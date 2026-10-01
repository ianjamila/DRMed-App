-- =============================================================================
-- 0196_patient_merge_atomic_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after 0196 is applied:
--   /opt/homebrew/opt/libpq/bin/psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0196_patient_merge_atomic_smoke.sql
--
-- BEGIN … ROLLBACK; leaves no rows behind. Single connection — the two-session
-- races live in scripts/merge-concurrency-proof.ts. Both functions are always
-- called AS service_role (the real caller), never as postgres. Sections:
--   s1  catalog: role, owners, ACLs, helper grants, policies, ledger columns
--   s2  consent fold (recompute_patient_consent_cache) + the insert trigger
--   s3  merge: every move, ledger, fill before/after, chain flatten, consent,
--       alert DRM-ID re-stamp, repeat flag, audit row, return value
--   s4  merge refusals (actor, pair, context, inactive records)
--   s5  merge is all-or-nothing (forced late failure)
--   s6  undo v2: moves back, later rows stay, post-merge alerts follow their
--       visit, edited field kept, chain restored, consent, audit, report
--   s7  undo refusals: double undo, 30-day boundary, kept record merged/deleted,
--       split result, actor
--   s8  legacy ledger rows (written by the pre-3b app)
--   s9  interrupted legacy undo completed by the function
--   s10 attachment booking groups (empty, walk-in-only, split owners)
--   s11 0196 rollback guard; ordinary edits and delete/restore unaffected
-- 0197 (merge-marker enforcement) supersedes the s11 rollback guard: once it is
-- installed, s1.9 checks its trigger instead, s1.12 holds trivially (the
-- helper is dropped) and s11.6 expects the legacy direct un-merge refused.
-- Every other check is the same with or without 0197.
-- =============================================================================

begin;

do $guard$
begin
  if (select count(*) from public.patients) > 5000 then
    raise exception 'refusing: % patients looks like prod — this test is LOCAL ONLY',
      (select count(*) from public.patients);
  end if;
end
$guard$;

-- --- Shared fixture -----------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000196', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mg-admin@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000196', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mg-reception@example.test', '', now(), now(), now()),
  ('a3000000-0000-4000-8000-000000000196', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mg-old-admin@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active)
values
  ('a0000000-0000-4000-8000-000000000196', 'MG Admin', 'admin', true),
  ('a1000000-0000-4000-8000-000000000196', 'MG Reception', 'reception', true),
  ('a3000000-0000-4000-8000-000000000196', 'MG Former Admin', 'admin', false);

insert into public.services (id, code, name, price_php, kind)
values ('c0000000-0000-4000-8000-000000000196', 'MG-LAB', 'MG smoke lab test', 1000, 'lab_test');

create temp table mg_fix (k text primary key, v uuid);
with ins as (
  insert into public.result_templates (service_id, layout)
  values ('c0000000-0000-4000-8000-000000000196', 'simple')
  returning id
)
insert into mg_fix (k, v) select 'tpl', id from ins;
with ins as (
  insert into public.result_template_params (template_id, sort_order, parameter_name, input_type)
  values ((select v from mg_fix where k = 'tpl'), 1, 'MG param', 'numeric')
  returning id
)
insert into mg_fix (k, v) select 'prm', id from ins;

-- --- Helpers (pg_temp: vanish with the session) ---------------------------------
create function pg_temp.admin() returns uuid language sql as
  $f$ select 'a0000000-0000-4000-8000-000000000196'::uuid $f$;

create function pg_temp.mk_patient(tag text, phone text default null, email text default null,
                                   bdate date default '1990-01-01') returns uuid language sql as $f$
  insert into public.patients (drm_id, first_name, last_name, birthdate, phone, email)
  values ('DRM-MG' || tag, 'Smoke', 'Mg' || tag, bdate, phone, email)
  returning id;
$f$;

create function pg_temp.mk_visit(p uuid) returns uuid language sql as $f$
  insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php)
  values ('V-MG-' || substr(md5(random()::text), 1, 10), p, 'unpaid', 0, 0)
  returning id;
$f$;

create function pg_temp.mk_line(v uuid, status text default 'in_progress') returns uuid language sql as $f$
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, parent_id, is_package_header)
  values (v, 'c0000000-0000-4000-8000-000000000196', status, 'a0000000-0000-4000-8000-000000000196',
          0, 0, null, false)
  returning id;
$f$;

-- A structured result linked to the given tests (one or more).
create function pg_temp.mk_result(lines uuid[]) returns uuid language plpgsql as $f$
declare r uuid; l uuid;
begin
  insert into public.results (generation_kind, uploaded_by)
  values ('structured', 'a0000000-0000-4000-8000-000000000196') returning id into r;
  foreach l in array lines loop
    insert into public.result_test_requests (result_id, test_request_id) values (r, l);
  end loop;
  return r;
end $f$;

create function pg_temp.mk_alert(r uuid, line uuid, p uuid) returns uuid language sql as $f$
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name,
                                      patient_id, patient_drm_id)
  values (r, line, (select v from mg_fix where k = 'prm'), 'high', 'MG param', p,
          (select drm_id from public.patients where id = p))
  returning id;
$f$;

create function pg_temp.grant_consent(p uuid, scope text default 'full') returns void language sql as $f$
  insert into public.patient_consents (patient_id, event_type, method, notice_version, signatory,
                                       actor_kind, consent_scope)
  values (p, 'granted', 'paper_wet_signature', 'v1', 'self', 'staff', scope);
$f$;

create function pg_temp.withdraw_consent(p uuid) returns void language sql as $f$
  insert into public.patient_consents (patient_id, event_type, reason, actor_kind, created_by)
  values (p, 'withdrawn', 'smoke', 'staff', 'a0000000-0000-4000-8000-000000000196');
$f$;

create function pg_temp.mk_appt(p uuid, grp uuid) returns uuid language sql as $f$
  insert into public.appointments (patient_id, status, scheduled_at, booking_group_id)
  values (p, 'confirmed', now() + interval '3 days', grp)
  returning id;
$f$;

create function pg_temp.mk_walkin_appt(grp uuid) returns uuid language sql as $f$
  insert into public.appointments (patient_id, walk_in_name, walk_in_phone, status, scheduled_at, booking_group_id)
  values (null, 'MG Walk-in', '09170000000', 'confirmed', now() + interval '3 days', grp)
  returning id;
$f$;

create function pg_temp.mk_attach(p uuid, grp uuid) returns uuid language sql as $f$
  insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes)
  values (grp, p, 'lab-request-forms/mg-' || gen_random_uuid() || '.pdf', 'mg.pdf', 'application/pdf', 10)
  returning id;
$f$;

create function pg_temp.mk_audit(p uuid) returns bigint language sql as $f$
  insert into public.audit_log (actor_type, action, patient_id) values ('system', 'mg.smoke', p) returning id;
$f$;

-- Marks src merged into keep the way a fixture must from now on: through the
-- private writer role, setting BOTH columns (0197 refuses anything else).
create function pg_temp.mark_merged(src uuid, keep uuid) returns void language plpgsql as $f$
begin
  set local role patient_merge_writer;
  update public.patients set merged_into_id = keep, merged_at = now() where id = src;
  reset role;
end $f$;

-- Deletes a patient without the blocker check (same mechanism as 0184's smoke).
create function pg_temp.kill(p uuid) returns void language plpgsql as $f$
begin
  set local role patient_lifecycle_writer;
  update public.patients
     set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000196', delete_reason = 'test_record'
   where id = p;
  reset role;
end $f$;

create function pg_temp.merge(keep uuid, src uuid,
                              actor uuid default 'a0000000-0000-4000-8000-000000000196',
                              ctx jsonb default '{"source":"admin","ip":"127.0.0.1","user_agent":"smoke"}')
returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  set local role service_role;
  r := public.merge_patients_guarded(keep, src, actor, ctx);
  reset role;
  return r;
end $f$;

create function pg_temp.undo(mid uuid, actor uuid default 'a0000000-0000-4000-8000-000000000196')
returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  set local role service_role;
  r := public.undo_patient_merge_guarded(mid, actor, '{"ip":"127.0.0.1","user_agent":"smoke"}'::jsonb);
  reset role;
  return r;
end $f$;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception '0196 % FAILED: got [%], want [%]', label, got, want;
  end if;
  raise notice '0196 % OK', label;
end $f$;

-- Runs sql as postgres; returns the SQLSTATE it raised, or 'ok'.
create function pg_temp.state_of(sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute sql;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- Runs sql as role r; returns the SQLSTATE it raised, or 'ok'. The exception
-- block's subtransaction rollback also reverts the SET LOCAL ROLE.
create function pg_temp.state_as(r text, sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute format('set local role %I', r);
  execute sql;
  reset role;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- The five cached consent columns as one comparable string.
create function pg_temp.consent5(p uuid) returns text language sql as $f$
  select consent_current::text || '|' || coalesce(consent_signed_at::text, '') || '|' ||
         coalesce(consent_withdrawn_at::text, '') || '|' || coalesce(consent_method, '') || '|' ||
         coalesce(consent_notice_version, '')
    from public.patients where id = p;
$f$;

-- The pre-3b app's merge, statement by statement (for LEGACY ledger rows):
-- moves the six tables, copies phone/email if keep lacks them, tombstones the
-- source (through the writer, so the fixture also works under 0197) and writes
-- a ledger row with NO snapshot_version.
create function pg_temp.legacy_merge(k uuid, s uuid) returns uuid language plpgsql as $f$
declare
  mv jsonb := '{}'::jsonb; x jsonb; filled text[] := '{}'; kp public.patients%rowtype; sp public.patients%rowtype; mid uuid;
begin
  select * into kp from public.patients where id = k;
  select * into sp from public.patients where id = s;
  with u as (update public.visits set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('visits', x);
  with u as (update public.appointments set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('appointments', x);
  with u as (update public.audit_log set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('audit_log', x);
  with u as (update public.critical_alerts set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('critical_alerts', x);
  with u as (update public.patient_consents set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('patient_consents', x);
  with u as (update public.appointment_attachments set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('appointment_attachments', x);
  if kp.phone is null and sp.phone is not null then
    update public.patients set phone = sp.phone where id = k; filled := filled || 'phone'::text;
  end if;
  if kp.email is null and sp.email is not null then
    update public.patients set email = sp.email where id = k; filled := filled || 'email'::text;
  end if;
  perform pg_temp.mark_merged(s, k);
  insert into public.patient_merges (keep_id, source_id, merged_by, moved, filled_from_source)
  values (k, s, 'a0000000-0000-4000-8000-000000000196', mv, filled) returning id into mid;
  return mid;
end $f$;

-- Runs one statement as the writer role (fixtures that emulate an old-app
-- undo that stopped part-way; 0197-proof).
create function pg_temp.as_writer(sql text) returns void language plpgsql as $f$
begin
  set local role patient_merge_writer;
  execute sql;
  reset role;
end $f$;

-- s1 ---------------------------------------------------------------------------
do $s1$
begin
  perform pg_temp.expect('s1.1 writer role is NOLOGIN NOINHERIT NOBYPASSRLS',
    (select rolcanlogin::text || rolinherit::text || rolbypassrls::text from pg_roles where rolname = 'patient_merge_writer'),
    'falsefalsefalse');
  perform pg_temp.expect('s1.2 only postgres is a member',
    (select string_agg(distinct r.rolname, ',') from pg_auth_members am join pg_roles r on r.oid = am.member
      where am.roleid = 'patient_merge_writer'::regrole), 'postgres');
  perform pg_temp.expect('s1.3 no runtime role can assume the writer',
    pg_has_role('authenticator', 'patient_merge_writer', 'member')::text || pg_has_role('service_role', 'patient_merge_writer', 'member')::text
    || pg_has_role('authenticated', 'patient_merge_writer', 'member')::text || pg_has_role('anon', 'patient_merge_writer', 'member')::text,
    'falsefalsefalsefalse');
  perform pg_temp.expect('s1.4 both functions: owner, definer, pinned search_path',
    (select string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' ||
                       array_to_string(p.proconfig, ';'), ',' order by p.proname)
       from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('merge_patients_guarded', 'undo_patient_merge_guarded')),
    'merge_patients_guarded:patient_merge_writer:true:search_path=pg_catalog, public, pg_temp,'
    || 'undo_patient_merge_guarded:patient_merge_writer:true:search_path=pg_catalog, public, pg_temp');
  perform pg_temp.expect('s1.5 writer may call exactly the helpers it needs',
    has_function_privilege('patient_merge_writer', 'public.lifecycle_lock(uuid[], boolean)', 'execute')::text
    || has_function_privilege('patient_merge_writer', 'public.lifecycle_lock_results(uuid[], boolean)', 'execute')::text
    || has_function_privilege('patient_merge_writer', 'public.recompute_patient_consent_cache(uuid)', 'execute')::text
    || has_function_privilege('patient_merge_writer', 'public.lifecycle_lock_and_assert(uuid[], boolean)', 'execute')::text,
    'truetruetruefalse');
  perform pg_temp.expect('s1.6 runtime roles cannot call the consent helper',
    has_function_privilege('service_role', 'public.recompute_patient_consent_cache(uuid)', 'execute')::text
    || has_function_privilege('authenticated', 'public.recompute_patient_consent_cache(uuid)', 'execute')::text
    || has_function_privilege('anon', 'public.recompute_patient_consent_cache(uuid)', 'execute')::text,
    'falsefalsefalse');
  perform pg_temp.expect('s1.7 writer has no CREATE on public',
    has_schema_privilege('patient_merge_writer', 'public', 'create')::text, 'false');
  perform pg_temp.expect('s1.8 ledger columns + live-source index',
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'patient_merges'
      and column_name in ('snapshot_version', 'fill_snapshot', 'rechained', 'context', 'undo_report'))::text || '|' ||
    (select count(*) from pg_indexes where indexname = 'uq_patient_merges_live_source')::text, '5|1');
  perform pg_temp.expect('s1.9 rollback guard trigger enabled (0197: its merge-marker guard)',
    (select tgenabled::text from pg_trigger
      where tgname = case when to_regprocedure('public.enforce_merge_marker()') is null
                          then 'trg_patients_live_merge_guard' else 'trg_patients_merge_marker_guard' end), 'O');
  perform pg_temp.expect('s1.11 0202 still holds: merge-ledger/consent policies name only the writer; anon/authenticated hold nothing',
    ((select bool_and(p.polroles = array['patient_merge_writer'::regrole::oid])
        from pg_policy p where p.polrelid in ('public.patient_merges'::regclass, 'public.patient_consents'::regclass))
     and not has_table_privilege('anon', 'public.patient_merges', 'SELECT')
     and not has_table_privilege('authenticated', 'public.patient_merges', 'SELECT')
     and not has_table_privilege('anon', 'public.patient_consents', 'SELECT')
     and not has_table_privilege('authenticated', 'public.patient_consents', 'SELECT'))::text, 'true');
  perform pg_temp.expect('s1.10 writer cannot change deletion columns (0167 guard)',
    pg_temp.state_as('patient_merge_writer', format(
      'update public.patients set deleted_at = now() where id = %L', pg_temp.mk_patient('S1D'))), '42501');
  perform pg_temp.expect('s1.12 writer has no EXECUTE on patient_has_live_v2_merge (F4: nested IFs, no extra grant)',
    (to_regprocedure('public.patient_has_live_v2_merge(uuid)') is not null
     and has_function_privilege('patient_merge_writer', 'public.patient_has_live_v2_merge(uuid)', 'execute'))::text, 'false');
end
$s1$;

-- s2 ---------------------------------------------------------------------------
do $s2$
declare
  p uuid; q uuid; w uuid; z uuid; c text; rv bigint;
begin
  p := pg_temp.mk_patient('S2A');
  perform pg_temp.expect('s2.1 no events → false + four NULLs', pg_temp.consent5(p), 'false||||');
  perform public.recompute_patient_consent_cache(p);
  perform pg_temp.expect('s2.2 recompute with no events', pg_temp.consent5(p), 'false||||');

  perform pg_temp.grant_consent(p);
  c := pg_temp.consent5(p);
  perform pg_temp.expect('s2.3 full grant (trigger) → current, method, version',
    split_part(c, '|', 1) || '|' || split_part(c, '|', 4) || '|' || split_part(c, '|', 5),
    'true|paper_wet_signature|v1');

  perform pg_temp.withdraw_consent(p);
  c := pg_temp.consent5(p);
  perform pg_temp.expect('s2.4 withdrawal: false, withdrawn stamped, grant fields carried',
    split_part(c, '|', 1) || '|' || (split_part(c, '|', 2) <> '')::text || '|' ||
    (split_part(c, '|', 3) <> '')::text || '|' || split_part(c, '|', 4),
    'false|true|true|paper_wet_signature');

  q := pg_temp.mk_patient('S2B');
  perform pg_temp.grant_consent(q, 'booking_contact_only');
  perform pg_temp.expect('s2.5 booking-only grant → false + four NULLs', pg_temp.consent5(q), 'false||||');

  w := pg_temp.mk_patient('S2C');
  perform pg_temp.grant_consent(w);
  perform pg_temp.grant_consent(w, 'booking_contact_only');
  perform pg_temp.withdraw_consent(w);
  c := pg_temp.consent5(w);
  perform pg_temp.expect('s2.6 full → booking-only → withdraw: grant fields cleared, withdrawn stamped',
    split_part(c, '|', 1) || '|' || split_part(c, '|', 2) || '|' || (split_part(c, '|', 3) <> '')::text || '|' ||
    split_part(c, '|', 4), 'false||true|');

  -- the helper reproduces exactly what the trigger built, and a no-op recompute
  -- does not touch the row (row_version unchanged)
  c := pg_temp.consent5(w);
  select row_version into rv from public.patients where id = w;
  perform public.recompute_patient_consent_cache(w);
  perform pg_temp.expect('s2.7 recompute = trigger state', pg_temp.consent5(w), c);
  perform pg_temp.expect('s2.8 no-op recompute leaves row_version',
    (select row_version from public.patients where id = w)::text, rv::text);

  -- moving events by UPDATE does NOT fire the trigger (why merge must re-sync):
  -- p's grant + withdrawal move to z, which had no events.
  z := pg_temp.mk_patient('S2D');
  update public.patient_consents set patient_id = z where patient_id = p;
  perform pg_temp.expect('s2.9 control: after an UPDATE move both caches are stale',
    (pg_temp.consent5(z) = 'false||||' and split_part(pg_temp.consent5(p), '|', 3) <> '')::text, 'true');
  perform public.recompute_patient_consent_cache(z);
  perform public.recompute_patient_consent_cache(p);
  c := pg_temp.consent5(z);
  perform pg_temp.expect('s2.10 recompute after the move: z withdrawn with grant fields, p cleared',
    split_part(c, '|', 1) || '|' || (split_part(c, '|', 3) <> '')::text || '|' || split_part(c, '|', 4) || '|' ||
    pg_temp.consent5(p), 'false|true|paper_wet_signature|false||||');
end
$s2$;

-- s11 --------------------------------------------------------------------------
do $s11$
declare
  k uuid; s uuid; lk uuid; ls uuid; f uuid;
begin
  k := pg_temp.mk_patient('S11K');
  s := pg_temp.mk_patient('S11S');
  perform pg_temp.mark_merged(s, k);
  insert into public.patient_merges (keep_id, source_id, snapshot_version, moved)
  values (k, s, 2, '{}'::jsonb);

  perform pg_temp.expect('s11.1 service_role cannot clear a live v2 merge marker',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s)),
    'P0080');
  perform pg_temp.expect('s11.2 postgres cannot either',
    pg_temp.state_of(format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s)),
    'P0080');
  perform pg_temp.expect('s11.3 service_role cannot re-point it',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = %L where id = %L', pg_temp.mk_patient('S11X'), s)),
    'P0080');
  perform pg_temp.expect('s11.4 the writer role can (it is how undo clears it)',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s)),
    'ok');
  perform pg_temp.expect('s11.5 the writer''s change landed (state_as commits on success)',
    coalesce((select merged_into_id from public.patients where id = s)::text, 'null'), 'null');
  perform pg_temp.mark_merged(s, k);

  -- a LEGACY live ledger row (pre-3b app) is not protected: the old app keeps working
  lk := pg_temp.mk_patient('S11LK');
  ls := pg_temp.mk_patient('S11LS');
  perform pg_temp.mark_merged(ls, lk);
  insert into public.patient_merges (keep_id, source_id, moved, filled_from_source)
  values (lk, ls, '{}'::jsonb, '{}');
  perform pg_temp.expect('s11.6 legacy live merge marker can still be cleared by service_role (old app undo) — refused once 0197 is in',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', ls)),
    case when to_regprocedure('public.enforce_merge_marker()') is null then 'ok' else 'P0080' end);

  -- ordinary edits and delete/restore are unaffected
  perform pg_temp.expect('s11.7 staff edit of an active patient',
    pg_temp.state_as('service_role', format('update public.patients set phone = %L where id = %L', '09171234567', k)),
    'ok');
  f := pg_temp.mk_patient('S11F');
  perform pg_temp.expect('s11.8 delete_patient still works',
    pg_temp.state_as('service_role', format(
      'select public.delete_patient(%L, %L, null, %L, null)', f, 'test_record', pg_temp.admin())), 'ok');
  perform pg_temp.expect('s11.9 restore_patient still works',
    pg_temp.state_as('service_role', format('select public.restore_patient(%L, %L, null)', f, pg_temp.admin())), 'ok');
end
$s11$;

-- s3 ---------------------------------------------------------------------------
do $s3$
declare
  k uuid; s uuid; t uuid; vk uuid; vs1 uuid; vs2 uuid; ls1 uuid; ls2 uuid; r1 uuid; al uuid;
  ap uuid; att uuid; au bigint; grp uuid := gen_random_uuid();
  res jsonb; m public.patient_merges%rowtype; kp public.patients%rowtype; sp public.patients%rowtype;
  run uuid; k2 uuid; s2 uuid; res2 jsonb;
begin
  k := pg_temp.mk_patient('S3K');
  update public.patients set address = '   ', sex = 'female' where id = k;   -- blank address counts as missing
  s := pg_temp.mk_patient('S3S', '09171112222', 'mg-s3s@example.test');
  update public.patients set address = 'MG street', middle_name = 'Q', sex = 'male' where id = s;
  t := pg_temp.mk_patient('S3T');
  perform pg_temp.mark_merged(t, s);                                          -- an older tombstone of s

  vk := pg_temp.mk_visit(k);
  vs1 := pg_temp.mk_visit(s);
  vs2 := pg_temp.mk_visit(s);
  ls1 := pg_temp.mk_line(vs1);
  ls2 := pg_temp.mk_line(vs2);
  r1 := pg_temp.mk_result(array[ls1]);
  al := pg_temp.mk_alert(r1, ls1, s);
  ap := pg_temp.mk_appt(s, grp);
  att := pg_temp.mk_attach(s, grp);
  au := pg_temp.mk_audit(s);
  perform pg_temp.grant_consent(s);

  res := pg_temp.merge(k, s);
  select * into m from public.patient_merges where id = (res->>'merge_id')::uuid;
  select * into kp from public.patients where id = k;
  select * into sp from public.patients where id = s;

  perform pg_temp.expect('s3.1 nothing left on the source',
    ((select count(*) from public.visits where patient_id = s) + (select count(*) from public.appointments where patient_id = s)
     + (select count(*) from public.audit_log where patient_id = s) + (select count(*) from public.critical_alerts where patient_id = s)
     + (select count(*) from public.patient_consents where patient_id = s)
     + (select count(*) from public.appointment_attachments where patient_id = s))::text, '0');
  perform pg_temp.expect('s3.2 ledger records the exact moved ids',
    (m.moved->'visits' @> to_jsonb(array[vs1, vs2]) and jsonb_array_length(m.moved->'visits') = 2
     and m.moved->'appointments' = to_jsonb(array[ap]) and m.moved->'critical_alerts' = to_jsonb(array[al])
     and m.moved->'appointment_attachments' = to_jsonb(array[att]) and m.moved->'audit_log' @> to_jsonb(array[au])
     and jsonb_array_length(m.moved->'patient_consents') = 1)::text, 'true');
  perform pg_temp.expect('s3.3 returned counts = ledger lengths',
    (res->'moved' = jsonb_build_object(
       'visits', jsonb_array_length(m.moved->'visits'), 'appointments', jsonb_array_length(m.moved->'appointments'),
       'audit_log', jsonb_array_length(m.moved->'audit_log'), 'critical_alerts', jsonb_array_length(m.moved->'critical_alerts'),
       'patient_consents', jsonb_array_length(m.moved->'patient_consents'),
       'appointment_attachments', jsonb_array_length(m.moved->'appointment_attachments')))::text, 'true');
  perform pg_temp.expect('s3.4 keep''s own visit untouched', (select patient_id from public.visits where id = vk)::text, k::text);
  perform pg_temp.expect('s3.5 moved alert re-stamped with the kept DRM-ID',
    (select patient_drm_id from public.critical_alerts where id = al), 'DRM-MGS3K');
  perform pg_temp.expect('s3.6 fill: phone, email, address (blank), middle name copied; sex kept',
    concat_ws('|', kp.phone, kp.email, kp.address, kp.middle_name, kp.sex),
    '09171112222|mg-s3s@example.test|MG street|Q|female');
  perform pg_temp.expect('s3.7 filled_from_source',
    (select string_agg(x, ',' order by x) from unnest(m.filled_from_source) x), 'address,email,middle_name,phone');
  perform pg_temp.expect('s3.8 fill snapshot before/after',
    (m.fill_snapshot->'address'->>'before') || '|' || (m.fill_snapshot->'address'->>'after') || '|' ||
    coalesce(m.fill_snapshot->'phone'->>'before', 'null') || '|' || (m.fill_snapshot->'phone'->>'after'),
    '   |MG street|null|09171112222');
  perform pg_temp.expect('s3.9 phone_normalized recomputed on keep', (kp.phone_normalized is not null)::text, 'true');
  perform pg_temp.expect('s3.10 chain flattened + recorded',
    (select merged_into_id from public.patients where id = t)::text || '|' || m.rechained::text, k::text || '|{' || t::text || '}');
  perform pg_temp.expect('s3.11 source tombstoned', (sp.merged_into_id = k and sp.merged_at is not null)::text, 'true');
  perform pg_temp.expect('s3.12 consent re-synced on both',
    kp.consent_current::text || '|' || pg_temp.consent5(s), 'true|false||||');
  perform pg_temp.expect('s3.13 repeat flag set on keep', kp.is_repeat_patient::text, 'true');
  perform pg_temp.expect('s3.14 ledger header',
    concat_ws('|', m.snapshot_version, m.merged_by, m.context->>'source', m.undone_at),
    '2|' || pg_temp.admin() || '|admin');
  perform pg_temp.expect('s3.15 audit row written in the same transaction',
    (select count(*) from public.audit_log a
      where a.action = 'patient.merged' and a.patient_id = k and a.actor_id = pg_temp.admin()
        and a.metadata->>'merge_id' = m.id::text and a.ip_address = '127.0.0.1'::inet
        and a.user_agent = 'smoke')::text, '1');
  perform pg_temp.expect('s3.16 return value names both records',
    (res->>'kept_drm_id') || '|' || (res->>'merged_drm_id') || '|' || (res->>'rechained'), 'DRM-MGS3K|DRM-MGS3S|1');
  perform pg_temp.expect('s3.17 writes to the tombstone are refused afterwards (0184 guard)',
    pg_temp.state_of(format('select pg_temp.mk_visit(%L)', s)), 'P0058');

  -- dedup CLI context + birthdate fill (only legacy-import records may lack one)
  insert into public.legacy_import_runs (source, dry_run) values ('mg-smoke', true) returning id into run;
  insert into public.patients (drm_id, first_name, last_name, birthdate, legacy_import_run_id)
  values ('DRM-MGS3K2', 'Smoke', 'MgS3K2', null, run) returning id into k2;
  s2 := pg_temp.mk_patient('S3S2', null, null, '1985-05-05');
  res2 := pg_temp.merge(k2, s2, pg_temp.admin(), '{"source":"dedup-cli","tier":"exact_dup"}'::jsonb);
  perform pg_temp.expect('s3.18 birthdate filled + CLI context recorded',
    (select birthdate::text from public.patients where id = k2) || '|' ||
    (select context->>'source' || ',' || (context->>'tier') from public.patient_merges where id = (res2->>'merge_id')::uuid) || '|' ||
    (select a.metadata->>'tier' from public.audit_log a where a.action = 'patient.merged' and a.patient_id = k2),
    '1985-05-05|dedup-cli,exact_dup|exact_dup');
end
$s3$;

-- s4 ---------------------------------------------------------------------------
do $s4$
declare
  k uuid; s uuid; d uuid; x uuid; y uuid;
  ux_k uuid; ux_src uuid; ux_other uuid;
  sig constant text := 'public.merge_patients_guarded(uuid, uuid, uuid, jsonb)';
begin
  k := pg_temp.mk_patient('S4K');
  s := pg_temp.mk_patient('S4S');
  perform pg_temp.mk_visit(s);

  perform pg_temp.expect('s4.1 reception actor refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L, %L)', k, s, 'a1000000-0000-4000-8000-000000000196')), 'P0078');
  perform pg_temp.expect('s4.2 inactive admin refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L, %L)', k, s, 'a3000000-0000-4000-8000-000000000196')), 'P0078');
  perform pg_temp.expect('s4.3 NULL actor refused (no NULL-actor path)',
    pg_temp.state_as('service_role', format('select public.merge_patients_guarded(%L, %L, null, null)', k, s)), 'P0078');
  perform pg_temp.expect('s4.4 same record twice refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, k)), 'P0079');
  perform pg_temp.expect('s4.5 NULL keep refused',
    pg_temp.state_as('service_role', format('select public.merge_patients_guarded(null, %L, %L, null)', s, pg_temp.admin())), 'P0079');
  perform pg_temp.expect('s4.6 unknown context key refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L, %L, %L)', k, s, pg_temp.admin(), '{"sneaky":1}')), 'P0079');
  perform pg_temp.expect('s4.7 unknown context source refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L, %L, %L)', k, s, pg_temp.admin(), '{"source":"cron"}')), 'P0079');

  d := pg_temp.mk_patient('S4D');
  perform pg_temp.kill(d);
  perform pg_temp.expect('s4.8 deleted keep refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', d, s)), 'P0058');
  perform pg_temp.expect('s4.9 deleted source refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, d)), 'P0058');
  x := pg_temp.mk_patient('S4X');
  y := pg_temp.mk_patient('S4Y');
  perform pg_temp.mark_merged(x, y);
  perform pg_temp.expect('s4.10 already-merged source refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, x)), 'P0058');
  perform pg_temp.expect('s4.11 tombstone as keep refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', x, s)), 'P0058');
  perform pg_temp.expect('s4.12 missing record refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, gen_random_uuid())), 'P0058');

  perform pg_temp.expect('s4.13 nothing changed by the refusals',
    ((select count(*) from public.visits where patient_id = s) = 1
     and (select merged_into_id from public.patients where id = s) is null
     and not exists (select 1 from public.patient_merges where keep_id = k or source_id = s))::text, 'true');

  perform pg_temp.expect('s4.14 anon cannot execute', has_function_privilege('anon', sig, 'execute')::text, 'false');
  perform pg_temp.expect('s4.15 authenticated cannot execute', has_function_privilege('authenticated', sig, 'execute')::text, 'false');
  perform pg_temp.expect('s4.16 service_role can', has_function_privilege('service_role', sig, 'execute')::text, 'true');
  perform pg_temp.expect('s4.17 authenticated call is denied (42501)',
    pg_temp.state_as('authenticated', format('select public.merge_patients_guarded(%L, %L, %L, null)', k, s, pg_temp.admin())), '42501');

  -- s4.18 (F1): X is the source of a LIVE interrupted-legacy ledger row (the
  -- old app cleared its marker, so X is active again, but the undo never
  -- finished) — X cannot be merged again, as either side of a new merge.
  ux_k := pg_temp.mk_patient('S4UXK'); ux_src := pg_temp.mk_patient('S4UXX');
  perform pg_temp.legacy_merge(ux_k, ux_src);
  perform pg_temp.as_writer(format('update public.patients set merged_into_id = null, merged_at = null where id = %L', ux_src));
  perform pg_temp.expect('s4.18a merging X in as source is refused (unfinished undo)',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, ux_src)), 'P0079');
  ux_other := pg_temp.mk_patient('S4UXO');
  perform pg_temp.expect('s4.18b merging X in as keep is refused (unfinished undo)',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', ux_src, ux_other)), 'P0079');
end
$s4$;

-- s5 ---------------------------------------------------------------------------
-- A failure in the LAST write (the ledger insert) must leave both records
-- exactly as they were: no partial merge exists any more.
create function public.mg_smoke_boom() returns trigger language plpgsql as $f$
begin
  raise exception 'forced failure' using errcode = 'XX000';
end $f$;

do $s5$
declare
  k uuid; s uuid; t uuid; vs uuid; ls uuid; r uuid; al uuid; grp uuid := gen_random_uuid();
  before_k text; before_s text;
begin
  k := pg_temp.mk_patient('S5K');
  s := pg_temp.mk_patient('S5S', '09175550000');
  t := pg_temp.mk_patient('S5T');
  perform pg_temp.mark_merged(t, s);
  vs := pg_temp.mk_visit(s);
  ls := pg_temp.mk_line(vs);
  r := pg_temp.mk_result(array[ls]);
  al := pg_temp.mk_alert(r, ls, s);
  perform pg_temp.mk_appt(s, grp);
  perform pg_temp.mk_attach(s, grp);
  perform pg_temp.grant_consent(s);
  select to_jsonb(p) - 'updated_at' - 'row_version' into before_k from public.patients p where id = k;
  select to_jsonb(p) - 'updated_at' - 'row_version' into before_s from public.patients p where id = s;

  execute format('create trigger mg_smoke_boom before insert on public.patient_merges for each row '
                 'when (new.keep_id = %L) execute function public.mg_smoke_boom()', k);
  perform pg_temp.expect('s5.1 forced failure in the ledger insert surfaces',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, s)), 'XX000');
  drop trigger mg_smoke_boom on public.patient_merges;

  perform pg_temp.expect('s5.2 both records unchanged',
    ((select to_jsonb(p) - 'updated_at' - 'row_version' from public.patients p where id = k)::text = before_k
     and (select to_jsonb(p) - 'updated_at' - 'row_version' from public.patients p where id = s)::text = before_s)::text, 'true');
  perform pg_temp.expect('s5.3 every child row still on the source, chain intact',
    ((select patient_id from public.visits where id = vs) = s
     and (select patient_id || '|' || patient_drm_id from public.critical_alerts where id = al) = s || '|DRM-MGS5S'
     and (select count(*) from public.appointments where patient_id = s) = 1
     and (select count(*) from public.appointment_attachments where patient_id = s) = 1
     and (select count(*) from public.patient_consents where patient_id = s) = 1
     and (select merged_into_id from public.patients where id = t) = s)::text, 'true');
  perform pg_temp.expect('s5.4 no audit row, no ledger row',
    ((select count(*) from public.audit_log where action = 'patient.merged' and patient_id = k)
     + (select count(*) from public.patient_merges where keep_id = k))::text, '0');
  perform pg_temp.expect('s5.5 the same merge then succeeds',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, s)), 'ok');
end
$s5$;

-- s6 ---------------------------------------------------------------------------
do $s6$
declare
  k uuid; s uuid; t uuid; vk uuid; vs1 uuid; vs2 uuid; ls1 uuid; ls2 uuid; r1 uuid; r2 uuid;
  al uuid; al2 uuid; ap uuid; att uuid; au bigint; grp uuid := gen_random_uuid();
  vnew uuid; apnew uuid; mid uuid; rep jsonb; m public.patient_merges%rowtype; c text;
begin
  k := pg_temp.mk_patient('S6K');
  s := pg_temp.mk_patient('S6S', '09176660000', 'mg-s6s@example.test');
  update public.patients set address = 'S6 street' where id = s;
  t := pg_temp.mk_patient('S6T');
  perform pg_temp.mark_merged(t, s);
  vk := pg_temp.mk_visit(k);
  vs1 := pg_temp.mk_visit(s);
  vs2 := pg_temp.mk_visit(s);
  ls1 := pg_temp.mk_line(vs1);
  r1 := pg_temp.mk_result(array[ls1]);
  al := pg_temp.mk_alert(r1, ls1, s);
  ap := pg_temp.mk_appt(s, grp);
  att := pg_temp.mk_attach(s, grp);
  au := pg_temp.mk_audit(s);
  perform pg_temp.grant_consent(s);

  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;

  -- work done on the kept record after the merge
  update public.patients set phone = '09179990000' where id = k;       -- edited a filled field
  vnew := pg_temp.mk_visit(k);
  apnew := pg_temp.mk_appt(k, gen_random_uuid());
  perform pg_temp.withdraw_consent(k);
  ls2 := pg_temp.mk_line(vs2);                                        -- a moved visit gets a new result + alert
  r2 := pg_temp.mk_result(array[ls2]);
  al2 := pg_temp.mk_alert(r2, ls2, k);

  rep := pg_temp.undo(mid);
  select * into m from public.patient_merges where id = mid;

  perform pg_temp.expect('s6.1 recorded visits back; keep''s old and new visits stay',
    ((select patient_id from public.visits where id = vs1) = s and (select patient_id from public.visits where id = vs2) = s
     and (select patient_id from public.visits where id = vk) = k and (select patient_id from public.visits where id = vnew) = k)::text, 'true');
  perform pg_temp.expect('s6.2 appointment, upload, audit row, consent back; later rows stay',
    ((select patient_id from public.appointments where id = ap) = s and (select patient_id from public.appointments where id = apnew) = k
     and (select patient_id from public.appointment_attachments where id = att) = s
     and (select patient_id from public.audit_log where id = au) = s
     and (select count(*) from public.patient_consents where patient_id = s and event_type = 'granted') = 1
     and (select count(*) from public.patient_consents where patient_id = k and event_type = 'withdrawn') = 1)::text, 'true');
  perform pg_temp.expect('s6.3 both alerts follow their visit (incl. the one created after the merge), re-stamped',
    (select string_agg(patient_id::text || ':' || patient_drm_id, ',' order by created_at, id)
       from public.critical_alerts where id in (al, al2)),
    s::text || ':DRM-MGS6S,' || s::text || ':DRM-MGS6S');
  perform pg_temp.expect('s6.4 edited phone kept; untouched email + address reverted',
    concat_ws('|', (select phone from public.patients where id = k),
                   coalesce((select email from public.patients where id = k), 'null'),
                   coalesce((select address from public.patients where id = k), 'null')),
    '09179990000|null|null');
  perform pg_temp.expect('s6.5 report: kept vs reverted fields',
    (rep->'kept_fields')::text || '|' ||
    (select string_agg(x, ',' order by x) from jsonb_array_elements_text(rep->'reverted_fields') x),
    '["phone"]|address,email');
  perform pg_temp.expect('s6.6 chain restored', (select merged_into_id from public.patients where id = t)::text, s::text);
  perform pg_temp.expect('s6.7 source active again',
    ((select merged_into_id is null and merged_at is null from public.patients where id = s))::text, 'true');
  c := pg_temp.consent5(k);
  perform pg_temp.expect('s6.8 consent re-synced: source granted, keep withdrawn-only',
    split_part(pg_temp.consent5(s), '|', 1) || '|' || split_part(c, '|', 1) || '|' ||
    (split_part(c, '|', 3) <> '')::text || '|' || split_part(c, '|', 2), 'true|false|true|');
  perform pg_temp.expect('s6.9 ledger marked undone with the report',
    (m.undone_at is not null and m.undone_by = pg_temp.admin() and m.undo_report = rep)::text, 'true');
  perform pg_temp.expect('s6.10 audit row',
    (select count(*) from public.audit_log a where a.action = 'patient.merge.undone' and a.patient_id = k
       and a.resource_id = s and a.metadata->>'merge_id' = mid::text)::text, '1');
  perform pg_temp.expect('s6.11 report counts; nothing recorded left on keep',
    (rep->'moved_back'->>'visits') || '|' || (rep->'moved_back'->>'critical_alerts') || '|' ||
    (select sum(jsonb_array_length(v))::text from jsonb_each(rep->'left_on_keep') e(k2, v)) || '|' ||
    (rep->>'resumed_interrupted_undo'),
    '2|2|0|false');
  perform pg_temp.expect('s6.12 the source takes writes again', pg_temp.state_of(format('select pg_temp.mk_visit(%L)', s)), 'ok');
  perform pg_temp.expect('s6.13 (F5 control) repeat flag NOT reverted: keep ends with 2 own visits',
    (select is_repeat_patient from public.patients where id = k)::text || '|' || (rep->>'repeat_flag_reverted'),
    'true|false');
end
$s6$;

-- s6b (F5) ---------------------------------------------------------------------
-- The repeat flag a merge sets is reverted by undo when the keep ends with no
-- own visits of its own; the flag was set BY the merge, recorded in context.
do $s6b$
declare
  k uuid; s uuid; mid uuid; rep jsonb; m public.patient_merges%rowtype;
begin
  k := pg_temp.mk_patient('S6BK');
  s := pg_temp.mk_patient('S6BS');
  perform pg_temp.mk_visit(s);
  perform pg_temp.mk_visit(s);

  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;
  select * into m from public.patient_merges where id = mid;
  perform pg_temp.expect('s6b.1 merge sets repeat flag + records it in context',
    (select is_repeat_patient from public.patients where id = k)::text || '|' || (m.context->>'repeat_flag_set'),
    'true|true');

  rep := pg_temp.undo(mid);
  perform pg_temp.expect('s6b.2 undo reverts the repeat flag it set (keep ends with 0 own visits)',
    (select is_repeat_patient from public.patients where id = k)::text || '|' || (rep->>'repeat_flag_reverted'),
    'false|true');
end
$s6b$;

-- s6c --------------------------------------------------------------------------
-- Undo moves a recorded row back only while it is still on keep: a recorded
-- visit or appointment that left keep after the merge stays where it went.
do $s6c$
declare
  k uuid; s uuid; x uuid; vs1 uuid; vs2 uuid; ap1 uuid; ap2 uuid; mid uuid; rep jsonb;
begin
  k := pg_temp.mk_patient('S6CK');
  s := pg_temp.mk_patient('S6CS');
  x := pg_temp.mk_patient('S6CX');
  vs1 := pg_temp.mk_visit(s);
  vs2 := pg_temp.mk_visit(s);
  ap1 := pg_temp.mk_appt(s, gen_random_uuid());
  ap2 := pg_temp.mk_appt(s, gen_random_uuid());

  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;
  update public.visits set patient_id = x where id = vs2;
  update public.appointments set patient_id = x where id = ap2;

  rep := pg_temp.undo(mid);
  perform pg_temp.expect('s6c.1 recorded rows still on keep go back; rows moved elsewhere stay there',
    (select patient_id from public.visits where id = vs1)::text || '|' || (select patient_id from public.visits where id = vs2)::text || '|' ||
    (select patient_id from public.appointments where id = ap1)::text || '|' || (select patient_id from public.appointments where id = ap2)::text,
    s::text || '|' || x::text || '|' || s::text || '|' || x::text);
  perform pg_temp.expect('s6c.2 report counts only the rows moved back',
    (rep->'moved_back'->>'visits') || '|' || (rep->'moved_back'->>'appointments'), '1|1');
end
$s6c$;

-- s7 ---------------------------------------------------------------------------
do $s7$
declare
  k uuid; s uuid; mid uuid; k2 uuid; s2 uuid; mid2 uuid; k3 uuid; s3 uuid; z3 uuid; mid3 uuid;
  k4 uuid; s4 uuid; mid4 uuid; k5 uuid; s5 uuid; vs5 uuid; vk5 uuid; mid5 uuid; k6 uuid; s6 uuid; mid6 uuid;
  sig constant text := 'public.undo_patient_merge_guarded(uuid, uuid, jsonb)';
begin
  k := pg_temp.mk_patient('S7K'); s := pg_temp.mk_patient('S7S'); perform pg_temp.mk_visit(s);
  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;
  perform pg_temp.undo(mid);
  perform pg_temp.expect('s7.1 double undo refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid)), 'P0079');

  -- 30-day boundary (now() is the transaction start, so the arithmetic is exact)
  k2 := pg_temp.mk_patient('S7K2'); s2 := pg_temp.mk_patient('S7S2');
  mid2 := (pg_temp.merge(k2, s2)->>'merge_id')::uuid;
  update public.patient_merges set merged_at = now() - interval '30 days' where id = mid2;
  perform pg_temp.expect('s7.2 exactly 30 days refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid2)), 'P0079');
  update public.patient_merges set merged_at = now() - interval '30 days 1 second' where id = mid2;
  perform pg_temp.expect('s7.3 30 days + 1s refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid2)), 'P0079');
  update public.patient_merges set merged_at = now() - interval '29 days 23 hours 59 minutes 59 seconds' where id = mid2;
  perform pg_temp.expect('s7.4 29d 23h 59m 59s allowed', pg_temp.state_of(format('select pg_temp.undo(%L)', mid2)), 'ok');

  -- kept record since merged into a third record
  k3 := pg_temp.mk_patient('S7K3'); s3 := pg_temp.mk_patient('S7S3'); z3 := pg_temp.mk_patient('S7Z3');
  mid3 := (pg_temp.merge(k3, s3)->>'merge_id')::uuid;
  perform pg_temp.merge(z3, k3);
  perform pg_temp.expect('s7.5 keep merged elsewhere refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid3)), 'P0079');

  -- kept record since deleted
  k4 := pg_temp.mk_patient('S7K4'); s4 := pg_temp.mk_patient('S7S4');
  mid4 := (pg_temp.merge(k4, s4)->>'merge_id')::uuid;
  perform pg_temp.kill(k4);
  perform pg_temp.expect('s7.6 keep deleted refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid4)), 'P0079');

  -- a result made after the merge that combines a moved visit's test with one of keep's own
  k5 := pg_temp.mk_patient('S7K5'); s5 := pg_temp.mk_patient('S7S5');
  vs5 := pg_temp.mk_visit(s5);
  mid5 := (pg_temp.merge(k5, s5)->>'merge_id')::uuid;
  vk5 := pg_temp.mk_visit(k5);
  perform pg_temp.mk_result(array[pg_temp.mk_line(vs5), pg_temp.mk_line(vk5)]);
  perform pg_temp.expect('s7.7 split result refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid5)), 'P0079');
  perform pg_temp.expect('s7.8 nothing changed by the refusal',
    ((select patient_id from public.visits where id = vs5) = k5
     and (select merged_into_id from public.patients where id = s5) = k5
     and (select undone_at from public.patient_merges where id = mid5) is null)::text, 'true');

  k6 := pg_temp.mk_patient('S7K6'); s6 := pg_temp.mk_patient('S7S6');
  mid6 := (pg_temp.merge(k6, s6)->>'merge_id')::uuid;
  perform pg_temp.expect('s7.9 reception actor refused',
    pg_temp.state_of(format('select pg_temp.undo(%L, %L)', mid6, 'a1000000-0000-4000-8000-000000000196')), 'P0078');
  perform pg_temp.expect('s7.10 NULL actor refused',
    pg_temp.state_as('service_role', format('select public.undo_patient_merge_guarded(%L, null, null)', mid6)), 'P0078');
  perform pg_temp.expect('s7.11 unknown merge refused', pg_temp.state_of(format('select pg_temp.undo(%L)', gen_random_uuid())), 'P0079');
  perform pg_temp.expect('s7.12 bad context refused',
    pg_temp.state_as('service_role', format('select public.undo_patient_merge_guarded(%L, %L, %L)', mid6, pg_temp.admin(), '{"x":1}')), 'P0079');
  perform pg_temp.expect('s7.13 anon/authenticated cannot execute; service_role can',
    has_function_privilege('anon', sig, 'execute')::text || has_function_privilege('authenticated', sig, 'execute')::text
    || has_function_privilege('service_role', sig, 'execute')::text, 'falsefalsetrue');
end
$s7$;

-- s8 ---------------------------------------------------------------------------
do $s8$
declare k uuid; s uuid; vs uuid; mid uuid; rep jsonb;
begin
  k := pg_temp.mk_patient('S8K');
  s := pg_temp.mk_patient('S8S', '09178880000', 'mg-s8s@example.test');
  vs := pg_temp.mk_visit(s);
  mid := pg_temp.legacy_merge(k, s);
  update public.patients set email = 'mg-s8-edited@example.test' where id = k;   -- edited after the merge
  rep := pg_temp.undo(mid);
  perform pg_temp.expect('s8.1 legacy undo moves the recorded visit back', (select patient_id from public.visits where id = vs)::text, s::text);
  perform pg_temp.expect('s8.2 legacy fill: phone (still = source) cleared, edited email kept',
    coalesce((select phone from public.patients where id = k), 'null') || '|' || (select email from public.patients where id = k)
    || '|' || (rep->'kept_fields')::text, 'null|mg-s8-edited@example.test|["email"]');
  perform pg_temp.expect('s8.3 ledger undone; not a resume',
    ((select undone_at is not null from public.patient_merges where id = mid) and (rep->>'resumed_interrupted_undo') = 'false')::text, 'true');
end
$s8$;

-- s8b (F7) ---------------------------------------------------------------------
-- A malformed `moved` shape (a hand-edited or older ledger row) must not crash
-- the undo with a raw 22023 — treat anything that is not a JSON array as empty.
do $s8b$
declare k uuid; s uuid; mid uuid;
begin
  k := pg_temp.mk_patient('S8BK');
  s := pg_temp.mk_patient('S8BS');
  perform pg_temp.mark_merged(s, k);
  insert into public.patient_merges (keep_id, source_id, merged_by, moved, filled_from_source)
  values (k, s, pg_temp.admin(), '{"visits": null, "appointments": 3}'::jsonb, '{}')
  returning id into mid;
  perform pg_temp.expect('s8b.1 defensive moved shape: undo succeeds instead of raising 22023',
    pg_temp.state_of(format('select pg_temp.undo(%L)', mid)), 'ok');
end
$s8b$;

-- s9 ---------------------------------------------------------------------------
do $s9$
declare
  k uuid; s uuid; vs1 uuid; vs2 uuid; ls1 uuid; r1 uuid; al uuid; ap uuid; mid uuid; rep jsonb;
  k2 uuid; s2 uuid; vs3 uuid; vk2 uuid; mid2 uuid;
  k3 uuid; s3 uuid; mid3 uuid; rep3 jsonb;
begin
  k := pg_temp.mk_patient('S9K');
  s := pg_temp.mk_patient('S9S', '09179990001');
  vs1 := pg_temp.mk_visit(s); vs2 := pg_temp.mk_visit(s);
  ls1 := pg_temp.mk_line(vs1); r1 := pg_temp.mk_result(array[ls1]); al := pg_temp.mk_alert(r1, ls1, s);
  ap := pg_temp.mk_appt(s, gen_random_uuid());
  mid := pg_temp.legacy_merge(k, s);
  -- the old action cleared the marker, moved visits back … and stopped
  perform pg_temp.as_writer(format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s));
  perform pg_temp.as_writer(format('update public.visits set patient_id = %L where id in (%L, %L)', s, vs1, vs2));
  -- meanwhile both records were corrected to the same new phone
  update public.patients set phone = '09170001111' where id in (k, s);

  rep := pg_temp.undo(mid);
  perform pg_temp.expect('s9.1 completes an interrupted legacy undo', rep->>'resumed_interrupted_undo', 'true');
  perform pg_temp.expect('s9.2 the rest moves back; the alert follows its visit',
    ((select patient_id from public.appointments where id = ap) = s
     and (select patient_id from public.critical_alerts where id = al) = s)::text, 'true');
  perform pg_temp.expect('s9.3 no fill reverted on a resume; all reported',
    (select phone from public.patients where id = k) || '|' || (rep->'kept_fields')::text || '|' || (rep->'reverted_fields')::text,
    '09170001111|["phone"]|[]');

  -- a result already split by the interrupted undo is refused, nothing changed
  k2 := pg_temp.mk_patient('S9K2'); s2 := pg_temp.mk_patient('S9S2');
  vs3 := pg_temp.mk_visit(s2);
  mid2 := pg_temp.legacy_merge(k2, s2);
  vk2 := pg_temp.mk_visit(k2);
  perform pg_temp.mk_result(array[pg_temp.mk_line(vs3), pg_temp.mk_line(vk2)]);      -- both on k2: allowed
  perform pg_temp.as_writer(format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s2));
  perform pg_temp.as_writer(format('update public.visits set patient_id = %L where id = %L', s2, vs3));  -- now split
  perform pg_temp.expect('s9.4 resume refuses an already-split result', pg_temp.state_of(format('select pg_temp.undo(%L)', mid2)), 'P0079');
  perform pg_temp.expect('s9.5 ledger still live', ((select undone_at from public.patient_merges where id = mid2) is null)::text, 'true');

  -- s9.6 (F1): an interrupted legacy undo must always be completable, even
  -- when the ledger row is well past the ordinary 30-day undo window — the
  -- source is already active again and half its rows are already back.
  k3 := pg_temp.mk_patient('S9K3'); s3 := pg_temp.mk_patient('S9S3');
  mid3 := pg_temp.legacy_merge(k3, s3);
  perform pg_temp.as_writer(format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s3));
  update public.patient_merges set merged_at = now() - interval '45 days' where id = mid3;
  rep3 := pg_temp.undo(mid3);
  perform pg_temp.expect('s9.6 interrupted legacy undo older than 30 days still completes',
    (rep3->>'resumed_interrupted_undo'), 'true');
end
$s9$;

-- s10 --------------------------------------------------------------------------
do $s10$
declare
  k uuid; s uuid; mid uuid; rep jsonb;
  g_empty uuid := gen_random_uuid(); g_walk uuid := gen_random_uuid(); g_split uuid := gen_random_uuid();
  g_follow uuid := gen_random_uuid();
  a_empty uuid; a_walk uuid; a_split uuid; a_orphan uuid; a_follow uuid;
begin
  k := pg_temp.mk_patient('S10K'); s := pg_temp.mk_patient('S10S');
  a_empty := pg_temp.mk_attach(s, g_empty);                          -- recorded, empty group
  perform pg_temp.mk_walkin_appt(g_walk);
  a_walk := pg_temp.mk_attach(s, g_walk);                            -- recorded, walk-in-only group
  perform pg_temp.mk_appt(s, g_split);
  a_split := pg_temp.mk_attach(s, g_split);                          -- recorded; keep books into the group later
  a_orphan := pg_temp.mk_attach(k, gen_random_uuid());               -- keep's own orphan upload
  perform pg_temp.mk_appt(s, g_follow);                              -- source booking, upload arrives after the merge
  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;
  perform pg_temp.mk_appt(k, g_split);
  a_follow := pg_temp.mk_attach(k, g_follow);

  rep := pg_temp.undo(mid);
  perform pg_temp.expect('s10.1 recorded, empty group → back',
    (select patient_id from public.appointment_attachments where id = a_empty)::text, s::text);
  perform pg_temp.expect('s10.2 recorded, walk-in-only group → back',
    (select patient_id from public.appointment_attachments where id = a_walk)::text, s::text);
  perform pg_temp.expect('s10.3 recorded, group now has keep''s booking → stays, reported',
    (select patient_id from public.appointment_attachments where id = a_split)::text || '|' ||
    (rep->'left_on_keep'->'appointment_attachments' @> to_jsonb(array[a_split]))::text, k::text || '|true');
  perform pg_temp.expect('s10.4 keep''s own orphan upload never taken',
    (select patient_id from public.appointment_attachments where id = a_orphan)::text, k::text);
  perform pg_temp.expect('s10.5 unrecorded upload follows its booking back',
    (select patient_id from public.appointment_attachments where id = a_follow)::text, s::text);
end
$s10$;

rollback;

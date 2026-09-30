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
  perform pg_temp.expect('s11.6 legacy live merge marker can still be cleared by service_role (old app undo)',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', ls)),
    'ok');

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

rollback;

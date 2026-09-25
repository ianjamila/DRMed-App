-- =============================================================================
-- 0167_patient_soft_delete_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after 0167 is applied:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/0167_patient_soft_delete_smoke.sql
--
-- Runs inside BEGIN … ROLLBACK and leaves no rows behind. Mints its own staff,
-- services, HMO provider and patients. Each section proves its guard with a
-- negative control. Sections:
--   s1  columns, row checks, the patient guard (who may write lifecycle fields)
--   s2  patient_kept_counts
--   s3  blockers: appointments, clinical work, non-HMO money
--   s4  blockers: HMO patient share, claims, unbilled, reconciliation
--   s5  delete_patient / restore_patient, audit, ACLs
--   s6  current_patient_id() and portal RLS
--   s7  views
--   s8  resolve_patient_guarded
--   s9  appointment_attachments delete guard (coordinator follow-up, 2026-09-25)
--
-- CORRECTION (controller-notes.md, 2026-09-25, Task 1 spike): `set role` is
-- checked against the SESSION user, not current_user. Inside this psql
-- session (session user = postgres, itself a member of
-- patient_lifecycle_writer WITH SET granted by the migration),
-- `set local role service_role; set role patient_lifecycle_writer` SUCCEEDS
-- regardless of the current role — so the plan's original s1.6/s1.7
-- (expecting 42501 from inside this session) would fail for the wrong
-- reason. Those two assertions are replaced below with pg_has_role
-- non-membership checks for the four runtime roles. The real deny for actual
-- API traffic — which authenticates as `authenticator` — is proven
-- out-of-band, once, outside this file (see the Task 2 report):
--   docker exec -e PGPASSWORD=postgres supabase_db_DRMed psql -h 127.0.0.1 \
--     -U authenticator -d postgres -c "set role service_role; set role patient_lifecycle_writer;"
--   -> expect: permission denied to set role
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
  ('a0000000-0000-4000-8000-000000000167', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pd-admin@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000167', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pd-reception@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000167', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pd-inactive-admin@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active)
values
  ('a0000000-0000-4000-8000-000000000167', 'PD Admin', 'admin', true),
  ('a1000000-0000-4000-8000-000000000167', 'PD Reception', 'reception', true),
  ('a2000000-0000-4000-8000-000000000167', 'PD Former Admin', 'admin', false);

insert into public.services (id, code, name, price_php, kind)
values
  ('c0000000-0000-4000-8000-000000000167', 'PD-LAB', 'PD smoke lab test', 1000, 'lab_test'),
  ('c1000000-0000-4000-8000-000000000167', 'PD-CONSULT', 'PD smoke consult', 500, 'doctor_consultation');

insert into public.hmo_providers (id, name)
values ('b0000000-0000-4000-8000-000000000167', 'PD Smoke HMO');

-- Helpers (pg_temp: vanish with the session).
create function pg_temp.mk_patient(tag text) returns uuid language sql as $f$
  insert into public.patients (drm_id, first_name, last_name, birthdate, email)
  values ('DRM-PD' || tag, 'Smoke', 'Pd' || tag, '1990-01-01', 'pd' || lower(tag) || '@example.test')
  returning id;
$f$;

create function pg_temp.mk_visit(p uuid, hmo boolean, status text, total numeric, paid numeric)
returns uuid language sql as $f$
  insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php, hmo_provider_id)
  values ('V-PD-' || substr(md5(random()::text), 1, 10), p, status, total, paid,
          case when hmo then 'b0000000-0000-4000-8000-000000000167'::uuid end)
  returning id;
$f$;

create function pg_temp.mk_line(v uuid, status text, final numeric, approved numeric,
                                parent uuid default null, svc uuid default 'c0000000-0000-4000-8000-000000000167',
                                header boolean default false)
returns uuid language sql as $f$
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, hmo_approved_amount_php,
                                    parent_id, is_package_header)
  values (v, svc, status, 'a0000000-0000-4000-8000-000000000167', final, final, approved,
          parent, header)
  returning id;
$f$;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception '0167 % FAILED: got [%], want [%]', label, got, want;
  end if;
  raise notice '0167 % OK', label;
end $f$;

-- Runs sql; returns the SQLSTATE it raised, or 'ok'.
create function pg_temp.state_of(sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute sql;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- 0119 strips PUBLIC EXECUTE from every function postgres creates, temp ones
-- included, so without this a helper called after `set local role …`
-- fails with "permission denied for function". Re-run after adding helpers.
do $grant$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', f);
  end loop;
end
$grant$;

-- --- s1: columns, row checks, patient guard -----------------------------------
do $s1$
declare
  p uuid := pg_temp.mk_patient('S1A');
  q uuid := pg_temp.mk_patient('S1B');
  r uuid := pg_temp.mk_patient('S1C'); -- visits on a deleted patient (fix review #1)
  s uuid := pg_temp.mk_patient('S1D'); -- overwrite-on-deleted-row / consent (fix review #4, #7)
  t uuid := pg_temp.mk_patient('S1E'); -- RLS/upsert bypass attempts (fix review #8)
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000167';
begin
  -- 1. INSERT carrying any deletion field is refused, whoever inserts.
  perform pg_temp.expect('s1.1 insert with deleted_at',
    pg_temp.state_of(format($q$insert into public.patients (drm_id, first_name, last_name, birthdate, deleted_at)
                             values ('DRM-PDS1X','a','b','1990-01-01', now())$q$)), 'P0057');
  perform pg_temp.expect('s1.2 insert with delete_note only',
    pg_temp.state_of(format($q$insert into public.patients (drm_id, first_name, last_name, birthdate, delete_note)
                             values ('DRM-PDS1Y','a','b','1990-01-01', 'x')$q$)), 'P0057');

  -- 2. A direct lifecycle UPDATE is refused for postgres and service_role.
  perform pg_temp.expect('s1.3 postgres direct delete',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L,
                             delete_reason = 'duplicate' where id = %L$q$, k_admin, p)), 'P0057');
  set local role service_role;
  perform pg_temp.expect('s1.4 service_role direct delete',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L,
                             delete_reason = 'duplicate' where id = %L$q$, k_admin, p)), 'P0057');
  -- An arbitrary GUC changes nothing (the spec forbids a GUC bypass).
  perform set_config('app.patient_lifecycle', 'on', true);
  perform pg_temp.expect('s1.5 GUC does not authorize',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L,
                             delete_reason = 'duplicate' where id = %L$q$, k_admin, p)), 'P0057');
  reset role;

  -- The runtime/API roles are not (and must never become) members of the
  -- private role. `set role` inside THIS session cannot be used to prove the
  -- deny (see the file header) — pg_has_role membership is the real proof
  -- here, and the out-of-band authenticator connection proves the SET ROLE
  -- deny for genuine API traffic.
  perform pg_temp.expect('s1.6 authenticator not a member',
    pg_has_role('authenticator', 'patient_lifecycle_writer', 'member')::text, 'false');
  perform pg_temp.expect('s1.6b service_role not a member',
    pg_has_role('service_role', 'patient_lifecycle_writer', 'member')::text, 'false');
  perform pg_temp.expect('s1.7 authenticated not a member',
    pg_has_role('authenticated', 'patient_lifecycle_writer', 'member')::text, 'false');
  perform pg_temp.expect('s1.7b anon not a member',
    pg_has_role('anon', 'patient_lifecycle_writer', 'member')::text, 'false');

  -- 3. Row checks hold even for the private role (independent protection).
  set local role patient_lifecycle_writer;
  perform pg_temp.expect('s1.8 deleted without actor',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), delete_reason = 'duplicate' where id = %L$q$, p)), '23514');
  perform pg_temp.expect('s1.9 bad reason',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'oops' where id = %L$q$, k_admin, p)), '23514');
  perform pg_temp.expect('s1.10 other without note',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'other' where id = %L$q$, k_admin, p)), '23514');
  perform pg_temp.expect('s1.11 untrimmed note',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'other', delete_note = ' x' where id = %L$q$, k_admin, p)), '23514');
  perform pg_temp.expect('s1.12 501-char note',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'other', delete_note = %L where id = %L$q$, k_admin, repeat('x', 501), p)), '23514');
  -- The writer may not change anything else in the same statement. Its
  -- column-level UPDATE grant stops this before the guard does (the guard's
  -- own "no other field" rule is the second line, for a future wider grant).
  perform pg_temp.expect('s1.13 writer cannot edit other fields',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'duplicate', first_name = 'Changed' where id = %L$q$, k_admin, p)), '42501');
  -- CONTROL: a valid write by the writer succeeds, so the refusals above are the guard, not a broken setup.
  perform pg_temp.expect('s1.14 CONTROL writer valid delete',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'duplicate' where id = %L$q$, k_admin, p)), 'ok');
  reset role;

  -- 4. A deleted row is read-only to everyone except a restore.
  perform pg_temp.expect('s1.15 edit deleted row (postgres)',
    pg_temp.state_of(format($q$update public.patients set first_name = 'X' where id = %L$q$, p)), 'P0058');
  set local role service_role;
  perform pg_temp.expect('s1.16 edit deleted row (service_role)',
    pg_temp.state_of(format($q$update public.patients set phone = '09170000000' where id = %L$q$, p)), 'P0058');
  reset role;
  -- A no-op update (e.g. the repeat-patient flag already true) is not a change.
  perform pg_temp.expect('s1.17 no-op update on deleted row',
    pg_temp.state_of(format($q$update public.patients set first_name = first_name where id = %L$q$, p)), 'ok');
  -- Deleted AND merged is impossible.
  perform pg_temp.expect('s1.18 merge a deleted row',
    pg_temp.state_of(format($q$update public.patients set merged_into_id = %L, merged_at = now() where id = %L$q$, q, p)), 'P0058');
  -- CONTROL: the same edit on an ACTIVE row succeeds.
  perform pg_temp.expect('s1.19 CONTROL edit active row',
    pg_temp.state_of(format($q$update public.patients set first_name = 'X' where id = %L$q$, q)), 'ok');

  -- 5. Restore (writer, all four cleared) is allowed.
  set local role patient_lifecycle_writer;
  perform pg_temp.expect('s1.20 writer restore',
    pg_temp.state_of(format($q$update public.patients set deleted_at = null, deleted_by = null, delete_reason = null, delete_note = null where id = %L$q$, p)), 'ok');
  reset role;

  -- 6. Structure: private role has no runtime members, guard is invoker, trigger enabled.
  perform pg_temp.expect('s1.21 no runtime membership',
    (select count(*)::text from pg_auth_members m
       join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
      where r.rolname = 'patient_lifecycle_writer'
        and u.rolname in ('authenticator', 'anon', 'authenticated', 'service_role')), '0');
  -- DEVIATION from plan text (2026-09-25): format('%s', <bool>) renders
  -- Postgres's boolean text output ('f'/'t'), not the words "false"/"true" —
  -- verified directly against pg_roles; the role's actual attributes
  -- (nologin/noinherit/nobypassrls, i.e. all false) are unchanged and correct.
  perform pg_temp.expect('s1.22 role attributes',
    (select format('%s/%s/%s', rolcanlogin, rolinherit, rolbypassrls) from pg_roles
      where rolname = 'patient_lifecycle_writer'), 'f/f/f');
  perform pg_temp.expect('s1.23 guard is invoker',
    (select prosecdef::text from pg_proc where proname = 'enforce_patient_lifecycle'), 'false');
  perform pg_temp.expect('s1.24 trigger enabled',
    (select tgenabled::text from pg_trigger where tgname = 'trg_patients_lifecycle_guard'), 'O');

  -- 7. The guard's "no other field" branch (code review fix #2), tested
  -- directly. s1.13 above is refused by the writer's COLUMN-LEVEL grant
  -- before the trigger ever runs — real defense, but it never exercises this
  -- PL/pgSQL branch. Temporarily grant first_name too, so the grant no
  -- longer intercepts the attempt, then revoke it again inside the txn.
  grant update (first_name) on public.patients to patient_lifecycle_writer;
  set local role patient_lifecycle_writer;
  perform pg_temp.expect('s1.25 guard no-other-field branch (lifecycle + first_name together)',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L,
                             delete_reason = 'duplicate', first_name = 'Changed2' where id = %L$q$, k_admin, q)), 'P0057');
  -- CONTROL: with the temporary grant in place, first_name ALONE (no
  -- lifecycle field touched) is not a lifecycle change and is not refused —
  -- proving s1.25 is specifically the "no other field" guard, not the grant.
  perform pg_temp.expect('s1.26 CONTROL first_name alone with temp grant',
    pg_temp.state_of(format($q$update public.patients set first_name = 'Changed3' where id = %L$q$, q)), 'ok');
  reset role;
  revoke update (first_name) on public.patients from patient_lifecycle_writer;

  -- 8. The writer may not overwrite deletion metadata on an already-deleted
  -- row (code review fix #4) — only a genuine restore (deleted_at -> null)
  -- may touch it.
  set local role patient_lifecycle_writer;
  update public.patients set deleted_at = now(), deleted_by = k_admin, delete_reason = 'duplicate' where id = s;
  -- Must be a DIFFERENT actor than the original deleted_by, or the "update"
  -- is not distinct from the current value and never reaches v_lifecycle_changed.
  perform pg_temp.expect('s1.27 writer cannot overwrite deleted_by on a deleted row',
    pg_temp.state_of(format($q$update public.patients set deleted_by = %L where id = %L$q$,
                             'a1000000-0000-4000-8000-000000000167'::uuid, s)), 'P0058');
  reset role;

  -- 9. Real-world writers that update patients also respect the guard. This
  -- pins CURRENT, ACTUAL behaviour (code review fix #1), not the intended
  -- end state: maintain_repeat_patient_flag only UPDATEs patients when a
  -- SECOND visit arrives for a patient whose is_repeat_patient is still
  -- false, so a deleted patient's FIRST visit is ACCEPTED by the database
  -- today and only the second one reaches this guard.
  -- PR 3 adds child-table guards — update this when it does.
  set local role patient_lifecycle_writer;
  update public.patients set deleted_at = now(), deleted_by = k_admin, delete_reason = 'duplicate' where id = r;
  reset role;
  perform pg_temp.expect('s1.28 CURRENT: first visit on a deleted patient is accepted',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L, false, 'unpaid', 0, 0)$q$, r)), 'ok');
  perform pg_temp.expect('s1.29 CURRENT: second visit on a deleted patient is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L, false, 'unpaid', 0, 0)$q$, r)), 'P0058');

  -- A consent-withdrawal event on a deleted patient is refused too, because
  -- sync_patient_consent_state's UPDATE on patients hits the same guard
  -- (code review fix #7). Owner decision pending: withdrawing consent on a
  -- deleted record requires restoring it first.
  perform pg_temp.expect('s1.30 consent withdrawal on a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.patient_consents
                             (patient_id, event_type, reason, actor_kind, created_by)
                             values (%L, 'withdrawn', 'testing guard', 'staff', %L)$q$, s, k_admin)), 'P0058');

  -- 10. RLS's "staff full" policy would allow an authenticated admin to
  -- touch patients; the guard still refuses, whether the write is a plain
  -- UPDATE (clearing or setting deleted_at) or an upsert (code review #8).
  set local role authenticated;
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', k_admin), true);
  perform pg_temp.expect('s1.31 authenticated admin clears deleted_at on a deleted row',
    pg_temp.state_of(format($q$update public.patients set deleted_at = null, deleted_by = null, delete_reason = null where id = %L$q$, s)), 'P0057');
  perform pg_temp.expect('s1.32 authenticated admin sets deleted_at on an active row',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'duplicate' where id = %L$q$, k_admin, t)), 'P0057');
  perform pg_temp.expect('s1.33 authenticated admin upsert cannot set deleted_at',
    pg_temp.state_of(format($q$insert into public.patients (id, drm_id, first_name, last_name, birthdate)
                             select id, drm_id, first_name, last_name, birthdate from public.patients where id = %L
                             on conflict (id) do update set deleted_at = now(), deleted_by = %L, delete_reason = 'duplicate'$q$, t, k_admin)), 'P0057');
  perform set_config('request.jwt.claims', '', true);
  reset role;
end
$s1$;

-- --- s2: patient_kept_counts ----------------------------------------------------
do $s2$
declare
  p uuid := pg_temp.mk_patient('S2A');
  empty uuid := pg_temp.mk_patient('S2B');
  v1 uuid; v2 uuid;
  got text;
begin
  v1 := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  v2 := pg_temp.mk_visit(p, false, 'unpaid', 0, 0);
  -- A queue-deleted visit is not "on file" for the patient page, so it is not counted.
  update public.visits set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000167',
         delete_reason = 'smoke' where id = v2;
  insert into public.payments (visit_id, amount_php, method, received_by)
  values (v1, 600, 'gcash', 'a0000000-0000-4000-8000-000000000167'),
         (v1, 400, 'gcash', 'a0000000-0000-4000-8000-000000000167');
  insert into public.appointments (patient_id, scheduled_at, status)
  values (p, now() - interval '30 days', 'completed'), (p, now() - interval '20 days', 'cancelled');
  insert into public.patient_consents (patient_id, event_type, method, notice_version, signatory, actor_kind)
  values (p, 'granted', 'paper_wet_signature', 'v1', 'self', 'staff');

  select format('%s/%s/%s/%s', visits, payments, appointments, consents) into got
    from public.patient_kept_counts(array[p]) where patient_id = p;
  perform pg_temp.expect('s2.1 counts', got, '1/2/2/1');

  select format('%s/%s/%s/%s', visits, payments, appointments, consents) into got
    from public.patient_kept_counts(array[empty]) where patient_id = empty;
  perform pg_temp.expect('s2.2 zero counts', got, '0/0/0/0');

  perform pg_temp.expect('s2.3 one row per id, unknown ids ignored',
    (select count(*)::text from public.patient_kept_counts(array[p, empty, gen_random_uuid()])), '2');

  set local role authenticated;
  perform pg_temp.expect('s2.4 authenticated cannot call',
    pg_temp.state_of(format('select * from public.patient_kept_counts(array[%L]::uuid[])', p)), '42501');
  reset role;
end
$s2$;

-- --- s3: blockers — appointments, clinical, non-HMO money -----------------------
-- Sorted, comma-joined blocker kinds for a patient ('' when deletable).
create function pg_temp.kinds(p uuid) returns text language sql as $f$
  select coalesce(string_agg(b->>'kind', ',' order by b->>'kind'), '')
  from jsonb_array_elements(public.patient_delete_blockers(p)) b;
$f$;
grant execute on function pg_temp.kinds(uuid) to public;

do $s3$
declare
  k_today timestamptz := date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  p uuid; v uuid; h uuid;
begin
  -- Deletable baseline: no rows at all.
  p := pg_temp.mk_patient('S3A');
  perform pg_temp.expect('s3.1 empty patient deletable', pg_temp.kinds(p), '');

  -- Appointments: every status, dated/undated callback, today vs yesterday.
  p := pg_temp.mk_patient('S3B');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, null, 'pending_callback');
  perform pg_temp.expect('s3.2 undated callback blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3C');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, now() - interval '40 days', 'pending_callback');
  perform pg_temp.expect('s3.3 past-dated callback still blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3D');
  -- One minute after Manila midnight today: earlier than "now" for most of the day, still blocks.
  insert into public.appointments (patient_id, scheduled_at, status) values (p, k_today + interval '1 minute', 'confirmed');
  perform pg_temp.expect('s3.4 confirmed earlier today blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3E');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, k_today + interval '1 minute', 'arrived');
  perform pg_temp.expect('s3.5 arrived today blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3F');
  -- CONTROL for s3.4: one minute BEFORE Manila midnight (yesterday in Manila, "today" in UTC for 8 hours).
  insert into public.appointments (patient_id, scheduled_at, status) values (p, k_today - interval '1 minute', 'confirmed');
  perform pg_temp.expect('s3.6 CONTROL confirmed yesterday (Manila) does not block', pg_temp.kinds(p), '');
  -- Exactly Manila midnight today: the boundary is >=, not >.
  p := pg_temp.mk_patient('S3F2');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, k_today, 'confirmed');
  perform pg_temp.expect('s3.6b confirmed exactly at Manila midnight blocks (>=, not >)', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3G');
  insert into public.appointments (patient_id, scheduled_at, status)
  values (p, now() + interval '3 days', 'cancelled'), (p, now() + interval '3 days', 'no_show'),
         (p, now() + interval '3 days', 'completed');
  perform pg_temp.expect('s3.7 cancelled/no_show/completed never block', pg_temp.kinds(p), '');
  p := pg_temp.mk_patient('S3H');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, now() + interval '5 days', 'confirmed');
  perform pg_temp.expect('s3.8 future confirmed blocks', pg_temp.kinds(p), 'appointment');
  -- Undated confirmed/arrived walk-ins (online lab-request bookings): open forever.
  p := pg_temp.mk_patient('S3H2');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, null, 'confirmed');
  perform pg_temp.expect('s3.8b undated confirmed walk-in blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3H3');
  insert into public.appointments (patient_id, scheduled_at, status)
  values (p, null, 'cancelled'), (p, null, 'completed');
  perform pg_temp.expect('s3.8c CONTROL undated cancelled/completed do not block', pg_temp.kinds(p), '');

  -- Clinical: each open status blocks; released/cancelled do not.
  p := pg_temp.mk_patient('S3I');
  v := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  perform pg_temp.mk_line(v, 'requested', 1000, null);
  perform pg_temp.expect('s3.9 requested blocks (even on a paid visit)', pg_temp.kinds(p), 'clinical');
  update public.test_requests set status = 'in_progress' where visit_id = v;
  perform pg_temp.expect('s3.10 in_progress blocks', pg_temp.kinds(p), 'clinical');
  update public.test_requests set status = 'result_uploaded' where visit_id = v;
  perform pg_temp.expect('s3.11 result_uploaded blocks', pg_temp.kinds(p), 'clinical');
  update public.test_requests set status = 'ready_for_release' where visit_id = v;
  perform pg_temp.expect('s3.12 ready_for_release blocks', pg_temp.kinds(p), 'clinical');
  p := pg_temp.mk_patient('S3J');
  v := pg_temp.mk_visit(p, false, 'paid', 1500, 1500);
  perform pg_temp.mk_line(v, 'released', 1000, null);
  perform pg_temp.mk_line(v, 'cancelled', 500, null);
  perform pg_temp.expect('s3.13 CONTROL released + cancelled, paid: deletable', pg_temp.kinds(p), '');
  -- A doctor consultation is a bill line like any other.
  p := pg_temp.mk_patient('S3K');
  v := pg_temp.mk_visit(p, false, 'paid', 500, 500);
  perform pg_temp.mk_line(v, 'requested', 500, null, null, 'c1000000-0000-4000-8000-000000000167');
  perform pg_temp.expect('s3.14 open doctor line blocks', pg_temp.kinds(p), 'clinical');
  -- Package: an open header blocks; a released header with released components does not.
  p := pg_temp.mk_patient('S3L');
  v := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  h := pg_temp.mk_line(v, 'released', 1000, null, null, 'c0000000-0000-4000-8000-000000000167', true);
  perform pg_temp.mk_line(v, 'in_progress', 0, null, h);
  perform pg_temp.expect('s3.15 open package component blocks', pg_temp.kinds(p), 'clinical');
  -- CONTROL for s3.15: a released header with a released component is deletable.
  p := pg_temp.mk_patient('S3L2');
  v := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  h := pg_temp.mk_line(v, 'released', 1000, null, null, 'c0000000-0000-4000-8000-000000000167', true);
  perform pg_temp.mk_line(v, 'released', 0, null, h);
  perform pg_temp.expect('s3.15b CONTROL released header + released component: deletable', pg_temp.kinds(p), '');
  -- Empty intake: a live visit with no live lines still blocks via empty_visit.
  p := pg_temp.mk_patient('S3M');
  v := pg_temp.mk_visit(p, false, 'unpaid', 0, 0);
  perform pg_temp.expect('s3.16 empty visit blocks via empty_visit', pg_temp.kinds(p), 'empty_visit');
  -- 2026-09-25 review: prod has 4,147 imported historical visits with
  -- total_php = 0 and payment_status 'unpaid' forever — a ₱0 unpaid visit
  -- must NOT block on balance (isolated here with a live line so the visit
  -- itself is not "empty").
  p := pg_temp.mk_patient('S3M2');
  v := pg_temp.mk_visit(p, false, 'unpaid', 0, 0);
  perform pg_temp.mk_line(v, 'released', 0, null);
  perform pg_temp.expect('s3.16b a genuine ₱0 unpaid visit (historical import) is deletable', pg_temp.kinds(p), '');
  -- CONTROL for s3.16b: a visit that genuinely owes even ₱1 still blocks.
  p := pg_temp.mk_patient('S3M3');
  v := pg_temp.mk_visit(p, false, 'unpaid', 1, 0);
  perform pg_temp.mk_line(v, 'released', 1, null);
  perform pg_temp.expect('s3.16c CONTROL a ₱1-owing unpaid visit still blocks', pg_temp.kinds(p), 'balance');
  -- Independently deleted rows do not block.
  p := pg_temp.mk_patient('S3N');
  v := pg_temp.mk_visit(p, false, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'requested', 1000, null);
  update public.visits set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000167',
         delete_reason = 'smoke' where id = v;
  perform pg_temp.expect('s3.17 queue-deleted visit (and its orphan line) do not block', pg_temp.kinds(p), '');

  -- Non-HMO money.
  p := pg_temp.mk_patient('S3O');
  v := pg_temp.mk_visit(p, false, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'released', 1000, null);
  perform pg_temp.expect('s3.18 unpaid blocks', pg_temp.kinds(p), 'balance');
  update public.visits set payment_status = 'partial', paid_php = 400 where id = v;
  perform pg_temp.expect('s3.19 partial blocks', pg_temp.kinds(p), 'balance');
  perform pg_temp.expect('s3.20 amount is the balance',
    (select b->>'amount_php' from jsonb_array_elements(public.patient_delete_blockers(p)) b), '600.00');
  update public.visits set payment_status = 'waived' where id = v;
  perform pg_temp.expect('s3.21 waived does not block', pg_temp.kinds(p), '');
  update public.visits set payment_status = 'paid', paid_php = 1000 where id = v;
  perform pg_temp.expect('s3.22 paid does not block', pg_temp.kinds(p), '');

  -- Shape: every blocker carries the six keys; links point at staff pages.
  p := pg_temp.mk_patient('S3P');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, null, 'pending_callback');
  v := pg_temp.mk_visit(p, false, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'requested', 1000, null);
  perform pg_temp.expect('s3.23 keys',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(public.patient_delete_blockers(p)->0) k),
    'amount_php,href,kind,label,resource_id,visit_id');
  perform pg_temp.expect('s3.24 appointment first, deterministic order',
    (select string_agg(b->>'kind', ',') from jsonb_array_elements(public.patient_delete_blockers(p)) b),
    'appointment,clinical,balance');
  perform pg_temp.expect('s3.25 hrefs are staff routes',
    (select bool_and(b->>'href' like '/staff/%')::text from jsonb_array_elements(public.patient_delete_blockers(p)) b),
    'true');
end
$s3$;

-- --- s4: blockers — HMO --------------------------------------------------------
do $s4$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000167';
  k_hmo   constant uuid := 'b0000000-0000-4000-8000-000000000167';
  p uuid; v uuid; l uuid; l2 uuid; h uuid; bt uuid; it uuid; pay uuid;
  amt text;
begin
  -- Helper-local: a batch per scenario.
  -- 1. Released HMO line, approved 800 of 1000, claim billed 800 and fully paid,
  --    co-pay 200 paid by the patient → deletable even though the visit stays 'unpaid' (0133).
  p := pg_temp.mk_patient('S4A');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 800);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php)
  values (bt, l, 800, 800);
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 200, 'gcash', k_admin);
  perform pg_temp.expect('s4.1 settled claim + paid co-pay: deletable despite stale unpaid', pg_temp.kinds(p), '');

  -- 2. Same, co-pay NOT paid → patient share blocks with the exact amount.
  p := pg_temp.mk_patient('S4B');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 800);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php)
  values (bt, l, 800, 800);
  perform pg_temp.expect('s4.2 unpaid co-pay blocks', pg_temp.kinds(p), 'hmo_patient_share');
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.3 co-pay amount', amt, '200.00');
  -- Partial co-pay payment leaves the rest.
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 150, 'gcash', k_admin);
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.4 partial co-pay', amt, '50.00');
  -- A voided patient payment does not count.
  update public.payments set voided_at = now(), voided_by = k_admin, void_reason = 'smoke'
   where visit_id = v and amount_php = 150;
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.5 voided payment ignored', amt, '200.00');
  -- Waiver clears the original co-pay.
  update public.visits set payment_status = 'waived' where id = v;
  perform pg_temp.expect('s4.6 waived clears co-pay', pg_temp.kinds(p), '');

  -- 3. Claim still pending (nothing paid) → unsettled claim blocks.
  p := pg_temp.mk_patient('S4C');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'submitted') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bt, l, 1000);
  perform pg_temp.expect('s4.7 pending claim blocks', pg_temp.kinds(p), 'hmo_claim');
  -- Rejected/draft labels are not settlement.
  update public.hmo_claim_batches set status = 'rejected' where id = bt;
  perform pg_temp.expect('s4.8 rejected batch still blocks', pg_temp.kinds(p), 'hmo_claim');
  -- Written off in full → settled.
  update public.hmo_claim_items set written_off_amount_php = 1000 where batch_id = bt;
  perform pg_temp.expect('s4.9 full write-off settles', pg_temp.kinds(p), '');

  -- 4. Transfer to patient: claim resolved, but the patient now owes it.
  p := pg_temp.mk_patient('S4D');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'partial_paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php,
                                      patient_billed_amount_php)
  values (bt, l, 1000, 700, 300);
  perform pg_temp.expect('s4.10 transfer to patient blocks as patient share', pg_temp.kinds(p), 'hmo_patient_share');
  -- Waiver does NOT clear a later claim-to-patient transfer.
  update public.visits set payment_status = 'waived' where id = v;
  perform pg_temp.expect('s4.11 waiver keeps the transfer', pg_temp.kinds(p), 'hmo_patient_share');
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 300, 'gcash', k_admin);
  perform pg_temp.expect('s4.12 transfer paid: deletable', pg_temp.kinds(p), '');

  -- 5. Approved coverage never claimed → unbilled.
  p := pg_temp.mk_patient('S4E');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'released', 1000, 1000);
  perform pg_temp.expect('s4.13 approved, unclaimed blocks', pg_temp.kinds(p), 'hmo_unbilled');
  -- Explicit zero coverage = patient pays all; nothing to claim.
  p := pg_temp.mk_patient('S4F');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'released', 1000, 0);
  perform pg_temp.expect('s4.14 zero coverage: patient share only', pg_temp.kinds(p), 'hmo_patient_share');
  -- NULL coverage on an unclaimed line is treated as fully covered by the
  -- HMO — NOT a reconciliation problem (2026-09-25 review: prod has never
  -- claimed a line or set hmo_approved_amount_php outside doctor_procedure
  -- creation-time defaults, so flagging this permanently blocked 443 of 925
  -- HMO patients). Consistent with 0133 (an HMO visit releases without a
  -- counter payment).
  p := pg_temp.mk_patient('S4G');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'released', 1000, null);
  perform pg_temp.expect('s4.15 NULL coverage, unclaimed: fully covered, no blocker', pg_temp.kinds(p), '');

  -- 6. Voided batch: the claim is gone, the line is unbilled again.
  p := pg_temp.mk_patient('S4H');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status, voided_at, voided_by, void_reason)
  values (k_hmo, 'voided', now(), k_admin, 'smoke') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, batch_voided)
  values (bt, l, 1000, true);
  perform pg_temp.expect('s4.16 voided batch: unbilled again', pg_temp.kinds(p), 'hmo_unbilled');
  -- A live item on a voided batch is a reconciliation problem.
  update public.hmo_claim_items set batch_voided = false where batch_id = bt;
  perform pg_temp.expect('s4.17 live item on voided batch',
    pg_temp.kinds(p), 'hmo_claim,hmo_reconciliation');

  -- 7. Claim disagrees with approval.
  p := pg_temp.mk_patient('S4I');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 800);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php)
  values (bt, l, 900, 900);
  perform pg_temp.expect('s4.18 claim ≠ approval', pg_temp.kinds(p), 'hmo_reconciliation');

  -- 8. Package: components never counted twice (give one a price on purpose).
  p := pg_temp.mk_patient('S4J');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  h := pg_temp.mk_line(v, 'released', 1000, 800, null, 'c0000000-0000-4000-8000-000000000167', true);
  update public.test_requests set status = 'released' where id = h and status <> 'released';
  perform pg_temp.mk_line(v, 'released', 100, 100, h);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php)
  values (bt, h, 800, 800);
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b
   where b->>'kind' = 'hmo_patient_share';
  perform pg_temp.expect('s4.19 package share uses the header only', amt, '200.00');

  -- 9. Claim on a line that was (wrongly) queue-deleted still blocks. A second,
  -- released line keeps the visit non-empty (DEVIATION from plan text,
  -- 2026-09-25: deleting a visit's ONLY line correctly also raises
  -- 'empty_visit' per section 6 — a second live line isolates this assertion
  -- to the hmo_claim rule it is meant to test).
  p := pg_temp.mk_patient('S4K');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  perform pg_temp.mk_line(v, 'released', 0, null);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'submitted') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bt, l, 1000);
  -- Bypass 0125's trg_test_requests_deletable_guard (extended by 0147 with
  -- the P0050 open-claim-item check that would otherwise refuse this) the
  -- way history might have: a direct column write, as postgres, test only.
  alter table public.test_requests disable trigger trg_test_requests_deletable_guard;
  update public.test_requests set deleted_at = now(), deleted_by = k_admin, delete_reason = 'smoke' where id = l;
  alter table public.test_requests enable trigger trg_test_requests_deletable_guard;
  perform pg_temp.expect('s4.20 claim on deleted line still blocks', pg_temp.kinds(p), 'hmo_claim');

  -- 10. Insurer payment not fully allocated → reconciliation; allocations count once.
  p := pg_temp.mk_patient('S4L');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bt, l, 1000)
  returning id into it;
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 1000, 'hmo', k_admin)
  returning id into pay;
  perform pg_temp.expect('s4.21 unallocated insurer payment',
    pg_temp.kinds(p), 'hmo_claim,hmo_reconciliation');
  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (pay, it, 1000);
  -- The allocation trigger recomputes paid_amount_php = 1000: claim settled, payment matched,
  -- and the 'hmo' payment is NOT counted again as a patient payment.
  perform pg_temp.expect('s4.22 fully allocated: deletable', pg_temp.kinds(p), '');
  -- Voiding the insurer payment (cascade voids the allocation) reopens the claim.
  update public.payments set voided_at = now(), voided_by = k_admin, void_reason = 'smoke' where id = pay;
  perform pg_temp.expect('s4.23 voided settlement reopens the claim', pg_temp.kinds(p), 'hmo_claim');

  -- 11. An insurer settlement logged as its own, properly-allocated payment
  -- row (method 'hmo') must never count toward the PATIENT's own co-pay —
  -- added because the mutation check below cannot observe this on any
  -- existing scenario: every 'hmo'-method payment above sits on a visit
  -- whose principal is already ₱0 once its own claim is settled, so
  -- double-counting it changes nothing observable. Here the claim (₱600 of
  -- ₱1000 approved) is fully paid and allocated, leaving a REAL ₱400 co-pay.
  p := pg_temp.mk_patient('S4M');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 600);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bt, l, 600)
  returning id into it;
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 600, 'hmo', k_admin)
  returning id into pay;
  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (pay, it, 600);
  perform pg_temp.expect('s4.24 real co-pay still blocks despite a fully-allocated hmo settlement payment',
    pg_temp.kinds(p), 'hmo_patient_share');
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.25 co-pay amount unaffected by the settlement payment', amt, '400.00');

  -- 12. A ₱300 transfer-to-patient must survive its own line being
  -- (wrongly) queue-deleted afterwards — sourced from claim_items, not
  -- hmo_lines, so it is not lost, and not double-counted while the line is
  -- still live either (2026-09-25 review, item D). A second, released line
  -- keeps the visit non-empty once l is deleted (same trick as s4.20).
  p := pg_temp.mk_patient('S4N');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  perform pg_temp.mk_line(v, 'released', 0, null);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'partial_paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php,
                                      patient_billed_amount_php)
  values (bt, l, 1000, 700, 300);
  perform pg_temp.expect('s4.26 transfer blocks before its line is deleted', pg_temp.kinds(p), 'hmo_patient_share');
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.27 transfer amount is 300 before delete', amt, '300.00');
  -- Bypass 0125's trg_test_requests_deletable_guard (extended by 0147 with
  -- the P0050 open-claim-item check) the way history might have: a direct
  -- column write, as postgres, test only.
  alter table public.test_requests disable trigger trg_test_requests_deletable_guard;
  update public.test_requests set deleted_at = now(), deleted_by = k_admin, delete_reason = 'smoke' where id = l;
  alter table public.test_requests enable trigger trg_test_requests_deletable_guard;
  perform pg_temp.expect('s4.28 transfer still blocks after its line is soft-deleted', pg_temp.kinds(p), 'hmo_patient_share');
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.29 transfer amount unchanged (not double-counted) after delete', amt, '300.00');

  -- 13. Same transfer, but the VISIT itself is (wrongly) soft-deleted, not
  -- just its line (2026-09-25 re-review): the hmo_patient_share branch
  -- joins public.visits, not live_visits, so this must still block.
  p := pg_temp.mk_patient('S4O');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'partial_paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php,
                                      patient_billed_amount_php)
  values (bt, l, 1000, 700, 300);
  perform pg_temp.expect('s4.30 transfer blocks before its visit is deleted', pg_temp.kinds(p), 'hmo_patient_share');
  -- Bypass 0125's trg_visits_deletable_guard the way history might have: a
  -- direct column write, as postgres, test only.
  alter table public.visits disable trigger trg_visits_deletable_guard;
  update public.visits set deleted_at = now(), deleted_by = k_admin, delete_reason = 'smoke' where id = v;
  alter table public.visits enable trigger trg_visits_deletable_guard;
  perform pg_temp.expect('s4.31 transfer still blocks after its VISIT is soft-deleted', pg_temp.kinds(p), 'hmo_patient_share');
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.32 transfer amount unchanged after visit delete', amt, '300.00');
end
$s4$;

-- --- s5: delete_patient / restore_patient ---------------------------------------
do $s5$
declare
  k_admin     constant uuid := 'a0000000-0000-4000-8000-000000000167';
  k_reception constant uuid := 'a1000000-0000-4000-8000-000000000167';
  k_former    constant uuid := 'a2000000-0000-4000-8000-000000000167';
  ctx jsonb := '{"ip":"203.0.113.9","user_agent":"smoke"}';
  p uuid; q uuid; m uuid; v uuid; p2 uuid; v2 uuid; p3 uuid; v3 uuid; p4 uuid; v4 uuid;
  res jsonb; st text;
begin
  p := pg_temp.mk_patient('S5A');
  v := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  perform pg_temp.mk_line(v, 'released', 1000, null);

  set local role service_role;
  -- Actor checks.
  perform pg_temp.expect('s5.1 reception actor refused',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_reception, ctx)), 'P0057');
  perform pg_temp.expect('s5.2 inactive admin refused',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_former, ctx)), 'P0057');
  perform pg_temp.expect('s5.3 null actor refused',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', null, %L)$q$, p, ctx)), 'P0057');
  -- Metadata checks.
  perform pg_temp.expect('s5.4 bad reason',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'nope', '', %L, %L)$q$, p, k_admin, ctx)), 'P0060');
  perform pg_temp.expect('s5.5 other without note',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'other', '   ', %L, %L)$q$, p, k_admin, ctx)), 'P0060');
  perform pg_temp.expect('s5.6 note too long',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'other', %L, %L, %L)$q$, p, repeat('x', 501), k_admin, ctx)), 'P0060');
  perform pg_temp.expect('s5.7 unexpected context key',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, '{"ip":"1.2.3.4","actor":"x"}')$q$, p, k_admin)), 'P0060');
  perform pg_temp.expect('s5.7b context must be a JSON object, not an array',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, '[]'::jsonb)$q$, gen_random_uuid(), k_admin)), 'P0060');
  -- Target checks.
  perform pg_temp.expect('s5.8 missing patient',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, gen_random_uuid(), k_admin, ctx)), 'P0058');
  reset role;

  -- Success: returns id, drm_id and kept counts; row + audit written together.
  set local role service_role;
  res := public.delete_patient(p, 'other', '  typo in birthdate  ', k_admin, ctx);
  reset role;
  perform pg_temp.expect('s5.9 result drm_id', res->>'drm_id', 'DRM-PDS5A');
  perform pg_temp.expect('s5.10 result kept visits', res->'kept'->>'visits', '1');
  perform pg_temp.expect('s5.11 row stamped',
    (select format('%s|%s|%s', deleted_by, delete_reason, delete_note) from public.patients where id = p),
    format('%s|other|typo in birthdate', k_admin));
  perform pg_temp.expect('s5.12 audit row',
    (select format('%s|%s|%s|%s|%s', actor_id, actor_type, action, metadata->>'reason', host(ip_address))
       from public.audit_log where patient_id = p and action = 'patient.deleted'),
    format('%s|staff|patient.deleted|other|203.0.113.9', k_admin));
  perform pg_temp.expect('s5.13 audit carries kept counts',
    (select metadata->'kept'->>'visits' from public.audit_log where patient_id = p and action = 'patient.deleted'), '1');
  perform pg_temp.expect('s5.13b audit user_agent equals what was passed',
    (select user_agent from public.audit_log where patient_id = p and action = 'patient.deleted'), 'smoke');

  -- Deleting again / deleting a merged row.
  set local role service_role;
  perform pg_temp.expect('s5.14 already deleted',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_admin, ctx)), 'P0058');
  reset role;
  q := pg_temp.mk_patient('S5B');
  m := pg_temp.mk_patient('S5C');
  update public.patients set merged_into_id = q, merged_at = now() where id = m;
  set local role service_role;
  perform pg_temp.expect('s5.15 merged row cannot be deleted',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, m, k_admin, ctx)), 'P0058');
  perform pg_temp.expect('s5.16 merged row cannot be restored',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, m, k_admin, ctx)), 'P0061');
  perform pg_temp.expect('s5.17 active row cannot be restored',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, q, k_admin, ctx)), 'P0061');
  perform pg_temp.expect('s5.18 reception cannot restore',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, p, k_reception, ctx)), 'P0057');
  perform pg_temp.expect('s5.18b inactive (former) admin cannot restore',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, p, k_former, ctx)), 'P0057');
  reset role;

  -- Blockers refuse with P0059 and the JSON list in DETAIL.
  q := pg_temp.mk_patient('S5D');
  insert into public.appointments (patient_id, scheduled_at, status) values (q, null, 'pending_callback');
  set local role service_role;
  begin
    perform public.delete_patient(q, 'duplicate', '', k_admin, ctx);
    st := 'ok';
  exception when others then
    get stacked diagnostics st = returned_sqlstate, res = pg_exception_detail;
  end;
  reset role;
  perform pg_temp.expect('s5.19 blocked with P0059', st, 'P0059');
  perform pg_temp.expect('s5.20 DETAIL is the blocker JSON', (res->0->>'kind'), 'appointment');
  perform pg_temp.expect('s5.21 blocked patient untouched',
    (select (deleted_at is null)::text from public.patients where id = q), 'true');

  -- Restore round-trip keeps the DRM-ID.
  set local role service_role;
  res := public.restore_patient(p, k_admin, ctx);
  reset role;
  perform pg_temp.expect('s5.22 restored', (select (deleted_at is null and delete_reason is null)::text
                                             from public.patients where id = p), 'true');
  perform pg_temp.expect('s5.23 same DRM-ID', (select drm_id from public.patients where id = p), 'DRM-PDS5A');
  perform pg_temp.expect('s5.24 restore audit', (select metadata->>'previous_reason' from public.audit_log
                                                   where patient_id = p and action = 'patient.restored'), 'other');

  -- Audit failure rolls the change back (no double-log, no silent success).
  -- A dedicated fresh patient (not `p`, which already carries delete/restore
  -- history) so the positive control's "exactly one" row count means
  -- something.
  p2 := pg_temp.mk_patient('S5E');
  v2 := pg_temp.mk_visit(p2, false, 'paid', 0, 0);
  perform pg_temp.mk_line(v2, 'released', 0, null);
  revoke insert on public.audit_log from patient_lifecycle_writer;
  set local role service_role;
  perform pg_temp.expect('s5.25 audit failure aborts',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p2, k_admin, ctx)), '42501');
  reset role;
  perform pg_temp.expect('s5.25b patient untouched by the aborted attempt',
    (select (deleted_at is null)::text from public.patients where id = p2), 'true');
  grant insert on public.audit_log to patient_lifecycle_writer;

  -- s5.26 POSITIVE CONTROL (replaces a vacuous check): state_of() runs the
  -- call inside its own PL/pgSQL exception handler, which establishes an
  -- implicit savepoint and rolls back to it on ANY error — so asserting
  -- "row unchanged" through state_of alone proves nothing about
  -- delete_patient's own transactional correctness; it would pass even if
  -- delete_patient never protected itself, because Postgres undoes the
  -- whole EXECUTE regardless. Prove the real thing instead: once INSERT is
  -- restored, the SAME call (made directly, not through state_of) succeeds
  -- outright, and exactly one 'patient.deleted' audit row exists for this
  -- patient (not two from a double-write, not zero from a silent no-op).
  set local role service_role;
  perform public.delete_patient(p2, 'duplicate', '', k_admin, ctx);
  reset role;
  perform pg_temp.expect('s5.26 positive control: succeeds once INSERT is restored',
    (select (deleted_at is not null)::text from public.patients where id = p2), 'true');
  perform pg_temp.expect('s5.26b exactly one patient.deleted audit row',
    (select count(*)::text from public.audit_log where patient_id = p2 and action = 'patient.deleted'), '1');

  -- A malformed multi-address ip (as a proxy might send) is not a valid
  -- inet literal; the ::inet cast raises invalid_text_representation, which
  -- is caught, and the delete proceeds with a NULL ip_address rather than
  -- being rejected outright.
  p3 := pg_temp.mk_patient('S5F');
  v3 := pg_temp.mk_visit(p3, false, 'paid', 0, 0);
  perform pg_temp.mk_line(v3, 'released', 0, null);
  set local role service_role;
  perform public.delete_patient(p3, 'duplicate', '', k_admin,
    '{"ip":"1.2.3.4, 5.6.7.8","user_agent":"smoke"}'::jsonb);
  reset role;
  perform pg_temp.expect('s5.31 malformed multi-address ip: delete still succeeds',
    (select (deleted_at is not null)::text from public.patients where id = p3), 'true');
  perform pg_temp.expect('s5.32 malformed multi-address ip: audit ip_address is NULL',
    (select (ip_address is null)::text from public.audit_log
      where patient_id = p3 and action = 'patient.deleted'), 'true');

  -- user_agent longer than 512 chars is truncated, not rejected or stored
  -- in full (bounds an unbounded client-supplied string in an audit row).
  p4 := pg_temp.mk_patient('S5G');
  v4 := pg_temp.mk_visit(p4, false, 'paid', 0, 0);
  perform pg_temp.mk_line(v4, 'released', 0, null);
  set local role service_role;
  perform public.delete_patient(p4, 'duplicate', '', k_admin,
    jsonb_build_object('ip', '203.0.113.9', 'user_agent', repeat('u', 600)));
  reset role;
  perform pg_temp.expect('s5.33 user_agent capped at 512 chars',
    (select length(user_agent)::text from public.audit_log
      where patient_id = p4 and action = 'patient.deleted'), '512');
  perform pg_temp.expect('s5.34 capped user_agent is a left-truncation, not garbage',
    (select user_agent from public.audit_log where patient_id = p4 and action = 'patient.deleted'),
    repeat('u', 512));

  -- ACLs and structure.
  set local role authenticated;
  perform pg_temp.expect('s5.27 authenticated cannot delete',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_admin, ctx)), '42501');
  reset role;
  set local role anon;
  perform pg_temp.expect('s5.28 anon cannot restore',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, p, k_admin, ctx)), '42501');
  reset role;
  perform pg_temp.expect('s5.29 owners',
    (select string_agg(p2.proname || '=' || r.rolname, ',' order by p2.proname)
       from pg_proc p2 join pg_roles r on r.oid = p2.proowner
      where p2.proname in ('delete_patient', 'restore_patient', 'patient_delete_blockers', 'patient_kept_counts')),
    'delete_patient=patient_lifecycle_writer,patient_delete_blockers=postgres,patient_kept_counts=postgres,restore_patient=patient_lifecycle_writer');
  perform pg_temp.expect('s5.30 pinned search_path',
    (select bool_and(p2.proconfig @> array['search_path=pg_catalog, public, pg_temp'])::text
       from pg_proc p2 where p2.proname in ('delete_patient', 'restore_patient', 'patient_delete_blockers',
                                            'patient_kept_counts', 'enforce_patient_lifecycle')),
    'true');
end
$s5$;

-- --- s6: current_patient_id() and portal RLS ------------------------------------
-- CORRECTION (controller-notes.md hint, verified 2026-09-25): on this stack
-- auth.uid() (which has_role() calls, and so the staff RLS policies) reads
-- the SINGULAR GUC `request.jwt.claim.sub`, not `request.jwt.claims ->> 'sub'`
-- — confirmed via `select prosrc from pg_proc where proname = 'uid' and
-- pronamespace = 'auth'::regnamespace`. s6.9 sets BOTH the JSON blob (which
-- current_patient_id()/PostgREST-style policies read) and the singular GUC
-- (which auth.uid() actually reads).
do $s6$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000167';
  p uuid := pg_temp.mk_patient('S6A');
  keep uuid := pg_temp.mk_patient('S6B');
  merged uuid := pg_temp.mk_patient('S6C');
  v uuid;
begin
  v := pg_temp.mk_visit(p, false, 'paid', 0, 0);
  -- A live visit with no test_requests trips the 'empty_visit' blocker (0167
  -- part 6, added after this section was first drafted) — give it a
  -- released line so delete_patient() below succeeds as intended.
  perform pg_temp.mk_line(v, 'released', 0, null);
  update public.patients set merged_into_id = keep, merged_at = now() where id = merged;

  -- The portal client is an anon JWT carrying patient_id (createPatientClient).
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', p)::text, true);
  perform pg_temp.expect('s6.1 active: own row visible', (select count(*)::text from public.patients), '1');
  perform pg_temp.expect('s6.2 active: own visit visible', (select count(*)::text from public.visits), '1');
  reset role;

  set local role service_role;
  perform public.delete_patient(p, 'test_record', '', k_admin, '{}'::jsonb);
  reset role;

  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', p)::text, true);
  perform pg_temp.expect('s6.3 deleted: helper returns null', coalesce(public.current_patient_id()::text, 'null'), 'null');
  perform pg_temp.expect('s6.4 deleted: own row hidden', (select count(*)::text from public.patients), '0');
  perform pg_temp.expect('s6.5 deleted: visits hidden', (select count(*)::text from public.visits), '0');
  -- Merged: no chain following.
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', merged)::text, true);
  perform pg_temp.expect('s6.6 merged: nothing visible', (select count(*)::text from public.patients), '0');
  -- CONTROL: the surviving record still works.
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', keep)::text, true);
  perform pg_temp.expect('s6.7 CONTROL keep visible', (select count(*)::text from public.patients), '1');
  reset role;

  -- Restore honours still-valid tokens again.
  set local role service_role;
  perform public.restore_patient(p, k_admin, '{}'::jsonb);
  reset role;
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', p)::text, true);
  perform pg_temp.expect('s6.8 restored: visible again', (select count(*)::text from public.patients), '1');
  reset role;

  -- Staff history is untouched: an admin JWT still reads the deleted row.
  set local role service_role;
  perform public.delete_patient(p, 'test_record', '', k_admin, '{}'::jsonb);
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', k_admin)::text, true);
  perform set_config('request.jwt.claim.sub', k_admin::text, true);
  perform pg_temp.expect('s6.9 staff still read the deleted record',
    (select count(*)::text from public.patients where id = p), '1');
  reset role;

  -- format('%s', boolean) renders 't'/'f' (the type's output function), not
  -- 'true'/'false' — verified against this Postgres (unlike a direct
  -- `::text` cast, which the rest of this file uses and does say 'true').
  perform pg_temp.expect('s6.10 helper is definer, pinned',
    (select format('%s|%s', prosecdef, proconfig) from pg_proc where proname = 'current_patient_id'),
    't|{"search_path=pg_catalog, public, pg_temp"}');
  perform pg_temp.expect('s6.11 helper anon-executable',
    has_function_privilege('anon', 'public.current_patient_id()', 'execute')::text, 'true');
end
$s6$;

-- --- s7: views -----------------------------------------------------------------
do $s7$
declare
  k_admin     constant uuid := 'a0000000-0000-4000-8000-000000000167';
  k_reception constant uuid := 'a1000000-0000-4000-8000-000000000167';
  live uuid := pg_temp.mk_patient('S7A');
  gone uuid := pg_temp.mk_patient('S7B');
  keep uuid := pg_temp.mk_patient('S7C');
  merged uuid := pg_temp.mk_patient('S7D');
begin
  -- gone and live share an email so they would pair in the dedup view.
  update public.patients set email = 'pds7a@example.test' where id = gone;
  update public.patients set merged_into_id = keep, merged_at = now() where id = merged;
  set local role service_role;
  perform public.delete_patient(gone, 'duplicate', '', k_admin, '{}'::jsonb);
  reset role;

  -- Directory: only active rows.
  perform pg_temp.expect('s7.1 directory hides deleted and merged',
    (select string_agg(drm_id, ',' order by drm_id) from public.v_patients_directory
      where drm_id like 'DRM-PDS7%'), 'DRM-PDS7A,DRM-PDS7C');
  -- Consent worklist: only active rows.
  perform pg_temp.expect('s7.2 without-consent hides deleted and merged',
    (select string_agg(drm_id, ',' order by drm_id) from public.v_patients_without_consent
      where drm_id like 'DRM-PDS7%'), 'DRM-PDS7A,DRM-PDS7C');
  -- Dedup pairs: a deleted row never pairs.
  perform pg_temp.expect('s7.3 dedup ignores deleted',
    (select count(*)::text from public.v_patient_dedup_candidate_pairs
      where id_a in (live, gone) or id_b in (live, gone)), '0');

  -- Admin inclusive view: deleted included, merged excluded, admin only.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', k_admin)::text, true);
  perform set_config('request.jwt.claim.sub', k_admin::text, true);
  perform pg_temp.expect('s7.4 admin sees deleted + active, not merged',
    (select string_agg(drm_id || ':' || (deleted_at is not null)::text, ',' order by drm_id)
       from public.v_patients_directory_admin where drm_id like 'DRM-PDS7%'),
    'DRM-PDS7A:false,DRM-PDS7B:true,DRM-PDS7C:false');
  perform pg_temp.expect('s7.5 admin view carries the actor name',
    (select deleted_by_name from public.v_patients_directory_admin where id = gone), 'PD Admin');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', k_reception)::text, true);
  perform set_config('request.jwt.claim.sub', k_reception::text, true);
  perform pg_temp.expect('s7.6 reception gets no rows from the admin view',
    (select count(*)::text from public.v_patients_directory_admin), '0');
  -- CONTROL: reception still reads the active directory.
  perform pg_temp.expect('s7.7 CONTROL reception reads the directory',
    (select count(*)::text from public.v_patients_directory where id = live), '1');
  reset role;

  -- ACLs and reloptions.
  perform pg_temp.expect('s7.8 anon has no SELECT on any patient view',
    (select string_agg(v || '=' || has_table_privilege('anon', 'public.' || v, 'select')::text, ',' order by v)
       from unnest(array['v_patients_directory', 'v_patients_directory_admin',
                         'v_patient_dedup_candidate_pairs', 'v_patients_without_consent']) v),
    'v_patient_dedup_candidate_pairs=false,v_patients_directory=false,v_patients_directory_admin=false,v_patients_without_consent=false');
  -- NOTE (same lesson as s6.10): format('%s', boolean) renders 't'/'f', not
  -- 'true'/'false' — verified against this Postgres. Cast to text directly.
  perform pg_temp.expect('s7.9 dedup view is service_role-only',
    has_table_privilege('authenticated', 'public.v_patient_dedup_candidate_pairs', 'select')::text || '/' ||
    has_table_privilege('service_role', 'public.v_patient_dedup_candidate_pairs', 'select')::text,
    'false/true');
  perform pg_temp.expect('s7.10 admin view: authenticated only',
    has_table_privilege('authenticated', 'public.v_patients_directory_admin', 'select')::text || '/' ||
    has_table_privilege('service_role', 'public.v_patients_directory_admin', 'select')::text,
    'true/false');
  perform pg_temp.expect('s7.11 every patient view is security_invoker',
    (select bool_and(c.reloptions @> array['security_invoker=true'])::text from pg_class c
      where c.oid in ('public.v_patients_directory'::regclass, 'public.v_patients_directory_admin'::regclass,
                      'public.v_patient_dedup_candidate_pairs'::regclass, 'public.v_patients_without_consent'::regclass)),
    'true');
end
$s7$;

-- --- s8: resolve_patient_guarded -------------------------------------------------
-- NOTE (same lesson as s6.10/s7.9): format('%s', boolean) renders 't'/'f', not
-- 'true'/'false'. Every boolean pair below is built with ::text || '/' || ::text.
do $s8$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000167';
  fields jsonb := '{"first_name":"Res","last_name":"Olve","birthdate":"1991-02-06","email":"pds8@example.test"}';
  first_id uuid; r record; r2 record; merged_src uuid; keep uuid;
begin
  set local role service_role;
  select * into r from public.resolve_patient_guarded('pds8@example.test', 'Olve', '1991-02-06', fields);
  first_id := r.id;
  select * into r from public.resolve_patient_guarded('PDS8@example.test', 'Olve', '1991-02-06', fields);
  reset role;
  perform pg_temp.expect('s8.1 CONTROL active identity is reused',
    (r.id = first_id)::text || '/' || r.reused::text, 'true/true');

  set local role service_role;
  perform public.delete_patient(first_id, 'test_record', '', k_admin, '{}'::jsonb);
  select * into r from public.resolve_patient_guarded('pds8@example.test', 'Olve', '1991-02-06', fields);
  select * into r2 from public.resolve_patient_guarded('pds8@example.test', 'Olve', '1991-02-06', fields);
  reset role;
  perform pg_temp.expect('s8.2 deleted identity gets a fresh record',
    (r.id <> first_id)::text || '/' || r.reused::text, 'true/false');
  perform pg_temp.expect('s8.3 the fresh record is then reused',
    (r2.id = r.id)::text || '/' || r2.reused::text, 'true/true');
  perform pg_temp.expect('s8.4 the deleted record keeps its DRM-ID and state',
    (select (deleted_at is not null)::text from public.patients where id = first_id), 'true');

  -- Merged: never matched either.
  keep := pg_temp.mk_patient('S8K');
  merged_src := r.id;
  update public.patients set merged_into_id = keep, merged_at = now() where id = merged_src;
  set local role service_role;
  select * into r from public.resolve_patient_guarded('pds8@example.test', 'Olve', '1991-02-06', fields);
  reset role;
  perform pg_temp.expect('s8.5 merged identity is not reused',
    (r.id <> merged_src)::text || '/' || r.reused::text, 'true/false');

  perform pg_temp.expect('s8.6 still service_role-only',
    has_function_privilege('anon', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute')::text || '/' ||
    has_function_privilege('authenticated', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute')::text,
    'false/false');
end
$s8$;

-- s9: appointment_attachments BEFORE DELETE guard (coordinator follow-up,
-- 2026-09-25). deletePatientLabRequestUpload runs the real DELETE via the
-- admin (service_role) client — RLS on this table has no write policy at
-- all, so only a role that bypasses RLS (service_role, postgres) can ever
-- reach the trigger; run the DELETE as service_role here to match.
do $s9$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000167';
  ctx jsonb := '{"ip":"203.0.113.9","user_agent":"smoke"}';
  p uuid := pg_temp.mk_patient('S9A');
  q uuid := pg_temp.mk_patient('S9B');
  att_p uuid;
  att_q uuid;
begin
  insert into public.appointment_attachments
    (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes)
  values (gen_random_uuid(), p, 'lab-request-forms/s9-active.pdf', 's9-active.pdf', 'application/pdf', 1024)
  returning id into att_p;

  insert into public.appointment_attachments
    (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes)
  values (gen_random_uuid(), q, 'lab-request-forms/s9-deleted.pdf', 's9-deleted.pdf', 'application/pdf', 1024)
  returning id into att_q;

  -- CONTROL: an active patient's attachment deletes normally.
  set local role service_role;
  perform pg_temp.expect('s9.1 CONTROL delete on active patient',
    pg_temp.state_of(format($q$delete from public.appointment_attachments where id = %L$q$, att_p)), 'ok');
  reset role;

  set local role service_role;
  perform public.delete_patient(q, 'test_record', '', k_admin, ctx);
  reset role;

  -- Deleted patient: the DELETE is refused with P0058, and the row survives.
  set local role service_role;
  perform pg_temp.expect('s9.2 delete on deleted patient is refused',
    pg_temp.state_of(format($q$delete from public.appointment_attachments where id = %L$q$, att_q)), 'P0058');
  reset role;
  perform pg_temp.expect('s9.3 row still present after the refused delete',
    (select count(*)::text from public.appointment_attachments where id = att_q), '1');

  -- Restore, then the delete succeeds again — same row, same guard, now off.
  set local role service_role;
  perform public.restore_patient(q, k_admin, ctx);
  reset role;
  set local role service_role;
  perform pg_temp.expect('s9.4 delete after restore succeeds',
    pg_temp.state_of(format($q$delete from public.appointment_attachments where id = %L$q$, att_q)), 'ok');
  reset role;

  -- A row with no patient_id has nothing to check against and is unaffected.
  insert into public.appointment_attachments
    (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes)
  values (gen_random_uuid(), null, 'lab-request-forms/s9-orphan.pdf', 's9-orphan.pdf', 'application/pdf', 1024)
  returning id into att_p;
  set local role service_role;
  perform pg_temp.expect('s9.5 CONTROL null patient_id is left alone',
    pg_temp.state_of(format($q$delete from public.appointment_attachments where id = %L$q$, att_p)), 'ok');
  reset role;

  -- SECURITY DEFINER so the guard can't fail open for a caller whose own RLS
  -- hides the patients row (see the migration's comment on this function).
  perform pg_temp.expect('s9.6 attachment delete guard is definer, pinned',
    (select format('%s|%s', prosecdef, proconfig) from pg_proc where proname = 'enforce_appointment_attachment_delete'),
    't|{"search_path=pg_catalog, public, pg_temp"}');
end
$s9$;

rollback;

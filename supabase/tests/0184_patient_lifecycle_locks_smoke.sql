-- =============================================================================
-- 0184_patient_lifecycle_locks_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after 0184 is applied:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/0184_patient_lifecycle_locks_smoke.sql
--
-- Runs inside BEGIN … ROLLBACK; leaves no rows behind. Single-connection only:
-- the two-connection races live in scripts/smoke-lifecycle-locks.ts. Sections:
--   s1  lock primitives + patient-path resolvers
--   s2  delete/restore take FOR NO KEY UPDATE
--   s3  guards: visits, appointments, patient_consents, appointment_attachments
--   s4  guards: test_requests, payments, visit_pins
--   s5  guards: results, result_test_requests, result_values, result_amendments, critical_alerts
--   s6  guards: HMO items/allocations/resolutions, doctor_pf_entries, mixed batch
--   s7  existing RPCs pre-acquire (result_*, correct_payment, appointments_insert_slot_guarded)
--   s8  resolve_patient_guarded
--   s9  create_visit_encounter
--   s10 result_create_linked
--   s11 record_hmo_settlement
--   s12 reschedule_closure_appointments
--   s13 current_patient_id JWT-only, set_patient_context gone, notification_skip_summary
--   s14 catalog sweep: owners, search_path, ACLs, trigger order
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
  ('a0000000-0000-4000-8000-000000000184', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'lk-admin@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000184', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'lk-reception@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000184', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'lk-medtech@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active)
values
  ('a0000000-0000-4000-8000-000000000184', 'LK Admin', 'admin', true),
  ('a1000000-0000-4000-8000-000000000184', 'LK Reception', 'reception', true),
  ('a2000000-0000-4000-8000-000000000184', 'LK Medtech', 'medtech', true);

insert into public.services (id, code, name, price_php, kind)
values
  ('c0000000-0000-4000-8000-000000000184', 'LK-LAB',     'LK smoke lab test',   1000, 'lab_test'),
  ('c1000000-0000-4000-8000-000000000184', 'LK-LAB2',    'LK smoke lab test 2',  400, 'lab_test'),
  ('c2000000-0000-4000-8000-000000000184', 'LK-PKG',     'LK smoke package',    1500, 'lab_package'),
  ('c3000000-0000-4000-8000-000000000184', 'LK-CONSULT', 'LK smoke consult',     500, 'doctor_consultation');

insert into public.hmo_providers (id, name)
values ('b0000000-0000-4000-8000-000000000184', 'LK Smoke HMO');

-- Helpers (pg_temp: vanish with the session).
create function pg_temp.mk_patient(tag text) returns uuid language sql as $f$
  insert into public.patients (drm_id, first_name, last_name, birthdate, email)
  values ('DRM-LK' || tag, 'Smoke', 'Lk' || tag, '1990-01-01', 'lk' || lower(tag) || '@example.test')
  returning id;
$f$;

create function pg_temp.mk_visit(p uuid, hmo boolean default false) returns uuid language sql as $f$
  insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php, hmo_provider_id)
  values ('V-LK-' || substr(md5(random()::text), 1, 10), p, 'unpaid', 0, 0,
          case when hmo then 'b0000000-0000-4000-8000-000000000184'::uuid end)
  returning id;
$f$;

create function pg_temp.mk_line(v uuid, status text default 'requested', final numeric default 0,
                                parent uuid default null, header boolean default false,
                                svc uuid default 'c0000000-0000-4000-8000-000000000184')
returns uuid language sql as $f$
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, parent_id, is_package_header)
  values (v, svc, status, 'a0000000-0000-4000-8000-000000000184', final, final, parent, header)
  returning id;
$f$;

create function pg_temp.mk_pay(v uuid, amount numeric, method text default 'cash') returns uuid language sql as $f$
  insert into public.payments (visit_id, amount_php, method, received_by)
  values (v, amount, method, 'a1000000-0000-4000-8000-000000000184')
  returning id;
$f$;

-- Deletes a patient WITHOUT the blocker check (fixtures need inactive
-- patients that still own children). Same mechanism 0167's smoke uses.
create function pg_temp.kill(p uuid) returns void language plpgsql as $f$
begin
  set local role patient_lifecycle_writer;
  update public.patients
     set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000184', delete_reason = 'test_record'
   where id = p;
  reset role;
end $f$;

create function pg_temp.revive(p uuid) returns void language plpgsql as $f$
begin
  set local role patient_lifecycle_writer;
  update public.patients set deleted_at = null, deleted_by = null, delete_reason = null, delete_note = null
   where id = p;
  reset role;
end $f$;

create function pg_temp.merge_into(src uuid, keep uuid) returns void language sql as $f$
  update public.patients set merged_into_id = keep, merged_at = now() where id = src;
$f$;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception '0184 % FAILED: got [%], want [%]', label, got, want;
  end if;
  raise notice '0184 % OK', label;
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

-- Number of advisory locks this backend holds in a given mode.
create function pg_temp.held(mode text) returns int language sql as $f$
  select count(*)::int from pg_locks
   where locktype = 'advisory' and pid = pg_backend_pid() and pg_locks.mode = held.mode
     and classid = (hashtext('patient_lifecycle'))::oid;
$f$;

-- Same, for the result-membership namespace.
create function pg_temp.held_results(mode text) returns int language sql as $f$
  select count(*)::int from pg_locks
   where locktype = 'advisory' and pid = pg_backend_pid() and pg_locks.mode = held_results.mode
     and classid = (hashtext('result_membership'))::oid;
$f$;

-- Does this backend hold the lifecycle lock on patient p in mode m?
create function pg_temp.holds(p uuid, m text) returns boolean language sql as $f$
  select exists (select 1 from pg_locks
   where locktype = 'advisory' and pid = pg_backend_pid() and mode = m
     and classid = (hashtext('patient_lifecycle'))::oid and objid = (hashtext(p::text))::oid);
$f$;

-- 0119 strips PUBLIC EXECUTE from every function postgres creates, temp ones
-- included; helpers called after `set local role …` need an explicit grant.
do $grant$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', f);
  end loop;
end
$grant$;

-- --- s1: lock primitives + resolvers ------------------------------------------
do $s1$
declare
  p  uuid := pg_temp.mk_patient('S1A');
  d  uuid := pg_temp.mk_patient('S1D');
  m  uuid := pg_temp.mk_patient('S1M');
  k  uuid := pg_temp.mk_patient('S1K');
  f0 uuid := pg_temp.mk_patient('S1F');   -- never written for: no lock held on it yet
  v  uuid;
  tr uuid;
  r  uuid;
  pay uuid;
  b  uuid;
  it uuid;
  q uuid; vq uuid; hq uuid; payq uuid; rq uuid; amq uuid; itq uuid; alq uuid; r2 uuid;
  pq uuid[];
  s0 int;
  x0 int;
begin
  v  := pg_temp.mk_visit(p, true);
  tr := pg_temp.mk_line(v, 'in_progress', 1000);
  pay := pg_temp.mk_pay(v, 100);
  insert into public.results (generation_kind, uploaded_by) values ('structured', 'a2000000-0000-4000-8000-000000000184')
    returning id into r;
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted')
    returning id into b;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (b, tr, 1000)
    returning id into it;
  perform pg_temp.kill(d);
  perform pg_temp.merge_into(m, k);

  -- lifecycle_norm: distinct + sorted, NULL kept once.
  perform pg_temp.expect('s1.1 norm dedups and sorts',
    public.lifecycle_norm(array[k, p, p, k])::text,
    (select array_agg(x order by x) from unnest(array[k, p]) x)::text);
  perform pg_temp.expect('s1.2 norm keeps one NULL',
    array_length(public.lifecycle_norm(array[p, null, null]::uuid[]), 1)::text, '2');

  -- Locks: shared and exclusive, counted in pg_locks.
  s0 := pg_temp.held('ShareLock');
  -- f0 (and k below) own no rows, so no guard has locked them earlier in this
  -- transaction (once Tasks 4-7 install the guards, p already is).
  perform public.lifecycle_lock_and_assert(array[f0, f0], false);
  perform pg_temp.expect('s1.3 shared lock taken once per distinct patient',
    (pg_temp.held('ShareLock') - s0)::text, '1');
  x0 := pg_temp.held('ExclusiveLock');
  perform public.lifecycle_lock_and_assert(array[k], true);
  perform pg_temp.expect('s1.4 exclusive lock taken',
    (pg_temp.held('ExclusiveLock') - x0)::text, '1');

  -- Assertion: inactive / missing / NULL refuse; empty and NULL array are no-ops.
  perform pg_temp.expect('s1.5 CONTROL active patient passes',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L]::uuid[], false)$q$, p)), 'ok');
  perform pg_temp.expect('s1.6 deleted patient refused',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L]::uuid[], false)$q$, d)), 'P0058');
  perform pg_temp.expect('s1.7 merged patient refused',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L]::uuid[], false)$q$, m)), 'P0058');
  perform pg_temp.expect('s1.8 missing patient refused',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L]::uuid[], false)$q$, gen_random_uuid())), 'P0058');
  perform pg_temp.expect('s1.9 NULL element refused (unresolved parent)',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L, null]::uuid[], false)$q$, p)), 'P0058');
  perform pg_temp.expect('s1.10 empty array is a no-op',
    pg_temp.state_of($q$select public.lifecycle_lock_and_assert('{}'::uuid[], false)$q$), 'ok');
  perform pg_temp.expect('s1.11 NULL array is a no-op',
    pg_temp.state_of($q$select public.lifecycle_lock_and_assert(null::uuid[], false)$q$), 'ok');
  perform pg_temp.expect('s1.12 lock-only primitive does not assert',
    pg_temp.state_of(format($q$select public.lifecycle_lock(array[%L]::uuid[], false)$q$, d)), 'ok');
  begin
    perform public.lifecycle_lock_and_assert(array[d], false);
  exception when sqlstate 'P0058' then
    perform pg_temp.expect('s1.13 message names the DRM-ID', (sqlerrm like '%DRM-LKS1D%')::text, 'true');
  end;

  -- Resolvers.
  perform pg_temp.expect('s1.14 visit → patient',
    public.lifecycle_patients_of_visits(array[v])::text, array[p]::text);
  perform pg_temp.expect('s1.15 missing visit → NULL (fail closed)',
    public.lifecycle_patients_of_visits(array[gen_random_uuid()])::text, '{NULL}');
  perform pg_temp.expect('s1.16 test request → patient',
    public.lifecycle_patients_of_test_requests(array[tr])::text, array[p]::text);
  perform pg_temp.expect('s1.17 unlinked result → empty',
    public.lifecycle_patients_of_result(r)::text, '{}');
  insert into public.result_test_requests (result_id, test_request_id) values (r, tr);
  perform pg_temp.expect('s1.18 linked result → patient',
    public.lifecycle_patients_of_result(r)::text, array[p]::text);
  perform pg_temp.expect('s1.19 claim item → patient',
    public.lifecycle_patients_of_hmo_items(array[it])::text, array[p]::text);
  perform pg_temp.expect('s1.20 payment → patient',
    public.lifecycle_patients_of_payments(array[pay])::text, array[p]::text);
  perform pg_temp.expect('s1.21 row resolver: test_requests',
    public.lifecycle_patients_of_row('test_requests', jsonb_build_object('visit_id', v), false)::text, array[p]::text);
  perform pg_temp.expect('s1.22 row resolver: walk-in appointment → empty',
    public.lifecycle_patients_of_row('appointments', jsonb_build_object('patient_id', null), false)::text, '{}');
  perform pg_temp.expect('s1.23 row resolver: allocation = item ∪ payment',
    public.lifecycle_norm(public.lifecycle_patients_of_row('hmo_payment_allocations',
      jsonb_build_object('item_id', it, 'payment_id', pay), false))::text, array[p]::text);
  perform pg_temp.expect('s1.24 row resolver: delete drops a vanished parent',
    public.lifecycle_patients_of_row('visit_pins', jsonb_build_object('visit_id', gen_random_uuid()), true)::text, '{}');
  perform pg_temp.expect('s1.25 row resolver: unknown table fails closed',
    pg_temp.state_of($q$select public.lifecycle_patients_of_row('staff_profiles', '{}'::jsonb, false)$q$), 'P0058');

  -- Every patient-bearing reference is followed (Codex plan review P1-1).
  -- q is a second active patient; each row below names p on one path and q on another.
  q  := pg_temp.mk_patient('S1Q');
  vq := pg_temp.mk_visit(q, true);
  hq := pg_temp.mk_line(vq, 'in_progress', 0, null, true, 'c2000000-0000-4000-8000-000000000184');
  payq := pg_temp.mk_pay(vq, 10, 'hmo');
  insert into public.results (generation_kind, uploaded_by) values ('structured', 'a2000000-0000-4000-8000-000000000184')
    returning id into rq;
  insert into public.result_test_requests (result_id, test_request_id) values (rq, pg_temp.mk_line(vq, 'in_progress', 10));
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (rq, (select test_request_id from public.result_test_requests where result_id = rq), 'x', 'a2000000-0000-4000-8000-000000000184',
            now(), 'smoke', 'a2000000-0000-4000-8000-000000000184', 1)
    returning id into amq;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
    values (b, pg_temp.mk_line(vq, 'released', 10), 10) returning id into itq;
  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (payq, itq, 10)
    returning id into alq;
  pq := array[p, q];
  pq := (select array_agg(x order by x) from unnest(pq) x);
  perform pg_temp.expect('s1.26 test_requests: visit ∪ parent header',
    public.lifecycle_norm(public.lifecycle_patients_of_row('test_requests',
      jsonb_build_object('visit_id', v, 'parent_id', hq), false))::text, pq::text);
  perform pg_temp.expect('s1.27 payments: visit ∪ corrected payment',
    public.lifecycle_norm(public.lifecycle_patients_of_row('payments',
      jsonb_build_object('visit_id', v, 'corrects_payment_id', payq), false))::text, pq::text);
  perform pg_temp.expect('s1.28 result_test_requests: test ∪ the result''s membership',
    public.lifecycle_norm(public.lifecycle_patients_of_row('result_test_requests',
      jsonb_build_object('test_request_id', tr, 'result_id', rq), false))::text, pq::text);
  perform pg_temp.expect('s1.29 result_amendments: result ∪ test',
    public.lifecycle_norm(public.lifecycle_patients_of_row('result_amendments',
      jsonb_build_object('result_id', rq, 'test_request_id', tr), false))::text, pq::text);
  perform pg_temp.expect('s1.30 critical_alerts: result ∪ test ∪ patient_id ∪ withdrawn_by_amendment',
    public.lifecycle_norm(public.lifecycle_patients_of_row('critical_alerts',
      jsonb_build_object('result_id', r, 'test_request_id', tr, 'patient_id', p, 'withdrawn_by_amendment', amq), false))::text, pq::text);
  perform pg_temp.expect('s1.31 doctor_pf_entries: test ∪ HMO allocation',
    public.lifecycle_norm(public.lifecycle_patients_of_row('doctor_pf_entries',
      jsonb_build_object('test_request_id', tr, 'hmo_allocation_id', alq), false))::text, pq::text);
  perform pg_temp.expect('s1.32 an optional reference that is NULL adds nothing',
    public.lifecycle_norm(public.lifecycle_patients_of_row('test_requests',
      jsonb_build_object('visit_id', v, 'parent_id', null), false))::text, array[p]::text);
  perform pg_temp.expect('s1.33 an optional reference to a MISSING row fails closed (NULL element)',
    (array_position(public.lifecycle_patients_of_row('payments',
      jsonb_build_object('visit_id', v, 'corrects_payment_id', gen_random_uuid()), false), null) is not null)::text, 'true');
  perform pg_temp.expect('s1.34 result resolver can leave one test out (junction UPDATE)',
    public.lifecycle_patients_of_result(r, tr)::text, '{}');

  -- Result-membership lock (Codex plan review P1-2).
  perform pg_temp.expect('s1.35 result ids of a row: critical alert = result ∪ withdrawing amendment''s result',
    public.lifecycle_norm(public.lifecycle_result_ids_of_row('critical_alerts',
      jsonb_build_object('result_id', r, 'withdrawn_by_amendment', amq)))::text,
    (select array_agg(x order by x) from unnest(array[r, rq]) x)::text);
  perform pg_temp.expect('s1.36 result ids of a non-results row → empty',
    public.lifecycle_result_ids_of_row('visits', jsonb_build_object('id', v))::text, '{}');
  -- Fresh ids: once Task 6 installs the junction guard, r and rq already hold
  -- membership locks from their links, and a re-entrant acquisition adds no
  -- pg_locks row (Codex recheck P2-4).
  s0 := pg_temp.held_results('ShareLock');
  r2 := gen_random_uuid();
  perform public.lifecycle_lock_results(array[r2, r2, null], false);
  perform pg_temp.expect('s1.37 shared membership lock, once per distinct result, NULLs ignored',
    (pg_temp.held_results('ShareLock') - s0)::text, '1');
  x0 := pg_temp.held_results('ExclusiveLock');
  perform public.lifecycle_lock_results(array[gen_random_uuid()], true);
  perform pg_temp.expect('s1.38 exclusive membership lock',
    (pg_temp.held_results('ExclusiveLock') - x0)::text, '1');

  -- ACLs: no runtime role may call the primitives.
  perform pg_temp.expect('s1.39 no runtime EXECUTE on primitives',
    (select bool_or(has_function_privilege(role_name, f, 'execute'))::text
       from unnest(array['anon','authenticated','service_role']) role_name,
            unnest(array[
              'public.lifecycle_lock(uuid[],boolean)',
              'public.lifecycle_lock_and_assert(uuid[],boolean)',
              'public.lifecycle_lock_results(uuid[],boolean)',
              'public.lifecycle_norm(uuid[])',
              'public.lifecycle_patients_of_visits(uuid[])',
              'public.lifecycle_patients_of_test_requests(uuid[])',
              'public.lifecycle_patients_of_result(uuid,uuid)',
              'public.lifecycle_patients_of_hmo_items(uuid[])',
              'public.lifecycle_patients_of_payments(uuid[])',
              'public.lifecycle_patients_of_amendments(uuid[])',
              'public.lifecycle_patients_of_allocations(uuid[])',
              'public.lifecycle_via(text,text)',
              'public.lifecycle_result_ids_of_row(text,jsonb)',
              'public.lifecycle_patients_of_row(text,jsonb,boolean)']) f),
    'false');
end
$s1$;

-- --- s2: delete/restore row-lock strength --------------------------------------
do $s2$
declare
  p uuid := pg_temp.mk_patient('S2A');
begin
  perform pg_temp.expect('s2.1 delete_patient uses FOR NO KEY UPDATE',
    (pg_get_functiondef('public.delete_patient(uuid,text,text,uuid,jsonb)'::regprocedure) ~* 'for\s+no\s+key\s+update')::text, 'true');
  perform pg_temp.expect('s2.2 restore_patient uses FOR NO KEY UPDATE',
    (pg_get_functiondef('public.restore_patient(uuid,uuid,jsonb)'::regprocedure) ~* 'for\s+no\s+key\s+update')::text, 'true');
  perform pg_temp.expect('s2.3 owners unchanged',
    (select string_agg(r.rolname, ',' order by p2.proname) from pg_proc p2 join pg_roles r on r.oid = p2.proowner
      where p2.proname in ('delete_patient', 'restore_patient')),
    'patient_lifecycle_writer,patient_lifecycle_writer');
  perform pg_temp.expect('s2.4 EXECUTE still service_role only',
    (has_function_privilege('service_role', 'public.delete_patient(uuid,text,text,uuid,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.delete_patient(uuid,text,text,uuid,jsonb)', 'execute')
     and has_function_privilege('service_role', 'public.restore_patient(uuid,uuid,jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.restore_patient(uuid,uuid,jsonb)', 'execute'))::text, 'true');
  -- Round trip still works.
  perform public.delete_patient(p, 'test_record', '', 'a0000000-0000-4000-8000-000000000184', '{}'::jsonb);
  perform pg_temp.expect('s2.5 delete works', (select (deleted_at is not null)::text from public.patients where id = p), 'true');
  perform public.restore_patient(p, 'a0000000-0000-4000-8000-000000000184', '{}'::jsonb);
  perform pg_temp.expect('s2.6 restore works', (select (deleted_at is null)::text from public.patients where id = p), 'true');
end
$s2$;

-- --- s3: guards on the direct-patient tables -----------------------------------
do $s3$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S3A');
  b  uuid := pg_temp.mk_patient('S3B');
  d  uuid := pg_temp.mk_patient('S3D');
  m  uuid := pg_temp.mk_patient('S3M');
  vd uuid;
  va uuid;
  ap1 uuid; ap2 uuid; ap3 uuid; ap4 uuid; apw uuid;
  att_d uuid;
  x0 int;
begin
  -- Children created while the patients are active, then the patients go inactive.
  vd := pg_temp.mk_visit(d);
  va := pg_temp.mk_visit(a);
  insert into public.appointments (patient_id, status, scheduled_at) values
    (d, 'confirmed', now() + interval '1 day') returning id into ap1;
  insert into public.appointments (patient_id, status, scheduled_at) values
    (d, 'confirmed', now() + interval '1 day') returning id into ap2;
  insert into public.appointments (patient_id, status, scheduled_at) values
    (d, 'confirmed', now() + interval '2 days') returning id into ap3;
  insert into public.appointments (patient_id, status, scheduled_at) values
    (d, 'pending_callback', null) returning id into ap4;
  insert into public.appointments (patient_id, walk_in_name, walk_in_phone, status, scheduled_at) values
    (null, 'Walk In', '09170000000', 'confirmed', now() + interval '1 day') returning id into apw;
  insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes)
    values (gen_random_uuid(), d, 'lab-request-forms/s3.pdf', 's3.pdf', 'application/pdf', 10) returning id into att_d;
  perform pg_temp.kill(d);
  perform pg_temp.merge_into(m, a);

  -- visits
  perform pg_temp.expect('s3.1 CONTROL new visit on an active patient',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, b)), 'ok');
  perform pg_temp.expect('s3.2 FIRST visit on a deleted patient is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, d)), 'P0058');
  perform pg_temp.expect('s3.3 visit on a merged patient is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, m)), 'P0058');
  perform pg_temp.expect('s3.4 editing a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$update public.visits set notes = 'x' where id = %L$q$, vd)), 'P0058');
  perform pg_temp.expect('s3.5 a no-op update is allowed',
    pg_temp.state_of(format($q$update public.visits set notes = notes where id = %L$q$, vd)), 'ok');
  perform pg_temp.expect('s3.6 soft-deleting a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$update public.visits set deleted_at = now(), deleted_by = %L, delete_reason = 'x' where id = %L$q$, k_admin, vd)), 'P0058');
  x0 := pg_temp.held('ExclusiveLock');
  perform pg_temp.expect('s3.7 CONTROL moving a visit between two active patients',
    pg_temp.state_of(format($q$update public.visits set patient_id = %L where id = %L$q$, b, va)), 'ok');
  perform pg_temp.expect('s3.8 …takes EXCLUSIVE on old and new',
    (pg_temp.held('ExclusiveLock') - x0 >= 2)::text, 'true');
  perform pg_temp.expect('s3.9 moving a visit onto a deleted patient is refused',
    pg_temp.state_of(format($q$update public.visits set patient_id = %L where id = %L$q$, d, va)), 'P0058');
  set local role service_role;
  perform pg_temp.expect('s3.10 service_role gets no bypass',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, d)), 'P0058');
  reset role;

  -- appointments
  perform pg_temp.expect('s3.11 CONTROL booking an active patient',
    pg_temp.state_of(format($q$insert into public.appointments (patient_id, status, scheduled_at) values (%L, 'confirmed', now() + interval '3 days')$q$, b)), 'ok');
  perform pg_temp.expect('s3.12 booking a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.appointments (patient_id, status, scheduled_at) values (%L, 'confirmed', now() + interval '3 days')$q$, d)), 'P0058');
  perform pg_temp.expect('s3.13 CONTROL a walk-in is never guarded',
    pg_temp.state_of($q$insert into public.appointments (walk_in_name, walk_in_phone, status, scheduled_at) values ('W', '09170000001', 'confirmed', now() + interval '3 days')$q$), 'ok');
  -- (That cancel takes NO lock cannot be shown here — this transaction already
  -- locked d while creating its fixtures; smoke:locks proves it doesn't wait.)
  perform pg_temp.expect('s3.14 cancelling a deleted patient''s appointment is allowed',
    pg_temp.state_of(format($q$update public.appointments set status = 'cancelled' where id = %L$q$, ap1)), 'ok');
  perform pg_temp.expect('s3.16 marking no-show is allowed',
    pg_temp.state_of(format($q$update public.appointments set status = 'no_show' where id = %L$q$, ap2)), 'ok');
  perform pg_temp.expect('s3.17 marking arrived is refused',
    pg_temp.state_of(format($q$update public.appointments set status = 'arrived' where id = %L$q$, ap3)), 'P0058');
  perform pg_temp.expect('s3.18 cancel + another column is refused (exception is column-shaped)',
    pg_temp.state_of(format($q$update public.appointments set status = 'cancelled', notes = 'x' where id = %L$q$, ap3)), 'P0058');
  perform pg_temp.expect('s3.19 rescheduling is refused',
    pg_temp.state_of(format($q$update public.appointments set scheduled_at = now() + interval '5 days' where id = %L$q$, ap3)), 'P0058');
  perform pg_temp.expect('s3.20 attaching a walk-in to a deleted patient is refused',
    pg_temp.state_of(format($q$update public.appointments set patient_id = %L, walk_in_name = null where id = %L$q$, d, apw)), 'P0058');
  perform pg_temp.expect('s3.21 deleting a deleted patient''s appointment row is allowed',
    pg_temp.state_of(format($q$delete from public.appointments where id = %L$q$, ap4)), 'ok');

  -- patient_consents (0167's patients guard only covered DELETED; merged was open)
  perform pg_temp.expect('s3.22 CONTROL consent event for an active patient',
    pg_temp.state_of(format($q$insert into public.patient_consents (patient_id, event_type, reason, actor_kind, created_by) values (%L, 'withdrawn', 'smoke', 'staff', %L)$q$, b, k_admin)), 'ok');
  perform pg_temp.expect('s3.23 consent event for a MERGED patient is refused',
    pg_temp.state_of(format($q$insert into public.patient_consents (patient_id, event_type, reason, actor_kind, created_by) values (%L, 'withdrawn', 'smoke', 'staff', %L)$q$, m, k_admin)), 'P0058');

  -- appointment_attachments (0167's delete-only guard folded in)
  perform pg_temp.expect('s3.24 CONTROL upload row for an active patient',
    pg_temp.state_of(format($q$insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes) values (gen_random_uuid(), %L, 'lab-request-forms/b.pdf', 'b.pdf', 'application/pdf', 10)$q$, b)), 'ok');
  perform pg_temp.expect('s3.25 upload row for a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes) values (gen_random_uuid(), %L, 'lab-request-forms/d.pdf', 'd.pdf', 'application/pdf', 10)$q$, d)), 'P0058');
  perform pg_temp.expect('s3.26 removing a deleted patient''s upload is refused',
    pg_temp.state_of(format($q$delete from public.appointment_attachments where id = %L$q$, att_d)), 'P0058');
  perform pg_temp.expect('s3.27 0167''s delete-only guard is gone (folded in)',
    (select count(*)::text from pg_trigger where tgname = 'trg_appointment_attachments_delete_guard'), '0');

  -- The guard fires FIRST among BEFORE row triggers on every guarded table so far.
  perform pg_temp.expect('s3.28 a_lifecycle_guard fires first',
    (select string_agg(first_trigger, ',' order by rel) from (
       select c.relname as rel,
              (select t.tgname from pg_trigger t
                where t.tgrelid = c.oid and not t.tgisinternal and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
                order by t.tgname collate "C" limit 1) as first_trigger
         from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relname in ('visits', 'appointments', 'patient_consents', 'appointment_attachments')) s),
    'a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard');
end
$s3$;

rollback;

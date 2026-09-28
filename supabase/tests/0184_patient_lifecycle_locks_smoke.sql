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

-- Runs sql (expected to raise); returns the PG_EXCEPTION_CONTEXT call stack
-- text, so a caller can tell WHICH function's raise actually fired — an RPC's
-- own pre-lock (section 4) vs. the downstream a_lifecycle_guard trigger
-- (section 3), which would raise the SAME P0058 if section 4's lock were
-- removed entirely (0184 review M2: a behavioural assertion alone is vacuous
-- here). Returns 'NO_EXCEPTION_RAISED' if the statement did not raise.
create function pg_temp.context_of(sql text) returns text language plpgsql as $f$
declare c text;
begin
  execute sql;
  return 'NO_EXCEPTION_RAISED';
exception when others then
  get stacked diagnostics c = pg_exception_context;
  return c;
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
  v_raised boolean := false;
  -- Review fix #1 (per-path union assertions): a 4th distinct active patient
  -- so critical_alerts' four paths (result/test/patient_id/amendment) each
  -- contribute a DIFFERENT patient — removing any one must shrink the set.
  n   uuid := pg_temp.mk_patient('S1N');
  vn  uuid;
  trn uuid;
  rn  uuid;
  amn uuid;
  amx uuid;   -- cross-patient amendment: result on p, test on q
  alx uuid;   -- cross-patient allocation: item on p, payment on q
  pqk uuid[]; -- {p,q,k,n} sorted
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
  -- NOT proof of our own dedup/sort: Postgres itself collapses a repeated
  -- acquisition of the SAME advisory lock key into one pg_locks row, so this
  -- would read '1' even if lifecycle_lock's dedup loop were removed and it
  -- called pg_advisory_xact_lock_shared twice for f0. What this DOES prove:
  -- a duplicate-patient array is accepted without error and without double
  -- counting. Sort order and real dedup under contention are proven by
  -- scripts/smoke-lifecycle-locks.ts's two-connection races (review fix #2).
  perform pg_temp.expect('s1.3 a duplicate-patient array locks without error, one held ShareLock (not proof of dedup — see the race script)',
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
    v_raised := true;
    perform pg_temp.expect('s1.13 message names the DRM-ID', (sqlerrm like '%DRM-LKS1D%')::text, 'true');
  end;
  -- The above block silently "passes" (no OK, no FAILED) if P0058 is never
  -- raised at all — expect() only runs INSIDE the handler. Assert separately
  -- that the exception actually fired (review fix #7).
  perform pg_temp.expect('s1.13b the P0058 exception was actually raised', v_raised::text, 'true');

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
  -- Same caveat as s1.3 (review fix #2): a repeated/NULL-padded array locking
  -- to exactly one held ShareLock does not by itself prove OUR loop dedups
  -- or sorts — Postgres collapses the repeat regardless. What this DOES
  -- prove: a duplicate + NULL result-id array is accepted without error.
  perform pg_temp.expect('s1.37 a duplicate+NULL result-id array locks without error, one held ShareLock (not proof of dedup — see the race script)',
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
              'public.lifecycle_via(text,text,boolean)',
              'public.lifecycle_result_ids_of_row(text,jsonb)',
              'public.lifecycle_patients_of_row(text,jsonb,boolean)']) f),
    'false');

  -- Review fix #1: per-path UNION assertions. s1.23/s1.30 as originally
  -- written used same-patient references on every path of a multi-reference
  -- branch, so dropping any ONE of them left the (already-satisfied) expected
  -- set unchanged — the mutation passed silently. Below, EVERY path of each
  -- multi-reference branch names a DIFFERENT patient, so dropping any one
  -- path shrinks the set and the assertion catches it.
  vn  := pg_temp.mk_visit(n, true);
  trn := pg_temp.mk_line(vn, 'in_progress', 10);
  insert into public.results (generation_kind, uploaded_by) values ('structured', 'a2000000-0000-4000-8000-000000000184')
    returning id into rn;
  insert into public.result_test_requests (result_id, test_request_id) values (rn, trn);
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (rn, trn, 'x', 'a2000000-0000-4000-8000-000000000184', now(), 'smoke', 'a2000000-0000-4000-8000-000000000184', 1)
    returning id into amn;
  pqk := (select array_agg(x order by x) from unnest(array[p, q, k, n]) x);
  perform pg_temp.expect('s1.40 critical_alerts: result / test / patient_id / withdrawn_by_amendment each contribute a DISTINCT patient (p,q,k,n) — dropping any one path shrinks the set',
    public.lifecycle_norm(public.lifecycle_patients_of_row('critical_alerts',
      jsonb_build_object('result_id', r, 'test_request_id', hq, 'patient_id', k, 'withdrawn_by_amendment', amn), false))::text,
    pqk::text);

  perform pg_temp.expect('s1.41 row resolver: hmo_payment_allocations item ∪ payment, cross-patient (item→p, payment→q)',
    public.lifecycle_norm(public.lifecycle_patients_of_row('hmo_payment_allocations',
      jsonb_build_object('item_id', it, 'payment_id', payq), false))::text, pq::text);

  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (r, hq, 'x', 'a2000000-0000-4000-8000-000000000184', now(), 'smoke', 'a2000000-0000-4000-8000-000000000184', 1)
    returning id into amx;
  perform pg_temp.expect('s1.42 lifecycle_patients_of_amendments: result ∪ test, cross-patient (result→p, test→q) — the function itself, not just the row-resolver wrapper',
    public.lifecycle_norm(public.lifecycle_patients_of_amendments(array[amx]))::text, pq::text);

  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (payq, it, 10)
    returning id into alx;
  perform pg_temp.expect('s1.43 lifecycle_patients_of_allocations: item ∪ payment, cross-patient (item→p, payment→q) — the function itself',
    public.lifecycle_norm(public.lifecycle_patients_of_allocations(array[alx]))::text, pq::text);

  -- Review fix #1: branches with no assertion at all (result_values,
  -- hmo_claim_resolutions, visit_pins non-delete, patient_consents).
  perform pg_temp.expect('s1.44 row resolver: result_values',
    public.lifecycle_patients_of_row('result_values', jsonb_build_object('result_id', r), false)::text, array[p]::text);
  perform pg_temp.expect('s1.45 row resolver: hmo_claim_resolutions',
    public.lifecycle_patients_of_row('hmo_claim_resolutions', jsonb_build_object('item_id', it), false)::text, array[p]::text);
  perform pg_temp.expect('s1.46 row resolver: visit_pins, insert-shaped (not for-delete)',
    public.lifecycle_patients_of_row('visit_pins', jsonb_build_object('visit_id', v), false)::text, array[p]::text);
  perform pg_temp.expect('s1.47 row resolver: patient_consents CONTROL',
    public.lifecycle_patients_of_row('patient_consents', jsonb_build_object('patient_id', p), false)::text, array[p]::text);
  perform pg_temp.expect('s1.48 row resolver: patient_consents NULL patient_id fails closed (NOT NULL column, malformed row)',
    (array_position(public.lifecycle_patients_of_row('patient_consents', jsonb_build_object('patient_id', null), false), null) is not null)::text, 'true');

  -- Review fix #4: lifecycle_via has no ELSE — an unrecognised kind must fail
  -- closed (P0058), never silently return NULL and drop the path.
  perform pg_temp.expect('s1.49 lifecycle_via: an unrecognised kind fails closed',
    pg_temp.state_of($q$select public.lifecycle_via('bogus_kind', gen_random_uuid()::text)$q$), 'P0058');
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
  d2 uuid := pg_temp.mk_patient('S3D2');  -- killed with NO prior visit (review fix #8)
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
  perform pg_temp.kill(d2);
  perform pg_temp.merge_into(m, a);

  -- visits
  perform pg_temp.expect('s3.1 CONTROL new visit on an active patient',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, b)), 'ok');
  -- Review fix #8: the original s3.2 used patient `d`, who already had visit
  -- `vd` created above. Inserting a SECOND visit under `d` fires 0167's
  -- maintain_repeat_patient_flag (AFTER INSERT on visits: v_count > 1 →
  -- UPDATE patients SET is_repeat_patient), and THAT UPDATE is refused by
  -- 0167's own trg_patients_lifecycle_guard on a deleted patient. That is not
  -- a question of which trigger runs FIRST — a_lifecycle_guard is BEFORE
  -- INSERT ROW and genuinely does run (and would raise) before the AFTER
  -- INSERT repeat-flag path ever gets a chance to. The actual flaw is that
  -- the ASSERTION cannot tell WHICH guard refused: with a_lifecycle_guard
  -- disabled, patient `d`'s second-visit attempt is STILL refused (P0058) by
  -- the unrelated repeat-flag mechanism, so "insert raises P0058" is true
  -- whether or not a_lifecycle_guard exists, and the differential proof below
  -- (disable, retry, re-enable) cannot distinguish the two — it would show
  -- the insert still failing even with a_lifecycle_guard off, wrongly
  -- appearing to confirm the guard when it confirms nothing about it. d2 has
  -- NO prior visit: v_count = 1 after the insert, the repeat-flag UPDATE
  -- never fires, so a_lifecycle_guard is the ONLY thing that can refuse it,
  -- and the differential proof (s3.2b/s3.2c below) is meaningful.
  perform pg_temp.expect('s3.2 a patient''s FIRST-EVER visit is refused when deleted (no prior visit — only a_lifecycle_guard can be blocking it)',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, d2)), 'P0058');
  -- Differential proof: disable a_lifecycle_guard inside a sub-transaction
  -- that ALWAYS rolls back (the sentinel-errcode raise below undoes both the
  -- ALTER TABLE and the INSERT — the trigger is never left disabled) and
  -- confirm the identical insert now succeeds, which can only be true if
  -- a_lifecycle_guard was the sole blocker above.
  declare
    v_disabled_insert_ok boolean := false;
  begin
    begin
      -- The shared local DB has other live sessions; ALTER TABLE ... DISABLE
      -- TRIGGER takes SHARE ROW EXCLUSIVE on visits and would otherwise queue
      -- behind another session's write indefinitely. lock_timeout is SET
      -- LOCAL, so it is scoped to this nested block (an implicit savepoint)
      -- and is undone along with the ALTER TABLE and the INSERT the moment
      -- either exception handler below rolls back to that savepoint — no
      -- explicit reset needed, and no later section is affected.
      set local lock_timeout = '5s';
      alter table public.visits disable trigger a_lifecycle_guard;
      perform pg_temp.mk_visit(d2);
      v_disabled_insert_ok := true;
      raise exception using errcode = 'XXTMP';
    exception when others then
      if sqlstate is distinct from 'XXTMP' then
        v_disabled_insert_ok := false;
      end if;
    end;
    perform pg_temp.expect('s3.2b with a_lifecycle_guard disabled (rolled back after — never left disabled), the SAME first visit succeeds',
      v_disabled_insert_ok::text, 'true');
  end;
  perform pg_temp.expect('s3.2c a_lifecycle_guard is enabled again afterward and refuses the same insert',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, d2)), 'P0058');
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
  -- d2 (no prior visit, per review fix #8/s3.2 above), not d: d already has
  -- vd, so a second insert for d would be confounded by 0167's own
  -- repeat-flag guard the same way the original s3.2 was — this must be
  -- refusable ONLY by a_lifecycle_guard to prove service_role gets no bypass.
  set local role service_role;
  perform pg_temp.expect('s3.10 service_role gets no bypass',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, d2)), 'P0058');
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

  -- Review fix #3 (controller decision): a HARD delete of a patient row is
  -- legitimate (sheet-sync undo hard-deletes patients it created; smoke
  -- fixtures do the same) and cascades into two guarded tables — consents
  -- (ON DELETE CASCADE, seen as a DELETE) and attachments (ON DELETE SET
  -- NULL, seen as an UPDATE). The vanished OLD.patient_id must be DROPPED,
  -- not fail closed, on both.
  declare
    hv     uuid := pg_temp.mk_patient('S3HV');
    hv_att uuid;
  begin
    insert into public.patient_consents (patient_id, event_type, reason, actor_kind, created_by)
      values (hv, 'withdrawn', 'smoke', 'staff', k_admin);
    insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes)
      values (gen_random_uuid(), hv, 'lab-request-forms/hv.pdf', 'hv.pdf', 'application/pdf', 10) returning id into hv_att;
    perform pg_temp.expect('s3.29 hard-deleting a patient succeeds: the cascade into consents (DELETE) and attachments (UPDATE...SET NULL) is not refused',
      pg_temp.state_of(format($q$delete from public.patients where id = %L$q$, hv)), 'ok');
    perform pg_temp.expect('s3.30 …the consent row is gone (ON DELETE CASCADE ran)',
      (select count(*)::text from public.patient_consents where patient_id = hv), '0');
    perform pg_temp.expect('s3.31 …the attachment''s patient_id is now NULL (ON DELETE SET NULL ran)',
      (select (patient_id is null)::text from public.appointment_attachments where id = hv_att), 'true');
  end;

  -- Negative control: a patient that is only SOFT-deleted still exists as a
  -- row, so the vanished-patient carve-out (s3.29-31, a hard delete) must NOT
  -- swallow the ordinary guard — an UPDATE (not delete) of `d`'s existing
  -- attachment is still refused exactly as before. Note this does NOT by
  -- itself prove the OLD-side carve-out survives an UPDATE: the row's NEW
  -- side still names `d` too (only `filename` changes), so the refusal here
  -- is consistent with either the OLD or the NEW side alone being enough —
  -- s3.33-35 below isolate the OLD side specifically.
  perform pg_temp.expect('s3.32 updating (not deleting) a soft-deleted patient''s upload is still refused when the row still names that patient on both old and new',
    pg_temp.state_of(format($q$update public.appointment_attachments set filename = 'renamed.pdf' where id = %L$q$, att_d)), 'P0058');

  -- Real OLD-side negatives: the NEW side resolves to an ACTIVE patient (or
  -- no patient at all), so if a_lifecycle_guard only asserted the NEW side,
  -- each of these would be allowed. It must still refuse because the OLD
  -- side names the inactive patient `d` — moving work or evidence off a
  -- deleted/merged patient is itself an action on that patient's record.
  perform pg_temp.expect('s3.33 moving vd (d''s visit) onto ACTIVE patient b is still refused (OLD side names deleted d)',
    pg_temp.state_of(format($q$update public.visits set patient_id = %L where id = %L$q$, b, vd)), 'P0058');
  perform pg_temp.expect('s3.34 moving ap3 (d''s appointment) onto ACTIVE patient b is still refused (OLD side names deleted d)',
    pg_temp.state_of(format($q$update public.appointments set patient_id = %L where id = %L$q$, b, ap3)), 'P0058');
  perform pg_temp.expect('s3.35 clearing att_d.patient_id to NULL is still refused (OLD side names deleted d, NEW side has no patient at all)',
    pg_temp.state_of(format($q$update public.appointment_attachments set patient_id = null where id = %L$q$, att_d)), 'P0058');
end
$s3$;

-- --- s4: guards on the visit-path tables ----------------------------------------
do $s4$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S4A');
  d  uuid := pg_temp.mk_patient('S4D');
  va uuid; vd uuid; vd2 uuid; vp uuid;
  la uuid; ld uuid; ld_rel uuid;
  ha uuid; hd uuid;
  pa uuid; pd uuid;
  pin_d uuid;
begin
  va := pg_temp.mk_visit(a);
  vd := pg_temp.mk_visit(d);
  vd2 := pg_temp.mk_visit(d);
  -- vp is a THIRD visit for d, dedicated to the payments tests below (rule-#4
  -- audit finding): recalc_visit_payment sets payment_status = 'paid'
  -- whenever total_php = 0 (mk_visit's default), so recording ANY payment on
  -- a visit flips it. If `pd` were recorded on `vd`, s4.5's soft-delete of
  -- `ld` (also on vd) would then be refused by enforce_deletable_test_request
  -- (P0042, "visit is not unpaid") regardless of a_lifecycle_guard — vacuous
  -- per the audit. Keeping the payment on its own visit `vp` leaves `vd`
  -- 'unpaid' throughout, so a_lifecycle_guard is the only thing that can
  -- refuse s4.2-s4.7b.
  vp := pg_temp.mk_visit(d);
  la := pg_temp.mk_line(va, 'requested', 100);
  ld := pg_temp.mk_line(vd, 'requested', 100);
  ld_rel := pg_temp.mk_line(vd2, 'released', 0);
  ha := pg_temp.mk_line(va, 'in_progress', 0, null, true, 'c2000000-0000-4000-8000-000000000184');
  hd := pg_temp.mk_line(vd, 'in_progress', 0, null, true, 'c2000000-0000-4000-8000-000000000184');
  pd := pg_temp.mk_pay(vp, 50);
  insert into public.visit_pins (visit_id, pin_hash) values (vd, '$2a$12$abcdefghijklmnopqrstuuM2ZyN0bN6o5uX0B0Qe0b8bOIG8J8r5a')
    returning id into pin_d;
  perform pg_temp.kill(d);

  -- test_requests
  perform pg_temp.expect('s4.1 CONTROL add a line on an active patient''s visit',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 10)$q$, va)), 'ok');
  perform pg_temp.expect('s4.2 add a line on a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 10)$q$, vd)), 'P0058');
  perform pg_temp.expect('s4.3 status change is refused',
    pg_temp.state_of(format($q$update public.test_requests set status = 'in_progress' where id = %L$q$, ld)), 'P0058');
  perform pg_temp.expect('s4.4 cancelling a released line is refused (reverses revenue + PF)',
    pg_temp.state_of(format($q$update public.test_requests set status = 'cancelled', cancelled_reason = 'x' where id = %L$q$, ld_rel)), 'P0058');
  perform pg_temp.expect('s4.5 soft-deleting a line is refused',
    pg_temp.state_of(format($q$update public.test_requests set deleted_at = now(), deleted_by = %L, delete_reason = 'x' where id = %L$q$, k_admin, ld)), 'P0058');
  perform pg_temp.expect('s4.6 moving a line from an active visit onto a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$update public.test_requests set visit_id = %L where id = %L$q$, vd, la)), 'P0058');
  perform pg_temp.expect('s4.7 a line pointing at a visit that does not exist fails closed',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 10)$q$, gen_random_uuid())), 'P0058');
  -- Mismatched references (Codex plan review P1-1): every reference is locked and asserted.
  perform pg_temp.expect('s4.7a CONTROL a component under its own visit''s header',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 0, %L, false)$q$, va, ha)), 'ok');
  perform pg_temp.expect('s4.7b a component on an ACTIVE visit whose parent header is on a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 0, %L, false)$q$, va, hd)), 'P0058');
  perform pg_temp.expect('s4.7c a payment on an ACTIVE visit that corrects a deleted patient''s payment is refused',
    pg_temp.state_of(format($q$insert into public.payments (visit_id, amount_php, method, received_by, corrects_payment_id) values (%L, 10, 'cash', %L, %L)$q$,
      va, 'a1000000-0000-4000-8000-000000000184', pd)), 'P0058');

  -- payments
  perform pg_temp.expect('s4.8 CONTROL payment on an active patient''s visit',
    pg_temp.state_of(format($q$select pg_temp.mk_pay(%L, 10)$q$, va)), 'ok');
  -- s4.9/s4.10 are DOUBLY guarded (verified empirically, controller review
  -- after Tasks 5-6): payments' own a_lifecycle_guard resolves visit_id -> vd
  -- -> deleted d and refuses first in the normal (both-enabled) path, but
  -- recalc_visit_payment (AFTER INSERT/void-UPDATE on payments) also writes
  -- visits.paid_php/payment_status, which independently fires the VISITS
  -- table's OWN a_lifecycle_guard on that nested UPDATE. Disabling
  -- a_lifecycle_guard on payments ALONE still leaves it refused (P0058) via
  -- that nested visits write; both must be disabled together for the
  -- statement to succeed. So the label below intentionally does not claim
  -- "the payments guard" is the (sole) blocker — s4.7c/s4.11 are the ones
  -- that prove the payments trigger on its own (no nested recalc write is
  -- involved in a payment-correction insert or a hard delete).
  perform pg_temp.expect('s4.9 payment on a deleted patient''s visit is refused (doubly guarded: payments'' own a_lifecycle_guard, and — independently — the VISITS guard via recalc_visit_payment''s nested write)',
    pg_temp.state_of(format($q$select pg_temp.mk_pay(%L, 10)$q$, vd)), 'P0058');
  perform pg_temp.expect('s4.10 voiding a deleted patient''s payment is refused (same double guard: payments'' own a_lifecycle_guard, and — independently — the VISITS guard via recalc_visit_payment''s nested write on void)',
    pg_temp.state_of(format($q$update public.payments set voided_at = now(), voided_by = %L, void_reason = 'x' where id = %L$q$, k_admin, pd)), 'P0058');
  perform pg_temp.expect('s4.11 hard-deleting a deleted patient''s payment is refused (payments'' own a_lifecycle_guard — DELETE fires no recalc write)',
    pg_temp.state_of(format($q$delete from public.payments where id = %L$q$, pd)), 'P0058');

  -- visit_pins
  perform pg_temp.expect('s4.12 sign-in bookkeeping on a deleted patient''s PIN is allowed',
    pg_temp.state_of(format($q$update public.visit_pins set failed_attempts = failed_attempts + 1, locked_until = now() where id = %L$q$, pin_d)), 'ok');
  perform pg_temp.expect('s4.13 PIN REISSUE (hash change) is refused',
    pg_temp.state_of(format($q$update public.visit_pins set pin_hash = 'x', expires_at = now() + interval '60 days' where id = %L$q$, pin_d)), 'P0058');
  perform pg_temp.expect('s4.14 new PIN row on a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$insert into public.visit_pins (visit_id, pin_hash) values (%L, 'x')$q$, vd2)), 'P0058');
  perform pg_temp.expect('s4.15 PIN retention delete is allowed',
    pg_temp.state_of(format($q$delete from public.visit_pins where id = %L$q$, pin_d)), 'ok');

  -- Restore lifts it.
  perform pg_temp.revive(d);
  perform pg_temp.expect('s4.16 after restore, a line can be added again',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 10)$q$, vd)), 'ok');
end
$s4$;

-- --- s5: guards on the results family ---------------------------------------------
do $s5$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  k_med   constant uuid := 'a2000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S5A');
  b  uuid := pg_temp.mk_patient('S5B');
  d  uuid := pg_temp.mk_patient('S5D');
  va uuid; vb uuid; vd uuid;
  ta uuid; ta2 uuid; ta3 uuid; ta4 uuid; tb uuid; td uuid; td2 uuid;
  ra uuid; rd uuid; r_new uuid; r_un uuid; r_b uuid;
  tpl uuid; prm uuid;
  al uuid; am_d uuid; am_a uuid; am_b uuid; am_w uuid; al_w uuid; rw uuid; ta5 uuid; am_rw uuid; al_rw uuid;
  s0 int; x0 int;
  kk uuid; e uuid; ve uuid; te uuid; re uuid; ale uuid;
begin
  insert into public.result_templates (service_id, layout) values ('c1000000-0000-4000-8000-000000000184', 'simple')
    returning id into tpl;
  insert into public.result_template_params (template_id, sort_order, parameter_name, input_type)
    values (tpl, 1, 'LK param', 'numeric') returning id into prm;
  va := pg_temp.mk_visit(a);
  vb := pg_temp.mk_visit(b);
  vd := pg_temp.mk_visit(d);
  ta  := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  ta2 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');  -- never linked
  ta3 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');  -- never linked
  ta4 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');  -- never linked
  tb  := pg_temp.mk_line(vb, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  td  := pg_temp.mk_line(vd, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  td2 := pg_temp.mk_line(vd, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into ra;
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into rd;
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into r_b;
  insert into public.result_test_requests (result_id, test_request_id) values (ra, ta), (rd, td), (r_b, tb);
  insert into public.result_values (result_id, parameter_id, numeric_value_si) values (rd, prm, 1);
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id)
    values (rd, td, prm, 'high', 'LK param', d) returning id into al;
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (rd, td, 'x', k_med, now(), 'smoke', k_med, 1) returning id into am_d;
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (ra, ta, 'x', k_med, now(), 'smoke', k_med, 1) returning id into am_a;
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (r_b, tb, 'x', k_med, now(), 'smoke', k_med, 1) returning id into am_b;
  perform pg_temp.kill(d);

  perform pg_temp.expect('s5.1 an UNLINKED result row can always be inserted (inert)',
    pg_temp.state_of(format($q$insert into public.results (generation_kind, uploaded_by) values ('structured', %L)$q$, k_med)), 'ok');
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into r_new;
  -- ta2 was never linked (uq_result_test_requests_test_request allows one result per test).
  perform pg_temp.expect('s5.2 CONTROL link a result to an active patient''s unlinked test',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, r_new, ta2)), 'ok');
  perform pg_temp.expect('s5.3 linking a result to a deleted patient''s test is refused',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, r_new, td2)), 'P0058');
  perform pg_temp.expect('s5.4 editing a deleted patient''s result row is refused',
    pg_temp.state_of(format($q$update public.results set notes = 'x' where id = %L$q$, rd)), 'P0058');
  perform pg_temp.expect('s5.5 CONTROL editing an active patient''s result row',
    pg_temp.state_of(format($q$update public.results set notes = 'x' where id = %L$q$, ra)), 'ok');
  perform pg_temp.expect('s5.6 saving a value on a deleted patient''s result is refused',
    pg_temp.state_of(format($q$update public.result_values set numeric_value_si = 2 where result_id = %L$q$, rd)), 'P0058');
  perform pg_temp.expect('s5.7 inserting an amendment row is refused',
    pg_temp.state_of(format($q$insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by, prior_uploaded_at, reason, amended_by, amendment_seq) values (%L, %L, 'x', %L, now(), 'x', %L, 2)$q$, rd, td, k_med, k_med)), 'P0058');
  perform pg_temp.expect('s5.8 acknowledging a deleted patient''s critical alert is allowed',
    pg_temp.state_of(format($q$update public.critical_alerts set acknowledged_at = now(), acknowledged_by = %L where id = %L$q$, k_med, al)), 'ok');
  perform pg_temp.expect('s5.9 changing anything else on the alert is refused',
    pg_temp.state_of(format($q$update public.critical_alerts set observed_value_si = 9 where id = %L$q$, al)), 'P0058');
  perform pg_temp.expect('s5.10 new critical alert for a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id) values (%L, %L, %L, 'low', 'LK param', %L)$q$, rd, td, prm, d)), 'P0058');
  perform pg_temp.expect('s5.11 deleting a deleted patient''s result is refused',
    pg_temp.state_of(format($q$delete from public.results where id = %L$q$, rd)), 'P0058');
  perform pg_temp.expect('s5.12 unlinking (junction delete) is refused',
    pg_temp.state_of(format($q$delete from public.result_test_requests where result_id = %L$q$, rd)), 'P0058');

  -- Mismatched references (Codex plan review P1-1): every reference is locked and asserted.
  perform pg_temp.expect('s5.13 linking an ACTIVE patient''s test to a DELETED patient''s result is refused',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, rd, ta3)), 'P0058');
  perform pg_temp.expect('s5.14 an amendment naming an active test but a deleted patient''s result is refused',
    pg_temp.state_of(format($q$insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by, prior_uploaded_at, reason, amended_by, amendment_seq) values (%L, %L, 'x', %L, now(), 'x', %L, 9)$q$, rd, ta, k_med, k_med)), 'P0058');
  perform pg_temp.expect('s5.15 an alert naming an active test + patient but a deleted patient''s result is refused',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id) values (%L, %L, %L, 'low', 'LK param', %L)$q$, rd, ta, prm, a)), 'P0058');
  -- Was P0058 before the controller-review fix that freed critical_alerts.patient_id
  -- from the (a2) immutable list: patient_id=d mismatches ta's real (active)
  -- patient a, so the new (a2') consistency check now catches this — a data
  -- integrity error (23514), not an activity check — BEFORE step (c) ever
  -- gets a chance to notice d is deleted. s5.10 still covers "patient_id
  -- correctly matches an INACTIVE patient's own test", which is P0058.
  perform pg_temp.expect('s5.16 an alert on an active result + test but patient_id = an unrelated (deleted) patient mismatches and is refused (23514, not P0058 — the mismatch is caught before the activity check)',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id) values (%L, %L, %L, 'low', 'LK param', %L)$q$, ra, ta, prm, d)), '23514');
  perform pg_temp.expect('s5.17 an alert on an active result withdrawn by a DELETED patient''s amendment is refused',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id, withdrawn_by_amendment) values (%L, %L, %L, 'low', 'LK param', %L, %L)$q$, ra, ta, prm, a, am_d)), 'P0058');

  -- The same Codex case through the real client path: an authenticated admin
  -- under RLS (0151's admin manage policy on the junction).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', k_admin)::text, true);
  perform set_config('request.jwt.claim.sub', k_admin::text, true);
  perform pg_temp.expect('s5.18 authenticated admin: active test → deleted patient''s result is refused',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, rd, ta3)), 'P0058');
  perform pg_temp.expect('s5.19 authenticated admin CONTROL: active test → an unlinked result',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, r_new, ta3)), 'ok');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- One patient per result.
  perform pg_temp.expect('s5.20 linking another ACTIVE patient''s test to a result is refused (one patient per result)',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, r_b, ta4)), '23514');
  perform pg_temp.expect('s5.21 CONTROL a second test of the SAME patient joins the result',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, ra, ta4)), 'ok');

  -- 0179 follow-up bookkeeping on a deleted patient's amendment: allowed; anything else refused.
  perform pg_temp.expect('s5.22 marking a deleted patient contacted about a correction is allowed',
    pg_temp.state_of(format($q$update public.result_amendments set patient_contacted_at = now(), patient_contacted_by = %L where id = %L$q$, k_med, am_d)), 'ok');
  perform pg_temp.expect('s5.23 recording a notice outcome is allowed',
    pg_temp.state_of(format($q$update public.result_amendments set patient_notified_at = now(), patient_notified_channels = '{}', patient_notify_error = 'skipped' where id = %L$q$, am_d)), 'ok');
  perform pg_temp.expect('s5.24 changing the amendment''s reason is refused',
    pg_temp.state_of(format($q$update public.result_amendments set reason = 'x', patient_contacted_at = now() where id = %L$q$, am_d)), 'P0058');

  -- Membership lock modes (Codex plan review P1-2).
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into r_un;
  s0 := pg_temp.held_results('ShareLock');
  insert into public.result_values (result_id, parameter_id, numeric_value_si) values (r_un, prm, 5);
  perform pg_temp.expect('s5.25 a value on an UNLINKED result still takes the SHARED membership lock',
    (pg_temp.held_results('ShareLock') - s0)::text, '1');
  x0 := pg_temp.held_results('ExclusiveLock');
  insert into public.result_test_requests (result_id, test_request_id)
    values (r_un, pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184'));
  perform pg_temp.expect('s5.26 a link takes the EXCLUSIVE membership lock',
    (pg_temp.held_results('ExclusiveLock') - x0)::text, '1');
  perform pg_temp.expect('s5.27 CONTROL an active patient''s amendment reason can still change',
    pg_temp.state_of(format($q$update public.result_amendments set reason = 'y' where id = %L$q$, am_a)), 'ok');

  -- Indirect references are immutable / consistent (Codex recheck P1).
  perform pg_temp.expect('s5.28 re-pointing a correction at another result is refused',
    pg_temp.state_of(format($q$update public.result_amendments set result_id = %L where id = %L$q$, r_new, am_a)), '23514');
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id)
    values (ra, ta, prm, 'high', 'LK param', a) returning id into al_w;
  perform pg_temp.expect('s5.29 re-pointing an alert at another result is refused',
    pg_temp.state_of(format($q$update public.critical_alerts set result_id = %L where id = %L$q$, r_new, al_w)), '23514');
  perform pg_temp.expect('s5.30 an alert withdrawn by a correction of ANOTHER result is refused',
    pg_temp.state_of(format($q$update public.critical_alerts set withdrawn_at = now(), withdrawn_by = %L, withdrawn_by_amendment = %L where id = %L$q$, k_med, am_b, al_w)), '23514');

  -- 0179's ON DELETE SET NULL through the guard, active patient (Codex recheck P2-3).
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (ra, ta, 'x', k_med, now(), 'smoke', k_med, 2) returning id into am_w;
  update public.critical_alerts set withdrawn_at = now(), withdrawn_by = k_med, withdrawn_by_amendment = am_w where id = al_w;
  perform pg_temp.expect('s5.31 deleting the correction that withdrew an alert (SET NULL on the alert) is allowed',
    pg_temp.state_of(format($q$delete from public.result_amendments where id = %L$q$, am_w)), 'ok');
  perform pg_temp.expect('s5.32 …and the alert survives with the reference cleared',
    (select (withdrawn_by_amendment is null)::text from public.critical_alerts where id = al_w), 'true');
  ta5 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into rw;
  insert into public.result_test_requests (result_id, test_request_id) values (rw, ta5);
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (rw, ta5, 'x', k_med, now(), 'smoke', k_med, 1) returning id into am_rw;
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id,
                                      withdrawn_at, withdrawn_by, withdrawn_by_amendment)
    values (rw, ta5, prm, 'low', 'LK param', a, now(), k_med, am_rw) returning id into al_rw;
  perform pg_temp.expect('s5.33 deleting an active patient''s result that carries a correction and an alert it withdrew (cascades) is allowed',
    pg_temp.state_of(format($q$delete from public.results where id = %L$q$, rw)), 'ok');
  perform pg_temp.expect('s5.34 …and everything under it is gone',
    (select count(*)::text from public.critical_alerts where id = al_rw)
      || (select count(*)::text from public.result_amendments where id = am_rw), '00');

  -- a_lifecycle_guard fires FIRST among BEFORE row triggers on all five
  -- results-family tables too (same catalog check as s3.28, extended here per
  -- controller instruction — Task 6 must prove the guard sorts first on each
  -- of the five tables it installs on this task).
  perform pg_temp.expect('s5.35 a_lifecycle_guard fires first among BEFORE row triggers on all five results-family tables',
    (select string_agg(first_trigger, ',' order by rel) from (
       select c.relname as rel,
              (select t.tgname from pg_trigger t
                where t.tgrelid = c.oid and not t.tgisinternal and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
                order by t.tgname collate "C" limit 1) as first_trigger
         from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relname in ('results', 'result_test_requests', 'result_values', 'result_amendments', 'critical_alerts')) s),
    'a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard');

  -- critical_alerts.patient_id follows its test, it is not frozen (controller
  -- review after Tasks 5-6, reviewer repro $SCRATCH/rv_x1.sql): the live
  -- merge flow (mergePatientsAction) moves a visit's patient then repoints
  -- critical_alerts.patient_id to match, which the old (a2) immutable-list
  -- entry for patient_id refused with 23514, stranding every alert on the
  -- merged-away record and then refusing its withdraw/delete with P0058 once
  -- the source patient was tombstoned. al_w (result_id=ra, test_request_id=ta,
  -- patient_id=a throughout s5 so far — every earlier attempt to change it
  -- was refused) is reused here as the moved alert.
  kk := pg_temp.mk_patient('S5KK');
  perform pg_temp.expect('s5.36 CONTROL move va (a''s visit, carrying ta/ra/al_w) from active a to active kk',
    pg_temp.state_of(format($q$update public.visits set patient_id = %L where id = %L$q$, kk, va)), 'ok');
  perform pg_temp.expect('s5.37 …then repointing al_w''s patient_id to kk (matching ta''s new patient) is allowed',
    pg_temp.state_of(format($q$update public.critical_alerts set patient_id = %L where id = %L$q$, kk, al_w)), 'ok');
  perform pg_temp.expect('s5.37b …and it actually moved',
    (select (patient_id = kk)::text from public.critical_alerts where id = al_w), 'true');
  perform pg_temp.expect('s5.38 setting an alert''s patient_id to an UNRELATED active patient (b, whose own test is not ta) is refused',
    pg_temp.state_of(format($q$update public.critical_alerts set patient_id = %L where id = %L$q$, b, al_w)), '23514');
  perform pg_temp.expect('s5.38b inserting a critical alert whose patient_id mismatches its test''s patient is refused the same way',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id) values (%L, %L, %L, 'low', 'LK param', %L)$q$, ra, ta4, prm, b)), '23514');

  -- (iii) "the same move" as s5.36/s5.37, but the SOURCE patient is DELETED
  -- instead of merely active-about-to-merge: moving the visit itself is
  -- refused at the VISIT step (OLD side names deleted e), before the alert
  -- repoint is ever attempted. (Attempting the critical_alerts repoint
  -- directly, without moving the visit first, cannot reach P0058 here at
  -- all: since e's visit can never successfully move while e is deleted —
  -- this assertion IS that proof — the test's real patient stays e forever,
  -- so any critical_alerts.patient_id other than e would be a (a2')
  -- MISMATCH, caught as 23514 before step (c)'s activity check ever runs.
  -- The activity check on patient_id is still real, it is just proven
  -- elsewhere: s5.10 is exactly "patient_id correctly matches an INACTIVE
  -- patient's own test" — a fresh critical_alerts INSERT — and that raises
  -- P0058, which is the only state this rule can ever actually reach.)
  e  := pg_temp.mk_patient('S5E');
  ve := pg_temp.mk_visit(e);
  te := pg_temp.mk_line(ve, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into re;
  insert into public.result_test_requests (result_id, test_request_id) values (re, te);
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id)
    values (re, te, prm, 'high', 'LK param', e) returning id into ale;
  perform pg_temp.kill(e);
  perform pg_temp.expect('s5.39 "the same move" when the source patient is DELETED: moving ve onto active kk is refused at the VISIT step (OLD side names deleted e), before any alert repoint is attempted',
    pg_temp.state_of(format($q$update public.visits set patient_id = %L where id = %L$q$, kk, ve)), 'P0058');
  perform pg_temp.expect('s5.39b …and ale is untouched (the move never happened, so the alert was never even reached)',
    (select patient_id::text from public.critical_alerts where id = ale), e::text);
  -- s5.10 (deleted patient's OWN consistent alert, "new critical alert for a
  -- deleted patient is refused") already proves the activity check itself
  -- fires P0058 when patient_id correctly matches an inactive patient's own
  -- test — the exact case "the same move" can never actually construct at
  -- the critical_alerts level once (a2') exists.
end
$s5$;

-- --- s6: HMO + PF guards, mixed batch ---------------------------------------------
do $s6$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S6A');   -- active, open item
  d  uuid := pg_temp.mk_patient('S6D');   -- deleted, SETTLED item in the same batch
  va uuid; vd uuid; ta uuid; td uuid; td_un uuid;
  bat uuid; bat2 uuid; ia uuid; id_ uuid; id_un uuid;
  pay_d uuid; alloc_d uuid; pf_d uuid; pay_a uuid;
  phys uuid; disb uuid;
begin
  va := pg_temp.mk_visit(a, true);
  vd := pg_temp.mk_visit(d, true);
  ta := pg_temp.mk_line(va, 'released', 1000);
  td := pg_temp.mk_line(vd, 'released', 1000);
  td_un := pg_temp.mk_line(vd, 'released', 500);
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted') returning id into bat;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bat, ta, 1000) returning id into ia;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bat, td, 1000) returning id into id_;
  -- d's item: settled (paid 1000).
  pay_d := pg_temp.mk_pay(vd, 1000, 'hmo');
  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (pay_d, id_, 1000) returning id into alloc_d;
  -- d's second item sits in a VOIDED batch (the reopen case).
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted') returning id into bat2;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bat2, td_un, 500) returning id into id_un;
  update public.hmo_claim_batches set voided_at = now(), voided_by = k_admin, void_reason = 'smoke', status = 'voided' where id = bat2;
  insert into public.physicians (slug, full_name, specialty) values ('lk-smoke-doc', 'LK Smoke Doc', 'General')
    returning id into phys;
  insert into public.doctor_pf_entries (test_request_id, physician_id, pf_php, recognition_basis, recognized_at)
    values (td, phys, 100, 'cash_at_release', now())
    returning id into pf_d;
  perform pg_temp.kill(d);

  -- Mixed batch: settling ACTIVE a's item succeeds although deleted d's settled item shares the batch.
  pay_a := pg_temp.mk_pay(va, 1000, 'hmo');
  perform pg_temp.expect('s6.1 mixed batch: settling the active patient''s item succeeds',
    pg_temp.state_of(format($q$insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (%L, %L, 1000)$q$, pay_a, ia)), 'ok');
  perform pg_temp.expect('s6.2 …and the batch rolled up (recompute touched only batches + a''s item)',
    (select status from public.hmo_claim_batches where id = bat), 'paid');

  perform pg_temp.expect('s6.3 voiding the deleted patient''s allocation is refused (reopens a settled balance)',
    pg_temp.state_of(format($q$update public.hmo_payment_allocations set voided_at = now(), voided_by = %L, void_reason = 'x' where id = %L$q$, k_admin, alloc_d)), 'P0058');
  perform pg_temp.expect('s6.4 a resolution on the deleted patient''s item is refused',
    pg_temp.state_of(format($q$insert into public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by) values (%L, 'write_off', 1, %L)$q$, id_, k_admin)), 'P0058');
  perform pg_temp.expect('s6.5 editing the deleted patient''s claim item is refused',
    pg_temp.state_of(format($q$update public.hmo_claim_items set hmo_response = 'paid' where id = %L$q$, id_)), 'P0058');
  perform pg_temp.expect('s6.6 reopening a voided batch that holds a deleted patient''s item is refused (nested write checked)',
    pg_temp.state_of(format($q$update public.hmo_claim_batches set voided_at = null, voided_by = null, void_reason = null, status = 'submitted' where id = %L$q$, bat2)), 'P0058');
  perform pg_temp.expect('s6.7 …and the batch stayed voided',
    (select (voided_at is not null)::text from public.hmo_claim_batches where id = bat2), 'true');

  -- doctor_pf_entries: linking a disbursement is allowed; anything else is refused.
  insert into public.doctor_pf_disbursements (batch_number, physician_id, posted_date, method, total_php, recorded_by)
    values ((select coalesce(max(batch_number), 0) + 1 from public.doctor_pf_disbursements),
            phys, (now() at time zone 'Asia/Manila')::date, 'cash', 100, k_admin)
    returning id into disb;
  perform pg_temp.expect('s6.8 paying the doctor (disbursement link) is allowed',
    pg_temp.state_of(format($q$update public.doctor_pf_entries set disbursement_id = %L where id = %L$q$, disb, pf_d)), 'ok');
  perform pg_temp.expect('s6.9 voiding the PF entry is refused',
    pg_temp.state_of(format($q$update public.doctor_pf_entries set voided_at = now(), voided_by = %L, void_reason = 'x' where id = %L$q$, k_admin, pf_d)), 'P0058');
  -- Mismatched references (Codex plan review P1-1): a PF entry for an ACTIVE
  -- patient's test that points at a DELETED patient's HMO allocation.
  perform pg_temp.expect('s6.10 a PF entry whose allocation belongs to a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.doctor_pf_entries (test_request_id, physician_id, pf_php, recognition_basis, recognized_at, hmo_allocation_id) values (%L, %L, 10, 'hmo_at_settlement', now(), %L)$q$, ta, phys, alloc_d)), 'P0058');
  perform pg_temp.expect('s6.11 an allocation of an ACTIVE item to a deleted patient''s payment is refused',
    pg_temp.state_of(format($q$insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (%L, %L, 1)$q$, pay_d, ia)), 'P0058');

  -- a_lifecycle_guard fires FIRST among BEFORE row triggers on all four
  -- newly guarded tables too (same catalog check as s3.28/s5.35).
  perform pg_temp.expect('s6.12 a_lifecycle_guard fires first among BEFORE row triggers on the four HMO/PF tables',
    (select string_agg(first_trigger, ',' order by rel) from (
       select c.relname as rel,
              (select t.tgname from pg_trigger t
                where t.tgrelid = c.oid and not t.tgisinternal and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
                order by t.tgname collate "C" limit 1) as first_trigger
         from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relname in ('hmo_claim_items', 'hmo_payment_allocations', 'hmo_claim_resolutions', 'doctor_pf_entries')) s),
    'a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard');
end
$s6$;

-- --- s7: existing RPCs lock the patient first ---------------------------------------
do $s7$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  k_med   constant uuid := 'a2000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S7A');
  d  uuid := pg_temp.mk_patient('S7D');
  va uuid; vd uuid; td uuid; td2 uuid; rd uuid; rd2 uuid; pd uuid; att uuid := gen_random_uuid();
  f  text;
  def text;
  lp int; rp int; mp int;
  res jsonb;
  phys2 uuid; ta_fee uuid; td_fee uuid;
  m uuid := pg_temp.mk_patient('S7M'); vm uuid; tm_fee uuid;  -- 0184 review M3
  -- 0184 review I1: payments.corrects_payment_id must not freeze a moved
  -- payment. The move target is `a`'s own visit `va` (already active,
  -- already set up above) — no separate target patient needed.
  pe uuid := pg_temp.mk_patient('S7E');
  ve uuid; x_m uuid; y_m uuid; x_r uuid; y_r uuid; x_v uuid; y_v uuid; x_c uuid; y_c uuid;
  ctx text;
  -- 0184 review I2: (a2') only when the alert's patient could change.
  t_i2 uuid; r_i2 uuid; prm_i2 uuid; al_null uuid;
  t_i2b uuid; r_i2b uuid; al_ok uuid; other_pt uuid := pg_temp.mk_patient('S7OTHER');
begin
  -- Text order: the lifecycle call comes before the first FOR UPDATE / slot
  -- lock. BOTH positions must be > 0: position() returns 0 for a missing call,
  -- and 0 < n would pass (Codex plan review P3).
  foreach f in array array[
    'public.result_save_draft(uuid,jsonb)',
    'public.result_finalise_commit(uuid,uuid,jsonb,text,integer,timestamp with time zone,jsonb,jsonb)',
    'public.result_edit_commit(uuid,uuid,integer,uuid,text,uuid,text,integer,jsonb,jsonb,jsonb)',
    'public.correct_payment(uuid,numeric,text,text,text,text,uuid,uuid,jsonb)']
  loop
    def := lower(pg_get_functiondef(f::regprocedure));
    lp := position('lifecycle_lock_and_assert' in def);
    rp := position('for update' in def);
    perform pg_temp.expect('s7.1 lock before row lock: ' || f, (lp > 0 and rp > 0 and lp < rp)::text, 'true');
    -- The three result RPCs take the membership lock before the patient lock.
    if f like 'public.result_%' then
      mp := position('lifecycle_lock_results' in def);
      perform pg_temp.expect('s7.1m membership lock before patient lock: ' || f, (mp > 0 and lp > 0 and mp < lp)::text, 'true');
    end if;
  end loop;
  def := pg_get_functiondef('public.appointments_insert_slot_guarded(jsonb,uuid,timestamp with time zone,boolean)'::regprocedure);
  lp := position('lifecycle_lock_and_assert' in def);
  rp := position('appt_slot:' in def);
  perform pg_temp.expect('s7.2 lock before slot lock: appointments_insert_slot_guarded', (lp > 0 and rp > 0 and lp < rp)::text, 'true');

  -- Behaviour on a deleted patient.
  va := pg_temp.mk_visit(a);
  vd := pg_temp.mk_visit(d);
  td := pg_temp.mk_line(vd, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  td2 := pg_temp.mk_line(vd, 'released', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into rd;
  insert into public.result_test_requests (result_id, test_request_id) values (rd, td);
  insert into public.results (generation_kind, uploaded_by, storage_path, file_size_bytes, finalised_at)
    values ('structured', k_med, 'x/y.pdf', 10, now()) returning id into rd2;
  insert into public.result_test_requests (result_id, test_request_id) values (rd2, td2);
  -- A committed edit attempt recorded BEFORE the delete (for the replay case).
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq, attempt_id, commit_outcome)
    values (rd2, td2, 'x/old.pdf', k_med, now(), 'smoke edit', k_med, 1, att,
            jsonb_build_object('alerts_added', '[]'::jsonb, 'alerts_removed', 0, 'alerts_kept_acknowledged', 0));
  pd := pg_temp.mk_pay(vd, 50);

  -- (Controller review fix, item 2) recompute_clinic_fee_for_unreleased is a
  -- bulk ALL-PATIENTS scrub with no lock to take — its fixture must be built
  -- while d is still ACTIVE (the reviewer's actual bug: an inactive
  -- patient's otherwise-eligible line used to abort the WHOLE UPDATE with
  -- P0058, $SCRATCH/rv_x5.sql), so d is killed only AFTER both lines exist.
  insert into public.physicians (slug, full_name, specialty) values ('lk-s7-doc', 'LK S7 Doc', 'GP') returning id into phys2;
  insert into public.physician_compensation (physician_id, compensation_arrangement)
    values (phys2, 'rent_paying')
    on conflict (physician_id) do update set compensation_arrangement = 'rent_paying', clinic_cut_php = null;
  ta_fee := pg_temp.mk_line(va, 'requested', 500);
  td_fee := pg_temp.mk_line(vd, 'requested', 500);
  update public.test_requests set attending_physician_id = phys2, clinic_fee_php = 100 where id in (ta_fee, td_fee);
  -- 0184 review M3: a MERGED patient's line, built the same way while m is
  -- still active (same reason as td_fee above).
  vm := pg_temp.mk_visit(m);
  tm_fee := pg_temp.mk_line(vm, 'requested', 500);
  update public.test_requests set attending_physician_id = phys2, clinic_fee_php = 100 where id = tm_fee;

  perform pg_temp.kill(d);
  perform pg_temp.merge_into(m, a);

  perform pg_temp.expect('s7.3 result_save_draft on a deleted patient',
    pg_temp.state_of(format($q$select public.result_save_draft(%L, '[]'::jsonb)$q$, rd)), 'P0058');
  perform pg_temp.expect('s7.4 result_finalise_commit on a deleted patient',
    pg_temp.state_of(format($q$select public.result_finalise_commit(%L, %L, '[]'::jsonb, 'p.pdf', 1, now(), null, '[]'::jsonb)$q$, rd, k_med)), 'P0058');
  -- 0184 review M2: s7.4's P0058 alone is vacuous — test_requests/results are
  -- ALSO independently guarded (section 3), so it would pass identically even
  -- with section 4's pre-lock deleted entirely. Assert the raise came from
  -- the RPC's OWN pre-lock, not from enforce_patient_activity firing on some
  -- downstream write the RPC never even reached.
  ctx := pg_temp.context_of(format($q$select public.result_finalise_commit(%L, %L, '[]'::jsonb, 'p.pdf', 1, now(), null, '[]'::jsonb)$q$, rd, k_med));
  perform pg_temp.expect('s7.4c …and it was result_finalise_commit''s OWN pre-lock, not the downstream guard',
    (ctx not like '%enforce_patient_activity%')::text, 'true');
  perform pg_temp.expect('s7.5 result_edit_commit (new attempt) on a deleted patient',
    pg_temp.state_of(format($q$select public.result_edit_commit(%L, %L, 1, %L, 'a long enough reason', %L, 'n.pdf', 1, null, null, null)$q$, gen_random_uuid(), rd2, k_med, td2)), 'P0058');
  res := public.result_edit_commit(att, rd2, 0, k_med, 'smoke edit', td2, 'n.pdf', 1, null, null, null);
  perform pg_temp.expect('s7.6 …but a REPLAY of an attempt that already committed still answers',
    (res ->> 'replayed'), 'true');
  perform pg_temp.expect('s7.7 correct_payment on a deleted patient',
    pg_temp.state_of(format($q$select public.correct_payment(%L, 40, 'cash', null, null, 'smoke fix', %L)$q$, pd, k_admin)), 'P0058');
  ctx := pg_temp.context_of(format($q$select public.correct_payment(%L, 40, 'cash', null, null, 'smoke fix', %L)$q$, pd, k_admin));
  perform pg_temp.expect('s7.7c …and it was correct_payment''s OWN pre-lock, not the downstream guard',
    (ctx not like '%enforce_patient_activity%')::text, 'true');
  perform pg_temp.expect('s7.8 correct_payment moving money ONTO a deleted patient''s visit',
    pg_temp.state_of(format($q$select public.correct_payment(%L, 10, 'cash', null, null, 'move', %L, %L)$q$,
      pg_temp.mk_pay(va, 10), k_admin, vd)), 'P0058');
  ctx := pg_temp.context_of(format($q$select public.correct_payment(%L, 10, 'cash', null, null, 'move', %L, %L)$q$,
      pg_temp.mk_pay(va, 10), k_admin, vd));
  perform pg_temp.expect('s7.8c …and it was correct_payment''s OWN pre-lock, not the downstream guard',
    (ctx not like '%enforce_patient_activity%')::text, 'true');
  perform pg_temp.expect('s7.9 correct_payment on a missing payment keeps its own message (P0054)',
    pg_temp.state_of(format($q$select public.correct_payment(%L, 1, 'cash', null, null, 'x', %L)$q$, gen_random_uuid(), k_admin)), 'P0054');
  perform pg_temp.expect('s7.10 appointments_insert_slot_guarded for a deleted patient',
    pg_temp.state_of(format($q$select public.appointments_insert_slot_guarded(jsonb_build_array(jsonb_build_object('patient_id', %L, 'status', 'confirmed', 'scheduled_at', (now() + interval '1 day')::text)))$q$, d)), 'P0058');
  ctx := pg_temp.context_of(format($q$select public.appointments_insert_slot_guarded(jsonb_build_array(jsonb_build_object('patient_id', %L, 'status', 'confirmed', 'scheduled_at', (now() + interval '1 day')::text)))$q$, d));
  perform pg_temp.expect('s7.10c …and it was appointments_insert_slot_guarded''s OWN pre-lock, not the downstream guard',
    (ctx not like '%enforce_patient_activity%')::text, 'true');
  perform pg_temp.expect('s7.11 CONTROL walk-in through the same RPC',
    pg_temp.state_of($q$select public.appointments_insert_slot_guarded(jsonb_build_array(jsonb_build_object('walk_in_name', 'W', 'walk_in_phone', '09170000000', 'status', 'confirmed', 'scheduled_at', (now() + interval '1 day')::text)))$q$), 'ok');
  perform pg_temp.expect('s7.12 CONTROL active patient through the same RPC',
    pg_temp.state_of(format($q$select public.appointments_insert_slot_guarded(jsonb_build_array(jsonb_build_object('patient_id', %L, 'status', 'confirmed', 'scheduled_at', (now() + interval '1 day')::text)))$q$, a)), 'ok');

  -- recompute_clinic_fee_for_unreleased (Task 4f): both lines were eligible
  -- before d was killed; the scrub must not raise even though one of them
  -- now belongs to a deleted patient, and must skip (not scrub) exactly that
  -- one.
  perform pg_temp.expect('s7.13 CONTROL both lines are eligible before the scrub',
    (select count(*)::text from public.test_requests where id in (ta_fee, td_fee) and clinic_fee_php > 0), '2');
  perform pg_temp.expect('s7.13m CONTROL the MERGED patient''s line is also eligible before the scrub',
    (select (clinic_fee_php > 0)::text from public.test_requests where id = tm_fee), 'true');
  perform pg_temp.expect('s7.14 the bulk scrub does not raise P0058 even though a deleted patient''s line qualifies',
    pg_temp.state_of($q$select public.recompute_clinic_fee_for_unreleased()$q$), 'ok');
  perform pg_temp.expect('s7.15 the ACTIVE patient''s line was scrubbed (clinic_fee_php -> 0)',
    (select clinic_fee_php::text from public.test_requests where id = ta_fee), '0.00');
  perform pg_temp.expect('s7.15b …and doctor_pf_php absorbed it',
    (select doctor_pf_php::text from public.test_requests where id = ta_fee), '500.00');
  perform pg_temp.expect('s7.16 the DELETED patient''s line was SKIPPED — clinic_fee_php unchanged, not scrubbed',
    (select clinic_fee_php::text from public.test_requests where id = td_fee), '100.00');
  -- 0184 review M3: same skip for a MERGED patient's line (s7.13-16 above
  -- only proved the deleted case).
  perform pg_temp.expect('s7.16m the MERGED patient''s line was also SKIPPED — clinic_fee_php unchanged, not scrubbed',
    (select clinic_fee_php::text from public.test_requests where id = tm_fee), '100.00');

  -- ============================================================================
  -- 0184 review I1: payments.corrects_payment_id must not freeze a moved
  -- payment onto its (possibly later-deleted) source patient forever.
  -- Flow: a payment recorded on the wrong patient (pe) is moved onto the
  -- right one (a, via its visit va) via correct_payment; pe is then deleted
  -- as a genuine duplicate (via the real delete_patient, blockers clear
  -- because its only visit was soft-deleted first); every future edit/void
  -- of the MOVED payment, on a — active throughout — must still work.
  -- ============================================================================
  ve := pg_temp.mk_visit(pe);
  -- A visit with total_php = 0 is always 'paid' (recalc_visit_payment, 0111:
  -- `v_total = 0 or v_paid >= v_total` is vacuously true) — give it a real
  -- total so voiding every payment below actually reaches 'unpaid', or the
  -- soft-delete two steps down would be refused (visit not unpaid), same
  -- trap the reviewer's own repro sidesteps by setting total_php = 100.
  update public.visits set total_php = 100 where id = ve;
  x_m := pg_temp.mk_pay(ve, 10);
  y_m := public.correct_payment(x_m, 10, 'cash', null, null, 'recorded on the wrong patient', k_admin, va);
  x_r := pg_temp.mk_pay(ve, 10);
  y_r := public.correct_payment(x_r, 10, 'cash', null, null, 'recorded on the wrong patient', k_admin, va);
  x_v := pg_temp.mk_pay(ve, 10);
  y_v := public.correct_payment(x_v, 10, 'cash', null, null, 'recorded on the wrong patient', k_admin, va);
  x_c := pg_temp.mk_pay(ve, 10);
  y_c := public.correct_payment(x_c, 10, 'cash', null, null, 'recorded on the wrong patient', k_admin, va);

  -- ve (pe's only visit) is soft-deleted so patient_delete_blockers(pe) is
  -- clear (an empty live visit, or one still carrying a live test, is itself
  -- a blocker — 0167), then pe is deleted for real.
  update public.visits set deleted_at = now(), deleted_by = k_admin, delete_reason = 'wrong patient' where id = ve;
  perform pg_temp.expect('s7.17 patient_delete_blockers(pe) is clear once its only visit is soft-deleted',
    (public.patient_delete_blockers(pe))::text, '[]');
  perform pg_temp.expect('s7.18 pe is deletable via the REAL delete_patient (no blockers)',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', null, %L, null)$q$, pe, k_admin)), 'ok');

  perform pg_temp.expect('s7.19 editing (method) the moved payment on ACTIVE pa succeeds even though pe is now deleted',
    pg_temp.state_of(format($q$select public.correct_payment(%L, 10, 'gcash', null, null, 'method fix', %L)$q$, y_m, k_admin)), 'ok');
  perform pg_temp.expect('s7.20 editing (reference only) the moved payment succeeds too',
    pg_temp.state_of(format($q$select public.correct_payment(%L, 10, 'cash', 'REF-S7', null, 'ref fix', %L)$q$, y_r, k_admin)), 'ok');
  perform pg_temp.expect('s7.21 voiding the moved payment directly succeeds',
    pg_temp.state_of(format($q$update public.payments set voided_at = now(), voided_by = %L, void_reason = 'x' where id = %L$q$, k_admin, y_v)), 'ok');

  perform pg_temp.expect('s7.22 corrects_payment_id is immutable (23514)',
    pg_temp.state_of(format($q$update public.payments set corrects_payment_id = %L where id = %L$q$, x_m, y_c)), '23514');

  perform pg_temp.expect('s7.23 inserting a NEW correction of a payment on a DELETED patient is refused (P0058, via corrects_payment_id, INSERT only)',
    pg_temp.state_of(format($q$insert into public.payments (visit_id, amount_php, method, received_by, corrects_payment_id) values (%L, 5, 'cash', %L, %L)$q$, va, k_admin, x_m)), 'P0058');

  -- ============================================================================
  -- 0184 review I2: (a2') only fires when the alert's patient_id could
  -- change — INSERT, or an UPDATE that actually touches patient_id. A legacy
  -- alert whose stored patient_id is stale/NULL must not block an UNRELATED
  -- write on it (result_edit_commit's withdrawal), on an otherwise ACTIVE
  -- patient's result.
  -- ============================================================================
  t_i2 := pg_temp.mk_line(va, 'released', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  insert into public.results (generation_kind, uploaded_by, storage_path, file_size_bytes, finalised_at)
    values ('structured', k_med, 'x/y2.pdf', 10, now()) returning id into r_i2;
  insert into public.result_test_requests (result_id, test_request_id) values (r_i2, t_i2);
  select id into prm_i2 from public.result_template_params limit 1;
  -- Simulate a legacy row predating this column being kept consistent:
  -- session_replication_role = replica skips ALL triggers, including
  -- a_lifecycle_guard, for this one INSERT only.
  set local session_replication_role = replica;
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id)
    values (r_i2, t_i2, prm_i2, 'high', 'legacy', null) returning id into al_null;
  set local session_replication_role = origin;

  perform pg_temp.expect('s7.24 withdrawing a legacy NULL-patient alert on an ACTIVE patient succeeds',
    pg_temp.state_of(format($q$select public.result_edit_commit(%L, %L, 0, %L, 'fix a typo', %L, 'n2.pdf', 1, null, null, '[]'::jsonb)$q$, gen_random_uuid(), r_i2, k_med, t_i2)), 'ok');
  perform pg_temp.expect('s7.24b …and the legacy alert was actually withdrawn',
    (select (withdrawn_at is not null)::text from public.critical_alerts where id = al_null), 'true');

  -- CONTROL: when patient_id DOES change (a raw UPDATE, not through the
  -- merge flow), a wrong value is still refused — the carve-out only skips
  -- the check when the column is untouched, it does not remove it.
  t_i2b := pg_temp.mk_line(va, 'released', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  insert into public.results (generation_kind, uploaded_by, storage_path, file_size_bytes, finalised_at)
    values ('structured', k_med, 'x/y3.pdf', 10, now()) returning id into r_i2b;
  insert into public.result_test_requests (result_id, test_request_id) values (r_i2b, t_i2b);
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id)
    values (r_i2b, t_i2b, prm_i2, 'high', 'consistent', a) returning id into al_ok;
  perform pg_temp.expect('s7.25 setting a consistent alert''s patient_id to a WRONG patient is still refused (23514)',
    pg_temp.state_of(format($q$update public.critical_alerts set patient_id = %L where id = %L$q$, other_pt, al_ok)), '23514');
end
$s7$;

-- --- s8: resolve_patient_guarded ---------------------------------------------------
do $s8$
declare
  old_p uuid; new_p uuid; d uuid;
  r record;
  s0 int;
  fields jsonb := jsonb_build_object('first_name', 'Smoke', 'last_name', 'Lks8', 'birthdate', '1990-01-01',
                                     'email', 'lks8@example.test', 'referral_source', 'family_friends');
begin
  insert into public.patients (drm_id, first_name, last_name, birthdate, email, created_at)
    values ('DRM-LKS8OLD', 'Smoke', 'Lks8', '1990-01-01', 'lks8@example.test', now() - interval '2 days')
    returning id into old_p;
  insert into public.patients (drm_id, first_name, last_name, birthdate, email, created_at)
    values ('DRM-LKS8NEW', 'Smoke', 'Lks8', '1990-01-01', 'lks8@example.test', now() - interval '1 day')
    returning id into new_p;

  s0 := pg_temp.held('ShareLock');
  select * into r from public.resolve_patient_guarded('LKS8@example.test', 'Lks8', '1990-01-01', fields);
  perform pg_temp.expect('s8.1 reuses the OLDEST active candidate', (r.id = old_p and r.reused)::text, 'true');
  perform pg_temp.expect('s8.2 …holding its lifecycle lock (shared)', (pg_temp.held('ShareLock') - s0 >= 1)::text, 'true');
  select * into r from public.resolve_patient_guarded('lks8@example.test', 'LKS8', '1990-01-01', fields);
  perform pg_temp.expect('s8.3 last name matches case-insensitively', (r.id = old_p)::text, 'true');

  perform pg_temp.kill(old_p);
  select * into r from public.resolve_patient_guarded('lks8@example.test', 'Lks8', '1990-01-01', fields);
  perform pg_temp.expect('s8.4 a deleted candidate is skipped', (r.id = new_p)::text, 'true');
  perform pg_temp.kill(new_p);
  select * into r from public.resolve_patient_guarded('lks8@example.test', 'Lks8', '1990-01-01', fields);
  perform pg_temp.expect('s8.5 no active candidate → a FRESH record', (not r.reused and r.id not in (old_p, new_p))::text, 'true');
  perform pg_temp.expect('s8.5b …stamped app.referral_origin = ''patient'' (0170''s trg_patients_referral_origin sees it)',
    (select p.referral_source_origin from public.patients p where p.id = r.id), 'patient');

  perform pg_temp.expect('s8.6 search_path is empty (superset of 0170)',
    (select proconfig::text from pg_proc where oid = 'public.resolve_patient_guarded(text,text,date,jsonb)'::regprocedure),
    '{"search_path=\"\""}');
  perform pg_temp.expect('s8.7 still stamps app.referral_origin (0170 compatibility)',
    (pg_get_functiondef('public.resolve_patient_guarded(text,text,date,jsonb)'::regprocedure) like '%app.referral_origin%')::text, 'true');
  perform pg_temp.expect('s8.8 EXECUTE service_role only',
    (has_function_privilege('service_role', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute'))::text, 'true');
end
$s8$;

-- --- s9: create_visit_encounter ------------------------------------------------------
create function pg_temp.enc_line(id uuid, svc uuid, price numeric, parent uuid, header boolean, status text)
returns jsonb language sql as $f$
  select jsonb_build_object('id', id, 'service_id', svc, 'base_price_php', price, 'discount_kind', null,
    'discount_amount_php', 0, 'final_price_php', price, 'hmo_provider_id', null, 'hmo_approval_date', null,
    'hmo_authorization_no', null, 'receptionist_remarks', null, 'clinic_fee_php', null, 'doctor_pf_php', null,
    'procedure_description', null, 'hmo_approved_amount_php', null, 'parent_id', parent,
    'is_package_header', header, 'status', status);
$f$;
create function pg_temp.enc_visit(total numeric, lines jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('visit', jsonb_build_object('total_php', total, 'notes', null, 'hmo_provider_id', null,
    'hmo_approval_date', null, 'hmo_authorization_no', null, 'attending_physician_id', null, 'is_sample', false),
    'lines', lines);
$f$;
do $grant9$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', f);
  end loop;
end
$grant9$;

do $s9$
declare
  k_rec  constant uuid := 'a1000000-0000-4000-8000-000000000184';
  k_med  constant uuid := 'a2000000-0000-4000-8000-000000000184';
  k_pkg  constant uuid := 'c2000000-0000-4000-8000-000000000184';
  k_lab  constant uuid := 'c0000000-0000-4000-8000-000000000184';
  k_lab2 constant uuid := 'c1000000-0000-4000-8000-000000000184';
  k_con  constant uuid := 'c3000000-0000-4000-8000-000000000184';
  hash   constant text := '$2a$12$' || repeat('a', 53);
  a uuid := pg_temp.mk_patient('S9A');
  pr uuid := pg_temp.mk_patient('S9P');
  d uuid := pg_temp.mk_patient('S9D');
  h uuid := gen_random_uuid();
  g uuid := gen_random_uuid();
  one jsonb; res jsonb; vid uuid; n int;
begin
  one := pg_temp.enc_visit(1900, jsonb_build_array(
    pg_temp.enc_line(h, k_pkg, 1500, null, true, 'in_progress'),
    pg_temp.enc_line(gen_random_uuid(), k_lab, 400, null, false, 'requested'),
    pg_temp.enc_line(gen_random_uuid(), k_lab, 0, h, false, 'requested'),
    pg_temp.enc_line(gen_random_uuid(), k_lab2, 0, h, false, 'requested')));
  res := public.create_visit_encounter(k_rec, a, hash, jsonb_build_array(one), null, '{"ip":"203.0.113.5","user_agent":"smoke"}');
  vid := (res -> 'visits' -> 0 ->> 'id')::uuid;
  perform pg_temp.expect('s9.1 one visit created', jsonb_array_length(res -> 'visits')::text, '1');
  perform pg_temp.expect('s9.2 four bill lines', (select count(*)::text from public.test_requests where visit_id = vid), '4');
  perform pg_temp.expect('s9.3 package header auto-promoted (0040)',
    (select status from public.test_requests where id = h), 'ready_for_release');
  perform pg_temp.expect('s9.4 total and creator recorded',
    (select total_php::text || '|' || created_by::text from public.visits where id = vid), '1900.00|' || k_rec);
  perform pg_temp.expect('s9.5 one PIN row with the given hash',
    (select count(*)::text from public.visit_pins where visit_id = vid and pin_hash = hash), '1');
  perform pg_temp.expect('s9.6 audits: visit.created, visit_pin.issued, package.decomposed(2 components)',
    (select string_agg(action || coalesce(':' || (metadata ->> 'component_count'), ''), ',' order by action collate "C")
       from public.audit_log where patient_id = a and action in ('visit.created', 'visit_pin.issued', 'package.decomposed')),
    'package.decomposed:2,visit.created,visit_pin.issued');
  perform pg_temp.expect('s9.7 visit.created metadata counts order lines, not components',
    (select (metadata ->> 'service_count') || '|' || (metadata ->> 'total_php')
       from public.audit_log where patient_id = a and action = 'visit.created' order by created_at limit 1), '2|1900.00');

  -- Split encounter + pre-registered patient.
  update public.patients set pre_registered = true where id = pr;
  res := public.create_visit_encounter(k_rec, pr, hash, jsonb_build_array(
    pg_temp.enc_visit(500, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_con, 500, null, false, 'requested'))),
    pg_temp.enc_visit(400, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_lab, 400, null, false, 'requested')))),
    g, null);
  perform pg_temp.expect('s9.8 split: two visits share the group id',
    (select count(*)::text from public.visits where visit_group_id = g), '2');
  perform pg_temp.expect('s9.9 split: both carry the same PIN hash',
    (select count(distinct pin_hash)::text || '|' || count(*)::text from public.visit_pins vp
       join public.visits v on v.id = vp.visit_id where v.visit_group_id = g), '1|2');
  perform pg_temp.expect('s9.10 identity verified: pre_registered cleared + audited',
    (select (not pre_registered)::text from public.patients where id = pr)
      || '|' || (select count(*)::text from public.audit_log where patient_id = pr and action = 'patient.identity_verified')
      || '|' || (res ->> 'identity_verified'), 'true|1|true');

  -- Refusals write nothing.
  perform pg_temp.kill(d);
  n := (select count(*) from public.visits where patient_id = d);
  perform pg_temp.expect('s9.11 deleted patient refused',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$, k_rec, d, hash, one)), 'P0058');
  perform pg_temp.expect('s9.12 …and nothing was written', (select count(*) from public.visits where patient_id = d)::text, n::text);
  perform pg_temp.expect('s9.13 total that does not match the lines',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$,
      k_rec, a, hash, jsonb_set(one, '{visit,total_php}', '1'))), 'P0073');
  perform pg_temp.expect('s9.14 a medtech cannot start a visit',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$, k_med, a, hash, one)), 'P0073');
  perform pg_temp.expect('s9.15 component whose header is not in the payload',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$,
      k_rec, a, hash, pg_temp.enc_visit(0, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_lab, 0, gen_random_uuid(), false, 'requested'))))), 'P0073');
  perform pg_temp.expect('s9.16 two visits without a group id',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb, %L::jsonb))$q$, k_rec, a, hash, one, one)), 'P0073');
  perform pg_temp.expect('s9.17 an unhashed PIN',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, 'ABCD2345', jsonb_build_array(%L::jsonb))$q$, k_rec, a, one)), 'P0073');
  n := (select count(*) from public.visits where patient_id = a);
  perform pg_temp.expect('s9.18 a failing SECOND visit leaves no first visit behind (atomic)',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb, %L::jsonb), %L)$q$,
      k_rec, a, hash,
      pg_temp.enc_visit(400, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_lab, 400, null, false, 'requested'))),
      pg_temp.enc_visit(400, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), gen_random_uuid(), 400, null, false, 'requested'))),
      gen_random_uuid())), '23503');
  perform pg_temp.expect('s9.19 …visit count unchanged', (select count(*) from public.visits where patient_id = a)::text, n::text);
  -- Centavo normalisation (Codex plan review P2-4): the app sums JS floats.
  n := (select count(*) from public.visits where patient_id = a);
  res := public.create_visit_encounter(k_rec, a, hash, jsonb_build_array(
    pg_temp.enc_visit(300.29999999999995, jsonb_build_array(
      pg_temp.enc_line(gen_random_uuid(), k_lab, 100.10, null, false, 'requested'),
      pg_temp.enc_line(gen_random_uuid(), k_lab2, 200.20, null, false, 'requested')))), null, null);
  vid := (res -> 'visits' -> 0 ->> 'id')::uuid;
  perform pg_temp.expect('s9.21 100.10 + 200.20 sent as the JS float 300.29999999999995 is accepted, stored 300.30',
    (select total_php::text from public.visits where id = vid), '300.30');
  res := public.create_visit_encounter(k_rec, a, hash, jsonb_build_array(
    pg_temp.enc_visit(79.99000000000001, jsonb_build_array(
      jsonb_set(jsonb_set(pg_temp.enc_line(gen_random_uuid(), k_lab, 79.99000000000001, null, false, 'requested'),
                          '{base_price_php}', '99.99'), '{discount_amount_php}', '20')))), null, null);
  vid := (res -> 'visits' -> 0 ->> 'id')::uuid;
  perform pg_temp.expect('s9.22 a discounted line whose float final is 79.99000000000001 is stored 79.99',
    (select total_php::text || '|' || (select final_price_php::text from public.test_requests where visit_id = vid)
       from public.visits where id = vid), '79.99|79.99');
  res := public.create_visit_encounter(k_rec, a, hash, jsonb_build_array(
    pg_temp.enc_visit(0.30000000000000004, jsonb_build_array(
      pg_temp.enc_line(gen_random_uuid(), k_con, 0.1, null, false, 'requested'),
      pg_temp.enc_line(gen_random_uuid(), k_con, 0.2, null, false, 'requested'))),
    pg_temp.enc_visit(100.1, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_lab, 100.1, null, false, 'requested')))),
    gen_random_uuid(), null);
  perform pg_temp.expect('s9.23 a split encounter with fractional totals on both halves',
    (select string_agg(total_php::text, ',' order by total_php) from public.visits
      where id in (select (x ->> 'id')::uuid from jsonb_array_elements(res -> 'visits') x)), '0.30,100.10');
  perform pg_temp.expect('s9.24 a real one-centavo mismatch is still refused',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$, k_rec, a, hash,
      pg_temp.enc_visit(300.31, jsonb_build_array(
        pg_temp.enc_line(gen_random_uuid(), k_lab, 100.10, null, false, 'requested'),
        pg_temp.enc_line(gen_random_uuid(), k_lab2, 200.20, null, false, 'requested'))))), 'P0073');
  perform pg_temp.expect('s9.25 …three encounters, four visits written',
    ((select count(*) from public.visits where patient_id = a) - n)::text, '4');

  perform pg_temp.expect('s9.20 EXECUTE service_role only',
    (has_function_privilege('service_role', 'public.create_visit_encounter(uuid,uuid,text,jsonb,uuid,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.create_visit_encounter(uuid,uuid,text,jsonb,uuid,jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.create_visit_encounter(uuid,uuid,text,jsonb,uuid,jsonb)', 'execute'))::text, 'true');
end
$s9$;

-- --- s10: result_create_linked ---------------------------------------------------------
do $s10$
declare
  k_med constant uuid := 'a2000000-0000-4000-8000-000000000184';
  k_rec constant uuid := 'a1000000-0000-4000-8000-000000000184';
  a uuid := pg_temp.mk_patient('S10A');
  b uuid := pg_temp.mk_patient('S10B');
  d uuid := pg_temp.mk_patient('S10D');
  va uuid; vb uuid; vd uuid; t1 uuid; t2 uuid; t3 uuid; t4 uuid; tb uuid; td uuid; tdel uuid;
  r uuid; n int;
begin
  va := pg_temp.mk_visit(a);
  vd := pg_temp.mk_visit(d);
  t1 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  t2 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  t3 := pg_temp.mk_line(va, 'in_progress', 100);
  t4 := pg_temp.mk_line(va, 'in_progress', 100);
  tdel := pg_temp.mk_line(va, 'in_progress', 100);
  update public.test_requests set deleted_at = now(), deleted_by = k_med, delete_reason = 'smoke' where id = tdel;
  td := pg_temp.mk_line(vd, 'in_progress', 100);
  vb := pg_temp.mk_visit(b);
  tb := pg_temp.mk_line(vb, 'in_progress', 100);
  perform pg_temp.kill(d);

  r := public.result_create_linked(k_med, array[t1, t2], 'structured', null, null, null, null);
  perform pg_temp.expect('s10.1 structured draft linked to both tests',
    (select count(*)::text from public.result_test_requests where result_id = r), '2');
  perform pg_temp.expect('s10.2 …not finalised, tests not advanced',
    (select (finalised_at is null)::text from public.results where id = r)
      || '|' || (select string_agg(distinct status, ',') from public.test_requests where id in (t1, t2)), 'true|in_progress');
  r := public.result_create_linked(k_med, array[t3], 'uploaded', null, 'p/v/t3/attempt-1.pdf', 1234, '  note  ');
  perform pg_temp.expect('s10.3 uploaded result: path, size, trimmed note',
    (select storage_path || '|' || file_size_bytes || '|' || notes from public.results where id = r), 'p/v/t3/attempt-1.pdf|1234|note');
  perform pg_temp.expect('s10.4 …and the link advanced the test (0059 trigger)',
    (select (status <> 'in_progress')::text from public.test_requests where id = t3), 'true');

  n := (select count(*) from public.results);
  perform pg_temp.expect('s10.5 a test that already has a result',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'uploaded', null, 'x.pdf', 1, null)$q$, k_med, t3)), 'P0066');
  perform pg_temp.expect('s10.6 deleted patient''s test',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'uploaded', null, 'x.pdf', 1, null)$q$, k_med, td)), 'P0058');
  perform pg_temp.expect('s10.7 an active and a deleted patient''s test together',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L, %L]::uuid[], 'structured', null, null, null, null)$q$, k_med, t4, td)), 'P0058');
  perform pg_temp.expect('s10.8 a soft-deleted test',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'structured', null, null, null, null)$q$, k_med, tdel)), 'P0066');
  perform pg_temp.expect('s10.9 an uploaded result without a file',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'uploaded', null, null, null, null)$q$, k_med, t4)), '22023');
  perform pg_temp.expect('s10.10 a test listed twice',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L, %L]::uuid[], 'structured', null, null, null, null)$q$, k_med, t4, t4)), '22023');
  perform pg_temp.expect('s10.11 reception cannot create results',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'structured', null, null, null, null)$q$, k_rec, t4)), '42501');
  perform pg_temp.expect('s10.11b two ACTIVE patients'' tests in one result',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L, %L]::uuid[], 'structured', null, null, null, null)$q$, k_med, t4, tb)), '23514');
  perform pg_temp.expect('s10.12 no results row was left by any refusal',
    (select count(*) from public.results)::text, n::text);
  perform pg_temp.expect('s10.13 EXECUTE service_role only',
    (has_function_privilege('service_role', 'public.result_create_linked(uuid,uuid[],text,uuid,text,integer,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.result_create_linked(uuid,uuid[],text,uuid,text,integer,text)', 'execute'))::text, 'true');
end
$s10$;

rollback;

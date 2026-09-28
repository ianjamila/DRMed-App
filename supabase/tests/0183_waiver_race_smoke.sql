-- =============================================================================
-- 0183_waiver_race_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Opens extra connections through dblink as supabase_admin to run
-- genuine two-session races against 0183 (waive_visit_balance / the release,
-- undo-release and payment guards it adds). Run with:
--
--   psql "$ADMIN" -v ON_ERROR_STOP=1 -f supabase/tests/0183_waiver_race_smoke.sql
--
-- where ADMIN points at the LOCAL stack as supabase_admin (superuser — the
-- postgres role is NOT a superuser on this image and dblink_connect refuses
-- it). Never point this at a hosted project: the first statement refuses to
-- run anywhere inet_server_addr() isn't a local/private address.
--
-- This does NOT run inside BEGIN/ROLLBACK — dblink workers are separate
-- backends and need their own commits to make rows visible to each other, so
-- the whole thing tears itself down explicitly at the end (and from the
-- exception handler on any failure) via direct DELETEs issued through the
-- 's0' connection under session_replication_role = replica. Every seeded row
-- is tagged '0183-race' so leftovers are findable.
--
-- Scenarios (serialization-protocol.md, Task 7):
--   1  payment-then-waive:  a concurrent payment insert wins the visit lock;
--      the waiver reads paid_php AFTER it commits.
--   2  waive-then-payment:  a concurrent waive wins the visit lock first; the
--      payment insert reads payment_status = 'waived' after it commits and
--      is refused (P0070).
--   3  undo-then-waive: an undo-release wins the line lock first; the waiver
--      reads the line's FINAL status (ready_for_release, not released) and
--      leaves the allocation unrecognised — no standalone JE.
--   4  waive-then-undo: the waiver wins the line lock first and posts a
--      standalone JE; the undo, running after, reverses it through
--      waiver_unrecognise_line.
--   5  forced package-cascade deadlock [CR-17]: the waiver (visit -> header
--      -> component, in id order) and an undo-release cascade (component ->
--      header) lock in opposite order on purpose (explicit ids so the header
--      sorts first). Postgres detects the cycle and aborts exactly one side
--      with SQLSTATE 40P01; re-running the loser's own operation afterwards
--      converges on the same end state either way.
-- =============================================================================

-- ---- Precondition: local stack only -----------------------------------------
do $$
declare v_addr text := host(inet_server_addr());
begin
  if v_addr !~ '^(127\.|172\.|192\.168\.|10\.)' then
    raise exception
      'refusing: inet_server_addr() = % is not a local/private address. '
      'This test opens raw superuser dblink connections and must never run against a hosted project.',
      v_addr;
  end if;
end
$$;

create extension if not exists dblink;

-- ---- Helpers (pg_temp: vanish with the session) -----------------------------

-- Strict wait: raises unless the given backend pid is observed waiting on a
-- Lock within ~5s. pg_stat_activity is a per-transaction snapshot, so it must
-- be cleared on every iteration or it would never change.
create or replace function pg_temp.wait_for_lock(p_pid int, p_label text) returns void
language plpgsql as $f$
declare i int;
begin
  for i in 1..20 loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where pid = p_pid and wait_event_type = 'Lock') then
      return;
    end if;
    perform pg_sleep(0.25);
  end loop;
  raise exception 'FAIL %: worker never waited on the lock', p_label;
end
$f$;

-- Lenient wait for scenario 5: once BOTH sides have sent a query, Postgres's
-- own deadlock detector (deadlock_timeout, 1s locally) resolves the cycle on
-- its own, so by the time we poll one side may already be done. Loop until
-- either connection is no longer busy, requiring that at least one side was
-- actually observed waiting on a Lock along the way (proof the cycle formed).
create or replace function pg_temp.wait_for_deadlock(p_c1 text, p_pid1 int, p_c2 text, p_pid2 int) returns void
language plpgsql as $f$
declare
  i int;
  seen1 boolean := false;
  seen2 boolean := false;
begin
  for i in 1..40 loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where pid = p_pid1 and wait_event_type = 'Lock') then seen1 := true; end if;
    if exists (select 1 from pg_stat_activity where pid = p_pid2 and wait_event_type = 'Lock') then seen2 := true; end if;
    if dblink_is_busy(p_c1) = 0 or dblink_is_busy(p_c2) = 0 then
      if not (seen1 or seen2) then
        raise exception 'FAIL 5: neither side was observed waiting on a lock before resolution';
      end if;
      return;
    end if;
    perform pg_sleep(0.25);
  end loop;
  raise exception 'FAIL 5: deadlock never resolved within the timeout (both sides still busy)';
end
$f$;

-- Drain BOTH dblink_get_result calls unconditionally (the result, then the
-- end-of-results marker) regardless of whether the first one raises — a
-- caught exception on the first call must never skip the second, or the
-- connection is left with a pending result and the NEXT dblink_send_query on
-- it fails with "another command is already in progress". Returns the
-- SQLSTATE of whichever call errored (first one wins), or NULL on success.
create or replace function pg_temp.drain2(p_conn text) returns text
language plpgsql as $f$
declare
  v_state text;
begin
  begin
    perform x from dblink_get_result(p_conn) as t(x text);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  begin
    perform x from dblink_get_result(p_conn) as t(x text);
  exception when others then
    if v_state is null then
      get stacked diagnostics v_state = returned_sqlstate;
    end if;
  end;
  return v_state;
end
$f$;

-- Drain an async call expected to SUCCEED.
create or replace function pg_temp.drain_ok(p_conn text, p_label text) returns void
language plpgsql as $f$
declare v_state text;
begin
  v_state := pg_temp.drain2(p_conn);
  if v_state is not null then
    raise exception 'FAIL %: expected success, got %', p_label, v_state;
  end if;
end
$f$;

-- Drain an async call expected to FAIL with a specific SQLSTATE.
create or replace function pg_temp.drain_expect_error(p_conn text, p_expected text, p_label text) returns void
language plpgsql as $f$
declare v_state text;
begin
  v_state := pg_temp.drain2(p_conn);
  if v_state is null then
    raise exception 'FAIL %: expected % but the call succeeded', p_label, p_expected;
  end if;
  if v_state is distinct from p_expected then
    raise exception 'FAIL %: expected % got %', p_label, p_expected, v_state;
  end if;
end
$f$;

-- Teardown: everything this file could have created, via s0, RI/guard
-- triggers off. Safe to call from the success path or from the exception
-- handler; every statement is independently best-effort-ordered (FK-child
-- first) so a partial run still cleans up as much as possible.
create or replace function pg_temp.teardown(
  p_visits   uuid[],
  p_lines    uuid[],
  p_payments uuid[],
  p_patients uuid[],
  p_services uuid[],
  p_staff    uuid[],
  p_users    uuid[]
) returns void language plpgsql as $f$
declare
  v_cte text;
begin
  -- Best-effort: neither worker should still be mid-transaction, but if a
  -- failure happened before a commit/rollback, clear that first so s0's
  -- deletes below don't hang waiting on a lock nobody will ever release.
  -- Cancel any still-in-flight query FIRST (e.g. scenario 5's
  -- wait_for_deadlock timed out with both workers still blocked
  -- server-side) — a `rollback` sent to a connection that is still busy
  -- processing an earlier async query errors with "another command is
  -- already in progress" without ever reaching the server, so the worker
  -- keeps its locks and s0's deletes below would hang indefinitely.
  begin perform dblink_cancel_query('s1'); exception when others then null; end;
  begin perform dblink_cancel_query('s2'); exception when others then null; end;
  begin perform dblink_exec('s1', 'rollback'); exception when others then null; end;
  begin perform dblink_exec('s2', 'rollback'); exception when others then null; end;

  perform dblink_exec('s0', 'set session_replication_role = replica');

  v_cte := format($cte$
    with recursive fixture_je as (
      select id from public.journal_entries
       where (source_kind = 'payment' and source_id = any(%L::uuid[]))
          or (source_kind = 'test_request' and source_id = any(%L::uuid[]))
          or (source_kind = 'visit_waiver' and source_id in
              (select id from public.visit_waiver_allocations where visit_id = any(%L::uuid[])))
      union
      select je.id from public.journal_entries je join fixture_je f on je.reverses = f.id
    )
  $cte$, p_payments, p_lines, p_visits);

  perform dblink_exec('s0', v_cte || 'delete from public.journal_lines where entry_id in (select id from fixture_je)');
  perform dblink_exec('s0', v_cte || 'delete from public.journal_entries where id in (select id from fixture_je)');

  perform dblink_exec('s0', format('delete from public.doctor_pf_entries where test_request_id = any(%L::uuid[])', p_lines));
  perform dblink_exec('s0', format('delete from public.visit_waiver_allocations where visit_id = any(%L::uuid[])', p_visits));
  perform dblink_exec('s0', format('delete from public.payments where id = any(%L::uuid[])', p_payments));
  perform dblink_exec('s0', format('delete from public.test_requests where id = any(%L::uuid[])', p_lines));
  perform dblink_exec('s0', format('delete from public.visits where id = any(%L::uuid[])', p_visits));
  perform dblink_exec('s0', format('delete from public.patients where id = any(%L::uuid[])', p_patients));
  perform dblink_exec('s0', format('delete from public.services where id = any(%L::uuid[])', p_services));
  perform dblink_exec('s0', format('delete from public.staff_profiles where id = any(%L::uuid[])', p_staff));
  perform dblink_exec('s0', format('delete from auth.users where id = any(%L::uuid[])', p_users));

  perform dblink_exec('s0', 'set session_replication_role = default');

  -- Verify: no fixture rows survive, in any of the tables touched above.
  if (select count(*) from dblink('s0', format('select 1 from public.visits where id = any(%L::uuid[])', p_visits)) as t(x int)) > 0
    or (select count(*) from dblink('s0', format('select 1 from public.test_requests where id = any(%L::uuid[])', p_lines)) as t(x int)) > 0
    or (select count(*) from dblink('s0', format('select 1 from public.payments where id = any(%L::uuid[])', p_payments)) as t(x int)) > 0
    or (select count(*) from dblink('s0', format('select 1 from public.patients where id = any(%L::uuid[])', p_patients)) as t(x int)) > 0
    or (select count(*) from dblink('s0', format('select 1 from public.services where id = any(%L::uuid[])', p_services)) as t(x int)) > 0
    or (select count(*) from dblink('s0', format('select 1 from public.staff_profiles where id = any(%L::uuid[])', p_staff)) as t(x int)) > 0
    or (select count(*) from dblink('s0', format('select 1 from auth.users where id = any(%L::uuid[])', p_users)) as t(x int)) > 0
    or (select count(*) from dblink('s0', format('select 1 from public.visit_waiver_allocations where visit_id = any(%L::uuid[])', p_visits)) as t(x int)) > 0
    or (select count(*) from dblink('s0', $q$select 1 from public.journal_entries where description like '%0183-race%'$q$) as t(x int)) > 0
  then
    raise exception 'FAIL teardown: fixture rows are still present after cleanup';
  end if;
end
$f$;

-- =============================================================================
-- Main
-- =============================================================================
do $race$
declare
  c text := 'dbname=postgres user=supabase_admin password=postgres host=localhost port=5432';

  -- Fixture ids
  v_admin    uuid := gen_random_uuid();
  v_svc_lab  uuid := gen_random_uuid();
  v_svc_pkg  uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid(); v_p2 uuid := gen_random_uuid(); v_p3 uuid := gen_random_uuid();
  v_p4 uuid := gen_random_uuid(); v_p5 uuid := gen_random_uuid();
  v_v1 uuid := gen_random_uuid(); v_v2 uuid := gen_random_uuid(); v_v3 uuid := gen_random_uuid();
  v_v4 uuid := gen_random_uuid(); v_v5 uuid := gen_random_uuid();
  v_l1 uuid := gen_random_uuid(); v_l2 uuid := gen_random_uuid(); v_l3 uuid := gen_random_uuid();
  v_l4 uuid := gen_random_uuid();
  -- Scenario 5: explicit ids so the header sorts first in `order by id`.
  v_h5 uuid := '00000000-0000-4000-8000-000000000001';
  v_c1 uuid := '00000000-0000-4000-8000-000000000002';
  v_c2 uuid := '00000000-0000-4000-8000-000000000003';
  v_pay1 uuid := gen_random_uuid();
  v_pay3 uuid := gen_random_uuid();
  v_pay4 uuid := gen_random_uuid();
  v_pay5 uuid := gen_random_uuid();

  v_visits_arr   uuid[] := array[v_v1, v_v2, v_v3, v_v4, v_v5];
  v_lines_arr    uuid[] := array[v_l1, v_l2, v_l3, v_l4, v_h5, v_c1, v_c2];
  v_payments_arr uuid[] := array[v_pay1, v_pay3, v_pay4, v_pay5];
  v_patients_arr uuid[] := array[v_p1, v_p2, v_p3, v_p4, v_p5];
  v_services_arr uuid[] := array[v_svc_lab, v_svc_pkg];
  v_staff_arr    uuid[] := array[v_admin];
  v_users_arr    uuid[] := array[v_admin];

  v_pid_s1 int;
  v_pid_s2 int;

  v_alloc_before bigint;
  v_je_before    bigint;
  v_alloc_after  bigint;
  v_je_after     bigint;

  -- scenario 5 locals
  v_s1_err boolean;
  v_s2_err boolean;
  v_s1_state text;
  v_s2_state text;
  v_loser text;
  v_wje uuid;
  v_wstatus text;
  v_wrev_status text;
  v_orig_je uuid;
  v_orig_status text;
  v_rev_status text;
  v_net numeric;
begin
  -- ---- before counts, connect ------------------------------------------------
  select count(*) into v_alloc_before from public.visit_waiver_allocations;
  select count(*) into v_je_before    from public.journal_entries;

  perform dblink_connect('s0', c);
  perform dblink_connect('s1', c);
  perform dblink_connect('s2', c);
  select x into v_pid_s1 from dblink('s1', 'select pg_backend_pid()') as t(x int);
  select x into v_pid_s2 from dblink('s2', 'select pg_backend_pid()') as t(x int);

  -- ---- seed (committed, via s0) ----------------------------------------------
  perform dblink_exec('s0', format(
    $sql$insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
         values (%L, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', %L, '', now(), now(), now())$sql$,
    v_admin, '0183-race-admin@example.test'));

  perform dblink_exec('s0', format(
    $sql$insert into public.staff_profiles (id, full_name, role, is_active) values (%L, %L, 'admin', true)$sql$,
    v_admin, '0183-race Admin'));

  perform dblink_exec('s0', format(
    $sql$insert into public.services (id, code, name, price_php, kind) values (%L, %L, %L, 1000, 'lab_test')$sql$,
    v_svc_lab, '0183-RACE-LAB', '0183-race lab test'));
  perform dblink_exec('s0', format(
    $sql$insert into public.services (id, code, name, price_php, kind) values (%L, %L, %L, 5888, 'lab_package')$sql$,
    v_svc_pkg, '0183-RACE-PKG', '0183-race package'));

  perform dblink_exec('s0', format(
    $sql$insert into public.patients (id, drm_id, first_name, last_name, birthdate) values (%L, %L, '0183-race', %L, '1990-01-01')$sql$,
    v_p1, 'DRM-0183RACE1', 'Scenario1'));
  perform dblink_exec('s0', format(
    $sql$insert into public.patients (id, drm_id, first_name, last_name, birthdate) values (%L, %L, '0183-race', %L, '1990-01-01')$sql$,
    v_p2, 'DRM-0183RACE2', 'Scenario2'));
  perform dblink_exec('s0', format(
    $sql$insert into public.patients (id, drm_id, first_name, last_name, birthdate) values (%L, %L, '0183-race', %L, '1990-01-01')$sql$,
    v_p3, 'DRM-0183RACE3', 'Scenario3'));
  perform dblink_exec('s0', format(
    $sql$insert into public.patients (id, drm_id, first_name, last_name, birthdate) values (%L, %L, '0183-race', %L, '1990-01-01')$sql$,
    v_p4, 'DRM-0183RACE4', 'Scenario4'));
  perform dblink_exec('s0', format(
    $sql$insert into public.patients (id, drm_id, first_name, last_name, birthdate) values (%L, %L, '0183-race', %L, '1990-01-01')$sql$,
    v_p5, 'DRM-0183RACE5', 'Scenario5'));

  perform dblink_exec('s0', format(
    $sql$insert into public.visits (id, visit_number, patient_id, payment_status, total_php, paid_php, notes)
         values (%L, %L, %L, 'unpaid', 1000, 0, '0183-race scenario 1')$sql$, v_v1, 'V-0183RACE-1', v_p1));
  perform dblink_exec('s0', format(
    $sql$insert into public.visits (id, visit_number, patient_id, payment_status, total_php, paid_php, notes)
         values (%L, %L, %L, 'unpaid', 1000, 0, '0183-race scenario 2')$sql$, v_v2, 'V-0183RACE-2', v_p2));
  perform dblink_exec('s0', format(
    $sql$insert into public.visits (id, visit_number, patient_id, payment_status, total_php, paid_php, notes)
         values (%L, %L, %L, 'unpaid', 1000, 0, '0183-race scenario 3')$sql$, v_v3, 'V-0183RACE-3', v_p3));
  perform dblink_exec('s0', format(
    $sql$insert into public.visits (id, visit_number, patient_id, payment_status, total_php, paid_php, notes)
         values (%L, %L, %L, 'unpaid', 1000, 0, '0183-race scenario 4')$sql$, v_v4, 'V-0183RACE-4', v_p4));
  perform dblink_exec('s0', format(
    $sql$insert into public.visits (id, visit_number, patient_id, payment_status, total_php, paid_php, notes)
         values (%L, %L, %L, 'unpaid', 5888, 0, '0183-race scenario 5')$sql$, v_v5, 'V-0183RACE-5', v_p5));

  perform dblink_exec('s0', format(
    $sql$insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php)
         values (%L, %L, %L, 'requested', %L, 1000, 1000)$sql$, v_l1, v_v1, v_svc_lab, v_admin));
  perform dblink_exec('s0', format(
    $sql$insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php)
         values (%L, %L, %L, 'requested', %L, 1000, 1000)$sql$, v_l2, v_v2, v_svc_lab, v_admin));
  perform dblink_exec('s0', format(
    $sql$insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php)
         values (%L, %L, %L, 'requested', %L, 1000, 1000)$sql$, v_l3, v_v3, v_svc_lab, v_admin));
  perform dblink_exec('s0', format(
    $sql$insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php)
         values (%L, %L, %L, 'requested', %L, 1000, 1000)$sql$, v_l4, v_v4, v_svc_lab, v_admin));

  perform dblink_exec('s0', format(
    $sql$insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php, is_package_header)
         values (%L, %L, %L, 'ready_for_release', %L, 5888, 5888, true)$sql$, v_h5, v_v5, v_svc_pkg, v_admin));
  perform dblink_exec('s0', format(
    $sql$insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php, parent_id)
         values (%L, %L, %L, 'in_progress', %L, 0, 0, %L)$sql$, v_c1, v_v5, v_svc_lab, v_admin, v_h5));
  perform dblink_exec('s0', format(
    $sql$insert into public.test_requests (id, visit_id, service_id, status, requested_by, base_price_php, final_price_php, parent_id)
         values (%L, %L, %L, 'in_progress', %L, 0, 0, %L)$sql$, v_c2, v_v5, v_svc_lab, v_admin, v_h5));

  -- ---- prep: scenario 3 (pay -> release -> void, JE stays posted) -----------
  perform dblink_exec('s0', format(
    $sql$insert into public.payments (id, visit_id, amount_php, method, received_by, received_at) values (%L, %L, 1000, 'cash', %L, now())$sql$,
    v_pay3, v_v3, v_admin));
  perform dblink_exec('s0', format(
    $sql$update public.test_requests set status = 'released', released_at = now(), released_by = %L where id = %L$sql$, v_admin, v_l3));
  perform dblink_exec('s0', format(
    $sql$update public.payments set voided_at = now(), voided_by = %L, void_reason = '0183-race prep void' where id = %L$sql$, v_admin, v_pay3));

  -- ---- prep: scenario 4 (same shape) ------------------------------------------
  perform dblink_exec('s0', format(
    $sql$insert into public.payments (id, visit_id, amount_php, method, received_by, received_at) values (%L, %L, 1000, 'cash', %L, now())$sql$,
    v_pay4, v_v4, v_admin));
  perform dblink_exec('s0', format(
    $sql$update public.test_requests set status = 'released', released_at = now(), released_by = %L where id = %L$sql$, v_admin, v_l4));
  perform dblink_exec('s0', format(
    $sql$update public.payments set voided_at = now(), voided_by = %L, void_reason = '0183-race prep void' where id = %L$sql$, v_admin, v_pay4));

  -- ---- prep: scenario 5 (pay, release both components, header auto-releases,
  --      void payment) ---------------------------------------------------------
  perform dblink_exec('s0', format(
    $sql$insert into public.payments (id, visit_id, amount_php, method, received_by, received_at) values (%L, %L, 5888, 'cash', %L, now())$sql$,
    v_pay5, v_v5, v_admin));
  perform dblink_exec('s0', format(
    $sql$update public.test_requests set status = 'released', released_at = now(), released_by = %L where id = %L$sql$, v_admin, v_c1));
  perform dblink_exec('s0', format(
    $sql$update public.test_requests set status = 'released', released_at = now(), released_by = %L where id = %L$sql$, v_admin, v_c2));
  if not exists (select 1 from public.test_requests where id = v_h5 and status = 'released') then
    raise exception 'FAIL prep: package header did not auto-release (0109)';
  end if;
  perform dblink_exec('s0', format(
    $sql$update public.payments set voided_at = now(), voided_by = %L, void_reason = '0183-race prep void' where id = %L$sql$, v_admin, v_pay5));

  -- =====================================================================
  -- Scenario 1: payment-then-waive
  -- =====================================================================
  perform dblink_exec('s1', 'begin');
  perform dblink_exec('s1', format(
    $sql$insert into public.payments (id, visit_id, amount_php, method, received_by, received_at) values (%L, %L, 400, 'cash', %L, now())$sql$,
    v_pay1, v_v1, v_admin));

  perform dblink_send_query('s2', format(
    $sql$select public.waive_visit_balance(%L, %L, %L)$sql$, v_v1, v_admin, '0183-race scenario 1'));
  perform pg_temp.wait_for_lock(v_pid_s2, '1');

  perform dblink_exec('s1', 'commit');
  perform pg_temp.drain_ok('s2', '1');

  if not exists (select 1 from public.visits where id = v_v1 and payment_status = 'waived' and waived_php = 600) then
    raise exception 'FAIL 1: visit not waived at 600 as expected';
  end if;
  if (select coalesce(sum(amount_php), 0) from public.visit_waiver_allocations where visit_id = v_v1) <> 600 then
    raise exception 'FAIL 1: allocation sum is not 600';
  end if;
  raise notice 'PASS 1';

  -- =====================================================================
  -- Scenario 2: waive-then-payment
  -- =====================================================================
  perform dblink_exec('s1', 'begin');
  perform x from dblink('s1', format($sql$select public.waive_visit_balance(%L, %L, %L)$sql$, v_v2, v_admin, '0183-race scenario 2')) as t(x text);

  perform dblink_send_query('s2', format(
    $sql$insert into public.payments (visit_id, amount_php, method, received_by, received_at) values (%L, 400, 'cash', %L, now())$sql$,
    v_v2, v_admin));
  perform pg_temp.wait_for_lock(v_pid_s2, '2');

  perform dblink_exec('s1', 'commit');
  perform pg_temp.drain_expect_error('s2', 'P0070', '2');

  if exists (select 1 from public.payments where visit_id = v_v2 and amount_php = 400) then
    raise exception 'FAIL 2: a payment row was created despite the waive';
  end if;
  raise notice 'PASS 2';

  -- =====================================================================
  -- Scenario 3: undo-then-waive
  -- =====================================================================
  perform dblink_exec('s1', 'begin');
  perform dblink_exec('s1', format(
    $sql$update public.test_requests set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null where id = %L$sql$,
    v_l3));

  perform dblink_send_query('s2', format(
    $sql$select public.waive_visit_balance(%L, %L, %L)$sql$, v_v3, v_admin, '0183-race scenario 3'));
  perform pg_temp.wait_for_lock(v_pid_s2, '3');

  perform dblink_exec('s1', 'commit');
  perform pg_temp.drain_ok('s2', '3');

  if not exists (select 1 from public.visit_waiver_allocations where test_request_id = v_l3) then
    raise exception 'FAIL 3: no allocation row created for the line';
  end if;
  if exists (select 1 from public.visit_waiver_allocations where test_request_id = v_l3 and recognised_at is not null) then
    raise exception 'FAIL 3: allocation was recognised (should be pending, folded at the next release)';
  end if;
  if exists (
    select 1 from public.journal_entries
     where source_kind = 'visit_waiver'
       and source_id in (select id from public.visit_waiver_allocations where test_request_id = v_l3)
  ) then
    raise exception 'FAIL 3: a visit_waiver JE was posted (the waiver should have read ready_for_release, not released)';
  end if;
  raise notice 'PASS 3';

  -- =====================================================================
  -- Scenario 4: waive-then-undo
  -- =====================================================================
  perform dblink_exec('s1', 'begin');
  perform x from dblink('s1', format($sql$select public.waive_visit_balance(%L, %L, %L)$sql$, v_v4, v_admin, '0183-race scenario 4')) as t(x text);

  perform dblink_send_query('s2', format(
    $sql$update public.test_requests set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null where id = %L$sql$,
    v_l4));
  perform pg_temp.wait_for_lock(v_pid_s2, '4');

  perform dblink_exec('s1', 'commit');
  perform pg_temp.drain_ok('s2', '4');

  select id, status into v_orig_je, v_orig_status
    from public.journal_entries
   where source_kind = 'visit_waiver'
     and source_id = (select id from public.visit_waiver_allocations where test_request_id = v_l4);
  if v_orig_je is null or v_orig_status <> 'reversed' then
    raise exception 'FAIL 4: expected the standalone waiver JE to be reversed, got %', v_orig_status;
  end if;
  select status into v_rev_status from public.journal_entries where reverses = v_orig_je;
  if v_rev_status is distinct from 'posted' then
    raise exception 'FAIL 4: mirrored reversal is not posted (got %)', v_rev_status;
  end if;
  if exists (select 1 from public.visit_waiver_allocations where test_request_id = v_l4 and recognised_at is not null) then
    raise exception 'FAIL 4: allocation still recognised after the undo';
  end if;
  raise notice 'PASS 4';

  -- =====================================================================
  -- Scenario 5: forced package-cascade deadlock [CR-17]
  -- =====================================================================
  perform dblink_exec('s1', 'begin');
  perform x from dblink('s1', format($sql$select 1 from public.test_requests where id = %L for update$sql$, v_c1)) as t(x int);

  perform dblink_send_query('s2', format(
    $sql$select public.waive_visit_balance(%L, %L, %L)$sql$, v_v5, v_admin, '0183-race scenario 5'));
  perform pg_temp.wait_for_lock(v_pid_s2, '5a');

  perform dblink_send_query('s1', format(
    $sql$update public.test_requests set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null where id = %L$sql$,
    v_c1));

  perform pg_temp.wait_for_deadlock('s1', v_pid_s1, 's2', v_pid_s2);

  v_s1_state := pg_temp.drain2('s1');
  v_s2_state := pg_temp.drain2('s2');
  v_s1_err := v_s1_state is not null;
  v_s2_err := v_s2_state is not null;

  if v_s1_err and v_s2_err then
    raise exception 'FAIL 5: both sides errored (s1=%, s2=%)', v_s1_state, v_s2_state;
  end if;
  if not v_s1_err and not v_s2_err then
    raise exception 'FAIL 5: neither side errored — expected a deadlock';
  end if;
  if v_s1_err and v_s1_state is distinct from '40P01' then
    raise exception 'FAIL 5: s1 failed with % (expected 40P01)', v_s1_state;
  end if;
  if v_s2_err and v_s2_state is distinct from '40P01' then
    raise exception 'FAIL 5: s2 failed with % (expected 40P01)', v_s2_state;
  end if;

  if v_s1_err then
    v_loser := 's1';
    perform dblink_exec('s1', 'rollback');
    perform dblink_exec('s2', 'commit');
    -- Re-run the loser's own operation standalone.
    perform dblink_exec('s1', format(
      $sql$update public.test_requests set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null where id = %L$sql$,
      v_c1));
  else
    v_loser := 's2';
    perform dblink_exec('s2', 'rollback');
    perform dblink_exec('s1', 'commit');
    perform x from dblink('s2', format(
      $sql$select public.waive_visit_balance(%L, %L, %L)$sql$, v_v5, v_admin, '0183-race scenario 5 retry')) as t(x text);
  end if;
  raise notice '0183-race scenario 5: loser was %, retried standalone', v_loser;

  -- ---- end state: identical either way ---------------------------------
  if not exists (select 1 from public.visits where id = v_v5 and payment_status = 'waived' and waived_php = 5888) then
    raise exception 'FAIL 5: visit is not waived at 5888';
  end if;
  if not exists (select 1 from public.visit_waiver_allocations where visit_id = v_v5 and test_request_id = v_h5) then
    raise exception 'FAIL 5: the header''s allocation is missing';
  end if;
  if exists (select 1 from public.visit_waiver_allocations where visit_id = v_v5 and test_request_id = v_h5 and recognised_at is not null) then
    raise exception 'FAIL 5: the header''s allocation should be unrecognised (folded, pending re-release)';
  end if;
  if not exists (select 1 from public.test_requests where id = v_h5 and status = 'ready_for_release') then
    raise exception 'FAIL 5: the header is not back to ready_for_release';
  end if;
  if not exists (select 1 from public.journal_entries where source_kind = 'test_request' and source_id = v_h5 and status = 'reversed') then
    raise exception 'FAIL 5: the header''s original release JE is not reversed';
  end if;

  if v_loser = 's1' then
    -- The waiver survived and posted the standalone header JE first; the
    -- later (retried) undo reversed it through waiver_unrecognise_line.
    select id, status into v_wje, v_wstatus
      from public.journal_entries
     where source_kind = 'visit_waiver'
       and source_id = (select id from public.visit_waiver_allocations where test_request_id = v_h5);
    if v_wje is null or v_wstatus <> 'reversed' then
      raise exception 'FAIL 5: expected the standalone header visit_waiver JE to be reversed (loser=s1), got %', v_wstatus;
    end if;
    select status into v_wrev_status from public.journal_entries where reverses = v_wje;
    if v_wrev_status is distinct from 'posted' then
      raise exception 'FAIL 5: mirrored waiver reversal is not posted';
    end if;
  else
    -- The undo survived first; the header was back to ready_for_release
    -- before the (retried) waiver ever ran, so it folded the share instead
    -- of posting a standalone JE — none should exist.
    if exists (
      select 1 from public.journal_entries
       where source_kind = 'visit_waiver'
         and source_id = (select id from public.visit_waiver_allocations where test_request_id = v_h5)
    ) then
      raise exception 'FAIL 5: an unexpected standalone visit_waiver JE exists (loser=s2)';
    end if;
  end if;

  -- 1100 nets to zero across the visit's own entries and their reversals.
  select coalesce(sum(jl.debit_php - jl.credit_php), 0) into v_net
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.chart_of_accounts coa on coa.id = jl.account_id
   where coa.code = '1100'
     and je.status in ('posted', 'reversed')
     and (
       (je.source_kind = 'test_request' and je.source_id = v_h5)
       or (je.source_kind = 'visit_waiver' and je.source_id in (select id from public.visit_waiver_allocations where test_request_id = v_h5))
       or je.reverses in (
         select id from public.journal_entries
          where (source_kind = 'test_request' and source_id = v_h5)
             or (source_kind = 'visit_waiver' and source_id in (select id from public.visit_waiver_allocations where test_request_id = v_h5))
       )
     );
  if v_net <> 0 then
    raise exception 'FAIL 5: 1100 does not net to zero for the visit (got %)', v_net;
  end if;

  raise notice 'PASS 5';

  -- =====================================================================
  -- Teardown + final checks
  -- =====================================================================
  perform pg_temp.teardown(v_visits_arr, v_lines_arr, v_payments_arr, v_patients_arr, v_services_arr, v_staff_arr, v_users_arr);

  select count(*) into v_alloc_after from public.visit_waiver_allocations;
  select count(*) into v_je_after    from public.journal_entries;
  if v_alloc_after <> v_alloc_before then
    raise exception 'FAIL: visit_waiver_allocations count changed (before % after %)', v_alloc_before, v_alloc_after;
  end if;
  if v_je_after <> v_je_before then
    raise exception 'FAIL: journal_entries count changed (before % after %)', v_je_before, v_je_after;
  end if;
  raise notice 'UNCHANGED COUNTS: visit_waiver_allocations before=% after=%, journal_entries before=% after=%',
    v_alloc_before, v_alloc_after, v_je_before, v_je_after;

  perform dblink_disconnect('s0');
  perform dblink_disconnect('s1');
  perform dblink_disconnect('s2');

  raise notice 'ALL PASS: 0183 waiver races';

exception when others then
  begin
    perform pg_temp.teardown(v_visits_arr, v_lines_arr, v_payments_arr, v_patients_arr, v_services_arr, v_staff_arr, v_users_arr);
  exception when others then
    raise warning 'teardown inside the exception handler also failed: %: %', sqlstate, sqlerrm;
  end;
  begin perform dblink_disconnect('s0'); exception when others then null; end;
  begin perform dblink_disconnect('s1'); exception when others then null; end;
  begin perform dblink_disconnect('s2'); exception when others then null; end;
  raise;
end
$race$;

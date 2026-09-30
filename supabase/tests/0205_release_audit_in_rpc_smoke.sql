-- =============================================================================
-- 0205_release_audit_in_rpc_smoke.sql
-- =============================================================================
-- DB proof for migration 0205 (release_visit_results / undo_visit_release write
-- their own audit rows; batch Undo refuses a null map value and treats an
-- unknown comparison as "changed"). Sequential only — the races are in
-- scripts/report-release-concurrency-proof.ts (B4c, B4d; control mutants M6, M7).
-- Runs inside BEGIN/ROLLBACK and leaves no state. Self-contained: mints its own
-- auth users, staff, report group, services, patient, visits, results and
-- test_requests. Calls run as `authenticated` with a JWT `sub` (or as
-- `service_role` with p_actor), the way the app calls them.
--
-- Run (local stack, from the repo root, with 0198 and 0205 applied):
--   /opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0205_release_audit_in_rpc_smoke.sql
--
-- What it proves:
--   1. A release writes ONE test_request.released row per released line
--      (report-mates too), in the call, with exactly the keys the TS wrapper
--      wrote — bulk, selection, the caller's extras, visit_id, release_medium,
--      released_at (the stamp the call returned, full precision) — plus the
--      ip / user agent. Extras may set bulk / selection but can't forge
--      visit_id, release_medium or released_at.
--   2. A DIRECT signed-in call with no p_audit is still audited (base keys).
--   3. A service-role call with p_actor is audited as that staff member.
--   4. A rolled-back release (payment gate) and a refused one write no rows.
--   5. Undo needs a reason: missing / blank → P0081, nothing changes.
--   6. An undo writes ONE test_request.release_undone row per undone line
--      with visit_id, reason, prior_release_medium, prior_released_at,
--      viewed_count (the SQL twin of countResultViews: every historical
--      result.downloaded shape, each row counted once), the extras and
--      report_result_id; extras can't forge the reason or the view count; an
--      unreadable ip is stored as null.
--   7. Batch Undo map with a JSON null (or a number) for a member → P0081,
--      nothing changes, no rows.
--   8. Batch Undo when a released member has NO released_at (legacy) and the
--      map is otherwise exact: the whole report is skipped (changed_since),
--      none undone — the 0198 check split it.
--   9. p_audit that isn't an object / metadata that isn't a small object → P0081.
--  10. Grants: the 0198 signatures are gone, the new RPCs are authenticated +
--      service_role only, the two new helpers are private.
-- =============================================================================

begin;

-- fixtures --------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000205', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke205-medtech@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000205', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke205-admin@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active) values
  ('a0000000-0000-4000-8000-000000000205', 'Smoke205 Medtech', 'medtech', true),
  ('a2000000-0000-4000-8000-000000000205', 'Smoke205 Admin',   'admin',   true);

insert into public.report_groups (id, code, name)
values ('b0000000-0000-4000-8000-000000000205', 'SMK205', 'Smoke205 Chemistry');

insert into public.services (id, code, name, price_php, kind, section, report_group_id) values
  ('c0000000-0000-4000-8000-000000000205', 'SMK205-A', 'Smoke205 A', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000205'),
  ('c1000000-0000-4000-8000-000000000205', 'SMK205-B', 'Smoke205 B', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000205'),
  ('c2000000-0000-4000-8000-000000000205', 'SMK205-C', 'Smoke205 C', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000205');
insert into public.services (id, code, name, price_php, kind, section) values
  ('c4000000-0000-4000-8000-000000000205', 'SMK205-U', 'Smoke205 Urinalysis', 100, 'lab_test', 'urinalysis');

insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values ('d0000000-0000-4000-8000-000000000205', 'DRM-SMK205', 'Smoke205', 'Patient', '1990-01-01', 'female');

-- V1 paid (the main visit), V2 unpaid (payment gate).
insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php) values
  ('e0000000-0000-4000-8000-000000000205', 'V-SMK205', 'd0000000-0000-4000-8000-000000000205',
   (now() at time zone 'Asia/Manila')::date, 'paid', 1000, 1000),
  ('e1000000-0000-4000-8000-000000000205', 'V-SMK205B', 'd0000000-0000-4000-8000-000000000205',
   (now() at time zone 'Asia/Manila')::date, 'unpaid', 100, 0);

-- Report R1 {f0,f1,f2}; plain f5 and f7 on V1; plain f6 on unpaid V2.
insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php) values
  ('f0000000-0000-4000-8000-000000000205', 'e0000000-0000-4000-8000-000000000205', 'c0000000-0000-4000-8000-000000000205', 'a0000000-0000-4000-8000-000000000205', 'ready_for_release', 100, 100),
  ('f1000000-0000-4000-8000-000000000205', 'e0000000-0000-4000-8000-000000000205', 'c1000000-0000-4000-8000-000000000205', 'a0000000-0000-4000-8000-000000000205', 'ready_for_release', 100, 100),
  ('f2000000-0000-4000-8000-000000000205', 'e0000000-0000-4000-8000-000000000205', 'c2000000-0000-4000-8000-000000000205', 'a0000000-0000-4000-8000-000000000205', 'ready_for_release', 100, 100),
  ('f5000000-0000-4000-8000-000000000205', 'e0000000-0000-4000-8000-000000000205', 'c4000000-0000-4000-8000-000000000205', 'a0000000-0000-4000-8000-000000000205', 'ready_for_release', 100, 100),
  ('f6000000-0000-4000-8000-000000000205', 'e1000000-0000-4000-8000-000000000205', 'c4000000-0000-4000-8000-000000000205', 'a0000000-0000-4000-8000-000000000205', 'ready_for_release', 100, 100),
  ('f7000000-0000-4000-8000-000000000205', 'e0000000-0000-4000-8000-000000000205', 'c4000000-0000-4000-8000-000000000205', 'a0000000-0000-4000-8000-000000000205', 'ready_for_release', 100, 100);

insert into public.results (id, uploaded_by) values
  ('90000000-0000-4000-8000-000000000205', 'a0000000-0000-4000-8000-000000000205');
insert into public.result_test_requests (result_id, test_request_id) values
  ('90000000-0000-4000-8000-000000000205', 'f0000000-0000-4000-8000-000000000205'),
  ('90000000-0000-4000-8000-000000000205', 'f1000000-0000-4000-8000-000000000205'),
  ('90000000-0000-4000-8000-000000000205', 'f2000000-0000-4000-8000-000000000205');

-- helpers ---------------------------------------------------------------------

-- Run p_sql (returning one jsonb) as a staff member, or as service_role when
-- p_user is null.
create or replace function pg_temp.run_as(p_user uuid, p_sql text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    execute 'set local role service_role';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  execute p_sql into v;
  execute 'reset role';
  return v;
exception when others then
  execute 'reset role';
  raise;
end $$;

create or replace function pg_temp.expect_error(p_label text, p_user uuid, p_sql text, p_state text) returns void
language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    perform pg_temp.run_as(p_user, p_sql);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_state then
      raise exception '%: expected %, got % (%)', p_label, p_state, v_state, v_msg;
    end if;
    raise notice '% ok: % (%)', p_label, v_state, v_msg;
    return;
  end;
  raise exception '%: expected %, call succeeded', p_label, p_state;
end $$;

create or replace function pg_temp.expect(p_label text, p_got text, p_want text) returns void
language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception '%: expected [%], got [%]', p_label, p_want, p_got;
  end if;
  raise notice '% ok: %', p_label, p_got;
end $$;

create or replace function pg_temp.statuses(p_ids uuid[]) returns text language sql as $$
  select string_agg(status, ',' order by id) from public.test_requests where id = any (p_ids);
$$;

create or replace function pg_temp.r1() returns uuid[] language sql immutable as $$
  select array['f0000000-0000-4000-8000-000000000205', 'f1000000-0000-4000-8000-000000000205',
               'f2000000-0000-4000-8000-000000000205']::uuid[]
$$;

-- Audit rows of one action for these lines.
create or replace function pg_temp.n_audit(p_action text, p_ids uuid[]) returns int language sql as $$
  select count(*)::int from public.audit_log
   where action = p_action and resource_type = 'test_request' and resource_id = any (p_ids);
$$;

-- The sorted metadata keys of every such row, as one distinct list (a|b|c).
create or replace function pg_temp.audit_keys(p_action text, p_ids uuid[]) returns text language sql as $$
  select string_agg(distinct k, '|' order by k)
    from (select (select string_agg(key, ',' order by key) from jsonb_object_keys(a.metadata) key) as k
            from public.audit_log a
           where a.action = p_action and a.resource_type = 'test_request' and a.resource_id = any (p_ids)) x;
$$;

-- 1. release through the app's shape: one row per line, exact keys ------------
do $$
declare v jsonb;
begin
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000205',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000205',
         '{f1000000-0000-4000-8000-000000000205}'::uuid[], 'email', null,
         '{"metadata": {"source": "visit_page", "bulk": false, "selection": false,
                        "bulk_batch_id": "11111111-1111-4111-8111-111111111111",
                        "visit_id": "forged", "release_medium": "forged", "released_at": "forged"},
           "ip": "203.0.113.7", "user_agent": "smoke205-ua"}'::jsonb)$q$);
  perform pg_temp.expect('1 released count', jsonb_array_length(v -> 'released')::text, '3');
  perform pg_temp.expect('1 one audit row per released line (report-mates too)',
    pg_temp.n_audit('test_request.released', pg_temp.r1())::text, '3');
  perform pg_temp.expect('1 keys',
    pg_temp.audit_keys('test_request.released', pg_temp.r1()),
    'bulk,bulk_batch_id,release_medium,released_at,selection,source,visit_id');
  perform pg_temp.expect('1 actor / ip / ua / extras / forged keys ignored',
    (select string_agg(distinct concat_ws('/', a.actor_id, a.actor_type, host(a.ip_address), a.user_agent,
                                          a.metadata ->> 'source', a.metadata ->> 'bulk', a.metadata ->> 'selection',
                                          a.metadata ->> 'bulk_batch_id', a.metadata ->> 'visit_id',
                                          a.metadata ->> 'release_medium'), ',')
       from public.audit_log a
      where a.action = 'test_request.released' and a.resource_id = any (pg_temp.r1())),
    'a0000000-0000-4000-8000-000000000205/staff/203.0.113.7/smoke205-ua/visit_page/false/false/11111111-1111-4111-8111-111111111111/e0000000-0000-4000-8000-000000000205/email');
  -- released_at in the row is byte-for-byte the string the call returned, and the stored stamp.
  perform pg_temp.expect('1 released_at = the returned string = the stored stamp',
    (select count(*)
       from jsonb_array_elements(v -> 'released') e
       join public.audit_log a
         on a.action = 'test_request.released' and a.resource_id = (e ->> 'id')::uuid
       join public.test_requests t on t.id = a.resource_id
      where a.metadata ->> 'released_at' = e ->> 'released_at'
        and (a.metadata ->> 'released_at')::timestamptz = t.released_at
        and a.created_at >= t.released_at)::text, '3');
end $$;

-- 2. a DIRECT signed-in call with no p_audit is still audited -------------------
do $$
begin
  perform pg_temp.run_as('a0000000-0000-4000-8000-000000000205',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000205',
         '{f5000000-0000-4000-8000-000000000205}'::uuid[], 'pickup')$q$);
  perform pg_temp.expect('2 direct call audited',
    pg_temp.n_audit('test_request.released', array['f5000000-0000-4000-8000-000000000205']::uuid[])::text, '1');
  perform pg_temp.expect('2 base keys only',
    pg_temp.audit_keys('test_request.released', array['f5000000-0000-4000-8000-000000000205']::uuid[]),
    'bulk,release_medium,released_at,selection,visit_id');
  perform pg_temp.expect('2 no ip / ua',
    (select concat_ws('/', coalesce(host(ip_address), 'null'), coalesce(user_agent, 'null'), metadata ->> 'bulk')
       from public.audit_log
      where action = 'test_request.released' and resource_id = 'f5000000-0000-4000-8000-000000000205'),
    'null/null/true');
end $$;

-- 3. service role names its staff member ------------------------------------------
do $$
begin
  perform pg_temp.run_as(null,
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000205',
         '{f7000000-0000-4000-8000-000000000205}'::uuid[], 'other', 'a0000000-0000-4000-8000-000000000205',
         '{"metadata": {"source": "finalise_consolidated"}}'::jsonb)$q$);
  perform pg_temp.expect('3 audited as p_actor',
    (select actor_id::text || '/' || (metadata ->> 'source') from public.audit_log
      where action = 'test_request.released' and resource_id = 'f7000000-0000-4000-8000-000000000205'),
    'a0000000-0000-4000-8000-000000000205/finalise_consolidated');
end $$;

-- 4. rolled back / refused → no rows ------------------------------------------------
select null from pg_temp.expect_error('4 unpaid visit: payment gate', 'a0000000-0000-4000-8000-000000000205',
  $q$select public.release_visit_results('e1000000-0000-4000-8000-000000000205',
       '{f6000000-0000-4000-8000-000000000205}'::uuid[], 'email', null, '{"metadata": {"source": "queue"}}'::jsonb)$q$, '23514');
select null from pg_temp.expect('4 no row for the rolled-back release',
  pg_temp.n_audit('test_request.released', array['f6000000-0000-4000-8000-000000000205']::uuid[])::text, '0');
do $$
declare v jsonb;
begin
  -- f5 is already released: not_ready, nothing written.
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000205',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000205',
         '{f5000000-0000-4000-8000-000000000205}'::uuid[], 'email')$q$);
  perform pg_temp.expect('4 refused code', (v -> 'refused' -> 0 ->> 'code'), 'not_ready');
  perform pg_temp.expect('4 no second row for a refused line',
    pg_temp.n_audit('test_request.released', array['f5000000-0000-4000-8000-000000000205']::uuid[])::text, '1');
end $$;

-- 5. undo needs a reason -------------------------------------------------------------
select null from pg_temp.expect_error('5 undo without a reason', 'a2000000-0000-4000-8000-000000000205',
  $q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000205',
       '{f0000000-0000-4000-8000-000000000205}'::uuid[])$q$, 'P0081');
select null from pg_temp.expect_error('5 undo with a blank reason', 'a2000000-0000-4000-8000-000000000205',
  $q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000205',
       '{f0000000-0000-4000-8000-000000000205}'::uuid[], p_reason => '   ')$q$, 'P0081');
select null from pg_temp.expect('5 nothing undone', pg_temp.statuses(pg_temp.r1()), 'released,released,released');
select null from pg_temp.expect('5 no undo rows',
  pg_temp.n_audit('test_request.release_undone', pg_temp.r1())::text, '0');

-- 6. undo: one row per undone line, view counts, forged keys ignored ------------------
-- The patient opened the report through every historical shape (viewed-count.ts):
--   a {test_request_id: f0}            → f0
--   b resource_id = R1                 → f0, f1, f2
--   c {test_request_ids: [f1]}         → f1
--   d {merged_component_ids: [f2]}     → f2
--   e {test_request_id: f0, test_request_ids: [f0]} → f0 ONCE (two shapes, one row)
-- so f0 = 3 (a, b, e), f1 = 2 (b, c), f2 = 2 (b, d).
insert into public.audit_log (actor_type, action, resource_type, resource_id, metadata) values
  ('patient', 'result.downloaded', 'result', null, '{"test_request_id": "f0000000-0000-4000-8000-000000000205"}'),
  ('patient', 'result.downloaded', 'result', '90000000-0000-4000-8000-000000000205', '{}'),
  ('patient', 'result.downloaded', 'result', null, '{"test_request_ids": ["f1000000-0000-4000-8000-000000000205"]}'),
  ('patient', 'result.downloaded', 'result', null, '{"merged_component_ids": ["f2000000-0000-4000-8000-000000000205"]}'),
  ('patient', 'result.downloaded', 'result', null,
   '{"test_request_id": "f0000000-0000-4000-8000-000000000205", "test_request_ids": ["f0000000-0000-4000-8000-000000000205"]}');
do $$
declare v jsonb;
begin
  v := pg_temp.run_as('a2000000-0000-4000-8000-000000000205',
    $q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000205',
         '{f0000000-0000-4000-8000-000000000205}'::uuid[], null, null, '  Wrong patient  ',
         '{"metadata": {"bulk": true, "via": "bulk_undo",
                        "undo_of_batch": "11111111-1111-4111-8111-111111111111",
                        "bulk_batch_id": "22222222-2222-4222-8222-222222222222",
                        "reason": "forged", "viewed_count": 99, "report_result_id": "forged"},
           "ip": "not-an-ip", "user_agent": "smoke205-ua2"}'::jsonb)$q$);
  perform pg_temp.expect('6 undone count', jsonb_array_length(v -> 'undone')::text, '3');
  perform pg_temp.expect('6 one row per undone line',
    pg_temp.n_audit('test_request.release_undone', pg_temp.r1())::text, '3');
  perform pg_temp.expect('6 keys',
    pg_temp.audit_keys('test_request.release_undone', pg_temp.r1()),
    'bulk,bulk_batch_id,prior_release_medium,prior_released_at,reason,report_result_id,undo_of_batch,via,viewed_count,visit_id');
  perform pg_temp.expect('6 actor / ip / ua / reason / extras / report',
    (select string_agg(distinct concat_ws('/', a.actor_id, coalesce(host(a.ip_address), 'null'), a.user_agent,
                                          a.metadata ->> 'reason', a.metadata ->> 'via', a.metadata ->> 'undo_of_batch',
                                          a.metadata ->> 'bulk_batch_id', a.metadata ->> 'visit_id',
                                          a.metadata ->> 'prior_release_medium', a.metadata ->> 'report_result_id'), ',')
       from public.audit_log a
      where a.action = 'test_request.release_undone' and a.resource_id = any (pg_temp.r1())),
    'a2000000-0000-4000-8000-000000000205/null/smoke205-ua2/Wrong patient/bulk_undo/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/e0000000-0000-4000-8000-000000000205/email/90000000-0000-4000-8000-000000000205');
  perform pg_temp.expect('6 viewed_count per line (f0, f1, f2)',
    (select string_agg(a.metadata ->> 'viewed_count', ',' order by a.resource_id)
       from public.audit_log a
      where a.action = 'test_request.release_undone' and a.resource_id = any (pg_temp.r1())),
    '3,2,2');
  -- prior_released_at is the release's own stamp, as the release row recorded it.
  perform pg_temp.expect('6 prior_released_at = the release row''s released_at',
    (select count(*)
       from public.audit_log u
       join public.audit_log r
         on r.action = 'test_request.released' and r.resource_id = u.resource_id
      where u.action = 'test_request.release_undone' and u.resource_id = any (pg_temp.r1())
        and u.metadata ->> 'prior_released_at' = r.metadata ->> 'released_at')::text, '3');
  perform pg_temp.expect('6 undo returns the same prior values',
    (select count(*) from jsonb_array_elements(v -> 'undone') e
       join public.audit_log u on u.action = 'test_request.release_undone' and u.resource_id = (e ->> 'id')::uuid
      where u.metadata ->> 'prior_released_at' = e ->> 'prior_released_at')::text, '3');
end $$;

-- 7. batch Undo: a JSON null / number for a member → P0081 -------------------------
do $$
declare v jsonb; v_map jsonb;
begin
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000205',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000205',
         '{f0000000-0000-4000-8000-000000000205}'::uuid[], 'other')$q$);
  v_map := (select jsonb_object_agg(e ->> 'id', e -> 'released_at') from jsonb_array_elements(v -> 'released') e);
  perform pg_temp.expect('7 map has three', (select count(*) from jsonb_each(v_map))::text, '3');
  create temp table smoke205_map on commit drop as select v_map as m;
end $$;
select null from pg_temp.expect_error('7 null value for one member', 'a0000000-0000-4000-8000-000000000205',
  format($q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000205',
       '{f0000000-0000-4000-8000-000000000205}'::uuid[], null, %L::jsonb, 'smoke205')$q$,
    (select jsonb_set(m, '{f1000000-0000-4000-8000-000000000205}', 'null') from smoke205_map)), 'P0081');
select null from pg_temp.expect_error('7 number value for one member', 'a0000000-0000-4000-8000-000000000205',
  format($q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000205',
       '{f0000000-0000-4000-8000-000000000205}'::uuid[], null, %L::jsonb, 'smoke205')$q$,
    (select jsonb_set(m, '{f1000000-0000-4000-8000-000000000205}', '12345') from smoke205_map)), 'P0081');
select null from pg_temp.expect('7 still released', pg_temp.statuses(pg_temp.r1()), 'released,released,released');
select null from pg_temp.expect('7 no new undo rows',
  pg_temp.n_audit('test_request.release_undone', pg_temp.r1())::text, '3');

-- 8. batch Undo: a released member with no released_at → whole report skipped -----
update public.test_requests set released_at = null where id = 'f1000000-0000-4000-8000-000000000205';
select null from pg_temp.expect('8 legacy member has no stamp',
  (select (released_at is null)::text || '/' || status from public.test_requests
    where id = 'f1000000-0000-4000-8000-000000000205'), 'true/released');
do $$
declare v jsonb;
begin
  execute format('select pg_temp.run_as(%L, %L)', 'a0000000-0000-4000-8000-000000000205',
    format($q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000205',
       '{f0000000-0000-4000-8000-000000000205}'::uuid[], null, %L::jsonb, 'smoke205')$q$,
      (select m from smoke205_map))) into v;
  perform pg_temp.expect('8 nothing undone', (v -> 'undone')::text, '[]');
  perform pg_temp.expect('8 skipped changed_since',
    (select string_agg(e ->> 'code', ',') from jsonb_array_elements(v -> 'skipped') e), 'changed_since');
  perform pg_temp.expect('8 report not split', pg_temp.statuses(pg_temp.r1()), 'released,released,released');
  perform pg_temp.expect('8 no new undo rows',
    pg_temp.n_audit('test_request.release_undone', pg_temp.r1())::text, '3');
end $$;

-- 9. malformed p_audit → P0081 ----------------------------------------------------------
select null from pg_temp.expect_error('9 p_audit not an object', 'a0000000-0000-4000-8000-000000000205',
  $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000205',
       '{f7000000-0000-4000-8000-000000000205}'::uuid[], 'email', null, '"x"'::jsonb)$q$, 'P0081');
select null from pg_temp.expect_error('9 metadata not an object', 'a0000000-0000-4000-8000-000000000205',
  $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000205',
       '{f7000000-0000-4000-8000-000000000205}'::uuid[], 'email', null, '{"metadata": [1]}'::jsonb)$q$, 'P0081');
select null from pg_temp.expect_error('9 oversized metadata', 'a0000000-0000-4000-8000-000000000205',
  format($q$select public.release_visit_results('e0000000-0000-4000-8000-000000000205',
       '{f7000000-0000-4000-8000-000000000205}'::uuid[], 'email', null, %L::jsonb)$q$,
    jsonb_build_object('metadata', jsonb_build_object('pad', repeat('x', 5000)))), 'P0081');

-- 10. grants ------------------------------------------------------------------------------
select null from pg_temp.expect('10 0198 signatures gone',
  (to_regprocedure('public.release_visit_results(uuid,uuid[],text,uuid)') is null
   and to_regprocedure('public.undo_visit_release(uuid,uuid[],uuid,jsonb)') is null)::text, 'true');
select null from pg_temp.expect('10 RPCs: authenticated + service_role, not anon',
  (has_function_privilege('authenticated', 'public.release_visit_results(uuid,uuid[],text,uuid,jsonb)', 'EXECUTE')
   and has_function_privilege('service_role', 'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)', 'EXECUTE')
   and not has_function_privilege('anon', 'public.release_visit_results(uuid,uuid[],text,uuid,jsonb)', 'EXECUTE')
   and not has_function_privilege('anon', 'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)', 'EXECUTE'))::text,
  'true');
select null from pg_temp.expect('10 helpers private',
  (has_function_privilege('authenticated', 'public.release_audit_context(jsonb)', 'EXECUTE')
   or has_function_privilege('service_role', 'public.release_audit_context(jsonb)', 'EXECUTE')
   or has_function_privilege('authenticated', 'public.result_view_count(uuid)', 'EXECUTE')
   or has_function_privilege('service_role', 'public.result_view_count(uuid)', 'EXECUTE'))::text, 'false');

\echo '0205 smoke: all checks passed'
rollback;

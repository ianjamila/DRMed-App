-- =============================================================================
-- 0198_atomic_report_release_smoke.sql
-- =============================================================================
-- DB proof for migration 0198 (release_visit_results / undo_visit_release).
-- Sequential only: the same functions under two sessions racing on one report
-- (release vs release / undo / claim / unclaim / payment void, package
-- siblings) are proven by scripts/report-release-concurrency-proof.ts
-- (npm run report-release:concurrency-proof -- --control).
-- Runs inside BEGIN/ROLLBACK and leaves no state. Self-contained: mints its
-- own auth users, staff, report group, services, patient, visits, results and
-- test_requests. Calls run as `authenticated` with a JWT `sub` (or as
-- `service_role` with p_actor), the way the app calls them.
--
-- Run (local stack, from the repo root, with 0198 and 0205 applied — 0205 made
-- undo_visit_release require p_reason and added p_audit to both functions):
--   /opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0198_atomic_report_release_smoke.sql
--
-- What it proves:
--   1. Releasing ONE member of a ready 3-test report releases all three (the
--      others reported selected=false), one posted journal entry each.
--   2. Undoing one member undoes the whole report, returns the prior medium,
--      and reverses every journal entry.
--   3. A report with a member still awaiting its result is refused
--      (report_not_finished, count 1) and NOTHING changes.
--   4. A report with a deleted, unreleased member is refused (report_deleted_member).
--   5. Reception (no lab sections) is refused: report_outside_sections and
--      outside_sections for a plain line; undo raises P0081.
--   6. A plain line releases alone; selecting it again → not_ready.
--   7. An unpaid visit: the payment gate's check_violation rolls the whole call back.
--   8. Who: service_role must name p_actor; a signed-in caller cannot name
--      someone else; anon cannot execute; the helpers are private.
--   9. Whole-call refusals raise P0081: nothing selected, a bad medium, a deleted visit,
--      undo with nothing released.
--  10. Package siblings released one after another: the header auto-releases
--      with the second component, exactly once.
--  11. Batch Undo (p_expected_released_at): release returns the stored
--      released_at; a report with ONE member no longer on that release is
--      skipped whole (changed_since, no raise); the exact identities undo it whole.
-- =============================================================================

begin;

-- fixtures --------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000198', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke198-medtech@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000198', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke198-reception@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000198', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke198-admin@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active) values
  ('a0000000-0000-4000-8000-000000000198', 'Smoke198 Medtech',   'medtech',   true),
  ('a1000000-0000-4000-8000-000000000198', 'Smoke198 Reception', 'reception', true),
  ('a2000000-0000-4000-8000-000000000198', 'Smoke198 Admin',     'admin',     true);

insert into public.report_groups (id, code, name)
values ('b0000000-0000-4000-8000-000000000198', 'SMK198', 'Smoke198 Chemistry');

insert into public.services (id, code, name, price_php, kind, section, report_group_id) values
  ('c0000000-0000-4000-8000-000000000198', 'SMK198-A', 'Smoke198 A', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000198'),
  ('c1000000-0000-4000-8000-000000000198', 'SMK198-B', 'Smoke198 B', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000198'),
  ('c2000000-0000-4000-8000-000000000198', 'SMK198-C', 'Smoke198 C', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000198');
insert into public.services (id, code, name, price_php, kind, section) values
  ('c3000000-0000-4000-8000-000000000198', 'SMK198-PKG', 'Smoke198 Package', 500, 'lab_package', null),
  ('c4000000-0000-4000-8000-000000000198', 'SMK198-U',   'Smoke198 Urinalysis', 100, 'lab_test', 'urinalysis');

insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values ('d0000000-0000-4000-8000-000000000198', 'DRM-SMK198', 'Smoke198', 'Patient', '1990-01-01', 'female');

-- V1 paid (the main visit), V2 unpaid (payment gate).
insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php) values
  ('e0000000-0000-4000-8000-000000000198', 'V-SMK198', 'd0000000-0000-4000-8000-000000000198',
   (now() at time zone 'Asia/Manila')::date, 'paid', 1000, 1000),
  ('e1000000-0000-4000-8000-000000000198', 'V-SMK198B', 'd0000000-0000-4000-8000-000000000198',
   (now() at time zone 'Asia/Manila')::date, 'unpaid', 100, 0);

-- Report R1 {f0,f1,f2}; report R2 {f3, f4 deleted}; plain f5; V2 plain f6.
insert into public.test_requests (id, visit_id, service_id, requested_by, status,
                                  base_price_php, final_price_php, deleted_at, delete_reason) values
  ('f0000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c0000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 100, 100, null, null),
  ('f1000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c1000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 100, 100, null, null),
  ('f2000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c2000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 100, 100, null, null),
  ('f3000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c0000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 100, 100, null, null),
  ('f4000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c1000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 100, 100, now(), 'smoke198 deleted member'),
  ('f5000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c4000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 100, 100, null, null),
  ('f6000000-0000-4000-8000-000000000198', 'e1000000-0000-4000-8000-000000000198', 'c4000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 100, 100, null, null);

insert into public.results (id, uploaded_by) values
  ('90000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198'),
  ('91000000-0000-4000-8000-000000000198', 'a0000000-0000-4000-8000-000000000198');
insert into public.result_test_requests (result_id, test_request_id) values
  ('90000000-0000-4000-8000-000000000198', 'f0000000-0000-4000-8000-000000000198'),
  ('90000000-0000-4000-8000-000000000198', 'f1000000-0000-4000-8000-000000000198'),
  ('90000000-0000-4000-8000-000000000198', 'f2000000-0000-4000-8000-000000000198'),
  ('91000000-0000-4000-8000-000000000198', 'f3000000-0000-4000-8000-000000000198'),
  ('91000000-0000-4000-8000-000000000198', 'f4000000-0000-4000-8000-000000000198');

-- helpers ---------------------------------------------------------------------

-- Run p_sql (returning one jsonb) as a staff member, or as service_role when
-- p_user is null. The ids are inlined: pg_temp helpers are not executable by
-- those roles.
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

-- Assert p_sql raises p_state.
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

create or replace function pg_temp.statuses(p_ids uuid[]) returns text language sql as $$
  select string_agg(status, ',' order by id) from public.test_requests where id = any (p_ids);
$$;

create or replace function pg_temp.posted_jes(p_ids uuid[]) returns int language sql as $$
  select count(*)::int from public.journal_entries
   where source_kind = 'test_request' and source_id = any (p_ids) and status = 'posted';
$$;

create or replace function pg_temp.expect(p_label text, p_got text, p_want text) returns void
language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception '%: expected [%], got [%]', p_label, p_want, p_got;
  end if;
  raise notice '% ok: %', p_label, p_got;
end $$;

create or replace function pg_temp.r1() returns uuid[] language sql immutable as $$
  select array['f0000000-0000-4000-8000-000000000198', 'f1000000-0000-4000-8000-000000000198',
               'f2000000-0000-4000-8000-000000000198']::uuid[]
$$;

-- 1. one member releases the whole report ------------------------------------
do $$
declare v jsonb;
begin
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f1000000-0000-4000-8000-000000000198}'::uuid[], 'pickup')$q$);
  perform pg_temp.expect('1 released count', jsonb_array_length(v -> 'released')::text, '3');
  perform pg_temp.expect('1 refused', (v -> 'refused')::text, '[]');
  perform pg_temp.expect('1 selected flags',
    (select string_agg((e ->> 'selected'), ',' order by e ->> 'id') from jsonb_array_elements(v -> 'released') e),
    'false,true,false');
  perform pg_temp.expect('1 report ids',
    (select string_agg(distinct e ->> 'report_id', ',') from jsonb_array_elements(v -> 'released') e),
    '90000000-0000-4000-8000-000000000198');
  perform pg_temp.expect('1 statuses', pg_temp.statuses(pg_temp.r1()), 'released,released,released');
  perform pg_temp.expect('1 one JE each', pg_temp.posted_jes(pg_temp.r1())::text, '3');
  perform pg_temp.expect('1 released_by/medium',
    (select string_agg(distinct released_by::text || '/' || release_medium, ',')
       from public.test_requests where id = any (pg_temp.r1())),
    'a0000000-0000-4000-8000-000000000198/pickup');
end $$;

-- 2. undo one member undoes the whole report ---------------------------------
do $$
declare v jsonb;
begin
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000198',
         '{f2000000-0000-4000-8000-000000000198}'::uuid[], p_reason => 'smoke198')$q$);
  perform pg_temp.expect('2 undone count', jsonb_array_length(v -> 'undone')::text, '3');
  perform pg_temp.expect('2 prior medium',
    (select string_agg(distinct e ->> 'prior_release_medium', ',') from jsonb_array_elements(v -> 'undone') e),
    'pickup');
  perform pg_temp.expect('2 statuses', pg_temp.statuses(pg_temp.r1()),
    'ready_for_release,ready_for_release,ready_for_release');
  perform pg_temp.expect('2 no posted JE', pg_temp.posted_jes(pg_temp.r1())::text, '0');
end $$;

-- 3. a member still awaiting its result: refused, nothing changes -------------
update public.test_requests set status = 'result_uploaded' where id = 'f2000000-0000-4000-8000-000000000198';
do $$
declare v jsonb;
begin
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f0000000-0000-4000-8000-000000000198,f1000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$);
  perform pg_temp.expect('3 released', (v -> 'released')::text, '[]');
  perform pg_temp.expect('3 codes',
    (select string_agg(e ->> 'code' || ':' || (e ->> 'count'), ',') from jsonb_array_elements(v -> 'refused') e),
    'report_not_finished:1,report_not_finished:1');
  perform pg_temp.expect('3 statuses', pg_temp.statuses(pg_temp.r1()),
    'ready_for_release,ready_for_release,result_uploaded');
end $$;
update public.test_requests set status = 'ready_for_release' where id = 'f2000000-0000-4000-8000-000000000198';

-- 4. a deleted, unreleased member ----------------------------------------------
do $$
declare v jsonb;
begin
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f3000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$);
  perform pg_temp.expect('4 code',
    (select string_agg(e ->> 'code', ',') from jsonb_array_elements(v -> 'refused') e), 'report_deleted_member');
  perform pg_temp.expect('4 status', pg_temp.statuses(array['f3000000-0000-4000-8000-000000000198']::uuid[]),
    'ready_for_release');
end $$;

-- 5. reception works no lab section -------------------------------------------
do $$
declare v jsonb;
begin
  v := pg_temp.run_as('a1000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f0000000-0000-4000-8000-000000000198,f5000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$);
  perform pg_temp.expect('5 released', (v -> 'released')::text, '[]');
  perform pg_temp.expect('5 codes',
    (select string_agg(e ->> 'code', ',' order by e ->> 'id') from jsonb_array_elements(v -> 'refused') e),
    'report_outside_sections,outside_sections');
end $$;
select null from pg_temp.expect_error('5 reception undo', 'a1000000-0000-4000-8000-000000000198',
  $q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000198',
       '{f0000000-0000-4000-8000-000000000198}'::uuid[], p_reason => 'smoke198')$q$, 'P0081');

-- 6. a plain line alone; again → not_ready ---------------------------------------
do $$
declare v jsonb;
begin
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f5000000-0000-4000-8000-000000000198}'::uuid[], 'email')$q$);
  perform pg_temp.expect('6 released',
    (select string_agg((e ->> 'id') || ':' || coalesce(e ->> 'report_id', '-'), ',') from jsonb_array_elements(v -> 'released') e),
    'f5000000-0000-4000-8000-000000000198:-');
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f5000000-0000-4000-8000-000000000198}'::uuid[], 'email')$q$);
  perform pg_temp.expect('6 again',
    (select string_agg(e ->> 'code', ',') from jsonb_array_elements(v -> 'refused') e), 'not_ready');
  perform pg_temp.expect('6 one JE', pg_temp.posted_jes(array['f5000000-0000-4000-8000-000000000198']::uuid[])::text, '1');
end $$;

-- 7. unpaid visit: the payment gate rolls the whole call back -------------------
select null from pg_temp.expect_error('7 payment gate', 'a0000000-0000-4000-8000-000000000198',
  $q$select public.release_visit_results('e1000000-0000-4000-8000-000000000198',
       '{f6000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$, '23514');
select null from pg_temp.expect('7 still ready', pg_temp.statuses(array['f6000000-0000-4000-8000-000000000198']::uuid[]),
  'ready_for_release');

-- 8. who --------------------------------------------------------------------------
select null from pg_temp.expect_error('8 service_role without actor', null,
  $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
       '{f0000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$, '42501');
select null from pg_temp.expect_error('8 someone else as actor', 'a0000000-0000-4000-8000-000000000198',
  $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
       '{f0000000-0000-4000-8000-000000000198}'::uuid[], 'other', 'a2000000-0000-4000-8000-000000000198')$q$, '42501');
do $$
declare v jsonb;
begin
  v := pg_temp.run_as(null,
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f0000000-0000-4000-8000-000000000198}'::uuid[], 'other', 'a2000000-0000-4000-8000-000000000198')$q$);
  perform pg_temp.expect('8 service_role with actor', jsonb_array_length(v -> 'released')::text, '3');
  perform pg_temp.expect('8 released_by is the actor',
    (select string_agg(distinct released_by::text, ',') from public.test_requests where id = any (pg_temp.r1())),
    'a2000000-0000-4000-8000-000000000198');
end $$;
select null from pg_temp.expect('8 anon cannot execute',
  (has_function_privilege('anon', 'public.release_visit_results(uuid,uuid[],text,uuid,jsonb)', 'EXECUTE')
   or has_function_privilege('anon', 'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)', 'EXECUTE'))::text, 'false');
select null from pg_temp.expect('8 helpers private',
  (has_function_privilege('authenticated', 'public.release_report_locks(uuid,uuid[],text)', 'EXECUTE')
   or has_function_privilege('service_role', 'public.release_actor(uuid)', 'EXECUTE'))::text, 'false');

-- 9. whole-call refusals -------------------------------------------------------------
select null from pg_temp.expect_error('9 nothing selected', 'a0000000-0000-4000-8000-000000000198',
  $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198', '{}'::uuid[], 'other')$q$, 'P0081');
select null from pg_temp.expect_error('9 bad medium', 'a0000000-0000-4000-8000-000000000198',
  $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
       '{f0000000-0000-4000-8000-000000000198}'::uuid[], 'fax')$q$, 'P0081');
select null from pg_temp.expect_error('9 undo with nothing released', 'a0000000-0000-4000-8000-000000000198',
  $q$select public.undo_visit_release('e1000000-0000-4000-8000-000000000198',
       '{f6000000-0000-4000-8000-000000000198}'::uuid[], p_reason => 'smoke198')$q$, 'P0081');
update public.visits set deleted_at = now(), delete_reason = 'smoke198' where id = 'e1000000-0000-4000-8000-000000000198';
select null from pg_temp.expect_error('9 deleted visit', 'a0000000-0000-4000-8000-000000000198',
  $q$select public.release_visit_results('e1000000-0000-4000-8000-000000000198',
       '{f6000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$, 'P0081');

-- 10. package siblings -----------------------------------------------------------------
insert into public.test_requests (id, visit_id, service_id, requested_by, status,
                                  is_package_header, base_price_php, final_price_php) values
  ('f7000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c3000000-0000-4000-8000-000000000198',
   'a0000000-0000-4000-8000-000000000198', 'ready_for_release', true, 500, 500);
insert into public.test_requests (id, visit_id, service_id, requested_by, status, parent_id,
                                  base_price_php, final_price_php) values
  ('f8000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c4000000-0000-4000-8000-000000000198',
   'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 'f7000000-0000-4000-8000-000000000198', 0, 0),
  ('f9000000-0000-4000-8000-000000000198', 'e0000000-0000-4000-8000-000000000198', 'c4000000-0000-4000-8000-000000000198',
   'a0000000-0000-4000-8000-000000000198', 'ready_for_release', 'f7000000-0000-4000-8000-000000000198', 0, 0);
do $$
begin
  perform pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f8000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$);
  perform pg_temp.expect('10 header waits', pg_temp.statuses(array['f7000000-0000-4000-8000-000000000198']::uuid[]),
    'ready_for_release');
  perform pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f9000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$);
  perform pg_temp.expect('10 header released', pg_temp.statuses(array['f7000000-0000-4000-8000-000000000198']::uuid[]),
    'released');
  perform pg_temp.expect('10 header one JE',
    pg_temp.posted_jes(array['f7000000-0000-4000-8000-000000000198']::uuid[])::text, '1');
end $$;

-- 11. batch Undo (p_expected_released_at): only the exact release this batch made --
do $$
declare v jsonb; v_map jsonb; v_old jsonb;
begin
  -- R1 is released (step 8). Undo it, release it as a batch, keep its identities.
  perform pg_temp.run_as('a2000000-0000-4000-8000-000000000198',
    $q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000198',
         '{f0000000-0000-4000-8000-000000000198}'::uuid[], p_reason => 'smoke198')$q$);
  v := pg_temp.run_as('a0000000-0000-4000-8000-000000000198',
    $q$select public.release_visit_results('e0000000-0000-4000-8000-000000000198',
         '{f0000000-0000-4000-8000-000000000198}'::uuid[], 'other')$q$);
  v_map := (select jsonb_object_agg(e ->> 'id', e -> 'released_at') from jsonb_array_elements(v -> 'released') e);
  perform pg_temp.expect('11 released_at returned', (select count(*) from jsonb_each(v_map))::text, '3');
  perform pg_temp.expect('11 released_at is the stored one',
    (select count(*) from public.test_requests t
      where t.id = any (pg_temp.r1()) and t.released_at = (v_map ->> t.id::text)::timestamptz)::text, '3');

  -- A wrong identity for one member: the whole report is skipped, nothing undone, no raise.
  v_old := jsonb_set(v_map, array['f1000000-0000-4000-8000-000000000198'], '"2000-01-01T00:00:00+00:00"');
  execute format('select pg_temp.run_as(%L, %L)', 'a0000000-0000-4000-8000-000000000198',
    format($q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000198',
       '{f0000000-0000-4000-8000-000000000198}'::uuid[], null, %L::jsonb, 'smoke198')$q$, v_old)) into v;
  perform pg_temp.expect('11 changed report skipped', (v -> 'undone')::text, '[]');
  perform pg_temp.expect('11 skipped code',
    (select string_agg(e ->> 'code', ',') from jsonb_array_elements(v -> 'skipped') e), 'changed_since');
  perform pg_temp.expect('11 still released', pg_temp.statuses(pg_temp.r1()), 'released,released,released');

  -- The exact identities: the whole report comes back.
  execute format('select pg_temp.run_as(%L, %L)', 'a0000000-0000-4000-8000-000000000198',
    format($q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000198',
       '{f0000000-0000-4000-8000-000000000198}'::uuid[], null, %L::jsonb, 'smoke198')$q$, v_map)) into v;
  perform pg_temp.expect('11 batch undo count', jsonb_array_length(v -> 'undone')::text, '3');
  perform pg_temp.expect('11 statuses', pg_temp.statuses(pg_temp.r1()),
    'ready_for_release,ready_for_release,ready_for_release');
end $$;
select pg_temp.expect_error('11 malformed identities', 'a0000000-0000-4000-8000-000000000198',
  $q$select public.undo_visit_release('e0000000-0000-4000-8000-000000000198',
       '{f0000000-0000-4000-8000-000000000198}'::uuid[], null, '{"f0000000-0000-4000-8000-000000000198":"not a time"}'::jsonb, 'smoke198')$q$, 'P0081');

\echo '0198 smoke: all checks passed'
rollback;

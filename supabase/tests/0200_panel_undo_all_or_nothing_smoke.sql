-- =============================================================================
-- 0200_panel_undo_all_or_nothing_smoke.sql
-- =============================================================================
-- DB proof for migration 0200 (reclaim_panel_members / restore_panel_members).
-- Sequential only. Runs inside BEGIN/ROLLBACK and leaves no state. Self-
-- contained: mints its own auth users, staff, report group, services, patient,
-- two visits and the test_requests. reclaim runs as `authenticated` with a JWT
-- `sub` (invoker rights: RLS + 0190's holder guard apply); restore runs as
-- `service_role`, the way queue-restore-core.ts calls it.
--
-- Run (local stack, from the repo root, with 0200 applied):
--   psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0200_panel_undo_all_or_nothing_smoke.sql
--
-- What it proves:
--   1. reclaim: three requested/unassigned members → 3; each under ITS OWN
--      holder at the started_at passed; a null started_at becomes now().
--   2. one member already in progress → P0082, the other two untouched.
--   3. one member soft-deleted → P0082, nothing changed.
--   4. the visit soft-deleted → P0082, nothing changed.
--   5. a non-admin putting back someone else's claim → P0082 "own name"; the
--      medtech's own → 3; an admin putting back another medtech's → 3.
--   6. a holder whose role cannot work the section (reception) → P0075 from
--      0190's guard, nothing changed.
--   7. array length mismatch / empty / repeated id / null holder → P0082.
--   8. anon cannot execute reclaim (42501).
--   9. restore (service_role): three members deleted at T → 3, deleted_at /
--      deleted_by / delete_reason all cleared.
--  10. one member's deleted_at differs from the one passed → P0082, all three
--      still deleted at their own stamps.
--  11. the visit is deleted → P0082 with the visit message.
--  12. a member on another visit → P0082, nothing restored.
--  13. authenticated cannot execute restore (42501).
--  14. ACLs on both functions.
--  15. restore with a component member (parent_id not null) → P0082, nothing
--      restored (components ride their header's cascade, 0125).
--  16. restore malformed input (length mismatch, empty, repeated id, null
--      deleted_at) → P0082.
--  17. reclaim where a member is still 'requested' but has a holder → P0082
--      (status alone must not mask it).
--  18. reclaim with a started_at in the future → P0082.
--  19. an admin mid-View-as (effective role medtech) putting back another
--      medtech's claim → P0082 "own name".
-- =============================================================================

begin;

-- fixtures --------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000200', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke200-medtech@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000200', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke200-medtech2@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000200', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke200-admin@example.test', '', now(), now(), now()),
  ('a3000000-0000-4000-8000-000000000200', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke200-reception@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active) values
  ('a0000000-0000-4000-8000-000000000200', 'Smoke200 Medtech',   'medtech',   true),
  ('a1000000-0000-4000-8000-000000000200', 'Smoke200 Medtech 2', 'medtech',   true),
  ('a2000000-0000-4000-8000-000000000200', 'Smoke200 Admin',     'admin',     true),
  ('a3000000-0000-4000-8000-000000000200', 'Smoke200 Reception', 'reception', true);

insert into public.report_groups (id, code, name)
values ('b0000000-0000-4000-8000-000000000200', 'SMK200', 'Smoke200 Chemistry');

insert into public.services (id, code, name, price_php, kind, section, report_group_id) values
  ('c0000000-0000-4000-8000-000000000200', 'SMK200-A', 'Smoke200 A', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000200'),
  ('c1000000-0000-4000-8000-000000000200', 'SMK200-B', 'Smoke200 B', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000200'),
  ('c2000000-0000-4000-8000-000000000200', 'SMK200-C', 'Smoke200 C', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000200');

insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values ('d0000000-0000-4000-8000-000000000200', 'DRM-SMK200', 'Smoke200', 'Patient', '1990-01-01', 'female');

insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php) values
  ('e0000000-0000-4000-8000-000000000200', 'V-SMK200', 'd0000000-0000-4000-8000-000000000200',
   (now() at time zone 'Asia/Manila')::date, 'unpaid', 0, 0),
  ('e1000000-0000-4000-8000-000000000200', 'V-SMK200B', 'd0000000-0000-4000-8000-000000000200',
   (now() at time zone 'Asia/Manila')::date, 'unpaid', 0, 0);

insert into public.test_requests (id, visit_id, service_id, requested_by, status) values
  ('f0000000-0000-4000-8000-000000000200', 'e0000000-0000-4000-8000-000000000200', 'c0000000-0000-4000-8000-000000000200', 'a0000000-0000-4000-8000-000000000200', 'requested'),
  ('f1000000-0000-4000-8000-000000000200', 'e0000000-0000-4000-8000-000000000200', 'c1000000-0000-4000-8000-000000000200', 'a0000000-0000-4000-8000-000000000200', 'requested'),
  ('f2000000-0000-4000-8000-000000000200', 'e0000000-0000-4000-8000-000000000200', 'c2000000-0000-4000-8000-000000000200', 'a0000000-0000-4000-8000-000000000200', 'requested'),
  -- a package header + its component on the first visit (case 15)
  ('f4000000-0000-4000-8000-000000000200', 'e0000000-0000-4000-8000-000000000200', 'c0000000-0000-4000-8000-000000000200', 'a0000000-0000-4000-8000-000000000200', 'requested'),
  -- a line on the OTHER visit (case 12)
  ('f3000000-0000-4000-8000-000000000200', 'e1000000-0000-4000-8000-000000000200', 'c0000000-0000-4000-8000-000000000200', 'a0000000-0000-4000-8000-000000000200', 'requested');

update public.test_requests set is_package_header = true where id = 'f4000000-0000-4000-8000-000000000200';
insert into public.test_requests (id, visit_id, service_id, requested_by, status, parent_id) values
  ('f5000000-0000-4000-8000-000000000200', 'e0000000-0000-4000-8000-000000000200', 'c1000000-0000-4000-8000-000000000200', 'a0000000-0000-4000-8000-000000000200', 'requested', 'f4000000-0000-4000-8000-000000000200');

-- helpers ---------------------------------------------------------------------

create or replace function pg_temp.ids() returns uuid[] language sql immutable as $$
  select array['f0000000-0000-4000-8000-000000000200',
               'f1000000-0000-4000-8000-000000000200',
               'f2000000-0000-4000-8000-000000000200']::uuid[]
$$;

-- "status:holder[:D]" for the three members, in id order (D = soft-deleted).
create or replace function pg_temp.states() returns text language sql as $$
  select string_agg(status || ':' || coalesce(left(assigned_to::text, 2), '-')
                    || case when deleted_at is not null then ':D' else '' end, ',' order by id)
    from public.test_requests where id = any (pg_temp.ids());
$$;

create or replace function pg_temp.expect(p_label text, p_want text) returns void
language plpgsql as $$
declare v_got text := pg_temp.states();
begin
  if v_got is distinct from p_want then
    raise exception 'FAIL: %: expected [%], got [%]', p_label, p_want, v_got;
  end if;
  raise notice '% ok: %', p_label, v_got;
end $$;

-- Back to the starting state: three requested, unassigned, live members on a
-- live visit, no started_at.
create or replace function pg_temp.reset() returns void language plpgsql as $$
begin
  update public.visits set deleted_at = null, deleted_by = null, delete_reason = null
   where id in ('e0000000-0000-4000-8000-000000000200', 'e1000000-0000-4000-8000-000000000200');
  update public.test_requests
     set status = 'requested', assigned_to = null, started_at = null,
         deleted_at = null, deleted_by = null, delete_reason = null
   where id = any (pg_temp.ids()) or id in ('f3000000-0000-4000-8000-000000000200', 'f4000000-0000-4000-8000-000000000200', 'f5000000-0000-4000-8000-000000000200');
end $$;

-- Switch to a runtime role the way the app's clients do. p_role is
-- authenticated (with a JWT sub), service_role or anon.
create or replace function pg_temp.become(p_role text, p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then json_build_object('role', p_role)::text
         else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  execute format('set local role %I', p_role);
end $$;

-- Run p_sql as p_role/p_user; return its integer result.
create or replace function pg_temp.run_as(p_role text, p_user uuid, p_sql text) returns integer
language plpgsql as $$
declare v_n integer;
begin
  perform pg_temp.become(p_role, p_user);
  execute p_sql into v_n;
  execute 'reset role';
  return v_n;
end $$;

-- Run p_sql as p_role/p_user and assert it raises p_state with a message
-- containing p_like. p_sql may only call public functions (pg_temp helpers are
-- not executable by the runtime roles) — the ids are inlined.
create or replace function pg_temp.expect_err(p_label text, p_role text, p_user uuid,
                                              p_state text, p_like text, p_sql text) returns void
language plpgsql as $$
declare v_state text; v_msg text;
begin
  perform pg_temp.become(p_role, p_user);
  begin
    execute p_sql;
    execute 'reset role';
    raise exception 'FAIL: %: expected %, call succeeded', p_label, p_state;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_state := sqlstate;
    execute 'reset role';
    if v_msg like 'FAIL: %' then raise exception '%', v_msg; end if;
    if v_state <> p_state or position(p_like in v_msg) = 0 then
      raise exception 'FAIL: %: expected % containing [%], got % [%]', p_label, p_state, p_like, v_state, v_msg;
    end if;
    raise notice '% ok: % (%)', p_label, v_state, v_msg;
  end;
end $$;

-- 1. reclaim: per-member holders and started_at, null → now() -------------------
select pg_temp.reset();
do $$
declare n integer;
begin
  n := pg_temp.run_as('authenticated', 'a2000000-0000-4000-8000-000000000200',
    $q$select public.reclaim_panel_members(
         $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
         array['a0000000-0000-4000-8000-000000000200','a1000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
         array['2026-09-30 01:00:00+00','2026-09-30 02:00:00+00',null]::timestamptz[])$q$);
  if n <> 3 then raise exception 'FAIL: 1: expected 3 put back, got %', n; end if;
  perform pg_temp.expect('1 reclaim', 'in_progress:a0,in_progress:a1,in_progress:a0');
  if (select started_at from public.test_requests where id = 'f0000000-0000-4000-8000-000000000200') <> '2026-09-30 01:00:00+00'
     or (select started_at from public.test_requests where id = 'f1000000-0000-4000-8000-000000000200') <> '2026-09-30 02:00:00+00'
     or (select started_at from public.test_requests where id = 'f2000000-0000-4000-8000-000000000200') is distinct from now() then
    raise exception 'FAIL: 1: started_at not restored as passed (null → now())';
  end if;
end $$;

-- 2. one member already in progress → P0082, rolled back ------------------------
select pg_temp.reset();
update public.test_requests set status = 'in_progress', assigned_to = 'a1000000-0000-4000-8000-000000000200'
 where id = 'f1000000-0000-4000-8000-000000000200';
select pg_temp.expect_err('2 partial reclaim', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'nothing was put back',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,null]::timestamptz[])$q$);
select pg_temp.expect('2 others untouched', 'requested:-,in_progress:a1,requested:-');
do $$ begin
  if exists (select 1 from public.test_requests where id in ('f0000000-0000-4000-8000-000000000200','f2000000-0000-4000-8000-000000000200') and started_at is not null) then
    raise exception 'FAIL: 2: a rolled-back member kept its started_at';
  end if;
end $$;

-- 3. one member soft-deleted → P0082 --------------------------------------------
select pg_temp.reset();
update public.test_requests set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000200', delete_reason = 'smoke'
 where id = 'f1000000-0000-4000-8000-000000000200';
select pg_temp.expect_err('3 deleted member', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'nothing was put back',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,null]::timestamptz[])$q$);
select pg_temp.expect('3 nothing changed', 'requested:-,requested:-:D,requested:-');

-- 4. the visit soft-deleted → P0082 ---------------------------------------------
select pg_temp.reset();
update public.visits set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000200', delete_reason = 'smoke'
 where id = 'e0000000-0000-4000-8000-000000000200';
select pg_temp.expect_err('4 deleted visit', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'nothing was put back',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,null]::timestamptz[])$q$);
select pg_temp.expect('4 nothing changed', 'requested:-,requested:-,requested:-');

-- 5. who may put back whose ------------------------------------------------------
select pg_temp.reset();
select pg_temp.expect_err('5 non-admin, not own', 'authenticated', 'a0000000-0000-4000-8000-000000000200', 'P0082', 'own name',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a1000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,null]::timestamptz[])$q$);
select pg_temp.expect('5 nothing changed', 'requested:-,requested:-,requested:-');
do $$
declare n integer;
begin
  n := pg_temp.run_as('authenticated', 'a0000000-0000-4000-8000-000000000200',
    $q$select public.reclaim_panel_members(
         $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
         array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
         array[null,null,null]::timestamptz[])$q$);
  if n <> 3 then raise exception 'FAIL: 5: medtech own claims: expected 3, got %', n; end if;
  perform pg_temp.expect('5 medtech puts back own', 'in_progress:a0,in_progress:a0,in_progress:a0');
end $$;
select pg_temp.reset();
do $$
declare n integer;
begin
  n := pg_temp.run_as('authenticated', 'a2000000-0000-4000-8000-000000000200',
    $q$select public.reclaim_panel_members(
         $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
         array['a1000000-0000-4000-8000-000000000200','a1000000-0000-4000-8000-000000000200','a1000000-0000-4000-8000-000000000200']::uuid[],
         array[null,null,null]::timestamptz[])$q$);
  if n <> 3 then raise exception 'FAIL: 5: admin putting back another medtech''s: expected 3, got %', n; end if;
  perform pg_temp.expect('5 admin puts back another''s', 'in_progress:a1,in_progress:a1,in_progress:a1');
end $$;

-- 6. a holder whose role cannot work the section → P0075 (0190 guard) ------------
select pg_temp.reset();
select pg_temp.expect_err('6 reception holder', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0075', 'section',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a3000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,null]::timestamptz[])$q$);
select pg_temp.expect('6 nothing changed', 'requested:-,requested:-,requested:-');

-- 7. malformed input → P0082 -----------------------------------------------------
select pg_temp.reset();
select pg_temp.expect_err('7 holders length mismatch', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'refresh the queue',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,null]::timestamptz[])$q$);
select pg_temp.expect_err('7 started_at length mismatch', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'refresh the queue',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null]::timestamptz[])$q$);
select pg_temp.expect_err('7 empty arrays', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'Nothing to put back',
  $q$select public.reclaim_panel_members('{}'::uuid[], '{}'::uuid[], '{}'::timestamptz[])$q$);
select pg_temp.expect_err('7 repeated id', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'Nothing to put back',
  $q$select public.reclaim_panel_members(
       array['f0000000-0000-4000-8000-000000000200','f0000000-0000-4000-8000-000000000200']::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null]::timestamptz[])$q$);
select pg_temp.expect_err('7 null holder', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'Nothing to put back',
  $q$select public.reclaim_panel_members(
       array['f0000000-0000-4000-8000-000000000200','f1000000-0000-4000-8000-000000000200']::uuid[],
       array['a0000000-0000-4000-8000-000000000200',null]::uuid[],
       array[null,null]::timestamptz[])$q$);
select pg_temp.expect('7 nothing changed', 'requested:-,requested:-,requested:-');

-- 8. anon cannot run reclaim ------------------------------------------------------
select pg_temp.expect_err('8 anon reclaim', 'anon', null, '42501', 'permission denied for function',
  $q$select public.reclaim_panel_members(
       array['f0000000-0000-4000-8000-000000000200']::uuid[],
       array['a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null]::timestamptz[])$q$);

-- 9. restore: three members deleted at T → restored whole -------------------------
select pg_temp.reset();
update public.test_requests
   set deleted_at = '2026-09-30 03:00:00+00', deleted_by = 'a0000000-0000-4000-8000-000000000200', delete_reason = 'smoke delete'
 where id = any (pg_temp.ids());
select pg_temp.expect('9 before', 'requested:-:D,requested:-:D,requested:-:D');
do $$
declare n integer;
begin
  n := pg_temp.run_as('service_role', null,
    $q$select public.restore_panel_members(
         'e0000000-0000-4000-8000-000000000200'::uuid,
         $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
         array['2026-09-30 03:00:00+00','2026-09-30 03:00:00+00','2026-09-30 03:00:00+00']::timestamptz[])$q$);
  if n <> 3 then raise exception 'FAIL: 9: expected 3 restored, got %', n; end if;
  perform pg_temp.expect('9 restore', 'requested:-,requested:-,requested:-');
  if exists (select 1 from public.test_requests
              where id = any (pg_temp.ids())
                and (deleted_by is not null or delete_reason is not null or deleted_at is not null)) then
    raise exception 'FAIL: 9: deleted_by / delete_reason not cleared';
  end if;
end $$;

-- 10. one member deleted at a different stamp → P0082, all still deleted ----------
update public.test_requests
   set deleted_at = '2026-09-30 03:00:00+00', deleted_by = 'a0000000-0000-4000-8000-000000000200', delete_reason = 'smoke delete'
 where id = any (pg_temp.ids());
update public.test_requests set deleted_at = '2026-09-30 03:05:00+00'
 where id = 'f1000000-0000-4000-8000-000000000200';
select pg_temp.expect_err('10 stamp mismatch', 'service_role', null, 'P0082', 'nothing was restored',
  $q$select public.restore_panel_members(
       'e0000000-0000-4000-8000-000000000200'::uuid,
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['2026-09-30 03:00:00+00','2026-09-30 03:00:00+00','2026-09-30 03:00:00+00']::timestamptz[])$q$);
select pg_temp.expect('10 all still deleted', 'requested:-:D,requested:-:D,requested:-:D');
do $$ begin
  if (select deleted_at from public.test_requests where id = 'f0000000-0000-4000-8000-000000000200') <> '2026-09-30 03:00:00+00'
     or (select deleted_at from public.test_requests where id = 'f1000000-0000-4000-8000-000000000200') <> '2026-09-30 03:05:00+00'
     or (select delete_reason from public.test_requests where id = 'f0000000-0000-4000-8000-000000000200') is distinct from 'smoke delete' then
    raise exception 'FAIL: 10: a rolled-back member lost its deleted_at / reason';
  end if;
end $$;

-- 11. the visit is deleted → P0082 with the visit message -------------------------
update public.test_requests set deleted_at = '2026-09-30 03:00:00+00' where id = 'f1000000-0000-4000-8000-000000000200';
update public.visits set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000200', delete_reason = 'smoke'
 where id = 'e0000000-0000-4000-8000-000000000200';
select pg_temp.expect_err('11 deleted visit', 'service_role', null, 'P0082', 'visit itself is deleted',
  $q$select public.restore_panel_members(
       'e0000000-0000-4000-8000-000000000200'::uuid,
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['2026-09-30 03:00:00+00','2026-09-30 03:00:00+00','2026-09-30 03:00:00+00']::timestamptz[])$q$);
select pg_temp.expect('11 all still deleted', 'requested:-:D,requested:-:D,requested:-:D');

-- 12. a member on another visit → P0082, nothing restored -------------------------
update public.visits set deleted_at = null, deleted_by = null, delete_reason = null
 where id = 'e0000000-0000-4000-8000-000000000200';
update public.test_requests
   set deleted_at = '2026-09-30 03:00:00+00', deleted_by = 'a0000000-0000-4000-8000-000000000200', delete_reason = 'smoke delete'
 where id = 'f3000000-0000-4000-8000-000000000200';
select pg_temp.expect_err('12 member on another visit', 'service_role', null, 'P0082', 'nothing was restored',
  $q$select public.restore_panel_members(
       'e0000000-0000-4000-8000-000000000200'::uuid,
       array['f0000000-0000-4000-8000-000000000200','f1000000-0000-4000-8000-000000000200','f3000000-0000-4000-8000-000000000200']::uuid[],
       array['2026-09-30 03:00:00+00','2026-09-30 03:00:00+00','2026-09-30 03:00:00+00']::timestamptz[])$q$);
select pg_temp.expect('12 nothing restored', 'requested:-:D,requested:-:D,requested:-:D');
do $$ begin
  if (select deleted_at from public.test_requests where id = 'f3000000-0000-4000-8000-000000000200') is null then
    raise exception 'FAIL: 12: the other visit''s line was restored';
  end if;
end $$;

-- 13. authenticated cannot run restore ---------------------------------------------
select pg_temp.expect_err('13 authenticated restore', 'authenticated', 'a2000000-0000-4000-8000-000000000200', '42501', 'permission denied for function',
  $q$select public.restore_panel_members(
       'e0000000-0000-4000-8000-000000000200'::uuid,
       array['f0000000-0000-4000-8000-000000000200']::uuid[],
       array['2026-09-30 03:00:00+00']::timestamptz[])$q$);
select pg_temp.expect('13 nothing restored', 'requested:-:D,requested:-:D,requested:-:D');

-- 15. restore with a component member → P0082, nothing restored -----------------
select pg_temp.reset();
update public.test_requests
   set deleted_at = '2026-09-30 03:00:00+00', deleted_by = 'a0000000-0000-4000-8000-000000000200', delete_reason = 'smoke delete'
 where id in ('f0000000-0000-4000-8000-000000000200', 'f1000000-0000-4000-8000-000000000200', 'f4000000-0000-4000-8000-000000000200');
-- a component cannot be deleted on its own (P0044): deleting its header cascades
-- the same deleted_at / reason to it.
do $$ begin
  if (select deleted_at from public.test_requests where id = 'f5000000-0000-4000-8000-000000000200') is distinct from '2026-09-30 03:00:00+00'::timestamptz then
    raise exception 'FAIL: 15: fixture — the header delete did not cascade to the component';
  end if;
end $$;
select pg_temp.expect_err('15 component member', 'service_role', null, 'P0082', 'nothing was restored',
  $q$select public.restore_panel_members(
       'e0000000-0000-4000-8000-000000000200'::uuid,
       array['f0000000-0000-4000-8000-000000000200','f1000000-0000-4000-8000-000000000200','f5000000-0000-4000-8000-000000000200']::uuid[],
       array['2026-09-30 03:00:00+00','2026-09-30 03:00:00+00','2026-09-30 03:00:00+00']::timestamptz[])$q$);
select pg_temp.expect('15 nothing restored', 'requested:-:D,requested:-:D,requested:-');
do $$ begin
  if (select deleted_at from public.test_requests where id = 'f5000000-0000-4000-8000-000000000200') is null then
    raise exception 'FAIL: 15: the component was restored';
  end if;
end $$;

-- 16. restore malformed input → P0082 ---------------------------------------------
select pg_temp.expect_err('16 length mismatch', 'service_role', null, 'P0082', 'refresh the queue',
  $q$select public.restore_panel_members(
       'e0000000-0000-4000-8000-000000000200'::uuid,
       array['f0000000-0000-4000-8000-000000000200','f1000000-0000-4000-8000-000000000200']::uuid[],
       array['2026-09-30 03:00:00+00']::timestamptz[])$q$);
select pg_temp.expect_err('16 empty arrays', 'service_role', null, 'P0082', 'Nothing to restore',
  $q$select public.restore_panel_members('e0000000-0000-4000-8000-000000000200'::uuid, '{}'::uuid[], '{}'::timestamptz[])$q$);
select pg_temp.expect_err('16 repeated id', 'service_role', null, 'P0082', 'Nothing to restore',
  $q$select public.restore_panel_members(
       'e0000000-0000-4000-8000-000000000200'::uuid,
       array['f0000000-0000-4000-8000-000000000200','f0000000-0000-4000-8000-000000000200']::uuid[],
       array['2026-09-30 03:00:00+00','2026-09-30 03:00:00+00']::timestamptz[])$q$);
select pg_temp.expect_err('16 null deleted_at', 'service_role', null, 'P0082', 'Nothing to restore',
  $q$select public.restore_panel_members(
       'e0000000-0000-4000-8000-000000000200'::uuid,
       array['f0000000-0000-4000-8000-000000000200','f1000000-0000-4000-8000-000000000200']::uuid[],
       array['2026-09-30 03:00:00+00',null]::timestamptz[])$q$);
select pg_temp.expect('16 nothing restored', 'requested:-:D,requested:-:D,requested:-');

-- 17. reclaim: a member is 'requested' but still has a holder → P0082 ---------------
select pg_temp.reset();
update public.test_requests set assigned_to = 'a1000000-0000-4000-8000-000000000200'
 where id = 'f1000000-0000-4000-8000-000000000200';
select pg_temp.expect('17 before', 'requested:-,requested:a1,requested:-');
select pg_temp.expect_err('17 requested but held', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'nothing was put back',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,null]::timestamptz[])$q$);
select pg_temp.expect('17 nothing changed', 'requested:-,requested:a1,requested:-');

-- 18. reclaim with a future started_at → P0082 -------------------------------------
select pg_temp.reset();
select pg_temp.expect_err('18 future started_at', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'Nothing to put back',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200','a0000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,now() + interval '1 day']::timestamptz[])$q$);
select pg_temp.expect('18 nothing changed', 'requested:-,requested:-,requested:-');

-- 19. an admin mid-View-as (effective role medtech) is not an admin here -------------
update public.staff_profiles
   set view_as_role = 'medtech', view_as_until = now() + interval '1 hour'
 where id = 'a2000000-0000-4000-8000-000000000200';
select pg_temp.reset();
select pg_temp.expect_err('19 admin viewing as medtech', 'authenticated', 'a2000000-0000-4000-8000-000000000200', 'P0082', 'own name',
  $q$select public.reclaim_panel_members(
       $a${f0000000-0000-4000-8000-000000000200,f1000000-0000-4000-8000-000000000200,f2000000-0000-4000-8000-000000000200}$a$::uuid[],
       array['a1000000-0000-4000-8000-000000000200','a1000000-0000-4000-8000-000000000200','a1000000-0000-4000-8000-000000000200']::uuid[],
       array[null,null,null]::timestamptz[])$q$);
select pg_temp.expect('19 nothing changed', 'requested:-,requested:-,requested:-');
update public.staff_profiles set view_as_role = null, view_as_until = null
 where id = 'a2000000-0000-4000-8000-000000000200';

-- 14. ACLs --------------------------------------------------------------------------
do $$
declare f text;
begin
  f := 'public.reclaim_panel_members(uuid[],uuid[],timestamptz[])';
  if has_function_privilege('anon', f, 'execute') then raise exception 'FAIL: 14: anon CAN execute %', f; end if;
  if not has_function_privilege('authenticated', f, 'execute') then raise exception 'FAIL: 14: authenticated cannot execute %', f; end if;
  if not has_function_privilege('service_role', f, 'execute') then raise exception 'FAIL: 14: service_role cannot execute %', f; end if;
  f := 'public.restore_panel_members(uuid,uuid[],timestamptz[])';
  if has_function_privilege('anon', f, 'execute') then raise exception 'FAIL: 14: anon CAN execute %', f; end if;
  if has_function_privilege('authenticated', f, 'execute') then raise exception 'FAIL: 14: authenticated CAN execute %', f; end if;
  if not has_function_privilege('service_role', f, 'execute') then raise exception 'FAIL: 14: service_role cannot execute %', f; end if;
  raise notice '14 ACLs ok';
end $$;

rollback;

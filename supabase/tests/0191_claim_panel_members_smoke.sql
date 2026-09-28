-- =============================================================================
-- 0191_claim_panel_members_smoke.sql
-- =============================================================================
-- DB proof for migration 0191 (claim_panel_members / unclaim_panel_members).
-- Runs inside BEGIN/ROLLBACK and leaves no state. Self-contained: mints its
-- own auth users, staff, report group, services, patient, visit and
-- test_requests. Calls run as `authenticated` with a JWT `sub`, the way the
-- staff server client calls them (invoker rights: RLS applies).
--
-- Run (local stack, from the repo root, with 0191 applied):
--   /opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0191_claim_panel_members_smoke.sql
--
-- What it proves:
--   1. A medtech claims a whole 3-test panel: all three in_progress, held by
--      the caller (auth.uid()).
--   2. The holder hands it back whole: all three requested, unassigned,
--      started_at cleared.
--   3. One member already held by someone else → P0077 and NOTHING claimed
--      (the other two stay requested — the UPDATE rolled back).
--   4. A non-admin cannot hand back someone else's panel → P0077.
--   5. A stale holder (the operator saw A, B holds it now) → P0077, nothing
--      handed back.
--   6. An admin hands back anyone's panel.
--   7. One member moved on mid-unclaim → P0077, nothing handed back.
--   8. ACLs: authenticated + service_role may execute; anon and PUBLIC may not.
-- =============================================================================

begin;

-- fixtures --------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000191', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke191-medtech@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000191', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke191-pathologist@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000191', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke191-admin@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active) values
  ('a0000000-0000-4000-8000-000000000191', 'Smoke191 Medtech',     'medtech',     true),
  ('a1000000-0000-4000-8000-000000000191', 'Smoke191 Pathologist', 'pathologist', true),
  ('a2000000-0000-4000-8000-000000000191', 'Smoke191 Admin',       'admin',       true);

insert into public.report_groups (id, code, name)
values ('b0000000-0000-4000-8000-000000000191', 'SMK191', 'Smoke191 Chemistry');

insert into public.services (id, code, name, price_php, kind, section, report_group_id) values
  ('c0000000-0000-4000-8000-000000000191', 'SMK191-A', 'Smoke191 A', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000191'),
  ('c1000000-0000-4000-8000-000000000191', 'SMK191-B', 'Smoke191 B', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000191'),
  ('c2000000-0000-4000-8000-000000000191', 'SMK191-C', 'Smoke191 C', 100, 'lab_test', 'chemistry', 'b0000000-0000-4000-8000-000000000191');

insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values ('d0000000-0000-4000-8000-000000000191', 'DRM-SMK191', 'Smoke191', 'Patient', '1990-01-01', 'female');

insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
values ('e0000000-0000-4000-8000-000000000191', 'V-SMK191', 'd0000000-0000-4000-8000-000000000191',
        (now() at time zone 'Asia/Manila')::date, 'unpaid', 0, 0);

insert into public.test_requests (id, visit_id, service_id, requested_by, status) values
  ('f0000000-0000-4000-8000-000000000191', 'e0000000-0000-4000-8000-000000000191', 'c0000000-0000-4000-8000-000000000191', 'a0000000-0000-4000-8000-000000000191', 'requested'),
  ('f1000000-0000-4000-8000-000000000191', 'e0000000-0000-4000-8000-000000000191', 'c1000000-0000-4000-8000-000000000191', 'a0000000-0000-4000-8000-000000000191', 'requested'),
  ('f2000000-0000-4000-8000-000000000191', 'e0000000-0000-4000-8000-000000000191', 'c2000000-0000-4000-8000-000000000191', 'a0000000-0000-4000-8000-000000000191', 'requested');

-- helpers ---------------------------------------------------------------------

create or replace function pg_temp.ids() returns uuid[] language sql immutable as $$
  select array['f0000000-0000-4000-8000-000000000191',
               'f1000000-0000-4000-8000-000000000191',
               'f2000000-0000-4000-8000-000000000191']::uuid[]
$$;

-- "status:holder" for the three members, in id order.
create or replace function pg_temp.states() returns text language sql as $$
  select string_agg(status || ':' || coalesce(left(assigned_to::text, 2), '-'), ',' order by id)
    from public.test_requests where id = any (pg_temp.ids());
$$;

create or replace function pg_temp.expect(p_label text, p_want text) returns void
language plpgsql as $$
declare v_got text := pg_temp.states();
begin
  if v_got is distinct from p_want then
    raise exception '%: expected [%], got [%]', p_label, p_want, v_got;
  end if;
  raise notice '% ok: %', p_label, v_got;
end $$;

-- Run p_sql as an authenticated staff member; assert it raises P0077. p_sql
-- runs AS authenticated, so it may only call public functions (pg_temp
-- helpers are not executable by that role) — the ids are inlined.
create or replace function pg_temp.expect_p0077(p_label text, p_user uuid, p_sql text) returns void
language plpgsql as $$
declare v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql;
    execute 'reset role';
    raise exception '%: expected P0077, call succeeded', p_label;
  exception when sqlstate 'P0077' then
    get stacked diagnostics v_msg = message_text;
    execute 'reset role';
    raise notice '% ok: refused with P0077 (%)', p_label, v_msg;
  end;
end $$;

create or replace function pg_temp.run_as(p_user uuid, p_sql text) returns integer
language plpgsql as $$
declare v_n integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute p_sql into v_n;
  execute 'reset role';
  return v_n;
end $$;

-- 1. claim the whole panel ------------------------------------------------------
do $$
declare n integer;
begin
  n := pg_temp.run_as('a0000000-0000-4000-8000-000000000191',
    'select public.claim_panel_members($a${f0000000-0000-4000-8000-000000000191,f1000000-0000-4000-8000-000000000191,f2000000-0000-4000-8000-000000000191}$a$::uuid[])');
  if n <> 3 then raise exception '1: expected 3 claimed, got %', n; end if;
  perform pg_temp.expect('1 claim', 'in_progress:a0,in_progress:a0,in_progress:a0');
end $$;

-- 2. hand it back whole ---------------------------------------------------------
do $$
declare n integer;
begin
  n := pg_temp.run_as('a0000000-0000-4000-8000-000000000191',
    $q$select public.unclaim_panel_members($a${f0000000-0000-4000-8000-000000000191,f1000000-0000-4000-8000-000000000191,f2000000-0000-4000-8000-000000000191}$a$::uuid[], 'a0000000-0000-4000-8000-000000000191')$q$);
  if n <> 3 then raise exception '2: expected 3 handed back, got %', n; end if;
  perform pg_temp.expect('2 unclaim', 'requested:-,requested:-,requested:-');
  if exists (select 1 from public.test_requests where id = any (pg_temp.ids()) and started_at is not null) then
    raise exception '2: started_at not cleared';
  end if;
end $$;

-- 3. one member already held elsewhere → nothing claimed ------------------------
update public.test_requests set status = 'in_progress', assigned_to = 'a1000000-0000-4000-8000-000000000191'
 where id = 'f0000000-0000-4000-8000-000000000191';
select pg_temp.expect_p0077('3 partial claim', 'a0000000-0000-4000-8000-000000000191',
  'select public.claim_panel_members($a${f0000000-0000-4000-8000-000000000191,f1000000-0000-4000-8000-000000000191,f2000000-0000-4000-8000-000000000191}$a$::uuid[])');
select pg_temp.expect('3 nothing claimed', 'in_progress:a1,requested:-,requested:-');

-- 4. non-admin cannot hand back someone else's panel ----------------------------
update public.test_requests set status = 'in_progress', assigned_to = 'a1000000-0000-4000-8000-000000000191'
 where id = any (pg_temp.ids());
select pg_temp.expect_p0077('4 not the holder', 'a0000000-0000-4000-8000-000000000191',
  $q$select public.unclaim_panel_members($a${f0000000-0000-4000-8000-000000000191,f1000000-0000-4000-8000-000000000191,f2000000-0000-4000-8000-000000000191}$a$::uuid[], 'a1000000-0000-4000-8000-000000000191')$q$);
select pg_temp.expect('4 still held', 'in_progress:a1,in_progress:a1,in_progress:a1');

-- 5. stale holder → nothing handed back -----------------------------------------
select pg_temp.expect_p0077('5 stale holder', 'a2000000-0000-4000-8000-000000000191',
  $q$select public.unclaim_panel_members($a${f0000000-0000-4000-8000-000000000191,f1000000-0000-4000-8000-000000000191,f2000000-0000-4000-8000-000000000191}$a$::uuid[], 'a0000000-0000-4000-8000-000000000191')$q$);
select pg_temp.expect('5 still held', 'in_progress:a1,in_progress:a1,in_progress:a1');

-- 6. admin hands back anyone's panel --------------------------------------------
do $$
declare n integer;
begin
  n := pg_temp.run_as('a2000000-0000-4000-8000-000000000191',
    $q$select public.unclaim_panel_members($a${f0000000-0000-4000-8000-000000000191,f1000000-0000-4000-8000-000000000191,f2000000-0000-4000-8000-000000000191}$a$::uuid[], 'a1000000-0000-4000-8000-000000000191')$q$);
  if n <> 3 then raise exception '6: expected 3 handed back, got %', n; end if;
  perform pg_temp.expect('6 admin unclaim', 'requested:-,requested:-,requested:-');
end $$;

-- 7. one member moved on mid-unclaim → nothing handed back ----------------------
update public.test_requests set status = 'in_progress', assigned_to = 'a0000000-0000-4000-8000-000000000191'
 where id in ('f0000000-0000-4000-8000-000000000191', 'f2000000-0000-4000-8000-000000000191');
select pg_temp.expect_p0077('7 partial unclaim', 'a0000000-0000-4000-8000-000000000191',
  $q$select public.unclaim_panel_members($a${f0000000-0000-4000-8000-000000000191,f1000000-0000-4000-8000-000000000191,f2000000-0000-4000-8000-000000000191}$a$::uuid[], 'a0000000-0000-4000-8000-000000000191')$q$);
select pg_temp.expect('7 nothing handed back', 'in_progress:a0,requested:-,in_progress:a0');

-- 8. ACLs -----------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.claim_panel_members(uuid[])', 'public.unclaim_panel_members(uuid[], uuid)'] loop
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '8: authenticated cannot execute %', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception '8: service_role cannot execute %', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then
      raise exception '8: anon CAN execute %', f;
    end if;
  end loop;
  raise notice '8 ACLs ok';
end $$;

rollback;

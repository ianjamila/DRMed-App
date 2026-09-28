-- =============================================================================
-- 0190_claim_holder_guard_smoke.sql
-- =============================================================================
-- DB proof for migration 0190 (claim-holder guard + view_as_end_for). Runs
-- inside BEGIN/ROLLBACK and leaves no state. Self-contained: mints its own
-- auth users, staff, services, patient, visit and test_requests.
--
-- Run (local stack, from the repo root):
--   /opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0190_claim_holder_guard_smoke.sql
--
-- What it proves:
--   A. test_requests_claim_holder_guard (P0075, two distinct messages):
--      1.  xray_technician may hold an x-ray line.
--      2.  medtech may NOT hold an x-ray line — medtech's section list does
--          not include imaging_xray, so this is the SECTION-SCOPE message,
--          same as reception's.
--      3.  reception may NOT hold an x-ray line (reception's section scope is
--          empty) — SECTION-SCOPE message.
--      4.  pathologist may NOT hold an x-ray line — unrestricted by section,
--          so this one reaches the single-OWNER-rule message.
--      5.  a genuine admin (no active View-as override) may NOT hold an
--          x-ray line either — same OWNER message; the owner rule is not
--          lifted by being unrestricted.
--      6.  an admin VIEWING AS xray_technician MAY hold an x-ray line — the
--          holder's EFFECTIVE role (0182) passes the owner check.
--      7.  an INACTIVE xray_technician may not hold anything.
--      8.  medtech may hold a chemistry line.
--      9.  reception may NOT hold a chemistry line.
--      10. unclaiming (assigned_to -> null) is always allowed, regardless of
--          who held the line.
--      11. changing another column on a line already held by a
--          now-disallowed holder does not raise (the trigger only re-judges
--          the moment the holder itself changes).
--      12. reassigning an already-claimed line to a disallowed holder raises,
--          same as claiming fresh.
--      13. the rule fires for service_role too, not only ordinary sessions.
--   B. view_as_end_for (P0076):
--      14. admin B ends admin A's active reception override: returns true,
--          A's view_as_role/until are cleared, and exactly one audit row
--          (actor_id=B, resource_type=staff_profile, resource_id=A,
--          reason=ended_by_admin) is written.
--      15. a second call for the same target returns false and writes
--          nothing more.
--      16. a target with an EXPIRED override, and a target with NO override,
--          both return false and write nothing.
--      17. an actor who is themselves simulating is refused P0076.
--      18. a non-admin actor is refused P0076.
--   C. ACLs: anon/authenticated cannot execute either function; service_role
--      can.
-- =============================================================================

begin;

-- fixtures --------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-admin-a@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-admin-b@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-xray@example.test', '', now(), now(), now()),
  ('a3000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-medtech@example.test', '', now(), now(), now()),
  ('a4000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-reception@example.test', '', now(), now(), now()),
  ('a5000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-pathologist@example.test', '', now(), now(), now()),
  ('a6000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-admin-viewas@example.test', '', now(), now(), now()),
  ('a7000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-xray-inactive@example.test', '', now(), now(), now()),
  ('a8000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-admin-simulating@example.test', '', now(), now(), now()),
  ('a9000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-admin-expired@example.test', '', now(), now(), now()),
  ('aa000000-0000-4000-8000-000000000190', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke190-admin-nooverride@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active) values
  ('a0000000-0000-4000-8000-000000000190', 'Smoke190 Admin A',        'admin',           true),
  ('a1000000-0000-4000-8000-000000000190', 'Smoke190 Admin B',        'admin',           true),
  ('a2000000-0000-4000-8000-000000000190', 'Smoke190 Xray',           'xray_technician', true),
  ('a3000000-0000-4000-8000-000000000190', 'Smoke190 Medtech',        'medtech',         true),
  ('a4000000-0000-4000-8000-000000000190', 'Smoke190 Reception',      'reception',       true),
  ('a5000000-0000-4000-8000-000000000190', 'Smoke190 Pathologist',    'pathologist',     true),
  ('a6000000-0000-4000-8000-000000000190', 'Smoke190 Admin ViewAs',   'admin',           true),
  ('a7000000-0000-4000-8000-000000000190', 'Smoke190 Xray Inactive',  'xray_technician', false),
  ('a8000000-0000-4000-8000-000000000190', 'Smoke190 Admin Simulate', 'admin',           true),
  ('a9000000-0000-4000-8000-000000000190', 'Smoke190 Admin Expired',  'admin',           true),
  ('aa000000-0000-4000-8000-000000000190', 'Smoke190 Admin NoOvr',    'admin',           true);

insert into public.services (id, code, name, price_php, kind, section) values
  ('c0000000-0000-4000-8000-000000000190', 'SMK190-GLU', 'Smoke190 Glucose', 100, 'lab_test', 'chemistry'),
  ('c1000000-0000-4000-8000-000000000190', 'SMK190-XR',  'Smoke190 X-ray',   100, 'lab_test', 'imaging_xray');

insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values ('d0000000-0000-4000-8000-000000000190', 'DRM-SMK190', 'Smoke190', 'Patient', '1990-01-01', 'female');

insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
values ('e0000000-0000-4000-8000-000000000190', 'V-SMK190', 'd0000000-0000-4000-8000-000000000190',
        (now() at time zone 'Asia/Manila')::date, 'unpaid', 0, 0);

-- helper: assert that inserting/updating test_requests with the given
-- holder raises P0075; fails the smoke run (raises) if it does NOT. When
-- p_expect_msg is given, also asserts the exact message text — P0075 carries
-- TWO distinct sentences (section-scope/inactive-holder vs. single-owner),
-- and this is what tells them apart.
create or replace function pg_temp.expect_p0075(p_label text, p_sql text, p_expect_msg text default null) returns void
language plpgsql as $$
declare
  v_msg text;
begin
  execute p_sql;
  raise exception '%: expected P0075, insert/update succeeded', p_label;
exception
  when sqlstate 'P0075' then
    get stacked diagnostics v_msg = message_text;
    if p_expect_msg is not null and v_msg is distinct from p_expect_msg then
      raise exception '%: expected message [%], got [%]', p_label, p_expect_msg, v_msg;
    end if;
    raise notice '% ok: refused with P0075 (%)', p_label, v_msg;
end $$;

-- The section-scope / inactive-holder message, verbatim (single quotes are
-- doubled here only because this is itself a SQL string literal).
create or replace function pg_temp.section_scope_msg() returns text
language sql immutable as $$
  select 'This staff member doesn''t work this test''s section, so they can''t hold it.'
$$;

do $$
declare
  k_admin_a    constant uuid := 'a0000000-0000-4000-8000-000000000190';
  k_admin_b    constant uuid := 'a1000000-0000-4000-8000-000000000190';
  k_xray       constant uuid := 'a2000000-0000-4000-8000-000000000190';
  k_medtech    constant uuid := 'a3000000-0000-4000-8000-000000000190';
  k_reception  constant uuid := 'a4000000-0000-4000-8000-000000000190';
  k_patho      constant uuid := 'a5000000-0000-4000-8000-000000000190';
  k_admin_via  constant uuid := 'a6000000-0000-4000-8000-000000000190';
  k_xray_inact constant uuid := 'a7000000-0000-4000-8000-000000000190';
  k_admin_sim  constant uuid := 'a8000000-0000-4000-8000-000000000190';
  k_admin_exp  constant uuid := 'a9000000-0000-4000-8000-000000000190';
  k_admin_noov constant uuid := 'aa000000-0000-4000-8000-000000000190';
  s_chem       constant uuid := 'c0000000-0000-4000-8000-000000000190';
  s_xray       constant uuid := 'c1000000-0000-4000-8000-000000000190';
  v_visit      constant uuid := 'e0000000-0000-4000-8000-000000000190';
  v_tr_xray    uuid;
  v_tr_chem    uuid;
  v_tr_probe   uuid;
  v_bool       boolean;
  v_bool2      boolean;
  v_n          int;
  v_role       text;
  v_until      timestamptz;
  v_meta       jsonb;
begin
  -- T1 -----------------------------------------------------------------------
  insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php)
  values (v_visit, s_xray, 'in_progress', k_admin_a, k_xray, 100, 100)
  returning id into v_tr_xray;
  raise notice 'T1 ok: xray_technician holds an x-ray line';

  -- T2 -------------------------------------------------------------------------
  -- medtech's section list has no imaging_xray, so this is the SECTION-SCOPE
  -- message, same as reception's — never reaches the owner check.
  perform pg_temp.expect_p0075('T2 medtech/xray',
    format('insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php) values (%L, %L, %L, %L, %L, 100, 100)',
           v_visit, s_xray, 'in_progress', k_admin_a, k_medtech),
    pg_temp.section_scope_msg());

  -- T3 -------------------------------------------------------------------------
  perform pg_temp.expect_p0075('T3 reception/xray',
    format('insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php) values (%L, %L, %L, %L, %L, 100, 100)',
           v_visit, s_xray, 'in_progress', k_admin_a, k_reception),
    pg_temp.section_scope_msg());

  -- T4 -------------------------------------------------------------------------
  -- pathologist is UNRESTRICTED by section, so this one reaches the
  -- single-owner-rule message and names the actual owner role.
  perform pg_temp.expect_p0075('T4 pathologist/xray',
    format('insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php) values (%L, %L, %L, %L, %L, 100, 100)',
           v_visit, s_xray, 'in_progress', k_admin_a, k_patho),
    'Only an X-ray Technician can hold this test.');

  -- T5 -------------------------------------------------------------------------
  perform pg_temp.expect_p0075('T5 genuine admin/xray',
    format('insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php) values (%L, %L, %L, %L, %L, 100, 100)',
           v_visit, s_xray, 'in_progress', k_admin_a, k_admin_a),
    'Only an X-ray Technician can hold this test.');
  raise notice 'T2-T5 ok: only xray_technician (real or effective) may hold an x-ray line — the right message for each reason';

  -- T6 -------------------------------------------------------------------------
  update public.staff_profiles
     set view_as_role = 'xray_technician', view_as_until = now() + interval '1 hour'
   where id = k_admin_via;
  insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php)
  values (v_visit, s_xray, 'in_progress', k_admin_a, k_admin_via, 100, 100)
  returning id into v_tr_probe;
  raise notice 'T6 ok: an admin viewing as xray_technician may hold an x-ray line';

  -- T7 -------------------------------------------------------------------------
  perform pg_temp.expect_p0075('T7 inactive xray_technician',
    format('insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php) values (%L, %L, %L, %L, %L, 100, 100)',
           v_visit, s_xray, 'in_progress', k_admin_a, k_xray_inact),
    pg_temp.section_scope_msg());
  raise notice 'T7 ok: an inactive xray_technician may not hold anything';

  -- T8 -------------------------------------------------------------------------
  insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php)
  values (v_visit, s_chem, 'in_progress', k_admin_a, k_medtech, 100, 100)
  returning id into v_tr_chem;
  raise notice 'T8 ok: medtech holds a chemistry line';

  -- T9 -------------------------------------------------------------------------
  perform pg_temp.expect_p0075('T9 reception/chemistry',
    format('insert into public.test_requests (visit_id, service_id, status, requested_by, assigned_to, base_price_php, final_price_php) values (%L, %L, %L, %L, %L, 100, 100)',
           v_visit, s_chem, 'in_progress', k_admin_a, k_reception),
    pg_temp.section_scope_msg());
  raise notice 'T9 ok: reception may not hold a chemistry line';

  -- T10: unclaim is always allowed -------------------------------------------
  update public.test_requests set assigned_to = null where id = v_tr_chem;
  select assigned_to into v_role from public.test_requests where id = v_tr_chem;
  if v_role is not null then
    raise exception 'T10: expected assigned_to to be null after unclaim';
  end if;
  raise notice 'T10 ok: unclaiming is always allowed';

  -- T11: a line held by a NOW-DISALLOWED holder can have other columns
  -- changed without raising. Bootstrap the disallowed state by disabling the
  -- trigger, exactly as this fixture would have looked BEFORE 0190 existed.
  alter table public.test_requests disable trigger test_requests_claim_holder_guard;
  update public.test_requests set assigned_to = k_reception where id = v_tr_xray; -- reception now (wrongly) holds an x-ray line
  alter table public.test_requests enable trigger test_requests_claim_holder_guard;

  update public.test_requests set receptionist_remarks = 'smoke190 note' where id = v_tr_xray;
  select receptionist_remarks into v_role from public.test_requests where id = v_tr_xray;
  if v_role is distinct from 'smoke190 note' then
    raise exception 'T11: remarks update did not take effect';
  end if;
  raise notice 'T11 ok: changing another column on an already-disallowed holder does not raise';

  -- T12: reassigning that same (disallowed-holder) line to ANOTHER
  -- disallowed holder still raises — medtech's section list has no
  -- imaging_xray, so this is the SECTION-SCOPE message again.
  perform pg_temp.expect_p0075('T12 reassign to disallowed holder',
    format('update public.test_requests set assigned_to = %L where id = %L', k_medtech, v_tr_xray),
    pg_temp.section_scope_msg());
  raise notice 'T12 ok: reassigning to a disallowed holder raises';

  -- T13: the rule fires for service_role too. Reassign to a DIFFERENT
  -- disallowed holder than the line's current one (k_reception, left in
  -- place by T12's failed attempt) so the guard actually re-judges it.
  -- k_patho is unrestricted by section, so this one is the OWNER message.
  set role service_role;
  declare
    v_msg13 text;
  begin
    update public.test_requests set assigned_to = k_patho where id = v_tr_xray;
    raise exception 'T13: expected P0075 under service_role, update succeeded';
  exception
    when sqlstate 'P0075' then
      get stacked diagnostics v_msg13 = message_text;
      if v_msg13 is distinct from 'Only an X-ray Technician can hold this test.' then
        raise exception 'T13: unexpected message %', v_msg13;
      end if;
      raise notice 'T13 ok: service_role is subject to the guard too (%)', v_msg13;
  end;
  reset role;

  -- --------------------------------------------------------------------------
  -- B. view_as_end_for
  -- --------------------------------------------------------------------------

  -- Set up: admin A has an ACTIVE reception override; admin C (k_admin_exp)
  -- has an EXPIRED one; admin D (k_admin_noov) has none; admin E
  -- (k_admin_sim) is itself simulating.
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() + interval '1 hour'
   where id = k_admin_a;
  update public.staff_profiles
     set view_as_role = 'medtech', view_as_until = now() - interval '1 minute'
   where id = k_admin_exp;
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() + interval '1 hour'
   where id = k_admin_sim;

  -- T14: admin B ends admin A's active override. -----------------------------
  select public.view_as_end_for(k_admin_b, k_admin_a) into v_bool;
  if v_bool is not true then
    raise exception 'T14: expected true, got %', v_bool;
  end if;

  select view_as_role, view_as_until into v_role, v_until from public.staff_profiles where id = k_admin_a;
  if v_role is not null or v_until is not null then
    raise exception 'T14: admin A''s override should be cleared (role=% until=%)', v_role, v_until;
  end if;

  select count(*) into v_n
    from public.audit_log
   where action = 'staff.view_as.ended'
     and resource_type = 'staff_profile'
     and resource_id = k_admin_a
     and metadata ->> 'reason' = 'ended_by_admin';
  if v_n <> 1 then
    raise exception 'T14: expected exactly one ended_by_admin audit row for admin A (got %)', v_n;
  end if;

  select actor_id, metadata into v_role, v_meta
    from public.audit_log
   where action = 'staff.view_as.ended'
     and resource_type = 'staff_profile'
     and resource_id = k_admin_a
     and metadata ->> 'reason' = 'ended_by_admin';
  if v_role::uuid is distinct from k_admin_b then
    raise exception 'T14: expected actor_id = admin B, got %', v_role;
  end if;
  if (v_meta ->> 'role') is distinct from 'reception' or (v_meta ->> 'target_id') is distinct from k_admin_a::text then
    raise exception 'T14: unexpected metadata %', v_meta;
  end if;
  raise notice 'T14 ok: admin B ends admin A''s active override, one audit row, correct actor/target/metadata';

  -- T15: a second call for the same target returns false, writes nothing. ----
  select public.view_as_end_for(k_admin_b, k_admin_a) into v_bool;
  if v_bool is not false then
    raise exception 'T15: expected false on a second call, got %', v_bool;
  end if;
  select count(*) into v_n
    from public.audit_log
   where action = 'staff.view_as.ended'
     and resource_type = 'staff_profile'
     and resource_id = k_admin_a;
  if v_n <> 1 then
    raise exception 'T15: expected still exactly one row for admin A (got %)', v_n;
  end if;
  raise notice 'T15 ok: a second call is a no-op';

  -- T16: expired override / no override -> false, nothing written. ----------
  select public.view_as_end_for(k_admin_b, k_admin_exp) into v_bool;
  select public.view_as_end_for(k_admin_b, k_admin_noov) into v_bool2;
  if v_bool is not false or v_bool2 is not false then
    raise exception 'T16: expected false/false for expired/no-override targets, got %/%', v_bool, v_bool2;
  end if;
  select count(*) into v_n
    from public.audit_log
   where action = 'staff.view_as.ended'
     and resource_type = 'staff_profile'
     and resource_id in (k_admin_exp, k_admin_noov);
  if v_n <> 0 then
    raise exception 'T16: expected no audit rows for expired/no-override targets (got %)', v_n;
  end if;
  raise notice 'T16 ok: an expired or absent override returns false and writes nothing';

  -- T17: an actor who is themselves simulating is refused. -------------------
  begin
    perform public.view_as_end_for(k_admin_sim, k_admin_exp);
    raise exception 'T17: expected P0076, a simulating actor was accepted';
  exception
    when sqlstate 'P0076' then
      raise notice 'T17 ok: an actor mid-simulation is refused (P0076)';
  end;

  -- T18: a non-admin actor is refused. ---------------------------------------
  begin
    perform public.view_as_end_for(k_reception, k_admin_exp);
    raise exception 'T18: expected P0076, a non-admin actor was accepted';
  exception
    when sqlstate 'P0076' then
      raise notice 'T18 ok: a non-admin actor is refused (P0076)';
  end;

  -- --------------------------------------------------------------------------
  -- C. ACLs
  -- --------------------------------------------------------------------------
  if has_function_privilege('anon', 'public.view_as_end_for(uuid, uuid, inet, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.view_as_end_for(uuid, uuid, inet, text)', 'EXECUTE') then
    raise exception 'C: anon/authenticated must not have EXECUTE on view_as_end_for';
  end if;
  if not has_function_privilege('service_role', 'public.view_as_end_for(uuid, uuid, inet, text)', 'EXECUTE') then
    raise exception 'C: service_role lost EXECUTE on view_as_end_for';
  end if;
  if has_function_privilege('anon', 'public.test_requests_claim_holder_guard()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.test_requests_claim_holder_guard()', 'EXECUTE') then
    raise exception 'C: anon/authenticated must not have EXECUTE on test_requests_claim_holder_guard';
  end if;
  raise notice 'C ok: ACLs closed to anon/authenticated, open to service_role';
end $$;

rollback;

-- =============================================================================
-- 0182_staff_view_as_smoke.sql
-- =============================================================================
-- DB proof for migration 0182 (admin "View as role"). Runs inside
-- BEGIN/ROLLBACK, leaves no state. Asserts with raise exception; the control
-- at the end shows the probes can tell "override" from "no override".
--
-- Run (local stack, from the repo root):
--   /opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0182_staff_view_as_smoke.sql
--
-- What it proves:
--   P1 helper ACLs: anon + authenticated can execute the three predicates.
--   P2 admin A with override 'reception': as A, has_role(admin) is false,
--      has_role(reception) true, staff_role() = reception; A can still read
--      its own staff_profiles row; A CANNOT update its own row under RLS
--      (why the app uses the service role to exit).
--   P3 equivalence: contact_messages (0154: reception/admin read) is visible
--      to A-as-reception exactly as to genuine reception R, and hidden from
--      A-as-medtech exactly as from genuine medtech M;
--      lab_sections_for_role(staff_role()) for A-as-xray equals genuine X.
--   P4 a non-admin (M) with override columns set still resolves to medtech.
--   P5 expiry: until = now() (strict >) and until in the past → admin.
--   P6 demoted: A.role = medtech with override set → medtech.
--   P7 CONTROL: override cleared → A is admin again and sees the message.
--   P8 pathologist equivalence: public.result_values SELECT is governed by
--      two current permissive policies (verified live via pg_policy — no
--      migration after 0151/0172 touches either): "result_values: read by
--      owning medtech + pathologist + admin" (0007/0151) — an unconditional
--      has_role(['pathologist','admin']) branch, OR an assigned medtech/xray
--      branch; and "result_values: section staff read finished" (0172) —
--      same unconditional pathologist/admin branch via
--      staff_can_read_finished_result(), OR an in-section medtech/xray
--      branch gated on the result being finished. Reception is in neither
--      policy's OR-list under any condition, so it is a clean, unconditional
--      control. A-as-pathologist reads the fixture row exactly as genuine
--      pathologist P does (both via the unconditional branch — the row is
--      deliberately left unfinished/unassigned so this does not lean on the
--      medtech/xray branch); A-as-reception reads 0.
--   P9 X-ray claim write: public.test_requests UPDATE is governed by two
--      current permissive policies (verified live via pg_policy): "test_
--      requests: medtech/pathologist update" (0151, ~line 1261) —
--      has_role(['medtech','pathologist','xray_technician']); and "test_
--      requests: reception/admin write" (0151, ~line 1280), which is FOR ALL
--      (not just insert/select) with the same using/with check for
--      ['reception','admin']. So — contrary to the plan's "Facts" note,
--      which named only the first policy — reception genuinely CAN issue
--      this exact claim UPDATE at the RLS layer; claimTestAction's
--      per-section restriction (queue/actions.ts) is enforced in TypeScript
--      only, confirmed by that file's own comment ("RLS lets every lab role
--      (and reception) write test_requests, so the queue list's section
--      filter is UX, not the guard"). That leaves no STAFF ROLE refused by
--      RLS on this table, so P9's control is a DEACTIVATED xray_technician
--      (is_active = false): has_role()/staff_role() filter on is_active, so
--      a real xray_technician row with is_active = false is refused by both
--      policies — a genuine, differently-shaped "effective role the policy
--      refuses". A-as-xray_technician claims its line exactly as genuine X
--      claims its own (1 row, assigned_to/status set); the deactivated
--      xray_technician's claim affects 0 rows.
begin;

-- fixtures ------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-admin@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-reception@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-medtech@example.test', '', now(), now(), now()),
  ('a3000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-xray@example.test', '', now(), now(), now()),
  ('a4000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-patho@example.test', '', now(), now(), now()),
  ('a5000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-xray-inactive@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active) values
  ('a0000000-0000-4000-8000-000000000182', 'Smoke Admin', 'admin', true),
  ('a1000000-0000-4000-8000-000000000182', 'Smoke Reception', 'reception', true),
  ('a2000000-0000-4000-8000-000000000182', 'Smoke Medtech', 'medtech', true),
  ('a3000000-0000-4000-8000-000000000182', 'Smoke Xray', 'xray_technician', true),
  ('a4000000-0000-4000-8000-000000000182', 'Smoke Pathologist', 'pathologist', true),
  -- P9 CONTROL: a real xray_technician row, deactivated. has_role()/staff_role()
  -- filter on is_active, so this row is refused by both write policies below.
  ('a5000000-0000-4000-8000-000000000182', 'Smoke Xray Inactive', 'xray_technician', false);

insert into public.contact_messages (id, name, message) values
  ('c0000000-0000-4000-8000-000000000182', 'Smoke Sender', 'smoke 0182');

-- P8/P9 fixtures ---------------------------------------------------------
insert into public.services (id, code, name, price_php, kind, section) values
  ('c1000000-0000-4000-8000-000000000182', 'SMK182-CHEM', 'Smoke Chem P8', 100, 'lab_test', 'chemistry'),
  ('c2000000-0000-4000-8000-000000000182', 'SMK182-XR', 'Smoke Xray P9', 100, 'lab_test', 'imaging_xray');

insert into public.result_templates (id, service_id, layout)
values ('b0000000-0000-4000-8000-000000000182', 'c1000000-0000-4000-8000-000000000182', 'simple');
insert into public.result_template_params (id, template_id, sort_order, parameter_name, input_type)
values ('b1000000-0000-4000-8000-000000000182', 'b0000000-0000-4000-8000-000000000182', 1, 'P1', 'numeric');

insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values ('d0000000-0000-4000-8000-000000000182', 'DRM-SMK182', 'Smoke', 'Patient182', '1990-01-01', 'female');

insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
values ('e0000000-0000-4000-8000-000000000182', 'V-SMK182', 'd0000000-0000-4000-8000-000000000182',
        (now() at time zone 'Asia/Manila')::date, 'paid', 200, 200);

-- P8: a chemistry line, deliberately unfinished ('in_progress') and
-- unassigned, so pathologist/admin equivalence cannot be riding on the
-- medtech/xray "assigned + finished" read branch.
insert into public.test_requests (id, visit_id, service_id, status, requested_by, assigned_to,
                                  base_price_php, final_price_php) values
  ('f0000000-0000-4000-8000-000000000182', 'e0000000-0000-4000-8000-000000000182',
   'c1000000-0000-4000-8000-000000000182', 'in_progress', 'a1000000-0000-4000-8000-000000000182',
   null, 100, 100);
insert into public.results (id, generation_kind, uploaded_by)
values ('30000000-0000-4000-8000-000000000182', 'structured', 'a2000000-0000-4000-8000-000000000182');
insert into public.result_test_requests (result_id, test_request_id)
values ('30000000-0000-4000-8000-000000000182', 'f0000000-0000-4000-8000-000000000182');
insert into public.result_values (id, result_id, parameter_id, numeric_value_si, is_blank)
values ('40000000-0000-4000-8000-000000000182', '30000000-0000-4000-8000-000000000182',
        'b1000000-0000-4000-8000-000000000182', 5, false);

-- P9: three x-ray lines, all 'requested' — one for A-as-xray to claim, one
-- for genuine X to claim, one for the deactivated-xray control attempt.
insert into public.test_requests (id, visit_id, service_id, status, requested_by, assigned_to,
                                  base_price_php, final_price_php) values
  ('f1000000-0000-4000-8000-000000000182', 'e0000000-0000-4000-8000-000000000182',
   'c2000000-0000-4000-8000-000000000182', 'requested', 'a1000000-0000-4000-8000-000000000182',
   null, 100, 100),
  ('f2000000-0000-4000-8000-000000000182', 'e0000000-0000-4000-8000-000000000182',
   'c2000000-0000-4000-8000-000000000182', 'requested', 'a1000000-0000-4000-8000-000000000182',
   null, 100, 100),
  ('f3000000-0000-4000-8000-000000000182', 'e0000000-0000-4000-8000-000000000182',
   'c2000000-0000-4000-8000-000000000182', 'requested', 'a1000000-0000-4000-8000-000000000182',
   null, 100, 100);

-- helper: run the rest of a block as `who` -----------------------------------
create or replace function pg_temp.become(who uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', who), true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.unbecome() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
-- unbecome() runs while the role is still `authenticated`, and the local
-- default ACL does not grant EXECUTE on new functions to PUBLIC (functions are
-- born closed), so grant it explicitly. become() is only ever called as postgres.
grant execute on function pg_temp.unbecome() to authenticated;

do $$
declare
  k_admin     constant uuid := 'a0000000-0000-4000-8000-000000000182';
  k_reception constant uuid := 'a1000000-0000-4000-8000-000000000182';
  k_medtech   constant uuid := 'a2000000-0000-4000-8000-000000000182';
  k_xray      constant uuid := 'a3000000-0000-4000-8000-000000000182';
  k_pathologist   constant uuid := 'a4000000-0000-4000-8000-000000000182';
  k_xray_inactive constant uuid := 'a5000000-0000-4000-8000-000000000182';
  v_bool boolean; v_text text; v_fn text; v_n int; v_n2 int; v_arr text[]; v_arr2 text[]; v_uuid uuid;
begin
  -- P1 -----------------------------------------------------------------------
  -- One check per grantee × helper so a failure names the grant that was lost.
  foreach v_text in array array['anon', 'authenticated'] loop
    foreach v_fn in array array['public.has_role(text[])', 'public.staff_role()', 'public.is_staff()'] loop
      if not has_function_privilege(v_text, v_fn, 'EXECUTE') then
        raise exception 'P1: % lost EXECUTE on %', v_text, v_fn;
      end if;
    end loop;
  end loop;
  raise notice 'P1 ok: helper ACLs intact';

  -- P2 -----------------------------------------------------------------------
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() + interval '4 hours'
   where id = k_admin;

  perform pg_temp.become(k_admin);
  select public.has_role(array['admin']) into v_bool;
  if v_bool then raise exception 'P2: has_role(admin) should be false while viewing as reception'; end if;
  select public.has_role(array['reception']) into v_bool;
  if not v_bool then raise exception 'P2: has_role(reception) should be true'; end if;
  select public.staff_role() into v_text;
  if v_text <> 'reception' then raise exception 'P2: staff_role() = % (want reception)', v_text; end if;
  select count(*) into v_n from public.staff_profiles where id = k_admin;
  if v_n <> 1 then raise exception 'P2: self-read failed (% rows)', v_n; end if;
  update public.staff_profiles set view_as_role = null, view_as_until = null where id = k_admin;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'P2: RLS let the simulating admin clear its own override (% rows) — the service-role exit path is then unnecessary, re-check the policies', v_n; end if;
  perform pg_temp.unbecome();
  raise notice 'P2 ok: helpers answer reception; self-read works; self-update denied';

  -- P3 -----------------------------------------------------------------------
  -- Each sub-check re-sets both override columns so the block does not depend
  -- on P2's setup (P2's own attempt to clear them was blocked by RLS on purpose).
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() + interval '4 hours'
   where id = k_admin;
  perform pg_temp.become(k_admin);
  select count(*) into v_n from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  perform pg_temp.become(k_reception);
  select count(*) into v_n2 from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  if v_n <> 1 or v_n2 <> 1 then raise exception 'P3: reception equivalence broken (A=% R=%)', v_n, v_n2; end if;

  update public.staff_profiles
     set view_as_role = 'medtech', view_as_until = now() + interval '4 hours'
   where id = k_admin;
  perform pg_temp.become(k_admin);
  select count(*) into v_n from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  perform pg_temp.become(k_medtech);
  select count(*) into v_n2 from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  if v_n <> 0 or v_n2 <> 0 then raise exception 'P3: medtech equivalence broken (A=% M=%)', v_n, v_n2; end if;

  update public.staff_profiles
     set view_as_role = 'xray_technician', view_as_until = now() + interval '4 hours'
   where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.lab_sections_for_role(public.staff_role()) into v_arr;
  perform pg_temp.unbecome();
  perform pg_temp.become(k_xray);
  select public.lab_sections_for_role(public.staff_role()) into v_arr2;
  perform pg_temp.unbecome();
  if v_arr is distinct from v_arr2 or v_arr is null then
    raise exception 'P3: xray lab sections differ (A=% X=%)', v_arr, v_arr2;
  end if;
  raise notice 'P3 ok: reception / medtech / xray equivalence';

  -- P4 -----------------------------------------------------------------------
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() + interval '4 hours'
   where id = k_medtech;
  perform pg_temp.become(k_medtech);
  select public.staff_role() into v_text;
  select public.has_role(array['reception']) into v_bool;
  perform pg_temp.unbecome();
  if v_text <> 'medtech' or v_bool then raise exception 'P4: non-admin override must be inert (role=% has_reception=%)', v_text, v_bool; end if;
  raise notice 'P4 ok: non-admin override inert';

  -- P5 -----------------------------------------------------------------------
  update public.staff_profiles set view_as_role = 'reception', view_as_until = now() where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.staff_role() into v_text;
  perform pg_temp.unbecome();
  if v_text <> 'admin' then raise exception 'P5: until = now() must be expired (got %)', v_text; end if;
  update public.staff_profiles set view_as_until = now() - interval '1 second' where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.staff_role() into v_text;
  perform pg_temp.unbecome();
  if v_text <> 'admin' then raise exception 'P5: past until must be expired (got %)', v_text; end if;
  raise notice 'P5 ok: expiry strict';

  -- P6 -----------------------------------------------------------------------
  update public.staff_profiles
     set role = 'medtech', view_as_role = 'reception', view_as_until = now() + interval '4 hours'
   where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.staff_role() into v_text;
  perform pg_temp.unbecome();
  if v_text <> 'medtech' then raise exception 'P6: demoted admin must resolve to real role (got %)', v_text; end if;
  update public.staff_profiles set role = 'admin' where id = k_admin;
  raise notice 'P6 ok: demotion makes the override inert (and the demote itself was not blocked)';

  -- P7 CONTROL ---------------------------------------------------------------
  update public.staff_profiles set view_as_role = null, view_as_until = null where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.has_role(array['admin']) into v_bool;
  select public.staff_role() into v_text;
  select count(*) into v_n from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  if not v_bool or v_text <> 'admin' or v_n <> 1 then
    raise exception 'P7 CONTROL: cleared override should restore admin (has_admin=% role=% msgs=%)', v_bool, v_text, v_n;
  end if;
  raise notice 'P7 ok (control): override cleared → admin again';

  -- P8 -------------------------------------------------------------------
  -- See header for the two policies exercised. Fixture row: result_values
  -- id 40000000-...-182, linked to an in_progress/unassigned chemistry line.
  update public.staff_profiles
     set view_as_role = 'pathologist', view_as_until = now() + interval '4 hours'
   where id = k_admin;

  perform pg_temp.become(k_admin);
  select public.staff_role() into v_text;
  if v_text <> 'pathologist' then raise exception 'P8: A staff_role() = % (want pathologist)', v_text; end if;
  select public.lab_sections_for_role(public.staff_role()) into v_arr;
  select count(*) into v_n from public.result_values where id = '40000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();

  perform pg_temp.become(k_pathologist);
  select public.lab_sections_for_role(public.staff_role()) into v_arr2;
  select count(*) into v_n2 from public.result_values where id = '40000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();

  if v_arr is distinct from v_arr2 then
    raise exception 'P8: lab_sections_for_role differs (A=% P=%)', v_arr, v_arr2;
  end if;
  if v_n <> 1 or v_n2 <> 1 then
    raise exception 'P8: pathologist equivalence broken (A=% P=%)', v_n, v_n2;
  end if;

  perform pg_temp.become(k_reception);
  select count(*) into v_n from public.result_values where id = '40000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  if v_n <> 0 then raise exception 'P8 CONTROL: reception should see 0 rows (got %)', v_n; end if;
  raise notice 'P8 ok: pathologist equivalence (result_values); reception control 0 rows';

  -- P9 -------------------------------------------------------------------
  -- See header for the two policies exercised and why the control is a
  -- deactivated xray_technician rather than reception.
  update public.staff_profiles
     set view_as_role = 'xray_technician', view_as_until = now() + interval '4 hours'
   where id = k_admin;

  perform pg_temp.become(k_admin);
  update public.test_requests
     set status = 'in_progress', assigned_to = k_admin, started_at = now()
   where id = 'f1000000-0000-4000-8000-000000000182' and status = 'requested';
  get diagnostics v_n = row_count;
  perform pg_temp.unbecome();
  if v_n <> 1 then raise exception 'P9: A-as-xray claim affected % rows (want 1)', v_n; end if;
  select assigned_to, status into v_uuid, v_text
    from public.test_requests where id = 'f1000000-0000-4000-8000-000000000182';
  if v_uuid <> k_admin or v_text <> 'in_progress' then
    raise exception 'P9: A-as-xray claimed row wrong (assigned_to=% status=%)', v_uuid, v_text;
  end if;

  perform pg_temp.become(k_xray);
  update public.test_requests
     set status = 'in_progress', assigned_to = k_xray, started_at = now()
   where id = 'f2000000-0000-4000-8000-000000000182' and status = 'requested';
  get diagnostics v_n2 = row_count;
  perform pg_temp.unbecome();
  if v_n2 <> 1 then raise exception 'P9: genuine X claim affected % rows (want 1)', v_n2; end if;
  select assigned_to, status into v_uuid, v_text
    from public.test_requests where id = 'f2000000-0000-4000-8000-000000000182';
  if v_uuid <> k_xray or v_text <> 'in_progress' then
    raise exception 'P9: genuine X claimed row wrong (assigned_to=% status=%)', v_uuid, v_text;
  end if;

  -- CONTROL: a real xray_technician row with is_active = false. Refused by
  -- BOTH write policies (has_role() filters is_active), unlike reception.
  perform pg_temp.become(k_xray_inactive);
  update public.test_requests
     set status = 'in_progress', assigned_to = k_xray_inactive, started_at = now()
   where id = 'f3000000-0000-4000-8000-000000000182' and status = 'requested';
  get diagnostics v_n = row_count;
  perform pg_temp.unbecome();
  if v_n <> 0 then
    raise exception 'P9 CONTROL: deactivated xray_technician claim should affect 0 rows (got %)', v_n;
  end if;
  raise notice 'P9 ok: X-ray claim write as A-as-xray (and genuine X); deactivated-xray control refused';
end $$;

rollback;

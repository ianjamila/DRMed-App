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
   'authenticated', 'authenticated', 'smoke182-xray@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role) values
  ('a0000000-0000-4000-8000-000000000182', 'Smoke Admin', 'admin'),
  ('a1000000-0000-4000-8000-000000000182', 'Smoke Reception', 'reception'),
  ('a2000000-0000-4000-8000-000000000182', 'Smoke Medtech', 'medtech'),
  ('a3000000-0000-4000-8000-000000000182', 'Smoke Xray', 'xray_technician');

insert into public.contact_messages (id, name, message) values
  ('c0000000-0000-4000-8000-000000000182', 'Smoke Sender', 'smoke 0182');

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
  v_bool boolean; v_text text; v_fn text; v_n int; v_n2 int; v_arr text[]; v_arr2 text[];
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
end $$;

rollback;

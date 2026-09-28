-- =============================================================================
-- 0187_view_as_followups_smoke.sql
-- =============================================================================
-- DB proof for migration 0187 (View-as follow-ups). Runs inside
-- BEGIN/ROLLBACK, leaves no state. Asserts with raise exception; T9 is a
-- CONTROL that disables the trigger to show T7/T8 would fail without it.
--
-- Run (local stack, from the repo root):
--   /opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0187_view_as_followups_smoke.sql
--
-- What it proves:
--   T1 ACLs: anon/authenticated cannot execute any of the three functions;
--      service_role can execute the two RPCs.
--   T2 start -> switch -> exit writes exactly the four staff.view_as.* rows
--      in order, with a non-null `until` on each started row, and clears the
--      admin's override columns.
--   T3 an exit with nothing active writes nothing; double exit after a start
--      logs the ended row once.
--   T4 starting over an already-expired row closes it with reason=expired
--      (and expired_at) before opening the new one.
--   T5 view_as_expire() is idempotent (true once, false after) and a no-op
--      against an ACTIVE override.
--   T6 a non-admin is refused P0074; an invalid role is refused 22023.
--   T7 the audit_log stamp trigger adds metadata.acting_as only for a staff
--      actor with an active override, on a non-view_as action, into a JSON
--      object (never touching a view_as.* row, a patient row, another
--      staff's row, a non-object payload, or a non-simulating admin).
--   T8 the stamp fires no matter which caller (JWT role, SQL function)
--      performs the insert.
--   T9 CONTROL: disabling the trigger removes the stamp, proving T7/T8
--      actually detect it.
begin;

-- fixtures ------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000187', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke187-admin@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000187', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke187-medtech@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role) values
  ('a0000000-0000-4000-8000-000000000187', 'Smoke187 Admin', 'admin'),
  ('a2000000-0000-4000-8000-000000000187', 'Smoke187 Medtech', 'medtech');

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

-- helper: the staff.view_as.* audit trail for one actor, oldest first.
create or replace function pg_temp.va_rows(who uuid)
returns table (action text, role text, reason text) language sql as $$
  select action, metadata->>'role', metadata->>'reason'
    from public.audit_log
   where actor_id = who and action like 'staff.view_as.%'
   order by id;
$$;

-- helper: a security-definer inserter, for T8 (the stamp must fire no matter
-- who — or what — performs the insert).
create or replace function pg_temp.definer_insert(who uuid, act text) returns void
language plpgsql security definer as $$
begin
  insert into public.audit_log (actor_id, actor_type, action) values (who, 'staff', act);
end $$;
grant execute on function pg_temp.definer_insert(uuid, text) to authenticated;

do $$
declare
  k_admin   constant uuid := 'a0000000-0000-4000-8000-000000000187';
  k_medtech constant uuid := 'a2000000-0000-4000-8000-000000000187';
  v_bool  boolean;
  v_bool2 boolean;
  v_text  text;
  v_text2 text;
  v_n     int;
  v_arr   text[];
  v_meta  jsonb;
  v_fn    text;
begin
  -- T1 -------------------------------------------------------------------
  foreach v_text in array array['anon', 'authenticated'] loop
    foreach v_fn in array array[
      'public.view_as_transition(uuid, text, inet, text)',
      'public.view_as_expire(uuid, inet, text)',
      'public.audit_log_stamp_view_as()'
    ] loop
      if has_function_privilege(v_text, v_fn, 'EXECUTE') then
        raise exception 'T1: % must not have EXECUTE on %', v_text, v_fn;
      end if;
    end loop;
  end loop;
  if not has_function_privilege('service_role', 'public.view_as_transition(uuid, text, inet, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.view_as_expire(uuid, inet, text)', 'EXECUTE') then
    raise exception 'T1: service_role lost EXECUTE on a View-as RPC';
  end if;
  raise notice 'T1 ok: anon/authenticated closed, service_role open on the two RPCs';

  -- T2 ---------------------------------------------------------------------
  perform public.view_as_transition(k_admin, 'reception');
  perform public.view_as_transition(k_admin, 'medtech');
  perform public.view_as_transition(k_admin, null);

  select array_agg(action || ':' || coalesce(role, '') || ':' || coalesce(reason, ''))
    into v_arr
    from pg_temp.va_rows(k_admin);
  if v_arr is distinct from array[
       'staff.view_as.started:reception:',
       'staff.view_as.ended:reception:switched',
       'staff.view_as.started:medtech:',
       'staff.view_as.ended:medtech:manual'
     ] then
    raise exception 'T2: unexpected audit sequence %', v_arr;
  end if;

  select view_as_role, view_as_until into v_text, v_text2 from public.staff_profiles where id = k_admin;
  if not found then
    raise exception 'T2: staff_profiles row missing for admin %', k_admin;
  end if;
  if v_text is not null or v_text2 is not null then
    raise exception 'T2: admin row should be clear after exit (role=% until=%)', v_text, v_text2;
  end if;

  select bool_and((metadata ->> 'until') is not null) into v_bool
    from public.audit_log
   where actor_id = k_admin and action = 'staff.view_as.started';
  if v_bool is not true then
    raise exception 'T2: a started row is missing metadata.until';
  end if;
  raise notice 'T2 ok: start -> switch -> exit writes exactly 4 rows in order, columns clear';

  -- T3 ---------------------------------------------------------------------
  delete from public.audit_log where actor_id = k_admin and action like 'staff.view_as.%';
  perform public.view_as_transition(k_admin, null);
  perform public.view_as_transition(k_admin, null);
  select count(*) into v_n from pg_temp.va_rows(k_admin);
  if v_n <> 0 then
    raise exception 'T3: exiting with nothing active should write nothing (% rows)', v_n;
  end if;

  perform public.view_as_transition(k_admin, 'reception');
  perform public.view_as_transition(k_admin, null);
  perform public.view_as_transition(k_admin, null);
  select array_agg(action || ':' || coalesce(role, '') || ':' || coalesce(reason, ''))
    into v_arr
    from pg_temp.va_rows(k_admin);
  if v_arr is distinct from array[
       'staff.view_as.started:reception:',
       'staff.view_as.ended:reception:manual'
     ] then
    raise exception 'T3: double exit after a start should log the ended row once (%)', v_arr;
  end if;
  raise notice 'T3 ok: no-op exit writes nothing; double exit after a start logs once';

  -- T4 ---------------------------------------------------------------------
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() - interval '1 minute'
   where id = k_admin;
  delete from public.audit_log where actor_id = k_admin and action like 'staff.view_as.%';
  perform public.view_as_transition(k_admin, 'pathologist');

  select array_agg(action || ':' || coalesce(role, '') || ':' || coalesce(reason, ''))
    into v_arr
    from pg_temp.va_rows(k_admin);
  if v_arr is distinct from array[
       'staff.view_as.ended:reception:expired',
       'staff.view_as.started:pathologist:'
     ] then
    raise exception 'T4: starting over an expired row gave unexpected rows %', v_arr;
  end if;

  select (metadata ? 'expired_at') into v_bool
    from public.audit_log
   where actor_id = k_admin and action = 'staff.view_as.ended'
   order by id desc limit 1;
  if not found then
    raise exception 'T4: no staff.view_as.ended row found for admin %', k_admin;
  end if;
  if v_bool is not true then
    raise exception 'T4: the expired ended row is missing expired_at';
  end if;
  raise notice 'T4 ok: starting over an expired row closes it as expired first';

  -- T5 ---------------------------------------------------------------------
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() - interval '1 minute'
   where id = k_admin;
  delete from public.audit_log where actor_id = k_admin and action like 'staff.view_as.%';

  select public.view_as_expire(k_admin) into v_bool;
  select public.view_as_expire(k_admin) into v_bool2;
  if v_bool is not true or v_bool2 is not false then
    raise exception 'T5: expected true then false, got % then %', v_bool, v_bool2;
  end if;
  select count(*) into v_n from pg_temp.va_rows(k_admin);
  if v_n <> 1 then
    raise exception 'T5: expected exactly one ended row (%)', v_n;
  end if;
  select view_as_role, view_as_until into v_text, v_text2 from public.staff_profiles where id = k_admin;
  if not found then
    raise exception 'T5: staff_profiles row missing for admin %', k_admin;
  end if;
  if v_text is not null or v_text2 is not null then
    raise exception 'T5: admin row should be clear after lazy expiry (role=% until=%)', v_text, v_text2;
  end if;

  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() + interval '1 hour'
   where id = k_admin;
  select public.view_as_expire(k_admin) into v_bool;
  if v_bool is not false then
    raise exception 'T5: view_as_expire must not touch an ACTIVE override';
  end if;
  select view_as_role, view_as_until into v_text, v_text2 from public.staff_profiles where id = k_admin;
  if not found then
    raise exception 'T5: staff_profiles row missing for admin %', k_admin;
  end if;
  if v_text is distinct from 'reception' or v_text2 is null then
    raise exception 'T5: ACTIVE override columns changed (role=% until=%)', v_text, v_text2;
  end if;
  raise notice 'T5 ok: view_as_expire idempotent on a stale row, a no-op on an active one';

  -- T6 ---------------------------------------------------------------------
  begin
    perform public.view_as_transition(k_medtech, 'reception');
    raise exception 'T6: non-admin accepted';
  exception
    when sqlstate 'P0074' then
      raise notice 'T6a ok: non-admin refused (P0074)';
  end;

  begin
    perform public.view_as_transition(k_admin, 'admin');
    raise exception 'T6: invalid role accepted';
  exception
    when sqlstate '22023' then
      raise notice 'T6b ok: invalid role refused (22023)';
  end;

  -- T7 ---------------------------------------------------------------------
  perform public.view_as_transition(k_admin, 'reception');

  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_admin, 'staff', 'smoke.187.a', '{"k": 1}'::jsonb)
  returning metadata into v_meta;
  if (v_meta ->> 'acting_as') is distinct from 'reception' or (v_meta ->> 'k') is distinct from '1' then
    raise exception 'T7a: expected acting_as=reception and k=1, got %', v_meta;
  end if;

  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_admin, 'staff', 'smoke.187.b', null)
  returning metadata into v_meta;
  if v_meta is distinct from jsonb_build_object('acting_as', 'reception') then
    raise exception 'T7b: expected {acting_as: reception}, got %', v_meta;
  end if;

  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_admin, 'staff', 'staff.view_as.smoke', null)
  returning metadata into v_meta;
  if v_meta is not null then
    raise exception 'T7c: a staff.view_as.* row must not be stamped (%)', v_meta;
  end if;

  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_admin, 'patient', 'smoke.187.patient', null)
  returning metadata into v_meta;
  if v_meta is not null then
    raise exception 'T7d: a patient-typed row must not be stamped (%)', v_meta;
  end if;

  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_admin, 'staff', 'smoke.187.arr', '[1]'::jsonb)
  returning metadata into v_meta;
  if v_meta is distinct from '[1]'::jsonb then
    raise exception 'T7e: a non-object payload must be left unchanged (%)', v_meta;
  end if;

  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_medtech, 'staff', 'smoke.187.m', null)
  returning metadata into v_meta;
  if v_meta is not null then
    raise exception 'T7f: a non-simulating staff row must not be stamped (%)', v_meta;
  end if;

  perform public.view_as_transition(k_admin, null);
  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_admin, 'staff', 'smoke.187.after-exit', null)
  returning metadata into v_meta;
  if v_meta is not null then
    raise exception 'T7g: after exit, no stamp should be added (%)', v_meta;
  end if;
  raise notice 'T7 ok: the stamp trigger fires only for a simulating staff actor on a non-view_as, object-or-null payload';

  -- T8 ---------------------------------------------------------------------
  perform public.view_as_transition(k_admin, 'reception');
  perform pg_temp.become(k_admin);
  perform pg_temp.definer_insert(k_admin, 'smoke.187.definer');
  perform pg_temp.unbecome();

  select metadata into v_meta
    from public.audit_log
   where actor_id = k_admin and action = 'smoke.187.definer'
   order by id desc limit 1;
  if not found then
    raise exception 'T8: no audit_log row found for the definer insert';
  end if;
  if (v_meta ->> 'acting_as') is distinct from 'reception' then
    raise exception 'T8: stamp missing from an insert done via a SQL-side definer function (%)', v_meta;
  end if;
  raise notice 'T8 ok: the stamp fires regardless of which caller performs the insert';

  -- T9 CONTROL ---------------------------------------------------------------
  alter table public.audit_log disable trigger audit_log_stamp_view_as;
  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_admin, 'staff', 'smoke.187.disabled', null)
  returning metadata into v_meta;
  if v_meta is not null then
    raise exception 'T9: expected no stamp with the trigger disabled (%)', v_meta;
  end if;
  alter table public.audit_log enable trigger audit_log_stamp_view_as;

  insert into public.audit_log (actor_id, actor_type, action, metadata)
  values (k_admin, 'staff', 'smoke.187.restored', null)
  returning metadata into v_meta;
  if (v_meta ->> 'acting_as') is distinct from 'reception' then
    raise exception 'T9: stamp did not resume after re-enabling the trigger (%)', v_meta;
  end if;
  raise notice 'T9 ok (control): disabling the trigger removes the stamp; re-enabling restores it';
end $$;

rollback;

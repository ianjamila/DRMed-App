-- =============================================================================
-- 0163_drm_id_width_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after migrations:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/0163_drm_id_width_smoke.sql
--
-- What it proves:
--   1. generate_drm_id() yields DRM-9999, DRM-10000, DRM-10001 across the boundary.
--   2. A patient inserted at DRM-10000 succeeds while a DRM-1000 row exists.
--   3. THE CONTROL: with 0001's original body restored inside this transaction, the
--      same insert raises unique_violation. That shows assertion 2 would catch the
--      truncation, rather than passing because DRM-1000 happened to be absent.
--   4. The ACL and pinned search_path survived the create-or-replace.
--
-- Sequences are NOT transactional: setval survives ROLLBACK. The block saves the
-- sequence position and restores it before exit, and it refuses to run against a
-- database that looks like prod.
begin;

do $$
declare
  saved_last bigint;
  saved_called boolean;
  got text;
  collided boolean := false;
begin
  if (select count(*) from public.patients) > 5000 then
    raise exception 'refusing: % patients looks like prod — this test is LOCAL ONLY',
      (select count(*) from public.patients);
  end if;

  select last_value, is_called into saved_last, saved_called from public.drm_id_seq;

  -- A kept DRM-1000 row: the one the old body collides with.
  if not exists (select 1 from public.patients where drm_id = 'DRM-1000') then
    insert into public.patients (drm_id, first_name, last_name, birthdate)
    values ('DRM-1000', 'Smoke', 'Kept', '1990-01-01');
  end if;

  -- 1. Boundary through the live function.
  perform setval('public.drm_id_seq', 9998, true);
  got := public.generate_drm_id();
  if got <> 'DRM-9999' then raise exception 'FAIL 1a: expected DRM-9999, got %', got; end if;
  got := public.generate_drm_id();
  if got <> 'DRM-10000' then raise exception 'FAIL 1b: expected DRM-10000, got %', got; end if;
  got := public.generate_drm_id();
  if got <> 'DRM-10001' then raise exception 'FAIL 1c: expected DRM-10001, got %', got; end if;

  -- 2. Real insert at the boundary, next to the kept DRM-1000.
  perform setval('public.drm_id_seq', 9999, true);
  insert into public.patients (first_name, last_name, birthdate)
  values ('Smoke', 'Boundary', '1990-01-01')
  returning drm_id into got;
  if got <> 'DRM-10000' then raise exception 'FAIL 2: inserted %, expected DRM-10000', got; end if;

  -- 4. ACL + search_path preserved (checked before the control redefines the body).
  if not has_function_privilege('authenticated', 'public.generate_drm_id()', 'execute')
     or not has_function_privilege('service_role', 'public.generate_drm_id()', 'execute')
     or not has_function_privilege('anon', 'public.generate_drm_id()', 'execute') then
    raise exception 'FAIL 4a: generate_drm_id lost an EXECUTE grant (column default needs it)';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.generate_drm_id()'::regprocedure
      and array_to_string(proconfig, ',') like 'search_path=%'
  ) then
    raise exception 'FAIL 4b: generate_drm_id has no pinned search_path';
  end if;

  -- 3. CONTROL: 0001's original body collides at the same boundary.
  execute $f$
    create or replace function public.generate_drm_id()
    returns text language sql volatile set search_path = public as $b$
      select 'DRM-' || lpad(nextval('public.drm_id_seq')::text, 4, '0');
    $b$
  $f$;
  perform setval('public.drm_id_seq', 9999, true);
  begin
    insert into public.patients (first_name, last_name, birthdate)
    values ('Smoke', 'Control', '1990-01-01');
  exception when unique_violation then
    collided := true;
  end;
  if not collided then
    raise exception 'FAIL 3 (control): the old body did not collide — assertion 2 proves nothing';
  end if;

  perform setval('public.drm_id_seq', saved_last, saved_called);
  raise notice 'PASS: boundary 9999→10000→10001, insert beside DRM-1000, control collides, ACL + search_path intact';
end;
$$;

rollback;

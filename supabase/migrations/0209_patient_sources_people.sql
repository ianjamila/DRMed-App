-- 0209_patient_sources_people.sql
--
-- Patient Sources Phase 5c: patient_sources_people (0189) rebuilt on the shared
-- arrays 0206 introduced. The people list used to build the identity core
-- itself (_patient_sources_identities(), + _patient_sources_encounters() for
-- "served"); it now takes the arrays from the same list builders the other
-- report RPCs use, so every list on the page has one definition of "who is who".
--   * adds the closed helper _ps_sec_people(ids, encounters, from, to, mode,
--     channel, limit, offset) holding 0189's rules VERBATIM (only the two core
--     calls became unnest(p_ids) / unnest(p_enc));
--   * re-creates patient_sources_people as a wrapper: same signature, return
--     type, STABLE, SECURITY DEFINER, search_path, admin-only gate (NO
--     service_role: a refused call segfaults prod image .111, so server code
--     never calls this function), validation order, paging and ACL.
-- Additive create-or-replace with an identical signature: the live app keeps
-- working whether this lands before or after the deploy. ACLs on the wrapper are
-- deliberately NOT restated (create or replace keeps them; the proof asserts the
-- proacl is byte-equal to the pre-0209 value). service_role keeps EXECUTE.
-- Rollback: a forward migration restoring scripts/fixtures/patient-sources-people-pre-0209.sql
-- (ps_old -> public), ACLs unchanged.

-- 1. The section helper (no gate: the wrapper gates and validates).
create or replace function public._ps_sec_people(
  p_ids public._ps_identity[], p_enc public._ps_encounter[], p_from date, p_to date,
  p_mode text, p_channel text, p_limit int, p_offset int)
returns table (
  identity_kind text,
  identity      text,
  patient_id    uuid,
  drm_id        text,
  display_name  text,
  first_date    date,
  total_count   bigint
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with ids as (
    select * from unnest(p_ids)
  ),
  picked as (
    select i.identity, i.confirmed, i.survivor_id, i.loose_key, i.first_date as d
    from ids i
    where p_mode in ('new', 'returning')
      and i.basis in ('encounter', 'registration')
      and i.first_date between p_from and p_to
      and i.is_returning = (p_mode = 'returning')
      and (p_channel is null or i.channel = p_channel)
    union all
    select i.identity, i.confirmed, i.survivor_id, i.loose_key, min(e.service_date)
    from unnest(p_enc) e
    join ids i on i.identity = e.identity
    where p_mode = 'served'
      and e.service_date between p_from and p_to
      and (p_channel is null or i.channel = p_channel)
    group by i.identity, i.confirmed, i.survivor_id, i.loose_key
  )
  select case when k.confirmed then 'confirmed' else 'unconfirmed' end,
         k.identity,
         k.survivor_id,
         p.drm_id,
         case when k.confirmed
              then concat_ws(', ', p.last_name, concat_ws(' ', p.first_name, p.middle_name))
              else coalesce(
                (select l.name_raw from public.sheet_encounter_lines l
                  where l.patient_id is null and l.loose_key = k.loose_key
                  order by l.service_date, l.id limit 1),
                (select c.full_name_raw from public.sheet_customer_rows c
                  where c.patient_id is null and c.loose_key = k.loose_key
                  order by c.sheet_row limit 1))
         end,
         k.d,
         count(*) over ()
  from picked k
  left join public.patients p on p.id = k.survivor_id
  order by k.d, k.identity
  limit greatest(1, least(coalesce(p_limit, 50), 1000))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

-- 2. The public RPC as a wrapper (signature, gate, validation order, paging unchanged).
create or replace function public.patient_sources_people(
  p_from date, p_to date, p_mode text, p_channel text, p_limit int, p_offset int)
returns table (
  identity_kind text,
  identity      text,
  patient_id    uuid,
  drm_id        text,
  display_name  text,
  first_date    date,
  total_count   bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  if p_mode is null or p_mode not in ('new', 'returning', 'served') then
    raise exception 'Unknown list %', coalesce(p_mode, '(none)') using errcode = '22023';
  end if;

  return query
  select * from public._ps_sec_people(
    public._ps_identity_list(),
    -- 'new' / 'returning' never read encounters: skip building them.
    case when p_mode = 'served' then public._ps_encounter_list() else '{}'::public._ps_encounter[] end,
    p_from, p_to, p_mode, p_channel, p_limit, p_offset);
end;
$$;

-- 3. ACLs. The helper is closed to every runtime role. The wrapper's ACL is
-- untouched (admin-only inside the body; authenticated and service_role keep
-- EXECUTE exactly as 0189 left them: NEVER revoke service_role — see header).
revoke all on function public._ps_sec_people(public._ps_identity[], public._ps_encounter[], date, date, text, text, int, int) from public, anon, authenticated, service_role;

-- 4. Post-conditions: abort the deploy if anything is not what this file says.
do $$
declare
  f constant text := 'public._ps_sec_people(public._ps_identity[],public._ps_encounter[],date,date,text,text,integer,integer)';
  w constant text := 'public.patient_sources_people(date,date,text,text,integer,integer)';
  v_def text;
  v_wrapper record;
begin
  -- Helper: closed, invoker, no service_role literal, reads the arrays.
  if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
     or has_function_privilege('service_role', f, 'execute') then
    raise exception '0209: internal % is executable by a runtime role', f;
  end if;
  if (select p.prosecdef from pg_proc p where p.oid = f::regprocedure) then
    raise exception '0209: % must not be SECURITY DEFINER', f;
  end if;
  v_def := pg_get_functiondef(f::regprocedure);
  if v_def like '%service_role%' then
    raise exception '0209: % must not mention service_role', f;
  end if;
  if v_def not like '%unnest(p_ids)%' or v_def not like '%unnest(p_enc) e%' then
    raise exception '0209: % does not read the shared arrays', f;
  end if;
  if v_def like '%_patient_sources_identities%' or v_def like '%_patient_sources_encounters%' then
    raise exception '0209: % still calls the identity core directly', f;
  end if;

  -- Wrapper: same shape as before, ACL unchanged, still admin-only.
  select p.prosecdef, p.provolatile, p.proconfig, p.proretset,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_function_result(p.oid) as result
    into v_wrapper
    from pg_proc p where p.oid = w::regprocedure;
  if not v_wrapper.prosecdef then
    raise exception '0209: % lost SECURITY DEFINER', w;
  end if;
  if v_wrapper.provolatile <> 's' then
    raise exception '0209: % is no longer STABLE', w;
  end if;
  if v_wrapper.proconfig is distinct from array['search_path=""'] then
    raise exception '0209: % lost its empty search_path', w;
  end if;
  if not v_wrapper.proretset then
    raise exception '0209: % no longer returns a set', w;
  end if;
  if v_wrapper.args <> 'p_from date, p_to date, p_mode text, p_channel text, p_limit integer, p_offset integer' then
    raise exception '0209: % identity arguments changed: %', w, v_wrapper.args;
  end if;
  if v_wrapper.result <> 'TABLE(identity_kind text, identity text, patient_id uuid, drm_id text, display_name text, first_date date, total_count bigint)' then
    raise exception '0209: % result type changed: %', w, v_wrapper.result;
  end if;
  if has_function_privilege('anon', w, 'execute') then
    raise exception '0209: % is executable by anon', w;
  end if;
  if not has_function_privilege('authenticated', w, 'execute') then
    raise exception '0209: % is not executable by authenticated', w;
  end if;
  -- service_role EXECUTE is deliberate (see header); the BODY stays admin-only.
  if not has_function_privilege('service_role', w, 'execute') then
    raise exception '0209: % lost service_role EXECUTE (a refused call segfaults prod image .111)', w;
  end if;
  v_def := pg_get_functiondef(w::regprocedure);
  if v_def like '%service_role%' then
    raise exception '0209: % must stay admin-only', w;
  end if;
  if v_def not like '%_ps_sec_people%' or v_def not like '%_ps_identity_list()%' then
    raise exception '0209: % does not call the shared-array helper', w;
  end if;
end;
$$;

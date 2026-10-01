-- patient_sources_people exactly as it was on main before 0209 (0189's body, generated with
-- pg_get_functiondef from a stack at the pre-0209 head), re-homed in schema ps_old, plus the
-- live function's ACL / signature / volatility facts in ps_old.frozen_people_meta.
-- scripts/patient-sources-db-proof.ts loads this INSIDE its rolled-back transaction and proves
-- the 0209 wrapper returns identical rows. Never applied anywhere. It is also the ROLLBACK body:
-- a forward migration that restores this function (ACL unchanged) undoes 0209.
create schema if not exists ps_old;
grant usage on schema ps_old to anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION ps_old.patient_sources_people(p_from date, p_to date, p_mode text, p_channel text, p_limit integer, p_offset integer)
 RETURNS TABLE(identity_kind text, identity text, patient_id uuid, drm_id text, display_name text, first_date date, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  with ids as (
    select * from public._patient_sources_identities()
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
    from public._patient_sources_encounters() e
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
$function$
;
revoke all on function ps_old.patient_sources_people(date, date, text, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function ps_old.patient_sources_people(date, date, text, text, integer, integer) to authenticated, service_role;
create table ps_old.frozen_people_meta as select 'postgres'::text as owner, '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'::text as proacl, 'p_from date, p_to date, p_mode text, p_channel text, p_limit integer, p_offset integer'::text as identity_args, 'TABLE(identity_kind text, identity text, patient_id uuid, drm_id text, display_name text, first_date date, total_count bigint)'::text as result, 'true'::text as secdef, 's'::text as volatility, E'{"search_path=\\"\\""}'::text as config, 'plpgsql'::text as lang, 'u'::text as parallel, '100'::text as cost, '1000'::text as prorows;

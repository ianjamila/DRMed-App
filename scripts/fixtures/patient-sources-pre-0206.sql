-- The five Patient Sources report RPCs exactly as they were on main before 0206
-- (generated with pg_get_functiondef from a stack at head 0204), re-homed in schema
-- ps_old. scripts/patient-sources-db-proof.ts loads this INSIDE its rolled-back
-- transaction and proves the 0206 wrappers return identical rows. Never applied anywhere.
-- NOTE: these ps_old bodies still call the LIVE public core (_patient_sources_identities,
-- _patient_sources_encounters, _ps_revenue_lines, _ps_bucket, _ps_survivors). So the
-- equivalence proves the wrapper/helper refactor only; 0206 must not touch that core
-- (spec section 2 non-goal). Pinned values in the proof anchor the numbers themselves.
create schema if not exists ps_old;
grant usage on schema ps_old to authenticated;
CREATE OR REPLACE FUNCTION ps_old.patient_sources_overlaps(p_from date, p_to date)
 RETURNS TABLE(patient_id uuid, drm_id text, service_date date, app_php numeric, sheet_php numeric)
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

  return query
  with lines as (
    select * from public._ps_revenue_lines(p_from, p_to)
  )
  select s.survivor_id, p.drm_id, s.service_date,
         coalesce((select sum(a.php) from lines a
                    where a.source = 'app' and a.survivor_id = s.survivor_id
                      and a.service_date = s.service_date), 0)::numeric(14,2),
         sum(s.php)::numeric(14,2)
  from lines s
  join public.patients p on p.id = s.survivor_id
  where s.source = 'sheet' and s.overlap
  group by s.survivor_id, p.drm_id, s.service_date
  order by s.service_date, p.drm_id;
end;
$function$
;
grant execute on function ps_old.patient_sources_overlaps(p_from date, p_to date) to authenticated;

CREATE OR REPLACE FUNCTION ps_old.patient_sources_referrers(p_from date, p_to date, p_limit integer DEFAULT 20)
 RETURNS TABLE(doctor_label text, new_confirmed integer, new_unconfirmed integer)
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

  return query
  with ids as (
    select * from public._patient_sources_identities() i
    where i.basis in ('encounter', 'registration') and not i.is_returning
      and i.first_date between p_from and p_to
  ),
  -- (M2) The referrer answer now comes from the identity core (referrer_raw):
  -- one definition, no second copy of the linked/unlinked rules here.
  raw as (
    select i.confirmed, i.referrer_raw as raw_label from ids i
  ),
  normed as (
    select r.confirmed, btrim(r.raw_label) as spelling, public._ps_doctor_norm(r.raw_label) as k
    from raw r where r.raw_label is not null
  ),
  spellings as (
    select n.k, n.spelling, count(*) as c from normed n where n.k is not null group by n.k, n.spelling
  ),
  labels as (
    select distinct on (s.k) s.k, s.spelling from spellings s order by s.k, s.c desc, s.spelling
  )
  select l.spelling,
         (count(*) filter (where n.confirmed))::int,
         (count(*) filter (where not n.confirmed))::int
  from normed n
  join labels l on l.k = n.k
  group by l.k, l.spelling
  order by count(*) desc, l.spelling
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$function$
;
grant execute on function ps_old.patient_sources_referrers(p_from date, p_to date, p_limit integer) to authenticated;

CREATE OR REPLACE FUNCTION ps_old.patient_sources_revenue(p_from date, p_to date)
 RETURNS TABLE(channel text, confirmed_php numeric, unconfirmed_php numeric)
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

  return query
  select i.channel,
         coalesce(sum(l.php) filter (where i.confirmed), 0)::numeric(14,2),
         coalesce(sum(l.php) filter (where not i.confirmed), 0)::numeric(14,2)
  from public._ps_revenue_lines(p_from, p_to) l
  join public._patient_sources_identities() i on i.identity = l.identity
  where not l.overlap
  group by i.channel
  order by i.channel;
end;
$function$
;
grant execute on function ps_old.patient_sources_revenue(p_from date, p_to date) to authenticated;

CREATE OR REPLACE FUNCTION ps_old.patient_sources_series(p_from date, p_to date, p_grain text, p_mode text)
 RETURNS TABLE(bucket_start date, channel text, confirmed integer, unconfirmed integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
begin
  if not (public.has_role(array['admin']) or coalesce((select auth.role()), '') = 'service_role') then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  if p_grain is null or p_grain not in ('day', 'week', 'month', 'period') then
    raise exception 'Unknown grouping %', coalesce(p_grain, '(none)') using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('new', 'served') then
    raise exception 'Unknown count %', coalesce(p_mode, '(none)') using errcode = '22023';
  end if;

  if p_mode = 'new' then
    return query
    select public._ps_bucket(i.first_date, p_grain, p_from), i.channel,
           (count(*) filter (where i.confirmed))::int,
           (count(*) filter (where not i.confirmed))::int
    from public._patient_sources_identities() i
    where i.basis in ('encounter', 'registration')
      and not i.is_returning
      and i.first_date between p_from and p_to
    group by 1, 2
    order by 1, 2;
  else
    return query
    with served as (
      select distinct public._ps_bucket(e.service_date, p_grain, p_from) as b, e.identity
      from public._patient_sources_encounters() e
      where e.service_date between p_from and p_to
    )
    select s.b, i.channel,
           (count(*) filter (where i.confirmed))::int,
           (count(*) filter (where not i.confirmed))::int
    from served s
    join public._patient_sources_identities() i on i.identity = s.identity
    group by 1, 2
    order by 1, 2;
  end if;
end;
$function$
;
grant execute on function ps_old.patient_sources_series(p_from date, p_to date, p_grain text, p_mode text) to authenticated;

CREATE OR REPLACE FUNCTION ps_old.patient_sources_summary(p_from date, p_to date)
 RETURNS TABLE(new_confirmed integer, new_unconfirmed integer, returning_first_recorded integer, served_confirmed integer, served_unconfirmed integer, undated_registrations integer, source_recorded integer, source_total integer, sheet_last_dates jsonb, sync_paused boolean, last_synced_at timestamp with time zone, sheet_rows_present boolean, last_run_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
begin
  if not (public.has_role(array['admin']) or coalesce((select auth.role()), '') = 'service_role') then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);

  return query
  with ids as (
    select * from public._patient_sources_identities()
  ),
  newish as (
    select * from ids i
    where i.basis in ('encounter', 'registration') and i.first_date between p_from and p_to
  ),
  served as (
    select distinct e.identity from public._patient_sources_encounters() e
    where e.service_date between p_from and p_to
  )
  select
    (select count(*) from newish n where n.confirmed and not n.is_returning)::int,
    (select count(*) from newish n where not n.confirmed)::int,
    (select count(*) from newish n where n.confirmed and n.is_returning)::int,
    (select count(*) from served s where s.identity like 'patient:%')::int,
    (select count(*) from served s where s.identity like 'name:%')::int,
    (select count(*) from ids i where i.basis = 'undated')::int,
    (select count(*) from newish n where not n.is_returning and n.channel <> 'not_recorded')::int,
    (select count(*) from newish n where not n.is_returning)::int,
    (select coalesce(jsonb_object_agg(t.tab, t.last_date), '{}'::jsonb)
       from (select l.tab, max(l.service_date) as last_date
               from public.sheet_encounter_lines l group by l.tab
             union all
             select 'customers', max(c.registered_on)
               from public.sheet_customer_rows c having count(*) > 0) t),
    (select s.paused from public.sheet_sync_settings s where s.id),
    (select max(r.ended_at) from public.sheet_sync_runs r
      where r.status in ('succeeded', 'partial') and not r.dry_run and r.trigger in ('cron', 'manual', 'cli')),
    (exists (select 1 from public.sheet_encounter_lines) or exists (select 1 from public.sheet_customer_rows)),
    (select r.status from public.sheet_sync_runs r
      where not r.dry_run and r.trigger in ('cron', 'manual', 'cli')
        and r.status in ('succeeded', 'partial', 'failed')
      order by r.started_at desc, r.id desc
      limit 1);
end;
$function$
;
grant execute on function ps_old.patient_sources_summary(p_from date, p_to date) to authenticated;

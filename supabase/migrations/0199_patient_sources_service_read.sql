-- 0199: the service key can read the Patient Sources summary + series.
--
-- WHY. The CLI first-night check (and, later, the Phase 5 weekly email cron)
-- runs with the SERVICE key and no signed-in user. patient_sources_summary()
-- and patient_sources_series() open by raising 42501 unless
-- has_role(array['admin']) — and has_role() is false when there is no
-- signed-in staff user, so those callers were refused even though they hold
-- the strongest key we have.
--
-- WHAT. Both functions are re-created with bodies copied VERBATIM from
-- 0189_patient_sources.sql (0193 did not redefine them) changing ONLY the gate:
--   if not (public.has_role(array['admin']) or (select auth.role()) = 'service_role') then
-- so a request whose JWT role is service_role passes, exactly as an admin does.
-- An admin viewing as another role (0182) is still refused; authenticated
-- non-admins and anon are still refused (anon has no EXECUTE at all).
--
-- NO NEW EXPOSURE. service_role already bypasses RLS and reads every
-- underlying table these functions aggregate; the functions return counts only.
--
-- ADDITIVE. No signature or return-type change (database.ts is unchanged), no
-- data change. ACLs are restated: revoke from public, anon; grant execute to
-- authenticated and service_role.

create or replace function public.patient_sources_summary(p_from date, p_to date)
returns table (
  new_confirmed            int,
  new_unconfirmed          int,
  returning_first_recorded int,
  served_confirmed         int,
  served_unconfirmed       int,
  undated_registrations    int,
  source_recorded          int,
  source_total             int,
  sheet_last_dates         jsonb,
  sync_paused              boolean,
  last_synced_at           timestamptz,
  sheet_rows_present       boolean,
  last_run_status          text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (public.has_role(array['admin']) or (select auth.role()) = 'service_role') then
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
$$;

create or replace function public.patient_sources_series(p_from date, p_to date, p_grain text, p_mode text)
returns table (bucket_start date, channel text, confirmed int, unconfirmed int)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (public.has_role(array['admin']) or (select auth.role()) = 'service_role') then
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
$$;

revoke all on function public.patient_sources_summary(date, date) from public, anon;
revoke all on function public.patient_sources_series(date, date, text, text) from public, anon;
grant execute on function public.patient_sources_summary(date, date) to authenticated, service_role;
grant execute on function public.patient_sources_series(date, date, text, text) to authenticated, service_role;

-- Post-conditions: abort the deploy if an ACL or body is not what this file says.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.patient_sources_summary(date,date)',
    'public.patient_sources_series(date,date,text,text)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '0199: % is executable by anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '0199: % is not executable by authenticated', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception '0199: % is not executable by service_role', f;
    end if;
    if pg_get_functiondef(f::regprocedure) not like '%''service_role''%' then
      raise exception '0199: % does not carry the service_role gate branch', f;
    end if;
  end loop;
end;
$$;

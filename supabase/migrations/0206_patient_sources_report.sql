-- 0206_patient_sources_report.sql
--
-- Sheet Sync extra (b): the Patient Sources page built the identity core
-- (_patient_sources_identities, ~185 ms on prod) once PER RPC — 8+ times per
-- page view, more when a series paged past 1,000 rows — and read 8 different
-- snapshots. This migration:
--   * adds row types + list builders so the identity core, encounters and
--     revenue lines can be built ONCE and handed around as arrays;
--   * moves each section's rule, verbatim, into one internal helper over those
--     arrays (_ps_sec_*), so every number has exactly one definition;
--   * re-creates the five report RPCs as wrappers (same signature, columns,
--     gate, validation order, ACL, SECURITY DEFINER, search_path);
--   * adds patient_sources_report(from, to, grain, mode, prev_from, prev_to)
--     returning every section of the page as one jsonb from one snapshot.
-- The identity core, encounters, revenue lines and patient_sources_people are
-- NOT changed. Additive + create-or-replace with identical signatures: the live
-- app keeps working whether this lands before or after the deploy.

-- 1. Row types (must match their producers; post-condition below).
create type public._ps_identity as (
  identity text, confirmed boolean, survivor_id uuid, loose_key text, first_date date,
  basis text, is_returning boolean, channel text, referrer_raw text
);
create type public._ps_encounter as (
  identity text, survivor_id uuid, loose_key text, service_date date, source text
);
create type public._ps_revenue_line as (
  identity text, survivor_id uuid, service_date date, source text, php numeric, overlap boolean
);

-- 2. List builders.
create or replace function public._ps_identity_list()
returns public._ps_identity[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(row(i.identity, i.confirmed, i.survivor_id, i.loose_key, i.first_date,
                                i.basis, i.is_returning, i.channel, i.referrer_raw)::public._ps_identity),
                  '{}'::public._ps_identity[])
  from public._patient_sources_identities() i
$$;

create or replace function public._ps_encounter_list()
returns public._ps_encounter[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(row(e.identity, e.survivor_id, e.loose_key, e.service_date, e.source)::public._ps_encounter),
                  '{}'::public._ps_encounter[])
  from public._patient_sources_encounters() e
$$;

create or replace function public._ps_revenue_line_list(p_from date, p_to date)
returns public._ps_revenue_line[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(row(l.identity, l.survivor_id, l.service_date, l.source, l.php, l.overlap)::public._ps_revenue_line),
                  '{}'::public._ps_revenue_line[])
  from public._ps_revenue_lines(p_from, p_to) l
$$;

-- 3. Section helpers (no gate: callers gate and validate).
create or replace function public._ps_sec_summary(
  p_ids public._ps_identity[], p_enc public._ps_encounter[], p_from date, p_to date)
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
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with ids as (
    select * from unnest(p_ids)
  ),
  newish as (
    select * from ids i
    where i.basis in ('encounter', 'registration') and i.first_date between p_from and p_to
  ),
  served as (
    select distinct e.identity from unnest(p_enc) e
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

create or replace function public._ps_sec_series(
  p_ids public._ps_identity[], p_enc public._ps_encounter[], p_from date, p_to date, p_grain text, p_mode text)
returns table (bucket_start date, channel text, confirmed int, unconfirmed int)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_mode = 'new' then
    return query
    select public._ps_bucket(i.first_date, p_grain, p_from), i.channel,
           (count(*) filter (where i.confirmed))::int,
           (count(*) filter (where not i.confirmed))::int
    from unnest(p_ids) i
    where i.basis in ('encounter', 'registration')
      and not i.is_returning
      and i.first_date between p_from and p_to
    group by 1, 2
    order by 1, 2;
  else
    return query
    with served as (
      select distinct public._ps_bucket(e.service_date, p_grain, p_from) as b, e.identity
      from unnest(p_enc) e
      where e.service_date between p_from and p_to
    )
    select s.b, i.channel,
           (count(*) filter (where i.confirmed))::int,
           (count(*) filter (where not i.confirmed))::int
    from served s
    join unnest(p_ids) i on i.identity = s.identity
    group by 1, 2
    order by 1, 2;
  end if;
end;
$$;

create or replace function public._ps_sec_revenue(p_ids public._ps_identity[], p_lines public._ps_revenue_line[])
returns table (channel text, confirmed_php numeric, unconfirmed_php numeric)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  select i.channel,
         coalesce(sum(l.php) filter (where i.confirmed), 0)::numeric(14,2),
         coalesce(sum(l.php) filter (where not i.confirmed), 0)::numeric(14,2)
  from unnest(p_lines) l
  join unnest(p_ids) i on i.identity = l.identity
  where not l.overlap
  group by i.channel
  order by i.channel;
end;
$$;

create or replace function public._ps_sec_overlaps(p_lines public._ps_revenue_line[])
returns table (patient_id uuid, drm_id text, service_date date, app_php numeric, sheet_php numeric)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with lines as (
    select * from unnest(p_lines)
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
$$;

create or replace function public._ps_sec_referrers(p_ids public._ps_identity[], p_from date, p_to date, p_limit int)
returns table (doctor_label text, new_confirmed int, new_unconfirmed int)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with ids as (
    select * from unnest(p_ids) i
    where i.basis in ('encounter', 'registration') and not i.is_returning
      and i.first_date between p_from and p_to
  ),
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
$$;

-- 4. The five RPCs as wrappers (signatures, gates, validation order unchanged).
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
  if not (public.has_role(array['admin']) or coalesce((select auth.role()), '') = 'service_role') then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  return query
  select * from public._ps_sec_summary(public._ps_identity_list(), public._ps_encounter_list(), p_from, p_to);
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
  return query
  select * from public._ps_sec_series(
    public._ps_identity_list(),
    -- 'new' never reads encounters directly: skip building them.
    case when p_mode = 'served' then public._ps_encounter_list() else '{}'::public._ps_encounter[] end,
    p_from, p_to, p_grain, p_mode);
end;
$$;

create or replace function public.patient_sources_revenue(p_from date, p_to date)
returns table (channel text, confirmed_php numeric, unconfirmed_php numeric)
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
  return query
  select * from public._ps_sec_revenue(public._ps_identity_list(), public._ps_revenue_line_list(p_from, p_to));
end;
$$;

create or replace function public.patient_sources_overlaps(p_from date, p_to date)
returns table (patient_id uuid, drm_id text, service_date date, app_php numeric, sheet_php numeric)
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
  return query
  select * from public._ps_sec_overlaps(public._ps_revenue_line_list(p_from, p_to));
end;
$$;

create or replace function public.patient_sources_referrers(p_from date, p_to date, p_limit int default 20)
returns table (doctor_label text, new_confirmed int, new_unconfirmed int)
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
  return query
  select * from public._ps_sec_referrers(public._ps_identity_list(), p_from, p_to, p_limit);
end;
$$;

-- 5. The page's one call.
create or replace function public.patient_sources_report(
  p_from date, p_to date, p_grain text, p_mode text,
  p_prev_from date default null, p_prev_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids   public._ps_identity[];
  v_enc   public._ps_encounter[];
  v_lines public._ps_revenue_line[];
begin
  -- Same gate as summary/series (0199): the coalesce is load-bearing — without
  -- it a session with no role claim fails OPEN. The server key may read every
  -- section (Phase 5's weekly email); it already bypasses RLS everywhere.
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
  if (p_prev_from is null) <> (p_prev_to is null) then
    raise exception 'Pick both ends of the comparison period, or neither' using errcode = '22023';
  end if;
  if p_prev_from is not null then
    perform public._ps_check_period(p_prev_from, p_prev_to);
  end if;

  v_ids := public._ps_identity_list();
  v_enc := public._ps_encounter_list();
  v_lines := public._ps_revenue_line_list(p_from, p_to);

  return jsonb_build_object(
    'summary',
      (select to_jsonb(s) from public._ps_sec_summary(v_ids, v_enc, p_from, p_to) s),
    'series',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start, x.channel), '[]'::jsonb)
         from public._ps_sec_series(v_ids, v_enc, p_from, p_to, p_grain, p_mode) x),
    'current',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start, x.channel), '[]'::jsonb)
         from public._ps_sec_series(v_ids, v_enc, p_from, p_to, 'period', p_mode) x),
    'previous',
      case when p_prev_from is null then null else
        (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start, x.channel), '[]'::jsonb)
           from public._ps_sec_series(v_ids, v_enc, p_prev_from, p_prev_to, 'period', p_mode) x)
      end,
    'new_by_day',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start, x.channel), '[]'::jsonb)
         from public._ps_sec_series(v_ids, v_enc, p_from, p_to, 'day', 'new') x),
    'revenue',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.channel), '[]'::jsonb)
         from public._ps_sec_revenue(v_ids, v_lines) x),
    'overlaps',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.service_date, x.drm_id), '[]'::jsonb)
         from public._ps_sec_overlaps(v_lines) x),
    'referrers',
      -- Keep the helper's own order (count desc, spelling): WITH ORDINALITY.
      -- Top 20, the page's only size (patient_sources_referrers keeps p_limit).
      (select coalesce(jsonb_agg(jsonb_build_object(
                'doctor_label', x.doctor_label, 'new_confirmed', x.new_confirmed,
                'new_unconfirmed', x.new_unconfirmed) order by x.ord), '[]'::jsonb)
         from public._ps_sec_referrers(v_ids, p_from, p_to, 20)
              with ordinality as x(doctor_label, new_confirmed, new_unconfirmed, ord))
  );
end;
$$;

-- 6. ACLs.
-- The row types carry no data; only the closed helpers use them.
revoke all on type public._ps_identity from public;
revoke all on type public._ps_encounter from public;
revoke all on type public._ps_revenue_line from public;
revoke all on function public._ps_identity_list() from public, anon, authenticated, service_role;
revoke all on function public._ps_encounter_list() from public, anon, authenticated, service_role;
revoke all on function public._ps_revenue_line_list(date, date) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_summary(public._ps_identity[], public._ps_encounter[], date, date) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_series(public._ps_identity[], public._ps_encounter[], date, date, text, text) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_revenue(public._ps_identity[], public._ps_revenue_line[]) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_overlaps(public._ps_revenue_line[]) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_referrers(public._ps_identity[], date, date, int) from public, anon, authenticated, service_role;

revoke all on function public.patient_sources_summary(date, date) from public, anon;
revoke all on function public.patient_sources_series(date, date, text, text) from public, anon;
revoke all on function public.patient_sources_revenue(date, date) from public, anon;
revoke all on function public.patient_sources_overlaps(date, date) from public, anon;
revoke all on function public.patient_sources_referrers(date, date, int) from public, anon;
revoke all on function public.patient_sources_report(date, date, text, text, date, date) from public, anon;
grant execute on function public.patient_sources_summary(date, date) to authenticated, service_role;
grant execute on function public.patient_sources_series(date, date, text, text) to authenticated, service_role;
grant execute on function public.patient_sources_revenue(date, date) to authenticated;
grant execute on function public.patient_sources_overlaps(date, date) to authenticated;
grant execute on function public.patient_sources_referrers(date, date, int) to authenticated;
grant execute on function public.patient_sources_report(date, date, text, text, date, date) to authenticated, service_role;

-- 7. Post-conditions: abort the deploy if anything is not what this file says.
do $$
declare
  f text;
  v_pair text[];
begin
  foreach f in array array[
    'public._ps_identity_list()', 'public._ps_encounter_list()', 'public._ps_revenue_line_list(date,date)',
    'public._ps_sec_summary(public._ps_identity[],public._ps_encounter[],date,date)',
    'public._ps_sec_series(public._ps_identity[],public._ps_encounter[],date,date,text,text)',
    'public._ps_sec_revenue(public._ps_identity[],public._ps_revenue_line[])',
    'public._ps_sec_overlaps(public._ps_revenue_line[])',
    'public._ps_sec_referrers(public._ps_identity[],date,date,integer)'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('service_role', f, 'execute') then
      raise exception '0206: internal % is executable by a runtime role', f;
    end if;
  end loop;

  foreach f in array array[
    'public.patient_sources_summary(date,date)', 'public.patient_sources_series(date,date,text,text)',
    'public.patient_sources_revenue(date,date)', 'public.patient_sources_overlaps(date,date)',
    'public.patient_sources_referrers(date,date,integer)',
    'public.patient_sources_report(date,date,text,text,date,date)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '0206: % is executable by anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '0206: % is not executable by authenticated', f;
    end if;
    if not (select p.prosecdef from pg_proc p where p.oid = f::regprocedure) then
      raise exception '0206: % lost SECURITY DEFINER', f;
    end if;
  end loop;

  foreach f in array array[
    'public.patient_sources_summary(date,date)', 'public.patient_sources_series(date,date,text,text)',
    'public.patient_sources_report(date,date,text,text,date,date)'
  ] loop
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception '0206: % is not executable by service_role', f;
    end if;
    if pg_get_functiondef(f::regprocedure) not like '%coalesce((select auth.role()), '''') = ''service_role''%' then
      raise exception '0206: % does not carry the coalesced service_role gate', f;
    end if;
  end loop;

  foreach f in array array[
    'public.patient_sources_revenue(date,date)', 'public.patient_sources_overlaps(date,date)',
    'public.patient_sources_referrers(date,date,integer)'
  ] loop
    if pg_get_functiondef(f::regprocedure) like '%service_role%' then
      raise exception '0206: % must stay admin-only', f;
    end if;
  end loop;

  foreach v_pair slice 1 in array array[
    ['public._ps_identity', 'public._patient_sources_identities()'],
    ['public._ps_encounter', 'public._patient_sources_encounters()'],
    ['public._ps_revenue_line', 'public._ps_revenue_lines(date,date)']
  ] loop
    if 'TABLE(' || (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
                      from pg_attribute a
                      where a.attrelid = (select t.typrelid from pg_type t where t.oid = v_pair[1]::regtype)
                        and a.attnum > 0 and not a.attisdropped) || ')'
       is distinct from pg_get_function_result(v_pair[2]::regprocedure) then
      raise exception '0206: type % does not match %', v_pair[1], v_pair[2];
    end if;
  end loop;
end;
$$;

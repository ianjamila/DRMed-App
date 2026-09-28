-- =============================================================================
-- 0189_patient_sources.sql — Sheet Sync PR 2: Marketing › Patient Sources
-- =============================================================================
-- Spec: docs/superpowers/specs/2026-09-28-patient-sources-pr2-design.md
-- (supersedes §6 of the 2026-09-24 sheet-sync spec). Plan decisions P1–P21 in
-- docs/superpowers/plans/2026-09-28-patient-sources-pr2.md.
--
-- Additive only: private helpers (no grants), seven admin-gated report
-- functions, the ad_spend_daily table and its four functions. Nothing here
-- writes a patient, a visit or a mirror row.
--
-- Mirror mode only. When sheet_sync_settings.converted_at is set, every report
-- function raises feature_not_supported; PR 4 replaces that branch and owns the
-- before/after/purge equivalence proof (parent spec §8).
-- =============================================================================

-- (1) Name keys — the SQL twin of normalizeName (src/lib/legacy-import/
-- normalize-name.ts) and looseKeyOf (src/lib/sheet-sync/names.ts). Parity is
-- proven by scripts/patient-sources-db-proof.ts against the TS functions.
create or replace function public._ps_name_norm(p text)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        replace(
          lower(regexp_replace(normalize(coalesce(p, ''), NFD),
                               '[' || U&'\0300' || '-' || U&'\036F' || ']', '', 'g')),
          '''', ''),
        '[^a-z0-9[:space:]]', ' ', 'g'),
      '[[:space:]]+', ' ', 'g'))
$$;

create or replace function public._ps_loose_key(p_last text, p_first text)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select public._ps_name_norm(p_last) || '|'
      || split_part(public._ps_name_norm(p_first), ' ', 1)
$$;

-- (2) Referring-doctor key: name-normalised, a leading title dropped, and
-- placeholder answers treated as blank. The most common raw spelling is the
-- label (patient_sources_referrers).
create or replace function public._ps_doctor_norm(p text)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select case when k in ('none', 'n a', 'na', 'no', 'nil', 'self') then null else k end
  from (
    select nullif(btrim(regexp_replace(public._ps_name_norm(p), '^(dra|dr|doc|doctor)( |$)', '')), '') as k
  ) x
$$;

-- (3) Merged patients → survivor, bounded like buildPatientIndex().survivor.
-- A chain over 10 hops (or a cycle) yields no row: the patient drops out
-- instead of being counted under the wrong person.
create or replace function public._ps_survivors()
returns table (patient_id uuid, survivor_id uuid)
language sql
stable
set search_path = ''
as $$
  with recursive walk as (
    select p.id as patient_id, p.id as cur, p.merged_into_id as next_id, 0 as hops
    from public.patients p
    union all
    select w.patient_id, n.id, n.merged_into_id, w.hops + 1
    from walk w
    join public.patients n on n.id = w.next_id
    where w.hops < 10
  )
  select w.patient_id, w.cur from walk w where w.next_id is null
$$;

-- (4) Guards shared by every report function.
create or replace function public._ps_assert_mirror_mode()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if exists (select 1 from public.sheet_sync_settings s where s.id and s.converted_at is not null) then
    raise exception 'Patient Sources does not read converted records yet'
      using errcode = 'feature_not_supported';
  end if;
end;
$$;

create or replace function public._ps_check_period(p_from date, p_to date)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    raise exception 'Pick a period whose start is on or before its end, at most 400 days long'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function public._ps_bucket(p_d date, p_grain text, p_from date)
returns date
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_grain
           when 'day'   then p_d
           when 'week'  then date_trunc('week', p_d::timestamp)::date   -- ISO: Monday
           when 'month' then date_trunc('month', p_d::timestamp)::date
           else p_from                                                  -- 'period'
         end
$$;

-- (5) Every encounter since 2023-12-01 (spec §1.2). One row per source line;
-- consumers take distinct (identity, service_date).
create or replace function public._patient_sources_encounters()
returns table (identity text, survivor_id uuid, loose_key text, service_date date, source text)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window date;
begin
  perform public._ps_assert_mirror_mode();
  select s.mirror_window_start into v_window from public.sheet_sync_settings s where s.id;
  v_window := coalesce(v_window, date '2026-05-26');

  return query
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  )
  select 'patient:' || s.survivor_id::text, s.survivor_id, null::text, v.visit_date, 'app'::text
  from public.visits v
  join surv s on s.patient_id = v.patient_id
  where v.deleted_at is null
    and v.visit_date >= date '2023-12-01'
    and (v.visit_date < v_window or v.legacy_import_run_id is null)
  union all
  select case when l.patient_id is null then 'name:' || l.loose_key
              else 'patient:' || s.survivor_id::text end,
         s.survivor_id,
         case when l.patient_id is null then l.loose_key end,
         l.service_date,
         'sheet'::text
  from public.sheet_encounter_lines l
  left join surv s on s.patient_id = l.patient_id
  where l.service_date >= date '2023-12-01'
    and (l.patient_id is null or s.survivor_id is not null);
end;
$$;

-- (6) One row per identity with its whole-history first date (spec §1.1, §1.3;
-- plan §1, P3–P6). basis: encounter | registration | suppressed | undated |
-- before_window. Only encounter/registration rows are ever counted as New.
create or replace function public._patient_sources_identities()
returns table (
  identity     text,
  confirmed    boolean,
  survivor_id  uuid,
  loose_key    text,
  first_date   date,
  basis        text,
  is_returning boolean,
  channel      text
)
language sql
stable
set search_path = ''
as $$
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  ),
  enc as (
    select distinct e.identity, e.service_date from public._patient_sources_encounters() e
  ),
  first_enc as (
    select e.identity, min(e.service_date) as d from enc e group by e.identity
  ),
  member as (
    select s.survivor_id,
           f.registered_on as fact_on,
           f.sheet_new_repeat,
           -- An imported patient's created_at is the import night, never a registration day.
           case when p.legacy_import_run_id is null
                then (p.created_at at time zone 'Asia/Manila')::date end as app_on
    from surv s
    join public.patients p on p.id = s.patient_id
    left join public.patient_acquisition_facts f on f.patient_id = s.patient_id
  ),
  member_ranked as (
    select m.*, min(m.fact_on) over (partition by m.survivor_id) as min_fact_on from member m
  ),
  confirmed_reg as (
    select m.survivor_id,
           -- P18, decided per GROUP: a sheet date wins; else the earliest app-native
           -- sign-up; imported-only groups with no sheet date stay undated.
           coalesce(min(m.fact_on), min(m.app_on)) as reg_on,
           case when bool_or(m.fact_on is not null)
                then coalesce(bool_or(m.sheet_new_repeat = 'repeat') filter (where m.fact_on = m.min_fact_on), false)
                else coalesce(bool_or(m.sheet_new_repeat = 'repeat'), false)
           end as is_returning
    from member_ranked m
    group by m.survivor_id
  ),
  old_visitors as (
    select distinct s.survivor_id
    from public.visits v
    join surv s on s.patient_id = v.patient_id
    where v.deleted_at is null and v.visit_date < date '2023-12-01'
  ),
  name_enc as (
    select e.identity from first_enc e where e.identity like 'name:%'
  ),
  confirmed_keys as (
    select r.survivor_id, public._ps_loose_key(sp.last_name, sp.first_name) as k
    from confirmed_reg r join public.patients sp on sp.id = r.survivor_id
    union
    select s.survivor_id, c.loose_key
    from public.sheet_customer_rows c join surv s on s.patient_id = c.patient_id
  ),
  suppressed as (
    select distinct k.survivor_id
    from confirmed_keys k join name_enc n on n.identity = 'name:' || k.k
  ),
  confirmed as (
    select 'patient:' || r.survivor_id::text as identity,
           true as confirmed,
           r.survivor_id,
           null::text as loose_key,
           case when fe.d is not null then fe.d
                when sup.survivor_id is not null then null
                else r.reg_on end as first_date,
           case when fe.d is not null then 'encounter'
                when sup.survivor_id is not null then 'suppressed'
                when r.reg_on is not null then 'registration'
                when ov.survivor_id is not null then 'before_window'
                else 'undated' end as basis,
           r.is_returning,
           coalesce(sp.referral_source, 'not_recorded') as channel
    from confirmed_reg r
    join public.patients sp on sp.id = r.survivor_id
    left join first_enc fe on fe.identity = 'patient:' || r.survivor_id::text
    left join suppressed sup on sup.survivor_id = r.survivor_id
    left join old_visitors ov on ov.survivor_id = r.survivor_id
  ),
  cust_by_key as (
    select c.loose_key,
           count(*) as n_rows,
           min(c.referral_source_id) as only_source,
           min(c.registered_on) filter (where c.patient_id is null) as unlinked_reg_on,
           bool_or(c.patient_id is null) as has_unlinked
    from public.sheet_customer_rows c
    group by c.loose_key
  ),
  name_ids as (
    select n.identity, substr(n.identity, 6) as k from name_enc n
    union
    select 'name:' || c.loose_key, c.loose_key from cust_by_key c where c.has_unlinked
  ),
  unconfirmed as (
    select ni.identity,
           false,
           null::uuid,
           ni.k,
           coalesce(fe.d, cb.unlinked_reg_on),
           case when fe.d is not null then 'encounter'
                when cb.unlinked_reg_on is not null then 'registration'
                else 'undated' end,
           false,
           case when cb.n_rows = 1 then coalesce(cb.only_source, 'not_recorded') else 'not_recorded' end
    from name_ids ni
    left join first_enc fe on fe.identity = ni.identity
    left join cust_by_key cb on cb.loose_key = ni.k
  )
  select * from confirmed
  union all
  select * from unconfirmed
$$;

-- (7) Revenue lines in a period (spec §1.6). overlap = a mirror line whose
-- (survivor, date) also has a stream-(a) app visit: excluded from revenue,
-- listed by patient_sources_overlaps.
create or replace function public._ps_revenue_lines(p_from date, p_to date)
returns table (identity text, survivor_id uuid, service_date date, source text, php numeric, overlap boolean)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window date;
begin
  perform public._ps_assert_mirror_mode();
  select s.mirror_window_start into v_window from public.sheet_sync_settings s where s.id;
  v_window := coalesce(v_window, date '2026-05-26');

  return query
  with surv as (
    select s.patient_id, s.survivor_id
    from public._ps_survivors() s
    join public.patients sp on sp.id = s.survivor_id
    where sp.deleted_at is null
  ),
  app_visits as (
    select v.id as visit_id, s.survivor_id, v.visit_date
    from public.visits v
    join surv s on s.patient_id = v.patient_id
    where v.deleted_at is null
      and v.visit_date between greatest(p_from, date '2023-12-01') and p_to
      and (v.visit_date < v_window or v.legacy_import_run_id is null)
  ),
  app_days as (
    select distinct a.survivor_id, a.visit_date from app_visits a
  ),
  app as (
    select 'patient:' || a.survivor_id::text as identity, a.survivor_id, a.visit_date as service_date,
           'app'::text as source,
           coalesce(sum(tr.final_price_php), 0)::numeric(14,2) as php,
           false as overlap
    from app_visits a
    join public.test_requests tr on tr.visit_id = a.visit_id and tr.deleted_at is null
    group by a.survivor_id, a.visit_date
  ),
  sheet as (
    select case when l.patient_id is null then 'name:' || l.loose_key
                else 'patient:' || s.survivor_id::text end,
           s.survivor_id,
           l.service_date,
           'sheet'::text,
           coalesce(l.revenue_php, 0)::numeric(14,2),
           (s.survivor_id is not null and exists (
              select 1 from app_days d where d.survivor_id = s.survivor_id and d.visit_date = l.service_date))
    from public.sheet_encounter_lines l
    left join surv s on s.patient_id = l.patient_id
    where l.service_date between greatest(p_from, date '2023-12-01') and p_to
      and (l.patient_id is null or s.survivor_id is not null)
  )
  select * from app
  union all
  select * from sheet;
end;
$$;

-- (8) The ONE definition every surface reads (spec §1.7; plan P8).
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
  if not public.has_role(array['admin']) then
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

-- (9) Channel × bucket counts, only non-empty cells (spec §1.7; plan P7).
create or replace function public.patient_sources_series(p_from date, p_to date, p_grain text, p_mode text)
returns table (bucket_start date, channel text, confirmed int, unconfirmed int)
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

-- (10) Channel revenue, billed (clinic share) — spec §1.6.
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
  select i.channel,
         coalesce(sum(l.php) filter (where i.confirmed), 0)::numeric(14,2),
         coalesce(sum(l.php) filter (where not i.confirmed), 0)::numeric(14,2)
  from public._ps_revenue_lines(p_from, p_to) l
  join public._patient_sources_identities() i on i.identity = l.identity
  where not l.overlap
  group by i.channel
  order by i.channel;
end;
$$;

-- (11) "Possible double entry": same survivor, same day, app visit AND sheet lines.
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
$$;

-- (12) Top referring doctors among the period's New customers (spec §1.7; P11).
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
  with ids as (
    select * from public._patient_sources_identities() i
    where i.basis in ('encounter', 'registration') and not i.is_returning
      and i.first_date between p_from and p_to
  ),
  surv as (
    select s.patient_id, s.survivor_id from public._ps_survivors() s
  ),
  raw as (
    select i.identity, true as confirmed,
           coalesce(
             nullif(btrim(sp.referred_by_doctor), ''),
             (select c.referred_by_raw
                from public.sheet_customer_rows c
                join surv s on s.patient_id = c.patient_id
               where s.survivor_id = i.survivor_id and nullif(btrim(c.referred_by_raw), '') is not null
               order by c.sheet_row desc
               limit 1)
           ) as raw_label
    from ids i
    join public.patients sp on sp.id = i.survivor_id
    where i.confirmed
    union all
    select i.identity, false,
           (select min(c.referred_by_raw) from public.sheet_customer_rows c
             where c.loose_key = i.loose_key having count(*) = 1)
    from ids i
    where not i.confirmed
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

-- (13) The people behind a count (spec §3.3; P9). Total order (first_date, identity).
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
$$;

-- (14) Ad spend per AD per day (spec §2.1). Writes only through the RPCs below.
create table if not exists public.ad_spend_daily (
  id             bigint generated always as identity primary key,
  spend_date     date not null,
  platform       text not null check (platform in ('meta', 'google')),
  campaign_key   text not null check (char_length(campaign_key) between 1 and 300),
  ad_key         text not null check (char_length(ad_key) between 1 and 300),
  campaign_label text not null check (char_length(campaign_label) <= 300),
  spend_php      numeric(12,2) not null check (spend_php >= 0),
  impressions    int check (impressions is null or impressions >= 0),
  clicks         int check (clicks is null or clicks >= 0),
  uploaded_by    uuid references auth.users(id),
  uploaded_at    timestamptz not null default now(),
  upload_id      uuid not null,
  constraint ad_spend_daily_key unique (spend_date, platform, campaign_key, ad_key)
);
create index if not exists ad_spend_daily_date on public.ad_spend_daily (spend_date, platform);

alter table public.ad_spend_daily enable row level security;
-- Literal revokes (not format() in a do block): seed-grant-parity.test.ts
-- regex-scans for them.
revoke all on public.ad_spend_daily from anon;
revoke all on public.ad_spend_daily from authenticated;
grant select on public.ad_spend_daily to authenticated;
drop policy if exists "ad_spend_daily: admin read" on public.ad_spend_daily;
create policy "ad_spend_daily: admin read" on public.ad_spend_daily
  for select to authenticated using ((select public.has_role(array['admin'])));

-- (15) Import: all-or-nothing upsert; duplicate keys inside one call are summed
-- (the parser already sums them — this keeps ON CONFLICT from touching a row twice).
create or replace function public.ad_spend_import(p_upload_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted int := 0;
  v_replaced int := 0;
  v_days int := 0;
  v_n int;
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can save ad spend' using errcode = '42501';
  end if;
  if p_upload_id is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Ad spend import needs an upload id and a list of rows' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n = 0 or v_n > 20000 then
    raise exception 'Ad spend import takes 1 to 20,000 rows, got %', v_n using errcode = '22023';
  end if;

  with src as (
    select r.spend_date, r.platform, r.campaign_key, r.ad_key,
           max(r.campaign_label) as campaign_label,
           sum(r.spend_php) as spend_php,
           sum(r.impressions)::int as impressions,
           sum(r.clicks)::int as clicks
    from jsonb_to_recordset(p_rows) as r(
      spend_date date, platform text, campaign_key text, ad_key text,
      campaign_label text, spend_php numeric, impressions int, clicks int)
    group by r.spend_date, r.platform, r.campaign_key, r.ad_key
  ),
  up as (
    insert into public.ad_spend_daily as a
      (spend_date, platform, campaign_key, ad_key, campaign_label, spend_php,
       impressions, clicks, uploaded_by, uploaded_at, upload_id)
    select s.spend_date, s.platform, s.campaign_key, s.ad_key, s.campaign_label, s.spend_php,
           s.impressions, s.clicks, auth.uid(), now(), p_upload_id
    from src s
    on conflict (spend_date, platform, campaign_key, ad_key) do update
      set campaign_label = excluded.campaign_label,
          spend_php      = excluded.spend_php,
          impressions    = excluded.impressions,
          clicks         = excluded.clicks,
          uploaded_by    = excluded.uploaded_by,
          uploaded_at    = excluded.uploaded_at,
          upload_id      = excluded.upload_id
    returning (xmax = 0) as inserted, a.spend_date
  )
  select count(*) filter (where u.inserted), count(*) filter (where not u.inserted), count(distinct u.spend_date)
    into v_inserted, v_replaced, v_days
  from up u;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (auth.uid(), 'staff', 'ad_spend.imported', 'ad_spend_upload', p_upload_id,
          jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced, 'days', v_days));

  return jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced, 'days', v_days);
end;
$$;

-- (16) Correction: remove saved spend for one platform over a date range.
create or replace function public.ad_spend_delete(p_platform text, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can remove ad spend' using errcode = '42501';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google') then
    raise exception 'Unknown ad platform %', coalesce(p_platform, '(none)') using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Pick a start date on or before the end date' using errcode = '22023';
  end if;

  delete from public.ad_spend_daily a
  where a.platform = p_platform and a.spend_date between p_from and p_to;
  get diagnostics v_deleted = row_count;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (auth.uid(), 'staff', 'ad_spend.deleted', 'ad_spend', null,
          jsonb_build_object('platform', p_platform, 'from', p_from, 'to', p_to, 'rows', v_deleted));

  return v_deleted;
end;
$$;

-- (17) Reads for the page (P10).
create or replace function public.ad_spend_daily_totals(p_from date, p_to date)
returns table (spend_date date, platform text, spend_php numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can see ad spend' using errcode = '42501';
  end if;
  perform public._ps_check_period(p_from, p_to);
  return query
  select a.spend_date, a.platform, sum(a.spend_php)::numeric(14,2)
  from public.ad_spend_daily a
  where a.spend_date between p_from and p_to
  group by a.spend_date, a.platform
  order by a.spend_date, a.platform;
end;
$$;

create or replace function public.ad_spend_coverage()
returns table (platform text, first_date date, last_date date, days int, total_php numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can see ad spend' using errcode = '42501';
  end if;
  return query
  select a.platform, min(a.spend_date), max(a.spend_date),
         count(distinct a.spend_date)::int, sum(a.spend_php)::numeric(14,2)
  from public.ad_spend_daily a
  group by a.platform
  order by a.platform;
end;
$$;

-- (18) Function ACLs. Helpers: callable only by their owner (the definer
-- functions above run as the owner). Report + ad-spend functions: authenticated
-- (each checks has_role(array['admin']) itself; has_role follows View-as, 0182).
revoke all on function public._ps_name_norm(text) from public, anon, authenticated, service_role;
revoke all on function public._ps_loose_key(text, text) from public, anon, authenticated, service_role;
revoke all on function public._ps_doctor_norm(text) from public, anon, authenticated, service_role;
revoke all on function public._ps_survivors() from public, anon, authenticated, service_role;
revoke all on function public._ps_assert_mirror_mode() from public, anon, authenticated, service_role;
revoke all on function public._ps_check_period(date, date) from public, anon, authenticated, service_role;
revoke all on function public._ps_bucket(date, text, date) from public, anon, authenticated, service_role;
revoke all on function public._patient_sources_encounters() from public, anon, authenticated, service_role;
revoke all on function public._patient_sources_identities() from public, anon, authenticated, service_role;
revoke all on function public._ps_revenue_lines(date, date) from public, anon, authenticated, service_role;

revoke all on function public.patient_sources_summary(date, date) from public, anon;
revoke all on function public.patient_sources_series(date, date, text, text) from public, anon;
revoke all on function public.patient_sources_revenue(date, date) from public, anon;
revoke all on function public.patient_sources_overlaps(date, date) from public, anon;
revoke all on function public.patient_sources_referrers(date, date, int) from public, anon;
revoke all on function public.patient_sources_people(date, date, text, text, int, int) from public, anon;
revoke all on function public.ad_spend_import(uuid, jsonb) from public, anon;
revoke all on function public.ad_spend_delete(text, date, date) from public, anon;
revoke all on function public.ad_spend_daily_totals(date, date) from public, anon;
revoke all on function public.ad_spend_coverage() from public, anon;
grant execute on function public.patient_sources_summary(date, date) to authenticated;
grant execute on function public.patient_sources_series(date, date, text, text) to authenticated;
grant execute on function public.patient_sources_revenue(date, date) to authenticated;
grant execute on function public.patient_sources_overlaps(date, date) to authenticated;
grant execute on function public.patient_sources_referrers(date, date, int) to authenticated;
grant execute on function public.patient_sources_people(date, date, text, text, int, int) to authenticated;
grant execute on function public.ad_spend_import(uuid, jsonb) to authenticated;
grant execute on function public.ad_spend_delete(text, date, date) to authenticated;
grant execute on function public.ad_spend_daily_totals(date, date) to authenticated;
grant execute on function public.ad_spend_coverage() to authenticated;

-- (19) Post-conditions: abort the deploy if an ACL is not what this file says.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.patient_sources_summary(date,date)',
    'public.patient_sources_series(date,date,text,text)',
    'public.patient_sources_revenue(date,date)',
    'public.patient_sources_overlaps(date,date)',
    'public.patient_sources_referrers(date,date,integer)',
    'public.patient_sources_people(date,date,text,text,integer,integer)',
    'public.ad_spend_import(uuid,jsonb)',
    'public.ad_spend_delete(text,date,date)',
    'public.ad_spend_daily_totals(date,date)',
    'public.ad_spend_coverage()'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '0189: % is executable by anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '0189: % is not executable by authenticated', f;
    end if;
  end loop;
  foreach f in array array[
    'public._ps_name_norm(text)', 'public._ps_loose_key(text,text)', 'public._ps_doctor_norm(text)',
    'public._ps_survivors()', 'public._ps_assert_mirror_mode()', 'public._ps_check_period(date,date)',
    'public._ps_bucket(date,text,date)', 'public._patient_sources_encounters()',
    'public._patient_sources_identities()', 'public._ps_revenue_lines(date,date)'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '0189: helper % is executable by a JWT role', f;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.ad_spend_daily', 'select')
     or has_table_privilege('authenticated', 'public.ad_spend_daily', 'insert') then
    raise exception '0189: ad_spend_daily grants are wider than admin read';
  end if;
end;
$$;

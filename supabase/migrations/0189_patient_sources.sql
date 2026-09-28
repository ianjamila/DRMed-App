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

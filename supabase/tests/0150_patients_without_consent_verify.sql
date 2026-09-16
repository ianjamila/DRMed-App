-- READ ONLY. Run after 0150 is applied, as an admin with the same visibility
-- for both paths (SQL editor postgres, or authenticated with an admin JWT).
-- Nothing here applies migrations, inserts fixtures, or changes permissions.
begin transaction isolation level repeatable read read only;

-- Both counts should agree; prod baseline measured 2026-09-15 was 6,877.
select
  (select count(*) from public.patients
   where consent_current = false and merged_into_id is null) as old_candidates,
  (select count(*) from public.v_patients_without_consent) as view_candidates;

-- Full parity, not just a sample. Old TS fetched each candidate's LIVE visits,
-- counted all rows, and took the greatest visit_date. Expect zero mismatches.
with old_path as (
  select p.id, count(v.id) as visit_count, max(v.visit_date) as last_visit_at
  from public.patients p
  left join public.visits v on v.patient_id = p.id and v.deleted_at is null
  where p.consent_current = false and p.merged_into_id is null
  group by p.id
)
select count(*) as mismatches
from old_path o
full join public.v_patients_without_consent n on n.id = o.id
where o.id is null or n.id is null
   or o.visit_count is distinct from n.visit_count
   or o.last_visit_at is distinct from n.last_visit_at;

-- A handful of ids: recent, never-visited/deleted-only, and patients with any
-- deleted visits. To inspect specific ids, replace sample with a VALUES list.
with sample as (
  (select id from public.v_patients_without_consent
   order by last_visit_at desc nulls last, id asc limit 3)
  union
  (select id from public.v_patients_without_consent
   where visit_count = 0 order by id limit 3)
  union
  (select p.id from public.patients p
   where p.consent_current = false and p.merged_into_id is null
     and exists (select 1 from public.visits v
                 where v.patient_id = p.id and v.deleted_at is not null)
   order by p.id limit 3)
)
select n.id, n.visit_count, o.visit_count as old_visit_count,
       n.last_visit_at, o.last_visit_at as old_last_visit_at
from sample s
join public.v_patients_without_consent n on n.id = s.id
cross join lateral (
  select count(*) as visit_count, max(v.visit_date) as last_visit_at
  from public.visits v
  where v.patient_id = s.id and v.deleted_at is null
) o
order by n.id;

-- Invoker=true; anon_select=false; authenticated_select=true.
select c.reloptions,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
from pg_class c
where c.oid = 'public.v_patients_without_consent'::regclass;

-- Confirm the existing partial covering index and fresh deleted_at statistics.
select indexname, indexdef from pg_indexes
where schemaname = 'public' and indexname = 'idx_visits_patient_last_visit';
select tablename, attname, null_frac, n_distinct from pg_stats
where schemaname = 'public' and tablename = 'visits' and attname = 'deleted_at';

-- Inspect actual timings/estimates under the role used by the report as well.
-- An exact count remains uncapped and necessarily scans all candidate rows.
explain (analyze, buffers)
select id, visit_count, last_visit_at
from public.v_patients_without_consent
order by last_visit_at desc nulls last, id asc
limit 10;

commit;

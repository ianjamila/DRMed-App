-- Clinical backfill validation (read-only).
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/clinical-backfill/validate.sql
\echo '=== 1. counts per year (legacy clinical rows) ==='
select extract(year from v.visit_date)::int as yr,
  count(distinct v.id) as visits,
  count(distinct t.id) as test_requests,
  count(distinct p.id) as payments
from public.visits v
left join public.test_requests t on t.visit_id = v.id and t.legacy_import_run_id is not null
left join public.payments p on p.visit_id = v.id and p.legacy_import_run_id is not null
where v.legacy_import_run_id is not null
group by 1 order by 1;

\echo '=== 2. payment_status distribution ==='
select payment_status, count(*) from public.visits
where legacy_import_run_id is not null group by 1 order by 1;

\echo '=== 3. GL-SILENCE assertion: zero JEs reference clinical legacy rows ==='
select count(*) as must_be_zero
from public.journal_entries je
where je.source_kind in ('payment','test_request')
  and je.source_id in (
    select id from public.payments where legacy_import_run_id is not null
    union all select id from public.test_requests where legacy_import_run_id is not null
  );

\echo '=== 4. books reconciliation: clinical final vs history_import revenue, per year ==='
with clinical as (
  select extract(year from t.released_at)::int as yr, sum(t.final_price_php) as clinical_final
  from public.test_requests t where t.legacy_import_run_id is not null group by 1
),
books as (
  select extract(year from je.posting_date)::int as yr, sum(jl.credit_php) as booked_revenue
  from public.journal_entries je
  join public.journal_lines jl on jl.entry_id = je.id
  join public.chart_of_accounts coa on coa.id = jl.account_id
  where je.source_kind = 'history_import' and coa.code in ('4100','4200','4500')
  group by 1
)
select coalesce(c.yr,b.yr) as yr,
  to_char(c.clinical_final,'FM999,999,999.00') as clinical,
  to_char(b.booked_revenue,'FM999,999,999.00') as books,
  to_char(coalesce(c.clinical_final,0)-coalesce(b.booked_revenue,0),'FM999,999,999.00') as diff
from clinical c full outer join books b on b.yr = c.yr order by 1;

\echo '=== 5. orphans / sanity ==='
select 'visits total<>sum(lines)' as check, count(*) as n from (
  select v.id from public.visits v
  join public.test_requests t on t.visit_id = v.id and t.legacy_import_run_id is not null
  where v.legacy_import_run_id is not null
  group by v.id, v.total_php having v.total_php <> round(sum(t.final_price_php),2)
) x;

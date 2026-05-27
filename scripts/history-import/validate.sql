-- 12.B history-import validation queries.
--
-- Run after each tab's commit to verify totals, balances, and per-HMO aging.
-- All queries are read-only.
--
-- Run via:
--   docker exec supabase_db_DRMed psql -U postgres -f - < scripts/history-import/validate.sql

\echo '=== 1. JE count + balance per (year, tab) ==='
select
  extract(year from je.posting_date)::int as fiscal_year,
  case
    when je.notes like '%xlsx EXPENSES r%'             then 'EXPENSES'
    when je.notes like '%xlsx VERITAS PAY r%'          then 'VERITAS PAY'
    when je.notes like '%xlsx DOCTOR CONSULTATION r%'  then 'DOCTOR CONSULTATION'
    when je.notes like '%xlsx LAB SERVICE r%'          then 'LAB SERVICE'
    else '(other)'
  end as source_tab,
  count(distinct je.id) as jes,
  to_char(sum(jl.debit_php), 'FM999,999,999.00') as total_dr,
  to_char(sum(jl.credit_php), 'FM999,999,999.00') as total_cr,
  to_char(sum(jl.debit_php) - sum(jl.credit_php), 'FM999,999,999.00') as diff
from journal_entries je
join journal_lines jl on jl.entry_id = je.id
where je.source_kind = 'history_import'
group by 1, 2
order by 1, 2;

\echo
\echo '=== 2. CoA totals — 12.B history only (anchor for IS comparison) ==='
select coa.code, coa.name,
  to_char(sum(jl.debit_php), 'FM999,999,999.00') as dr,
  to_char(sum(jl.credit_php), 'FM999,999,999.00') as cr,
  to_char(sum(jl.debit_php - jl.credit_php), 'FM999,999,999.00') as net
from journal_entries je
join journal_lines jl on jl.entry_id = je.id
join chart_of_accounts coa on coa.id = jl.account_id
where je.source_kind = 'history_import'
group by 1, 2
order by 1;

\echo
\echo '=== 3. HMO subledger by provider (combined DOC + LAB) ==='
select hmo_provider,
  count(*) as claims,
  to_char(sum(final_amount_php), 'FM999,999,999.00') as billed_total,
  to_char(sum(case when status = 'paid' then final_amount_php else 0 end), 'FM999,999,999.00') as paid,
  to_char(sum(case when status in ('pending', 'overdue') then final_amount_php else 0 end), 'FM999,999,999.00') as outstanding,
  to_char(sum(case when status = 'overdue' then final_amount_php else 0 end), 'FM999,999,999.00') as overdue,
  to_char(sum(case when status = 'unknown' then final_amount_php else 0 end), 'FM999,999,999.00') as unknown_status
from historic_hmo_claims
group by 1
order by sum(final_amount_php) desc;

\echo
\echo '=== 4. AR-HMO control account reconciliation ==='
\echo 'GL 1110 net balance vs sum of outstanding historic_hmo_claims (LAB SERVICE only — DOC CONS subledger was not booked to GL).'
with gl_1110 as (
  select coalesce(sum(jl.debit_php - jl.credit_php), 0) as net
  from journal_lines jl
  join chart_of_accounts coa on coa.id = jl.account_id
  where coa.code = '1110'
),
sub_outstanding as (
  select coalesce(sum(final_amount_php), 0) as total
  from historic_hmo_claims
  where source_tab = 'LAB SERVICE' and status in ('pending', 'overdue', 'unknown')
)
select
  to_char((select net from gl_1110), 'FM999,999,999.00') as gl_1110_net,
  to_char((select total from sub_outstanding), 'FM999,999,999.00') as subledger_outstanding,
  to_char((select net from gl_1110) - (select total from sub_outstanding), 'FM999,999,999.00') as diff;

\echo
\echo '=== 5. HMO aging buckets (combined) — relative to today ==='
select hmo_provider,
  to_char(sum(case when current_date - claim_date <= 30 then final_amount_php else 0 end), 'FM999,999.00') as bucket_0_30,
  to_char(sum(case when current_date - claim_date between 31 and 60 then final_amount_php else 0 end), 'FM999,999.00') as bucket_31_60,
  to_char(sum(case when current_date - claim_date between 61 and 90 then final_amount_php else 0 end), 'FM999,999.00') as bucket_61_90,
  to_char(sum(case when current_date - claim_date > 90 then final_amount_php else 0 end), 'FM999,999.00') as bucket_over_90
from historic_hmo_claims
where status in ('pending', 'overdue', 'unknown')
group by 1
order by sum(final_amount_php) desc;

\echo
\echo '=== 6. Bills (AP) — 12.B history bills ==='
select v.name as vendor,
  count(*) as bills,
  to_char(sum(b.gross_amount), 'FM999,999.00') as gross_total,
  to_char(sum(b.outstanding_amount), 'FM999,999.00') as outstanding
from bills b
join vendors v on v.id = b.vendor_id
where b.vendor_invoice_number like 'HIST-EXP-r%'
group by 1
order by sum(b.gross_amount) desc;

-- 2026 books reconciliation — run against PROD via the Supabase MCP.
-- Diagnoses why the GL Income Statement (Jan–May 2026) disagrees with the clinic's
-- manual Income Statement. See docs/superpowers/specs/2026-06-07-books-reconciliation-2026-findings.md.
-- READ-ONLY. June 2026 intentionally excluded.

-- (1) GL income statement per account, Jan–May 2026 (posted), signed per normal_balance.
with rng as (select date '2026-01-01' f, date '2026-05-31' t)
select coa.type, coa.code, coa.name,
  case when coa.type='revenue' then sum(jl.credit_php - jl.debit_php)
       else sum(jl.debit_php - jl.credit_php) end as signed_balance
from public.journal_lines jl
join public.journal_entries je on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id
cross join rng
where je.status='posted' and je.posting_date between rng.f and rng.t
  and coa.type in ('revenue','contra_revenue','expense')
group by coa.type, coa.code, coa.name
order by coa.type, coa.code;

-- (2) ROOT CAUSE: expense debits split by source_kind. history_import ≈ the manual sheet;
--     bill_post is the duplicate layer (all history-tagged, no genuine live bills).
with rng as (select date '2026-01-01' f, date '2026-05-31' t)
select je.source_kind,
       count(distinct je.id) as entries,
       sum(jl.debit_php - jl.credit_php) as expense_debit
from public.journal_lines jl
join public.journal_entries je on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id
cross join rng
where je.status='posted' and je.posting_date between rng.f and rng.t
  and coa.type='expense'
group by je.source_kind order by expense_debit desc;
-- EXPECT: history_import ~2,722,795 (≈ sheet) ; bill_post ~418,319 (DUPLICATE).

-- (3) The 75 duplicate bill_post expense entries to reverse (all '[history imported_at]').
select je.entry_number, je.posting_date, je.source_id, left(je.description,70) as description,
       sum(jl.debit_php - jl.credit_php) as expense_debit
from public.journal_entries je
join public.journal_lines jl on jl.entry_id = je.id
join public.chart_of_accounts coa on coa.id = jl.account_id and coa.type='expense'
where je.status='posted' and je.source_kind='bill_post'
  and je.description ilike '%[history imported_at%'
group by je.id, je.entry_number, je.posting_date, je.source_id, je.description
order by expense_debit desc;

-- (4) Missing income: Rent Received (4300) + Consult Discounts (4920) should be > 0 after fix.
select coa.code, coa.name,
       coalesce(sum(case when je.status='posted' then jl.credit_php - jl.debit_php end),0) as posted_balance
from public.chart_of_accounts coa
left join public.journal_lines jl on jl.account_id = coa.id
left join public.journal_entries je on je.id = jl.entry_id
  and je.posting_date between date '2026-01-01' and date '2026-05-31'
where coa.code in ('4300','4920')
group by coa.code, coa.name;
-- EXPECT today: both 0 (rent income unbooked). Sheet has rent ₱37,500 Jan–May.

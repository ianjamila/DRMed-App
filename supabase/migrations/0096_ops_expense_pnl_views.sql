-- 0096_ops_expense_pnl_views.sql
-- Part B / B1.3 — Expenses + Net income + Cash flow read-layer.
-- Two views over the GL (posted journal entries), so the Operations P&L cannot
-- disagree with the Income Statement. Both security_invoker = on + NO grant to
-- anon/authenticated: only the service-role admin client reads them (clinic-wide
-- financials past patient RLS). See
-- docs/superpowers/specs/2026-06-07-partB-b1.3-expenses-net-income-design.md.

-- (1) Per-account daily expenses — the 17 sheet lines + an "Other" catch-all. ----
-- Same logic as 0094 v_ops_daily_expenses but grouped by account (keeps code+name);
-- Σ over a day == the 0094 total by construction. posting_date is a plain DATE.
create or replace view public.v_ops_daily_expense_accounts
with (security_invoker = on) as
select
  je.posting_date                                              as business_date,
  coa.code,
  coa.name,
  coalesce(sum(jl.debit_php - jl.credit_php), 0)::numeric(14,2) as expense_php
from public.journal_lines jl
join public.journal_entries je   on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id
where coa.type = 'expense'
  and je.status = 'posted'
group by je.posting_date, coa.code, coa.name;

alter view public.v_ops_daily_expense_accounts owner to postgres;

-- (2) Per-day P&L-by-type — for the "reconciliation to books" net income. --------
-- Pre-signed balance columns (per normal_balance): revenue is credit-normal,
-- contra_revenue + expense are debit-normal. books_net_income =
-- Σ(revenue_php - contra_revenue_php - expense_php).
create or replace view public.v_ops_daily_pnl
with (security_invoker = on) as
select
  je.posting_date as business_date,
  coalesce(sum(case when coa.type='revenue'
    then (jl.credit_php - jl.debit_php) else 0 end),0)::numeric(14,2) as revenue_php,
  coalesce(sum(case when coa.type='contra_revenue'
    then (jl.debit_php - jl.credit_php) else 0 end),0)::numeric(14,2) as contra_revenue_php,
  coalesce(sum(case when coa.type='expense'
    then (jl.debit_php - jl.credit_php) else 0 end),0)::numeric(14,2) as expense_php
from public.journal_lines jl
join public.journal_entries je   on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id
where je.status = 'posted'
  and coa.type in ('revenue','contra_revenue','expense')
group by je.posting_date;

alter view public.v_ops_daily_pnl owner to postgres;

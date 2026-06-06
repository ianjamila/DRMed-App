-- 0094_ops_daily_expenses.sql
-- Part B / B1.1 follow-up — a per-day GL expenses total for the Operational
-- daily report's rough "Net" line. Mirrors the Income Statement P&L exactly:
-- posted journal entries, expense-type accounts, expense = sum(debit - credit),
-- grouped by posting_date (a plain DATE — no Manila cast needed). Read-only,
-- security_invoker = on, NO grant to anon/authenticated (admin client only).
-- NOTE: this is the lightweight total only; the full 17-line expense P&L +
-- net income + cash flow is the later B1.3 phase.

create or replace view public.v_ops_daily_expenses
with (security_invoker = on) as
select
  je.posting_date as business_date,
  coalesce(sum(jl.debit_php - jl.credit_php), 0)::numeric(14,2) as expense_php
from public.journal_lines jl
join public.journal_entries je on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id
where coa.type = 'expense'
  and je.status = 'posted'
group by je.posting_date;

alter view public.v_ops_daily_expenses owner to postgres;

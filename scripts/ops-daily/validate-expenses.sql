-- B1.3 reconciliation — run against PROD via the Supabase MCP (reference figures
-- live only in prod). Asserts the Operations P&L ties to the books + the sheet.

-- (A) Books-tie invariant: Σ per-account expenses == 0094 total == Σ pnl.expense,
--     for a recent full month (adjust the range as needed).
with rng as (select date '2025-05-01' as f, date '2025-05-31' as t)
select
  (select coalesce(sum(expense_php),0) from public.v_ops_daily_expense_accounts, rng
     where business_date between f and t)                              as per_account_total,
  (select coalesce(sum(expense_php),0) from public.v_ops_daily_expenses, rng
     where business_date between f and t)                              as v0094_total,
  (select coalesce(sum(expense_php),0) from public.v_ops_daily_pnl, rng
     where business_date between f and t)                             as pnl_expense_total;
-- EXPECT: all three equal to the peso.

-- (B) Per-line breakdown for that month (eyeball against the books / sheet).
with rng as (select date '2025-05-01' as f, date '2025-05-31' as t)
select code, name, sum(expense_php) as month_expense
from public.v_ops_daily_expense_accounts, rng
where business_date between f and t
group by code, name order by code;

-- (C) Books net income for the month.
with rng as (select date '2025-05-01' as f, date '2025-05-31' as t)
select coalesce(sum(revenue_php - contra_revenue_php - expense_php),0) as books_net_income
from public.v_ops_daily_pnl, rng
where business_date between f and t;

-- (D) Sheet spot-check: Dec 2 2023 — sheet r70 Salaries 700, r71 Doctors Payroll 80,
--     r87 TOTAL 780, r88 NET 6,630.
select code, name, expense_php
from public.v_ops_daily_expense_accounts
where business_date = date '2023-12-02' order by code;
select coalesce(sum(expense_php),0) as total_expenses_dec2
from public.v_ops_daily_expense_accounts where business_date = date '2023-12-02';

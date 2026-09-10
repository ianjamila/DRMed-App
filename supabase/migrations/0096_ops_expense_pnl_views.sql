-- 0096_ops_expense_pnl_views.sql
-- Part B / B1.3 — Expenses + Net income + Cash flow read-layer.
-- Two views over the GL (posted journal entries), so the Operations P&L cannot
-- disagree with the Income Statement. Both security_invoker = on; read in
-- practice only by the service-role admin client (clinic-wide financials past
-- patient RLS). (Corrected 2026-09-10: "NO grant to anon/authenticated" was
-- never true — see the note at the foot of this file.) See
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

-- ---------------------------------------------------------------------------
-- GRANTS ON THIS FILE'S VIEWS — measured on prod 2026-09-10, not assumed
-- ---------------------------------------------------------------------------
-- These views DO carry the default anon + authenticated grants. Supabase's
-- `alter default privileges for role postgres in schema public grant all on
-- tables` applies to every new view, and no migration ever revoked it here, so
-- the original "NO grant to anon/authenticated" comments were wrong from the
-- day they were written. Verified via information_schema.role_table_grants.
--
-- The views are nonetheless NOT readable, because `security_invoker = on` makes
-- them run with the CALLER's rights and the base-table RLS policies then apply.
-- Persona simulation on prod (`set local role …`, rolled back):
--
--     role                     rows returned
--     anon                     0  (all six v_ops_daily_* views)
--     medtech (authenticated)  0  (all six)
--     postgres / service_role  782 – 2,230 depending on the view
--
-- So the protection is real; only the mechanism named in the comment was wrong.
-- The grant is the door, RLS is the lock — the standard Supabase model, and the
-- same reasoning 0134 used when it deliberately KEPT `authenticated` on the two
-- 0043 report views.
--
-- Deliberately NOT revoking. Every reader of these views in src/ goes through
-- createAdminClient() (service_role), so a revoke would be safe — but it would
-- be a schema change with no security gain, and the app-facing reason to keep
-- the grant is the same as 0134's: if a route ever needs to read one as the
-- signed-in admin through the RLS client, the door has to be open for the lock
-- to be the thing that decides.
--
-- CONTRAST — 0135. The four v_hmo_* views had the same default grants but were
-- SECURITY DEFINER, so RLS never ran and anon really did read 2,031 rows of
-- patient names. Grant open AND lock absent. That is the combination that
-- matters; a default grant on its own is not a finding.

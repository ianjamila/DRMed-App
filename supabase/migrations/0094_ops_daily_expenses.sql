-- 0094_ops_daily_expenses.sql
-- Part B / B1.1 follow-up — a per-day GL expenses total for the Operational
-- daily report's rough "Net" line. Mirrors the Income Statement P&L exactly:
-- posted journal entries, expense-type accounts, expense = sum(debit - credit),
-- grouped by posting_date (a plain DATE — no Manila cast needed). Read-only,
-- security_invoker = on; read in practice only by the service-role admin client.
-- (Corrected 2026-09-10: this line used to claim "NO grant to anon/authenticated",
-- which was never true — Supabase's `alter default privileges` grants every new
-- view to both roles, and prod confirms it still does. What actually protects
-- this view is `security_invoker = on`: it runs with the CALLER's rights, so
-- base-table RLS applies and anon/medtech both read 0 rows. The grant is the
-- door, RLS is the lock — see the note at the foot of this file.)
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

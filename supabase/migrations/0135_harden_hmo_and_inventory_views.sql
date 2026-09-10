-- 0135_harden_hmo_and_inventory_views.sql
-- Closes a live disclosure: the four HMO claim views were readable by `anon`.
--
-- 0134 hardened the two 0043 report views on the premise that they "were the
-- last public views still running as their owner". That premise was WRONG. The
-- 12.3 HMO views (0034, last redefined in 0079-0082) and v_inventory_balances
-- (0073) were never given `security_invoker`, so they ran with the DEFINER's
-- rights — RLS on their base tables never executed — while still carrying the
-- default anon/authenticated SELECT that Supabase's `alter default privileges`
-- hands every new table and view. Grant open, lock absent.
--
-- MEASURED ON PROD BEFORE THIS MIGRATION (set local role anon)
--   v_hmo_unbilled ......... 2,031 rows   <- 292 distinct patients by NAME,
--                                            each with the service they had,
--                                            their HMO, and ₱2,110,365.40
--   v_hmo_ar_aging .........    25 rows
--   v_hmo_stuck ............    15 rows
--   v_hmo_provider_summary .    11 rows
--   v_inventory_balances ...     0 rows   <- only because the table is empty;
--                                            same defect, not yet realised
-- `anon` is the role behind the publishable key that ships in every browser, so
-- this was patient health information (which named person had which lab test)
-- readable without authenticating. RA 10173.
--
-- WHAT CHANGES
--   1. security_invoker = on  -> the views run with the CALLER's rights, so the
--      base-table RLS policies finally apply through them.
--   2. revoke all from anon AND authenticated. This goes further than 0134,
--      which kept `authenticated` because /api/admin/reports/{daily-revenue,
--      staff-advances}.csv read those views through the RLS-scoped client.
--      These five have no such reader: every reference in src/ goes through
--      createAdminClient() (service_role) — the hmo-claims pages and actions,
--      admin/operations/hmo, the admin dashboard, and both inventory pages.
--      The *-client.tsx files name the views only in a generated Database type.
--      If a future route ever needs to read one as the signed-in admin, restore
--      the `authenticated` grant and let RLS be the lock — do not re-grant anon.
--
-- WHY THE APP IS UNAFFECTED
--   service_role has rolbypassrls = true (verified on prod), so RLS does not
--   apply to it whether the view is definer or invoker. Every reader listed
--   above is service_role, so every page and CSV returns exactly what it
--   returned before.
--
-- ALL FOUR HMO VIEWS MUST FLIP TOGETHER
--   v_hmo_provider_summary selects FROM v_hmo_unbilled and v_hmo_stuck. A
--   definer view nested inside an invoker view still runs as its own owner, so
--   hardening the outer one alone would leave the inner legs bypassing RLS.
--
-- No view body is restated: `alter view ... set` changes only the option, so the
-- definitions in 0082 (unbilled, stuck, ar_aging), 0078 (provider_summary) and
-- 0073 (inventory) stay the one source of truth for what these views select.
--
-- ⚠ READ THIS BEFORE REDEFINING ANY OF THESE FIVE VIEWS
--   `create or replace view`'s WITH clause REPLACES the view's options — it
--   does not merge with what is already set. Omit the clause and
--   `security_invoker` silently reverts to off: the view goes back to running
--   with its OWNER's rights, base-table RLS stops applying, nothing errors and
--   no test fails. The revoke above still stands, so the view is not instantly
--   world-readable again — but the second half of this fix is gone, and the
--   note at line 34 ("restore the `authenticated` grant and let RLS be the
--   lock") would then be advice that quietly does not hold.
--   This is not hypothetical: these four HMO views were recreated by ordinary
--   feature work three times (0078, 0079, 0080/0081/0082). Any one of those,
--   written after today, would have reopened it.
--   EVERY later `create or replace view` of these five MUST restate
--   `with (security_invoker = on)`. src/lib/supabase/hardened-views.test.ts
--   fails the build if one doesn't.

alter view public.v_hmo_unbilled         set (security_invoker = on);
alter view public.v_hmo_stuck            set (security_invoker = on);
alter view public.v_hmo_ar_aging         set (security_invoker = on);
alter view public.v_hmo_provider_summary set (security_invoker = on);
alter view public.v_inventory_balances   set (security_invoker = on);

revoke all on public.v_hmo_unbilled         from anon, authenticated;
revoke all on public.v_hmo_stuck            from anon, authenticated;
revoke all on public.v_hmo_ar_aging         from anon, authenticated;
revoke all on public.v_hmo_provider_summary from anon, authenticated;
revoke all on public.v_inventory_balances   from anon, authenticated;

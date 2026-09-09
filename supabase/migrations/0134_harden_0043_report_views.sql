-- 0134_harden_0043_report_views.sql
-- Flow-review PR 5 (a). Hardens the two read-only admin-report views created in
-- 0043, which were the last public views still running as their owner.
--
-- Both were created owner-postgres with NO view options, so they executed with
-- the *definer's* rights: RLS on their base tables was bypassed entirely and any
-- caller holding the default `anon`/`authenticated` SELECT grant read the whole
-- clinic's numbers. Every view added since (0093-0097 v_ops_daily_*) is
-- `security_invoker = on`; these two were simply never brought forward.
--
-- WHAT CHANGES
--   1. security_invoker = on  -> the view now runs with the CALLER's rights, so
--      the base-table RLS policies apply through it.
--   2. revoke all from anon   -> anon has no legitimate read here. (`authenticated`
--      deliberately KEEPS its grant: that is the standard Supabase model — the
--      grant is the door, RLS is the lock — and both CSV route handlers,
--      /api/admin/reports/{daily-revenue,staff-advances}.csv, read these views
--      through the RLS-scoped client, i.e. as role `authenticated` carrying the
--      admin's JWT. Revoking it would break both exports with "permission denied
--      for view".)
--
-- NET EFFECT (base-table policies, unchanged by this migration)
--   v_daily_revenue_by_service  (test_requests join services)
--     anon / patient session .......... 0 rows  (was: full clinic revenue)
--     reception/medtech/pathologist/xray/admin  unchanged — `test_requests:
--       staff select` + `services: staff read` already allow the base rows
--   v_staff_advances_outstanding  (staff_advances join staff_profiles)
--     anon / patient session .......... 0 rows  (was: every staff advance)
--     medtech / pathologist / xray .... 0 rows  (was: every staff advance) <- the
--       real tightening; `staff_advances` is reception+admin only
--     reception / admin ............... unchanged
--
-- No view body is restated: `alter view ... set` changes only the option, so the
-- 0043 definitions at 0043_eod_cash_reconciliation.sql:770 and :787 stay the one
-- source of truth for what these views select.

alter view public.v_daily_revenue_by_service   set (security_invoker = on);
alter view public.v_staff_advances_outstanding set (security_invoker = on);

revoke all on public.v_daily_revenue_by_service   from anon;
revoke all on public.v_staff_advances_outstanding from anon;

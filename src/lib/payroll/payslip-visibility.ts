/**
 * When is a payslip visible to the STAFF member it belongs to?
 *
 * Owner decision (2026-09-15): "finalised or paid." That phrase resolves to
 * a single Postgres filter, which is worth spelling out because it looks
 * wrong at first glance — the natural instinct is to look for a `'paid'`
 * run status and come up empty.
 *
 * - `payroll_runs.status` is `text` with
 *   `check (status in ('draft','computed','finalised','voided'))`
 *   (supabase/migrations/0044_payroll.sql). There is **no** `'paid'` run
 *   status.
 * - "Paid" instead lives on a different table/column entirely:
 *   `payroll_employee_runs.payout_status`, `check (payout_status in
 *   ('pending','paid','voided'))` — the per-employee payout row, not the run.
 * - A DB guard trigger (same migration) freezes `payroll_runs.status` at
 *   `'finalised'` the moment any employee on the run is marked paid, and the
 *   app only exposes "Mark paid" once a run is finalised. So
 *   `payout_status = 'paid'` always implies `payroll_runs.status =
 *   'finalised'` — it can never coexist with `'draft'`, `'computed'`, or
 *   `'voided'`.
 * - Therefore "finalised or paid" collapses to exactly one run-status
 *   filter: `status = 'finalised'`. `draft` and `computed` are hidden
 *   because the numbers aren't real yet (a freshly-created run's
 *   `payroll_employee_runs` rows start at all zeros before anything is
 *   computed); `voided` is hidden because it has been withdrawn.
 *
 * `payroll_runs.status` is a plain `text` column with a CHECK, not a
 * Postgres enum, so the generated type (`src/types/database.ts`) is just
 * `status: string` — TypeScript gives no protection on these literals. Get
 * them right by hand, and route every payslip-visibility decision through
 * this module (list, YTD totals, signed-URL download, the detail page) so
 * the four call sites can't drift from each other or from this reasoning.
 */

export const PAYSLIP_VISIBLE_RUN_STATUSES = ["finalised"] as const;

export type PayslipVisibleRunStatus =
  (typeof PAYSLIP_VISIBLE_RUN_STATUSES)[number];

/**
 * True when a payroll run's status means its payslips may be shown/
 * downloaded by the staff member they belong to. Fails closed: an
 * unrecognised or empty status (including `draft`, `computed`, `voided`) is
 * treated as NOT visible.
 */
export function payslipVisibleToStaff(runStatus: string): boolean {
  return (PAYSLIP_VISIBLE_RUN_STATUSES as readonly string[]).includes(
    runStatus,
  );
}

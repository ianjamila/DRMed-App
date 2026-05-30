import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { SettingsClient, type SettingRow } from "./settings-client";

export const metadata = { title: "Payroll settings — payroll admin" };
export const dynamic = "force-dynamic";

// Payroll-relevant keys, in seed order. accounting_settings can hold non-
// payroll keys (e.g. default_change_fund_php for cash reconciliation), so we
// allow-list the keys this editor exposes. If migration 0044 adds new payroll
// keys later, extending this list is the only edit required.
const PAYROLL_KEYS: ReadonlyArray<string> = [
  // Tardiness
  "tardiness_per_minute_php",
  "tardiness_threshold_for_halfday_deduction",
  "perfect_attendance_bonus_php",
  // Schedule defaults
  "standard_workday_minutes",
  "scheduled_start_hour",
  "scheduled_start_minute",
  "scheduled_end_hour",
  "scheduled_end_minute",
  "lunch_break_minutes",
  // Night differential
  "night_diff_premium_rate",
  "night_diff_start_hour",
  "night_diff_end_hour",
  // Overtime
  "ot_rate_regular_day",
  "ot_rate_rest_day",
  // Holiday pay
  "holiday_pay_regular_worked",
  "holiday_pay_regular_unworked",
  "holiday_pay_special_worked",
  "holiday_pay_special_unworked",
  // Staff advance cap
  "staff_advance_settlement_max_pct",
];

export default async function PayrollSettingsPage() {
  await requireAdminStaff();

  // Service-role client: page is gated by requireAdminStaff() above, and the
  // accounting_settings table is fully admin-facing.
  const admin = createAdminClient();

  let dbError: string | null = null;
  const { data, error } = await admin
    .from("accounting_settings")
    .select("id, key, value_php, value_text, value_jsonb, description")
    .in("key", PAYROLL_KEYS as string[])
    .order("key", { ascending: true });
  if (error) {
    console.error("[payroll/settings] query failed:", error);
    dbError = "Failed to load payroll settings.";
  }

  // Reshape into a typed list, preserving the seed order from PAYROLL_KEYS
  // (alphabetical via `.order` above keeps it deterministic; we then group
  // by category client-side using key prefix).
  const byKey = new Map<string, SettingRow>();
  for (const row of data ?? []) {
    // We only render payroll-numeric settings — all of these are stored in
    // value_php per migration 0044. value_text / value_jsonb stay reserved
    // for future non-numeric settings and are not exposed here.
    byKey.set(row.key, {
      id: row.id,
      key: row.key,
      value_php: row.value_php === null ? null : Number(row.value_php),
      description: row.description,
    });
  }

  // Emit the row list in the curated PAYROLL_KEYS order, skipping any keys
  // the DB hasn't seeded yet (defensive — the seed inserts on conflict do
  // nothing, so absence is possible during partial migrations).
  const rows: SettingRow[] = PAYROLL_KEYS.map((k) => byKey.get(k)).filter(
    (r): r is SettingRow => Boolean(r),
  );

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Payroll settings
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Tunable parameters used by the payroll compute engine. Changes apply
          to the next recompute; existing finalised runs are not retroactively
          affected.
        </p>
      </header>

      <SettingsClient rows={rows} error={dbError} />
    </div>
  );
}

import { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { buildPeriodPresets } from "@/lib/reports/period-presets";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { buildSpendMatrix, enumerateMonths, type SpendByLabRow } from "@/lib/reports/send-out-labs";

/**
 * Send-out Labs export: the spend-by-lab matrix (months × labs + Total) shown
 * on the page — one `send_out_spend_by_lab` call under the RLS-scoped client
 * (SECURITY INVOKER; admin-only journal RLS applies), mirrored into a CSV via
 * `reportCsvResponse` (escaping, the in-band truncation notice, and the
 * `report.send_out_spend_by_lab.exported` audit row).
 */
export async function GET(request: NextRequest) {
  const staff = await requireAdminStaff();

  const sp = request.nextUrl.searchParams;
  const todayISO = todayManilaISODate();
  const defaultPreset = buildPeriodPresets(todayISO).find((p) => p.key === "12m")!;
  const startParam = sp.get("start");
  const endParam = sp.get("end");
  const start = isISODate(startParam) ? startParam : defaultPreset.start;
  const endRaw = isISODate(endParam) ? endParam : defaultPreset.end;
  const end = endRaw < start ? start : endRaw;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("send_out_spend_by_lab", { p_start: start, p_end: end });
  if (error) throw new Error(error.message);

  const rows: SpendByLabRow[] = data ?? [];
  const months = enumerateMonths(start, end);
  const matrix = buildSpendMatrix(rows, months);

  const header = ["Month", ...matrix.columns.map((c) => c.label), "Total"];
  const body: unknown[][] = matrix.rows.map((row) => [
    row.month,
    ...matrix.columns.map((c) => row.byLab[c.key] ?? 0),
    row.totalPhp,
  ]);
  body.push([
    "Total",
    ...matrix.columns.map((c) => matrix.totals.byLab[c.key] ?? 0),
    matrix.totals.totalPhp,
  ]);

  return reportCsvResponse({
    staff,
    report: "send_out_spend_by_lab",
    filename: `send-out-labs-spend-${start}_${end}.csv`,
    rows: [header, ...body],
    truncated: false,
    filters: { start, end },
  });
}

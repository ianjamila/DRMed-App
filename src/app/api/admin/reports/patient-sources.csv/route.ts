import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { PATIENT_SOURCES_MIN_DATE, resolvePeriod } from "@/lib/marketing/period";
import { parseGrain, parseMode, seriesCsvRows } from "@/lib/marketing/patient-sources";
import { loadPatientSourcesSeries, loadPatientSourcesSummary } from "@/lib/marketing/patient-sources.server";

// Admin-only, RLS-scoped client, row ceiling, audit row (report-CSV pattern;
// plan P12). Counts only — no names.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const sp = req.nextUrl.searchParams;
  const todayISO = todayManilaISODate();
  const period = resolvePeriod({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }, todayISO, { min: PATIENT_SOURCES_MIN_DATE });
  // An unusable period is a 400, never a silent export of this month.
  if (period.problem) return new Response(period.problem, { status: 400 });
  const mode = parseMode(sp.get("mode") ?? undefined);
  const grain = parseGrain(sp.get("grain") ?? undefined);
  const supabase = await createClient();
  const [summary, series] = await Promise.all([
    loadPatientSourcesSummary(supabase, period.from, period.to),
    loadPatientSourcesSeries(supabase, period.from, period.to, grain, mode),
  ]);
  if (!summary.ok) return new Response(summary.message, { status: summary.kind === "forbidden" ? 403 : 500 });
  if (!series.ok) return new Response(series.message, { status: series.kind === "forbidden" ? 403 : 500 });
  return reportCsvResponse({
    staff,
    report: "patient_sources",
    filename: `patient-sources-${period.from}-to-${period.to}-${mode}-${grain}.csv`,
    rows: seriesCsvRows({ from: period.from, to: period.to, mode, grain }, summary.data, series.data.rows),
    truncated: series.data.truncated,
    filters: { from: period.from, to: period.to, mode, grain },
  });
}

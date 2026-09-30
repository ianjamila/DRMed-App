import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { priorYearRange } from "@/lib/reports/period-presets";
import { summariseClasses, type VisitView } from "@/lib/visits/classification";
import { trendMonths, type RevenueTrendPoint } from "@/lib/visits/revenue-presets";

type Classes = { lab: number; consult: number; procedure: number };

/**
 * The 12-month revenue-by-classification trend, each month paired with the
 * same dates one year earlier — shared by the dropdown's chart
 * (/api/admin/revenue-trend) and its CSV. 24 calls of the SECURITY INVOKER
 * summary RPC through the caller's RLS client, all in parallel; each is one
 * month over an indexed visit_date range.
 */
export async function loadRevenueTrend(
  supabase: SupabaseClient<Database>,
  todayISO: string,
  view: VisitView,
): Promise<{ ok: true; points: RevenueTrendPoint[] } | { ok: false; error: unknown }> {
  const months = trendMonths(todayISO);
  const summary = (start: string, end: string) =>
    supabase.rpc("visits_classification_summary", { p_start: start, p_end: end, p_deleted: view });
  const [current, prior] = await Promise.all([
    Promise.all(months.map((m) => summary(m.start, m.end))),
    Promise.all(
      months.map((m) => {
        const r = priorYearRange(m.start, m.end);
        return summary(r.start, r.end);
      }),
    ),
  ]);

  const failed = [...current, ...prior].find((r) => r.error);
  if (failed?.error) return { ok: false, error: failed.error };

  const byClass = (data: Parameters<typeof summariseClasses>[0]): Classes => {
    const m = new Map(summariseClasses(data).map((r) => [r.class, r.revenuePhp]));
    return { lab: m.get("lab") ?? 0, consult: m.get("consult") ?? 0, procedure: m.get("procedure") ?? 0 };
  };

  return {
    ok: true,
    points: months.map((m, i) => ({
      key: m.key,
      label: m.label,
      year: m.year,
      partial: m.partial,
      start: m.start,
      end: m.end,
      ...byClass(current[i].data),
      prior: byClass(prior[i].data),
    })),
  };
}

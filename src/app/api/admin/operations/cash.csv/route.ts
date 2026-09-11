import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { enumerateDays } from "@/lib/operations/daily-report";
import {
  buildCollectionsMatrix,
  buildCashReconRows,
  type CollectionRow,
  type HmoReceivedRow,
  type EodCloseRow,
} from "@/lib/operations/cash-report";
import { CASH_DENOMINATIONS } from "@/lib/accounting/cash-denominations";
import { buildDenominationTrend } from "@/lib/accounting/denomination-trends";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";

// N15: see operations/daily.csv for why the service-role client stays for the
// two `v_ops_daily_*` reads (security_invoker views with no staff-readable
// RLS path) while `eod_close_records` — a real table carrying its own
// "staff read" policy — would work under the RLS client too; both are read
// through `admin` here to keep the route to one client, since the dominant
// data (collections) requires it regardless. Admin gate, chunked paging and
// the audit row (via `reportCsvResponse`) are the actual fix.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();

  const sp = req.nextUrl.searchParams;
  const today = todayManilaISODate();
  const from = sp.get("from") ?? today.slice(0, 7) + "-01";
  const to = sp.get("to") ?? today;

  const admin = createAdminClient();
  const [collectionsResult, hmoResult, eodResult] = await Promise.all([
    fetchAllRows<CollectionRow>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_collections")
          .select("*")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date", { ascending: true })
          .order("section", { ascending: true })
          .order("method", { ascending: true })
          .range(rFrom, rTo)
          .returns<CollectionRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<HmoReceivedRow>(
      (rFrom, rTo) =>
        admin
          .from("v_ops_daily_hmo_received")
          .select("*")
          .gte("received_date", from)
          .lte("received_date", to)
          .order("received_date", { ascending: true })
          .order("source", { ascending: true })
          .range(rFrom, rTo)
          .returns<HmoReceivedRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
    // Same query the on-screen panel runs — the sheet gained a cash
    // reconciliation section in PR N, so the route now needs the closes too.
    fetchAllRows<EodCloseRow>(
      (rFrom, rTo) =>
        admin
          .from("eod_close_records")
          .select("business_date,expected_cash_php,counted_cash_php,variance_php,counted_denominations")
          .eq("status", "closed")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date", { ascending: true })
          .range(rFrom, rTo)
          .returns<EodCloseRow[]>(),
      REPORT_EXPORT_MAX_ROWS,
    ),
  ]);

  const days = enumerateDays(from, to);
  const matrix = buildCollectionsMatrix(collectionsResult.rows, days, hmoResult.rows);

  const header = ["Section", "Row", ...days, "Total"];
  const body: unknown[][] = [];

  for (const sec of matrix.sections) {
    for (const row of sec.rows) {
      const rowTotal = days.reduce((s, d) => s + (row.values[d] ?? 0), 0);
      body.push([sec.title, row.label, ...days.map((d) => row.values[d] ?? 0), rowTotal]);
    }
  }

  const hmoTotal = days.reduce((s, d) => s + (matrix.hmoReceived.values[d] ?? 0), 0);
  body.push(["HMO", matrix.hmoReceived.label, ...days.map((d) => matrix.hmoReceived.values[d] ?? 0), hmoTotal]);

  const grandTotal = days.reduce((s, d) => s + (matrix.total.values[d] ?? 0), 0);
  body.push(["TOTAL", matrix.total.label, ...days.map((d) => matrix.total.values[d] ?? 0), grandTotal]);

  // ---- Cash reconciliation section ----------------------------------------
  const reconRows = buildCashReconRows(eodResult.rows, days);
  const byDay = new Map(reconRows.map((r) => [r.day, r]));
  const reconLine = (label: string, pick: (day: string) => number) => {
    const values = days.map(pick);
    body.push(["Cash reconciliation", label, ...values, values.reduce((s, v) => s + v, 0)]);
  };

  reconLine("Expected in till", (d) => byDay.get(d)?.expected ?? 0);
  reconLine("Counted in till", (d) => byDay.get(d)?.counted ?? 0);
  reconLine("Variance (over / short)", (d) => byDay.get(d)?.variance ?? 0);
  for (const denom of CASH_DENOMINATIONS) {
    reconLine(`${denom.full_label} (pieces)`, (d) => byDay.get(d)?.denominations?.[denom.key] ?? 0);
  }

  // ---- Cash count trends ---------------------------------------------------
  const trend = buildDenominationTrend(
    reconRows
      .filter((r) => r.reconciled)
      .map((r) => ({ day: r.day, variance: r.variance, denominations: r.denominations })),
  );

  const trendStat = (label: string, value: number) => {
    body.push(["Cash count trends", label, ...days.map(() => ""), value]);
  };
  trendStat("Days closed", trend.closedDays);
  trendStat("Days with a denomination count", trend.countedDays);
  trendStat("Days counted exactly", trend.balancedDays);
  trendStat("Days short", trend.shortDays);
  trendStat("Days over", trend.overDays);
  trendStat("Net difference (pesos)", trend.netVariancePhp);

  const attributionByDay = new Map(trend.offDays.map((o) => [o.day, o]));
  const attrLine = (label: string, pick: (day: string) => number | string) => {
    body.push(["Difference explanation", label, ...days.map(pick), ""]);
  };
  attrLine("Fits a note / coin of (pesos)", (d) => attributionByDay.get(d)?.valuePhp ?? "");
  attrLine("…this many pieces", (d) => {
    const a = attributionByDay.get(d);
    return a?.valuePhp == null ? "" : a.pieces;
  });

  for (const b of trend.buckets) {
    body.push(["Difference explanation", `${b.label} — days`, ...days.map(() => ""), b.days]);
    body.push(["Difference explanation", `${b.label} — net pesos`, ...days.map(() => ""), b.netPhp]);
  }

  return reportCsvResponse({
    staff,
    report: "ops_cash",
    filename: `cash-collected-${from}_${to}.csv`,
    rows: [header, ...body],
    truncated: collectionsResult.truncated || hmoResult.truncated || eodResult.truncated,
    filters: { from, to },
  });
}

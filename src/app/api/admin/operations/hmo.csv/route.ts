import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { groupDaysByMonth } from "@/lib/operations/daily-report";
import {
  buildHmoArMatrix,
  type HmoArRow,
  type HmoArProviderRow,
} from "@/lib/operations/hmo-ar-report";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";

// N15: see operations/daily.csv for why the service-role client stays for
// this `security_invoker` view. Admin gate, chunked paging and the audit row
// are the actual fix.
//
// No `from` filter on the underlying query — deliberately, matching the
// original: the running AR balance needs every movement through `to`, not
// just the ones inside the display window (`from` only trims which columns
// render). The order key (business_date, provider_name, source, billed_in,
// paid_out) is the closest thing to a total order the view offers — it has
// no id column, and the live-IN/live-OUT branches can legitimately share a
// (date, provider, source) tuple on a day with both movements — but the two
// branches always differ on which of billed_in/paid_out is nonzero, so this
// resolves the realistic case; an exact duplicate row is vanishingly
// unlikely and would double-count into the total regardless of chunk
// boundary, not silently drop.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const today = todayManilaISODate();
  const from = req.nextUrl.searchParams.get("from") ?? `${today.slice(0, 4)}-01-01`;
  const to = req.nextUrl.searchParams.get("to") ?? today;

  const admin = createAdminClient();
  const { rows, truncated } = await fetchAllRows<HmoArRow>(
    (rFrom, rTo) =>
      admin
        .from("v_ops_daily_hmo_provider_ar")
        .select("*")
        .lte("business_date", to)
        .order("business_date", { ascending: true })
        .order("provider_name", { ascending: true })
        .order("source", { ascending: true })
        .order("billed_in_php", { ascending: true })
        .order("paid_out_php", { ascending: true })
        .range(rFrom, rTo)
        .returns<HmoArRow[]>(),
    REPORT_EXPORT_MAX_ROWS,
  );

  const matrix = buildHmoArMatrix(rows, { from, to });
  const months = groupDaysByMonth(matrix.days);
  const monthEnding = (row: HmoArProviderRow, dates: string[]) =>
    dates.length ? row.byDay[dates[dates.length - 1]].ending : row.endingBalance;
  const monthSum = (row: HmoArProviderRow, dates: string[], key: "billedIn" | "paidOut") =>
    dates.reduce((s, d) => s + row.byDay[d][key], 0);

  const header = ["Section", "Provider", ...months.map((m) => m.label), "Balance"];
  const body: unknown[][] = [];

  const block = (
    title: string,
    pick: (row: HmoArProviderRow, dates: string[]) => number,
    useEnding: boolean,
  ) => {
    for (const p of matrix.providers) {
      body.push([title, p.provider, ...months.map((m) => pick(p, m.dates)), useEnding ? p.endingBalance : ""]);
    }
  };

  block("IN (billed)", (p, d) => monthSum(p, d, "billedIn"), false);
  body.push(["TOTAL IN", "", ...months.map((m) => monthSum(matrix.total, m.dates, "billedIn")), ""]);
  block("OUT (paid)", (p, d) => monthSum(p, d, "paidOut"), false);
  body.push(["TOTAL OUT", "", ...months.map((m) => monthSum(matrix.total, m.dates, "paidOut")), ""]);
  block("ENDING BALANCE", (p, d) => monthEnding(p, d), true);
  body.push([
    "HMO RECEIVABLES BALANCE",
    "",
    ...months.map((m) => monthEnding(matrix.total, m.dates)),
    matrix.total.endingBalance,
  ]);

  return reportCsvResponse({
    staff,
    report: "ops_hmo_ar",
    filename: `hmo-receivables-${from}-to-${to}.csv`,
    rows: [header, ...body],
    truncated,
    filters: { from, to },
  });
}

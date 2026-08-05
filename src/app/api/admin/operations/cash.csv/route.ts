import { NextRequest, NextResponse } from "next/server";
import { escapeCell } from "@/lib/csv/escape";
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

export async function GET(req: NextRequest) {
  await requireAdminStaff();

  const sp = req.nextUrl.searchParams;
  const today = todayManilaISODate();
  const from = sp.get("from") ?? today.slice(0, 7) + "-01";
  const to = sp.get("to") ?? today;

  const admin = createAdminClient();
  const [collectionsRes, hmoRes, eodRes] = await Promise.all([
    admin
      .from("v_ops_daily_collections")
      .select("*")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_hmo_received")
      .select("*")
      .gte("received_date", from)
      .lte("received_date", to),
    // Same query the on-screen panel runs — the sheet gained a cash
    // reconciliation section in PR N, so the route now needs the closes too.
    admin
      .from("eod_close_records")
      .select("business_date,expected_cash_php,counted_cash_php,variance_php,counted_denominations")
      .eq("status", "closed")
      .gte("business_date", from)
      .lte("business_date", to),
  ]);

  if (collectionsRes.error || hmoRes.error || eodRes.error) {
    return new NextResponse("Failed to build cash report", { status: 500 });
  }

  const days = enumerateDays(from, to);
  const matrix = buildCollectionsMatrix(
    (collectionsRes.data ?? []) as CollectionRow[],
    days,
    (hmoRes.data ?? []) as HmoReceivedRow[],
  );

  // Header: Section, Row, <day1>, <day2>, ..., Total
  const header = ["Section", "Row", ...days, "Total"];
  const lines: string[] = [header.map(escapeCell).join(",")];

  // Section rows: method rows + section_total
  for (const sec of matrix.sections) {
    for (const row of sec.rows) {
      const rowTotal = days.reduce((s, d) => s + (row.values[d] ?? 0), 0);
      lines.push(
        [sec.title, row.label, ...days.map((d) => row.values[d] ?? 0), rowTotal]
          .map(escapeCell)
          .join(","),
      );
    }
  }

  // HMO received row
  const hmoTotal = days.reduce((s, d) => s + (matrix.hmoReceived.values[d] ?? 0), 0);
  lines.push(
    ["HMO", matrix.hmoReceived.label, ...days.map((d) => matrix.hmoReceived.values[d] ?? 0), hmoTotal]
      .map(escapeCell)
      .join(","),
  );

  // Grand total row
  const grandTotal = days.reduce((s, d) => s + (matrix.total.values[d] ?? 0), 0);
  lines.push(
    ["TOTAL", matrix.total.label, ...days.map((d) => matrix.total.values[d] ?? 0), grandTotal]
      .map(escapeCell)
      .join(","),
  );

  // ---- Cash reconciliation section ----------------------------------------
  // Expected / Counted / Variance are pesos like the rest of the sheet; the
  // denomination rows are PIECE COUNTS, which is why each of those labels says
  // "(pieces)" — otherwise "₱1,000 bills … 3" reads as ₱3 in a peso column.
  const reconRows = buildCashReconRows((eodRes.data ?? []) as EodCloseRow[], days);
  const byDay = new Map(reconRows.map((r) => [r.day, r]));
  const reconLine = (label: string, pick: (day: string) => number) => {
    const values = days.map(pick);
    lines.push(
      ["Cash reconciliation", label, ...values, values.reduce((s, v) => s + v, 0)]
        .map(escapeCell)
        .join(","),
    );
  };

  reconLine("Expected in till", (d) => byDay.get(d)?.expected ?? 0);
  reconLine("Counted in till", (d) => byDay.get(d)?.counted ?? 0);
  reconLine("Variance (over / short)", (d) => byDay.get(d)?.variance ?? 0);
  for (const denom of CASH_DENOMINATIONS) {
    reconLine(
      `${denom.full_label} (pieces)`,
      (d) => byDay.get(d)?.denominations?.[denom.key] ?? 0,
    );
  }

  // ---- Cash count trends ---------------------------------------------------
  // Only the parts that are NOT already derivable from the rows above. The
  // panel's "what the till usually holds" table is deliberately omitted: days
  // counted, totals and averages all fall straight out of summing the
  // per-denomination piece rows already in this sheet, so exporting them again
  // would add bulk and no information.
  //
  // What ISN'T derivable is the variance attribution — it needs the
  // divisibility logic in `denomination-trends.ts` — so that is what ships.
  const trend = buildDenominationTrend(
    reconRows
      .filter((r) => r.reconciled)
      .map((r) => ({ day: r.day, variance: r.variance, denominations: r.denominations })),
  );

  // Range-wide figures: no per-day value to give, so the day cells stay empty
  // and the figure sits under Total. Labels carry their unit.
  const trendStat = (label: string, value: number) => {
    lines.push(
      ["Cash count trends", label, ...days.map(() => ""), value].map(escapeCell).join(","),
    );
  };
  trendStat("Days closed", trend.closedDays);
  trendStat("Days with a denomination count", trend.countedDays);
  trendStat("Days counted exactly", trend.balancedDays);
  trendStat("Days short", trend.shortDays);
  trendStat("Days over", trend.overDays);
  trendStat("Net difference (pesos)", trend.netVariancePhp);

  // Per-day attribution. This one DOES fit the day columns: for each off day,
  // the biggest note or coin whose value divides the difference exactly, and
  // how many of them it works out to. Arithmetic, not a claim about which pile
  // was actually miscounted — see denomination-trends.ts.
  const attributionByDay = new Map(trend.offDays.map((o) => [o.day, o]));
  const attrLine = (label: string, pick: (day: string) => number | string) => {
    lines.push(
      ["Difference explanation", label, ...days.map(pick), ""].map(escapeCell).join(","),
    );
  };
  // Both cells key off valuePhp, not off `pieces`. A day no pile explains has
  // pieces === 0, and `?? ""` would let that 0 through — printing "0 pieces"
  // beside a blank denomination, which reads as a real answer instead of "no
  // whole-pile explanation". Blank both, or fill both.
  attrLine("Fits a note / coin of (pesos)", (d) => attributionByDay.get(d)?.valuePhp ?? "");
  attrLine("…this many pieces", (d) => {
    const a = attributionByDay.get(d);
    return a?.valuePhp == null ? "" : a.pieces;
  });

  // And the same attribution rolled up over the range — the "we are short a
  // ₱1,000 note more often than not" signal.
  for (const b of trend.buckets) {
    lines.push(
      [
        "Difference explanation",
        `${b.label} — days`,
        ...days.map(() => ""),
        b.days,
      ]
        .map(escapeCell)
        .join(","),
    );
    lines.push(
      [
        "Difference explanation",
        `${b.label} — net pesos`,
        ...days.map(() => ""),
        b.netPhp,
      ]
        .map(escapeCell)
        .join(","),
    );
  }

  const filename = `cash-collected-${from}_${to}.csv`;
  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

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

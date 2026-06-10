import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { groupDaysByMonth } from "@/lib/operations/daily-report";
import {
  buildHmoArMatrix,
  type HmoArRow,
  type HmoArProviderRow,
} from "@/lib/operations/hmo-ar-report";

const csvCell = (s: string | number) => {
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export async function GET(req: NextRequest) {
  await requireAdminStaff();
  const today = todayManilaISODate();
  const from = req.nextUrl.searchParams.get("from") ?? `${today.slice(0, 4)}-01-01`;
  const to = req.nextUrl.searchParams.get("to") ?? today;

  const admin = createAdminClient();
  const { data } = await admin
    .from("v_ops_daily_hmo_provider_ar")
    .select("*")
    .lte("business_date", to);

  const matrix = buildHmoArMatrix((data ?? []) as HmoArRow[], { from, to });
  const months = groupDaysByMonth(matrix.days);
  const monthEnding = (row: HmoArProviderRow, dates: string[]) =>
    dates.length ? row.byDay[dates[dates.length - 1]].ending : row.endingBalance;
  const monthSum = (row: HmoArProviderRow, dates: string[], key: "billedIn" | "paidOut") =>
    dates.reduce((s, d) => s + row.byDay[d][key], 0);

  const header = ["Section", "Provider", ...months.map((m) => m.label), "Balance"];
  const lines: string[] = [header.map(csvCell).join(",")];

  const block = (title: string, pick: (row: HmoArProviderRow, dates: string[]) => number, useEnding: boolean) => {
    for (const p of matrix.providers) {
      lines.push(
        [title, p.provider, ...months.map((m) => pick(p, m.dates)), useEnding ? p.endingBalance : ""]
          .map(csvCell)
          .join(","),
      );
    }
  };

  block("IN (billed)", (p, d) => monthSum(p, d, "billedIn"), false);
  lines.push(
    ["TOTAL IN", "", ...months.map((m) => monthSum(matrix.total, m.dates, "billedIn")), ""]
      .map(csvCell)
      .join(","),
  );
  block("OUT (paid)", (p, d) => monthSum(p, d, "paidOut"), false);
  lines.push(
    ["TOTAL OUT", "", ...months.map((m) => monthSum(matrix.total, m.dates, "paidOut")), ""]
      .map(csvCell)
      .join(","),
  );
  block("ENDING BALANCE", (p, d) => monthEnding(p, d), true);
  lines.push(
    [
      "HMO RECEIVABLES BALANCE",
      "",
      ...months.map((m) => monthEnding(matrix.total, m.dates)),
      matrix.total.endingBalance,
    ]
      .map(csvCell)
      .join(","),
  );

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="hmo-receivables-${from}-to-${to}.csv"`,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  enumerateDays,
  buildDailyMatrix,
  type ChannelRow,
  type TotalsRow,
} from "@/lib/operations/daily-report";
import {
  buildCollectionsMatrix,
  type CollectionRow,
  type HmoReceivedRow,
} from "@/lib/operations/cash-report";
import {
  buildExpenseMatrix,
  buildNetIncome,
  buildCashFlow,
  type ExpenseAccountRow,
} from "@/lib/operations/expense-report";

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(req: NextRequest) {
  await requireAdminStaff();

  const sp = req.nextUrl.searchParams;
  const today = todayManilaISODate();
  const from = sp.get("from") ?? today.slice(0, 7) + "-01";
  const to = sp.get("to") ?? today;

  const admin = createAdminClient();
  const [expenseRes, totalsRes, collectionsRes, hmoRes] = await Promise.all([
    admin.from("v_ops_daily_expense_accounts").select("*").gte("business_date", from).lte("business_date", to),
    admin.from("v_ops_daily_totals").select("*").gte("business_date", from).lte("business_date", to),
    admin.from("v_ops_daily_collections").select("*").gte("business_date", from).lte("business_date", to),
    admin.from("v_ops_daily_hmo_received").select("*").gte("received_date", from).lte("received_date", to),
  ]);

  if (expenseRes.error || totalsRes.error || collectionsRes.error || hmoRes.error) {
    return new NextResponse("Failed to build expenses report", { status: 500 });
  }

  const days = enumerateDays(from, to);
  const matrix = buildExpenseMatrix((expenseRes.data ?? []) as ExpenseAccountRow[], days);
  const dailyMatrix = buildDailyMatrix([] as ChannelRow[], (totalsRes.data ?? []) as TotalsRow[], days);
  const netIncome = buildNetIncome(dailyMatrix.totals.net.byDay, matrix.total.byDay, days);
  const collectionsMatrix = buildCollectionsMatrix(
    (collectionsRes.data ?? []) as CollectionRow[],
    days,
    (hmoRes.data ?? []) as HmoReceivedRow[],
  );
  const cashFlow = buildCashFlow(collectionsMatrix.total.values, matrix.total.byDay, days);

  const header = ["Section", "Row", ...days, "Total"];
  const lines: string[] = [header.map(escapeCell).join(",")];
  const push = (section: string, label: string, byDay: Record<string, number>) => {
    const rowTotal = days.reduce((s, d) => s + (byDay[d] ?? 0), 0);
    lines.push([section, label, ...days.map((d) => byDay[d] ?? 0), rowTotal].map(escapeCell).join(","));
  };

  for (const cat of matrix.categories) {
    for (const line of cat.lines) push(cat.name, line.label, line.byDay);
    push(cat.name, cat.subtotal.label, cat.subtotal.byDay);
  }
  if (matrix.other) push("Other", matrix.other.label, matrix.other.byDay);
  push("TOTAL", matrix.total.label, matrix.total.byDay);

  push("P&L", "Gross profit (lab + consult)", netIncome.grossProfit);
  push("P&L", "Net income (operational)", netIncome.net);

  push("Cash flow", cashFlow.starting.label, cashFlow.starting.byDay);
  push("Cash flow", cashFlow.collected.label, cashFlow.collected.byDay);
  push("Cash flow", cashFlow.expenses.label, cashFlow.expenses.byDay);
  push("Cash flow", cashFlow.ending.label, cashFlow.ending.byDay);

  const filename = `expenses-pnl-${from}_${to}.csv`;
  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  buildDailyMatrix,
  enumerateDays,
  type ChannelRow,
  type TotalsRow,
} from "@/lib/operations/daily-report";

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
  const [channelRes, totalsRes] = await Promise.all([
    admin
      .from("v_ops_daily_channel")
      .select("business_date, section, channel, line_count, distinct_customers, sales_gross, discount, net")
      .gte("business_date", from)
      .lte("business_date", to),
    admin
      .from("v_ops_daily_totals")
      .select("business_date, section, line_count, distinct_customers, sales_gross, discount, net, pf_collected")
      .gte("business_date", from)
      .lte("business_date", to),
  ]);

  if (channelRes.error || totalsRes.error) {
    return new NextResponse("Failed to build report", { status: 500 });
  }

  const days = enumerateDays(from, to);
  const matrix = buildDailyMatrix(
    (channelRes.data ?? []) as ChannelRow[],
    (totalsRes.data ?? []) as TotalsRow[],
    days,
  );

  const header = ["Section", "Metric", ...days, "Total"];
  const lines: string[] = [header.map(escapeCell).join(",")];
  for (const sec of matrix.sections) {
    for (const row of sec.rows) {
      lines.push(
        [sec.title, row.label, ...days.map((d) => row.byDay[d] ?? 0), row.total]
          .map(escapeCell)
          .join(","),
      );
    }
  }
  for (const row of [matrix.totals.revenue, matrix.totals.discount, matrix.totals.net]) {
    lines.push(
      ["TOTAL", row.label, ...days.map((d) => row.byDay[d] ?? 0), row.total]
        .map(escapeCell)
        .join(","),
    );
  }

  const filename = `operations-daily-${from}-to-${to}.csv`;
  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { enumerateDays } from "@/lib/operations/daily-report";
import {
  buildCollectionsMatrix,
  type CollectionRow,
  type HmoReceivedRow,
} from "@/lib/operations/cash-report";

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
  const [collectionsRes, hmoRes] = await Promise.all([
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
  ]);

  if (collectionsRes.error || hmoRes.error) {
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

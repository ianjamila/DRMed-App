import { NextResponse } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS, chunk, unique, IN_CHUNK } from "@/lib/reports/paging";

// N15: brought up to the standard every other admin CSV in this app meets —
// requireAdminStaff (not a bare has_role RPC check), the RLS-scoped server
// client (gift_codes and staff_profiles both carry a "staff read" policy, so
// nothing here needs the service-role client), chunked .range() paging past
// PostgREST's 1000-row cap, and an audit row via reportCsvResponse (which
// also appends the in-band TRUNCATED marker). See /api/admin/visits.csv for
// the reasoning this mirrors.
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function manilaDate(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Manila" }).format(new Date(iso));
}

function manilaTime(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

interface SaleRow {
  id: string;
  code: string;
  face_value_php: number;
  status: string;
  purchased_at: string | null;
  purchased_by_name: string | null;
  purchased_by_contact: string | null;
  purchase_method: string | null;
  purchase_reference_number: string | null;
  sold_by: string | null;
  batch_label: string | null;
}

export async function GET(request: Request) {
  const staff = await requireAdminStaff();

  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from") ?? "";
  const toParam = url.searchParams.get("to") ?? "";
  if (!DATE_RE.test(fromParam) || !DATE_RE.test(toParam)) {
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD." }, { status: 400 });
  }

  const fromIso = `${fromParam}T00:00:00+08:00`;
  const toIso = new Date(
    new Date(`${toParam}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000,
  ).toISOString();

  const supabase = await createClient();

  // `id` is the tie-break `fetchAllRows` requires for a total order — two
  // gift codes can share a `purchased_at` timestamp.
  const { rows, truncated } = await fetchAllRows<SaleRow>(
    (from, to) =>
      supabase
        .from("gift_codes")
        .select(
          "id, code, face_value_php, status, purchased_at, purchased_by_name, purchased_by_contact, purchase_method, purchase_reference_number, sold_by, batch_label",
        )
        .gte("purchased_at", fromIso)
        .lt("purchased_at", toIso)
        .not("purchased_at", "is", null)
        .order("purchased_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<SaleRow[]>(),
    REPORT_EXPORT_MAX_ROWS,
  );

  const sellerNames = new Map<string, string>();
  for (const ids of chunk(unique(rows.map((r) => r.sold_by)), IN_CHUNK)) {
    const { data: profiles } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", ids);
    for (const p of profiles ?? []) sellerNames.set(p.id, p.full_name);
  }

  const header = [
    "Date",
    "Time",
    "Code",
    "Face value (PHP)",
    "Buyer name",
    "Buyer contact",
    "Method",
    "Reference",
    "Sold by",
    "Batch",
    "Status",
  ];

  const body = rows
    .filter((r) => r.purchased_at)
    .map((r) => [
      manilaDate(r.purchased_at!),
      manilaTime(r.purchased_at!),
      r.code,
      Number(r.face_value_php).toFixed(2),
      r.purchased_by_name ?? "",
      r.purchased_by_contact ?? "",
      r.purchase_method ?? "",
      r.purchase_reference_number ?? "",
      r.sold_by ? (sellerNames.get(r.sold_by) ?? "") : "",
      r.batch_label ?? "",
      r.status,
    ]);

  return reportCsvResponse({
    staff,
    report: "gift_code_sales",
    filename: `gift-code-sales-${fromParam}-to-${toParam}.csv`,
    rows: [header, ...body],
    truncated,
    filters: { from: fromParam, to: toParam },
  });
}

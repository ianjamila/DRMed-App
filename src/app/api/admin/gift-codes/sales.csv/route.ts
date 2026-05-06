import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function manilaDate(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
  }).format(new Date(iso));
}

function manilaDateTime(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(" ", " ");
}

export async function GET(request: Request) {
  // Admin gate via the cookie-bound staff client. has_role() returns true
  // only for an admin staff session, so a non-admin gets the 403.
  const supabase = await createClient();
  const { data: hasAdmin } = await supabase.rpc("has_role", {
    roles: ["admin"],
  });
  if (!hasAdmin) {
    return NextResponse.json({ error: "Admin only." }, { status: 403 });
  }

  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from") ?? "";
  const toParam = url.searchParams.get("to") ?? "";
  if (!DATE_RE.test(fromParam) || !DATE_RE.test(toParam)) {
    return NextResponse.json(
      { error: "from and to must be YYYY-MM-DD." },
      { status: 400 },
    );
  }

  const fromIso = `${fromParam}T00:00:00+08:00`;
  const toIso = new Date(
    new Date(`${toParam}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000,
  ).toISOString();

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("gift_codes")
    .select(
      "code, face_value_php, status, purchased_at, purchased_by_name, purchased_by_contact, purchase_method, purchase_reference_number, sold_by, batch_label",
    )
    .gte("purchased_at", fromIso)
    .lt("purchased_at", toIso)
    .not("purchased_at", "is", null)
    .order("purchased_at", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const sellerIds = Array.from(
    new Set((rows ?? []).map((r) => r.sold_by).filter(Boolean)),
  ) as string[];
  const sellerNames = new Map<string, string>();
  if (sellerIds.length > 0) {
    const { data: profiles } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", sellerIds);
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

  const lines: string[] = [header.map(escapeCell).join(",")];
  for (const r of rows ?? []) {
    if (!r.purchased_at) continue;
    lines.push(
      [
        manilaDate(r.purchased_at),
        manilaDateTime(r.purchased_at).split(" ")[1] ?? "",
        r.code,
        Number(r.face_value_php).toFixed(2),
        r.purchased_by_name ?? "",
        r.purchased_by_contact ?? "",
        r.purchase_method ?? "",
        r.purchase_reference_number ?? "",
        r.sold_by ? sellerNames.get(r.sold_by) ?? "" : "",
        r.batch_label ?? "",
        r.status,
      ]
        .map(escapeCell)
        .join(","),
    );
  }

  const filename = `gift-code-sales-${fromParam}-to-${toParam}.csv`;
  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

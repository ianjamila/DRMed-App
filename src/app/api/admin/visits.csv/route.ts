import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { csvDocument } from "@/lib/csv/escape";
import { isISODate } from "@/lib/dates/manila";
import { formatPatientName } from "@/lib/patients/format-name";
import { paymentStatusLabel } from "@/lib/ui/payment-status";
import { fetchArchiveAll } from "@/lib/visits/archive-query";
import {
  isVisitView,
  parseVisitClasses,
  serialiseVisitClasses,
  VISIT_CLASS_LABEL,
} from "@/lib/visits/classification";

// Admin-only, matching every other bulk CSV in this app. Paging the archive 25
// at a time is routine reception work; walking out with the whole visit ledger
// — patient names, DRM-IDs and amounts in one file — is not, and RA 10173 wants
// it attributable. Hence requireAdminStaff + an audit row naming the filters.
//
// The RLS-scoped server client is used deliberately, NOT the service-role admin
// client: the export must never be able to return a row the exporting staff
// member could not already read on the page.

// Walking the archive costs ~1ms/row (three queries per 1000-row chunk,
// measured against production), so the ceiling below is ~20s of work — well
// inside this budget, which the default 10s would not have been.
export const maxDuration = 60;

const MAX_ROWS = 20_000;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();

  const sp = req.nextUrl.searchParams;
  const start = isISODate(sp.get("start")) ? sp.get("start")! : "";
  const end = isISODate(sp.get("end")) ? sp.get("end")! : "";
  const classes = parseVisitClasses(sp.get("kind") ?? undefined);
  const viewParam = sp.get("view");
  const view = isVisitView(viewParam) ? viewParam : "active";

  const supabase = await createClient();
  const { rows, count, truncated } = await fetchArchiveAll(
    supabase,
    { start, end, classes, view },
    MAX_ROWS,
  );

  const header = [
    "Visit date",
    "Visit numbers",
    "Split visit",
    "Patient",
    "DRM-ID",
    "Classification",
    "Billed lines",
    "Total PHP",
    "Paid PHP",
    "Payment method",
    "Payment status",
    "Deleted",
    "Delete reason",
  ];

  const body = rows.map((r) => [
    r.visitDate,
    r.members.map((m) => String(m.visit_number).padStart(4, "0")).join(" + "),
    r.split ? "yes" : "no",
    formatPatientName(r.patient),
    r.patient.drm_id,
    r.classes.map((c) => VISIT_CLASS_LABEL[c]).join(" / "),
    r.testCount,
    r.total.toFixed(2),
    r.paid.toFixed(2),
    r.methods === "—" ? "" : r.methods,
    paymentStatusLabel(r.status),
    r.deleted ? "yes" : "no",
    r.deleteReason ?? "",
  ]);

  // A silently truncated export reads as "that's everything". Say so in-band —
  // the reader of the file is not necessarily the person who clicked.
  if (truncated) {
    body.push([
      `TRUNCATED — ${count} visits matched, first ${MAX_ROWS} exported. Narrow the date range.`,
    ]);
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "visits.exported",
    resource_type: "visit",
    resource_id: null,
    metadata: {
      start: start || null,
      end: end || null,
      kind: serialiseVisitClasses(classes) || "all",
      view,
      rows_exported: rows.length,
      visits_matched: count,
      truncated,
    },
    ip_address: ip,
    user_agent: ua,
  });

  const scope = [start || "start", end || "today"].join("_");
  const filename = `visits-${scope}.csv`;

  return new NextResponse(csvDocument([header, ...body]), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

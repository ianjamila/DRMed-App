import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { resolvePeriod } from "@/lib/marketing/period";
import { channelLabel } from "@/lib/marketing/patient-sources";
import { loadAllPeople, type PeopleQuery } from "@/lib/marketing/patient-sources.server";

// Names ⇒ its own audit action (report.patient_sources_people.exported).
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const sp = req.nextUrl.searchParams;
  const period = resolvePeriod({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }, todayManilaISODate());
  const raw = sp.get("mode");
  const mode: PeopleQuery["mode"] = raw === "served" || raw === "returning" ? raw : "new";
  const channel = sp.get("channel") || null;
  const supabase = await createClient();
  const res = await loadAllPeople(supabase, { from: period.from, to: period.to, mode, channel });
  if (!res.ok) return new Response(res.message, { status: res.kind === "forbidden" ? 403 : 500 });
  return reportCsvResponse({
    staff,
    report: "patient_sources_people",
    filename: `patient-sources-people-${period.from}-to-${period.to}-${mode}.csv`,
    rows: [
      ["Date", "Name", "DRM-ID", "Record", "Channel filter"],
      ...res.data.rows.map((r) => [
        r.first_date,
        r.display_name ?? "",
        r.drm_id ?? "",
        r.identity_kind === "confirmed" ? "Patient record" : "Name in the sheet (unconfirmed)",
        channel ? channelLabel(channel) : "All channels",
      ]),
    ],
    truncated: res.data.truncated,
    filters: { from: period.from, to: period.to, mode, channel },
  });
}

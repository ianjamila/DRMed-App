import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  loadPatientsWithoutConsent,
  patientsWithoutConsentCsvFilename,
  patientsWithoutConsentCsvRows,
} from "@/lib/reports/patients-without-consent";

// Admin-only, RLS-scoped client, hard ceiling, audit row — see
// /api/admin/visits.csv for the reasoning. Discloses contact details, hence
// the audit row. maxDuration matches visits.csv.
export const maxDuration = 60;

export async function GET() {
  const staff = await requireAdminStaff();
  const supabase = await createClient();
  const report = await loadPatientsWithoutConsent(supabase, REPORT_EXPORT_MAX_ROWS);
  return reportCsvResponse({
    staff,
    report: "patients_without_consent",
    filename: patientsWithoutConsentCsvFilename(todayManilaISODate()),
    rows: patientsWithoutConsentCsvRows(report.rows, report.visitCount, report.lastVisit),
    truncated: report.truncated,
    filters: {},
  });
}

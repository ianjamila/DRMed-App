import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatPatientName } from "@/lib/patients/format-name";

// Result Follow-ups' "result-ready messages that did not go out" (0210/0212):
// release notices the sender gave up on (`abandoned`), plus how many are still
// waiting for an automatic retry. release_notices is service_role-only, so this
// reads through the admin client AFTER the page has gated the role. It selects
// ids, states, the patient's NAME and DRM-ID and the already-redacted
// last_error — never a phone number or an email address (RA 10173).

export interface StuckNoticeRow {
  id: string;
  visit_id: string;
  visit_number: string;
  patient_name: string;
  drm_id: string;
  test_count: number;
  attempts: number;
  gave_up_at: string | null;
  last_error: string | null;
}

export type StuckNotices =
  | { ok: true; abandoned: StuckNoticeRow[]; waitingForRetry: number; capped: boolean }
  | { ok: false };

export const STUCK_NOTICE_LIMIT = 200;

type PatientEmbed = { first_name: string; middle_name: string | null; last_name: string; drm_id: string };
type VisitEmbed = { visit_number: string; patients: PatientEmbed | PatientEmbed[] | null };

export async function fetchStuckNotices(): Promise<StuckNotices> {
  const admin = createAdminClient();

  // A deleted visit, or a deleted / merged patient, is never listed: nobody is
  // to be contacted about it (the sender cancels or skips those anyway).
  const abandoned = await admin
    .from("release_notices")
    .select(
      `id, visit_id, test_request_ids, attempts, resolved_at, last_error,
       visits!inner ( visit_number, patients!inner ( first_name, middle_name, last_name, drm_id ) )`,
    )
    .eq("status", "abandoned")
    .is("visits.deleted_at", null)
    .is("visits.patients.deleted_at", null)
    .is("visits.patients.merged_into_id", null)
    .order("resolved_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(STUCK_NOTICE_LIMIT + 1);
  if (abandoned.error) return { ok: false };

  const waiting = await admin
    .from("release_notices")
    .select("id", { count: "exact", head: true })
    .eq("status", "retry");
  if (waiting.error) return { ok: false };

  const rows = abandoned.data ?? [];
  const mapped: StuckNoticeRow[] = rows.slice(0, STUCK_NOTICE_LIMIT).map((r) => {
    const visit = (Array.isArray(r.visits) ? r.visits[0] : r.visits) as VisitEmbed | null;
    const patient = Array.isArray(visit?.patients) ? visit?.patients[0] : visit?.patients;
    return {
      id: r.id,
      visit_id: r.visit_id,
      visit_number: visit?.visit_number ?? "",
      patient_name: (patient ? formatPatientName(patient) : "") || "(no name on file)",
      drm_id: patient?.drm_id ?? "",
      test_count: r.test_request_ids.length,
      attempts: r.attempts,
      gave_up_at: r.resolved_at,
      last_error: r.last_error,
    };
  });
  return { ok: true, abandoned: mapped, waitingForRetry: waiting.count ?? 0, capped: rows.length > STUCK_NOTICE_LIMIT };
}

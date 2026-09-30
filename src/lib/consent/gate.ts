import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { LATEST_CONSENT_EVENT_ORDER } from "@/lib/consent/latest-event";
import type { ConsentHistoryEvent } from "@/lib/consent/history";

export async function isConsentGateRequired(): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("consent_settings")
    .select("gate_required")
    .eq("id", true)
    .maybeSingle();
  return !!data?.gate_required;
}

export interface PatientConsentState {
  current: boolean;
  signedAt: string | null;
  withdrawnAt: string | null;
  method: string | null;
  noticeVersion: string | null;
}

export async function getPatientConsentState(
  patientId: string,
): Promise<PatientConsentState> {
  const admin = createAdminClient();
  // The signed artifact behind the current consent is read on demand by the
  // signed-form page (patients/[id]/consent/signed), not here — every visit
  // and receipt page calls this, and none of them needs it.
  const { data } = await admin
    .from("patients")
    .select(
      "consent_current, consent_signed_at, consent_withdrawn_at, consent_method, consent_notice_version",
    )
    .eq("id", patientId)
    .maybeSingle();
  return {
    current: !!data?.consent_current,
    signedAt: data?.consent_signed_at ?? null,
    withdrawnAt: data?.consent_withdrawn_at ?? null,
    method: data?.consent_method ?? null,
    noticeVersion: data?.consent_notice_version ?? null,
  };
}

/**
 * Every consent event for a patient, newest first in the sync trigger's order
 * (seq desc), with the recording staff member's name. A patient has a handful
 * of events at most, well under PostgREST's row cap.
 */
export async function getConsentHistory(patientId: string): Promise<ConsentHistoryEvent[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("patient_consents")
    .select(
      "id, event_type, method, created_at, signatory, signatory_name, signatory_relationship, artifact_path, reason, source_form, consent_scope, actor_kind, recorded_by:staff_profiles!patient_consents_created_by_fkey(full_name)",
    )
    .eq("patient_id", patientId)
    .order(LATEST_CONSENT_EVENT_ORDER.column, {
      ascending: LATEST_CONSENT_EVENT_ORDER.ascending,
    });
  return (data ?? []) as ConsentHistoryEvent[];
}

/**
 * consent_current for many patients in one read (the lab queue lists up to
 * 100 rows across visits). Admin client, same as getPatientConsentState. A
 * missing patient reads as false. Display/preflight only — the DB trigger
 * (0088) is the guard at release time.
 */
export async function getConsentCurrentByPatient(
  patientIds: readonly string[],
): Promise<Map<string, boolean>> {
  const ids = Array.from(new Set(patientIds));
  const out = new Map<string, boolean>();
  if (ids.length === 0) return out;
  const admin = createAdminClient();
  const { data } = await admin.from("patients").select("id, consent_current").in("id", ids);
  for (const r of data ?? []) out.set(r.id, !!r.consent_current);
  return out;
}

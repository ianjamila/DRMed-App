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

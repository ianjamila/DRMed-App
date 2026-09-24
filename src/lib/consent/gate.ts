import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { LATEST_CONSENT_EVENT_ORDER } from "@/lib/consent/latest-event";

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
 * Whether the patient's latest consent event is a booking-only grant (0162):
 * the old online-booking checkbox, which covered contact details for the
 * booking only. It is recorded but does not count as consent on file, so the
 * patient page tells reception to have the patient sign. Read only there —
 * getPatientConsentState stays a single patients read for the many pages
 * that call it.
 */
export async function hasBookingOnlyConsent(patientId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("patient_consents")
    .select("event_type, consent_scope")
    .eq("patient_id", patientId)
    .order(LATEST_CONSENT_EVENT_ORDER.column, {
      ascending: LATEST_CONSENT_EVENT_ORDER.ascending,
    })
    .limit(1)
    .maybeSingle();
  return data?.event_type === "granted" && data.consent_scope === "booking_contact_only";
}

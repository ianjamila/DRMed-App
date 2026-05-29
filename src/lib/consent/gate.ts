import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

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

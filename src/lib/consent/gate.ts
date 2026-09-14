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
  // Path of the signed-artifact scan (paper form or on-screen signature) tied
  // to the LATEST consent event, if that event is a grant and it carried one.
  // Null after a withdrawal, or when no artifact was captured. Never render
  // this path directly — always resolve it through viewConsentArtifactAction,
  // which mints a short-lived signed URL and audit-logs the access.
  artifactPath: string | null;
}

export async function getPatientConsentState(
  patientId: string,
): Promise<PatientConsentState> {
  const admin = createAdminClient();
  const [{ data }, { data: latestEvent }] = await Promise.all([
    admin
      .from("patients")
      .select(
        "consent_current, consent_signed_at, consent_withdrawn_at, consent_method, consent_notice_version",
      )
      .eq("id", patientId)
      .maybeSingle(),
    // patient_consents is an append-only ledger (no denormalized artifact
    // column on `patients`), so the artifact tied to the current state is
    // read straight off the latest event row — same "latest by created_at,
    // id" ordering the sync trigger uses.
    admin
      .from("patient_consents")
      .select("event_type, artifact_path")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    current: !!data?.consent_current,
    signedAt: data?.consent_signed_at ?? null,
    withdrawnAt: data?.consent_withdrawn_at ?? null,
    method: data?.consent_method ?? null,
    noticeVersion: data?.consent_notice_version ?? null,
    artifactPath:
      latestEvent?.event_type === "granted"
        ? (latestEvent.artifact_path ?? null)
        : null,
  };
}

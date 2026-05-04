"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PatientUpdateSchema } from "@/lib/validations/patient";

export type PatientUpdateResult =
  | { ok: true; patient_id: string }
  | { ok: false; error: string };

function readForm(formData: FormData) {
  return {
    first_name: formData.get("first_name"),
    last_name: formData.get("last_name"),
    middle_name: formData.get("middle_name") ?? "",
    birthdate: formData.get("birthdate"),
    sex: formData.get("sex") ?? "",
    phone: formData.get("phone") ?? "",
    email: formData.get("email") ?? "",
    address: formData.get("address") ?? "",
    referral_source: formData.get("referral_source") ?? "",
    referred_by_doctor: formData.get("referred_by_doctor") ?? "",
    preferred_release_medium: formData.get("preferred_release_medium") ?? "",
    senior_pwd_id_kind: formData.get("senior_pwd_id_kind") ?? "",
    senior_pwd_id_number: formData.get("senior_pwd_id_number") ?? "",
    consent_given_today: formData.get("consent_given_today"),
  };
}

export async function updatePatientAction(
  patientId: string,
  _prev: PatientUpdateResult | null,
  formData: FormData,
): Promise<PatientUpdateResult> {
  const session = await requireActiveStaff();

  const parsed = PatientUpdateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const { consent_given_today, ...rest } = parsed.data;

  // Use the admin client so RLS doesn't block reception editing patients
  // they didn't create. Authorisation lives at requireActiveStaff above.
  const admin = createAdminClient();

  // Look at the current consent_signed_at: only stamp it now if it isn't
  // already set. Editing the form should never CLEAR an existing signed
  // consent — that's a deliberate one-way ratchet for RA 10173 compliance.
  const { data: existing } = await admin
    .from("patients")
    .select("consent_signed_at")
    .eq("id", patientId)
    .maybeSingle();

  const consent_signed_at = existing?.consent_signed_at
    ? existing.consent_signed_at
    : consent_given_today === "yes"
      ? new Date().toISOString()
      : null;

  const { error } = await admin
    .from("patients")
    .update({ ...rest, consent_signed_at })
    .eq("id", patientId);

  if (error) return { ok: false, error: error.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: patientId,
    action: "patient.updated",
    resource_type: "patient",
    resource_id: patientId,
    metadata: {
      consent_signed_now: !existing?.consent_signed_at && !!consent_signed_at,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/patients/${patientId}`);
  revalidatePath(`/staff/patients/${patientId}/edit`);
  redirect(`/staff/patients/${patientId}`);
}

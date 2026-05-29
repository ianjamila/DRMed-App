"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PatientUpdateSchema } from "@/lib/validations/patient";
import { recordConsentGrantAction } from "@/lib/actions/consent/grant";

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
    // Signatory fields are read raw from FormData (not part of the Zod schema).
    consent_signatory: (formData.get("consent_signatory") ?? "self").toString(),
    consent_signatory_name: (formData.get("consent_signatory_name") ?? "").toString(),
    consent_signatory_relationship: (formData.get("consent_signatory_relationship") ?? "").toString(),
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
  const consentGivenToday = consent_given_today === "yes";

  // Signatory fields are read raw (not in the Zod schema).
  const consentSignatory = (
    ["self", "guardian", "representative"].includes(
      formData.get("consent_signatory")?.toString() ?? "",
    )
      ? formData.get("consent_signatory")!.toString()
      : "self"
  ) as "self" | "guardian" | "representative";
  const consentSignatoryName =
    formData.get("consent_signatory_name")?.toString().trim() || undefined;
  const consentSignatoryRelationship =
    formData.get("consent_signatory_relationship")?.toString().trim() || undefined;

  // Whenever reception submits a non-empty DOB, treat it as confirmed.
  // Never flip to false here — the legacy importer sets false for imported rows.
  const birthdateRaw = (formData.get("birthdate") ?? "").toString().trim();
  const birthdate_confirmed = birthdateRaw !== "" ? true : undefined;

  // Use the admin client so RLS doesn't block reception editing patients
  // they didn't create. Authorisation lives at requireActiveStaff above.
  const admin = createAdminClient();

  // Check whether the patient already has current consent. If they do, skip
  // recording a new grant to avoid duplicates. The DB trigger owns
  // consent_signed_at and consent_current — do NOT write those columns here.
  let consentSignedNow = false;
  if (consentGivenToday) {
    const { data: existing } = await admin
      .from("patients")
      .select("consent_current")
      .eq("id", patientId)
      .maybeSingle();

    if (!existing?.consent_current) {
      await recordConsentGrantAction({
        patientId,
        method: "paper_wet_signature",
        signatory: consentSignatory,
        signatoryName: consentSignatoryName,
        signatoryRelationship: consentSignatoryRelationship,
      });
      consentSignedNow = true;
    }
  }

  const { error } = await admin
    .from("patients")
    .update({
      ...rest,
      ...(birthdate_confirmed !== undefined ? { birthdate_confirmed } : {}),
    })
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
      consent_signed_now: consentSignedNow,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/patients/${patientId}`);
  revalidatePath(`/staff/patients/${patientId}/edit`);
  redirect(`/staff/patients/${patientId}`);
}

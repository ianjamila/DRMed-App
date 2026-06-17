"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PatientCreateSchema } from "@/lib/validations/patient";
import { findCandidatesForInput } from "@/lib/patients/find-duplicates";
import { recordConsentGrantAction } from "@/lib/actions/consent/grant";

export type PatientCreateResult =
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

export async function createPatientAction(
  _prev: PatientCreateResult | null,
  formData: FormData,
): Promise<PatientCreateResult> {
  const session = await requireActiveStaff();

  const parsed = PatientCreateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  // consent_given_today is a UI-only signal; the DB trigger owns consent_signed_at.
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

  // Any DOB supplied by reception at intake is implicitly confirmed.
  const birthdateRaw = (formData.get("birthdate") ?? "").toString().trim();
  const birthdate_confirmed = birthdateRaw !== "";

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patients")
    .insert({
      ...rest,
      birthdate_confirmed,
      created_by: session.user_id,
      pre_registered: false,
    })
    .select("id, drm_id")
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: error?.message ?? "Could not create patient.",
    };
  }

  // Record consent grant; the AFTER-INSERT trigger sets patients.consent_signed_at
  // and patients.consent_current — application code must NOT write those columns.
  if (consentGivenToday) {
    await recordConsentGrantAction({
      patientId: data.id,
      method: "paper_wet_signature",
      signatory: consentSignatory,
      signatoryName: consentSignatoryName,
      signatoryRelationship: consentSignatoryRelationship,
    });
    // Patient is already created; a grant failure is not fatal — consent can
    // be captured later via the patient detail page.
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: data.id,
    action: "patient.created",
    resource_type: "patient",
    resource_id: data.id,
    metadata: {
      drm_id: data.drm_id,
      created_by_role: session.role,
      consent_signed: consentGivenToday,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // If this new record strongly matches an existing patient, the staff member
  // chose to create a separate record despite the near-match advisory — record
  // the override server-side (independent of any client acknowledgement).
  const admin = createAdminClient();
  const dupes = await findCandidatesForInput(
    admin,
    {
      first_name: rest.first_name,
      last_name: rest.last_name,
      birthdate: rest.birthdate ?? null,
      email: rest.email || null,
      phone_normalized: (rest.phone ?? "").replace(/\D/g, "").slice(-10) || null,
      address: null,
      sex: null,
      excludeId: data.id,
    },
    { minTier: "strong" },
  );
  if (dupes.length > 0) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: data.id,
      action: "patient.create.dup_override",
      resource_type: "patient",
      resource_id: data.id,
      metadata: {
        created_drm_id: data.drm_id,
        matched: dupes.map((d) => ({ drm_id: d.patient.drm_id, tier: d.score.tier })),
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  revalidatePath("/staff/patients");
  redirect(`/staff/patients/${data.id}`);
}

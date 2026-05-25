"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PatientCreateSchema } from "@/lib/validations/patient";

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

  // consent_given_today is a UI-only signal; translate to the actual column.
  const { consent_given_today, ...rest } = parsed.data;
  const consent_signed_at =
    consent_given_today === "yes" ? new Date().toISOString() : null;

  // Any DOB supplied by reception at intake is implicitly confirmed.
  const birthdateRaw = (formData.get("birthdate") ?? "").toString().trim();
  const birthdate_confirmed = birthdateRaw !== "";

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patients")
    .insert({
      ...rest,
      consent_signed_at,
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
      consent_signed: !!consent_signed_at,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/patients");
  redirect(`/staff/patients/${data.id}`);
}

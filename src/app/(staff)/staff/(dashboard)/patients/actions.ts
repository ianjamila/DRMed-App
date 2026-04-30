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

export async function createPatientAction(
  _prev: PatientCreateResult | null,
  formData: FormData,
): Promise<PatientCreateResult> {
  const session = await requireActiveStaff();

  const parsed = PatientCreateSchema.safeParse({
    first_name: formData.get("first_name"),
    last_name: formData.get("last_name"),
    middle_name: formData.get("middle_name") ?? "",
    birthdate: formData.get("birthdate"),
    sex: formData.get("sex") ?? "",
    phone: formData.get("phone") ?? "",
    email: formData.get("email") ?? "",
    address: formData.get("address") ?? "",
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patients")
    .insert({
      ...parsed.data,
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
    metadata: { drm_id: data.drm_id, created_by_role: session.role },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/patients");
  redirect(`/staff/patients/${data.id}`);
}

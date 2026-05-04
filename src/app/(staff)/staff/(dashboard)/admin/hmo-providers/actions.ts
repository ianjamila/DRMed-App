"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  HmoProviderCreateSchema,
  HmoProviderUpdateSchema,
} from "@/lib/validations/hmo-provider";

export type HmoProviderResult =
  | { ok: true }
  | { ok: false; error: string };

function readForm(formData: FormData) {
  return {
    name: formData.get("name"),
    is_active: formData.get("is_active"),
    due_days_for_invoice: formData.get("due_days_for_invoice"),
    contract_start_date: formData.get("contract_start_date"),
    contract_end_date: formData.get("contract_end_date"),
    contact_person_name: formData.get("contact_person_name"),
    contact_person_address: formData.get("contact_person_address"),
    contact_person_phone: formData.get("contact_person_phone"),
    contact_person_email: formData.get("contact_person_email"),
    notes: formData.get("notes"),
  };
}

export async function createHmoProviderAction(
  _prev: HmoProviderResult | null,
  formData: FormData,
): Promise<HmoProviderResult> {
  const session = await requireAdminStaff();
  const parsed = HmoProviderCreateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("hmo_providers")
    .insert(parsed.data)
    .select("id, name")
    .single();
  if (error || !created) {
    return { ok: false, error: error?.message ?? "Could not create provider." };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_provider.created",
    resource_type: "hmo_provider",
    resource_id: created.id,
    metadata: { name: created.name },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/hmo-providers");
  redirect("/staff/admin/hmo-providers");
}

export async function updateHmoProviderAction(
  providerId: string,
  _prev: HmoProviderResult | null,
  formData: FormData,
): Promise<HmoProviderResult> {
  const session = await requireAdminStaff();
  const parsed = HmoProviderUpdateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("hmo_providers")
    .update(parsed.data)
    .eq("id", providerId);
  if (error) return { ok: false, error: error.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "hmo_provider.updated",
    resource_type: "hmo_provider",
    resource_id: providerId,
    metadata: parsed.data,
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/hmo-providers");
  revalidatePath(`/staff/admin/hmo-providers/${providerId}/edit`);
  redirect("/staff/admin/hmo-providers");
}

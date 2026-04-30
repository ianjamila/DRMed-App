"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ServiceSchema } from "@/lib/validations/service";

export type ServiceResult = { ok: true } | { ok: false; error: string };

function parseForm(formData: FormData) {
  return ServiceSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    price_php: formData.get("price_php"),
    turnaround_hours: formData.get("turnaround_hours") ?? "",
    is_active: formData.get("is_active"),
    requires_signoff: formData.get("requires_signoff"),
  });
}

export async function createServiceAction(
  _prev: ServiceResult | null,
  formData: FormData,
): Promise<ServiceResult> {
  const session = await requireAdminStaff();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .insert(parsed.data)
    .select("id, code")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not create service." };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "service.created",
    resource_type: "service",
    resource_id: data.id,
    metadata: { code: data.code },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/services");
  redirect("/staff/services");
}

export async function updateServiceAction(
  serviceId: string,
  _prev: ServiceResult | null,
  formData: FormData,
): Promise<ServiceResult> {
  const session = await requireAdminStaff();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update(parsed.data)
    .eq("id", serviceId);

  if (error) return { ok: false, error: error.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "service.updated",
    resource_type: "service",
    resource_id: serviceId,
    metadata: { code: parsed.data.code },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/services");
  revalidatePath(`/staff/services/${serviceId}/edit`);
  redirect("/staff/services");
}

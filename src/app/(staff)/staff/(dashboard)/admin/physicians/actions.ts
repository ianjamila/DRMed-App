"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  PhysicianCreateSchema,
  PhysicianUpdateSchema,
} from "@/lib/validations/physician";

export type PhysicianResult =
  | { ok: true }
  | { ok: false; error: string };

function readForm(formData: FormData) {
  return {
    slug: formData.get("slug"),
    full_name: formData.get("full_name"),
    specialty: formData.get("specialty"),
    group_label: formData.get("group_label"),
    bio: formData.get("bio"),
    is_active: formData.get("is_active"),
    display_order: formData.get("display_order"),
  };
}

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

export async function createPhysicianAction(
  _prev: PhysicianResult | null,
  formData: FormData,
): Promise<PhysicianResult> {
  const session = await requireAdminStaff();
  const parsed = PhysicianCreateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("physicians")
    .insert(parsed.data)
    .select("id, slug")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error?.message ?? "Could not create physician.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.created",
    resource_type: "physician",
    resource_id: created.id,
    metadata: { slug: created.slug },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/physicians");
  redirect("/staff/admin/physicians");
}

export async function updatePhysicianAction(
  physicianId: string,
  _prev: PhysicianResult | null,
  formData: FormData,
): Promise<PhysicianResult> {
  const session = await requireAdminStaff();
  const parsed = PhysicianUpdateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("physicians")
    .update(parsed.data)
    .eq("id", physicianId);
  if (error) return { ok: false, error: error.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.updated",
    resource_type: "physician",
    resource_id: physicianId,
    metadata: { slug: parsed.data.slug },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/physicians");
  revalidatePath(`/staff/admin/physicians/${physicianId}/edit`);
  redirect("/staff/admin/physicians");
}

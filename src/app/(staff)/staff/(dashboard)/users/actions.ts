"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  StaffCreateSchema,
  StaffUpdateSchema,
} from "@/lib/validations/staff-user";

export type StaffResult =
  | { ok: true; redirect_to?: string }
  | { ok: false; error: string };

export async function createStaffUserAction(
  _prev: StaffResult | null,
  formData: FormData,
): Promise<StaffResult> {
  const session = await requireAdminStaff();

  const parsed = StaffCreateSchema.safeParse({
    email: formData.get("email"),
    full_name: formData.get("full_name"),
    role: formData.get("role"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
  });

  if (authErr || !created.user) {
    return {
      ok: false,
      error: authErr?.message ?? "Could not create auth user.",
    };
  }

  const { error: profileErr } = await admin.from("staff_profiles").insert({
    id: created.user.id,
    full_name: parsed.data.full_name,
    role: parsed.data.role,
    is_active: true,
  });

  if (profileErr) {
    // Roll back the auth user so we don't orphan it.
    await admin.auth.admin.deleteUser(created.user.id);
    return {
      ok: false,
      error: profileErr.message,
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_user.created",
    resource_type: "staff_profile",
    resource_id: created.user.id,
    metadata: {
      email: parsed.data.email,
      role: parsed.data.role,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/users");
  redirect("/staff/users");
}

export async function updateStaffUserAction(
  staffUserId: string,
  _prev: StaffResult | null,
  formData: FormData,
): Promise<StaffResult> {
  const session = await requireAdminStaff();

  const parsed = StaffUpdateSchema.safeParse({
    full_name: formData.get("full_name"),
    role: formData.get("role"),
    is_active: formData.get("is_active"),
    prc_license_kind: formData.get("prc_license_kind"),
    prc_license_no: formData.get("prc_license_no"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("staff_profiles")
    .update(parsed.data)
    .eq("id", staffUserId);

  if (error) return { ok: false, error: error.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_user.updated",
    resource_type: "staff_profile",
    resource_id: staffUserId,
    metadata: parsed.data,
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/users");
  revalidatePath(`/staff/users/${staffUserId}/edit`);
  redirect("/staff/users");
}

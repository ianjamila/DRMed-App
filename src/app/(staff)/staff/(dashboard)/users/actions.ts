"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  AdminResetPasswordSchema,
  StaffCreateSchema,
  StaffUpdateSchema,
} from "@/lib/validations/staff-user";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";

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

export type AdminResetResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function adminResetStaffPasswordAction(
  staffUserId: string,
  _prev: AdminResetResult | null,
  formData: FormData,
): Promise<AdminResetResult> {
  const session = await requireAdminStaff();

  if (session.user_id === staffUserId) {
    return {
      ok: false,
      error: "Use Personal → My profile to change your own password.",
    };
  }

  const parsed = AdminResetPasswordSchema.safeParse({
    new_password: formData.get("new_password"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  // Confirm the target row exists before touching auth, so an admin can't
  // accidentally reset a deleted-profile auth user.
  const { data: target } = await admin
    .from("staff_profiles")
    .select("id, full_name")
    .eq("id", staffUserId)
    .maybeSingle();
  if (!target) {
    return { ok: false, error: "Staff user not found." };
  }

  const { error: updateErr } = await admin.auth.admin.updateUserById(
    staffUserId,
    { password: parsed.data.new_password },
  );
  if (updateErr) {
    return { ok: false, error: updateErr.message };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_user.password_reset_by_admin",
    resource_type: "staff_profile",
    resource_id: staffUserId,
    metadata: { target_name: target.full_name },
    ip_address: ip,
    user_agent: ua,
  });

  return {
    ok: true,
    message: "Password reset. Share the new password with the user securely.",
  };
}

export type DeleteResult =
  | { ok: true; redirect_to: string }
  | { ok: false; error: string };

// Soft-deletes a staff_profile by stamping deleted_at + deleted_by and
// flipping is_active=false. Row stays so audit logs continue to resolve
// actor_id → name. The auth.users row is left intact (no auth.admin.delete)
// because requireSignedInStaff already refuses sessions whose profile is
// deleted_at IS NOT NULL — that's a tighter, idempotent check than churning
// auth users (and it preserves the email→user mapping in case of restore).
export async function softDeleteStaffUserAction(
  staffUserId: string,
  formData: FormData,
): Promise<DeleteResult> {
  const session = await requireAdminStaff();

  if (session.user_id === staffUserId) {
    return {
      ok: false,
      error: "You cannot delete your own account.",
    };
  }

  // Two-step confirmation: client must echo the user's full name back as
  // proof they read the warning. Mismatch aborts.
  const confirmedName = (formData.get("confirm_name") ?? "").toString().trim();

  const admin = createAdminClient();
  const { data: target, error: targetErr } = await admin
    .from("staff_profiles")
    .select("id, full_name, role, deleted_at")
    .eq("id", staffUserId)
    .maybeSingle();
  if (targetErr || !target) {
    return { ok: false, error: "Staff user not found." };
  }
  if (target.deleted_at !== null) {
    return { ok: false, error: "This user is already deleted." };
  }
  if (confirmedName !== target.full_name) {
    return {
      ok: false,
      error: `Confirmation name doesn't match. Type "${target.full_name}" exactly to confirm deletion.`,
    };
  }

  const { error: updateErr } = await admin
    .from("staff_profiles")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: session.user_id,
      is_active: false,
    })
    .eq("id", staffUserId)
    .is("deleted_at", null);

  if (updateErr) return { ok: false, error: updateErr.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_user.deleted",
    resource_type: "staff_profile",
    resource_id: staffUserId,
    metadata: { target_name: target.full_name, target_role: target.role },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/users");
  revalidatePath(`/staff/users/${staffUserId}/edit`);
  return { ok: true, redirect_to: "/staff/users" };
}

// Restores a previously soft-deleted staff user. Clears deleted_at +
// deleted_by but DOES NOT re-activate (admin must flip is_active back to
// true in the edit form). This forces a deliberate two-step recovery.
export async function restoreStaffUserAction(
  staffUserId: string,
): Promise<{ ok: true; redirect_to: string } | { ok: false; error: string }> {
  const session = await requireAdminStaff();

  const admin = createAdminClient();
  const { data: target } = await admin
    .from("staff_profiles")
    .select("id, full_name, deleted_at")
    .eq("id", staffUserId)
    .maybeSingle();
  if (!target) return { ok: false, error: "Staff user not found." };
  if (target.deleted_at === null) {
    return { ok: false, error: "This user is not deleted." };
  }

  const { error } = await admin
    .from("staff_profiles")
    .update({ deleted_at: null, deleted_by: null })
    .eq("id", staffUserId);
  if (error) return { ok: false, error: error.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_user.restored",
    resource_type: "staff_profile",
    resource_id: staffUserId,
    metadata: { target_name: target.full_name },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/users");
  return { ok: true, redirect_to: `/staff/users/${staffUserId}/edit` };
}

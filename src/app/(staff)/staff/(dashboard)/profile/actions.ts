"use server";

import { createClient as createSbClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { ChangePasswordSchema } from "@/lib/validations/staff-user";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";

export type ProfileResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function changeMyPasswordAction(
  _prev: ProfileResult | null,
  formData: FormData,
): Promise<ProfileResult> {
  const session = await requireActiveStaff();

  const parsed = ChangePasswordSchema.safeParse({
    current_password: formData.get("current_password"),
    new_password: formData.get("new_password"),
    confirm_password: formData.get("confirm_password"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  // Verify the current password by calling signInWithPassword against a
  // throw-away anon-key client (no cookies, no persisted session). This
  // does NOT touch the user's existing browser session — if the password
  // is wrong, sign-in fails locally; if it's right, the returned session
  // is discarded.
  const verifier = createSbClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: verifyErr } = await verifier.auth.signInWithPassword({
    email: session.email,
    password: parsed.data.current_password,
  });
  if (verifyErr) {
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "staff_user.self_password_change_rejected",
      resource_type: "staff_profile",
      resource_id: session.user_id,
      metadata: { reason: "wrong_current_password" },
      ip_address: ip,
      user_agent: ua,
    });
    return { ok: false, error: "Current password is incorrect." };
  }

  // Apply the new password via the service-role admin client (bypasses
  // any user-facing rate limits).
  const admin = createAdminClient();
  const { error: updateErr } = await admin.auth.admin.updateUserById(
    session.user_id,
    { password: parsed.data.new_password },
  );
  if (updateErr) {
    return { ok: false, error: updateErr.message };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_user.self_password_changed",
    resource_type: "staff_profile",
    resource_id: session.user_id,
    metadata: {},
    ip_address: ip,
    user_agent: ua,
  });

  return {
    ok: true,
    message: "Password updated. Use the new password next time you sign in.",
  };
}

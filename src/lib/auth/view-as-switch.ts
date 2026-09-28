// src/lib/auth/view-as-switch.ts
// Admin "View as role" — start / switch / exit. Server-only core, called by
// the Server Actions in app/(staff)/staff/(dashboard)/view-as/actions.ts.
//
// Guards on session.actual_role, never session.role: while simulating, `role`
// IS the simulated role, and an admin viewing as reception must still be able
// to exit. Writes go through the service-role client for the same reason —
// under the simulated role has_role(array['admin']) is false, so the
// "staff_profiles: admin manage" policy would refuse the admin's own row.
// The `.eq("role", "admin")` filter is defense in depth: even a wrong session
// can never put an override on a non-admin row (and the SQL CASE would ignore
// it anyway).
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import type { StaffSession } from "./require-staff";
import { VIEW_AS_DURATION_MS, isViewAsRole } from "./view-as";

export type ViewAsResult = { ok: true } | { ok: false; error: string };

export interface ViewAsContext {
  ip: string | null;
  ua: string | null;
  /** Injectable clock for tests. */
  now?: Date;
}

const NOT_ADMIN = "Only an admin can view the app as another role.";

export async function startViewAs(
  session: StaffSession,
  role: unknown,
  ctx: ViewAsContext,
): Promise<ViewAsResult> {
  if (session.actual_role !== "admin") return { ok: false, error: NOT_ADMIN };
  if (!isViewAsRole(role)) return { ok: false, error: "Unknown role." };

  const now = ctx.now ?? new Date();
  const until = new Date(now.getTime() + VIEW_AS_DURATION_MS).toISOString();

  const { error } = await createAdminClient()
    .from("staff_profiles")
    .update({ view_as_role: role, view_as_until: until })
    .eq("id", session.user_id)
    .eq("role", "admin");
  if (error) return { ok: false, error: "Could not start viewing as another role." };

  const base = {
    actor_id: session.user_id,
    actor_type: "staff" as const,
    ip_address: ctx.ip,
    user_agent: ctx.ua,
  };
  if (session.view_as) {
    await audit({
      ...base,
      action: "staff.view_as.ended",
      metadata: { role: session.view_as.role, reason: "switched" },
    });
  }
  await audit({
    ...base,
    action: "staff.view_as.started",
    metadata: { role, until },
  });
  return { ok: true };
}

export async function exitViewAs(
  session: StaffSession,
  ctx: ViewAsContext,
): Promise<ViewAsResult> {
  if (session.actual_role !== "admin") return { ok: false, error: NOT_ADMIN };

  const { error } = await createAdminClient()
    .from("staff_profiles")
    .update({ view_as_role: null, view_as_until: null })
    .eq("id", session.user_id)
    .eq("role", "admin");
  if (error) return { ok: false, error: "Could not exit the role view." };

  // No active override (expired, or stale columns) → nothing to bracket.
  if (session.view_as) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "staff.view_as.ended",
      metadata: { role: session.view_as.role, reason: "manual" },
      ip_address: ctx.ip,
      user_agent: ctx.ua,
    });
  }
  return { ok: true };
}

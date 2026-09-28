// src/lib/auth/view-as-switch.ts
// Admin "View as role" — start / switch / exit / lazy expiry. Server-only;
// called by the Server Actions in app/(staff)/staff/(dashboard)/view-as/
// actions.ts and by requireSignedInStaff().
//
// Every state change and its staff.view_as.* audit rows happen inside one
// row-locked SQL call (0187 view_as_transition / view_as_expire), so two
// tabs can no longer double-log or lose an "ended" row. Guards on
// session.actual_role, never session.role: while simulating, `role` IS the
// simulated role, and an admin viewing as reception must still be able to
// exit. Service-role client because under the simulated role RLS would refuse
// the admin's own row; the SQL re-checks role = 'admin' under the row lock
// (P0074), so a wrong session still cannot put an override on anyone else.
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import type { StaffSession } from "./require-staff";
import { isViewAsRole, type ViewAsRole } from "./view-as";

export type ViewAsResult =
  | { ok: true; role: ViewAsRole | null }
  | { ok: false; error: string };

export interface ViewAsContext {
  ip: string | null;
  ua: string | null;
}

const NOT_ADMIN = "Only an admin can view the app as another role.";

function requestArgs(ctx: ViewAsContext) {
  return {
    ...(ctx.ip ? { p_ip: ctx.ip } : {}),
    ...(ctx.ua ? { p_ua: ctx.ua } : {}),
  };
}

async function transition(
  session: StaffSession,
  role: ViewAsRole | null,
  ctx: ViewAsContext,
  failure: string,
): Promise<ViewAsResult> {
  const { data, error } = await createAdminClient().rpc("view_as_transition", {
    p_actor: session.user_id,
    ...(role ? { p_role: role } : {}),
    ...requestArgs(ctx),
  });
  if (error) return { ok: false, error: error.code === "P0074" ? NOT_ADMIN : failure };
  const next = (data as { role?: unknown } | null)?.role;
  return { ok: true, role: isViewAsRole(next) ? next : null };
}

export async function startViewAs(
  session: StaffSession,
  role: unknown,
  ctx: ViewAsContext,
): Promise<ViewAsResult> {
  if (session.actual_role !== "admin") return { ok: false, error: NOT_ADMIN };
  if (!isViewAsRole(role)) return { ok: false, error: "Unknown role." };
  return transition(session, role, ctx, "Could not start viewing as another role.");
}

export async function exitViewAs(
  session: StaffSession,
  ctx: ViewAsContext,
): Promise<ViewAsResult> {
  if (session.actual_role !== "admin") return { ok: false, error: NOT_ADMIN };
  return transition(session, null, ctx, "Could not exit the role view.");
}

/** Lazy `staff.view_as.ended` reason=expired (0187 view_as_expire). Best
 *  effort: the session is already correct without it (an expired override
 *  is inert), so a failure is reported, never thrown. */
export async function expireStaleViewAs(userId: string, ctx: ViewAsContext): Promise<void> {
  const { error } = await createAdminClient().rpc("view_as_expire", {
    p_actor: userId,
    ...requestArgs(ctx),
  });
  if (error) {
    await reportError({
      scope: "view-as.expire",
      error: new Error(error.message),
      metadata: { userId },
    });
  }
}

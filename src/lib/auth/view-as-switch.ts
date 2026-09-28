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

export type EndViewAsResult =
  | { ok: true; ended: boolean }
  | { ok: false; error: string };

const NOT_UNSIMULATING_ADMIN =
  "Only an admin who isn't viewing the app as another role can end someone's role view.";

/** Admin B ends admin A's active View-as override (the "End now" button on
 *  /staff/users — spec addendum A3). `session` must be a genuine, effective
 *  admin (requireAdminStaff already ensures this — a simulating admin's
 *  effective role is the simulated one, so they can't reach the page at
 *  all), and `targetId` must be a real, non-empty id that isn't the caller's
 *  own (an admin can't end their own view from here; the button is hidden
 *  on their own line anyway). The SQL (0190 view_as_end_for) re-checks the
 *  caller is a genuine, non-simulating admin under a row lock (P0076) —
 *  this guard is belt-and-suspenders, not the source of truth. */
export async function endViewAsFor(
  session: StaffSession,
  targetId: unknown,
  ctx: ViewAsContext,
): Promise<EndViewAsResult> {
  if (session.role !== "admin") return { ok: false, error: NOT_ADMIN };
  if (typeof targetId !== "string" || targetId.trim() === "") {
    return { ok: false, error: "Could not end that role view." };
  }
  if (targetId === session.user_id) {
    return { ok: false, error: "You can't end your own role view from here." };
  }

  const { data, error } = await createAdminClient().rpc("view_as_end_for", {
    p_actor: session.user_id,
    p_target: targetId,
    ...requestArgs(ctx),
  });
  if (error) {
    return {
      ok: false,
      error: error.code === "P0076" ? NOT_UNSIMULATING_ADMIN : "Could not end that role view.",
    };
  }
  return { ok: true, ended: data === true };
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

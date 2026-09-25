// src/lib/auth/view-as.ts
// Admin "View as role" — the pure rules shared by the session loader (server),
// the switch actions (server) and the banner (client). No server-only imports.
//
// Mirrors the SQL CASE in supabase/migrations/0182_staff_view_as_role.sql:
//   when role = 'admin' and view_as_until > now() then view_as_role else role
// view-as-migration.test.ts pins the two to each other.
import type { StaffSession } from "./require-staff";

export const VIEW_AS_ROLES = [
  "reception",
  "medtech",
  "xray_technician",
  "pathologist",
] as const;
export type ViewAsRole = (typeof VIEW_AS_ROLES)[number];

/** How long an override lasts. Owner decision 2026-09-25: 4 hours. */
export const VIEW_AS_DURATION_MS = 4 * 60 * 60 * 1000;

export interface ViewAsColumns {
  role: string;
  view_as_role: string | null;
  view_as_until: string | null;
}

export interface ActiveViewAs {
  role: ViewAsRole;
  /** ISO-8601 UTC. */
  until: string;
}

export function isViewAsRole(value: unknown): value is ViewAsRole {
  return typeof value === "string" && (VIEW_AS_ROLES as readonly string[]).includes(value);
}

/** The override that is in force right now, or null. Only an admin row can
 *  carry one; the expiry check is strict (an expiry equal to `now` is over). */
export function activeViewAs(profile: ViewAsColumns, now: Date = new Date()): ActiveViewAs | null {
  if (profile.role !== "admin") return null;
  if (!isViewAsRole(profile.view_as_role) || !profile.view_as_until) return null;
  const until = Date.parse(profile.view_as_until);
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  return { role: profile.view_as_role, until: new Date(until).toISOString() };
}

/** The role every page should behave as. */
export function effectiveRole(profile: ViewAsColumns, now: Date = new Date()): StaffSession["role"] {
  return (activeViewAs(profile, now)?.role ?? profile.role) as StaffSession["role"];
}

/** "3h 40m" / "12m" / "under a minute" — rendered server-side in the banner. */
export function formatRemaining(untilIso: string, now: Date = new Date()): string {
  const ms = Date.parse(untilIso) - now.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

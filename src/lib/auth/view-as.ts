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

/** "3h 40m" / "12m" / "under a minute". */
export function formatRemainingMs(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Server-side label from an ISO expiry. */
export function formatRemaining(untilIso: string, now: Date = new Date()): string {
  return formatRemainingMs(Date.parse(untilIso) - now.getTime());
}

/** Server-computed ms remaining until an ISO expiry. A default parameter
 *  (rather than `Date.now()` inline in a render body) keeps a server
 *  component's render pure for the react-hooks/purity rule — same pattern
 *  as `hasRecentAudit` in `action-helpers.ts`. */
export function remainingMsFrom(untilIso: string, now: Date = new Date()): number {
  return Date.parse(untilIso) - now.getTime();
}

/** Delay before the banner asks the server whether the override has ended:
 *  the server-computed remaining time plus 1s, so the server's strict
 *  `until > now()` is already false. Never below 1s (no hot loop). */
export function expiryRefreshDelay(remainingMs: number): number {
  return Math.max(remainingMs, 0) + 1_000;
}

/** An admin row still storing an override that has run out — the case the
 *  lazy `view_as_expire` cleanup (0187) exists for. */
export function hasStaleViewAs(profile: ViewAsColumns, now: Date = new Date()): boolean {
  return profile.role === "admin" && profile.view_as_role !== null && activeViewAs(profile, now) === null;
}

/** Pure countdown arithmetic for the banner's `useCountdown` hook. `tick` is
 *  `{ base, elapsed }` from a `performance.now()`-based interval: `base` is
 *  the `remainingMs` in force when the tick was captured, `elapsed` is
 *  wall-clock ms since the timer armed. Only apply the tick when its `base`
 *  still matches the current `remainingMs` — a new server render (new props)
 *  invalidates any tick captured against the old value, so a stale tick from
 *  before a refresh is ignored rather than applied to the wrong baseline. */
export function countdownRemainingMs(
  remainingMs: number,
  tick: { base: number; elapsed: number } | null,
): number {
  return tick && tick.base === remainingMs ? remainingMs - tick.elapsed : remainingMs;
}

/** Identity of a View-as state; changes on every start/switch/exit. Used as a
 *  React key: to reset the picker (`ViewAsSelect key={...}`), and — on
 *  `StaffMobileNavTrigger` itself, in `staff-shell.tsx` — to remount the
 *  whole mobile drawer closed on any state change, including a round trip
 *  back to "none" (Codex P3: a plain open-boolean couldn't tell that case
 *  from "never opened", so exiting View-as could reopen the drawer). */
export function viewAsStateKey(v: ActiveViewAs | null): string {
  return v ? `${v.role}@${v.until}` : "none";
}

/** What the View-as Server Actions return to `useActionState`. */
export interface ViewAsActionState {
  error: string | null;
}

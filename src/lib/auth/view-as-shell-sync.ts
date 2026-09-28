// Client-safe. Decides whether an admin's staff shell (sidebar, banner,
// picker) is out of date with the database. Next caches the dashboard
// layout across client navigations, so a switch made on another device is
// invisible here until something refreshes it; a full router.refresh() on
// every navigation would double every page load, so ask a tiny endpoint first.
import { isViewAsRole, type ViewAsRole } from "./view-as";

export const VIEW_AS_STATE_URL = "/staff/view-as/state";

export interface ViewAsShellState {
  /** The role the caller actually rendered with — always "admin" for the
   *  components that use this (they only render for admins), but passed in
   *  explicitly by the caller rather than hardcoded, so a real demotion
   *  (an admin's `staff_profiles.role` changed elsewhere) is caught too:
   *  without this, an admin demoted to reception with no active override
   *  looks unchanged ({null,null} before and after) and the shell never
   *  refreshes (Codex P2). */
  actualRole: string;
  viewAs: { role: ViewAsRole; until: string } | null;
}

export function shellIsStale(expected: ViewAsShellState, actual: unknown): boolean {
  if (!actual || typeof actual !== "object") return true;
  const a = actual as Record<string, unknown>;
  if (typeof a.actual_role !== "string") return true;
  if (a.actual_role !== expected.actualRole) return true;
  const role = isViewAsRole(a.role) ? a.role : null;
  const until = typeof a.until === "string" ? Date.parse(a.until) : null;
  const expectedRole = expected.viewAs?.role ?? null;
  const expectedUntil = expected.viewAs ? Date.parse(expected.viewAs.until) : null;
  return role !== expectedRole || until !== expectedUntil;
}

/** true → the caller should router.refresh(). An aborted check is a no-op;
 *  any other failure (network, login redirect, non-JSON) refreshes, which is
 *  the safe direction: a refresh re-renders from the database. */
export async function checkViewAsShell(
  expected: ViewAsShellState,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetchImpl(VIEW_AS_STATE_URL, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return true;
    return shellIsStale(expected, await res.json());
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return false;
    return true;
  }
}

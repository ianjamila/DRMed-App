// Where a View-as switch/exit sends the admin: back to the page they were on
// when the NEW role's sidebar can reach it, else /staff. The value comes from
// a hidden form field, so it is attacker-controlled: safeRedirectPath() does
// the open-redirect checks (same rules as post-login), then a URL parse pins
// the origin, then the sidebar decides reachability. Pages no sidebar item
// owns fall back to /staff; every page's own server guard stays the backstop.
import { isSectionActive, visibleNavFor, type StaffRole } from "@/components/staff/staff-nav-config";
import { safeRedirectPath } from "./safe-redirect";

const HOME = "/staff";
const BASE = "https://x.invalid";

export function safeReturnTo(raw: unknown, role: StaffRole): string {
  if (typeof raw !== "string") return HOME;
  const checked = safeRedirectPath(raw);
  if (checked === HOME) return HOME;
  let url: URL;
  try {
    url = new URL(checked, BASE);
  } catch {
    return HOME;
  }
  if (url.origin !== BASE) return HOME;
  const { pathname, search } = url;
  if (pathname !== HOME && !pathname.startsWith(`${HOME}/`)) return HOME;
  if (pathname !== HOME && !visibleNavFor(role).some((s) => isSectionActive(s, pathname))) {
    return HOME;
  }
  return pathname + search;
}

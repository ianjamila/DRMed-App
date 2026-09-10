// Where a staff member lands after signing in. Every post-login redirect goes
// through here: the value arrives on the query string, so it is attacker-
// controlled and must never be able to leave the site.
//
// The allowlist is deliberately narrow — /staff and below is the only place a
// signed-in staff member has any business landing.
const DEFAULT_PATH = "/staff";

export function safeRedirectPath(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length === 0) return DEFAULT_PATH;

  // Must be inside the staff area. This single check also rejects "//host"
  // (scheme-relative, which browsers navigate off-site) and any absolute URL.
  if (next !== "/staff" && !next.startsWith("/staff/")) return DEFAULT_PATH;

  // Some browsers normalise "\" to "/", so a backslash can smuggle a host.
  if (next.includes("\\")) return DEFAULT_PATH;

  // "/staff/../.." escapes the prefix check above once the browser resolves it.
  if (next.split(/[/?#]/).includes("..")) return DEFAULT_PATH;

  // CR/LF/NUL and friends can split a header or truncate a URL.
  if (/[\x00-\x1f]/.test(next)) return DEFAULT_PATH;

  return next;
}

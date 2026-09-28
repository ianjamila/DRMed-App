// Where a staff member lands after signing in. Every post-login redirect goes
// through here: the value arrives on the query string, so it is attacker-
// controlled and must never be able to leave the site.
//
// The allowlist is deliberately narrow — /staff and below is the only place a
// signed-in staff member has any business landing.
const DEFAULT_PATH = "/staff";

// Anything below U+0020, plus U+007F (DEL). Written as code points rather
// than a regex escape class on purpose: the escape sequence kept getting
// mangled into literal control bytes by the tooling that edits this file.
const FIRST_PRINTABLE = 0x20;
const DEL = 0x7f;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < FIRST_PRINTABLE || codePoint === DEL) return true;
  }
  return false;
}

export function safeRedirectPath(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length === 0) return DEFAULT_PATH;

  // Must be inside the staff area. This single check also rejects "//host"
  // (scheme-relative, which browsers navigate off-site) and any absolute URL.
  if (next !== "/staff" && !next.startsWith("/staff/")) return DEFAULT_PATH;

  // Some browsers normalise "\" to "/", so a backslash can smuggle a host.
  if (next.includes("\\")) return DEFAULT_PATH;

  // "/staff/../.." escapes the prefix check above once the browser resolves it.
  if (next.split(/[/?#]/).includes("..")) return DEFAULT_PATH;

  // CR/LF/NUL and friends can split a header or truncate a URL. DEL too.
  if (hasControlCharacter(next)) return DEFAULT_PATH;

  // The checks above only look at the RAW string, so a percent-encoded ".."
  // segment (any case, and mixed with a literal dot — "%2e.", ".%2e") sails
  // through: the literal two dots never appear. A browser decodes and
  // resolves the path before navigating, so "/staff/%2e%2e/patients" lands
  // on "/patients" — same origin, never off-site, but outside the staff area
  // this function promises. Resolve against a fixed dummy origin (WHATWG URL
  // parsing does the percent-decoding and dot-segment collapsing for us) and
  // require the result to still be same-origin and inside /staff.
  const DUMMY_ORIGIN = "https://x.invalid";
  let resolved: URL;
  try {
    resolved = new URL(next, DUMMY_ORIGIN);
  } catch {
    return DEFAULT_PATH;
  }
  if (resolved.origin !== DUMMY_ORIGIN) return DEFAULT_PATH;
  if (resolved.pathname !== "/staff" && !resolved.pathname.startsWith("/staff/")) {
    return DEFAULT_PATH;
  }

  return next;
}

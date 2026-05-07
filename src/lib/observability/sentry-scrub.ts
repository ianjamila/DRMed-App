// Shared PII scrubbing for Sentry events. RA 10173 requires that personally
// identifiable information from patients and staff does not leave our infra
// without consent. This redacts the obvious leak vectors before any event
// reaches Sentry's ingest:
//   - DRM-IDs (e.g. DRM-0042) — patient identifier
//   - Email addresses
//   - Philippine mobile numbers (+63 9XXXXXXXXX or 09XXXXXXXXX)
//   - Cookies + Authorization header (would expose Supabase JWTs and the
//     drmed_patient_session cookie which is a signed JWT we'd rather not
//     correlate to errors)
//   - Request bodies (can contain names, PINs, payloads)
//   - URL query strings
//
// Receipt PINs are 8-char alphanumeric and not statistically distinguishable
// from random tokens, so we don't pattern-match them; the project rule is
// "never log plain PINs" (CLAUDE.md), and audit_log only stores the bcrypt
// hash. If a PIN ever appears in an error, it's a code bug to fix at source.

import type { ErrorEvent } from "@sentry/nextjs";

const DRM_ID_RE = /\bDRM-\d{3,}\b/g;
const EMAIL_RE = /[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const PH_PHONE_RE = /(?:\+?63|0)9\d{9}/g;

function scrubText(s: string): string {
  return s
    .replace(DRM_ID_RE, "DRM-[redacted]")
    .replace(EMAIL_RE, "[email]")
    .replace(PH_PHONE_RE, "[phone]");
}

function scrubMaybe<T>(v: T): T {
  if (typeof v === "string") return scrubText(v) as T;
  return v;
}

function scrubUrl(url: string): string {
  try {
    const u = new URL(url, "http://x");
    if (u.search) u.search = "";
    return scrubText(u.pathname);
  } catch {
    return scrubText(url);
  }
}

export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  // Request data: drop cookies and auth, scrub URL + body.
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      const h = event.request.headers as Record<string, string>;
      delete h.cookie;
      delete h.Cookie;
      delete h.authorization;
      delete h.Authorization;
    }
    if (typeof event.request.url === "string") {
      event.request.url = scrubUrl(event.request.url);
    }
    if (event.request.query_string) {
      event.request.query_string = "[redacted]";
    }
    if (event.request.data !== undefined) {
      event.request.data = "[redacted]";
    }
  }

  // User: keep id only (Supabase user UUID for staff is fine; patient
  // identifier — drm_id — is not). Drop email, ip, username.
  if (event.user) {
    const id = event.user.id;
    event.user = id ? { id: String(id) } : {};
  }

  // Exception messages and stack frame variables.
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
    if (ex.type) ex.type = scrubText(ex.type);
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (frame.vars) {
        for (const k of Object.keys(frame.vars)) {
          frame.vars[k] = scrubMaybe(frame.vars[k]);
        }
      }
    }
  }

  // Breadcrumbs (fetch URLs, console messages, navigation, ui clicks).
  for (const bc of event.breadcrumbs ?? []) {
    if (bc.message) bc.message = scrubText(bc.message);
    if (bc.data) {
      for (const k of Object.keys(bc.data)) {
        bc.data[k] = scrubMaybe(bc.data[k]);
      }
    }
  }

  // Top-level message (Sentry.captureMessage).
  if (event.message) event.message = scrubText(event.message);

  // Extras / contexts — anything we attached intentionally still gets a pass.
  if (event.extra) {
    for (const k of Object.keys(event.extra)) {
      event.extra[k] = scrubMaybe(event.extra[k]);
    }
  }

  return event;
}

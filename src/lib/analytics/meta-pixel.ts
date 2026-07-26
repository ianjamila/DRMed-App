// Thin wrapper around window.fbq — the base Meta Pixel script is mounted once
// by <MetaPixel> in the marketing layout (src/app/(marketing)/layout.tsx) and
// is a no-op everywhere else (NEXT_PUBLIC_META_PIXEL_ID unset). Every call
// here is also a no-op until that script has loaded, which is expected for the
// first handful of milliseconds of a session.
//
// Never call this from the patient portal or staff portal (RA 10173) — the
// marketing layout intentionally doesn't mount the base script there.

import { CONSENT_COOKIE_NAME, hasAdvertisingConsent, readCookieFromHeader } from "./consent";

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[] };
  }
}

// eventId, when passed, lets Meta de-duplicate this browser Pixel event
// against the matching server-side Conversions API event fired for the same
// action (see src/lib/analytics/meta-capi.ts) — pass the same id to both.
export function metaTrack(
  eventName: string,
  customData?: Record<string, unknown>,
  eventId?: string,
): void {
  if (typeof window === "undefined" || typeof window.fbq !== "function") return;

  // Defence in depth. In normal operation a declined visitor has no fbq at all,
  // because <MetaPixel> never mounts the script — so the guard above already
  // covers it. This re-checks consent at the single choke point every tracking
  // call passes through, so the "no consent, no tracking" guarantee does not
  // depend on nothing else ever defining window.fbq (a browser extension, a
  // third-party embed, a future script added to the page). Cheap: one
  // document.cookie read per event.
  const cookieHeader = typeof document === "undefined" ? undefined : document.cookie;
  if (!hasAdvertisingConsent(readCookieFromHeader(cookieHeader, CONSENT_COOKIE_NAME))) {
    return;
  }

  if (eventId) {
    window.fbq("track", eventName, customData ?? {}, { eventID: eventId });
  } else {
    window.fbq("track", eventName, customData ?? {});
  }
}

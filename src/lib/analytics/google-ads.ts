// Thin wrapper around window.gtag for Google Ads conversion tracking — the
// sibling of ./meta-pixel.ts, and deliberately shaped the same way. The base
// gtag.js script is mounted once by <GoogleTag> in the marketing layout
// (src/app/(marketing)/layout.tsx) and is a no-op everywhere else
// (NEXT_PUBLIC_GOOGLE_ADS_ID unset). Every call here is also a no-op until
// that script has loaded, which is expected for the first handful of
// milliseconds of a session.
//
// Never call this from the patient portal or staff portal (RA 10173) — the
// marketing layout intentionally doesn't mount the base script there.
//
// What may and may not be sent to Google is fixed by
// docs/decisions/0004-google-ads-conversion-tracking.md. Read it before adding
// a conversion or a parameter; the risky change is not a new conversion, it is
// adding a field to an existing one.

import { CONSENT_COOKIE_NAME, hasAdvertisingConsent, readCookieFromHeader } from "./consent";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

// Account-wide Google Ads tag id, of the form "AW-868551722". Unset in an env
// without the tag configured yet (e.g. a fresh local clone), which switches
// every consumer below off.
export const GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID;

// Per-conversion-action labels, the second half of gtag's `send_to`
// ("AW-868551722/<label>"). Each is independently optional: an unset label
// silently disables just that conversion, leaving the tag — and the other
// conversions — working. That matters because the labels are minted one at a
// time in the Google Ads UI (Goals → Conversions → new conversion action), so
// the code has to tolerate having some but not all of them.
//
// Read as literal `process.env.NEXT_PUBLIC_*` member expressions because that
// is the only form Next.js inlines into the client bundle.
export const GOOGLE_ADS_CONVERSION_LABELS = {
  // "Booking submitted" — a public /schedule booking reached the success screen.
  booking: process.env.NEXT_PUBLIC_GOOGLE_ADS_BOOKING_LABEL,
  // "Messenger chat started" — a visitor tapped through to Messenger.
  messenger: process.env.NEXT_PUBLIC_GOOGLE_ADS_MESSENGER_LABEL,
} as const;

export type GoogleAdsConversionName = keyof typeof GOOGLE_ADS_CONVERSION_LABELS;

// transactionId, when passed, is the same random per-submission UUID already
// sent to Meta as eventID (see ./event-id.ts). Google de-duplicates
// conversions that share a transaction_id for a given conversion action, so
// passing it makes a repeat fire — a reloaded success screen, a double mount —
// count once. It is explicitly NOT the DRM-ID and not the booking group id.
export function googleAdsConversion(
  name: GoogleAdsConversionName,
  transactionId?: string,
): void {
  const label = GOOGLE_ADS_CONVERSION_LABELS[name];
  if (!GOOGLE_ADS_ID || !label) return;
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;

  // Defence in depth, exactly as in metaTrack. In normal operation a declined
  // visitor has no gtag at all, because <GoogleTag> never mounts the script —
  // so the guard above already covers it. This re-checks consent at the single
  // choke point every conversion passes through, so the "no consent, no
  // tracking" guarantee does not depend on nothing else ever defining
  // window.gtag (a browser extension, a third-party embed, a future script
  // added to the page). Cheap: one document.cookie read per conversion.
  const cookieHeader = typeof document === "undefined" ? undefined : document.cookie;
  if (!hasAdvertisingConsent(readCookieFromHeader(cookieHeader, CONSENT_COOKIE_NAME))) {
    return;
  }

  // No `value`/`currency`: a booking's worth varies and inventing a number
  // would poison target-CPA bidding. The conversion action carries its own
  // default value, set once in the Google Ads UI.
  const params: Record<string, unknown> = { send_to: `${GOOGLE_ADS_ID}/${label}` };
  if (transactionId) params.transaction_id = transactionId;

  window.gtag("event", "conversion", params);
}

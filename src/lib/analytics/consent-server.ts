import "server-only";
import { cookies } from "next/headers";
import { CONSENT_COOKIE_NAME, hasAdvertisingConsent } from "./consent";

// Server-side consent gate, used by the Conversions API sender so declined
// visitors generate no server-side events either. Kept apart from ./consent.ts
// so that module stays free of `next/headers` and remains importable from the
// proxy (middleware runtime) and from unit tests.
export async function hasAdvertisingConsentServer(): Promise<boolean> {
  const c = await cookies();
  return hasAdvertisingConsent(c.get(CONSENT_COOKIE_NAME)?.value);
}

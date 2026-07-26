"use server";

import { cookies } from "next/headers";
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_SECONDS,
  META_PIXEL_COOKIE_NAMES,
  parseConsentChoice,
  type ConsentChoice,
} from "@/lib/analytics/consent";
import { ATTRIBUTION_COOKIE_NAME } from "@/lib/analytics/attribution";

// Persists the visitor's cookie-consent choice.
//
// This runs on the server rather than being a `document.cookie` write because
// declining must also clear the UTM attribution cookie, which is HttpOnly and
// therefore invisible to client JS. Accepting and declining go through the
// same path so there is one place that defines what each choice implies.
//
// The consent cookie itself is deliberately NOT HttpOnly: the banner and the
// Pixel loader are client components that must read it to decide whether to
// mount tracking at all, and a consent flag is not a secret.
export async function recordCookieConsent(choice: ConsentChoice): Promise<void> {
  // Never trust the client with an unvalidated cookie value.
  const validated = parseConsentChoice(choice);
  if (!validated) return;

  const store = await cookies();

  store.set(CONSENT_COOKIE_NAME, validated, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: CONSENT_MAX_AGE_SECONDS,
  });

  if (validated === "denied") {
    // Declining withdraws consent for anything already dropped, not just
    // future writes: the campaign attribution cookie plus the Meta Pixel's own
    // _fbp/_fbc identifiers.
    store.delete(ATTRIBUTION_COOKIE_NAME);
    for (const name of META_PIXEL_COOKIE_NAMES) store.delete(name);
  }
}

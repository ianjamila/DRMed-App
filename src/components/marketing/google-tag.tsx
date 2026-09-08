"use client";

import Script from "next/script";
import { useCookieConsent } from "./cookie-consent";

// Extra destinations that Google attaches to this account's tag server-side.
//
// Loading gtag.js with id=AW-868551722 does NOT load only the Google Ads
// destination: the config Google serves for that id also lists a GA4 property
// and a Merchant Center stream (verified 2026-09-08 by grepping the served
// gtag.js). They are almost certainly Shopify-era leftovers, alongside the
// Google Shopping conversion actions the September 2026 audit found in the
// same account — nobody asked for a behavioural analytics stream on a clinic's
// website, and ADR-0004 says there isn't one.
//
// `ga-disable-<ID>` is Google's documented opt-out flag, checked before any
// hit is sent, so setting it here makes ADR-0004's "no GA4" a property of the
// code rather than a promise about an account setting someone could flip back.
// The CSP in next.config.ts blocks most of this traffic too, but not all of it
// — the GA4 hit to www.google.com rides the same host the conversion beacon
// needs — so the flag is the part that actually closes it.
//
// The durable fix is to unlink both destinations in Google Ads → Tools → Data
// manager → Google tag; see docs/google-ads-verification.md. Until that
// happens these ids are load-bearing, and if the clinic ever genuinely wants
// GA4, deleting the matching line here is the switch.
const UNWANTED_TAG_DESTINATIONS = ["G-2R14BG8YRD", "MC-ZYRJZLN5TE"] as const;

// Consent-gated Google tag (gtag.js), configured for the Google Ads account
// only. Under the site's opt-in model this component renders NOTHING — no
// script tag, no network request to Google, no _gcl_* cookies — until the
// visitor has actively accepted. Declining, or simply ignoring the banner,
// means the tag never loads at all.
//
// The sibling of <MetaPixel>, and gated identically. There is deliberately no
// <noscript> fallback: a visitor without JavaScript cannot be shown the consent
// banner and therefore cannot consent.
//
// Note the CSP in next.config.ts has to allow googletagmanager.com,
// googleadservices.com, doubleclick.net and google.com for any of this to
// reach Google — a blocked tag fails silently.
export function GoogleTag({ conversionId }: { conversionId: string }) {
  const { granted } = useCookieConsent();

  if (!granted) return null;

  return (
    <>
      {/*
        Declared before the loader below so the ga-disable flags are set before
        gtag.js can send anything. Calling gtag() ahead of the library loading
        is the documented pattern — the calls queue on dataLayer and replay.
      */}
      <Script id="google-tag-init" strategy="afterInteractive">
        {`
          ${UNWANTED_TAG_DESTINATIONS.map(
            (id) => `window['ga-disable-${id}'] = true;`,
          ).join("\n          ")}
          window.dataLayer = window.dataLayer || [];
          window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
          window.gtag('js', new Date());
          window.gtag('config', '${conversionId}', {
            // No Enhanced Conversions. Google's tag can hash and upload a
            // visitor's email/phone for better attribution; it is off and must
            // stay off (ADR-0004), the same rule ADR-0003 sets for Meta's
            // Advanced Matching.
            'allow_enhanced_conversions': false,
            // No remarketing or personalised-advertising signals. Conversion
            // measurement and Smart Bidding are unaffected; what this switches
            // off is building audiences out of people who browsed a clinic's
            // pages, which ADR-0003 and ADR-0004 both forbid for health.
            // Verifiable from outside: every request gtag makes carries npa=1.
            'allow_ad_personalization_signals': false
          });
        `}
      </Script>
      <Script
        id="google-tag-base"
        src={`https://www.googletagmanager.com/gtag/js?id=${conversionId}`}
        strategy="afterInteractive"
      />
    </>
  );
}

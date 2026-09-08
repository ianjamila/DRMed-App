"use client";

import type { AnchorHTMLAttributes } from "react";
import { metaTrack } from "@/lib/analytics/meta-pixel";
import { googleAdsConversion } from "@/lib/analytics/google-ads";

interface TrackedMessengerLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  contentName: string;
}

// Drop-in replacement for a plain <a href={SOCIAL.messenger}>. Fires a Meta
// "Contact" event (content_name identifies which inquiry it was) and a Google
// Ads "Messenger chat started" conversion before handing off to Messenger.
//
// Every Messenger entry point on the site routes through here — including the
// floating action button — so the conversion has exactly one call site.
//
// No delayed-navigation dance (the `event_callback` + `window.location` helper
// Google's console hands out). Every caller opens Messenger in a new tab, so
// this page is never torn down mid-beacon; and gtag.js sends over
// navigator.sendBeacon anyway, which survives unload.
export function TrackedMessengerLink({
  href,
  contentName,
  onClick,
  ...rest
}: TrackedMessengerLinkProps) {
  return (
    <a
      href={href}
      onClick={(e) => {
        metaTrack("Contact", { content_name: contentName });
        // contentName is deliberately not forwarded: which button was tapped
        // is Meta-side detail, and ADR-0004 keeps the Google payload empty.
        googleAdsConversion("messenger");
        onClick?.(e);
      }}
      {...rest}
    />
  );
}

"use client";

import type { AnchorHTMLAttributes } from "react";
import { metaTrack } from "@/lib/analytics/meta-pixel";
import { googleAdsConversion } from "@/lib/analytics/google-ads";

interface TrackedTelLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  // Page/section context for the fired event's content_category — e.g.
  // "footer", "contact_page", "physician_profile".
  label: string;
}

// Drop-in replacement for a plain <a href="tel:...">. Fires a Meta "Contact"
// event (content_name: call_click) and a Google Ads "Website call tap"
// conversion before the browser hands off to the phone dialer — click-only,
// no server round trip, so client Pixel/gtag is sufficient.
//
// label is deliberately not forwarded to Google (same rule as
// TrackedMessengerLink's contentName): it is Meta-side content_category
// detail, and ADR-0004 keeps the Google payload empty.
export function TrackedTelLink({ href, label, onClick, ...rest }: TrackedTelLinkProps) {
  return (
    <a
      href={href}
      onClick={(e) => {
        metaTrack("Contact", { content_name: "call_click", content_category: label });
        googleAdsConversion("callTap");
        onClick?.(e);
      }}
      {...rest}
    />
  );
}

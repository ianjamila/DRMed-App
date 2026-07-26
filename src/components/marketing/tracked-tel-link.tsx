"use client";

import type { AnchorHTMLAttributes } from "react";
import { metaTrack } from "@/lib/analytics/meta-pixel";

interface TrackedTelLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  // Page/section context for the fired event's content_category — e.g.
  // "footer", "contact_page", "physician_profile".
  label: string;
}

// Drop-in replacement for a plain <a href="tel:...">. Fires a Meta "Contact"
// event (content_name: call_click) before the browser hands off to the phone
// dialer — click-only, no server round trip, so client Pixel is sufficient.
export function TrackedTelLink({ href, label, onClick, ...rest }: TrackedTelLinkProps) {
  return (
    <a
      href={href}
      onClick={(e) => {
        metaTrack("Contact", { content_name: "call_click", content_category: label });
        onClick?.(e);
      }}
      {...rest}
    />
  );
}

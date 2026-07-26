"use client";

import type { AnchorHTMLAttributes } from "react";
import { metaTrack } from "@/lib/analytics/meta-pixel";

interface TrackedMessengerLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  contentName: string;
}

// Drop-in replacement for a plain <a href={SOCIAL.messenger}>. Fires a Meta
// "Contact" event (content_name identifies which inquiry it was) before
// handing off to Messenger.
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
        onClick?.(e);
      }}
      {...rest}
    />
  );
}

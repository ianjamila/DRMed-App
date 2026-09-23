"use client";

import { createContext, useContext, type ReactNode } from "react";
import Link from "next/link";
import { PAUSED_CTA_LABEL } from "@/lib/booking/online-booking-copy";

// Carries the admin's online-booking pause switch (booking_settings, 0153) from
// the marketing layout — which reads it once per render — down to every "Book"
// CTA, server- or client-rendered, without threading a prop through each page.
// Defaults to "not paused" so a CTA rendered outside the provider behaves as it
// always has.
const OnlineBookingPausedContext = createContext(false);

export function OnlineBookingProvider({
  paused,
  children,
}: {
  paused: boolean;
  children: ReactNode;
}) {
  return (
    <OnlineBookingPausedContext.Provider value={paused}>{children}</OnlineBookingPausedContext.Provider>
  );
}

export function useOnlineBookingPaused(): boolean {
  return useContext(OnlineBookingPausedContext);
}

// The visible text of a booking CTA: the normal label, or "Contact us to book"
// while online booking is paused. The link itself keeps pointing at /schedule,
// which shows the contact-reception notice while paused.
export function BookingCtaLabel({
  children,
  pausedLabel = PAUSED_CTA_LABEL,
}: {
  children: ReactNode;
  pausedLabel?: string;
}) {
  return <>{useOnlineBookingPaused() ? pausedLabel : children}</>;
}

// A card-style link whose accessible name mentions booking (the home services
// grid) — the aria-label has to change with the switch too, not just the text.
export function BookingAwareLink({
  href,
  label,
  pausedLabel,
  className,
  children,
}: {
  href: string;
  label: string;
  pausedLabel: string;
  className?: string;
  children: ReactNode;
}) {
  const paused = useOnlineBookingPaused();
  return (
    <Link href={href} aria-label={paused ? pausedLabel : label} className={className}>
      {children}
    </Link>
  );
}

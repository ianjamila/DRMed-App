"use client";

import { PhoneCall } from "lucide-react";
import { CONTACT, SOCIAL } from "@/lib/marketing/site";
import { telHref } from "@/lib/marketing/nap";
import { TrackedTelLink } from "@/components/marketing/tracked-tel-link";
import { TrackedMessengerLink } from "@/components/marketing/tracked-messenger-link";
import { useOnlineBookingPaused } from "@/components/marketing/online-booking-context";

// A thin site-wide strip above the marketing nav while an admin has paused
// online booking (booking_settings, 0153), so visitors learn how to book before
// they reach a "Book" button. Marketing pages only — the layout mounts it and
// hides it on /schedule, where the full notice already says the same thing.
export function BookingPausedStrip() {
  if (!useOnlineBookingPaused()) return null;
  return (
    <div
      role="region"
      aria-label="Online booking paused"
      className="bg-[color:var(--color-brand-navy)] text-white"
    >
      <p className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-2 text-center text-[13px] leading-snug sm:px-6 lg:px-8">
        <PhoneCall className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="font-semibold">Online booking is paused for now.</span>
        <span className="text-white/85">
          To book, call or text{" "}
          <TrackedTelLink
            href={telHref("mobile")}
            label="booking_paused_strip"
            className="font-semibold text-white underline underline-offset-2 hover:text-[color:var(--color-brand-cyan)]"
          >
            {CONTACT.phone.mobile}
          </TrackedTelLink>{" "}
          or{" "}
          <TrackedMessengerLink
            href={SOCIAL.messenger}
            contentName="booking_paused_strip"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-white underline underline-offset-2 hover:text-[color:var(--color-brand-cyan)]"
          >
            message us
          </TrackedMessengerLink>
          .
        </span>
      </p>
    </div>
  );
}

import type { ReactNode } from "react";
import { Clock, Mail, MapPin, MessageCircle, MessageSquareText, Phone, PhoneCall } from "lucide-react";
import { CONTACT, SOCIAL } from "@/lib/marketing/site";
import { telHref } from "@/lib/marketing/nap";
import { TrackedTelLink } from "@/components/marketing/tracked-tel-link";
import { TrackedMessengerLink } from "@/components/marketing/tracked-messenger-link";

// Shown in place of the booking form while an admin has paused online booking
// (booking_settings, 0153 — /staff/admin/settings/online-booking). Rendered by
// the public /schedule page and the portal's /portal/book.
//
// Only `context="public"` uses the tracked tel/Messenger wrappers (Meta Pixel +
// Google Ads events). The patient portal emits no marketing analytics at all
// (RA 10173) and neither does the staff portal, so "portal" and "preview" (the
// admin settings page) render plain links.
export function BookingPausedNotice({
  context,
  message,
  doctorName,
}: {
  context: "public" | "portal" | "preview";
  // Optional admin-written note (e.g. "Online booking returns on 1 October.").
  message: string | null;
  // Set when the visitor arrived from a physician's "Book" deep link.
  doctorName?: string | null;
}) {
  const Heading = context === "public" ? "h1" : "h2";
  const tracked = context === "public";
  const smsHref = `sms:${CONTACT.phone.mobileE164}`;

  const mobileLink = (children: ReactNode, className: string) =>
    tracked ? (
      <TrackedTelLink href={telHref("mobile")} label="booking_paused" className={className}>
        {children}
      </TrackedTelLink>
    ) : (
      <a href={telHref("mobile")} className={className}>
        {children}
      </a>
    );
  const landlineLink = (children: ReactNode, className: string) =>
    tracked ? (
      <TrackedTelLink href={telHref("landline")} label="booking_paused" className={className}>
        {children}
      </TrackedTelLink>
    ) : (
      <a href={telHref("landline")} className={className}>
        {children}
      </a>
    );
  const messengerLink = (children: ReactNode, className: string) =>
    tracked ? (
      <TrackedMessengerLink
        href={SOCIAL.messenger}
        contentName="booking_paused"
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {children}
      </TrackedMessengerLink>
    ) : (
      <a href={SOCIAL.messenger} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );

  const card =
    "group flex min-h-[76px] items-center gap-3.5 rounded-[16px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)] px-4 py-3.5 transition hover:border-[color:var(--color-brand-navy)] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]";
  const iconWrap =
    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-brand-navy)] text-white";
  const cardLabel = "block text-[12px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-ink-soft)]";
  const cardValue = "block text-[16px] font-bold text-[color:var(--color-brand-navy)]";

  return (
    <section
      aria-labelledby="booking-paused-heading"
      className="rounded-[24px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)] sm:p-10"
    >
      <p className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-[12.5px] font-bold text-amber-800 ring-1 ring-amber-200">
        <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
        Booking by phone or message for now
      </p>

      <Heading
        id="booking-paused-heading"
        className="mt-4 font-[family-name:var(--font-display)] text-[28px] leading-tight text-[color:var(--color-brand-navy)] sm:text-[34px]"
      >
        Online booking is paused for now
      </Heading>
      <p className="mt-3 max-w-[560px] text-[15.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
        Please contact our reception and we&apos;ll book your consultation, lab
        test, or home service for you. Call, text, or message us — whichever is
        easiest.
      </p>

      {doctorName ? (
        <p className="mt-3 text-[15px] text-[color:var(--color-ink-mid)]">
          Want to see <span className="font-semibold text-[color:var(--color-brand-navy)]">{doctorName}</span>?
          Just mention it when you reach us.
        </p>
      ) : null}

      {message ? (
        <div className="mt-5 rounded-[14px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)] px-4 py-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-ink-soft)]">
            A note from the clinic
          </p>
          <p className="mt-1 whitespace-pre-line text-[15px] text-[color:var(--color-ink)]">{message}</p>
        </div>
      ) : null}

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {mobileLink(
          <>
            <span className={iconWrap}>
              <Phone className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <span>
              <span className={cardLabel}>Call or text (mobile)</span>
              <span className={cardValue}>{CONTACT.phone.mobile}</span>
            </span>
          </>,
          card,
        )}
        {landlineLink(
          <>
            <span className={iconWrap}>
              <PhoneCall className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <span>
              <span className={cardLabel}>Call (landline)</span>
              <span className={cardValue}>{CONTACT.phone.landline}</span>
            </span>
          </>,
          card,
        )}
        {messengerLink(
          <>
            <span className={iconWrap}>
              <MessageCircle className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <span>
              <span className={cardLabel}>Facebook Messenger</span>
              <span className={cardValue}>Message us</span>
            </span>
          </>,
          card,
        )}
        <a href={`mailto:${CONTACT.email}`} className={card}>
          <span className={iconWrap}>
            <Mail className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <span>
            <span className={cardLabel}>Email</span>
            <span className={cardValue}>{CONTACT.email}</span>
          </span>
        </a>
      </div>

      <p className="mt-3 text-[13.5px] text-[color:var(--color-ink-soft)]">
        On your phone?{" "}
        <a
          href={smsHref}
          className="inline-flex items-center gap-1 font-semibold text-[color:var(--color-brand-cyan-text)] underline underline-offset-2"
        >
          <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
          Send us a text
        </a>
      </p>

      <div className="mt-6 space-y-2 border-t border-[color:var(--color-warm-line-soft)] pt-5 text-[14px] text-[color:var(--color-ink-mid)]">
        <p className="flex items-start gap-2">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-brand-navy)]" aria-hidden="true" />
          <span>
            Reception is open {CONTACT.hours}. Walk-ins are always welcome — no
            booking needed.
          </span>
        </p>
        <p className="flex items-start gap-2">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-brand-navy)]" aria-hidden="true" />
          <span>{CONTACT.address.full}</span>
        </p>
      </div>
    </section>
  );
}

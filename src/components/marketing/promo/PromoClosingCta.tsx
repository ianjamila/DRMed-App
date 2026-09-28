import { ArrowRight, MessageCircle } from "lucide-react";
import { PillLink, pillLinkClassName } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { SOCIAL } from "@/lib/marketing/site";
import { BookingCtaLabel } from "@/components/marketing/online-booking-context";
import { TrackedMessengerLink } from "@/components/marketing/tracked-messenger-link";

/**
 * Closing CTA band for campaign landing pages — navy field with a booking pill
 * (/schedule) and the Messenger deep-link, mirroring the service-detail CTA band.
 */
export function PromoClosingCta({
  title,
  body,
  primaryLabel,
}: {
  title: string;
  body: string;
  primaryLabel: string;
}) {
  return (
    <section className="bg-[color:var(--color-brand-navy)] py-16 text-white sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(26px,4vw,40px)] font-normal leading-[1.1]">
            {title}
          </h2>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-white/75">
            {body}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <PillLink href="/schedule" variant="cyan">
              <BookingCtaLabel>{primaryLabel}</BookingCtaLabel>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </PillLink>
            <TrackedMessengerLink
              href={SOCIAL.messenger}
              contentName={`promo_closing_cta_${primaryLabel}`}
              target="_blank"
              rel="noopener noreferrer"
              className={pillLinkClassName({ variant: "lineOnDark" })}
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              Message Us on Messenger
            </TrackedMessengerLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

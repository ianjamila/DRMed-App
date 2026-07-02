import type { ReactNode } from "react";
import { ArrowRight, MessageCircle } from "lucide-react";
import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { SOCIAL } from "@/lib/marketing/site";

interface PromoCta {
  label: string;
  href: string;
}

/**
 * Campaign landing-page hero — the shared {@link SectionHeading} lockup (same
 * warm field as PageHero) plus the campaign CTA row: a primary booking pill,
 * optional secondary internal links, and the Messenger deep-link from SOCIAL.
 */
export function PromoHero({
  eyebrow,
  title,
  accent,
  description,
  primary,
  extraLinks = [],
  messengerLabel = "Message Us",
}: {
  eyebrow?: string;
  title: string;
  /** Optional italic-cyan accent fragment appended to the title. */
  accent?: string;
  description: ReactNode;
  /** Primary CTA — always an internal route (normally /schedule). */
  primary: PromoCta;
  /** Optional extra internal links rendered between the primary and Messenger CTAs. */
  extraLinks?: readonly PromoCta[];
  messengerLabel?: string;
}) {
  return (
    <section className="border-b border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)]">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 md:py-20 lg:px-8">
        <SectionHeading
          as="h1"
          eyebrow={eyebrow}
          title={title}
          accent={accent}
          description={description}
        />
        <div className="mt-8 flex flex-wrap gap-3">
          <PillLink href={primary.href} variant="cyan">
            {primary.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </PillLink>
          {extraLinks.map((link) => (
            <PillLink key={link.href} href={link.href} variant="line">
              {link.label}
            </PillLink>
          ))}
          <PillLink
            href={SOCIAL.messenger}
            variant="line"
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            {messengerLabel}
          </PillLink>
        </div>
      </div>
    </section>
  );
}

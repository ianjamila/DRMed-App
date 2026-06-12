import { SectionHeading } from "@/components/marketing/ui";

interface PageHeroProps {
  eyebrow?: string;
  title: string;
  /** Optional italic-cyan accent fragment appended to the title. */
  accent?: string;
  description?: string;
}

/**
 * Shared subpage hero — warm field, eyebrow kicker, Instrument-Serif headline.
 * Used across /packages, /physicians, /about, /contact, /all-services, etc.
 */
export function PageHero({ eyebrow, title, accent, description }: PageHeroProps) {
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
      </div>
    </section>
  );
}

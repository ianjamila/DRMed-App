import { ChevronDown } from "lucide-react";
import { SectionHeading } from "@/components/marketing/ui";
import type { FaqItem } from "@/lib/marketing/faq";

/**
 * Campaign FAQ section — the homepage Faq markup (details/summary accordion)
 * parameterized so each promo landing page can carry its own question set.
 * Pair with faqPageLd(items) on the page for the matching FAQPage JSON-LD.
 */
export function PromoFaq({ items }: { items: readonly FaqItem[] }) {
  return (
    <section className="py-[72px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Good to Know"
          title="Questions,"
          accent="answered."
          className="mb-7"
        />

        <div className="mx-auto mt-7 max-w-3xl space-y-3">
          {items.map(({ question, answer }) => (
            <details
              key={question}
              className="group rounded-[16px] border border-[color:var(--color-warm-line-soft)] bg-white px-6 py-1 shadow-[var(--shadow-warm-sm)] open:shadow-[var(--shadow-warm-lg)]"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-semibold text-[color:var(--color-brand-navy)] [&::-webkit-details-marker]:hidden">
                {question}
                <ChevronDown
                  className="h-5 w-5 shrink-0 text-[color:var(--color-brand-cyan)] transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="pb-4 text-sm leading-relaxed text-[color:var(--color-ink-mid)]">
                {answer}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

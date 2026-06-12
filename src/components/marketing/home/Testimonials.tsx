// PLACEHOLDER/VERIFY: testimonials lifted from public FB/Google reviews — obtain permission to feature names before launch (see DESIGN-NOTES.md, C19).

import { SectionHeading } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";

const TESTIMONIALS = [
  {
    quote:
      "Excellent service!!! They attended to me as soon as I got in — no waiting time (considering it was a Saturday), and everything was done in a short amount of time. The staff were highly efficient and very professional. Prices are also reasonable! I received my complete blood chemistry results the next day. Would very much recommend!",
    name: "Sassyy Llabres",
    source: "via Facebook · July 2024",
  },
  {
    quote:
      "Mabilis ang pagprocess ng mga medical results at mabilis din ang pagasikaso nila sa mga dumadating na patients. Bukod sa mabilis ang pagprocess ay maayos din ang pagkuha ng aking laboratory. Mabait at approachable din ang mga nurse dito. Thank you po sa inyong maayos na serbisyo.",
    name: "Lei Malana",
    source: "via Facebook · August 2024",
  },
  {
    quote:
      "Everyone is very friendly and professional, organized and not crowded looking. recommended din sa bilis ng labtests",
    name: "April Veluz",
    source: "via Google Reviews · January 2021",
  },
] as const;

export function Testimonials() {
  return (
    <section className="py-[72px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Kind Words"
          title="From our"
          accent="patients."
          description="Real reviews from our Facebook page and Google Reviews."
        />

        <div className="mt-10 grid grid-cols-1 gap-[14px] md:grid-cols-3">
          {TESTIMONIALS.map((t) => (
            <Reveal key={t.name}>
              <article className="flex flex-col rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-[26px] shadow-[var(--shadow-warm-sm)]">
                {/* Big serif quote mark */}
                <span
                  aria-hidden="true"
                  className="font-[family-name:var(--font-display)] text-[40px] leading-none text-[color:var(--color-brand-cyan)]"
                >
                  &ldquo;
                </span>

                <p className="mt-2 flex-1 text-sm leading-relaxed text-[color:var(--color-ink-mid)]">
                  {t.quote}
                </p>

                <div className="mt-[18px] border-t border-[color:var(--color-warm-line-soft)] pt-[14px]">
                  <b className="block font-bold text-[color:var(--color-brand-navy)]">
                    {t.name}
                  </b>
                  <span className="text-xs text-[color:var(--color-ink-soft)]">
                    {t.source}
                  </span>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

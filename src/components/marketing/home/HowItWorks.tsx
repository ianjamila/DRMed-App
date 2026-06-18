import { CalendarCheck, Stethoscope, FileDown, type LucideIcon } from "lucide-react";
import { SectionHeading } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { CONTACT } from "@/lib/marketing/site";

interface Step {
  n: string;
  icon: LucideIcon;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    n: "01",
    icon: CalendarCheck,
    title: "Book or walk in",
    body: "Reserve a slot online in two minutes — or just walk in for packages and most lab tests, Monday to Saturday.",
  },
  {
    n: "02",
    icon: Stethoscope,
    title: "Visit the clinic",
    body: `${CONTACT.address.line2}, ${CONTACT.address.city}. Present your ID and HMO card — our staff handles the rest.`,
  },
  {
    n: "03",
    icon: FileDown,
    title: "Results in 24 hours",
    body: "Most tests release same-day. View and download your signed results online, anytime, via the patient portal.",
  },
];

/**
 * "How It Works" 3-step explainer section.
 * Server component — each card scrolls in via <Reveal>.
 */
export function HowItWorks() {
  return (
    <section className="py-[72px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="How It Works"
          title="Three steps to"
          accent="peace of mind."
          className="mb-9"
        />

        <div className="grid grid-cols-1 gap-[14px] md:grid-cols-3">
          {STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <Reveal key={step.n}>
                <div className="relative rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)]">
                  {/* Icon chip — absolute top-right */}
                  <span className="absolute right-[22px] top-[22px] grid h-[42px] w-[42px] place-items-center rounded-[13px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>

                  {/* Step number — decorative faded numeral (order conveyed by DOM + heading) */}
                  <span
                    aria-hidden="true"
                    className="font-[family-name:var(--font-display)] text-[28px] italic leading-none text-[color:var(--color-brand-cyan)] opacity-50"
                  >
                    {step.n}
                  </span>

                  {/* Card body */}
                  <h3 className="mt-[14px] text-[17px] font-bold text-[color:var(--color-brand-navy)]">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-[14px] leading-[1.55] text-[color:var(--color-ink-soft)]">
                    {step.body}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

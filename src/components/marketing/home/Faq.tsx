// PLACEHOLDER/VERIFY: FAQ answers drafted by design, NOT clinically reviewed — confirm with clinic ops before launch (see DESIGN-NOTES.md, C19).

import { ChevronDown } from "lucide-react";
import { SectionHeading } from "@/components/marketing/ui";

const FAQ_ITEMS = [
  {
    question: "Do I need to fast before my test?",
    answer:
      "Blood sugar (FBS) and lipid tests need 8–10 hours of fasting — water is fine. Most other tests don't require it. Unsure? Message us before your visit and we'll confirm.",
  },
  {
    question: "Can I use my HMO?",
    answer:
      "Yes — we're accredited with 10 major HMO providers. Bring your HMO card and a valid ID; reception processes your LOA and covered services are cashless.",
  },
  {
    question: "How do I get my results?",
    answer:
      "Most tests release within 24 hours. We email you when they're ready, and you can view and download the official signed PDF anytime in the patient portal using your DRM-ID and the Secure PIN on your receipt.",
  },
  {
    question: "Do you see children?",
    answer:
      "Yes — we have pediatricians on staff. Schedules can change, so kindly call or message us first to confirm availability before bringing your little one in.",
  },
  {
    question: "Can you come to my home or office?",
    answer:
      "Yes — our team comes to your home or office for lab sample collection (subject to availability). Consultations are done in the clinic, though some doctors offer online consultations by appointment. Book online or message us, and reception will call to confirm the schedule and fee.",
  },
] as const;

export function Faq() {
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
          {FAQ_ITEMS.map(({ question, answer }) => (
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

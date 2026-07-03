import {
  ArrowRight,
  Banknote,
  CalendarCheck,
  ClipboardList,
  CreditCard,
  FileCheck,
  House,
  ShieldCheck,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";
import { PillLink, SectionHeading } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import {
  PromoHero,
  PromoProofRow,
  PromoIconCard,
  PromoFaq,
  PromoClosingCta,
  PromoJsonLd,
  type ProofItem,
} from "@/components/marketing/promo";
import { getServiceByCode } from "@/lib/marketing/services";
import { formatPhp } from "@/lib/marketing/format";
import { pageMetadata } from "@/lib/marketing/metadata";
import { AREAS_SERVED } from "@/lib/marketing/site";
import type { FaqItem } from "@/lib/marketing/faq";

export const metadata = pageMetadata({
  title: "Home Service Lab Tests — The Lab That Comes to You",
  description:
    "Home blood draws and sample collection by licensed DRMed medtechs at your home or office in Quezon City & nearby. Results in your patient portal within 24 hours.",
  path: "/promo/we-come-to-you",
});

// Live DRMed prices from the services table; 5 min cache — admin price edits
// on /staff/admin/prices land within 5 min (matches the physicians page).
export const revalidate = 300;

interface Step {
  n: string;
  icon: LucideIcon;
  title: string;
  body: string;
}

const STEPS: readonly Step[] = [
  {
    n: "01",
    icon: ClipboardList,
    title: "Choose your tests",
    body: "Pick the tests you need — or ask us and we'll help you figure out what's required.",
  },
  {
    n: "02",
    icon: CalendarCheck,
    title: "Pick a date and time",
    body: "Same-day slots available. Reception calls to confirm your schedule and the fee for your location.",
  },
  {
    n: "03",
    icon: House,
    title: "We visit you",
    body: "Our licensed medtech visits your home or office and collects your samples — gentle and quick.",
  },
  {
    n: "04",
    icon: FileCheck,
    title: "Results within 24 hours",
    body: "Signed PDF results land in your patient portal within 24 hours — you get an alert the moment they're ready.",
  },
];

// Home service covers sample collection only — X-ray, ultrasound & ECG are
// in-clinic. Never imply otherwise.
const FAQ: readonly FaqItem[] = [
  {
    question: "What can be done at home?",
    answer:
      "Home service covers blood, urine, and stool sample collection by a licensed DRMed medtech. X-ray, ultrasound, and ECG are done at the clinic — we'll gladly help you schedule those for a visit.",
  },
  {
    question: "Do I need to fast?",
    answer:
      "Fasting depends on the test: blood sugar (FBS) needs 8–10 hours and lipid profile needs 10–12 hours — water is fine throughout. Most other tests don't require it. Unsure? Message us before your visit and we'll confirm.",
  },
  {
    question: "What areas do you cover?",
    answer: `We serve Quezon City and nearby areas, including ${AREAS_SERVED.join(", ")}. Outside these? Message us and we'll confirm if we can reach you.`,
  },
  {
    question: "How do I pay?",
    answer:
      "Cash, GCash, Maya, and cards are accepted. Reception confirms your total — test prices plus the home-service fee for your location — when they call to confirm your booking.",
  },
];

const PROOF: readonly ProofItem[] = [
  { icon: ShieldCheck, label: "DOH-compliant clinic & lab" },
  { icon: Stethoscope, label: "Licensed medtechs" },
  { icon: FileCheck, label: "Signed PDF results" },
  { icon: CreditCard, label: "10+ HMOs accepted" },
];

export default async function WeComeToYouPage() {
  // Live home-service base fee — never hardcoded. Location-based tiers exist in
  // the services table; the base row carries the "from" price. If unavailable,
  // the fee note keeps its copy without the figure.
  const homeService = await getServiceByCode("HOME_SERVICE");

  return (
    <>
      <PromoJsonLd
        name="We Come to You"
        path="/promo/we-come-to-you"
        faq={FAQ}
      />

      <PromoHero
        eyebrow="Home Service"
        title="The lab that comes"
        accent="to you."
        description="Home blood draws and sample collection by licensed DRMed medtechs — at your home or office in Quezon City & nearby. Results in your patient portal within 24 hours."
        primary={{ label: "Book a Home Visit", href: "/schedule" }}
      />

      <PromoProofRow items={PROOF} />

      {/* How it works */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="How It Works"
              title="Four steps,"
              accent="zero waiting rooms."
              className="mb-9"
            />
          </Reveal>

          <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <Reveal key={step.n} delay={i * 0.06}>
                <PromoIconCard
                  icon={step.icon}
                  title={step.title}
                  body={step.body}
                  step={step.n}
                />
              </Reveal>
            ))}
          </div>

          {/* Fee note */}
          <Reveal delay={0.1}>
            <div className="mt-10 flex items-start gap-4 rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)] p-6">
              <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                <Banknote className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="text-sm leading-relaxed text-[color:var(--color-ink-mid)]">
                {homeService ? (
                  <>
                    Home-service fee starts at{" "}
                    <strong className="text-[color:var(--color-brand-navy)]">
                      {formatPhp(homeService.price_php)}
                    </strong>{" "}
                    (final fee depends on your location — confirmed at booking)
                    on top of regular test prices. No rush fee on results.
                  </>
                ) : (
                  <>
                    The home-service fee depends on your location — confirmed at
                    booking — on top of regular test prices. No rush fee on
                    results.
                  </>
                )}
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Corporate onsite block */}
      <section className="bg-[color:var(--color-warm-sand)] py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="Corporate Onsite"
              title="Screening a"
              accent="whole team?"
              description="Our mobile clinic runs PEME, APE and executive panels onsite — medtechs, equipment, and consolidated results included. Serving Quezon City & Metro Manila."
            />
          </Reveal>
          <Reveal delay={0.1}>
            <div className="mt-8">
              <PillLink href="/contact" variant="navy">
                Get a Corporate Quote{" "}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </PillLink>
            </div>
          </Reveal>
        </div>
      </section>

      <PromoFaq items={FAQ} />

      <PromoClosingCta
        title="Skip the queue entirely."
        body="Book a home visit in 2 minutes or message us on Messenger — Mon–Sat, 8am–5pm. Serving Quezon City & nearby."
        primaryLabel="Book a Home Visit"
      />
    </>
  );
}

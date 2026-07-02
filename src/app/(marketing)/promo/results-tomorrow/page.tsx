import {
  BellRing,
  ClipboardList,
  CreditCard,
  Droplets,
  FileCheck,
  ScanLine,
  ShieldCheck,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import { SectionHeading } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import {
  PromoHero,
  PromoProofRow,
  PromoFaq,
  PromoClosingCta,
  type ProofItem,
} from "@/components/marketing/promo";
import { JsonLd } from "@/components/marketing/json-ld";
import { breadcrumbLd, faqPageLd } from "@/lib/marketing/structured-data";
import { getServiceByCode } from "@/lib/marketing/services";
import { formatPhp } from "@/lib/marketing/format";
import { pageMetadata } from "@/lib/marketing/metadata";
import type { FaqItem } from "@/lib/marketing/faq";

export const metadata = pageMetadata({
  title: "Results in 24 Hours — No Rush Fee",
  description:
    "Lab tests, X-ray & ECG at DRMed Clinic and Laboratory, Quezon City — most results out the same day, all within 24 hours, at no extra charge. Book online or walk in.",
  path: "/promo/results-tomorrow",
});

// Live data — admin price changes on /staff/admin/prices reflect here on next
// request because DRMed prices are read directly from the services table.
export const dynamic = "force-dynamic";

interface SpeedItem {
  icon: LucideIcon;
  title: string;
  body: string;
}

// Honest turnaround expectations per the campaign brief — "most same-day, all
// within 24 hours", never a specific hour.
const SPEED_ITEMS: readonly SpeedItem[] = [
  {
    icon: Droplets,
    title: "Routine blood tests & urinalysis",
    body: "Usually released the same day.",
  },
  {
    icon: ScanLine,
    title: "Digital X-ray",
    body: "Read by our radiologist within hours.",
  },
  {
    icon: ClipboardList,
    title: "Full packages (APE, PEME, executive)",
    body: "Complete within 24 hours.",
  },
  {
    icon: BellRing,
    title: "The moment it's ready",
    body: "You get an alert the moment your signed PDF lands in your patient portal.",
  },
];

const FAQ: readonly FaqItem[] = [
  {
    question: "When exactly will my results be ready?",
    answer:
      "Most routine tests are released the same day, and everything is out within 24 hours — we don't promise a specific hour, but we email you the moment your signed PDF is ready in the patient portal, so you never have to call and ask.",
  },
  {
    question: "Do I need to fast?",
    answer:
      "Fasting depends on the test: blood sugar (FBS) needs 8–10 hours, lipid profile needs 10–12 hours, and whole abdomen ultrasound needs 6–8 hours — water is fine throughout. Most other tests don't require it. Unsure? Message us before your visit and we'll confirm.",
  },
  {
    question: "Can someone else claim my results?",
    answer:
      "Your results live in your private patient portal, protected by your DRM-ID and the Secure PIN printed on your receipt — only someone with both can view them. Need a printed copy claimed at the clinic by someone else? Message us first so reception can guide you through the requirements.",
  },
  {
    question: "Walk-in or appointment?",
    answer:
      "Both work. Reserve a slot online in two minutes, or just walk in for packages and most lab tests — Monday to Saturday, 8:00 AM to 5:00 PM. Booking ahead keeps your wait short.",
  },
];

const PROOF: readonly ProofItem[] = [
  { icon: ShieldCheck, label: "DOH-compliant clinic & lab" },
  { icon: FileCheck, label: "Signed PDF results" },
  { icon: Smartphone, label: "Secure patient portal" },
  { icon: CreditCard, label: "10+ HMOs accepted" },
];

export default async function ResultsTomorrowPage() {
  // Live DRMed price — never hardcoded. If the package is unavailable the
  // price clause is simply omitted.
  const ape = await getServiceByCode("ANNUAL_PHYSICAL_EXAM");

  return (
    <>
      <JsonLd
        data={[
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: "Results Tomorrow", path: "/promo/results-tomorrow" },
          ]),
          faqPageLd(FAQ),
        ]}
      />

      <PromoHero
        eyebrow="DRMed Clinic and Laboratory"
        title="Your results in 24 hours."
        accent="No rush fee."
        description={
          <>
            Lab tests, X-ray &amp; ECG at DRMed Clinic &amp; Laboratory, Quezon
            City — most results out the same day, all within 24 hours.
            {ape ? <> APE &amp; Pre-Employment {formatPhp(ape.price_php)}.</> : null}
          </>
        }
        primary={{ label: "Book Appointment", href: "/schedule" }}
      />

      <PromoProofRow items={PROOF} />

      {/* "How fast is fast?" */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="Turnaround Times"
              title="How fast is"
              accent="fast?"
              className="mb-9"
            />
          </Reveal>

          <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
            {SPEED_ITEMS.map((item, i) => {
              const Icon = item.icon;
              return (
                <Reveal key={item.title} delay={i * 0.06}>
                  <div className="flex h-full flex-col rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)]">
                    <span className="grid h-[42px] w-[42px] place-items-center rounded-[13px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <h3 className="mt-4 text-[17px] font-bold text-[color:var(--color-brand-navy)]">
                      {item.title}
                    </h3>
                    <p className="mt-2 text-[14px] leading-[1.55] text-[color:var(--color-ink-soft)]">
                      {item.body}
                    </p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* "No rush fee" strip */}
      <section className="bg-[color:var(--color-warm-sand)] py-14 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="No Rush Fee"
              title="Elsewhere, “rush” results can cost ~50% extra."
              accent="At DRMed, fast is the default — one price, no surcharge."
              headingClassName="text-[clamp(24px,3.5vw,36px)]"
            />
          </Reveal>
        </div>
      </section>

      <PromoFaq items={FAQ} />

      <PromoClosingCta
        title="Deadline coming up?"
        body="Book in 2 minutes or message us on Messenger — Mon–Sat, 8am–5pm. Congressional Ave, Quezon City."
        primaryLabel="Book Appointment"
      />
    </>
  );
}

import { ArrowRight, CreditCard, FileCheck, ShieldCheck, Users } from "lucide-react";
import { PillLink, SectionHeading } from "@/components/marketing/ui";
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
  title: "Hospital-Grade Tests at Clinic Prices",
  description:
    "Lab tests, X-ray, ECG, and full checkups at DRMed Clinic and Laboratory, Quezon City — up to 50% less than hospitals, results in 24 hours. 10+ HMOs accepted.",
  path: "/promo/beat-the-hospital-price",
});

// Live data — admin price changes on /staff/admin/prices reflect here on next
// request because DRMed prices are read directly from the services table.
export const dynamic = "force-dynamic";

const FAQ: readonly FaqItem[] = [
  {
    question: "Do I need to fast before my test?",
    answer:
      "Fasting depends on the test: blood sugar (FBS) needs 8–10 hours, lipid profile needs 10–12 hours, and whole abdomen ultrasound needs 6–8 hours — water is fine throughout. Most other tests don't require it. Unsure? Message us before your visit and we'll confirm.",
  },
  {
    question: "Can I use my HMO?",
    answer:
      "Yes — we're accredited with 10+ major HMO providers. Bring your HMO card and a valid ID; reception processes your LOA and covered services are cashless.",
  },
  {
    question: "How fast are results?",
    answer:
      "Most tests release within 24 hours — many the same day. We email you when they're ready, and you can view and download the official signed PDF anytime in the patient portal using your DRM-ID and the Secure PIN on your receipt.",
  },
  {
    question: "Walk-in or appointment?",
    answer:
      "Both work. Reserve a slot online in two minutes, or just walk in for packages and most lab tests — Monday to Saturday, 8:00 AM to 5:00 PM. Booking ahead keeps your wait short.",
  },
];

const PROOF: readonly ProofItem[] = [
  { icon: ShieldCheck, label: "DOH-compliant clinic & lab" },
  { icon: Users, label: "20 physicians, 14 specialties" },
  { icon: CreditCard, label: "10+ HMOs accepted" },
  { icon: FileCheck, label: "Signed PDF results" },
];

export default async function BeatTheHospitalPricePage() {
  // Live DRMed prices — never hardcoded. Hospital figures below are static
  // competitor comparisons from the campaign brief.
  const [exec, ape] = await Promise.all([
    getServiceByCode("EXECUTIVE_PACKAGE_STANDARD"),
    getServiceByCode("ANNUAL_PHYSICAL_EXAM"),
  ]);

  const comparisonRows = [
    {
      label: "Executive checkup",
      drmed: exec ? formatPhp(exec.price_php) : "Inquire",
      hospital: "₱12,000–25,000",
    },
    {
      label: "Annual physical exam",
      drmed: ape ? formatPhp(ape.price_php) : "Inquire",
      hospital: "from ~₱2,500",
    },
    { label: "Results", drmed: "24h / same-day", hospital: "often 3–7 days" },
    { label: "Queue", drmed: "minimal", hospital: "long" },
  ];

  return (
    <>
      <JsonLd
        data={[
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: "Beat the Hospital Price", path: "/promo/beat-the-hospital-price" },
          ]),
          faqPageLd(FAQ),
        ]}
      />

      <PromoHero
        eyebrow="DRMed Clinic and Laboratory"
        title="Hospital-grade tests. Clinic prices."
        accent="Results in 24 hours."
        description="Lab tests, X-ray, ECG, and full checkups at DRMed Clinic & Laboratory, Quezon City — up to 50% less than hospitals. 10+ HMOs accepted."
        primary={{ label: "Book Appointment", href: "/schedule" }}
      />

      <PromoProofRow items={PROOF} />

      {/* "vs Hospital" comparison */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="DRMed vs Hospital"
              title="Same tests. Same standards."
              accent="A fraction of the price."
              className="mb-8"
            />
          </Reveal>

          <Reveal delay={0.08}>
            <div className="overflow-x-auto rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white shadow-[var(--shadow-warm-sm)]">
              <table className="w-full min-w-[480px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[color:var(--color-warm-line-soft)]">
                    <th scope="col" className="px-5 py-4 font-bold text-[color:var(--color-ink-soft)]">
                      <span className="sr-only">Comparison</span>
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-4 font-[family-name:var(--font-display)] text-lg font-normal italic text-[color:var(--color-brand-cyan-text)]"
                    >
                      DRMed
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-4 font-[family-name:var(--font-display)] text-lg font-normal text-[color:var(--color-ink-soft)]"
                    >
                      Hospital
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map((row) => (
                    <tr
                      key={row.label}
                      className="border-b border-[color:var(--color-warm-line-soft)] last:border-b-0"
                    >
                      <th
                        scope="row"
                        className="px-5 py-4 font-semibold text-[color:var(--color-brand-navy)]"
                      >
                        {row.label}
                      </th>
                      <td className="px-5 py-4 font-bold text-[color:var(--color-brand-cyan-text)]">
                        {row.drmed}
                      </td>
                      <td className="px-5 py-4 text-[color:var(--color-ink-soft)]">
                        {row.hospital}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>

          <Reveal delay={0.12}>
            <p className="mt-4 text-xs leading-relaxed text-[color:var(--color-ink-soft)]">
              &ldquo;Up to 50% less&rdquo; is based on comparing DRMed&apos;s executive
              packages with typical private-hospital executive checkup rates
              (₱12,000–25,000). Hospital figures are indicative; prices and
              inclusions may change without prior notice.
            </p>
          </Reveal>

          <Reveal delay={0.15}>
            <div className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)] px-6 py-5">
              <p className="text-sm text-[color:var(--color-ink-mid)]">
                Want the full list of packages and prices?
              </p>
              <PillLink href="/packages" variant="navy" size="sm">
                Packages &amp; Prices <ArrowRight className="h-[18px] w-[18px]" aria-hidden="true" />
              </PillLink>
            </div>
          </Reveal>
        </div>
      </section>

      <PromoFaq items={FAQ} />

      <PromoClosingCta
        title="Ready to skip the hospital queue?"
        body="Book in 2 minutes or message us on Messenger — Mon–Sat, 8am–5pm. Congressional Ave, Quezon City."
        primaryLabel="Book Appointment"
      />
    </>
  );
}

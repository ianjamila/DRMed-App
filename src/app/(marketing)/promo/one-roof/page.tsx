import {
  ArrowRight,
  Baby,
  Check,
  CreditCard,
  FileCheck,
  FlaskConical,
  HeartPulse,
  Route,
  ShieldCheck,
  Stethoscope,
  Users,
  type LucideIcon,
} from "lucide-react";
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
import { getServiceByCode, type PublicService } from "@/lib/marketing/services";
import { formatPhp } from "@/lib/marketing/format";
import { pageMetadata } from "@/lib/marketing/metadata";
import type { FaqItem } from "@/lib/marketing/faq";

export const metadata = pageMetadata({
  title: "One Roof: Full Lab + 20 Specialist Physicians",
  description:
    "Lab tests, X-ray, ultrasound & ECG at DRMed Clinic and Laboratory, Quezon City — with 20 physicians across 14 specialties in the same building, so an abnormal result never leaves you stranded.",
  path: "/promo/one-roof",
});

// Live data — admin price changes on /staff/admin/prices reflect here on next
// request because DRMed prices are read directly from the services table.
export const dynamic = "force-dynamic";

interface PathStep {
  n: string;
  title: string;
  body: string;
}

const PATH_STEPS: readonly PathStep[] = [
  {
    n: "01",
    title: "Get tested",
    body: "Results in 24 hours, most same-day — signed PDFs in your patient portal.",
  },
  {
    n: "02",
    title: "Something flagged?",
    body: "Book the right specialist the same week — cardiologist, diabetologist, nephrologist & more.",
  },
  {
    n: "03",
    title: "Same building",
    body: "No referral needed, and your records are already on file.",
  },
];

interface RosterGroup {
  icon: LucideIcon;
  title: string;
  body: string;
}

// Real groups from the live physician roster — 20 physicians, 14 specialties.
const ROSTER_GROUPS: readonly RosterGroup[] = [
  {
    icon: Users,
    title: "OB-GYN & Family Medicine",
    body: "Women's health, general consults, checkup follow-ups.",
  },
  {
    icon: Baby,
    title: "Pediatrics",
    body: "Well-baby checks, vaccines, school requirements.",
  },
  {
    icon: HeartPulse,
    title: "Internal Medicine subspecialties",
    body: "Cardiology, pulmonology, gastroenterology, oncology, diabetology, nephrology.",
  },
  {
    icon: Stethoscope,
    title: "ENT, Ophthalmology, Radiology, Surgery, Psychiatry",
    body: "Rounding out 14 specialties under one roof.",
  },
];

const FAQ: readonly FaqItem[] = [
  {
    question: "Can I book a specific doctor?",
    answer:
      "Yes — browse specialist schedules on our physicians page, then book online or message us to reserve with a specific doctor. Schedules can change, so we'll confirm before your visit.",
  },
  {
    question: "Do I need a referral?",
    answer:
      "No referral needed — you can book any of our specialists directly, whether it's a first consult or a follow-up on a lab result.",
  },
  {
    question: "Can I use my HMO for consults?",
    answer:
      "We're accredited with 10+ major HMO providers, and coverage depends on your plan. Bring your HMO card and a valid ID; reception processes your LOA and covered consults and tests are cashless.",
  },
  {
    question: "How fast are results?",
    answer:
      "Most tests release within 24 hours — many the same day. We email you when they're ready, and you can view and download the official signed PDF anytime in the patient portal using your DRM-ID and the Secure PIN on your receipt.",
  },
];

const PROOF: readonly ProofItem[] = [
  { icon: ShieldCheck, label: "DOH-compliant clinic & lab" },
  { icon: Users, label: "20 physicians, 14 specialties" },
  { icon: CreditCard, label: "10+ HMOs accepted" },
  { icon: FileCheck, label: "Signed PDF results" },
];

// Executive package tier rows — inclusions per the campaign brief, verified
// against the live services catalog. Column prices are fetched live below.
const TIER_ROWS: readonly { label: string; tiers: [boolean, boolean, boolean] }[] = [
  {
    label:
      "Consult & PE, CBC, urinalysis, fecalysis, blood chemistry, lipid profile, HbA1c, chest X-ray, 12-lead ECG",
    tiers: [true, true, true],
  },
  {
    label: "Thyroid panel (FT3, FT4, TSH) + whole-abdomen ultrasound",
    tiers: [false, true, true],
  },
  {
    label:
      "Extended chemistry + cancer markers (CEA; PSA men's / Pap smear women's)",
    tiers: [false, false, true],
  },
];

function tierPrice(service: PublicService | null): string {
  return service ? formatPhp(service.price_php) : "Inquire";
}

export default async function OneRoofPage() {
  // Live DRMed prices — never hardcoded. The two Deluxe variants share a price;
  // either row can carry the column.
  const [execStandard, execComprehensive, deluxeMens, deluxeWomens] =
    await Promise.all([
      getServiceByCode("EXECUTIVE_PACKAGE_STANDARD"),
      getServiceByCode("EXECUTIVE_PACKAGE_COMPREHENSIVE"),
      getServiceByCode("EXECUTIVE_PACKAGE_DELUXE_MEN_S"),
      getServiceByCode("EXECUTIVE_PACKAGE_DELUXE_WOMEN_S"),
    ]);
  const deluxe = deluxeMens ?? deluxeWomens;

  const tierColumns = [
    { name: "Standard", price: tierPrice(execStandard) },
    { name: "Comprehensive", price: tierPrice(execComprehensive) },
    { name: "Deluxe (Men's / Women's)", price: tierPrice(deluxe) },
  ];

  return (
    <>
      <JsonLd
        data={[
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: "One Roof", path: "/promo/one-roof" },
          ]),
          faqPageLd(FAQ),
        ]}
      />

      <PromoHero
        eyebrow="More Than a Lab"
        title="One roof. Full lab."
        accent="20 doctors."
        description="Lab tests, X-ray, ultrasound & ECG at DRMed Clinic & Laboratory, Quezon City — with 20 physicians across 14 specialties in the same building, so an abnormal result never leaves you stranded."
        primary={{ label: "Book Your Checkup", href: "/schedule" }}
        extraLinks={[{ label: "See Specialist Schedules", href: "/physicians" }]}
      />

      <PromoProofRow items={PROOF} />

      {/* What happens after your result */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="After Your Result"
              title="A lab gives you numbers."
              accent="We give you answers."
              className="mb-9"
            />
          </Reveal>

          <div className="grid grid-cols-1 gap-[14px] md:grid-cols-3">
            {PATH_STEPS.map((step, i) => (
              <Reveal key={step.n} delay={i * 0.06}>
                <div className="relative h-full rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)]">
                  <span className="absolute right-[22px] top-[22px] grid h-[42px] w-[42px] place-items-center rounded-[13px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                    <Route className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span
                    aria-hidden="true"
                    className="font-[family-name:var(--font-display)] text-[28px] italic leading-none text-[color:var(--color-brand-cyan)] opacity-50"
                  >
                    {step.n}
                  </span>
                  <h3 className="mt-[14px] text-[17px] font-bold text-[color:var(--color-brand-navy)]">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-[14px] leading-[1.55] text-[color:var(--color-ink-soft)]">
                    {step.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Specialist roster */}
      <section className="bg-[color:var(--color-warm-sand)] py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="Our Specialists"
              title="20 physicians,"
              accent="14 specialties."
              // "from ₱500" matches the live site's consultation copy (see
              // SERVICE_HIGHLIGHTS in lib/marketing/site.ts) — final consult
              // fees are confirmed at reception.
              description="Consults from ₱500 — book directly, no referral needed."
              className="mb-10"
            />
          </Reveal>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {ROSTER_GROUPS.map((group, i) => {
              const Icon = group.icon;
              return (
                <Reveal key={group.title} delay={i * 0.08}>
                  <div className="h-full rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)]">
                    <span className="grid h-[42px] w-[42px] place-items-center rounded-[13px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <h3 className="mt-4 text-[17px] font-bold text-[color:var(--color-brand-navy)]">
                      {group.title}
                    </h3>
                    <p className="mt-2 text-[14px] leading-[1.55] text-[color:var(--color-ink-soft)]">
                      {group.body}
                    </p>
                  </div>
                </Reveal>
              );
            })}
          </div>

          <Reveal delay={0.15}>
            <div className="mt-8">
              <PillLink href="/physicians" variant="navy" size="sm">
                Meet Our Specialists{" "}
                <ArrowRight className="h-[18px] w-[18px]" aria-hidden="true" />
              </PillLink>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Executive package comparison */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="Executive Packages"
              title="One morning."
              accent="One building."
              description="A full executive checkup — bloodwork, X-ray, ECG, ultrasound — with a doctor to walk you through the results."
              className="mb-8"
            />
          </Reveal>

          <Reveal delay={0.08}>
            <div className="overflow-x-auto rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white shadow-[var(--shadow-warm-sm)]">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[color:var(--color-warm-line-soft)]">
                    <th scope="col" className="px-5 py-4">
                      <span className="sr-only">Inclusions</span>
                    </th>
                    {tierColumns.map((tier) => (
                      <th scope="col" key={tier.name} className="px-5 py-4 align-top">
                        <span className="block font-bold text-[color:var(--color-brand-navy)]">
                          {tier.name}
                        </span>
                        <span className="mt-1 block font-[family-name:var(--font-display)] text-xl font-normal italic text-[color:var(--color-brand-cyan-text)]">
                          {tier.price}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TIER_ROWS.map((row) => (
                    <tr
                      key={row.label}
                      className="border-b border-[color:var(--color-warm-line-soft)] last:border-b-0"
                    >
                      <th
                        scope="row"
                        className="max-w-xs px-5 py-4 font-medium leading-relaxed text-[color:var(--color-ink-mid)]"
                      >
                        {row.label}
                      </th>
                      {row.tiers.map((included, i) => (
                        <td key={tierColumns[i].name} className="px-5 py-4">
                          {included ? (
                            <>
                              <Check
                                className="h-5 w-5 text-[color:var(--color-brand-cyan)]"
                                aria-hidden="true"
                              />
                              <span className="sr-only">Included</span>
                            </>
                          ) : (
                            <span className="text-[color:var(--color-ink-soft)]">
                              —<span className="sr-only">Not included</span>
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>

          <Reveal delay={0.12}>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <PillLink href="/schedule" variant="cyan" size="sm">
                Book Your Checkup{" "}
                <ArrowRight className="h-[18px] w-[18px]" aria-hidden="true" />
              </PillLink>
              <PillLink href="/packages" variant="line" size="sm">
                <FlaskConical className="h-[18px] w-[18px]" aria-hidden="true" />
                Full Package Details
              </PillLink>
            </div>
          </Reveal>

          <Reveal delay={0.15}>
            <p className="mt-6 text-xs text-[color:var(--color-ink-soft)]">
              Prices and inclusions may change without prior notice. Final
              pricing is confirmed at the clinic upon registration.
            </p>
          </Reveal>
        </div>
      </section>

      <PromoFaq items={FAQ} />

      <PromoClosingCta
        title="Test here. Treated here."
        body="Book your checkup in 2 minutes or message us on Messenger — Mon–Sat, 8am–5pm. Congressional Ave, Quezon City."
        primaryLabel="Book Your Checkup"
      />
    </>
  );
}

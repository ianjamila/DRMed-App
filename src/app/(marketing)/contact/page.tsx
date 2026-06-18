import { MapPin, Clock, Phone, Mail, Navigation, Car, HelpCircle, ExternalLink } from "lucide-react";
import { PageHero } from "@/components/marketing/page-hero";
import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { CONTACT, SOCIAL, AREAS_SERVED } from "@/lib/marketing/site";
import { addressLines, hoursLabel, telHref, directionsHrefs, mapEmbedSrc } from "@/lib/marketing/nap";
import { ContactForm } from "./contact-form";
import { MapEmbed } from "@/components/marketing/map-embed";
import { OpenNowPill } from "@/components/marketing/home/OpenNowPill";
import { JsonLd } from "@/components/marketing/json-ld";
import { medicalClinicLd, breadcrumbLd, faqPageLd } from "@/lib/marketing/structured-data";
import { pageMetadata } from "@/lib/marketing/metadata";
import type { FaqItem } from "@/lib/marketing/faq";

export const metadata = pageMetadata({
  title: "Contact & Location",
  description:
    "Visit DRMed Clinic and Laboratory in Quezon City — address, directions, map, phone, and clinic hours. Open Monday to Saturday, 8:00 AM–5:00 PM.",
  path: "/contact",
});

// Confirmed facts only (already true on the site). Parking, exact HMO list, and
// fasting guidance are owner-confirm (spec) — add them here once confirmed so they
// also flow into FAQPage schema. Do NOT publish unconfirmed answers.
const FAQS: FaqItem[] = [
  {
    question: "Do I need an appointment, or can I walk in?",
    answer:
      "Walk-ins are welcome for packages and most lab tests. Booking online is optional and simply saves you time at reception.",
  },
  {
    question: "How soon are my results ready?",
    answer:
      "Most tests are ready within 24 hours, and many are released the same day. You can view and download released results anytime through the patient portal.",
  },
  {
    question: "Do you accept HMOs?",
    answer:
      "Yes — we accept 10 major HMO providers. Present your HMO card or letter of authorization (LOA) at reception.",
  },
  {
    question: "Do you offer home service?",
    answer:
      "Yes — we offer home sample collection and a mobile clinic for groups and companies. Contact us to arrange a visit.",
  },
];

const dir = directionsHrefs();

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-[14px]">
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
          {label}
        </p>
        {children}
      </div>
    </div>
  );
}

export default function ContactPage() {
  const [addrTop, addrBottom] = addressLines();

  return (
    <>
      <JsonLd
        data={[
          medicalClinicLd(),
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: "Contact & Location", path: "/contact" },
          ]),
          faqPageLd(FAQS),
        ]}
      />

      <PageHero
        eyebrow="Visit Us"
        title="Find DRMed in Quezon City."
        description="Address, directions, clinic hours, and a quick way to reach us. Walk in during operating hours or send a message to book ahead."
      />

      {/* Details + form */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:px-8 md:grid-cols-2">
          <Reveal>
            <div>
              <SectionHeading eyebrow="Visit, call, or email" title="We are easy" accent="to find." />
              <div className="mt-8 space-y-6">
                <DetailRow icon={<MapPin className="h-5 w-5" />} label="Address">
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                    {addrTop}
                    <br />
                    {addrBottom}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a href={dir.google} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full bg-[rgba(8,168,226,0.10)] px-3 py-1 text-[12px] font-bold text-[color:var(--color-brand-cyan-text)] hover:bg-[rgba(8,168,226,0.18)]">
                      <Navigation className="h-3.5 w-3.5" aria-hidden="true" /> Google Maps
                    </a>
                    <a href={dir.waze} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full bg-[rgba(8,168,226,0.10)] px-3 py-1 text-[12px] font-bold text-[color:var(--color-brand-cyan-text)] hover:bg-[rgba(8,168,226,0.18)]">
                      <Navigation className="h-3.5 w-3.5" aria-hidden="true" /> Waze
                    </a>
                    <a href={dir.apple} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full bg-[rgba(8,168,226,0.10)] px-3 py-1 text-[12px] font-bold text-[color:var(--color-brand-cyan-text)] hover:bg-[rgba(8,168,226,0.18)]">
                      <Navigation className="h-3.5 w-3.5" aria-hidden="true" /> Apple Maps
                    </a>
                  </div>
                </DetailRow>

                <DetailRow icon={<Clock className="h-5 w-5" />} label="Clinic Hours">
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                    {hoursLabel()}
                    <OpenNowPill />
                  </p>
                </DetailRow>

                <DetailRow icon={<Phone className="h-5 w-5" />} label="Phone">
                  <p className="mt-1 text-[14.5px] leading-relaxed">
                    <a href={telHref("mobile")} className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]">
                      {CONTACT.phone.mobile}
                    </a>
                    {" · "}
                    <a href={telHref("landline")} className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]">
                      {CONTACT.phone.landline}
                    </a>
                  </p>
                </DetailRow>

                <DetailRow icon={<Mail className="h-5 w-5" />} label="Email">
                  <p className="mt-1 text-[14.5px] leading-relaxed">
                    <a href={`mailto:${CONTACT.email}`} className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]">
                      {CONTACT.email}
                    </a>
                  </p>
                </DetailRow>

                <DetailRow icon={<ExternalLink className="h-5 w-5" />} label="Connect With Us">
                  <div className="mt-1 flex items-center gap-[14px] text-[14.5px]">
                    <a href={SOCIAL.facebook} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-[7px] text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]" aria-label="DRMed on Facebook (opens in new tab)">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" /> Facebook
                    </a>
                    <a href={SOCIAL.instagram} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-[7px] text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]" aria-label="DRMed on Instagram (opens in new tab)">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" /> Instagram
                    </a>
                    <a href={SOCIAL.messenger} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-[7px] text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]" aria-label="DRMed on Messenger (opens in new tab)">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" /> Messenger
                    </a>
                  </div>
                </DetailRow>
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="rounded-[24px] border border-[color:var(--color-warm-line-soft)] bg-white p-8 shadow-[var(--shadow-warm-sm)]">
              <SectionHeading eyebrow="Inquire / Book" title="Send us a message." />
              <p className="mt-1.5 mb-6 text-[13px] text-[color:var(--color-ink-soft)]">
                For appointments, corporate packages, or general inquiries.
              </p>
              <ContactForm />
            </div>
          </Reveal>
        </div>
      </section>

      {/* Map + how to find us */}
      <section className="bg-[color:var(--color-warm-bg)] py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Getting Here" title="How to" accent="find us." className="mb-8" />
          <div className="grid gap-8 lg:grid-cols-2">
            <Reveal>
              <MapEmbed src={mapEmbedSrc()} title="DRMed Clinic and Laboratory, Quezon City" />
            </Reveal>
            <Reveal delay={0.08}>
              <div className="space-y-5">
                <DetailRow icon={<MapPin className="h-5 w-5" />} label="Landmark">
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                    We are on the 4th floor of Northridge Plaza along Congressional Avenue, Project 8,
                    Quezon City. Look for the building entrance and take the lift to the 4th floor.
                  </p>
                </DetailRow>
                <DetailRow icon={<Car className="h-5 w-5" />} label="Parking & Transit">
                  {/* OWNER-CONFIRM (spec item #1): replace with exact parking + jeepney/bus details. */}
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                    Accessible via Congressional Avenue, with public-transport routes along the avenue.
                    Call us if you need directions for your specific route.
                  </p>
                </DetailRow>
                <PillLink href={dir.google} variant="navy" size="md" target="_blank" rel="noopener noreferrer">
                  Get directions <Navigation className="h-4 w-4" aria-hidden="true" />
                </PillLink>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Areas served */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Service Area" title="Serving Quezon City" accent="and nearby areas." className="mb-6" />
          <p className="max-w-2xl text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
            Patients visit us from across Quezon City. We also bring the lab to you with home sample
            collection and a mobile clinic for groups and companies.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {AREAS_SERVED.map((area) => (
              <span key={area} className="rounded-full border border-[color:var(--color-warm-line-soft)] bg-white px-3 py-1 text-[13px] text-[color:var(--color-ink-mid)] shadow-[var(--shadow-warm-sm)]">
                {area}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="bg-[color:var(--color-warm-sand)] py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Good to Know" title="Frequently asked" accent="questions." className="mb-8" />
          <div className="space-y-3">
            {FAQS.map((f) => (
              <details key={f.question} className="group rounded-[16px] border border-[color:var(--color-warm-line-soft)] bg-white px-5 py-4 shadow-[var(--shadow-warm-sm)]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-[8px] text-[15px] font-bold text-[color:var(--color-brand-navy)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]">
                  <span className="flex items-center gap-2.5">
                    <HelpCircle className="h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan)]" aria-hidden="true" />
                    {f.question}
                  </span>
                  <span className="shrink-0 text-[color:var(--color-brand-cyan)] transition-transform group-open:rotate-45" aria-hidden="true">+</span>
                </summary>
                <p className="mt-3 text-[14px] leading-relaxed text-[color:var(--color-ink-mid)]">{f.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="bg-[color:var(--color-brand-navy)] py-14 text-white">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-2xl font-normal">Ready to visit?</h2>
            <p className="mt-1 text-sm text-white/75">Book ahead online or just walk in during clinic hours.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <PillLink href="/schedule" variant="cyan" size="md">Book an appointment</PillLink>
            <PillLink href={telHref("mobile")} variant="lineOnDark" size="md">Call now</PillLink>
          </div>
        </div>
      </section>
    </>
  );
}

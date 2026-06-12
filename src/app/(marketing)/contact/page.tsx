import { MapPin, Clock, Phone, Mail, ExternalLink } from "lucide-react";
import { PageHero } from "@/components/marketing/page-hero";
import { SectionHeading } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { CONTACT, SOCIAL } from "@/lib/marketing/site";
import { ContactForm } from "./contact-form";

export const metadata = {
  title: "Contact",
  description:
    "Get in touch with DRMed Clinic and Laboratory. Send us a message about appointments, HMO, corporate packages, or general inquiries.",
};

const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(CONTACT.address.full)}`;

export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Reach Us"
        title="Get in touch."
        description="We're here to help with appointments, HMO inquiries, corporate packages, and general questions."
      />

      <section className="py-16 sm:py-20">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:px-8 md:grid-cols-2">
          {/* Left column: contact details */}
          <Reveal>
            <div>
              <SectionHeading
                eyebrow="Visit, call, or email"
                title="We are easy"
                accent="to find."
                description={`Located at the heart of the community at Northridge Plaza, Congressional Avenue, Quezon City. Our friendly staff is available ${CONTACT.hours}.`}
              />

              <div className="mt-8 space-y-6">
                {/* Address */}
                <div className="flex items-start gap-[14px]">
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  >
                    <MapPin className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      Address
                    </p>
                    <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                      {CONTACT.address.line1}
                      <br />
                      {CONTACT.address.line2}, {CONTACT.address.city}
                    </p>
                    <a
                      href={mapsHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-[13px] text-[color:var(--color-brand-cyan-text)] underline-offset-2 hover:underline"
                    >
                      Open in Maps ↗
                    </a>
                  </div>
                </div>

                {/* Hours */}
                <div className="flex items-start gap-[14px]">
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  >
                    <Clock className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      Clinic Hours
                    </p>
                    <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                      {CONTACT.hours}
                    </p>
                  </div>
                </div>

                {/* Mobile */}
                <div className="flex items-start gap-[14px]">
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  >
                    <Phone className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      Phone
                    </p>
                    <p className="mt-1 text-[14.5px] leading-relaxed">
                      <a
                        href={`tel:${CONTACT.phone.mobileE164}`}
                        className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]"
                      >
                        {CONTACT.phone.mobile}
                      </a>
                      {" · "}
                      <a
                        href={`tel:${CONTACT.phone.landlineE164}`}
                        className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]"
                      >
                        {CONTACT.phone.landline}
                      </a>
                    </p>
                  </div>
                </div>

                {/* Email */}
                <div className="flex items-start gap-[14px]">
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  >
                    <Mail className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      Email
                    </p>
                    <p className="mt-1 text-[14.5px] leading-relaxed">
                      <a
                        href={`mailto:${CONTACT.email}`}
                        className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]"
                      >
                        {CONTACT.email}
                      </a>
                    </p>
                  </div>
                </div>

                {/* Social */}
                <div className="flex items-start gap-[14px]">
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  >
                    <ExternalLink className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      Connect With Us
                    </p>
                    <div className="mt-1 flex items-center gap-[14px] text-[14.5px]">
                      <a
                        href={SOCIAL.facebook}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-[7px] text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]"
                        aria-label="DRMed on Facebook (opens in new tab)"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        Facebook
                      </a>
                      <a
                        href={SOCIAL.instagram}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-[7px] text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]"
                        aria-label="DRMed on Instagram (opens in new tab)"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        Instagram
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>

          {/* Right column: form card */}
          <Reveal delay={0.1}>
            <div className="rounded-[24px] border border-[color:var(--color-warm-line-soft)] bg-white p-8 shadow-[var(--shadow-warm-sm)]">
              <SectionHeading
                eyebrow="Inquire / Book"
                title="Send us a message."
              />
              <p className="mt-1.5 mb-6 text-[13px] text-[color:var(--color-ink-soft)]">
                For appointments, corporate packages, or general inquiries.
              </p>
              <ContactForm />
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}

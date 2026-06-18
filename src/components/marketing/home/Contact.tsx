// Note: lucide-react in this project does not export Facebook/Instagram icons.
// Using ExternalLink as the generic social-link icon (lucide-react ONLY constraint).
import { MapPin, Clock, Phone, HeartHandshake, ExternalLink } from "lucide-react";

import { SectionHeading } from "@/components/marketing/ui/SectionHeading";
import { Eyebrow } from "@/components/marketing/ui/Eyebrow";
import { ContactForm } from "@/app/(marketing)/contact/contact-form";
import { OpenNowPill } from "./OpenNowPill";
import { CONTACT, SOCIAL } from "@/lib/marketing/site";
import { addressLines, hoursLabel, directionsHrefs } from "@/lib/marketing/nap";

const mapsHref = directionsHrefs().google;
const [addrTop, addrBottom] = addressLines();

/**
 * Homepage Contact section — navy background with a wave SVG transition
 * placed immediately before it. Left column = contact details; right column
 * = the shared ContactForm on a warm card.
 */
export function Contact() {
  return (
    <>
      {/* Wave transition from preceding section into navy */}
      <svg
        className="block w-full -mb-px pointer-events-none"
        style={{ height: "clamp(48px,9vw,110px)" }}
        viewBox="0 0 1440 110"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          fill="#263F91"
          fillOpacity=".14"
          d="M0,58 C260,18 540,96 820,62 C1100,28 1280,72 1440,46 L1440,110 L0,110 Z"
        />
        <path
          fill="#263F91"
          fillOpacity=".38"
          d="M0,76 C300,40 620,104 900,78 C1160,54 1330,86 1440,68 L1440,110 L0,110 Z"
        />
        <path
          fill="#263F91"
          d="M0,94 C340,66 700,112 1020,94 C1240,82 1370,96 1440,90 L1440,110 L0,110 Z"
        />
      </svg>

      <section
        id="contact"
        className="bg-[color:var(--color-brand-navy)] py-[72px] text-white"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 md:grid-cols-2 lg:gap-14">
            {/* ── Left column: contact details ── */}
            <div>
              <SectionHeading
                light
                eyebrow="Reach Us"
                title="Get in"
                accent="touch."
                description="We're here to help with appointments, inquiries, and corporate packages."
              />

              {/* Address */}
              <div className="mt-6 flex items-start gap-[14px]">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.16)] text-[color:var(--color-brand-cyan-on-navy)]"
                  aria-hidden="true"
                >
                  <MapPin className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-on-navy)]">
                    Address
                  </p>
                  <p className="mt-1 text-[14.5px] leading-relaxed text-white/[.82]">
                    {addrTop}
                    <br />
                    {addrBottom}
                  </p>
                  <a
                    href={mapsHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-[13px] text-[color:var(--color-brand-cyan-on-navy)] underline-offset-2 hover:underline"
                  >
                    Open in Maps ↗
                  </a>
                </div>
              </div>

              {/* Clinic Hours */}
              <div className="mt-6 flex items-start gap-[14px]">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.16)] text-[color:var(--color-brand-cyan-on-navy)]"
                  aria-hidden="true"
                >
                  <Clock className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-on-navy)]">
                    Clinic Hours
                  </p>
                  <p className="mt-1 text-[14.5px] leading-relaxed text-white/[.82]">
                    {hoursLabel()}
                    <OpenNowPill />
                  </p>
                </div>
              </div>

              {/* Phone */}
              <div className="mt-6 flex items-start gap-[14px]">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.16)] text-[color:var(--color-brand-cyan-on-navy)]"
                  aria-hidden="true"
                >
                  <Phone className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-on-navy)]">
                    Phone
                  </p>
                  <p className="mt-1 text-[14.5px] leading-relaxed text-white/[.82]">
                    <a
                      href={`tel:${CONTACT.phone.mobileE164}`}
                      className="hover:text-white"
                    >
                      {CONTACT.phone.mobile}
                    </a>
                    {" · "}
                    <a
                      href={`tel:${CONTACT.phone.landlineE164}`}
                      className="hover:text-white"
                    >
                      {CONTACT.phone.landline}
                    </a>
                  </p>
                </div>
              </div>

              {/* Connect With Us */}
              <div className="mt-6 flex items-start gap-[14px]">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.16)] text-[color:var(--color-brand-cyan-on-navy)]"
                  aria-hidden="true"
                >
                  <HeartHandshake className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-on-navy)]">
                    Connect With Us
                  </p>
                  <div className="mt-1 flex items-center gap-[14px] text-[14.5px] text-white/[.82]">
                    <a
                      href={SOCIAL.facebook}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-[7px] hover:text-white"
                      aria-label="DRMed on Facebook (opens in new tab)"
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      Facebook
                    </a>
                    <a
                      href={SOCIAL.instagram}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-[7px] hover:text-white"
                      aria-label="DRMed on Instagram (opens in new tab)"
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      Instagram
                    </a>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Right column: form card ── */}
            <div className="rounded-[24px] bg-[color:var(--color-warm-bg)] p-[30px] text-[color:var(--color-ink)] shadow-[var(--shadow-warm-lg)]">
              <Eyebrow>Inquire / Book</Eyebrow>
              <h3 className="mt-2.5 font-[family-name:var(--font-display)] text-[28px] text-[color:var(--color-brand-navy)]">
                Send us a message
              </h3>
              <p className="mt-1.5 mb-5 text-[13px] text-[color:var(--color-ink-soft)]">
                For appointments, corporate packages, or general inquiries.
              </p>
              <ContactForm />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

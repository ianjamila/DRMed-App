import { PageHero } from "@/components/marketing/page-hero";
import { CONTACT } from "@/lib/marketing/site";
import { ContactForm } from "./contact-form";

export const metadata = {
  title: "Contact",
  description:
    "Get in touch with DRMed Clinic and Laboratory. Send us a message about appointments, HMO, corporate packages, or general inquiries.",
};

export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Reach Us"
        title="Get in touch."
        description="We're here to help with appointments, HMO inquiries, corporate packages, and general questions."
      />

      <section className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 md:grid-cols-2 lg:px-8">
        <div>
          <h2 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
            Visit, call, or email
          </h2>
          <p className="mt-4 text-base leading-relaxed text-[color:var(--color-brand-text-mid)]">
            Located at the heart of the community at Northridge Plaza,
            Congressional Avenue, Quezon City. Our friendly staff is available
            {` ${CONTACT.hours}`}.
          </p>

          <dl className="mt-8 space-y-5 text-sm">
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                Address
              </dt>
              <dd className="mt-1 text-[color:var(--color-brand-text-mid)]">
                {CONTACT.address.line1}
                <br />
                {CONTACT.address.line2}, {CONTACT.address.city}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                Mobile
              </dt>
              <dd className="mt-1">
                <a
                  href={`tel:${CONTACT.phone.mobileE164}`}
                  className="text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                >
                  {CONTACT.phone.mobile}
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                Telephone
              </dt>
              <dd className="mt-1">
                <a
                  href={`tel:${CONTACT.phone.landlineE164}`}
                  className="text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                >
                  {CONTACT.phone.landline}
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                Email
              </dt>
              <dd className="mt-1">
                <a
                  href={`mailto:${CONTACT.email}`}
                  className="text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                >
                  {CONTACT.email}
                </a>
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 shadow-sm">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
            Send us a message
          </h2>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            For appointments, corporate packages, or general inquiries.
          </p>
          <div className="mt-6">
            <ContactForm />
          </div>
        </div>
      </section>
    </>
  );
}

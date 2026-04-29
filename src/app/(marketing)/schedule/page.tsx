import { PageHero } from "@/components/marketing/page-hero";
import { CONTACT } from "@/lib/marketing/site";

export const metadata = {
  title: "Schedule & Location",
  description: `Visit DRMed Clinic & Laboratory at ${CONTACT.address.full}. Open ${CONTACT.hours}.`,
};

export default function SchedulePage() {
  return (
    <>
      <PageHero
        eyebrow="Visit Us"
        title="Schedule & Location"
        description="Walk in or book ahead — our team is ready to help."
      />

      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-2">
          <article className="rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8">
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
              Operating Hours
            </p>
            <h2 className="mt-3 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
              {CONTACT.hours}
            </h2>
            <p className="mt-4 text-sm text-[color:var(--color-brand-text-soft)]">
              Closed on Sundays and Philippine public holidays. Last patient
              registration is 30 minutes before closing.
            </p>
          </article>

          <article className="rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8">
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
              Address
            </p>
            <h2 className="mt-3 font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
              {CONTACT.address.line1}
            </h2>
            <p className="mt-2 text-base text-[color:var(--color-brand-text-mid)]">
              {CONTACT.address.line2}
              <br />
              {CONTACT.address.city}, {CONTACT.address.region}
            </p>
            <p className="mt-4 text-sm">
              <a
                href={`tel:${CONTACT.phone.mobileE164}`}
                className="text-[color:var(--color-brand-cyan)] hover:underline"
              >
                Mobile: {CONTACT.phone.mobile}
              </a>
              <br />
              <a
                href={`tel:${CONTACT.phone.landlineE164}`}
                className="text-[color:var(--color-brand-cyan)] hover:underline"
              >
                Tel: {CONTACT.phone.landline}
              </a>
            </p>
          </article>
        </div>

        <div className="mt-12 rounded-2xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-10 text-center">
          <p className="font-[family-name:var(--font-heading)] text-xl font-bold text-[color:var(--color-brand-navy)]">
            Online booking is coming soon.
          </p>
          <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
            For now, please walk in during operating hours, or{" "}
            <a
              href="/contact"
              className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
            >
              send us a message
            </a>{" "}
            to set up an appointment.
          </p>
        </div>
      </section>
    </>
  );
}

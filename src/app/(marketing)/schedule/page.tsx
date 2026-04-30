import { PageHero } from "@/components/marketing/page-hero";
import { CONTACT } from "@/lib/marketing/site";
import { listActiveServices } from "@/lib/marketing/services";
import { BookingForm } from "./booking-form";

export const metadata = {
  title: "Schedule & Location",
  description: `Visit DRMed Clinic & Laboratory at ${CONTACT.address.full}. Open ${CONTACT.hours}.`,
};

// Manila is UTC+8 with no DST. Shift the UTC time and slice to get the
// "YYYY-MM-DDTHH:mm" string the datetime-local picker expects.
function manilaLocal(d: Date): string {
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const services = await listActiveServices();
  // eslint-disable-next-line react-hooks/purity -- per-request bounds for the picker.
  const now = Date.now();
  const minDt = manilaLocal(new Date(now + 60 * 60 * 1000));
  const maxDt = manilaLocal(new Date(now + 60 * 24 * 60 * 60 * 1000));
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

        <section
          id="book"
          className="mt-12 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 sm:p-10"
        >
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Book online
          </p>
          <h2 className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)] md:text-3xl">
            Reserve your slot
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-mid)]">
            New patient? Use this form to register and book in one step. We
            verify your identity at the counter on arrival. For corporate
            packages or HMO,{" "}
            <a
              href="/contact"
              className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
            >
              message us instead
            </a>
            .
          </p>

          <div className="mt-8">
            <BookingForm
              services={services.map((s) => ({
                id: s.id,
                code: s.code,
                name: s.name,
              }))}
              defaultMin={minDt}
              defaultMax={maxDt}
            />
          </div>
        </section>
      </section>
    </>
  );
}

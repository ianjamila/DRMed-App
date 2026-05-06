import { PageHero } from "@/components/marketing/page-hero";
import { CONTACT } from "@/lib/marketing/site";
import { listActiveServices } from "@/lib/marketing/services";
import {
  addDaysISO,
  listClosuresInRange,
  tomorrowManilaISO,
} from "@/lib/marketing/closures";
import { createClient } from "@/lib/supabase/server";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { BookingForm } from "./booking-form";

export const metadata = {
  title: "Schedule & Location",
  description: `Visit DRMed Clinic & Laboratory at ${CONTACT.address.full}. Open ${CONTACT.hours}.`,
};

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const services = await listActiveServices();
  const startDate = tomorrowManilaISO();
  const endDate = addDaysISO(startDate, 60);
  const closures = await listClosuresInRange(startDate, endDate);

  // Load active physicians + their schedules + upcoming overrides so the
  // booking form can render a picker and the slot grid can intersect days.
  const supabase = await createClient();
  const [
    { data: physicianRows },
    { data: scheduleRows },
    { data: overrideRows },
  ] = await Promise.all([
    supabase
      .from("physicians")
      .select(
        "id, slug, full_name, specialty, group_label, photo_path, display_order",
      )
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("full_name", { ascending: true }),
    supabase
      .from("physician_schedules")
      .select("physician_id, day_of_week, start_time, end_time"),
    supabase
      .from("physician_schedule_overrides")
      .select("physician_id, override_on, start_time, end_time")
      .gte("override_on", startDate)
      .lte("override_on", endDate),
  ]);

  const blocksByPhysician = new Map<
    string,
    Array<{ day_of_week: number; start_time: string; end_time: string }>
  >();
  for (const r of scheduleRows ?? []) {
    const list = blocksByPhysician.get(r.physician_id) ?? [];
    list.push({
      day_of_week: r.day_of_week,
      start_time: r.start_time,
      end_time: r.end_time,
    });
    blocksByPhysician.set(r.physician_id, list);
  }

  const overridesByPhysician = new Map<
    string,
    Array<{ override_on: string; start_time: string | null; end_time: string | null }>
  >();
  for (const r of overrideRows ?? []) {
    const list = overridesByPhysician.get(r.physician_id) ?? [];
    list.push({
      override_on: r.override_on,
      start_time: r.start_time,
      end_time: r.end_time,
    });
    overridesByPhysician.set(r.physician_id, list);
  }

  // Bookable = at least one recurring block. By-appointment-only physicians
  // appear on /physicians but not in the booking picker.
  const bookablePhysicians = (physicianRows ?? [])
    .filter((p) => (blocksByPhysician.get(p.id) ?? []).length > 0)
    .map((p) => ({
      id: p.id,
      full_name: p.full_name,
      specialty: p.specialty,
      group_label: p.group_label,
      photo_url: physicianPhotoUrl({
        slug: p.slug,
        photo_path: p.photo_path,
      }),
      blocks: blocksByPhysician.get(p.id) ?? [],
      overrides: overridesByPhysician.get(p.id) ?? [],
    }));

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
              services={services
                .filter(
                  (s) =>
                    s.kind === "lab_test" ||
                    s.kind === "lab_package" ||
                    s.kind === "doctor_consultation",
                )
                .map((s) => ({
                  id: s.id,
                  code: s.code,
                  name: s.name,
                  kind: s.kind as
                    | "lab_test"
                    | "lab_package"
                    | "doctor_consultation",
                }))}
              closures={closures}
              startDate={startDate}
              physicians={bookablePhysicians}
            />
          </div>
        </section>
      </section>
    </>
  );
}

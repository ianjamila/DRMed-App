import Link from "next/link";
import { listActiveServices } from "@/lib/marketing/services";
import {
  addDaysISO,
  listClosuresInRange,
  tomorrowManilaISO,
} from "@/lib/marketing/closures";
import { createClient } from "@/lib/supabase/server";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { BookingForm } from "@/app/(marketing)/schedule/booking-form";

export const metadata = {
  title: "Book an appointment — drmed.ph",
};

export const dynamic = "force-dynamic";

export default async function PortalBookPage() {
  const patient = await requirePatientProfile();

  const services = await listActiveServices();
  const startDate = tomorrowManilaISO();
  const endDate = addDaysISO(startDate, 60);
  const closures = await listClosuresInRange(startDate, endDate);

  const supabase = await createClient();
  const [
    { data: physicianRows },
    { data: scheduleRows },
    { data: overrideRows },
    { data: specialtyRows },
    { data: physicianSpecialtyRows },
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
    supabase
      .from("specialty_codes")
      .select("code, label, display_order")
      .order("display_order", { ascending: true }),
    supabase
      .from("physician_specialties")
      .select("physician_id, code"),
  ]);

  const specialties = (specialtyRows ?? []).map((s) => ({
    code: s.code,
    label: s.label,
  }));

  const codesByPhysician = new Map<string, string[]>();
  for (const r of physicianSpecialtyRows ?? []) {
    const list = codesByPhysician.get(r.physician_id) ?? [];
    list.push(r.code);
    codesByPhysician.set(r.physician_id, list);
  }

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
      specialty_codes: codesByPhysician.get(p.id) ?? [],
      blocks: blocksByPhysician.get(p.id) ?? [],
      overrides: overridesByPhysician.get(p.id) ?? [],
    }));

  const byAppointmentPhysicians = (physicianRows ?? [])
    .filter((p) => (blocksByPhysician.get(p.id) ?? []).length === 0)
    .map((p) => ({
      id: p.id,
      full_name: p.full_name,
      specialty: p.specialty,
      group_label: p.group_label,
      photo_url: physicianPhotoUrl({
        slug: p.slug,
        photo_path: p.photo_path,
      }),
      specialty_codes: codesByPhysician.get(p.id) ?? [],
    }));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Book an appointment
        </h1>
        <Link
          href="/portal"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Back to results
        </Link>
      </div>
      <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
        Booking as{" "}
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          {patient.first_name} {patient.last_name}
        </span>{" "}
        ({patient.drm_id}). We&apos;ll send confirmation to the contact info on
        your file.
      </p>

      <section className="mt-6 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6 sm:p-8">
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
              description: s.description,
              price_php: Number(s.price_php),
              fasting_required: s.fasting_required,
              requires_time_slot: s.requires_time_slot,
              specialty_code: s.specialty_code,
            }))}
          closures={closures}
          startDate={startDate}
          specialties={specialties}
          physicians={bookablePhysicians}
          byAppointmentPhysicians={byAppointmentPhysicians}
          prefilledPatient={{
            id: patient.patient_id,
            drm_id: patient.drm_id,
            first_name: patient.first_name,
            last_name: patient.last_name,
          }}
        />
      </section>
    </div>
  );
}

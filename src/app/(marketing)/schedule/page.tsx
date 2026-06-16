import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { listActiveServices } from "@/lib/marketing/services";
import {
  addDaysISO,
  listClosuresInRange,
  tomorrowManilaISO,
} from "@/lib/marketing/closures";
import { createClient } from "@/lib/supabase/server";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { BookingForm } from "./booking-form";
import { pageMetadata } from "@/lib/marketing/metadata";

export const metadata = pageMetadata({
  title: "Book an Appointment",
  description:
    "Book a consultation, lab test, or home service at DRMed Clinic & Laboratory in Quezon City. See clinic hours and location.",
  path: "/schedule",
});

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const services = await listActiveServices();
  const startDate = tomorrowManilaISO();
  const endDate = addDaysISO(startDate, 60);
  const closures = await listClosuresInRange(startDate, endDate);

  // Load active physicians + their schedules + upcoming overrides so the
  // booking form can render a picker and the slot grid can intersect days.
  // Also load specialty_codes (drives the strict specialty picker on the
  // doctor branch) and physician_specialties (per-physician code list).
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

  // Bookable = at least one recurring block. By-appointment-only physicians
  // appear on /physicians and surface in a "call to book" card on the doctor
  // branch — full pending_callback online flow is deferred to a later phase.
  const bookablePhysicians = (physicianRows ?? [])
    .filter((p) => (blocksByPhysician.get(p.id) ?? []).length > 0)
    .map((p) => ({
      id: p.id,
      slug: p.slug,
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
      slug: p.slug,
      full_name: p.full_name,
      specialty: p.specialty,
      group_label: p.group_label,
      photo_url: physicianPhotoUrl({
        slug: p.slug,
        photo_path: p.photo_path,
      }),
      specialty_codes: codesByPhysician.get(p.id) ?? [],
    }));

  // Deep-link preselect: /schedule?doctor=<slug> opens on the doctor branch
  // with that physician already picked. Resolve across both pools so by-
  // appointment physicians also deep-link correctly.
  const { doctor: doctorSlug } = await searchParams;
  const slugString = Array.isArray(doctorSlug) ? doctorSlug[0] : doctorSlug;
  const matchedPhysician =
    slugString
      ? (bookablePhysicians.find((p) => p.slug === slugString) ??
          byAppointmentPhysicians.find((p) => p.slug === slugString) ??
          null)
      : null;
  const initialBranch = matchedPhysician ? ("doctor_appointment" as const) : undefined;
  const initialPhysicianId = matchedPhysician?.id;
  // "all" is a valid specialty selector option that shows every physician, so it
  // is a safe fallback when a physician has no specialty_codes assigned yet.
  const initialSpecialtyCode = matchedPhysician
    ? (matchedPhysician.specialty_codes[0] ?? "all")
    : undefined;

  const bookingServices = services
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
      kind: s.kind as "lab_test" | "lab_package" | "doctor_consultation",
      description: s.description,
      price_php: Number(s.price_php),
      fasting_required: s.fasting_required,
      requires_time_slot: s.requires_time_slot,
      specialty_code: s.specialty_code,
    }));

  return (
    <div className="min-h-screen">
      {/* Focused funnel header — replaces the marketing nav on /schedule (C12). */}
      <header className="border-b border-[color:var(--color-warm-line-soft)] bg-[rgba(251,249,245,0.92)] backdrop-blur-[10px]">
        <div className="mx-auto flex h-[60px] max-w-[760px] items-center justify-between px-5">
          <Link href="/" aria-label={SITE.name} className="flex items-center">
            <Image
              src="/logo.png"
              alt={SITE.name}
              width={78}
              height={30}
              sizes="78px"
              priority
              className="h-[30px] w-auto"
            />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-[color:var(--color-ink-mid)] transition hover:text-[color:var(--color-brand-cyan-text)]"
          >
            <ArrowLeft className="h-[15px] w-[15px]" /> Back to homepage
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-5 pb-20 pt-2">
        <BookingForm
          services={bookingServices}
          closures={closures}
          startDate={startDate}
          specialties={specialties}
          physicians={bookablePhysicians}
          byAppointmentPhysicians={byAppointmentPhysicians}
          initialBranch={initialBranch}
          initialPhysicianId={initialPhysicianId}
          initialSpecialtyCode={initialSpecialtyCode}
        />

        {/* Minimal focused footer — privacy + a couple of escape hatches. */}
        <footer className="mt-10 border-t border-[color:var(--color-warm-line-soft)] pt-6 text-[12px] text-[color:var(--color-ink-soft)]">
          <p>
            Identity is verified at the counter on arrival. For corporate
            packages or HMO,{" "}
            <Link href="/contact" className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2">
              message us instead
            </Link>
            . Just want a DRM-ID?{" "}
            <Link href="/register" className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2">
              pre-register here
            </Link>
            .
          </p>
          <p className="mt-2">
            {CONTACT.hours} · {CONTACT.address.full} · Protected under the
            Philippine Data Privacy Act (RA 10173).
          </p>
        </footer>
      </main>
    </div>
  );
}

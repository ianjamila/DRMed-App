import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHero } from "@/components/marketing/page-hero";
import { DoctorAvatar } from "@/components/marketing/doctor-avatar";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { formatSchedule } from "@/lib/physicians/format-schedule";

export const metadata = {
  title: "Physicians and Detailed Schedules",
  description:
    "Complete DRMed doctor roster with photos and regular clinic schedules. Confirm final availability before visiting.",
};

export const revalidate = 300; // 5 min cache; admin edits land within 5 min

interface PhysicianRow {
  id: string;
  slug: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  photo_path: string | null;
  display_order: number;
}

interface ScheduleRow {
  physician_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

const FALLBACK_GROUP = "Other Specialists";

export default async function PhysiciansPage() {
  const supabase = await createClient();

  const [{ data: physicians }, { data: schedules }] = await Promise.all([
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
  ]);

  const blocksByPhysician = new Map<string, ScheduleRow[]>();
  for (const s of schedules ?? []) {
    const list = blocksByPhysician.get(s.physician_id) ?? [];
    list.push(s);
    blocksByPhysician.set(s.physician_id, list);
  }

  // Group physicians by group_label, preserving the display_order within
  // each group. Track group encounter order for stable section ordering.
  const groupsInOrder: string[] = [];
  const grouped = new Map<string, PhysicianRow[]>();
  for (const p of physicians ?? []) {
    const key = p.group_label ?? FALLBACK_GROUP;
    if (!grouped.has(key)) {
      grouped.set(key, []);
      groupsInOrder.push(key);
    }
    grouped.get(key)!.push(p);
  }

  const totalCount = (physicians ?? []).length;

  return (
    <>
      <PageHero
        eyebrow="DRMed Clinic and Laboratory"
        title="Physicians and Detailed Schedules"
        description="Complete doctor roster with photos and regular clinic schedules. Please confirm final availability before visiting."
      />

      <div className="mx-auto max-w-7xl px-4 pb-8 pt-2 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-4 text-xs font-medium text-[color:var(--color-brand-text-soft)]">
          <span className="rounded-full bg-[color:var(--color-brand-bg)] px-3 py-1 text-[color:var(--color-brand-navy)]">
            {totalCount}+ Physicians
          </span>
          <span>Northridge Plaza · Quezon City</span>
          <span>Mon – Sat Clinic Hours</span>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {groupsInOrder.map((group) => (
          <PhysicianGroupSection
            key={group}
            group={group}
            physicians={grouped.get(group) ?? []}
            blocksByPhysician={blocksByPhysician}
          />
        ))}

        <div className="mt-12 rounded-xl bg-[color:var(--color-brand-bg)] p-6 text-sm text-[color:var(--color-brand-text-mid)]">
          ⚠️ Schedules may change without prior notice. Kindly call{" "}
          <a
            href="tel:+639166043208"
            className="font-bold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
          >
            0916 604 3208
          </a>{" "}
          or{" "}
          <a
            href="tel:+63283553517"
            className="font-bold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
          >
            8355 3517
          </a>{" "}
          to confirm availability before booking.
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/schedule"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-5 py-2.5 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Book an Appointment
          </Link>
          <Link
            href="/"
            className="rounded-md border border-[color:var(--color-brand-navy)] px-5 py-2.5 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
          >
            Back to Homepage
          </Link>
        </div>
      </div>
    </>
  );
}

function PhysicianGroupSection({
  group,
  physicians,
  blocksByPhysician,
}: {
  group: string;
  physicians: PhysicianRow[];
  blocksByPhysician: Map<string, ScheduleRow[]>;
}) {
  return (
    <section className="mb-12">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)] md:text-3xl">
          {group}
        </h2>
        <span className="text-sm font-medium text-[color:var(--color-brand-cyan)]">
          {physicians.length} physician{physicians.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {physicians.map((doc) => {
          const blocks = blocksByPhysician.get(doc.id) ?? [];
          const lines = formatSchedule(blocks);
          const photoUrl = physicianPhotoUrl({
            slug: doc.slug,
            photo_path: doc.photo_path,
          });
          return (
            <article
              key={doc.id}
              className="flex gap-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5"
            >
              <DoctorAvatar photoUrl={photoUrl} name={doc.full_name} />
              <div className="min-w-0 flex-1">
                <h3 className="font-[family-name:var(--font-heading)] text-base font-bold leading-tight text-[color:var(--color-brand-navy)]">
                  {doc.full_name}
                </h3>
                <p className="mt-1 text-xs font-medium text-[color:var(--color-brand-cyan)]">
                  {doc.specialty}
                </p>
                <ul className="mt-3 space-y-1 text-xs text-[color:var(--color-brand-text-mid)]">
                  {lines.map((s) => (
                    <li key={s}>· {s}</li>
                  ))}
                </ul>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

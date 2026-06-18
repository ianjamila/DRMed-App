import { Calendar, Info, MapPin } from "lucide-react";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { PageHero } from "@/components/marketing/page-hero";
import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { DoctorAvatar } from "@/components/marketing/doctor-avatar";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { formatSchedule } from "@/lib/physicians/format-schedule";
import { JsonLd } from "@/components/marketing/json-ld";
import { physiciansItemListLd } from "@/lib/marketing/structured-data";
import { pageMetadata } from "@/lib/marketing/metadata";
import { CONTACT } from "@/lib/marketing/site";

export const metadata = pageMetadata({
  title: "Our Physicians & Schedules",
  description:
    "Meet the doctors at DRMed Clinic and Laboratory in Quezon City and view their clinic schedules. Book a consultation online.",
  path: "/physicians",
});

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

  const itemList = physiciansItemListLd(
    (physicians ?? []).map((d) => ({ slug: d.slug, fullName: d.full_name })),
  );

  return (
    <>
      <JsonLd data={itemList} />
      <PageHero
        eyebrow="DRMed Clinic and Laboratory"
        title="Physicians and Detailed"
        accent="Schedules."
        description="Complete doctor roster with photos and regular clinic schedules. Please confirm final availability before visiting."
      />

      {/* Meta strip */}
      <div className="border-b border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)]">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-4 text-xs font-medium text-[color:var(--color-ink-mid)]">
            <span className="flex items-center gap-1.5">
              <span className="inline-flex h-5 items-center rounded-full bg-[rgba(8,168,226,0.10)] px-2.5 text-[color:var(--color-brand-cyan-text)] font-bold">
                {totalCount}+ Physicians
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-brand-cyan)]" aria-hidden="true" />
              {CONTACT.address.line2.split(",")[0]} · {CONTACT.address.city}
            </span>
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-brand-cyan)]" aria-hidden="true" />
              Mon – Sat Clinic Hours
            </span>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        {groupsInOrder.map((group) => (
          <PhysicianGroupSection
            key={group}
            group={group}
            physicians={grouped.get(group) ?? []}
            blocksByPhysician={blocksByPhysician}
          />
        ))}

        {/* Schedule-change notice */}
        <Reveal>
          <div className="mt-4 flex flex-wrap items-start gap-3 rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)] p-5 text-sm text-[color:var(--color-ink-mid)]">
            <Info
              className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan)]"
              aria-hidden="true"
            />
            <p>
              Schedules may change without prior notice. Kindly call{" "}
              <a
                href={`tel:${CONTACT.phone.mobileE164}`}
                className="font-bold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan-text)]"
              >
                {CONTACT.phone.mobile}
              </a>{" "}
              or{" "}
              <a
                href={`tel:${CONTACT.phone.landlineE164}`}
                className="font-bold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan-text)]"
              >
                {CONTACT.phone.landline}
              </a>{" "}
              to confirm availability before booking.
            </p>
          </div>
        </Reveal>

        {/* Bottom CTAs */}
        <Reveal>
          <div className="mt-8 flex flex-wrap gap-3">
            <PillLink href="/schedule" variant="navy" size="md">
              Book an Appointment
            </PillLink>
            <PillLink href="/" variant="line" size="md">
              Back to Homepage
            </PillLink>
          </div>
        </Reveal>
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
    <section className="mb-14 sm:mb-16">
      <Reveal>
        <div className="mb-7 flex flex-wrap items-baseline justify-between gap-3">
          <SectionHeading as="h2" title={group} />
          <span className="inline-flex h-6 items-center rounded-full bg-[rgba(8,168,226,0.10)] px-3 text-xs font-bold text-[color:var(--color-brand-cyan-text)]">
            {physicians.length} physician{physicians.length === 1 ? "" : "s"}
          </span>
        </div>
      </Reveal>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {physicians.map((doc, i) => {
          const blocks = blocksByPhysician.get(doc.id) ?? [];
          const lines = formatSchedule(blocks);
          const photoUrl = physicianPhotoUrl({
            slug: doc.slug,
            photo_path: doc.photo_path,
          });
          return (
            <Reveal key={doc.id} delay={i * 0.05}>
              <Link
                href={`/physicians/${doc.slug}`}
                className="block rounded-[20px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]"
              >
                <article className="flex gap-4 rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-5 shadow-[var(--shadow-warm-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-warm-lg)]">
                  <DoctorAvatar photoUrl={photoUrl} name={doc.full_name} />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-[family-name:var(--font-display)] text-lg leading-tight text-[color:var(--color-brand-navy)]">
                      {doc.full_name}
                    </h3>
                    <p className="mt-1 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--color-brand-cyan-text)]">
                      {doc.specialty}
                    </p>
                    {lines.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {lines.map((s) => (
                          <li
                            key={s}
                            className="flex items-center gap-1.5 text-xs text-[color:var(--color-ink-mid)]"
                          >
                            <Calendar
                              className="h-3 w-3 shrink-0 text-[color:var(--color-brand-cyan)]"
                              aria-hidden="true"
                            />
                            {s}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </article>
              </Link>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}

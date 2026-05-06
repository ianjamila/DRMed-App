import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { DAY_NAMES, formatTime } from "@/lib/physicians/schedule";
import { AddBlockForm } from "./add-block-form";
import { AddOverrideForm } from "./add-override-form";
import { DeleteBlockButton, DeleteOverrideButton } from "./delete-buttons";

export const metadata = { title: "Schedule — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SchedulePage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: physician } = await admin
    .from("physicians")
    .select("id, full_name, specialty")
    .eq("id", id)
    .maybeSingle();
  if (!physician) notFound();

  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const [blocksRes, overridesRes] = await Promise.all([
    admin
      .from("physician_schedules")
      .select(
        "id, day_of_week, start_time, end_time, valid_from, valid_until, notes",
      )
      .eq("physician_id", id)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true }),
    admin
      .from("physician_schedule_overrides")
      .select("id, override_on, start_time, end_time, reason")
      .eq("physician_id", id)
      .gte("override_on", today)
      .order("override_on", { ascending: true }),
  ]);

  const blocks = blocksRes.data ?? [];
  const overrides = overridesRes.data ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          <Link
            href={`/staff/admin/physicians/${id}/edit`}
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← {physician.full_name}
          </Link>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Schedule
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Recurring weekly availability and one-off overrides. The booking
          slot picker intersects these with clinic closures.
        </p>
      </header>

      <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h2 className="font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Recurring blocks ({blocks.length})
        </h2>

        {blocks.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] px-4 py-3 text-sm text-[color:var(--color-brand-text-soft)]">
            No recurring availability — this physician is by-appointment
            only and won&apos;t appear in the online booking picker.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-lg border border-[color:var(--color-brand-bg-mid)]">
            {blocks.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-[color:var(--color-brand-navy)]">
                    {DAY_NAMES[b.day_of_week]} ·{" "}
                    {formatTime(b.start_time)} – {formatTime(b.end_time)}
                  </p>
                  <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                    From {b.valid_from}
                    {b.valid_until ? ` until ${b.valid_until}` : " (no end)"}
                    {b.notes ? ` · ${b.notes}` : ""}
                  </p>
                </div>
                <DeleteBlockButton physicianId={id} blockId={b.id} />
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 border-t border-[color:var(--color-brand-bg-mid)] pt-6">
          <p className="mb-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
            Add a block
          </p>
          <AddBlockForm physicianId={id} />
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h2 className="font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Upcoming overrides ({overrides.length})
        </h2>

        {overrides.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] px-4 py-3 text-sm text-[color:var(--color-brand-text-soft)]">
            No overrides scheduled.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-lg border border-[color:var(--color-brand-bg-mid)]">
            {overrides.map((o) => (
              <li
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-[color:var(--color-brand-navy)]">
                    {o.override_on}{" "}
                    {o.start_time && o.end_time ? (
                      <span className="font-normal text-[color:var(--color-brand-text-mid)]">
                        · {formatTime(o.start_time)} – {formatTime(o.end_time)}
                      </span>
                    ) : (
                      <span className="ml-2 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-900">
                        Full day off
                      </span>
                    )}
                  </p>
                  {o.reason ? (
                    <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                      {o.reason}
                    </p>
                  ) : null}
                </div>
                <DeleteOverrideButton
                  physicianId={id}
                  overrideId={o.id}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 border-t border-[color:var(--color-brand-bg-mid)] pt-6">
          <p className="mb-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
            Add an override
          </p>
          <AddOverrideForm physicianId={id} />
        </div>
      </section>
    </div>
  );
}

import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export const metadata = { title: "Physicians — staff" };

export const dynamic = "force-dynamic";

export default async function PhysiciansAdminPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: physicians } = await admin
    .from("physicians")
    .select("id, slug, full_name, specialty, group_label, is_active, display_order")
    .order("is_active", { ascending: false })
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });

  // Pull recurring counts so admin can see at a glance who's by-appointment
  // only (zero rows = filtered out of online booking).
  const ids = (physicians ?? []).map((p) => p.id);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: rows } = await admin
      .from("physician_schedules")
      .select("physician_id")
      .in("physician_id", ids);
    for (const r of rows ?? []) {
      counts.set(r.physician_id, (counts.get(r.physician_id) ?? 0) + 1);
    }
  }

  const active = (physicians ?? []).filter((p) => p.is_active);
  const inactive = (physicians ?? []).filter((p) => !p.is_active);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 9 · Admin
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Physicians
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Roster shown on the public /physicians page. Physicians with
            zero recurring schedule blocks are listed for info but
            filtered out of the online booking picker.
          </p>
        </div>
        <Link
          href="/staff/admin/physicians/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New physician
        </Link>
      </header>

      <Section
        title={`Active (${active.length})`}
        rows={active}
        counts={counts}
      />
      {inactive.length > 0 ? (
        <Section
          title={`Inactive (${inactive.length})`}
          rows={inactive}
          counts={counts}
          muted
        />
      ) : null}
    </div>
  );
}

interface Row {
  id: string;
  slug: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  is_active: boolean;
  display_order: number;
}

const UNGROUPED_LABEL = "Ungrouped";

function Section({
  title,
  rows,
  counts,
  muted = false,
}: {
  title: string;
  rows: Row[];
  counts: Map<string, number>;
  muted?: boolean;
}) {
  // Group rows by group_label preserving the rows' arrival order so the
  // "first group seen first" stays consistent across the page.
  const groups: Array<{ label: string; rows: Row[] }> = [];
  for (const r of rows) {
    const label = r.group_label?.trim() || UNGROUPED_LABEL;
    const existing = groups.find((g) => g.label === label);
    if (existing) existing.rows.push(r);
    else groups.push({ label, rows: [r] });
  }

  return (
    <section className="mt-2">
      <h2 className="font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 text-sm text-[color:var(--color-brand-text-soft)]">
          No physicians yet.
        </p>
      ) : (
        <div
          className={`mt-2 grid gap-4 ${muted ? "opacity-60" : ""}`}
        >
          {groups.map((g) => (
            <div key={g.label}>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                {g.label} · {g.rows.length}
              </p>
              <ul className="divide-y divide-[color:var(--color-brand-bg-mid)] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
                {g.rows.map((p) => {
                  const blocks = counts.get(p.id) ?? 0;
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-[color:var(--color-brand-navy)]">
                          {p.full_name}
                        </p>
                        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {p.specialty}
                          {" · "}
                          {blocks > 0 ? (
                            <span className="font-semibold text-emerald-700">
                              {blocks} schedule{blocks === 1 ? "" : "s"}
                            </span>
                          ) : (
                            <span className="font-semibold text-amber-700">
                              by appointment only
                            </span>
                          )}
                        </p>
                      </div>
                      <Link
                        href={`/staff/admin/physicians/${p.id}/edit`}
                        className="shrink-0 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
                      >
                        Edit
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

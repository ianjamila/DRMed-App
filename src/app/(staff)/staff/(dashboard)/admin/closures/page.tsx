import { createClient } from "@/lib/supabase/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ClosuresClient } from "./closures-client";

export const metadata = {
  title: "Closures — staff",
};

export const dynamic = "force-dynamic";

export default async function ClosuresAdminPage() {
  await requireAdminStaff();
  const supabase = await createClient();

  // Show today onward; past closures aren't useful for the slot picker.
  const todayISO = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const { data: closures } = await supabase
    .from("clinic_closures")
    .select("closed_on, reason, created_at, created_by")
    .gte("closed_on", todayISO)
    .order("closed_on", { ascending: true });

  // Fetch the names of the staff who created each closure.
  const creatorIds = Array.from(
    new Set((closures ?? []).map((c) => c.created_by).filter(Boolean)),
  ) as string[];
  const creatorMap = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: profiles } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", creatorIds);
    for (const p of profiles ?? []) creatorMap.set(p.id, p.full_name);
  }

  // For each closure date, count appointments that would be affected by
  // a bulk reschedule (status confirmed/arrived with a real scheduled_at
  // landing on that Manila day). Patients with pending_callback are
  // already awaiting a reception call, so they're excluded.
  const affectedByDate = new Map<string, number>();
  for (const c of closures ?? []) {
    const startIso = `${c.closed_on}T00:00:00+08:00`;
    const next = new Date(startIso);
    next.setUTCDate(next.getUTCDate() + 1);
    const { count } = await supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .gte("scheduled_at", startIso)
      .lt("scheduled_at", next.toISOString())
      .in("status", ["confirmed", "arrived"]);
    affectedByDate.set(c.closed_on, count ?? 0);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Clinic closures
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Days the clinic is closed — Philippine public holidays plus ad-hoc
          closures (staff training, brownout, etc). The public booking slot
          picker reads this list and greys out matching dates.
        </p>
      </header>

      <ClosuresClient
        initialClosures={(closures ?? []).map((c) => ({
          closed_on: c.closed_on,
          reason: c.reason,
          created_at: c.created_at,
          created_by_name: c.created_by
            ? creatorMap.get(c.created_by) ?? null
            : null,
          affected_count: affectedByDate.get(c.closed_on) ?? 0,
        }))}
      />
    </div>
  );
}

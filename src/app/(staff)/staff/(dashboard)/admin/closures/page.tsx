import { createClient } from "@/lib/supabase/server";
// The RPC below is service_role-only by design (0184) — this page is
// already admin-gated by requireAdminStaff().
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ClosuresClient } from "./closures-client";
import { ROUTE_NAME } from "@/lib/staff/route-names";

export const metadata = {
  title: ROUTE_NAME["/staff/admin/closures"],
};

export const dynamic = "force-dynamic";

export default async function ClosuresAdminPage() {
  const session = await requireAdminStaff();
  const supabase = await createClient();
  const admin = createAdminClient();

  // Show today onward; past closures aren't useful for the slot picker.
  const todayISO = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const { data: closureRows } = await supabase
    .from("clinic_closures")
    .select("closed_on, reason, created_at, created_by")
    .gte("closed_on", todayISO)
    .order("closed_on", { ascending: true });
  const upcoming = closureRows ?? [];

  // Fetch the names of the staff who created each closure.
  const creatorIds = Array.from(
    new Set(upcoming.map((c) => c.created_by).filter(Boolean)),
  ) as string[];
  const creatorMap = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: profiles } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", creatorIds);
    for (const p of profiles ?? []) creatorMap.set(p.id, p.full_name);
  }

  // For each closure date, preview exactly what a bulk reschedule would do —
  // the same reschedule_closure_appointments RPC (0184) in dry-run mode, so
  // this number is never higher than what the button actually moves (the
  // old hand-rolled count included deleted/merged patients' appointments,
  // which the action always skips).
  const previews = await Promise.all(
    upcoming.map(async (c) => {
      const { data, error } = await admin.rpc("reschedule_closure_appointments", {
        p_closed_on: c.closed_on,
        p_actor: session.user_id,
        p_dry_run: true,
      });
      const r = data as { affected: number; skipped_inactive: number } | null;
      return { closedOn: c.closed_on, affected: error || !r ? null : r.affected, skippedInactive: r?.skipped_inactive ?? 0 };
    }),
  );
  const affectedByDate = new Map(previews.map((p) => [p.closedOn, p.affected]));
  const skippedInactiveByDate = new Map(previews.map((p) => [p.closedOn, p.skippedInactive]));

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {ROUTE_NAME["/staff/admin/closures"]}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Days the clinic is closed — Philippine public holidays plus ad-hoc
          closures (staff training, brownout, etc). The public booking slot
          picker reads this list and greys out matching dates.
        </p>
      </header>

      <ClosuresClient
        initialClosures={upcoming.map((c) => ({
          closed_on: c.closed_on,
          reason: c.reason,
          created_at: c.created_at,
          created_by_name: c.created_by
            ? creatorMap.get(c.created_by) ?? null
            : null,
          affected_count: affectedByDate.get(c.closed_on) ?? null,
          skipped_inactive: skippedInactiveByDate.get(c.closed_on) ?? 0,
        }))}
      />
    </div>
  );
}

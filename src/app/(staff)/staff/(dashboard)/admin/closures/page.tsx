import { createClient } from "@/lib/supabase/server";
// The Affected preview reads appointments with their patient rows through the
// service-role client so it sees exactly what the SECURITY DEFINER
// reschedule_closure_appointments RPC (0184) sees — an RLS-hidden patient row
// would otherwise read as "left alone". This page is admin-gated by
// requireAdminStaff().
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { manilaRangeUtc } from "@/lib/dates/manila";
import { reportError } from "@/lib/observability/report-error";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  CLOSURE_RESCHEDULE_STATUSES,
  closurePreviewCounts,
  type ClosurePreview,
  type ClosurePreviewRow,
} from "@/lib/appointments/closure-preview";
import { ClosuresClient } from "./closures-client";
import { ROUTE_NAME } from "@/lib/staff/route-names";

export const metadata = {
  title: ROUTE_NAME["/staff/admin/closures"],
};

export const dynamic = "force-dynamic";

export default async function ClosuresAdminPage() {
  await requireAdminStaff();
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

  // Preview what "Reschedule all" would do on every closed day from ONE
  // appointments read (was one dry-run RPC call per upcoming closure, with no
  // limit). closurePreviewCounts applies the RPC's own dry-run rules —
  // closure-preview.test.ts pins them to its SQL — so this number is never
  // higher than what the button actually moves. On a read error, or a window
  // past the row ceiling, every count is unknown (null) rather than short.
  const previews = await loadClosurePreviews(admin, upcoming.map((c) => c.closed_on));

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
          affected_count: previews?.get(c.closed_on)?.affected ?? null,
          skipped_inactive: previews?.get(c.closed_on)?.skippedInactive ?? 0,
        }))}
      />
    </div>
  );
}

async function loadClosurePreviews(
  admin: ReturnType<typeof createAdminClient>,
  closedOn: string[],
): Promise<Map<string, ClosurePreview> | null> {
  if (closedOn.length === 0) return new Map();
  // upcoming is ordered by closed_on, so the first and last bound the window.
  const { fromIso, toIso } = manilaRangeUtc(closedOn[0], closedOn[closedOn.length - 1]);
  if (!fromIso || !toIso) return null;
  try {
    const { rows, truncated } = await fetchAllRows<ClosurePreviewRow>(
      (from, to) =>
        admin
          .from("appointments")
          .select("scheduled_at, patient_id, patients(deleted_at, merged_into_id)")
          .in("status", [...CLOSURE_RESCHEDULE_STATUSES])
          .gte("scheduled_at", fromIso)
          .lt("scheduled_at", toIso)
          .order("id")
          .range(from, to),
      REPORT_EXPORT_MAX_ROWS,
    );
    return truncated ? null : closurePreviewCounts(closedOn, rows);
  } catch (error) {
    void reportError({ scope: "admin/closures/preview", error });
    return null;
  }
}

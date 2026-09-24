import { PageHeader } from "@/components/staff/page-header";
import { PlainTh } from "@/components/staff/sortable-th";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { manilaDateTime } from "@/lib/dates/manila";
import { CRON_HEARTBEATS, deriveCronStatus } from "@/lib/ops/cron-heartbeats";
import { ROUTE_NAME } from "@/lib/staff/route-names";

export const metadata = { title: ROUTE_NAME["/staff/admin/operations/cron-health"] };
export const dynamic = "force-dynamic";

const STATUS_STYLE = {
  healthy: "bg-emerald-100 text-emerald-900",
  pending: "bg-slate-200 text-slate-700",
  stale: "bg-amber-100 text-amber-900",
  unavailable: "bg-red-100 text-red-900",
};

export default async function CronHealthPage() {
  await requireAdminStaff();
  const supabase = await createClient();
  const rows = await Promise.all(CRON_HEARTBEATS.map(async (cron) => {
    // One latest row per leg, not a capped shared audit scan that can hide a quiet leg.
    const { data, error } = await supabase
      .from("audit_log")
      .select("created_at")
      .eq("actor_type", "system")
      .in("action", [...cron.actions])
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    return { cron, lastSeen: data?.created_at ?? null, failed: !!error };
  }));
  const checkedAt = new Date();
  const now = checkedAt.getTime();

  // Not a Daily Monitoring view: this page sits beside the (daily-monitoring)
  // route group, so it gets no period tab bar and owns its own padding.
  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title={ROUTE_NAME["/staff/admin/operations/cron-health"]}
        subtitle="Latest recorded runs of the clinic’s scheduled tasks. All timestamps are in Manila time."
      />
      <p className="mb-4 text-sm text-[color:var(--color-brand-text-soft)]">
        Healthy means a recent run was recorded. Pending means no run has been recorded yet,
        but the initial monitoring grace period has not ended; it does not indicate a failure.
        Stale means the last run is overdue, or no run was recorded by the grace-period deadline.
        A recorded run confirms the task ran, not that every item it processed succeeded.
      </p>
      <p className="mb-4 text-sm text-[color:var(--color-brand-text-soft)]">
        Checked at {manilaDateTime(checkedAt)}. Reload this page to check again.
      </p>
      {rows.some((row) => row.failed) ? (
        <p role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Some heartbeat records could not be loaded. Their status is unavailable. Please try again.
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <PlainTh label="Scheduled Task" />
              <PlainTh label="Status" />
              <PlainTh label="Last Seen (Manila)" />
              <PlainTh label="Age" />
              <PlainTh label="Allowed Age" />
              <PlainTh label="Grace Period Ends (Manila)" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.map(({ cron, lastSeen, failed }) => {
              const status = failed ? "unavailable" : deriveCronStatus(lastSeen, now, cron.maxAge, cron.activeFrom);
              return (
                <tr key={cron.key} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">{cron.label}</div>
                    <div className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">{cron.description}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md px-2 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLE[status]}`}>{status}</span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{failed ? "Unavailable" : lastSeen ? manilaDateTime(lastSeen) : "No recorded run"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{!failed && lastSeen ? `${((now - Date.parse(lastSeen)) / 3_600_000).toFixed(1)} hours` : "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{cron.maxAge / 3_600_000} hours</td>
                  <td className="px-4 py-3 whitespace-nowrap">{manilaDateTime(`${cron.activeFrom}T00:00:00Z`)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

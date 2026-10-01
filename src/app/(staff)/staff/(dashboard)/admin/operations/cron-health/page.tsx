import { PageHeader } from "@/components/staff/page-header";
import { PlainTh } from "@/components/staff/sortable-th";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { manilaDateTime } from "@/lib/dates/manila";
import { createAdminClient } from "@/lib/supabase/admin";
import { CRON_HEARTBEATS, deriveCronStatus, isNoticeSweepWatched } from "@/lib/ops/cron-heartbeats";
import { describeCronSchedule } from "@/lib/ops/cron-schedule";
import { ROUTE_NAME } from "@/lib/staff/route-names";
import { fetchOutboxCounts } from "@/lib/results/release-notice-followups.server";
import { OutboxHealthPanel } from "./outbox-health-panel";
import { skipReasonLabel, skipSenderLabel } from "@/lib/notifications/skip-labels";

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
    let query = supabase
      .from("audit_log")
      .select("created_at")
      .eq("actor_type", "system")
      .in("action", [...cron.actions]);
    // sheet-sync's "Sync now" / CLI runs also audit actor_type 'system' (run.ts)
    // — requireTrigger keeps a manual/CLI run from masking a stopped cron here too.
    if ("requireTrigger" in cron) query = query.eq("metadata->>trigger", cron.requireTrigger);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    return { cron, lastSeen: data?.created_at ?? null, failed: !!error };
  }));
  const checkedAt = new Date();
  const now = checkedAt.getTime();
  // release_notice_settings is service_role-only; this page is already admin-gated.
  // A failed read counts as OFF (the strict-flag rule), so the sweeper reads as not watched.
  const { data: noticeFlag } = await createAdminClient()
    .from("release_notice_settings")
    .select("enabled, updated_at")
    .eq("id", true)
    .maybeSingle();
  const outbox = await fetchOutboxCounts(now);
  const noticeWatched = isNoticeSweepWatched(noticeFlag?.enabled === true, noticeFlag?.updated_at ?? null, now);

  // Function is SECURITY INVOKER: audit_log's RLS (admin-only SELECT) decides
  // who sees anything, so this must run through the signed-in admin's
  // RLS-scoped client, never the admin client.
  const { data: skips, error: skipsError } = await supabase.rpc("notification_skip_summary");

  // Not a Daily Monitoring view: this page sits beside the (daily-monitoring)
  // route group, so it gets no period tab bar and owns its own padding.
  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title={ROUTE_NAME["/staff/admin/operations/cron-health"]}
        subtitle="Latest recorded runs of the clinic's scheduled tasks, and patient messages that were not sent. All timestamps are in Manila time."
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
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <PlainTh label="Scheduled Task" />
              <PlainTh label="Runs (Manila)" />
              <PlainTh label="Status" />
              <PlainTh label="Last Seen (Manila)" />
              <PlainTh label="Age" />
              <PlainTh label="Allowed Age" />
              <PlainTh label="Grace Period Ends (Manila)" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.map(({ cron, lastSeen, failed }) => {
              const status = failed ? "unavailable" : deriveCronStatus(lastSeen, now, cron.maxAge, cron.activeFrom, "watchWhen" in cron ? noticeWatched : true);
              return (
                <tr key={cron.key} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-[color:var(--color-brand-navy)]">{cron.label}</div>
                    <div className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">{cron.description}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{describeCronSchedule(cron.schedule)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md px-2 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLE[status]}`}>{status}</span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{failed ? "Unavailable" : lastSeen ? manilaDateTime(lastSeen) : "watchWhen" in cron && !noticeWatched ? "Not watched while switched off" : "No recorded run"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{!failed && lastSeen ? `${((now - Date.parse(lastSeen)) / 3_600_000).toFixed(1)} hours` : "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{cron.maxAge / 3_600_000} hours</td>
                  <td className="px-4 py-3 whitespace-nowrap">{manilaDateTime(`${cron.activeFrom}T00:00:00Z`)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <OutboxHealthPanel enabled={noticeFlag?.enabled === true} counts={outbox.ok ? outbox.counts : null} now={now} />
      <section className="mt-10" aria-labelledby="skipped-messages-heading">
        <h2 id="skipped-messages-heading" className="text-lg font-bold text-[color:var(--color-brand-navy)]">
          Patient messages not sent
        </h2>
        <p className="mb-3 mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Result, booking and reminder messages the clinic did not send because the patient record was deleted,
          merged or could not be checked. These are the skips that were recorded — if the database was down, a
          check can fail without leaving a record (those are also reported to the error monitor).
        </p>
        {skipsError ? (
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            The skipped-message counts could not be loaded. Please try again.
          </p>
        ) : !skips || skips.length === 0 ? (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">None in the last 30 days.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <PlainTh label="Message" />
                  <PlainTh label="Why It Was Not Sent" />
                  <PlainTh label="Last 7 Days" />
                  <PlainTh label="Last 30 Days" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {skips.map((s) => (
                  <tr key={`${s.sender}:${s.reason}`}>
                    <td className="px-4 py-3">{skipSenderLabel(s.sender)}</td>
                    <td className="px-4 py-3">{skipReasonLabel(s.reason)}</td>
                    <td className="px-4 py-3 tabular-nums">{s.skipped_7d}</td>
                    <td className="px-4 py-3 tabular-nums">{s.skipped_30d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

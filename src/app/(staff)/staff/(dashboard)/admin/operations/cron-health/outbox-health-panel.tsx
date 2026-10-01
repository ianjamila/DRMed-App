import Link from "next/link";
import { evaluateOutboxHealth, type OutboxCounts, type OutboxStatus } from "@/lib/results/release-notice-health";

// Cron Health's "Result-ready messages (outbox)" card (0210/0212/0214). Counts
// only — never a patient's name, phone or email (RA 10173). The status words and
// colours mirror the scheduled-task table above it.

const PILL: Record<OutboxStatus | "unavailable", { label: string; className: string }> = {
  ok: { label: "Healthy", className: "bg-emerald-100 text-emerald-900" },
  warning: { label: "Warning", className: "bg-amber-100 text-amber-900" },
  problem: { label: "Problem", className: "bg-red-100 text-red-900" },
  off: { label: "Switched off", className: "bg-slate-200 text-slate-700" },
  unavailable: { label: "Unavailable", className: "bg-red-100 text-red-900" },
};

export function OutboxHealthPanel({ enabled, counts, now }: { enabled: boolean; counts: OutboxCounts | null; now: number }) {
  const health = counts ? evaluateOutboxHealth({ enabled, counts, now }) : null;
  const pill = PILL[health ? health.status : "unavailable"];
  const stat = (label: string, value: string, id: string) => (
    <div key={id} data-stat={id}>
      <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums text-[color:var(--color-brand-navy)]">{value}</dd>
    </div>
  );

  return (
    <section className="mt-10" aria-labelledby="outbox-health-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="outbox-health-heading" className="text-lg font-bold text-[color:var(--color-brand-navy)]">
          Result-ready messages (outbox)
        </h2>
        <span data-testid="outbox-status" className={`rounded-md px-2 py-0.5 text-xs font-semibold uppercase ${pill.className}`}>{pill.label}</span>
      </div>
      <p className="mb-3 mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        The &quot;your result is ready&quot; emails and texts queued when results are released. The sender runs every 5
        minutes and retries on its own. This shows whether the queue is draining. Counts only, no patient details.
      </p>
      {!health || !counts ? (
        <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The outbox counts could not be loaded. Please try again.
        </p>
      ) : (
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
          {health.reasons.length > 0 ? (
            <ul
              role={health.status === "problem" ? "alert" : undefined}
              className={`mb-4 list-disc space-y-1 rounded-lg border px-8 py-3 text-sm ${
                health.status === "problem"
                  ? "border-red-300 bg-red-50 text-red-900"
                  : health.status === "warning"
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : "border-slate-300 bg-slate-50 text-slate-700"
              }`}
            >
              {health.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
            {stat("Waiting to send", String(counts.queued), "queued")}
            {stat("Past due", String(counts.overdue), "overdue")}
            {stat("Oldest past due", health.oldestOverdueMinutes === null ? "—" : `${health.oldestOverdueMinutes} min`, "oldest-overdue")}
            {stat("Stuck mid-send", String(counts.expiredLeases), "expired-leases")}
            {stat("Given up, 24 hours", String(counts.abandoned24h), "abandoned-24h")}
            {stat("Given up, 7 days", String(counts.abandoned7d), "abandoned-7d")}
            {stat("Sent, 24 hours", String(counts.sent24h), "sent-24h")}
          </dl>
          <p className="mt-4 text-sm">
            <Link href="/staff/result-follow-ups" className="font-semibold text-[color:var(--color-brand-navy)] underline">
              Open Result Follow-ups to see messages that did not go out
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}

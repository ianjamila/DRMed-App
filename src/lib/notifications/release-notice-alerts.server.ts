import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { fetchOutboxCounts } from "@/lib/results/release-notice-followups.server";
import { evaluateOutboxHealth, shouldAlertBacklog } from "@/lib/results/release-notice-health";
import type { SweepSummary } from "./release-notice-sweep";

// Active "needs attention" signals from the release-notice sweep (0210/0212).
// Both go through reportError (Sentry + a system.error audit row in production),
// with COUNTS ONLY — no patient identity, address or notice id.
//
// - abandoned: fires once per run that gave up on >= 1 notice. A notice is
//   abandoned exactly once, so this cannot repeat for the same notice.
// - backlog: fires when the outbox reads `problem` (oldest overdue > 2 h, or an
//   expired lease > 30 min). A problem persists across runs, so it is de-duplicated
//   against the system.error rows this same scope already wrote: at most one alert
//   per BACKLOG_ALERT_COOLDOWN_MS. The audit row is only written in production; in
//   development the cooldown never engages, which is harmless.
//
// This is best effort and never throws: the sweep's own result must not depend on it.

export const ABANDONED_SCOPE = "cron/release-notices:abandoned";
export const BACKLOG_SCOPE = "cron/release-notices:backlog";
export const BACKLOG_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

async function backlogAlertedRecently(now: number): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("audit_log")
    .select("created_at")
    .eq("actor_type", "system")
    .eq("action", "system.error")
    .eq("resource_type", BACKLOG_SCOPE)
    .gte("created_at", new Date(now - BACKLOG_ALERT_COOLDOWN_MS).toISOString())
    .limit(1);
  // A failed read alerts: staying silent on doubt could hide a real outage.
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

export async function alertOnSweep(summary: Pick<SweepSummary, "enabled" | "abandoned">, now: number = Date.now()): Promise<void> {
  try {
    if (summary.abandoned > 0) {
      await reportError({
        scope: ABANDONED_SCOPE,
        error: new Error(`${summary.abandoned} result-ready message(s) were given up on in this run and need a manual follow-up`),
        metadata: { abandoned: summary.abandoned },
      });
    }

    if (summary.enabled !== true) return;
    const read = await fetchOutboxCounts(now);
    if (!read.ok) return;
    const health = evaluateOutboxHealth({ enabled: true, counts: read.counts, now });
    if (health.status !== "problem") return;
    if (!shouldAlertBacklog(health.status, await backlogAlertedRecently(now))) return;
    await reportError({
      scope: BACKLOG_SCOPE,
      error: new Error("The result-ready message outbox is not draining"),
      metadata: {
        overdue: read.counts.overdue,
        queued: read.counts.queued,
        oldest_overdue_minutes: health.oldestOverdueMinutes,
        expired_leases: read.counts.expiredLeases,
        oldest_expired_lease_minutes: health.oldestExpiredLeaseMinutes,
        abandoned_24h: read.counts.abandoned24h,
      },
    });
  } catch (err) {
    console.error("[cron/release-notices] alert check failed", err);
  }
}

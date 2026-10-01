// Health of the result-ready "release notice" outbox (0210/0212/0214), judged
// from counts alone. Pure: no database, no clock of its own. The Cron Health
// panel and the sweep route both use it, so the page and the alert agree.
//
// "Overdue" = a pending / retry notice whose next_attempt_at has passed (the
// sweeper should already have claimed it). A notice waiting out its retry
// back-off (next_attempt_at in the future) is NOT overdue: that is healthy.

export const OVERDUE_WARNING_MS = 30 * 60 * 1000;
export const OVERDUE_PROBLEM_MS = 2 * 60 * 60 * 1000;
/** A lease lasts 3 minutes and the sweep runs every 5, so a lease expired this long means the reclaim is not happening. */
export const EXPIRED_LEASE_WARNING_MS = 10 * 60 * 1000;
export const EXPIRED_LEASE_PROBLEM_MS = 30 * 60 * 1000;

export interface OutboxCounts {
  /** Everything waiting to be sent: pending + retry, due or not. */
  queued: number;
  /** pending / retry rows whose next_attempt_at has passed. */
  overdue: number;
  oldestOverdueAt: string | null;
  /** `sending` rows whose lease has expired. */
  expiredLeases: number;
  oldestExpiredLeaseAt: string | null;
  abandoned24h: number;
  abandoned7d: number;
  sent24h: number;
}

export type OutboxStatus = "ok" | "warning" | "problem" | "off";

export interface OutboxHealth {
  status: OutboxStatus;
  /** Plain-English reasons, worst first. Empty when ok. Counts only: never a patient detail. */
  reasons: string[];
  oldestOverdueMinutes: number | null;
  oldestExpiredLeaseMinutes: number | null;
}

const minutesSince = (iso: string | null, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : null;
};
const ageMs = (iso: string | null, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : null;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const duration = (min: number) => (min >= 120 ? `${Math.floor(min / 60)} hours` : `${min} minutes`);

export function evaluateOutboxHealth(input: { enabled: boolean; counts: OutboxCounts; now: number }): OutboxHealth {
  const { enabled, counts, now } = input;
  const oldestOverdueMinutes = counts.overdue > 0 ? minutesSince(counts.oldestOverdueAt, now) : null;
  const oldestExpiredLeaseMinutes = counts.expiredLeases > 0 ? minutesSince(counts.oldestExpiredLeaseAt, now) : null;

  if (!enabled) {
    return {
      status: "off",
      reasons: ["The result-ready message outbox is switched off, so nothing is being sent and waiting messages are expected."],
      oldestOverdueMinutes,
      oldestExpiredLeaseMinutes,
    };
  }

  const problems: string[] = [];
  const warnings: string[] = [];

  const overdueAge = counts.overdue > 0 ? ageMs(counts.oldestOverdueAt, now) : null;
  if (overdueAge !== null && overdueAge > OVERDUE_PROBLEM_MS) {
    problems.push(`${plural(counts.overdue, "message has", "messages have")} been waiting to send for more than 2 hours (the oldest for ${duration(oldestOverdueMinutes ?? 0)}). The sender may not be running.`);
  } else if (overdueAge !== null && overdueAge > OVERDUE_WARNING_MS) {
    warnings.push(`${plural(counts.overdue, "message is", "messages are")} past due, the oldest by more than 30 minutes. It should have been sent within about 5 minutes.`);
  }

  const leaseAge = counts.expiredLeases > 0 ? ageMs(counts.oldestExpiredLeaseAt, now) : null;
  if (leaseAge !== null && leaseAge > EXPIRED_LEASE_PROBLEM_MS) {
    problems.push(`${plural(counts.expiredLeases, "message was", "messages were")} being sent when the sender stopped, more than 30 minutes ago, and not picked up again.`);
  } else if (leaseAge !== null && leaseAge > EXPIRED_LEASE_WARNING_MS) {
    warnings.push(`${plural(counts.expiredLeases, "message was", "messages were")} being sent when the sender stopped, more than 10 minutes ago, and not picked up again yet.`);
  }

  if (counts.abandoned24h > 0) {
    warnings.push(`${plural(counts.abandoned24h, "message was", "messages were")} given up on in the last 24 hours. The patient was not told; see Result Follow-ups.`);
  }

  const status: OutboxStatus = problems.length > 0 ? "problem" : warnings.length > 0 ? "warning" : "ok";
  return { status, reasons: [...problems, ...warnings], oldestOverdueMinutes, oldestExpiredLeaseMinutes };
}

/** The backlog alert fires only on `problem`, and not again while a recent alert for it exists. */
export function shouldAlertBacklog(status: OutboxStatus, alertedRecently: boolean): boolean {
  return status === "problem" && !alertedRecently;
}

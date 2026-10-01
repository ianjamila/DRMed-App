import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { loadAuditTests, sendReleaseNotice } from "./release-notice-sender";
import { auditTerminalNotice } from "./release-notice-audit";
import type { ReleaseNoticeRow } from "./release-notice-types";

// One sweep of the release-notice outbox (0210/0212), run by
// /api/cron/release-notices every 5 minutes (a Supabase pg_cron job through
// pg_net, see 0212): claim the due notices, send each, then audit any terminal
// notice that never got its audit row. Does nothing while the strict flag is off.

// Sizing: a provider call is bounded to 15 s (email.ts / sms.ts), so one row takes
// at most ~15 s (email and SMS run in parallel). 8 rows at concurrency 4 are two
// waves = ~30 s worst case, inside the 40 s deadline and the route's 60 s
// maxDuration. Claiming FEWER rows was chosen over finishing unstarted rows back
// to retry because finish_release_notice always counts an attempt: a row that was
// claimed but never started would burn one of its six attempts for nothing.
export const SWEEP_CLAIM_LIMIT = 8;
export const SWEEP_CONCURRENCY = 4;
/** No new row is started after this. With the sizing above it is a safety net, not a path. */
export const SWEEP_DEADLINE_MS = 40_000;
/** The audit pass looks at this many of the OLDEST and this many of the NEWEST un-audited terminal rows. */
export const SWEEP_AUDIT_WINDOW = 25;
/** A terminal row younger than this still belongs to the sender that just finished it. */
export const AUDIT_GRACE_MS = 2 * 60 * 1000;

export interface SweepSummary {
  enabled: boolean;
  claimed: number;
  sent: number;
  skipped: number;
  suppressed: number;
  cancelled: number;
  retried: number;
  abandoned: number;
  /** Lost the lease or could not finish: the lease expires and a later sweep reclaims it. */
  deferred: number;
  /** Terminal notices found without their audit row. */
  audit_pending: number;
  audited: number;
  failures: number;
}

const empty = (enabled: boolean): SweepSummary => ({
  enabled, claimed: 0, sent: 0, skipped: 0, suppressed: 0, cancelled: 0, retried: 0, abandoned: 0,
  deferred: 0, audit_pending: 0, audited: 0, failures: 0,
});

/** Runs fn over items with bounded concurrency; once `deadline` has passed no new item starts (its slot stays undefined). */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, deadline = Infinity): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return;
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The strict flag read. Only an explicit `true` is ON, but a read that ERRORS is a
 * failure, not "off": it throws, so the route answers 500 and writes no heartbeat
 * (a broken flag read must not look like a healthy, switched-off sweeper).
 */
export async function readOutboxEnabled(): Promise<boolean> {
  const flag = await createAdminClient().rpc("release_notices_enabled");
  if (flag.error) throw new Error(`release_notices_enabled failed: ${flag.error.message}`);
  return flag.data === true;
}

export const emptySweepSummary = empty;

/** Runs one sweep. Throws only when the claim itself fails (the route turns that into a 500). */
export async function runReleaseNoticeSweep(): Promise<SweepSummary> {
  const admin = createAdminClient();

  const startedAt = Date.now();
  const deadline = startedAt + SWEEP_DEADLINE_MS;
  if (!(await readOutboxEnabled())) return empty(false);

  const summary = empty(true);

  const claim = await admin.rpc("claim_release_notice", { p_limit: SWEEP_CLAIM_LIMIT });
  if (claim.error) throw new Error(`claim_release_notice failed: ${claim.error.message}`);
  const claimed = (claim.data ?? []) as ReleaseNoticeRow[];
  summary.claimed = claimed.length;

  const results = await mapBounded(claimed, SWEEP_CONCURRENCY, (row) => sendReleaseNotice(row), deadline);
  for (const r of results) {
    if (r === undefined) { summary.deferred += 1; continue; } // never started: its lease expires and a later sweep reclaims it
    switch (r.finalStatus) {
      case "sent": summary.sent += 1; break;
      case "skipped": summary.skipped += 1; break;
      case "suppressed": summary.suppressed += 1; break;
      case "cancelled": summary.cancelled += 1; break;
      case "retry": summary.retried += 1; break;
      case "abandoned": summary.abandoned += 1; break;
      case "fenced": summary.deferred += 1; break;
      default: summary.failures += 1; // "error"
    }
  }

  // Terminal notices whose audit row never got written: a crash between
  // finish and the audit, or an exhausted lease the claim closed as abandoned.
  // Head-of-line safety, with no schema change: a row whose audit keeps failing
  // would sit at the front of a plain oldest-first scan for ever and starve newer
  // rows. So each sweep takes the oldest AND the newest few; the newest window
  // keeps draining the queue however many oldest rows are stuck.
  const cutoff = new Date(Date.now() - AUDIT_GRACE_MS).toISOString();
  const window = (ascending: boolean) =>
    admin
      .from("release_notices")
      .select("*")
      .not("resolved_at", "is", null)
      .is("audited_at", null)
      .lte("resolved_at", cutoff)
      .order("resolved_at", { ascending })
      .order("id", { ascending: true })
      .limit(SWEEP_AUDIT_WINDOW);
  const [oldest, newest] = await Promise.all([window(true), window(false)]);
  const failed = oldest.error ?? newest.error;
  if (failed) {
    await reportError({ scope: "cron/release-notices:audit-query", error: new Error(failed.message) });
    summary.failures += 1;
    return summary;
  }
  const byId = new Map<string, ReleaseNoticeRow>();
  for (const r of [...(oldest.data ?? []), ...(newest.data ?? [])] as ReleaseNoticeRow[]) byId.set(r.id, r);
  const rows = [...byId.values()];
  summary.audit_pending = rows.length;
  const audited = await mapBounded(rows, SWEEP_CONCURRENCY, async (row) => {
    // A sent / channel-skipped notice is re-audited with the lab-only names and
    // ids the live send used (a rebuilt audit has no live context).
    const tests = row.status === "sent" || row.status === "skipped" ? await loadAuditTests(admin, row) : null;
    return auditTerminalNotice(admin, row, undefined, tests ?? undefined);
  }, deadline);
  for (const a of audited) {
    if (a === undefined) continue; // past the deadline: picked up next sweep
    if (a === "stamped" || a === "already_audited") summary.audited += 1;
    else summary.failures += 1;
  }
  return summary;
}

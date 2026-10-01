import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { sendReleaseNotice } from "./release-notice-sender";
import { auditTerminalNotice } from "./release-notice-audit";
import type { ReleaseNoticeRow } from "./release-notice-types";

// One sweep of the release-notice outbox (0210/0212), run by
// /api/cron/release-notices every 5 minutes (a Supabase pg_cron job through
// pg_net, see 0212): claim the due notices, send each, then audit any terminal
// notice that never got its audit row. Does nothing while the strict flag is off.

export const SWEEP_CLAIM_LIMIT = 20;
export const SWEEP_CONCURRENCY = 4;
export const SWEEP_AUDIT_LIMIT = 50;
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

async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Runs one sweep. Throws only when the claim itself fails (the route turns that into a 500). */
export async function runReleaseNoticeSweep(): Promise<SweepSummary> {
  const admin = createAdminClient();

  // Strict: only an explicit `true` counts; an error reading the flag is OFF.
  const flag = await admin.rpc("release_notices_enabled");
  if (flag.error || flag.data !== true) return empty(false);

  const summary = empty(true);

  const claim = await admin.rpc("claim_release_notice", { p_limit: SWEEP_CLAIM_LIMIT });
  if (claim.error) throw new Error(`claim_release_notice failed: ${claim.error.message}`);
  const claimed = (claim.data ?? []) as ReleaseNoticeRow[];
  summary.claimed = claimed.length;

  const results = await mapBounded(claimed, SWEEP_CONCURRENCY, (row) => sendReleaseNotice(row));
  for (const r of results) {
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
  const cutoff = new Date(Date.now() - AUDIT_GRACE_MS).toISOString();
  const pending = await admin
    .from("release_notices")
    .select("*")
    .not("resolved_at", "is", null)
    .is("audited_at", null)
    .lte("resolved_at", cutoff)
    .order("resolved_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(SWEEP_AUDIT_LIMIT);
  if (pending.error) {
    await reportError({
      scope: "cron/release-notices:audit-query",
      error: new Error(pending.error.message),
    });
    summary.failures += 1;
    return summary;
  }
  const rows = (pending.data ?? []) as ReleaseNoticeRow[];
  summary.audit_pending = rows.length;
  const audited = await mapBounded(rows, SWEEP_CONCURRENCY, (row) => auditTerminalNotice(admin, row));
  for (const a of audited) {
    if (a === "stamped" || a === "already_audited") summary.audited += 1;
    else summary.failures += 1;
  }
  return summary;
}

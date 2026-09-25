import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

// Daily retention sweep. Enforces the policy table in SECURITY.md:
//
//   - rate_limit_attempts older than 24h are deleted (the sliding window
//     is at most an hour; rows past 24h have no operational use).
//   - visit_pins past expires_at + 90d are hard-deleted. expires_at
//     already excludes them from auth lookups (60-day expiry by default
//     plus a generous 90-day grace before purge so any in-flight audit
//     review still has them on hand).
//   - sheet_sync_review_items with status = 'resolved' (auto-cleared because
//     the sheet stopped reporting the row, or an admin linked/created a
//     patient) more than 90 days old are purged. DISMISSED items are never
//     purged: sheet_sync_upsert_review (0170) treats an open dismissed row
//     as the suppression record that stops the identical item re-opening on
//     every future run, and isSuspectAccepted reads a dismissed
//     suspect_snapshot row the same way to stop re-flagging an
//     already-approved row-count drop — deleting either would resurrect it
//     as a brand-new OPEN item on the next sync.
//   - sheet_mirror_staging rows older than 1 day are purged — belt and
//     braces: sheet_sync_acquire (0170) already sweeps every orphaned
//     staging row (any run not currently 'running' with a live lease) at
//     the start of each new sync attempt, paused or not, so this only
//     fires if no sync has even been attempted since the crash.
//
// Lab results, audit_log, patient rows, and newsletter rows are
// intentionally left alone — see SECURITY.md retention table for why.
//
// Tracks counts for the audit row so admins can see how many rows the
// sweep deleted; a sudden zero or huge spike is a useful signal.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  return withCronMonitor("data-retention", async (markFailed) => {
    const admin = createAdminClient();
    const now = Date.now();

    // 24h-old rate-limit rows.
    const rateCutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const { data: rateDeleted, error: rateErr } = await admin
      .from("rate_limit_attempts")
      .delete()
      .lt("attempted_at", rateCutoff)
      .select("id");

    // visit_pins where expires_at < now - 90d.
    const pinCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: pinsDeleted, error: pinErr } = await admin
      .from("visit_pins")
      .delete()
      .lt("expires_at", pinCutoff)
      .select("visit_id");

    // sheet_sync_review_items RESOLVED (not dismissed) more than 90d ago.
    // A dismissed row is a live suppression record (0170's
    // sheet_sync_upsert_review reads it to stop the identical item
    // re-opening); purging it would resurrect the item as OPEN.
    const reviewCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: sheetReviewDeleted, error: sheetReviewErr } = await admin
      .from("sheet_sync_review_items")
      .delete()
      .eq("status", "resolved")
      .lt("resolved_at", reviewCutoff)
      .select("id");

    // sheet_mirror_staging orphans of a crashed run, older than 1 day.
    const stagingCutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const { data: sheetStagingDeleted, error: sheetStagingErr } = await admin
      .from("sheet_mirror_staging")
      .delete()
      .lt("staged_at", stagingCutoff)
      .select("seq");

    // sheet_sync_runs where status = 'skipped_paused', older than 90d. While
    // the sync stays paused the nightly cron inserts one of these every
    // night forever — a `skipped_paused` run does no other work (run.ts
    // returns right after this row is written, before heartbeat/stage/
    // commit/applyCustomerOps), so nothing else ever points at its id:
    // sheet_sync_changes/sheet_customer_rows/sheet_encounter_lines
    // (run_id NOT NULL, no ON DELETE) and sheet_mirror_staging (ON DELETE
    // CASCADE) never carry a row for it, and reverted_by_run_id is only set
    // by a revert of a run that made real changes. lastGoodRowsRead already
    // ignores this status (`.in("status", ["succeeded","partial"])`).
    const skippedRunsCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: sheetSkippedRunsDeleted, error: sheetSkippedRunsErr } = await admin
      .from("sheet_sync_runs")
      .delete()
      .eq("status", "skipped_paused")
      .lt("started_at", skippedRunsCutoff)
      .select("id");

    const summary = {
      rate_limit_attempts_deleted: rateDeleted?.length ?? 0,
      visit_pins_deleted: pinsDeleted?.length ?? 0,
      sheet_review_items_purged: sheetReviewDeleted?.length ?? 0,
      sheet_staging_purged: sheetStagingDeleted?.length ?? 0,
      sheet_skipped_runs_purged: sheetSkippedRunsDeleted?.length ?? 0,
      rate_cutoff: rateCutoff,
      pin_cutoff: pinCutoff,
      sheet_review_cutoff: reviewCutoff,
      sheet_staging_cutoff: stagingCutoff,
      sheet_skipped_runs_cutoff: skippedRunsCutoff,
      errors: [
        rateErr ? `rate_limit: ${rateErr.message}` : null,
        pinErr ? `visit_pins: ${pinErr.message}` : null,
        sheetReviewErr ? `sheet_sync_review_items: ${sheetReviewErr.message}` : null,
        sheetSkippedRunsErr ? `sheet_sync_runs: ${sheetSkippedRunsErr.message}` : null,
        sheetStagingErr ? `sheet_mirror_staging: ${sheetStagingErr.message}` : null,
      ].filter(Boolean),
    };

    await audit({
      actor_id: null,
      actor_type: "system",
      action: "data_retention.sweep",
      resource_type: null,
      resource_id: null,
      metadata: summary,
    });

    if (rateErr || pinErr || sheetReviewErr || sheetStagingErr || sheetSkippedRunsErr) markFailed();
    return NextResponse.json({
      ok: rateErr === null && pinErr === null && sheetReviewErr === null
        && sheetStagingErr === null && sheetSkippedRunsErr === null,
      ...summary,
    });
  });
}

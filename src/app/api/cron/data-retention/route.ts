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
//   - sheet_sync_review_items resolved/dismissed more than 90 days ago are
//     purged, except dismissed suspect_snapshot items — those are acceptances
//     the sync runner itself reads (isSuspectAccepted) to stop re-flagging an
//     already-approved row-count drop.
//   - sheet_mirror_staging rows older than 1 day are purged — orphans of a
//     sync run that crashed between staging and committing.
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

    // sheet_sync_review_items resolved/dismissed more than 90d ago — keep
    // dismissed suspect_snapshot items, the sync runner reads those back.
    const reviewCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: sheetReviewDeleted, error: sheetReviewErr } = await admin
      .from("sheet_sync_review_items")
      .delete()
      .in("status", ["resolved", "dismissed"])
      .lt("resolved_at", reviewCutoff)
      .neq("kind", "suspect_snapshot")
      .select("id");

    // sheet_mirror_staging orphans of a crashed run, older than 1 day.
    const stagingCutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const { data: sheetStagingDeleted, error: sheetStagingErr } = await admin
      .from("sheet_mirror_staging")
      .delete()
      .lt("staged_at", stagingCutoff)
      .select("seq");

    const summary = {
      rate_limit_attempts_deleted: rateDeleted?.length ?? 0,
      visit_pins_deleted: pinsDeleted?.length ?? 0,
      sheet_review_items_purged: sheetReviewDeleted?.length ?? 0,
      sheet_staging_purged: sheetStagingDeleted?.length ?? 0,
      rate_cutoff: rateCutoff,
      pin_cutoff: pinCutoff,
      sheet_review_cutoff: reviewCutoff,
      sheet_staging_cutoff: stagingCutoff,
      errors: [
        rateErr ? `rate_limit: ${rateErr.message}` : null,
        pinErr ? `visit_pins: ${pinErr.message}` : null,
        sheetReviewErr ? `sheet_sync_review_items: ${sheetReviewErr.message}` : null,
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

    if (rateErr || pinErr || sheetReviewErr || sheetStagingErr) markFailed();
    return NextResponse.json({
      ok: rateErr === null && pinErr === null && sheetReviewErr === null && sheetStagingErr === null,
      ...summary,
    });
  });
}

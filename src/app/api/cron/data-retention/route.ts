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

  const summary = {
    rate_limit_attempts_deleted: rateDeleted?.length ?? 0,
    visit_pins_deleted: pinsDeleted?.length ?? 0,
    rate_cutoff: rateCutoff,
    pin_cutoff: pinCutoff,
    errors: [
      rateErr ? `rate_limit: ${rateErr.message}` : null,
      pinErr ? `visit_pins: ${pinErr.message}` : null,
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

  return NextResponse.json({
    ok: rateErr === null && pinErr === null,
    ...summary,
  });
}

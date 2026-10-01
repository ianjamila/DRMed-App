import { createHash, timingSafeEqual } from "node:crypto";
import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { runReleaseNoticeSweep } from "@/lib/notifications/release-notice-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The release-notice sweeper (0210/0212). NOT a Vercel cron: a Supabase pg_cron
// job (release-notice-sweep, every 5 minutes) POSTs here through pg_net with
// `Authorization: Bearer <CRON_SECRET>`, reading the URL and secret from Vault.
// GET is accepted too so the route can be exercised by hand.
//
// Claims the due notices and sends each (bounded concurrency), then audits any
// terminal notice still missing its audit row. While the strict flag
// (release_notice_settings.enabled) is off it does nothing — but still writes
// its heartbeat, so a quiet run is distinguishable from a dead scheduler.

// Constant-time: both sides are hashed to equal length first.
function bearerMatches(header: string, secret: string): boolean {
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (!bearerMatches(request.headers.get("authorization") ?? "", secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  return withCronMonitor("release-notices", async (markFailed) => {
    let summary;
    try {
      summary = await runReleaseNoticeSweep();
    } catch (err) {
      await reportError({ scope: "cron/release-notices:sweep", error: err });
      return Response.json({ error: "sweep failed" }, { status: 500 });
    }

    // Run heartbeat, including quiet runs with nothing due and runs while off.
    await audit({
      actor_id: null,
      actor_type: "system",
      action: "system.release_notices.sweep.completed",
      metadata: { ...summary },
    });

    if (summary.failures > 0) markFailed();
    return Response.json(summary);
  });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

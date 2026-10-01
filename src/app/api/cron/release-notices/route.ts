import { createHash, timingSafeEqual } from "node:crypto";
import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { reportError } from "@/lib/observability/report-error";
import { writeSweepHeartbeat } from "@/lib/notifications/release-notice-heartbeat";
import { alertOnSweep } from "@/lib/notifications/release-notice-alerts.server";
import { emptySweepSummary, readOutboxEnabled, runReleaseNoticeSweep } from "@/lib/notifications/release-notice-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The release-notice sweeper (0210/0212). NOT a Vercel cron: a Supabase pg_cron
// job (release-notice-sweep, every 5 minutes) POSTs here through pg_net with
// `Authorization: Bearer <CRON_SECRET>`, reading the URL and secret from Vault.
// GET is accepted too so the route can be exercised by hand.
//
// Claims the due notices and sends each (bounded concurrency), then audits any
// terminal notice still missing its audit row. While the strict flag
// (release_notice_settings.enabled) is off it does nothing and writes nothing; while
// it is on, a heartbeat (at most hourly when quiet) distinguishes a quiet run from a
// dead scheduler.

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

  // The strict flag decides everything. A read that ERRORS is a failure (500, no
  // heartbeat, reported) — never "off". While the flag is OFF the route does nothing,
  // writes NO heartbeat (the watchdog does not watch the leg then) and makes no Sentry
  // check-in, so switching the outbox off does not look like a broken monitor.
  let enabled: boolean;
  try {
    enabled = await readOutboxEnabled();
  } catch (err) {
    await reportError({ scope: "cron/release-notices:flag", error: err });
    return Response.json({ error: "flag read failed" }, { status: 500 });
  }
  if (!enabled) return Response.json(emptySweepSummary(false));

  return withCronMonitor("release-notices", async (markFailed) => {
    let summary;
    try {
      summary = await runReleaseNoticeSweep();
    } catch (err) {
      await reportError({ scope: "cron/release-notices:sweep", error: err });
      return Response.json({ error: "sweep failed" }, { status: 500 });
    }

    // Run heartbeat: only while the flag is ON; always when the run did work or
    // failed, and otherwise (a quiet run) at most once an hour.
    if (summary.enabled === true) await writeSweepHeartbeat(summary);

    // "Needs attention" signals (counts only, best effort, never throws): a run that
    // abandoned a notice, or a backlog that is not draining. See release-notice-alerts.
    await alertOnSweep(summary);

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

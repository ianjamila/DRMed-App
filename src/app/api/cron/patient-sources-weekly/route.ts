import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { manilaISODate } from "@/lib/dates/manila";
import { parseDigestParams } from "@/lib/marketing/patient-sources-digest";
import { runDigestCron } from "@/lib/marketing/patient-sources-digest-cron.server";

export const dynamic = "force-dynamic";

// Vercel Cron sends GET. Sunday 23:00 UTC = Monday 07:00 Manila, before the 8am opening:
// emails the owners last week's Patient Sources digest (Admin Tools › Email Alerts, key
// patient_sources_weekly). CRON_SECRET callers only may add ?period_from=YYYY-MM-DD (a
// finished Monday, ≤ 62 days old) to re-run an earlier week and &include_unknown=1 to
// re-send rows left uncertain — see the guide's admin notes.
export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // A typo in a hand-typed retry must not turn the Sentry monitor red: validate before it starts.
  const params = parseDigestParams(new URL(request.url).searchParams, "week", manilaISODate(new Date())!);
  if (!params.ok) return Response.json({ error: params.error }, { status: 400 });
  return withCronMonitor("patient-sources-weekly", (markFailed) => runDigestCron("week", params, markFailed));
}

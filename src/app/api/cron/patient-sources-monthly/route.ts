import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { manilaISODate } from "@/lib/dates/manila";
import { parseDigestParams } from "@/lib/marketing/patient-sources-digest";
import { runDigestCron } from "@/lib/marketing/patient-sources-digest-cron.server";

export const dynamic = "force-dynamic";

// Vercel Cron sends GET. 0 0 1 * * UTC = the 1st, 08:00 Manila: emails the owners last month's
// Patient Sources digest (Admin Tools › Email Alerts, key patient_sources_monthly).
// CRON_SECRET callers only may add ?period_from=YYYY-MM-DD (a
// finished 1st-of-month period, ≤ 62 days old) to re-run an earlier month and &include_unknown=1 to
// re-send rows left uncertain — see the guide's admin notes.
export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // A typo in a hand-typed retry must not turn the Sentry monitor red: validate before it starts.
  const params = parseDigestParams(new URL(request.url).searchParams, "month", manilaISODate(new Date())!);
  if (!params.ok) return Response.json({ error: params.error }, { status: 400 });
  return withCronMonitor("patient-sources-monthly", (markFailed) => runDigestCron("month", params, markFailed));
}

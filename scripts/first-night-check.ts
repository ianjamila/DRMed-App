/**
 * First-night check — proves every "New patients" screen agrees for a range of
 * days and flags any day that jumps (an import night). Read-only; the same
 * engine as Admin › Sheet Sync › First-night check.
 *
 *   npm run first-night:check                          last 7 days, LOCAL database
 *   npm run first-night:check -- --days 14 --threshold 60
 *   npm run first-night:check -- --from 2026-09-24 --to 2026-09-30 --json
 *   npm run first-night:check -- --prod                the live database (reads counts only)
 *
 * Exit code: 0 all screens agree · 1 screens disagree or a figure could not be
 * loaded · 2 a day is above the threshold (screens agree).
 * Needs migration 0199 (the report functions accept the service key).
 */
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { resolveCliArgs } from "./lib/first-night-args";

async function main() {
  requireLocalOrExplicitProd("first-night:check", {
    writes: "nothing — reads New-patient counts and patient created counts",
  });

  const { todayManilaISODate } = await import("../src/lib/dates/manila");
  const args = resolveCliArgs(process.argv.slice(2), todayManilaISODate());
  if (!args.ok) {
    for (const e of args.errors) console.error(e);
    console.error("Options: --from YYYY-MM-DD  --to YYYY-MM-DD  --days N  --threshold N  --json  --prod");
    process.exit(1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  const { runFirstNightCheck } = await import("../src/lib/marketing/first-night-check.server");
  const { exitCodeFor, formatReportText } = await import("../src/lib/marketing/first-night-check");

  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { report, durationMs } = await runFirstNightCheck(client as never, args.params);

  if (args.json) console.log(JSON.stringify({ ...report, duration_ms: durationMs }, null, 2));
  else console.log(`${formatReportText(report)}\n\nTook ${(durationMs / 1000).toFixed(1)}s.`);
  process.exit(exitCodeFor(report.verdict));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

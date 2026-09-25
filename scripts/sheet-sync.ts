/**
 * Sheet Sync CLI — the same runSheetSync the cron and the admin page use.
 *   npm run sheet:sync                          dry run against LOCAL (default)
 *   npm run sheet:sync -- --commit --confirm=local
 *   npm run sheet:sync -- --prod                dry run against prod (reads patient data)
 *   npm run sheet:sync -- --prod --commit --confirm=<project-ref>
 * A commit is refused while the sync is paused (the admin page's switch) — the
 * same rule as the cron. Needs LEGACY_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON.
 */
import "./lib/load-env";
import { expectedConfirmToken, requireLocalOrExplicitProd, requireTargetConfirmation } from "./lib/env-guard";

async function main() {
  requireLocalOrExplicitProd("sheet:sync", {
    writes: "patients (create / fill blanks), sheet_sync_* and sheet mirror tables — only with --commit; a dry run still reads patient data",
  });
  const commit = process.argv.includes("--commit");
  if (commit) requireTargetConfirmation("sheet:sync");

  const { createClient } = await import("@supabase/supabase-js");
  const { createSupabaseStore } = await import("../src/lib/sheet-sync/store");
  const { runSheetSync } = await import("../src/lib/sheet-sync/run");
  const { sheetReaderFromEnv } = await import("../src/lib/sheet-sync/config");

  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const outcome = await runSheetSync({
    store: createSupabaseStore(client as never), readSheet: sheetReaderFromEnv(),
    trigger: "cli", actorId: null, dryRun: !commit,
  });
  console.log(JSON.stringify({ run_id: outcome.runId, status: outcome.status, duration_ms: outcome.durationMs,
    error: outcome.error ?? null, per_tab: outcome.perTab }, null, 2));
  if (!commit) console.log(`\nDry run only. To apply: --commit --confirm=${expectedConfirmToken()}`);
  if (outcome.status === "skipped_paused") console.log("The sync is PAUSED — unpause it on /staff/admin/sheet-sync first.");
  process.exit(outcome.status === "failed" ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

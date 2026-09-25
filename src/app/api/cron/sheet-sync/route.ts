import { NextResponse } from "next/server";
import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { createAdminClient } from "@/lib/supabase/admin";
import { sheetReaderFromEnv } from "@/lib/sheet-sync/config";
import { runSheetSync, SyncBusyError } from "@/lib/sheet-sync/run";
import { createSupabaseStore } from "@/lib/sheet-sync/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 00:00 Manila. The runner re-stages every lab/consult row in the mirror window on
// EVERY run, not just new ones (~36k sheet rows read, ~13 stage calls + 3 commits) —
// est. 30-90s, well inside 5 minutes (the admin page records the actual duration).
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return withCronMonitor("sheet-sync", async (markFailed) => {
    try {
      const outcome = await runSheetSync({ store: createSupabaseStore(createAdminClient()), readSheet: sheetReaderFromEnv(),
        trigger: "cron", actorId: null, dryRun: false });
      if (outcome.status === "partial" || outcome.status === "failed") markFailed();
      return NextResponse.json({ ok: outcome.status !== "failed", status: outcome.status, run_id: outcome.runId, duration_ms: outcome.durationMs });
    } catch (err) {
      markFailed();
      const busy = err instanceof SyncBusyError;
      console.error("sheet sync cron failed", err);
      return NextResponse.json({ ok: false, error: busy ? "busy" : "error" }, { status: busy ? 409 : 500 });
    }
  });
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import type { SweepSummary } from "./release-notice-sweep";

// The sweeper's heartbeat (system.release_notices.sweep.completed), throttled:
// it runs every 5 minutes, and a quiet run only needs to prove the scheduler is
// alive, so it is written at most once an hour (the watchdog allows 6 h). A run
// that did work or hit a failure always writes one.

export const HEARTBEAT_ACTION = "system.release_notices.sweep.completed";
export const HEARTBEAT_MIN_INTERVAL_MS = 60 * 60 * 1000;

export function sweepDidWork(s: Pick<SweepSummary, "claimed" | "audit_pending" | "failures">): boolean {
  return s.claimed > 0 || s.audit_pending > 0 || s.failures > 0;
}

/** Writes the heartbeat unless this was a quiet run and the last one is under an hour old. Returns whether it wrote. */
export async function writeSweepHeartbeat(summary: SweepSummary, now: number = Date.now()): Promise<boolean> {
  if (!sweepDidWork(summary)) {
    const { data, error } = await createAdminClient()
      .from("audit_log")
      .select("created_at")
      .eq("actor_type", "system")
      .eq("action", HEARTBEAT_ACTION)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // A failed read writes the heartbeat: skipping on doubt could starve the watchdog.
    if (!error && data && now - Date.parse(data.created_at) < HEARTBEAT_MIN_INTERVAL_MS) return false;
  }
  await audit({ actor_id: null, actor_type: "system", action: HEARTBEAT_ACTION, metadata: { ...summary } });
  return true;
}

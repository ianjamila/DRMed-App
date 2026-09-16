import { captureCheckIn, flush } from "@sentry/nextjs";
import { CRON_HEARTBEATS, type CronKey } from "./cron-heartbeats";

// SDK types: @sentry/core/build/types/{exports,types-hoist/checkin}.d.ts,
// re-exported by @sentry/nextjs's server entrypoint. Both settings are minutes.
// An hour accommodates Vercel scheduling jitter; ten minutes allows runtime headroom.
async function startCheckIn(key: CronKey): Promise<string | undefined> {
  let checkInId: string | undefined;
  try {
    const cron = CRON_HEARTBEATS.find((entry) => entry.key === key)!;
    checkInId = captureCheckIn({ monitorSlug: key, status: "in_progress" }, {
      schedule: { type: "crontab", value: cron.schedule },
      checkinMargin: 60,
      maxRuntime: 10,
      timezone: "UTC",
    });
    // Deliver the start before doing work, so a killed process can time out in Sentry.
    await flush(2000);
  } catch {
    // Monitoring must never interrupt the task, even if the SDK/transport fails.
  }
  return checkInId;
}

async function finishCheckIn(key: CronKey, checkInId: string | undefined, status: "ok" | "error", startedAt: number) {
  if (!checkInId) return;
  try {
    captureCheckIn({ monitorSlug: key, checkInId, status, duration: (Date.now() - startedAt) / 1000 });
    await flush(2000);
  } catch {
    // Preserve the route's response or original exception on every failure path.
  }
}

/** Call only AFTER CRON_SECRET authorization. markFailed covers partial HTTP-200 failures. */
export async function withCronMonitor<T extends Response>(
  key: CronKey,
  run: (markFailed: () => void) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const checkInId = await startCheckIn(key);
  let status: "ok" | "error" = "error";
  let failed = false;
  try {
    const response = await run(() => { failed = true; });
    status = response.ok && !failed ? "ok" : "error";
    return response;
  } finally {
    // A thrown error retains its identity and still terminates the check-in.
    await finishCheckIn(key, checkInId, status, startedAt);
  }
}

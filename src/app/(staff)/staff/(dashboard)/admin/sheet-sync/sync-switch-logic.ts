// Pure, framework-free decision logic for the sync on/off Switch — split out
// of sync-controls.tsx (a "use client" file that also imports the "use
// server" actions.ts, which pulls in requireAdminStaff's `server-only`
// guard) so it can be unit-tested directly with plain vitest, no DOM, no
// server context. See sync-controls.test.ts for why: this repo's
// `.test.tsx` convention renders with `react-dom/server`'s
// renderToStaticMarkup under `environment: "node"` (vitest.config.ts) —
// there is no jsdom / @testing-library/* installed, so nothing here can
// simulate a click. Pulling the DECISION into plain functions is what makes
// it testable at all.
//
// Regression this exists for (C1): the switch's turn-on/turn-off branches
// were swapped, so clicking it to turn the sync ON opened the "Pause the
// nightly sheet sync?" confirm and sent paused:true — the toggle could
// never actually change state.

export type SyncSwitchIntent = "resume" | "confirm-pause";

/** `next` is Switch's REQUESTED checked state (sync-controls.tsx passes it
 * `checked={!paused}`, and Switch itself calls `onCheckedChange(!checked)`)
 * — true means "the sync should now be ON". */
export function syncSwitchIntent(next: boolean): SyncSwitchIntent {
  return next ? "resume" : "confirm-pause";
}

/** What setSheetSyncPausedAction is called with for each half of the toggle. */
export function resumeArgs(): { paused: false; reason: null } {
  return { paused: false, reason: null };
}

export function pauseConfirmArgs(reason: string): { paused: true; reason: string | null } {
  return { paused: true, reason: reason.trim() || null };
}

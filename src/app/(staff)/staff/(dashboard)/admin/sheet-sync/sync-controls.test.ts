// Regression coverage for C1: the sync on/off Switch's onToggle branches
// were swapped, so clicking the switch to turn the sync ON asked "Pause the
// nightly sheet sync?" and sent paused:true — the toggle could never
// actually change state.
//
// This repo's `.test.tsx` convention renders client components with
// `react-dom/server`'s `renderToStaticMarkup` (see switch.test.tsx,
// message-actions.test.tsx) under a plain Node vitest environment
// (`environment: "node"` in vitest.config.ts) — there is no jsdom and no
// @testing-library/* installed (checked node_modules directly), so nothing
// in the existing suite simulates a click or asserts what a mocked action
// was called with. sync-controls.tsx itself also can't be imported bare
// under vitest anyway: it transitively pulls in actions.ts's "use server"
// chain, which hits requireAdminStaff's `server-only` guard outside a real
// server context. So the on/off DECISION and the args each half sends live
// in the framework-free sync-switch-logic.ts and are tested directly here,
// the same way this repo tests every other pure-logic module.
import { describe, it, expect } from "vitest";
import { pauseConfirmArgs, resumeArgs, syncSwitchIntent } from "./sync-switch-logic";

describe("syncSwitchIntent (C1 regression)", () => {
  it("turning the switch ON (next=true) resumes — no confirm", () => {
    expect(syncSwitchIntent(true)).toBe("resume");
  });

  it("turning the switch OFF (next=false) asks for confirmation first (pausing)", () => {
    expect(syncSwitchIntent(false)).toBe("confirm-pause");
  });
});

describe("resumeArgs", () => {
  it("turning the sync on calls the action with paused:false and no reason", () => {
    expect(resumeArgs()).toEqual({ paused: false, reason: null });
  });
});

describe("pauseConfirmArgs", () => {
  it("confirming pause sends paused:true with the trimmed reason", () => {
    expect(pauseConfirmArgs("  Cleaning up the sheet  ")).toEqual({
      paused: true,
      reason: "Cleaning up the sheet",
    });
  });

  it("an empty or whitespace-only reason is sent as null, not an empty string", () => {
    expect(pauseConfirmArgs("")).toEqual({ paused: true, reason: null });
    expect(pauseConfirmArgs("   ")).toEqual({ paused: true, reason: null });
  });
});

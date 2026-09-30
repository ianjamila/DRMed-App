import { describe, expect, it } from "vitest";
import { ACTIONS_FIRST_SELECTOR, FOCUSABLE_IN_BAR, isBarShortcut } from "./bar-focus";

const ev = (over: Partial<Parameters<typeof isBarShortcut>[0]>) => ({
  code: "KeyB",
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("isBarShortcut", () => {
  it("matches Alt+B by physical key (Mac ⌥B types ∫)", () => {
    expect(isBarShortcut(ev({}))).toBe(true);
  });
  it("ignores other modifiers and keys", () => {
    expect(isBarShortcut(ev({ altKey: false }))).toBe(false);
    expect(isBarShortcut(ev({ ctrlKey: true }))).toBe(false);
    expect(isBarShortcut(ev({ metaKey: true }))).toBe(false);
    expect(isBarShortcut(ev({ shiftKey: true }))).toBe(false);
    expect(isBarShortcut(ev({ code: "KeyN" }))).toBe(false);
  });
});

describe("FOCUSABLE_IN_BAR", () => {
  it("targets enabled controls only", () => {
    expect(FOCUSABLE_IN_BAR).toContain("button:not([disabled])");
    expect(FOCUSABLE_IN_BAR).toContain("select:not([disabled])");
    expect(FOCUSABLE_IN_BAR).not.toContain("input[type=checkbox]");
  });
});

describe("ACTIONS_FIRST_SELECTOR", () => {
  it("scopes every FOCUSABLE_IN_BAR clause to the actions container", () => {
    expect(ACTIONS_FIRST_SELECTOR).toContain("[data-bar-actions] button:not([disabled])");
    expect(ACTIONS_FIRST_SELECTOR).toContain("[data-bar-actions] select:not([disabled])");
    expect(ACTIONS_FIRST_SELECTOR).toContain("[data-bar-actions] textarea:not([disabled])");
    expect(ACTIONS_FIRST_SELECTOR).toContain("[data-bar-actions] a[href]");
  });

  it("has one clause per FOCUSABLE_IN_BAR selector, in the same order", () => {
    const bases = FOCUSABLE_IN_BAR.split(",").map((s) => s.trim());
    const scoped = ACTIONS_FIRST_SELECTOR.split(",").map((s) => s.trim());
    expect(scoped).toEqual(bases.map((base) => `[data-bar-actions] ${base}`));
  });

  it("does NOT itself exclude an inline outcome panel — that's firstBarFocusTarget's job", () => {
    // "Clear" (count-line) is unscoped by [data-bar-actions] and never
    // matches; an inline BulkOutcomePanel's Undo/Dismiss DO match this
    // selector (they are buttons inside the actions container) — excluding
    // them is firstBarFocusTarget's [data-bar-outcome] check, not this
    // string. Guard the shape so that exclusion logic keeps a reason to exist.
    expect(ACTIONS_FIRST_SELECTOR).not.toContain("data-bar-outcome");
  });
});

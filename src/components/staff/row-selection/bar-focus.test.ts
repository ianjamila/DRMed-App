import { describe, expect, it } from "vitest";
import { FOCUSABLE_IN_BAR, isBarShortcut } from "./bar-focus";

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

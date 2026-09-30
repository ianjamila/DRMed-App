import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { canContinueRacedStructuredDraft } from "./create-linked";

// Pure branch logic behind prepareStructured's P0066 handling (0184): after
// losing the race to result_create_linked, is the winner's row something this
// caller can safely continue against?
describe("canContinueRacedStructuredDraft", () => {
  it("continues onto an open structured draft", () => {
    expect(canContinueRacedStructuredDraft({ generation_kind: "structured", finalised_at: null })).toBe(true);
  });

  it("refuses when the winner uploaded a PDF instead", () => {
    expect(canContinueRacedStructuredDraft({ generation_kind: "uploaded", finalised_at: null })).toBe(false);
  });

  it("refuses when the winner's structured result is already finalised", () => {
    expect(
      canContinueRacedStructuredDraft({ generation_kind: "structured", finalised_at: "2026-09-28T00:00:00+00:00" }),
    ).toBe(false);
  });

  it("refuses when no link was found at all (e.g. the race was on a test that no longer exists)", () => {
    expect(canContinueRacedStructuredDraft(null)).toBe(false);
    expect(canContinueRacedStructuredDraft(undefined)).toBe(false);
  });
});

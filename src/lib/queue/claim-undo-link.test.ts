import { describe, expect, it } from "vitest";
import { claimBenchHref, claimReportHref, claimUndoOpen, parseClaimUndoParams } from "./claim-undo-link";

const NOW = 1_800_000_000_000;
const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PANEL = { visitId: "v1", groupId: "g1" };

describe("claimReportHref", () => {
  it("adds the batch and the claim time", () => {
    expect(claimReportHref(PANEL, BATCH, NOW)).toBe(
      `/staff/queue/consolidated/v1/g1?claimed=${BATCH}&at=${NOW}`,
    );
  });
  it("is the bare report URL with no batch", () => {
    expect(claimReportHref(PANEL, undefined, NOW)).toBe("/staff/queue/consolidated/v1/g1");
    expect(claimReportHref(PANEL, "", NOW)).toBe("/staff/queue/consolidated/v1/g1");
  });
  it("encodes the batch id", () => {
    expect(claimReportHref(PANEL, "a&b=c d", NOW)).toContain("?claimed=a%26b%3Dc%20d&at=");
  });
});

describe("claimBenchHref", () => {
  it("adds the batch and the claim time", () => {
    expect(claimBenchHref("t1", BATCH, NOW)).toBe(`/staff/queue/t1?claimed=${BATCH}&at=${NOW}`);
  });
  it("is the bare bench URL with no batch", () => {
    expect(claimBenchHref("t1", undefined, NOW)).toBe("/staff/queue/t1");
  });
});

describe("claimUndoOpen", () => {
  it("is open until exactly ten minutes, closed one millisecond later", () => {
    expect(claimUndoOpen(NOW - 10 * 60_000, NOW)).toBe(true);
    expect(claimUndoOpen(NOW - 10 * 60_000 - 1, NOW)).toBe(false);
  });
});

describe("parseClaimUndoParams", () => {
  it("accepts a uuid-shaped batch and a valid past at", () => {
    expect(parseClaimUndoParams({ claimed: BATCH, at: String(NOW - 5000) }, NOW)).toEqual({
      batchId: BATCH,
      doneAt: NOW - 5000,
    });
  });
  it("keeps an at equal to now", () => {
    expect(parseClaimUndoParams({ claimed: BATCH, at: String(NOW) }, NOW).doneAt).toBe(NOW);
  });
  it("drops anything that is not uuid-shaped, or not a single string", () => {
    for (const claimed of [undefined, "", "nope", "x".repeat(36) + "!", `${BATCH}0`, [BATCH, BATCH]]) {
      expect(parseClaimUndoParams({ claimed, at: String(NOW) }, NOW).batchId).toBeNull();
    }
    expect(parseClaimUndoParams({ claimed: "g".repeat(36) }, NOW).batchId).toBeNull();
  });
  it("treats a missing, empty, whitespace, garbage or future at as now", () => {
    for (const at of [undefined, "", "   ", "abc", "NaN", "Infinity", String(NOW + 1), [String(NOW - 1)]]) {
      expect(parseClaimUndoParams({ claimed: BATCH, at }, NOW).doneAt).toBe(NOW);
    }
  });
  it("still reports now as doneAt when there is no batch", () => {
    expect(parseClaimUndoParams({}, NOW)).toEqual({ batchId: null, doneAt: NOW });
  });
});

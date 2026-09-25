import { describe, expect, it } from "vitest";
import { activeCheck, chunkIds } from "./require-active-core";

describe("activeCheck", () => {
  it("passes when every patient is active and walk-ins (no id) are ignored", () => {
    expect(activeCheck([{ drm_id: "DRM-1", deleted_at: null, merged_into_id: null }], 1)).toEqual({ ok: true });
    expect(activeCheck([], 0)).toEqual({ ok: true });
  });
  it("refuses with the first inactive DRM-ID", () => {
    const r = activeCheck(
      [
        { drm_id: "DRM-1", deleted_at: null, merged_into_id: null },
        { drm_id: "DRM-2", deleted_at: "2026-09-24T00:00:00Z", merged_into_id: null },
      ],
      2,
    );
    expect(r).toEqual({
      ok: false,
      error: "DRM-2 was deleted. An admin can restore it from Admin Tools › Deleted Patients before anything else is done on it.",
    });
  });
  it("refuses when an id did not resolve to a row", () => {
    expect(activeCheck([], 1)).toEqual({ ok: false, error: "We couldn't find that patient. Search again." });
  });
});

describe("chunkIds", () => {
  it("returns [] for an empty list", () => {
    expect(chunkIds([], 200)).toEqual([]);
  });
  it("returns one chunk when under the size", () => {
    expect(chunkIds(["a", "b", "c"], 200)).toEqual([["a", "b", "c"]]);
  });
  it("splits exactly on a multiple of the size", () => {
    expect(chunkIds(["a", "b", "c", "d"], 2)).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("puts the remainder in a final short chunk", () => {
    expect(chunkIds(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});

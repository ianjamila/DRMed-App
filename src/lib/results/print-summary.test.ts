import { describe, expect, it } from "vitest";
import { foldPrintEvents } from "./print-summary";

const names = new Map([["u1", "Ana Cruz"], ["u2", "Ben Reyes"]]);

describe("foldPrintEvents", () => {
  it("counts prints per file and keeps the latest, whatever the row order", () => {
    const out = foldPrintEvents(
      [
        { result_id: "r1", amendment_count: "0", created_at: "2026-09-25T02:00:00+00:00", actor_id: "u2" },
        { result_id: "r1", amendment_count: "0", created_at: "2026-09-25T01:00:00+00:00", actor_id: "u1" },
        { result_id: "r2", amendment_count: "0", created_at: "2026-09-25T03:00:00+00:00", actor_id: "u1" },
      ],
      names,
      new Map([["r1", 0], ["r2", 0]]),
    );
    expect(out.get("r1")).toEqual({ count: 2, lastAt: "2026-09-25T02:00:00+00:00", lastBy: "Ben Reyes" });
    expect(out.get("r2")).toEqual({ count: 1, lastAt: "2026-09-25T03:00:00+00:00", lastBy: "Ana Cruz" });
  });

  it("names nobody when the actor is unknown, and skips rows with no file", () => {
    const out = foldPrintEvents(
      [
        { result_id: "r1", amendment_count: "0", created_at: "2026-09-25T01:00:00+00:00", actor_id: "gone" },
        { result_id: null, amendment_count: "0", created_at: "2026-09-25T01:00:00+00:00", actor_id: "u1" },
      ],
      names,
      new Map([["r1", 0], ["r2", 0]]),
    );
    expect(out.get("r1")?.lastBy).toBeNull();
    expect(out.size).toBe(1);
  });
});

describe("foldPrintEvents — amended files", () => {
  it("does not carry a print of the old version over to the correction", () => {
    const out = foldPrintEvents(
      [
        { result_id: "r1", amendment_count: "0", created_at: "2026-09-25T01:00:00+00:00", actor_id: "u1" },
        { result_id: "r1", amendment_count: "1", created_at: "2026-09-25T05:00:00+00:00", actor_id: "u2" },
      ],
      names,
      new Map([["r1", 1]]),
    );
    expect(out.get("r1")).toEqual({ count: 1, lastAt: "2026-09-25T05:00:00+00:00", lastBy: "Ben Reyes" });
  });

  it("shows nothing for a correction not printed yet, or for rows with no version", () => {
    const out = foldPrintEvents(
      [
        { result_id: "r1", amendment_count: "0", created_at: "2026-09-25T01:00:00+00:00", actor_id: "u1" },
        { result_id: "r2", amendment_count: null, created_at: "2026-09-25T01:00:00+00:00", actor_id: "u1" },
      ],
      names,
      new Map([["r1", 1], ["r2", 0]]),
    );
    expect(out.size).toBe(0);
  });
});

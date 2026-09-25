import { describe, expect, it } from "vitest";
import { foldPrintEvents, servedAmendmentCount } from "./print-summary";

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

describe("servedAmendmentCount — the version a print row stamps", () => {
  it("stamps the current file when no ?version is asked for", () => {
    expect(servedAmendmentCount(null, 1)).toBe(0);
    expect(servedAmendmentCount(null, 3)).toBe(2);
  });

  it("stamps the replaced version a ?version=N request served", () => {
    expect(servedAmendmentCount(1, 2)).toBe(0);
    expect(servedAmendmentCount(2, 3)).toBe(1);
    expect(servedAmendmentCount(3, 3)).toBe(2);
  });

  it("printing version 1 after version 2 exists leaves version 2's Printed note empty", () => {
    // r1 has been edited once: current file = version 2 (amendment_count 1).
    const current = new Map([["r1", 1]]);
    const printOfV1 = {
      result_id: "r1",
      amendment_count: String(servedAmendmentCount(1, 2)),
      created_at: "2026-09-25T06:00:00+00:00",
      actor_id: "u1",
    };
    expect(foldPrintEvents([printOfV1], names, current).get("r1")).toBeUndefined();

    // …whereas printing the current file (no ?version) does count.
    const printOfCurrent = { ...printOfV1, amendment_count: String(servedAmendmentCount(null, 2)) };
    expect(foldPrintEvents([printOfV1, printOfCurrent], names, current).get("r1")?.count).toBe(1);
  });
});

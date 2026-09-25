import { describe, expect, it } from "vitest";
import { foldEditNotes, type EditNoteTestRow } from "./edit-note";

function row(overrides: Partial<EditNoteTestRow> = {}): EditNoteTestRow {
  return {
    id: "t1",
    name: "GLUCOSE",
    resultId: "r1",
    amendedAt: "2026-09-24T05:00:00Z",
    amendmentCount: 1,
    ...overrides,
  };
}

describe("foldEditNotes", () => {
  it("returns nothing for an unamended test", () => {
    const got = foldEditNotes(
      [row({ resultId: null, amendedAt: null, amendmentCount: 0 })],
      new Map(),
    );
    expect(got.size).toBe(0);
  });

  it("returns nothing when the reason map has no entry (RLS returned no rows)", () => {
    // Reception's read of result_amendments comes back empty (0172 RLS) — the
    // visit page must show nothing rather than a note with no reason.
    const got = foldEditNotes([row()], new Map());
    expect(got.size).toBe(0);
  });

  it("full note on a single-test result", () => {
    const got = foldEditNotes([row()], new Map([["r1", "Corrected transcription error"]]));
    expect(got.get("t1")).toBe(
      "Edited Sep 24, 2026, 1:00 PM — Corrected transcription error",
    );
  });

  it("adds the ×N suffix when amendment_count > 1", () => {
    const got = foldEditNotes(
      [row({ amendmentCount: 3 })],
      new Map([["r1", "Re-keyed after QC flag"]]),
    );
    expect(got.get("t1")).toBe(
      "Edited Sep 24, 2026, 1:00 PM (×3) — Re-keyed after QC flag",
    );
  });

  it("only the first member of a combined report gets the full note", () => {
    const rows = [
      row({ id: "t1", name: "GLUCOSE" }),
      row({ id: "t2", name: "CREATININE" }),
      row({ id: "t3", name: "SGOT/AST" }),
    ];
    const got = foldEditNotes(rows, new Map([["r1", "Re-keyed after QC flag"]]));
    expect(got.get("t1")).toBe(
      "Edited Sep 24, 2026, 1:00 PM — Re-keyed after QC flag",
    );
    expect(got.get("t2")).toBe("Edited — see GLUCOSE");
    expect(got.get("t3")).toBe("Edited — see GLUCOSE");
  });

  it("first-member assignment follows the given row order, not the array's insertion order of results", () => {
    const rows = [
      row({ id: "t2", name: "CREATININE", resultId: "r1" }),
      row({ id: "t1", name: "GLUCOSE", resultId: "r1" }),
    ];
    const got = foldEditNotes(rows, new Map([["r1", "reason"]]));
    expect(got.get("t2")).toContain("Edited Sep");
    expect(got.get("t1")).toBe("Edited — see CREATININE");
  });

  it("keeps two different amended reports independent", () => {
    const rows = [
      row({ id: "t1", name: "GLUCOSE", resultId: "r1" }),
      row({ id: "t2", name: "CREATININE", resultId: "r1" }),
      row({ id: "t3", name: "URIC ACID", resultId: "r2" }),
    ];
    const got = foldEditNotes(
      rows,
      new Map([
        ["r1", "reason one"],
        ["r2", "reason two"],
      ]),
    );
    expect(got.get("t1")).toContain("reason one");
    expect(got.get("t2")).toBe("Edited — see GLUCOSE");
    expect(got.get("t3")).toContain("reason two");
  });

  it("a test not linked to any result is skipped even if it somehow carries an amendment count", () => {
    const got = foldEditNotes(
      [row({ resultId: null })],
      new Map([["r1", "reason"]]),
    );
    expect(got.size).toBe(0);
  });
});

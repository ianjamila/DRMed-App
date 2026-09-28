// Review fix #2: a header row that was deleted or sorted away puts a cell's
// real content (which can be a patient's name) where the sync expects a
// column heading. assertHeaders must report only coordinates + the expected
// header — never the observed cell — since HeaderMismatchError's message
// lands verbatim in sheet_sync_runs.per_tab / .error (run.ts's errText lets
// our own hand-authored messages through unredacted).
import { describe, expect, it } from "vitest";
import { assertHeaders, HeaderMismatchError } from "./headers";

describe("assertHeaders", () => {
  it("never includes the observed cell value in the error message", () => {
    const rows = [["", "", "", "", "Dela Cruz, Juan Santos"]];
    let error: HeaderMismatchError | undefined;
    try {
      assertHeaders("CUSTOMER LIST2", rows, [[0, 4, "Full Name"]]);
    } catch (e) {
      error = e as HeaderMismatchError;
    }
    expect(error).toBeInstanceOf(HeaderMismatchError);
    expect(error!.message).not.toContain("Dela Cruz");
    expect(error!.message).not.toContain("Juan");
    expect(error!.message).toMatch(/row 1 col 5/);
    expect(error!.message).toMatch(/expected "Full Name…"/);
  });

  it("still names the tab, row and column so the mismatch is fixable", () => {
    const rows = [["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "SOMETHING ELSE"]];
    expect(() => assertHeaders("CUSTOMER LIST2", rows, [[0, 17, "Referred By"]]))
      .toThrow(/CUSTOMER LIST2: header changed \(row 1 col 18: expected "Referred By…"\)/);
  });

  it("passes silently when every expected prefix matches", () => {
    const rows = [["Full Name", "Gender"]];
    expect(() => assertHeaders("CUSTOMER LIST2", rows, [[0, 0, "Full Name"], [0, 1, "Gender"]])).not.toThrow();
  });
});

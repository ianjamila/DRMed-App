import { describe, expect, it } from "vitest";
import { sheetOnlyNote } from "./sheet-only-note";

const coverage = {
  lab: { rows: 3186, firstDate: "2026-05-26", lastDate: "2026-10-01" },
  consult: { rows: 1051, firstDate: "2026-05-26", lastDate: "2026-09-30" },
};

describe("sheetOnlyNote", () => {
  it("counts each tab's sheet-only rows with their date range", () => {
    expect(sheetOnlyNote("doctor_consultations", coverage)).toBe(
      "On the reception sheet only, not copied: 1,051 consultation rows from May 26, 2026 to Sep 30, 2026.",
    );
    expect(sheetOnlyNote("lab_services", coverage)).toBe(
      "On the reception sheet only, not copied: 3,186 lab rows from May 26, 2026 to Oct 1, 2026.",
    );
  });

  it("says the procedure tab is not read at all, whatever the counts", () => {
    expect(sheetOnlyNote("doctor_procedures", { lab: null, consult: null })).toMatch(/not read by the app/);
  });

  it("stays silent when the sheet has nothing or the read failed", () => {
    expect(sheetOnlyNote("doctor_consultations", { ...coverage, consult: { rows: 0, firstDate: null, lastDate: null } })).toBeNull();
    expect(sheetOnlyNote("lab_services", { ...coverage, lab: null })).toBeNull();
  });

  it("uses the singular and a single date for one row", () => {
    expect(
      sheetOnlyNote("doctor_consultations", { ...coverage, consult: { rows: 1, firstDate: "2026-09-30", lastDate: "2026-09-30" } }),
    ).toBe("On the reception sheet only, not copied: 1 consultation row on Sep 30, 2026.");
  });
});

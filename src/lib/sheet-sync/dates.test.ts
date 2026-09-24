import { describe, expect, it } from "vitest";
import { DOB_CASES, EVENT_DATE_CASES } from "./__fixtures__/date-cells";
import { parseDobCell, parseEventDateCell, serialToISODate } from "./dates";

const TODAY = "2026-09-24";

describe("serialToISODate", () => {
  it("converts by integer arithmetic (25569 = 1970-01-01)", () => {
    expect(serialToISODate(25569)).toBe("1970-01-01");
    expect(serialToISODate(25569 + 59)).toBe("1970-03-01");
    // Plan's test used serial 45350, but that converts to 2024-02-28 (verified
    // independently); 45351 is the leap day, 2024-02-29. Test value corrected.
    expect(serialToISODate(45351)).toBe("2024-02-29");  // leap day
    expect(serialToISODate(45627.99)).toBe("2024-12-01");
    expect(serialToISODate(Number.NaN)).toBeNull();
  });
});

describe("parseEventDateCell", () => {
  it.each(EVENT_DATE_CASES)("%j → %s", (cell, expected) => {
    expect(parseEventDateCell(cell, TODAY).iso).toBe(expected);
  });
  it("flags junk as an issue but treats blank as undated, not an issue", () => {
    expect(parseEventDateCell("", TODAY).issue).toBeNull();
    expect(parseEventDateCell("GCASH", TODAY).issue).toBe("unparseable");
    expect(parseEventDateCell(46000, TODAY)).toEqual({ iso: "2025-12-09", issue: null });
  });
  it("rejects dates after today (Manila) and before 2023-12-01", () => {
    expect(parseEventDateCell("9/25/2026", TODAY).issue).toBe("out_of_range");
    expect(parseEventDateCell("11/30/2023", TODAY).issue).toBe("out_of_range");
    expect(parseEventDateCell("9/24/2026", TODAY).iso).toBe("2026-09-24");
  });
  it("rejects impossible calendar dates", () => {
    expect(parseEventDateCell("2/30/2025", TODAY).iso).toBeNull();
  });
});

describe("parseDobCell", () => {
  it.each(DOB_CASES)("%j → %s", (cell, expected) => {
    expect(parseDobCell(cell, TODAY).iso).toBe(expected);
  });
});

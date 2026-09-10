import { describe, it, expect } from "vitest";
import {
  escapeCell,
  csvRow,
  csvDocument,
  csvDocumentFromRecords,
} from "./escape";

describe("escapeCell", () => {
  it("passes plain values through unquoted", () => {
    expect(escapeCell("CBC")).toBe("CBC");
    expect(escapeCell(1234)).toBe("1234");
    expect(escapeCell(0)).toBe("0");
    expect(escapeCell(false)).toBe("false");
  });

  it("renders null and undefined as an empty cell", () => {
    expect(escapeCell(null)).toBe("");
    expect(escapeCell(undefined)).toBe("");
  });

  it("quotes on comma, quote, LF and CR", () => {
    expect(escapeCell("Dela Cruz, Juan")).toBe('"Dela Cruz, Juan"');
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("doubles every embedded quote, not just the first", () => {
    expect(escapeCell('a"b"c')).toBe('"a""b""c"');
  });

  // A patient name is the realistic injection vector here.
  it("keeps a comma-bearing name in one cell", () => {
    const line = csvRow(["0037", "Dela Cruz, Juan", 1500]);
    expect(line).toBe('0037,"Dela Cruz, Juan",1500');
    expect(line.split('"')[0]).toBe("0037,");
  });
});

describe("csvDocument", () => {
  it("joins rows with LF and ends with a trailing newline", () => {
    expect(csvDocument([["a", "b"], [1, 2]])).toBe("a,b\n1,2\n");
  });

  it("produces just a newline for no rows", () => {
    expect(csvDocument([])).toBe("\n");
  });
});

describe("csvDocumentFromRecords", () => {
  const rows = [
    { provider: "Maxicare", patient: "Dela Cruz, Juan", amount_php: 1200 },
    { provider: "Intellicare", patient: "Reyes", amount_php: 0 },
  ];

  it("takes the header from the first record's keys, in order", () => {
    expect(csvDocumentFromRecords(rows)).toBe(
      "provider,patient,amount_php\n" +
        'Maxicare,"Dela Cruz, Juan",1200\n' +
        "Intellicare,Reyes,0\n",
    );
  });

  it("renders an absent or null field as an empty cell, not the string null", () => {
    expect(
      csvDocumentFromRecords([{ a: 1, b: null }, { a: 2 } as Record<string, unknown>]),
    ).toBe("a,b\n1,\n2,\n");
  });

  it("returns nothing for an empty set — there is no header to infer", () => {
    expect(csvDocumentFromRecords([])).toBe("");
  });

  it("appends the truncation notice in-band when one is given", () => {
    const out = csvDocumentFromRecords(rows, { truncatedNotice: "TRUNCATED — narrow it." });
    expect(out.trimEnd().split("\n").at(-1)).toBe("TRUNCATED — narrow it.");
  });

  it("leaves a complete export unmarked", () => {
    expect(csvDocumentFromRecords(rows, {})).toBe(csvDocumentFromRecords(rows));
    expect(csvDocumentFromRecords(rows)).not.toContain("TRUNCATED");
  });
});

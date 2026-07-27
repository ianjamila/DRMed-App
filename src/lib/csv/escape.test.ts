import { describe, it, expect } from "vitest";
import { escapeCell, csvRow, csvDocument } from "./escape";

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

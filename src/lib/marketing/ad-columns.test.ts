import { describe, expect, it } from "vitest";
import { findCountColumn, mapCountColumns, parseCountCell, parseCountCellExact, roundCount } from "./ad-columns";

describe("mapCountColumns (the old Ad Performance screen's fuzzy rules)", () => {
  it("matches lead | result | conversation | messag for leads, in that priority", () => {
    expect(mapCountColumns(["Day", "Results"]).leads).toBe("Results");
    expect(mapCountColumns(["Day", "Results", "Leads"]).leads).toBe("Leads");
    expect(mapCountColumns(["Day", "Messaging conversations started"]).leads).toBe("Messaging conversations started");
    expect(mapCountColumns(["Day", "New messages"]).leads).toBe("New messages");
  });
  it("matches booking | conversion | purchase | appointment for bookings", () => {
    expect(mapCountColumns(["Bookings"]).bookings).toBe("Bookings");
    expect(mapCountColumns(["Conversions"]).bookings).toBe("Conversions");
    expect(mapCountColumns(["Website purchases"]).bookings).toBe("Website purchases");
    expect(mapCountColumns(["Appointments set"]).bookings).toBe("Appointments set");
  });
  it("is case-insensitive and ignores files with neither", () => {
    expect(mapCountColumns(["LEADS", "BOOKINGS"])).toEqual({ leads: "LEADS", bookings: "BOOKINGS" });
    expect(mapCountColumns(["Day", "Campaign", "Cost"])).toEqual({ leads: undefined, bookings: undefined });
  });
  it("never feeds one column into both fields (Meta's single Results column is leads only)", () => {
    const m = mapCountColumns(["Lead form conversions"]);
    expect(m.leads).toBe("Lead form conversions");
    expect(m.bookings).toBeUndefined();
    expect(mapCountColumns(["Results"])).toEqual({ leads: "Results", bookings: undefined });
  });
  it("skips costs, rates, values and labels that merely contain the word", () => {
    const headers = ["Cost per lead", "Lead rate", "Result indicator", "Conversion value", "Conv. rate", "Cost per purchase", "Leads"];
    expect(mapCountColumns(headers).leads).toBe("Leads");
    expect(findCountColumn(["Conversion rate", "Conversion value", "Cost per conversion"], "bookings")).toBeUndefined();
  });
});

describe("parseCountCell", () => {
  it("blank and unreadable are unknown; a real zero is kept", () => {
    expect(parseCountCell("")).toBeNull();
    expect(parseCountCell(undefined)).toBeNull();
    expect(parseCountCell(" --")).toBeNull();
    expect(parseCountCell("n/a")).toBeNull();
    expect(parseCountCell("-3")).toBeNull();
    expect(parseCountCell("0")).toBe(0);
    expect(parseCountCell("0.0")).toBe(0);
  });
  it("reads thousands separators and rounds fractional conversions", () => {
    expect(parseCountCell("1,234")).toBe(1234);
    expect(parseCountCell("2.5")).toBe(3);
    expect(parseCountCell("2.49")).toBe(2);
  });
});

describe("label and category headers are never the count", () => {
  it("skips name / action / source / form / category columns", () => {
    expect(mapCountColumns(["Lead form name", "Leads"]).leads).toBe("Leads");
    expect(mapCountColumns(["Lead form name"]).leads).toBeUndefined();
    expect(findCountColumn(["Conversion action", "Conversion source", "Conversion category", "Conversion name"], "bookings")).toBeUndefined();
    expect(mapCountColumns(["Conversion action", "Conversions"]).bookings).toBe("Conversions");
    expect(mapCountColumns(["Lead source", "Lead form", "Leads"]).leads).toBe("Leads");
    expect(mapCountColumns(["Lead form"]).leads).toBeUndefined();
  });
  it("still reads a form-conversions COUNT", () => {
    expect(mapCountColumns(["Lead form conversions"]).leads).toBe("Lead form conversions");
  });
});

describe("Google's short conversion headers", () => {
  it("reads Conv. and All conv. as bookings", () => {
    expect(mapCountColumns(["Day", "Conv."]).bookings).toBe("Conv.");
    expect(mapCountColumns(["Day", "All conv."]).bookings).toBe("All conv.");
  });
  it("prefers Conversions / Conv. over All conv. in either header order", () => {
    expect(mapCountColumns(["All conv.", "Conv."]).bookings).toBe("Conv.");
    expect(mapCountColumns(["All conv.", "Conversions"]).bookings).toBe("Conversions");
    expect(mapCountColumns(["All conversions", "Conversions"]).bookings).toBe("Conversions");
    expect(mapCountColumns(["Conv. rate", "Conv. value", "Cost / conv.", "All conv."]).bookings).toBe("All conv.");
  });
});

describe("exact vs rounded counts", () => {
  it("parseCountCellExact keeps the fraction", () => {
    expect(parseCountCellExact("0.4")).toBe(0.4);
    expect(parseCountCellExact("1,234.5")).toBe(1234.5);
    expect(parseCountCellExact("-1")).toBeNull();
    expect(parseCountCellExact("")).toBeNull();
  });
  it("roundCount is half-up and immune to float noise", () => {
    expect(roundCount(0.4 + 0.4 + 0.4)).toBe(1);
    expect(roundCount(0.5)).toBe(1);
    expect(roundCount(2.5)).toBe(3);
    expect(roundCount(0.1 + 0.2 + 0.2)).toBe(1);
    expect(roundCount(0.4)).toBe(0);
  });
});

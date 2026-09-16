import { describe, it, expect } from "vitest";
import {
  carryParams,
  operationsToStatementQuery,
  statementPeriodQueries,
  statementToOperationsQuery,
} from "./statement-period";

describe("carryParams", () => {
  const q = (s: string) => new URLSearchParams(s);

  it("keeps only the listed keys, in the order listed", () => {
    expect(carryParams(q("to=2026-03-31&junk=x&from=2026-03-01"), ["from", "to"])).toBe(
      "?from=2026-03-01&to=2026-03-31",
    );
  });

  it("is empty when nothing is selected, so the tab keeps its own default", () => {
    expect(carryParams(q(""), ["from", "to"])).toBe("");
    expect(carryParams(q("other=1"), ["from", "to"])).toBe("");
  });

  it("carries a partial selection", () => {
    expect(carryParams(q("from=2026-03-01"), ["from", "to"])).toBe("?from=2026-03-01");
  });

  it("drops a value that is not a YYYY-MM-DD date, rather than forwarding junk", () => {
    expect(carryParams(q("from=lol&to=2026-03-31"), ["from", "to"])).toBe("?to=2026-03-31");
  });

  it("percent-encodes, so a hand-edited URL can't inject another parameter", () => {
    expect(carryParams(q("shift=a%26b=c"), ["shift"], { unvalidated: ["shift"] })).toBe(
      "?shift=a%26b%3Dc",
    );
  });

  it("carries a date and a non-date key together in one well-formed string", () => {
    // Regression: building this as two concatenated calls produced a bare
    // "&shift=am" — a malformed href — whenever the date was absent.
    expect(carryParams(q("shift=am"), ["date", "shift"], { unvalidated: ["shift"] })).toBe(
      "?shift=am",
    );
    expect(
      carryParams(q("date=2026-05-30&shift=am"), ["date", "shift"], {
        unvalidated: ["shift"],
      }),
    ).toBe("?date=2026-05-30&shift=am");
  });
});

describe("statementPeriodQueries", () => {
  it("passes a start/end period straight to the range tabs", () => {
    const { range } = statementPeriodQueries(
      new URLSearchParams("start=2026-03-01&end=2026-03-31"),
    );
    expect(range).toBe("?start=2026-03-01&end=2026-03-31");
  });

  it("positions the balance sheet at the CLOSE of the period you were reading", () => {
    // A balance sheet is a point in time, not a range — the honest mapping of
    // "I was looking at March" is "the position at 31 March".
    const { asOf } = statementPeriodQueries(
      new URLSearchParams("start=2026-03-01&end=2026-03-31"),
    );
    expect(asOf).toBe("?as_of=2026-03-31");
  });

  it("turns a balance-sheet as_of back into year-to-date through that date", () => {
    // Matches what both range pages default to on their own (1 Jan → today).
    const { range, asOf } = statementPeriodQueries(new URLSearchParams("as_of=2026-03-31"));
    expect(range).toBe("?start=2026-01-01&end=2026-03-31");
    expect(asOf).toBe("?as_of=2026-03-31");
  });

  it("prefers an explicit start/end over as_of when a URL somehow carries both", () => {
    const { range, asOf } = statementPeriodQueries(
      new URLSearchParams("start=2026-02-01&end=2026-02-28&as_of=2025-12-31"),
    );
    expect(range).toBe("?start=2026-02-01&end=2026-02-28");
    expect(asOf).toBe("?as_of=2026-02-28");
  });

  it("carries nothing when nothing is selected", () => {
    expect(statementPeriodQueries(new URLSearchParams(""))).toEqual({ range: "", asOf: "" });
  });

  it("ignores junk dates instead of forwarding them into a query", () => {
    expect(statementPeriodQueries(new URLSearchParams("start=nope&end=nope"))).toEqual({
      range: "",
      asOf: "",
    });
    expect(statementPeriodQueries(new URLSearchParams("as_of=2026-13-45"))).toEqual({
      range: "",
      asOf: "",
    });
  });

  it("still fixes the balance sheet when only one end of the range is set", () => {
    const { range, asOf } = statementPeriodQueries(new URLSearchParams("end=2026-06-30"));
    expect(range).toBe("?end=2026-06-30");
    expect(asOf).toBe("?as_of=2026-06-30");
  });

  it("cannot point the balance sheet at a start date alone", () => {
    // No closing date is implied by a start, so leave the balance sheet alone.
    const { range, asOf } = statementPeriodQueries(new URLSearchParams("start=2026-06-01"));
    expect(range).toBe("?start=2026-06-01");
    expect(asOf).toBe("");
  });
});

describe("operations ⇄ financial-statements period remap", () => {
  it("remaps Operations' from/to onto the statement pages' start/end", () => {
    expect(operationsToStatementQuery("2026-01-01", "2026-03-31")).toBe(
      "?start=2026-01-01&end=2026-03-31",
    );
  });

  it("remaps the statement pages' start/end back onto Operations' from/to", () => {
    expect(statementToOperationsQuery("2026-01-01", "2026-03-31")).toBe(
      "?from=2026-01-01&to=2026-03-31",
    );
  });

  it("round-trips a period through both directions unchanged", () => {
    const there = operationsToStatementQuery("2026-05-01", "2026-05-31");
    const params = new URLSearchParams(there);
    expect(statementToOperationsQuery(params.get("start")!, params.get("end")!)).toBe(
      "?from=2026-05-01&to=2026-05-31",
    );
  });

  it("does NOT pass the keys through unchanged — the whole point of the remap", () => {
    // A blind passthrough would send from/to to a page that reads start/end,
    // which renders as that page's own default with no sign anything was lost.
    expect(operationsToStatementQuery("2026-01-01", "2026-03-31")).not.toContain("from=");
    expect(statementToOperationsQuery("2026-01-01", "2026-03-31")).not.toContain("start=");
  });

  it("drops a junk date rather than forwarding it into the next page's query", () => {
    expect(operationsToStatementQuery("nope", "2026-03-31")).toBe("");
    expect(operationsToStatementQuery("2026-01-01", "2026-13-45")).toBe("");
    expect(statementToOperationsQuery("2026-02-30", "2026-03-31")).toBe("");
    expect(statementToOperationsQuery("", "")).toBe("");
  });

  it("needs BOTH ends — a half range would silently pin one bound and default the other", () => {
    expect(operationsToStatementQuery("2026-01-01", "")).toBe("");
    expect(statementToOperationsQuery("", "2026-03-31")).toBe("");
  });
});

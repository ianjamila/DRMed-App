import { describe, expect, it } from "vitest";
import { bucketCashMovements, type CashFlowLine } from "./cash-flow-buckets";

const SEPT = { start: "2026-09-01", end: "2026-09-30" };

const line = (
  source_kind: string,
  debit: number,
  credit: number,
  original?: { source_kind: string; posting_date: string } | null,
): CashFlowLine => ({
  debit_php: debit,
  credit_php: credit,
  journal_entries: { source_kind, original },
});

const net = (m: Map<string, { inflow: number; outflow: number }>) =>
  [...m.values()].reduce((s, b) => s + b.inflow - b.outflow, 0);

describe("bucketCashMovements", () => {
  it("groups ordinary lines by source_kind", () => {
    const m = bucketCashMovements(
      [line("payment", 1000, 0), line("payment", 500, 0), line("bill_payment", 0, 300)],
      SEPT,
    );
    expect(Object.fromEntries(m)).toEqual({
      payment: { inflow: 1500, outflow: 0, count: 2 },
      bill_payment: { inflow: 0, outflow: 300, count: 1 },
    });
  });

  it("cancels an in-period undo inside the original's category, not under JE reversals", () => {
    const lines = [
      line("payment", 1000, 0),
      line("payment", 1500, 0), // undone below
      line("reversal", 0, 1500, { source_kind: "payment", posting_date: "2026-09-22" }),
    ];
    const m = bucketCashMovements(lines, SEPT);
    expect(m.get("payment")).toEqual({ inflow: 1000, outflow: 0, count: 1 });
    expect(m.has("reversal")).toBe(false);
  });

  it("keeps the net movement exactly what a plain sum of the lines gives", () => {
    const lines = [
      line("payment", 1500, 0),
      line("reversal", 0, 1500, { source_kind: "payment", posting_date: "2026-09-22" }),
      line("bill_payment", 0, 800),
      line("reversal", 800, 0, { source_kind: "bill_payment", posting_date: "2026-09-03" }),
      line("payment", 200, 0),
      line("reversal", 0, 90, { source_kind: "payment", posting_date: "2026-08-31" }),
    ];
    const plain = lines.reduce(
      (s, l) => s + Number(l.debit_php) - Number(l.credit_php),
      0,
    );
    expect(net(bucketCashMovements(lines, SEPT))).toBeCloseTo(plain, 2);
  });

  it("cancels an undone outflow the other way round", () => {
    const m = bucketCashMovements(
      [
        line("bill_payment", 0, 800),
        line("reversal", 800, 0, { source_kind: "bill_payment", posting_date: "2026-09-03" }),
      ],
      SEPT,
    );
    // Every line cancelled — the category drops out entirely.
    expect(m.size).toBe(0);
  });

  it("files an undo of an EARLIER period's entry as a movement in the original's category", () => {
    const m = bucketCashMovements(
      [line("reversal", 0, 90, { source_kind: "payment", posting_date: "2026-08-31" })],
      SEPT,
    );
    expect(Object.fromEntries(m)).toEqual({ payment: { inflow: 0, outflow: 90, count: 1 } });
  });

  it("treats the period's first and last day as inside it", () => {
    for (const posting_date of [SEPT.start, SEPT.end]) {
      const m = bucketCashMovements(
        [
          line("payment", 40, 0),
          line("reversal", 0, 40, { source_kind: "payment", posting_date }),
        ],
        SEPT,
      );
      expect(m.size).toBe(0);
    }
  });

  it("leaves a mirror whose original is unknown under reversal, so no money is dropped", () => {
    const m = bucketCashMovements([line("reversal", 0, 75, null), line("reversal", 0, 25)], SEPT);
    expect(Object.fromEntries(m)).toEqual({ reversal: { inflow: 0, outflow: 100, count: 2 } });
  });

  it("does not leave float dust behind a cancelled pair", () => {
    const m = bucketCashMovements(
      [
        line("payment", 0.1, 0),
        line("payment", 0.2, 0),
        line("reversal", 0, 0.3, { source_kind: "payment", posting_date: "2026-09-10" }),
        line("payment", 5, 0),
      ],
      SEPT,
    );
    expect(m.get("payment")?.inflow).toBe(5);
  });

  it("reads numeric strings, as PostgREST can return numeric columns", () => {
    const m = bucketCashMovements(
      [{ debit_php: "12.50", credit_php: "0", journal_entries: { source_kind: "payment" } }],
      SEPT,
    );
    expect(m.get("payment")).toEqual({ inflow: 12.5, outflow: 0, count: 1 });
  });

  it("files a line with no entry under manual, as the page always has", () => {
    const m = bucketCashMovements([{ debit_php: 10, credit_php: 0, journal_entries: null }], SEPT);
    expect(m.get("manual")).toEqual({ inflow: 10, outflow: 0, count: 1 });
  });
});

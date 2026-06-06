import { describe, it, expect } from "vitest";
import {
  CASH_METHOD_ORDER,
  buildCollectionsMatrix,
  buildCreditCardPanel,
  buildCashReconRows,
  type CollectionRow,
  type HmoReceivedRow,
  type EodCloseRow,
} from "./cash-report";

const days = ["2023-12-01", "2023-12-02"];

const collections: CollectionRow[] = [
  { business_date: "2023-12-01", section: "lab",     method: "cash",  line_count: 5, amount: "7960.00" },
  { business_date: "2023-12-01", section: "consult", method: "cash",  line_count: 1, amount: "100.00" },
  { business_date: "2023-12-02", section: "lab",     method: "gcash", line_count: 2, amount: "300.00" },
  { business_date: "2023-12-02", section: "lab",     method: "maya",  line_count: 1, amount: "50.00" },
];

const hmo: HmoReceivedRow[] = [
  { received_date: "2023-12-02", source: "historic", claim_count: 3, amount: "1500.00" },
];

describe("buildCollectionsMatrix", () => {
  const m = buildCollectionsMatrix(collections, days, hmo);

  it("groups Lab and Consult sections with one row per present method", () => {
    expect(m.sections.map((s) => s.title)).toEqual(["Lab", "Consult"]);
    const labMethods = m.sections[0].rows.filter((r) => r.kind === "method").map((r) => r.method);
    expect(labMethods).toEqual(["cash", "gcash", "maya"]); // sheet order, extras appended
  });

  it("places amounts on the right day and section", () => {
    const labCash = m.sections[0].rows.find((r) => r.method === "cash")!;
    expect(labCash.values["2023-12-01"]).toBe(7960);
    const consultCash = m.sections[1].rows.find((r) => r.method === "cash")!;
    expect(consultCash.values["2023-12-01"]).toBe(100);
  });

  it("computes per-section totals additively", () => {
    const labTotal = m.sections[0].rows.find((r) => r.kind === "section_total")!;
    expect(labTotal.values["2023-12-01"]).toBe(7960);
    expect(labTotal.values["2023-12-02"]).toBe(350); // 300 gcash + 50 maya
  });

  it("adds an HMO received row from the hmo view", () => {
    expect(m.hmoReceived.values["2023-12-02"]).toBe(1500);
    expect(m.hmoReceived.values["2023-12-01"]).toBe(0);
  });

  it("grand total = collections (all sections) + HMO received", () => {
    expect(m.total.values["2023-12-01"]).toBe(8060);          // 7960 + 100
    expect(m.total.values["2023-12-02"]).toBe(350 + 1500);    // collections + hmo
  });

  it("omits a method with no non-zero amount anywhere", () => {
    expect(CASH_METHOD_ORDER).toContain("bpi");
    const hasBpi = m.sections.some((s) => s.rows.some((r) => r.method === "bpi"));
    expect(hasBpi).toBe(false);
  });
});

describe("buildCreditCardPanel", () => {
  it("rolls up card-method IN by day with a total and the not-tracked flag", () => {
    const panel = buildCreditCardPanel(
      [
        { business_date: "2026-05-23", section: "lab", method: "card", line_count: 2, amount: "1876.00" },
        { business_date: "2026-05-23", section: "lab", method: "cash", line_count: 1, amount: "100.00" },
      ],
      ["2026-05-22", "2026-05-23"],
    );
    expect(panel.in.values["2026-05-23"]).toBe(1876);
    expect(panel.in.values["2026-05-22"]).toBe(0);
    expect(panel.totalIn).toBe(1876);
    expect(panel.settlementTracked).toBe(false);
  });
});

describe("buildCashReconRows", () => {
  it("maps closed rows to expected/counted/variance and flags unreconciled days", () => {
    const eod: EodCloseRow[] = [
      { business_date: "2026-05-23", expected_cash_php: "5000.00", counted_cash_php: "4990.00", variance_php: "-10.00" },
    ];
    const rows = buildCashReconRows(eod, ["2026-05-22", "2026-05-23"]);
    const may23 = rows.find((r) => r.day === "2026-05-23")!;
    expect(may23.reconciled).toBe(true);
    expect(may23.variance).toBe(-10);
    const may22 = rows.find((r) => r.day === "2026-05-22")!;
    expect(may22.reconciled).toBe(false);
  });

  it("aggregates multiple shift rows on the same day", () => {
    const eod: EodCloseRow[] = [
      { business_date: "2026-05-23", expected_cash_php: "1000", counted_cash_php: "1000", variance_php: "0" },
      { business_date: "2026-05-23", expected_cash_php: "2000", counted_cash_php: "1995", variance_php: "-5" },
    ];
    const rows = buildCashReconRows(eod, ["2026-05-23"]);
    expect(rows[0].expected).toBe(3000);
    expect(rows[0].variance).toBe(-5);
  });
});

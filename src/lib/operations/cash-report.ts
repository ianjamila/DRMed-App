// Pure pivot + formatting helpers for the Operations Cash & cards report (B1.2).
// NO "server-only" import — vitest-tested + shared with the CSV route.
import { channelLabel, num, type Section } from "./daily-report";

export const CASH_METHOD_ORDER = ["cash", "gcash", "bpi", "bank_transfer", "card"] as const;
const SECTION_TITLES: Record<Section, string> = { lab: "Lab", consult: "Consult" } as const;

export interface CollectionRow {
  business_date: string;
  section: "lab" | "consult" | "unknown";
  method: string;
  line_count: number;
  amount: string | number | null;
}
export interface HmoReceivedRow {
  received_date: string;
  source: "live" | "historic";
  claim_count: number;
  amount: string | number | null;
}

export type CashRowKind = "method" | "section_total" | "hmo" | "grand_total";
export interface CashMatrixRow {
  label: string;
  kind: CashRowKind;
  method?: string;
  values: Record<string, number>; // keyed by ISO day
}
export interface CashMatrixSection {
  title: string;
  rows: CashMatrixRow[]; // method rows then a section_total row
}
export interface CashMatrix {
  days: string[];
  sections: CashMatrixSection[];
  hmoReceived: CashMatrixRow;
  total: CashMatrixRow;
}

function zeroes(days: string[]): Record<string, number> {
  return Object.fromEntries(days.map((d) => [d, 0]));
}

/** Ordered list of methods that actually carry a non-zero amount, sheet-order first. */
function presentMethods(rows: CollectionRow[]): string[] {
  const nonZero = new Set<string>();
  for (const r of rows) if (num(r.amount) !== 0) nonZero.add(r.method);
  const ordered = CASH_METHOD_ORDER.filter((m) => nonZero.has(m));
  const extras = [...nonZero]
    .filter((m) => !CASH_METHOD_ORDER.includes(m as (typeof CASH_METHOD_ORDER)[number]))
    .sort();
  return [...ordered, ...extras];
}

export function buildCollectionsMatrix(
  rows: CollectionRow[],
  days: string[],
  hmo: HmoReceivedRow[],
): CashMatrix {
  const daySet = new Set(days);
  const sections: CashMatrixSection[] = (["lab", "consult"] as const).map((section) => {
    const secRows = rows.filter((r) => r.section === section);
    const methods = presentMethods(secRows);
    const methodRows: CashMatrixRow[] = methods.map((method) => {
      const values = zeroes(days);
      for (const r of secRows) {
        if (r.method === method && daySet.has(r.business_date)) values[r.business_date] += num(r.amount);
      }
      return { label: `${SECTION_TITLES[section]} — ${channelLabel(method)}`, kind: "method", method, values };
    });
    const totalValues = zeroes(days);
    for (const r of secRows) if (daySet.has(r.business_date)) totalValues[r.business_date] += num(r.amount);
    methodRows.push({ label: `${SECTION_TITLES[section]} — total`, kind: "section_total", values: totalValues });
    return { title: SECTION_TITLES[section], rows: methodRows };
  });

  const hmoValues = zeroes(days);
  for (const h of hmo) if (daySet.has(h.received_date)) hmoValues[h.received_date] += num(h.amount);
  const hmoReceived: CashMatrixRow = { label: "HMO received", kind: "hmo", values: hmoValues };

  const totalValues = zeroes(days);
  for (const d of days) {
    const collected = sections.reduce(
      (sum, s) => sum + (s.rows.find((r) => r.kind === "section_total")!.values[d] ?? 0),
      0,
    );
    totalValues[d] = collected + hmoValues[d];
  }
  const total: CashMatrixRow = { label: "TOTAL CASH COLLECTED", kind: "grand_total", values: totalValues };

  return { days, sections, hmoReceived, total };
}

export interface CreditCardPanel {
  in: CashMatrixRow;        // card-method receipts (IN) by day
  totalIn: number;
  settlementTracked: false; // card is booked as cash on hand; OUT/receivable not modelled
}
export function buildCreditCardPanel(rows: CollectionRow[], days: string[]): CreditCardPanel {
  const daySet = new Set(days);
  const values = zeroes(days);
  for (const r of rows) {
    if (r.method === "card" && daySet.has(r.business_date)) values[r.business_date] += num(r.amount);
  }
  const totalIn = Object.values(values).reduce((a, b) => a + b, 0);
  return { in: { label: "Card collected (IN)", kind: "method", method: "card", values }, totalIn, settlementTracked: false };
}

export interface EodCloseRow {
  business_date: string;
  expected_cash_php: string | number | null;
  counted_cash_php: string | number | null;
  variance_php: string | number | null;
}
export interface CashReconRow {
  day: string;
  reconciled: boolean;
  expected: number;
  counted: number;
  variance: number;
}
export function buildCashReconRows(eod: EodCloseRow[], days: string[]): CashReconRow[] {
  return days.map((day) => {
    const forDay = eod.filter((e) => e.business_date === day);
    if (forDay.length === 0) return { day, reconciled: false, expected: 0, counted: 0, variance: 0 };
    return {
      day,
      reconciled: true,
      expected: forDay.reduce((s, e) => s + num(e.expected_cash_php), 0),
      counted: forDay.reduce((s, e) => s + num(e.counted_cash_php), 0),
      variance: forDay.reduce((s, e) => s + num(e.variance_php), 0),
    };
  });
}

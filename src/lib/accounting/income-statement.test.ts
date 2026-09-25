import { describe, expect, it, vi } from "vitest";
import { incomeStatementTotals, loadIncomeStatementLines, type IncomeStatementLine } from "./income-statement";
import { LEDGER_TOTAL_STATUSES } from "./ledger-status";

function line(type: string, normal: string, debit: number, credit: number): IncomeStatementLine {
  return { debit_php: debit, credit_php: credit, journal_entries: { posting_date: "2026-09-01", status: "posted" },
    chart_of_accounts: { id: type, code: "test", name: type, type, normal_balance: normal } };
}

it("calculates accrual income including contra revenue, expense reversals and normal balances", () => {
  expect(incomeStatementTotals([
    line("revenue", "credit", 0, 1000),
    line("contra_revenue", "debit", 100, 0),
    line("expense", "debit", 300, 0),
    line("expense", "debit", 0, 50),
    line("asset", "debit", 9999, 0),
  ])).toEqual({ revenue: 1000, contraRevenue: 100, expense: 250, netRevenue: 900, netIncome: 650 });
});

function queryFixture(count: number, error: { message: string } | null = null) {
  let start = 0, end = 0;
  const q = {
    from: vi.fn(() => q), select: vi.fn(() => q), eq: vi.fn(() => q),
    gte: vi.fn(() => q), lte: vi.fn(() => q), in: vi.fn(() => q), order: vi.fn(() => q),
    range: vi.fn((from: number, to: number) => { start = from; end = to; return q; }),
    returns: vi.fn(async () => ({ error, data: Array.from({ length: Math.max(0, Math.min(end + 1, count) - start) }, () => line("revenue", "credit", 0, 1)) })),
  };
  // This fixture implements only the fluent read path exercised by the loader.
  const client = q as unknown as Parameters<typeof loadIncomeStatementLines>[0];
  return { q, client };
}

describe("statement and dashboard share the posted-and-reversed journal query", () => {
  it("walks past 1000 rows with a stable order and the rendered period", async () => {
    const { q, client } = queryFixture(1001);
    const rows = await loadIncomeStatementLines(client, "2026-09-01", "2026-09-16");
    expect(incomeStatementTotals(rows).netIncome).toBe(1001);
    expect(q.from).toHaveBeenCalledWith("journal_lines");
    expect(q.gte).toHaveBeenCalledWith("journal_entries.posting_date", "2026-09-01");
    expect(q.lte).toHaveBeenCalledWith("journal_entries.posting_date", "2026-09-16");
    expect(q.in).toHaveBeenCalledWith("chart_of_accounts.type", ["revenue", "contra_revenue", "expense"]);
    expect(q.order).toHaveBeenCalledWith("id", { ascending: true });
    expect(q.range.mock.calls).toEqual([[0, 999], [1000, 1999]]);
  });
  it("does not turn a failed query into zero income", async () => {
    const { client } = queryFixture(0, { message: "failed" });
    await expect(loadIncomeStatementLines(client, "2026-09-01", "2026-09-16")).rejects.toThrow("failed");
  });
  it("does not present a ceiling-limited total as complete", async () => {
    const { client } = queryFixture(200001);
    await expect(loadIncomeStatementLines(client, "2026-09-01", "2026-09-16")).rejects.toThrow("narrow the period");
  });
  // Reversing an entry marks the ORIGINAL 'reversed' and posts a mirror
  // 'reversal' entry — a posted-only filter keeps the mirror and drops the
  // original, subtracting the amount twice instead of netting to zero. This
  // fails if the query ever reverts to `.eq("journal_entries.status", "posted")`.
  it("counts reversed entries alongside posted ones so a reversal pair nets to zero", async () => {
    const { q, client } = queryFixture(1);
    await loadIncomeStatementLines(client, "2026-09-01", "2026-09-16");
    expect(q.eq).not.toHaveBeenCalledWith("journal_entries.status", "posted");
    expect(q.in).toHaveBeenCalledWith("journal_entries.status", LEDGER_TOTAL_STATUSES);
    expect(LEDGER_TOTAL_STATUSES).toContain("reversed");
  });
});

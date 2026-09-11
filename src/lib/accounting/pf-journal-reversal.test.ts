import { describe, expect, it } from "vitest";
import { reversePfJournalLine } from "./pf-journal-reversal";

describe("reversePfJournalLine", () => {
  it("swaps debit and credit", () => {
    const out = reversePfJournalLine("je-2", {
      account_id: "acct-1",
      debit_php: 0,
      credit_php: 1500,
      description: "Doctor PF accrual (cash)",
      line_order: 1,
    });
    expect(out.debit_php).toBe(1500);
    expect(out.credit_php).toBe(0);
  });

  it("prefixes the description with Reversal:", () => {
    const out = reversePfJournalLine("je-2", {
      account_id: "acct-1",
      debit_php: 1500,
      credit_php: 0,
      description: "Doctor PF payout (cash)",
      line_order: 2,
    });
    expect(out.description).toBe("Reversal: Doctor PF payout (cash)");
  });

  it("falls back to an empty description when the original line has none", () => {
    const out = reversePfJournalLine("je-2", {
      account_id: "acct-1",
      debit_php: 1500,
      credit_php: 0,
      description: null,
      line_order: 1,
    });
    expect(out.description).toBe("Reversal: ");
  });

  it("carries the entry id and line order through unchanged", () => {
    const out = reversePfJournalLine("je-9", {
      account_id: "acct-3",
      debit_php: 200,
      credit_php: 0,
      description: "x",
      line_order: 4,
    });
    expect(out.entry_id).toBe("je-9");
    expect(out.line_order).toBe(4);
    expect(out.account_id).toBe("acct-3");
  });
});

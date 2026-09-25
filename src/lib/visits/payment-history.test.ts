import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  crossVisitLinkIds,
  linkPayments,
  stripCorrectionPrefix,
  type HistoryPayment,
} from "./payment-history";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/0161_payment_correction.sql"),
  "utf8",
);

function pay(p: Partial<HistoryPayment> & { id: string }): HistoryPayment {
  return {
    visit_id: "v1",
    amount_php: 100,
    method: "cash",
    voided_at: null,
    void_reason: null,
    corrects_payment_id: null,
    ...p,
  };
}

describe("linkPayments", () => {
  it("reads an untouched payment as active", () => {
    const a = pay({ id: "a" });
    expect(linkPayments([a]).fate(a)).toBe("active");
  });

  it("reads a voided payment with a same-visit replacement as edited", () => {
    const a = pay({ id: "a", voided_at: "t", void_reason: "Edited: keyed as cash" });
    const b = pay({ id: "b", method: "gcash", corrects_payment_id: "a" });
    const l = linkPayments([a, b]);
    expect(l.fate(a)).toBe("edited");
    expect(l.replacementOf(a)).toBe(b);
    expect(l.originalOf(b)).toBe(a);
    expect(l.arrivedBy(b)).toBe("edited");
    expect(l.reason(a)).toBe("keyed as cash");
  });

  it("reads a replacement on another visit as a move, on both sides", () => {
    const a = pay({ id: "a", voided_at: "t", void_reason: "Moved: wrong visit" });
    const b = pay({ id: "b", visit_id: "v2", corrects_payment_id: "a" });
    const l = linkPayments([a, b]);
    expect(l.fate(a)).toBe("moved");
    expect(l.arrivedBy(b)).toBe("moved");
  });

  it("falls back to the void prefix when the replacement is not loaded", () => {
    const moved = pay({ id: "a", voided_at: "t", void_reason: "Moved: x" });
    const edited = pay({ id: "b", voided_at: "t", void_reason: "Edited: y" });
    const deleted = pay({ id: "c", voided_at: "t", void_reason: "Recorded twice" });
    const l = linkPayments([moved, edited, deleted]);
    expect([l.fate(moved), l.fate(edited), l.fate(deleted)]).toEqual(["moved", "edited", "deleted"]);
  });

  it("follows a chain: edited, then the correction itself deleted", () => {
    const a = pay({ id: "a", voided_at: "t1", void_reason: "Edited: x" });
    const b = pay({ id: "b", corrects_payment_id: "a", voided_at: "t2", void_reason: "Recorded twice" });
    const l = linkPayments([a, b]);
    expect(l.fate(a)).toBe("edited");
    expect(l.fate(b)).toBe("deleted");
    expect(l.arrivedBy(b)).toBe("edited");
  });

  it("gives no reason for an active row", () => {
    const a = pay({ id: "a", void_reason: null });
    expect(linkPayments([a]).reason(a)).toBeNull();
  });
});

describe("stripCorrectionPrefix", () => {
  it("strips exactly the prefixes correct_payment writes", () => {
    expect(MIGRATION).toContain("case when v_moving then 'Moved: ' else 'Edited: ' end");
    expect(stripCorrectionPrefix("Edited: a")).toBe("a");
    expect(stripCorrectionPrefix("Moved: b")).toBe("b");
    expect(stripCorrectionPrefix("Deleted: c")).toBe("Deleted: c");
    expect(stripCorrectionPrefix(null)).toBeNull();
  });
});

describe("crossVisitLinkIds", () => {
  it("asks for replacements of voided rows and originals not already loaded", () => {
    const rows = [
      pay({ id: "a", voided_at: "t" }),
      pay({ id: "b", corrects_payment_id: "a" }),
      pay({ id: "c", corrects_payment_id: "elsewhere" }),
    ];
    expect(crossVisitLinkIds(rows)).toEqual({ replacementsOf: ["a"], originals: ["elsewhere"] });
  });
});

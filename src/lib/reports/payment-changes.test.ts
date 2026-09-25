import { describe, expect, it } from "vitest";
import {
  comparePaymentChanges,
  derivePaymentChanges,
  parsePaymentChangesParams,
  paymentChangeOutcome,
  paymentChangesCsvHref,
  paymentChangesCsvRows,
  PAYMENT_CHANGES_CSV_HEADER,
  summarisePaymentChanges,
  type VoidedPaymentRow,
} from "./payment-changes";

function row(p: Partial<VoidedPaymentRow> & { id: string }): VoidedPaymentRow {
  return {
    visit_id: "v1",
    amount_php: 5888,
    method: "cash",
    reference_number: null,
    received_at: "2026-09-24T01:00:00Z",
    voided_at: null,
    voided_by: null,
    void_reason: null,
    corrects_payment_id: null,
    visits: { visit_number: "0043", patients: { first_name: "Pedro", last_name: "Garcia", drm_id: "DRM-1" } },
    ...p,
  };
}

const STAFF = new Map([
  ["s1", "Ana Reyes"],
  ["s2", "Ben Cruz"],
]);

describe("derivePaymentChanges", () => {
  const edited = row({ id: "a", voided_at: "2026-09-24T02:00:00Z", voided_by: "s1", void_reason: "Edited: keyed as cash" });
  const editRep = row({ id: "a2", method: "gcash", corrects_payment_id: "a" });
  const moved = row({ id: "b", voided_at: "2026-09-24T03:00:00Z", voided_by: "s1", void_reason: "Moved: wrong visit" });
  const moveRep = row({
    id: "b2",
    visit_id: "v2",
    corrects_payment_id: "b",
    visits: { visit_number: "0044", patients: { first_name: "Maria", last_name: "Santos", drm_id: "DRM-2" } },
  });
  const deleted = row({ id: "c", amount_php: 500, voided_at: "2026-09-24T04:00:00Z", voided_by: "s2", void_reason: "Recorded twice" });
  const rollback = row({ id: "d", method: "gift_code", voided_at: "2026-09-24T05:00:00Z", void_reason: "redemption_rollback" });

  const entries = derivePaymentChanges([edited, moved, deleted, rollback], [editRep, moveRep], STAFF);
  const byId = new Map(entries.map((e) => [e.id, e]));

  it("classifies edited, moved and deleted payments", () => {
    expect(byId.get("a")!.fate).toBe("edited");
    expect(byId.get("b")!.fate).toBe("moved");
    expect(byId.get("c")!.fate).toBe("deleted");
  });

  it("strips the correction prefix and names system rollbacks", () => {
    expect(byId.get("a")!.reason).toBe("keyed as cash");
    expect(byId.get("d")!.reason).toBe("Automatic: gift code redemption rolled back");
  });

  it("describes what each became", () => {
    expect(paymentChangeOutcome(byId.get("a")!)).toMatch(/^Now ₱5,888 GCash$/);
    expect(paymentChangeOutcome(byId.get("b")!)).toBe("Moved to #0044 · Santos, Maria");
    expect(paymentChangeOutcome(byId.get("c")!)).toBe("Deleted");
  });

  it("summarises the window", () => {
    const s = summarisePaymentChanges(entries);
    expect(s).toMatchObject({ total: 4, deleted: 2, edited: 1, moved: 1 });
    expect(s.deletedPhp).toBe(6388);
    expect(s.topActor).toEqual({ name: "Ana Reyes", count: 2 });
  });

  it("writes one CSV line per change under the header", () => {
    const csv = paymentChangesCsvRows(entries);
    expect(csv[0]).toEqual([...PAYMENT_CHANGES_CSV_HEADER]);
    expect(csv).toHaveLength(5);
    const movedLine = csv.find((l) => l[1] === "Moved")!;
    expect(movedLine[10]).toBe("0044");
  });

  it("sorts an unknown staff member last in both directions", () => {
    const withUnknown = entries.filter((e) => e.id !== "b");
    for (const dir of ["asc", "desc"] as const) {
      const sorted = [...withUnknown].sort((x, y) => comparePaymentChanges(x, y, { key: "by", dir }));
      expect(sorted[sorted.length - 1]!.id).toBe("d");
    }
  });
});

describe("parsePaymentChangesParams", () => {
  it("defaults to the last 90 days and all kinds", () => {
    expect(parsePaymentChangesParams({}, "2026-09-24")).toEqual({
      start: "2026-06-26",
      end: "2026-09-24",
      kind: "all",
    });
  });

  it("ignores an unknown kind", () => {
    expect(parsePaymentChangesParams({ kind: "stolen" }, "2026-09-24").kind).toBe("all");
    expect(parsePaymentChangesParams({ kind: "moved" }, "2026-09-24").kind).toBe("moved");
  });

  it("carries a kind into the CSV link only when set", () => {
    expect(paymentChangesCsvHref({ start: "2026-09-01", end: "2026-09-24", kind: "all" })).not.toContain("kind");
    expect(paymentChangesCsvHref({ start: "2026-09-01", end: "2026-09-24", kind: "edited" })).toContain("kind=edited");
  });
});

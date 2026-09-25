import { describe, expect, it } from "vitest";
import {
  comparePaymentChanges,
  deleteReasonLabel,
  deriveInPlaceEdits,
  derivePaymentChanges,
  parsePaymentChangesParams,
  paymentChangeOutcome,
  paymentChangesCsvFilename,
  paymentChangesCsvHref,
  paymentChangesCsvRows,
  matchesDeleteReason,
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
    expect(movedLine[11]).toBe("0044");
  });

  it("puts the Delete reason beside the change, blank for edits and moves", () => {
    const csv = paymentChangesCsvRows(entries);
    const col = PAYMENT_CHANGES_CSV_HEADER.indexOf("Delete reason");
    expect(col).toBe(2);
    const cell = (id: string) => csv[1 + entries.findIndex((e) => e.id === id)]![col];
    expect(cell("c")).toBe("Recorded twice");
    expect(cell("d")).toBe("Not recorded");
    expect(cell("a")).toBe("");
    expect(cell("b")).toBe("");
  });

  it("sorts an unknown staff member last in both directions", () => {
    const withUnknown = entries.filter((e) => e.id !== "b");
    for (const dir of ["asc", "desc"] as const) {
      const sorted = [...withUnknown].sort((x, y) => comparePaymentChanges(x, y, { key: "by", dir }));
      expect(sorted[sorted.length - 1]!.id).toBe("d");
    }
  });
});

describe("Delete reason (category picked in the Delete dialog)", () => {
  const del = (id: string, void_reason: string | null) =>
    row({ id, voided_at: "2026-09-25T02:00:00Z", voided_by: "s1", void_reason });
  const entries = derivePaymentChanges(
    [
      del("twice", "Recorded twice: keyed by both shifts"),
      del("refund", "Patient refunded"),
      del("other", "Other: patient disputed the charge"),
      del("old", "wrong patient"),
      row({ id: "ed", voided_at: "2026-09-25T02:00:00Z", void_reason: "Edited: Other: typo" }),
    ],
    [],
    STAFF,
  );
  const byId = new Map(entries.map((e) => [e.id, e]));

  it("reads the category off the prefix and keeps the note as the reason", () => {
    expect(byId.get("twice")).toMatchObject({ category: "recorded_twice", reason: "keyed by both shifts" });
    expect(byId.get("refund")).toMatchObject({ category: "refunded", reason: null });
    expect(byId.get("other")).toMatchObject({ category: "other", reason: "patient disputed the charge" });
  });

  it("leaves a delete from before the picker uncategorised, reason intact", () => {
    expect(byId.get("old")).toMatchObject({ category: null, reason: "wrong patient" });
    expect(deleteReasonLabel(byId.get("old")!)).toBe("Not recorded");
  });

  it("never gives an edit or a move a delete category", () => {
    expect(byId.get("ed")).toMatchObject({ fate: "edited", category: null, reason: "Other: typo" });
    expect(deleteReasonLabel(byId.get("ed")!)).toBe("");
  });

  it("breaks the Deleted tile down by reason, most common first", () => {
    const more = derivePaymentChanges(
      [del("t2", "Recorded twice"), del("t3", "Recorded twice: again")],
      [],
      STAFF,
    );
    expect(summarisePaymentChanges([...entries, ...more]).deletedByReason).toEqual([
      { why: "recorded_twice", label: "Recorded twice", count: 3 },
      { why: "refunded", label: "Patient refunded", count: 1 },
      { why: "other", label: "Other", count: 1 },
      { why: "none", label: "Not recorded", count: 1 },
    ]);
  });

  it("filters to one category, to uncategorised deletes, or not at all", () => {
    const ids = (why: Parameters<typeof matchesDeleteReason>[1]) =>
      entries.filter((e) => matchesDeleteReason(e, why)).map((e) => e.id);
    expect(ids("all")).toHaveLength(5);
    expect(ids("refunded")).toEqual(["refund"]);
    expect(ids("none")).toEqual(["old"]);
    expect(ids("wrong_visit")).toEqual([]);
  });
});

describe("parsePaymentChangesParams", () => {
  it("defaults to the last 90 days, all kinds and any reason", () => {
    expect(parsePaymentChangesParams({}, "2026-09-24")).toEqual({
      start: "2026-06-26",
      end: "2026-09-24",
      kind: "all",
      why: "all",
    });
  });

  it("reads a known Delete reason and ignores anything else", () => {
    expect(parsePaymentChangesParams({ why: "refunded" }, "2026-09-24").why).toBe("refunded");
    expect(parsePaymentChangesParams({ why: "none" }, "2026-09-24").why).toBe("none");
    expect(parsePaymentChangesParams({ why: "Recorded twice" }, "2026-09-24").why).toBe("all");
  });

  it("carries the Delete reason into the CSV link and filename only when set", () => {
    const p = { start: "2026-09-01", end: "2026-09-24", kind: "all" as const };
    expect(paymentChangesCsvHref({ ...p, why: "all" })).not.toContain("why");
    expect(paymentChangesCsvHref({ ...p, why: "recorded_twice" })).toContain("why=recorded_twice");
    expect(paymentChangesCsvFilename({ ...p, why: "recorded_twice" })).toBe(
      "payment-changes-recorded-twice-2026-09-01_2026-09-24.csv",
    );
  });

  it("ignores an unknown kind", () => {
    expect(parsePaymentChangesParams({ kind: "stolen" }, "2026-09-24").kind).toBe("all");
    expect(parsePaymentChangesParams({ kind: "moved" }, "2026-09-24").kind).toBe("moved");
  });

  it("carries a kind into the CSV link only when set", () => {
    expect(paymentChangesCsvHref({ start: "2026-09-01", end: "2026-09-24", kind: "all", why: "all" })).not.toContain("kind");
    expect(paymentChangesCsvHref({ start: "2026-09-01", end: "2026-09-24", kind: "edited", why: "all" })).toContain("kind=edited");
  });
});

describe("deriveInPlaceEdits (reference/notes-only edits leave no voided row)", () => {
  const pay = row({ id: "p1", reference_number: "OR-2" });
  const audits = [
    {
      id: 41,
      created_at: "2026-09-25T02:00:00Z",
      actor_id: "s2",
      resource_id: "p1",
      metadata: {
        money_changed: false,
        reason: " typo in OR ",
        before: { reference_number: "OR-1", notes: null },
        after: { reference_number: "OR-2", notes: "paid at desk" },
      },
    },
    {
      id: 42,
      created_at: "2026-09-25T03:00:00Z",
      actor_id: null,
      resource_id: "gone",
      metadata: { money_changed: false, before: { reference_number: "X", notes: "a" }, after: { reference_number: "X", notes: "b" } },
    },
  ];
  const [e1, e2] = deriveInPlaceEdits(audits, new Map([["p1", pay]]), STAFF);

  it("reads as an edit on the payment's own visit, by the audit's actor", () => {
    expect(e1.id).toBe("audit-41");
    expect(e1.fate).toBe("edited");
    expect(e1.changedAt).toBe("2026-09-25T02:00:00Z");
    expect(e1.visitNumber).toBe("0043");
    expect(e1.byName).toBe("Ben Cruz");
    expect(e1.reason).toBe("typo in OR");
    expect(e1.replacement).toBeNull();
    expect(e1.reference).toBe("OR-1");
  });

  it("says what changed", () => {
    expect(paymentChangeOutcome(e1)).toBe("Reference OR-1 → OR-2 · Notes changed");
    expect(paymentChangeOutcome(e2)).toBe("Notes changed");
  });

  it("survives a payment the report could not load", () => {
    expect(e2.visitNumber).toBeNull();
    expect(e2.byName).toBeNull();
  });

  it("counts in the Edited tile", () => {
    expect(summarisePaymentChanges([e1, e2]).edited).toBe(2);
  });

  it("exports its before → after in the CSV Outcome column", () => {
    const [, line] = paymentChangesCsvRows([e1]);
    expect(line[PAYMENT_CHANGES_CSV_HEADER.indexOf("Outcome")]).toBe("Reference OR-1 → OR-2 · Notes changed");
  });
});

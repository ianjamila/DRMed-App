import { describe, expect, it } from "vitest";
import {
  buildReleasedPaymentAlertEmail,
  shouldAlertPaymentEdited,
  shouldAlertReleasedPaymentRemoved,
  type ReleasedPaymentAlertInput,
} from "./released-payment-alert-content";

const base: ReleasedPaymentAlertInput = {
  change: "deleted",
  visitNumber: "0043",
  amountPhp: 1000,
  methodLabel: "Cash",
  reasonLabel: "Recorded twice",
  movedToVisitNumber: null,
  editedTo: null,
  byName: "Ana Reyes",
  completed: { results: 3, consults: 0, procedures: 0 },
  owesPhp: 1000,
  visitUrl: "https://drmed.ph/staff/visits/v1",
};

describe("buildReleasedPaymentAlertEmail", () => {
  it("names the visit, the change, the reason and what it now owes", () => {
    const c = buildReleasedPaymentAlertEmail(base);
    expect(c.subject).toBe("Visit #0043 owes ₱1,000 after its results went out");
    expect(c.text).toContain(
      "A ₱1,000 Cash payment was deleted from visit #0043. 3 results on it are already released, and it now owes ₱1,000.",
    );
    expect(c.text).toContain("What happened: Deleted — Recorded twice");
    expect(c.text).toContain("By: Ana Reyes");
    expect(c.text).toContain("Completed work: 3 results released");
    expect(c.text).toContain("Released results stay released");
    expect(c.html).toContain("https://drmed.ph/staff/visits/v1");
  });

  it("describes a move by the visit it went to", () => {
    const c = buildReleasedPaymentAlertEmail({
      ...base,
      change: "moved",
      reasonLabel: null,
      movedToVisitNumber: "0044",
      completed: { results: 1, consults: 0, procedures: 0 },
    });
    expect(c.text).toContain("was moved off visit #0043. 1 result on it is already released");
    expect(c.text).toContain("What happened: Moved to visit #0044");
  });

  it("describes an edit by what the payment became, with no free-text reason", () => {
    const c = buildReleasedPaymentAlertEmail({
      ...base,
      change: "edited",
      reasonLabel: null,
      editedTo: { amountPhp: 800, methodLabel: "GCash" },
      owesPhp: 200,
    });
    expect(c.subject).toBe("Visit #0043 owes ₱200 after its results went out");
    expect(c.text).toContain("A ₱1,000 Cash payment on visit #0043 was edited to ₱800 GCash.");
    expect(c.text).toContain("What happened: Edited to ₱800 GCash");
    expect(c.text).not.toMatch(/reason|note/i);
  });

  it("counts a doctor consult marked done as completed work, worded apart from results", () => {
    const c = buildReleasedPaymentAlertEmail({
      ...base,
      completed: { results: 0, consults: 1, procedures: 0 },
      owesPhp: 500,
    });
    expect(c.subject).toBe("Visit #0043 owes ₱500 after its doctor consult was done");
    expect(c.text).toContain("1 doctor consult on it is already done, and it now owes ₱500.");
    expect(c.text).toContain("Completed work: 1 doctor consult done");
    expect(c.text).not.toContain("results went out");
  });

  it("names results and doctor lines together", () => {
    const c = buildReleasedPaymentAlertEmail({
      ...base,
      completed: { results: 2, consults: 1, procedures: 1 },
    });
    expect(c.subject).toBe("Visit #0043 owes ₱1,000 after its results went out and its doctor lines were done");
    expect(c.text).toContain("Completed work: 2 results released, 1 doctor consult and 1 procedure done");
  });

  it("carries no patient identity, test names or typed note (RA 10173): the input has no field for them", () => {
    // Structural: every string the email can print comes from these keys.
    expect(Object.keys(base).sort()).toEqual(
      [
        "amountPhp",
        "byName",
        "change",
        "completed",
        "editedTo",
        "methodLabel",
        "movedToVisitNumber",
        "owesPhp",
        "reasonLabel",
        "visitNumber",
        "visitUrl",
      ].sort(),
    );
    expect(Object.keys(base.completed).sort()).toEqual(["consults", "procedures", "results"]);
  });

  it("escapes staff names in the HTML", () => {
    expect(buildReleasedPaymentAlertEmail({ ...base, byName: "<b>x</b>" }).html).not.toContain("<b>x</b>");
  });
});

describe("shouldAlertReleasedPaymentRemoved (Delete, Move)", () => {
  it("alerts only when the visit owes again AND work on it was completed", () => {
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: false, completedWork: 2 })).toBe(true);
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: true, completedWork: 2 })).toBe(false);
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: false, completedWork: 0 })).toBe(false);
  });
  it("a doctor consult marked done counts as completed work (a consult-only visit alerts)", () => {
    // completedWork is results + consults + procedures — the caller sums
    // them; 1 here stands for one done consult and no result.
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: false, completedWork: 1 })).toBe(true);
  });
  it("does not alert when the re-read failed", () => {
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: null, completedWork: 2 })).toBe(false);
    expect(shouldAlertReleasedPaymentRemoved({ settledAfter: false, completedWork: null })).toBe(false);
  });
});

describe("shouldAlertPaymentEdited (Edit)", () => {
  const edit = {
    moneyChanged: true,
    oldAmountPhp: 1000,
    newAmountPhp: 800,
    settledAfter: false,
    completedWork: 2,
  };
  it("alerts when the amount came down, the visit owes again and work was completed", () => {
    expect(shouldAlertPaymentEdited(edit)).toBe(true);
  });
  it("never alerts on a reference/notes-only edit", () => {
    expect(shouldAlertPaymentEdited({ ...edit, moneyChanged: false, newAmountPhp: 1000 })).toBe(false);
  });
  it("never alerts when the money did not leave the visit: a method-only change or an amount going up", () => {
    // Money changed (method) but the amount is the same — nothing was removed.
    expect(shouldAlertPaymentEdited({ ...edit, newAmountPhp: 1000 })).toBe(false);
    // More money on a visit that still owes is not a removal either.
    expect(shouldAlertPaymentEdited({ ...edit, oldAmountPhp: 500, newAmountPhp: 800 })).toBe(false);
  });
  it("compares in centavos", () => {
    expect(shouldAlertPaymentEdited({ ...edit, oldAmountPhp: 0.3, newAmountPhp: 0.1 + 0.2 })).toBe(false);
  });
  it("still needs the visit to owe again and completed work on it", () => {
    expect(shouldAlertPaymentEdited({ ...edit, settledAfter: true })).toBe(false);
    expect(shouldAlertPaymentEdited({ ...edit, completedWork: 0 })).toBe(false);
    expect(shouldAlertPaymentEdited({ ...edit, settledAfter: null })).toBe(false);
    expect(shouldAlertPaymentEdited({ ...edit, completedWork: null })).toBe(false);
  });
});

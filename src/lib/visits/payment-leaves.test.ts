import { describe, expect, it } from "vitest";
import { formatPhp } from "@/lib/marketing/format";
import {
  completedWorkCount,
  completedWorkSummary,
  completedWorkWentPhrase,
  countReleasedLines,
  NO_RELEASED,
  paymentLeavesMessage,
  paymentLeavesState,
  paymentStatusAfter,
  releasedWhileUnpaidMessage,
  settledAfter,
  type ReleasableLine,
  type VisitMoney,
} from "./payment-edit";

const visit = (p: Partial<VisitMoney> = {}): VisitMoney => ({
  totalPhp: 1000,
  paidPhp: 1000,
  paymentStatus: "paid",
  hmoProviderId: null,
  ...p,
});

const line = (kind: string, p: Partial<ReleasableLine> = {}): ReleasableLine => ({
  status: "released",
  is_package_header: false,
  kind,
  ...p,
});

const TWO_RESULTS = { results: 2, consults: 0, procedures: 0 };

describe("paymentStatusAfter mirrors recalc_visit_payment (0111)", () => {
  it("full delete leaves the visit unpaid", () => {
    expect(paymentStatusAfter(visit(), -1000)).toBe("unpaid");
  });
  it("partial delete leaves it partial", () => {
    expect(paymentStatusAfter(visit(), -400)).toBe("partial");
  });
  it("a duplicate on an overpaid visit leaves it paid", () => {
    expect(paymentStatusAfter(visit({ paidPhp: 2000 }), -1000)).toBe("paid");
  });
  it("a ₱0 bill is paid whatever is voided", () => {
    expect(paymentStatusAfter(visit({ totalPhp: 0, paidPhp: 100 }), -100)).toBe("paid");
  });
  it("a waived visit stays waived", () => {
    expect(paymentStatusAfter(visit({ paymentStatus: "waived", paidPhp: 300 }), -300)).toBe("waived");
  });
  it("works in centavos (no float drift at the boundary)", () => {
    expect(paymentStatusAfter(visit({ totalPhp: 0.3, paidPhp: 0.4 }), -0.1)).toBe("paid");
  });
});

describe("settledAfter reuses money-settled.ts", () => {
  it("is false once an ordinary visit owes again", () => {
    expect(settledAfter(visit(), -1)).toBe(false);
  });
  it("is true for an HMO visit whatever the payments", () => {
    expect(settledAfter(visit({ hmoProviderId: "h1" }), -1000)).toBe(true);
  });
  it("is true for a waived visit", () => {
    expect(settledAfter(visit({ paymentStatus: "waived" }), -1000)).toBe(true);
  });
});

describe("countReleasedLines", () => {
  it("counts lab and imaging results, never package headers", () => {
    expect(
      countReleasedLines([
        line("lab_package", { is_package_header: true }),
        line("lab_test"),
        line("lab_test"),
        line("imaging"),
      ]),
    ).toEqual({ results: 3, consults: 0, procedures: 0 });
  });
  it("counts package components as results", () => {
    expect(countReleasedLines([line("lab_package", { is_package_header: true }), line("lab_test")]).results).toBe(1);
  });
  it("keeps doctor kinds out of the result count", () => {
    expect(countReleasedLines([line("doctor_consultation"), line("doctor_procedure"), line("lab_test")])).toEqual({
      results: 1,
      consults: 1,
      procedures: 1,
    });
  });
  it("ignores lines that are not released", () => {
    expect(countReleasedLines([line("lab_test", { status: "ready_for_release" })])).toEqual(NO_RELEASED);
  });
  it("reads an unknown kind as a lab result (classifyKind)", () => {
    expect(countReleasedLines([line("vaccine"), line("", { kind: null })]).results).toBe(2);
  });
});

describe("paymentLeavesState (the dialog preview)", () => {
  it("full delete with released results: owes the whole bill", () => {
    expect(paymentLeavesState(visit(), 1000, TWO_RESULTS)).toEqual({
      kind: "owes",
      balancePhp: 1000,
      released: TWO_RESULTS,
    });
  });
  it("partial delete: owes what left", () => {
    expect(paymentLeavesState(visit(), 400, TWO_RESULTS)).toMatchObject({ kind: "owes", balancePhp: 400 });
  });
  it("recorded twice (overpaid): no warning", () => {
    expect(paymentLeavesState(visit({ paidPhp: 2000 }), 1000, TWO_RESULTS)).toBeNull();
  });
  it("owes with nothing released is still said, without emphasis", () => {
    const s = paymentLeavesState(visit(), 1000, NO_RELEASED)!;
    expect(paymentLeavesMessage(s, "0043", formatPhp)).toEqual({
      text: "Visit #0043 will then owe ₱1,000.",
      emphasis: false,
    });
  });
  it("HMO: released under HMO billing, never an amount owed", () => {
    const s = paymentLeavesState(visit({ hmoProviderId: "h1", paidPhp: 200 }), 200, TWO_RESULTS)!;
    expect(s).toEqual({ kind: "hmo", released: TWO_RESULTS });
    const { text } = paymentLeavesMessage(s, "0043", formatPhp);
    expect(text).toBe("Visit #0043 is billed to an HMO, so its 2 results were released under HMO billing and stay released.");
    expect(text).not.toMatch(/owe|left to pay/);
  });
  it("HMO with no released result: nothing to say", () => {
    expect(paymentLeavesState(visit({ hmoProviderId: "h1" }), 200, { results: 0, consults: 1, procedures: 0 })).toBeNull();
  });
  it("waived: stays waived, the money is no longer tracked", () => {
    const v = visit({ paymentStatus: "waived", paidPhp: 300 });
    const s = paymentLeavesState(v, 300, TWO_RESULTS)!;
    expect(s).toEqual({ kind: "waived", untrackedPhp: 300, released: TWO_RESULTS });
    const { text } = paymentLeavesMessage(s, "0043", formatPhp);
    expect(text).toContain("stays waived; the ₱300 is no longer tracked in Patient AR");
    expect(text).not.toMatch(/owe|left to pay/);
  });
  it("waived and overpaid: only the part that is now uncovered", () => {
    expect(paymentLeavesState(visit({ paymentStatus: "waived", paidPhp: 1200 }), 500, NO_RELEASED)).toEqual({
      kind: "waived",
      untrackedPhp: 300,
      released: NO_RELEASED,
    });
  });
  it("consult-only visit: says the consult is done, not a result", () => {
    const released = { results: 0, consults: 1, procedures: 0 };
    const s = paymentLeavesState(visit({ totalPhp: 500, paidPhp: 500 }), 500, released)!;
    expect(paymentLeavesMessage(s, "0043", formatPhp)).toEqual({
      text: "Visit #0043 will then owe ₱500, and 1 doctor consult on it is already done. Released results stay released.",
      emphasis: true,
    });
  });
  it("names results and doctor lines separately", () => {
    const s = paymentLeavesState(visit(), 1000, { results: 1, consults: 2, procedures: 1 })!;
    expect(paymentLeavesMessage(s, "0043", formatPhp).text).toBe(
      "Visit #0043 will then owe ₱1,000, and 1 result on it is already released and 2 doctor consults and 1 procedure are already done. Released results stay released.",
    );
  });
});

describe("releasedWhileUnpaidMessage (the visit page note)", () => {
  it("names the results and the balance on an unsettled visit", () => {
    expect(releasedWhileUnpaidMessage(visit({ paidPhp: 0, paymentStatus: "unpaid" }), TWO_RESULTS, formatPhp)).toBe(
      "2 results went out while this visit was paid; it now owes ₱1,000.",
    );
  });
  it("says nothing on a settled visit", () => {
    expect(releasedWhileUnpaidMessage(visit(), TWO_RESULTS, formatPhp)).toBeNull();
  });
  it("says nothing on an HMO visit (releases unpaid by design)", () => {
    expect(
      releasedWhileUnpaidMessage(visit({ paidPhp: 0, paymentStatus: "unpaid", hmoProviderId: "h1" }), TWO_RESULTS, formatPhp),
    ).toBeNull();
  });
  it("says nothing when nothing is released", () => {
    expect(releasedWhileUnpaidMessage(visit({ paidPhp: 0, paymentStatus: "unpaid" }), NO_RELEASED, formatPhp)).toBeNull();
  });
  it("words a consult as done", () => {
    expect(
      releasedWhileUnpaidMessage(
        visit({ paidPhp: 200, paymentStatus: "partial" }),
        { results: 1, consults: 1, procedures: 0 },
        formatPhp,
      ),
    ).toBe("1 result went out and 1 doctor consult was done while this visit was paid; it now owes ₱800.");
  });
});

describe("completed work = released results + doctor lines marked done", () => {
  it("completedWorkCount counts every released non-header line, doctor kinds included", () => {
    expect(
      completedWorkCount([
        line("lab_package", { is_package_header: true }),
        line("lab_test"),
        line("doctor_consultation"),
        line("doctor_procedure"),
        line("lab_test", { status: "ready_for_release" }),
      ]),
    ).toBe(3);
  });
  it("completedWorkCount is 0 for a visit with nothing released", () => {
    expect(completedWorkCount([line("lab_test", { status: "requested" })])).toBe(0);
  });
  it("completedWorkSummary words results and doctor lines apart", () => {
    expect(completedWorkSummary({ results: 3, consults: 0, procedures: 0 })).toBe("3 results released");
    expect(completedWorkSummary({ results: 0, consults: 1, procedures: 0 })).toBe("1 doctor consult done");
    expect(completedWorkSummary({ results: 2, consults: 1, procedures: 1 })).toBe(
      "2 results released, 1 doctor consult and 1 procedure done",
    );
    expect(completedWorkSummary(NO_RELEASED)).toBe("");
  });
  it("completedWorkWentPhrase is the 'after its …' clause", () => {
    expect(completedWorkWentPhrase({ results: 3, consults: 0, procedures: 0 })).toBe("its results went out");
    expect(completedWorkWentPhrase({ results: 0, consults: 1, procedures: 0 })).toBe("its doctor consult was done");
    expect(completedWorkWentPhrase({ results: 0, consults: 0, procedures: 2 })).toBe("its doctor procedures were done");
    expect(completedWorkWentPhrase({ results: 1, consults: 1, procedures: 1 })).toBe(
      "its results went out and its doctor lines were done",
    );
    expect(completedWorkWentPhrase(NO_RELEASED)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  UNCLAIM_REFUSAL_ANY,
  UNCLAIM_REFUSAL_OWN,
  evaluateClaim,
  evaluateUnclaim,
  type ClaimCandidate,
} from "./claim-eligibility";

const PAID = { payment_status: "paid", hmo_provider_id: null };

function candidate(over: Partial<ClaimCandidate> = {}): ClaimCandidate {
  return {
    isPackageHeader: false,
    isDoctorLine: false,
    section: "hematology",
    visitDeleted: false,
    visit: PAID,
    ...over,
  };
}

describe("evaluateClaim", () => {
  it("lets a medtech claim a paid hematology test", () => {
    expect(evaluateClaim(candidate(), "medtech")).toEqual({ ok: true });
  });

  it("refuses a test on a deleted visit first", () => {
    const r = evaluateClaim(candidate({ visitDeleted: true, isPackageHeader: true }), "medtech");
    expect(r).toEqual({ ok: false, error: "This visit was deleted from the queue." });
  });

  it("refuses a package header", () => {
    expect(evaluateClaim(candidate({ isPackageHeader: true }), "admin")).toEqual({
      ok: false,
      error: "Package headers cannot be claimed — they have no work.",
    });
  });

  it("refuses a doctor line even for admin", () => {
    const r = evaluateClaim(candidate({ isDoctorLine: true, section: null }), "admin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Mark done/);
  });

  it("refuses reception outright (no sections)", () => {
    expect(evaluateClaim(candidate(), "reception")).toEqual({
      ok: false,
      error: "This test is outside the sections you can claim.",
    });
  });

  it("refuses a medtech on an x-ray (outside their sections)", () => {
    expect(evaluateClaim(candidate({ section: "imaging_xray" }), "medtech")).toEqual({
      ok: false,
      error: "This test is outside the sections you can claim.",
    });
  });

  it("refuses admin and pathologist on an x-ray with the owner message", () => {
    for (const role of ["admin", "pathologist"] as const) {
      expect(evaluateClaim(candidate({ section: "imaging_xray" }), role)).toEqual({
        ok: false,
        error: "Only an X-ray technician can claim this test.",
      });
    }
  });

  it("lets the x-ray technician claim an x-ray", () => {
    expect(evaluateClaim(candidate({ section: "imaging_xray" }), "xray_technician")).toEqual({
      ok: true,
    });
  });

  it("refuses an unpaid non-HMO visit with the payment hint", () => {
    const r = evaluateClaim(
      candidate({ visit: { payment_status: "unpaid", hmo_provider_id: null } }),
      "medtech",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/waiting for payment/);
  });

  it("passes waived and HMO-covered visits", () => {
    expect(
      evaluateClaim(candidate({ visit: { payment_status: "waived", hmo_provider_id: null } }), "medtech"),
    ).toEqual({ ok: true });
    expect(
      evaluateClaim(candidate({ visit: { payment_status: "unpaid", hmo_provider_id: "hmo-1" } }), "medtech"),
    ).toEqual({ ok: true });
  });
});

describe("evaluateUnclaim", () => {
  const held = { status: "in_progress", assigned_to: "u1" };

  it("lets the holder unclaim their own test", () => {
    expect(evaluateUnclaim(held, "u1")).toEqual({ ok: true });
  });

  it("refuses someone else's test for a non-admin", () => {
    expect(evaluateUnclaim(held, "u2")).toEqual({ ok: false, error: UNCLAIM_REFUSAL_OWN });
  });

  it("lets admin (ownerId null) unclaim anyone's test", () => {
    expect(evaluateUnclaim(held, null)).toEqual({ ok: true });
  });

  it("refuses a test that is not in progress", () => {
    expect(evaluateUnclaim({ status: "result_uploaded", assigned_to: "u1" }, "u1")).toEqual({
      ok: false,
      error: UNCLAIM_REFUSAL_OWN,
    });
    expect(evaluateUnclaim({ status: "requested", assigned_to: null }, null)).toEqual({
      ok: false,
      error: UNCLAIM_REFUSAL_ANY,
    });
  });

  it("refuses an in-progress row with no holder", () => {
    expect(evaluateUnclaim({ status: "in_progress", assigned_to: null }, null)).toEqual({
      ok: false,
      error: UNCLAIM_REFUSAL_ANY,
    });
  });
});

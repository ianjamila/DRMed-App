import { describe, expect, it } from "vitest";
import { evaluateRelease, RELEASE_REFUSAL, type ReleaseCandidate } from "./release-eligibility";
import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";

const ok: ReleaseCandidate = {
  status: "ready_for_release", isPackageHeader: false, isDoctorLine: false, section: "microbiology",
  visitDeleted: false, patientActive: true, visit: { payment_status: "paid", hmo_provider_id: null },
  consentOnFile: true, gateRequired: false,
};

describe("evaluateRelease", () => {
  it("allows an in-section medtech on a paid visit", () => {
    expect(evaluateRelease(ok, "medtech")).toEqual({ ok: true });
  });
  it("denies reception outright", () => {
    expect(evaluateRelease(ok, "reception")).toEqual({ ok: false, error: RELEASE_REFUSAL.reception });
  });
  it("scopes by section", () => {
    const xray = { ...ok, section: "imaging_xray" };
    expect(evaluateRelease(xray, "medtech")).toEqual({ ok: false, error: RELEASE_REFUSAL.section });
    expect(evaluateRelease(xray, "xray_technician").ok).toBe(true);
    expect(evaluateRelease(xray, "pathologist").ok).toBe(true);
  });
  it("refuses anything not at ready_for_release", () => {
    expect(evaluateRelease({ ...ok, status: "released" }, "admin")).toEqual({ ok: false, error: RELEASE_REFUSAL.notReady });
    expect(evaluateRelease({ ...ok, status: "result_uploaded" }, "admin").ok).toBe(false);
  });
  it("refuses headers, doctor lines, deleted visits and inactive patients", () => {
    expect(evaluateRelease({ ...ok, isPackageHeader: true }, "admin").ok).toBe(false);
    expect(evaluateRelease({ ...ok, isDoctorLine: true, section: null }, "admin").ok).toBe(false);
    expect(evaluateRelease({ ...ok, visitDeleted: true }, "admin").ok).toBe(false);
    expect(evaluateRelease({ ...ok, patientActive: false }, "admin").ok).toBe(false);
  });
  it("mirrors the payment gate: unpaid blocks; waived and HMO pass", () => {
    const unpaid = { ...ok, visit: { payment_status: "unpaid", hmo_provider_id: null } };
    expect(evaluateRelease(unpaid, "admin")).toEqual({ ok: false, error: RELEASE_BLOCKED_UNPAID });
    expect(evaluateRelease({ ...ok, visit: { payment_status: "waived", hmo_provider_id: null } }, "admin").ok).toBe(true);
    expect(evaluateRelease({ ...unpaid, visit: { payment_status: "unpaid", hmo_provider_id: "h1" } }, "admin").ok).toBe(true);
  });
  it("blocks missing consent only while the gate is on", () => {
    expect(evaluateRelease({ ...ok, consentOnFile: false }, "admin").ok).toBe(true);
    expect(evaluateRelease({ ...ok, consentOnFile: false, gateRequired: true }, "admin"))
      .toEqual({ ok: false, error: RELEASE_BLOCKED_CONSENT });
  });
});

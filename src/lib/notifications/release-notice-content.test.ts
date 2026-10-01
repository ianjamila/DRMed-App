import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MAX_LISTED, renderBulkNotice, renderSingleNotice } from "./release-notice-content";

const patient = { drm_id: "DRM-0001", first_name: "Ana" };

describe("release notice content (shared by the legacy senders and the outbox)", () => {
  it("renders the single-test wording", () => {
    const r = renderSingleNotice({ patient, testName: "CBC", includeReviewCta: false });
    expect(r.emailSubject).toBe("Your DRMed lab result is ready (CBC)");
    expect(r.smsBody).toContain("your DRMed lab result for CBC is ready");
    expect(r.smsBody).toContain("DRM-0001");
    expect(r.emailText).not.toContain("Google review");
  });

  it("adds the review CTA only when asked", () => {
    expect(renderSingleNotice({ patient, testName: "CBC", includeReviewCta: true }).emailText).toContain("Google review");
    expect(renderBulkNotice({ patient, testNames: ["A", "B"], includeReviewCta: true }).emailText).toContain("Google review");
  });

  it("renders the consolidated wording and caps the listed tests", () => {
    const names = Array.from({ length: MAX_LISTED + 2 }, (_, i) => `T${i}`);
    const r = renderBulkNotice({ patient, testNames: names, includeReviewCta: false });
    expect(r.emailSubject).toBe(`${names.length} lab results ready — DRMed`);
    expect(r.emailText).toContain("  + 2 more");
    expect(r.emailText).not.toContain(`T${MAX_LISTED}`);
    expect(r.smsBody).toContain(`${names.length} results from your DRMed visit are ready`);
  });

  it("greets 'there' when the first name is missing", () => {
    expect(renderSingleNotice({ patient: { drm_id: "D", first_name: null }, testName: "X", includeReviewCta: false }).emailText).toContain("Hi there,");
  });
});

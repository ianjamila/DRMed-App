import { describe, expect, it } from "vitest";
import { recipientDecision } from "./active-patient-recipient";

const row = {
  id: "p1", drm_id: "DRM-0001", first_name: "Ana", email: "ana@example.test", phone: "09170000000",
  deleted_at: null as string | null, merged_into_id: null as string | null,
};

describe("recipientDecision", () => {
  it("treats a NULL patient id as a genuine walk-in", () => {
    expect(recipientDecision(null, null)).toEqual({ kind: "walk_in" });
  });
  it("returns the FRESH contact for an active record", () => {
    expect(recipientDecision("p1", row)).toEqual({
      kind: "active",
      patient: { id: "p1", drm_id: "DRM-0001", first_name: "Ana", email: "ana@example.test", phone: "09170000000" },
    });
  });
  it("skips deleted, merged and missing records — never a walk-in fallback", () => {
    expect(recipientDecision("p1", { ...row, deleted_at: "2026-09-24T00:00:00Z" })).toEqual({ kind: "inactive", patientId: "p1", reason: "deleted" });
    expect(recipientDecision("p1", { ...row, merged_into_id: "k" })).toEqual({ kind: "inactive", patientId: "p1", reason: "merged" });
    expect(recipientDecision("p1", null)).toEqual({ kind: "inactive", patientId: "p1", reason: "missing" });
  });
});

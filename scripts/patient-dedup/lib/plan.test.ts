// scripts/patient-dedup/lib/plan.test.ts
import { describe, it, expect } from "vitest";
import { pickCanonical, planCluster, completeness } from "./plan";
import type { PatientRow } from "./types";

function p(over: Partial<PatientRow>): PatientRow {
  return {
    id: over.id ?? "x", drm_id: over.drm_id ?? "DRM-0001",
    first_name: over.first_name ?? "Elmer", last_name: over.last_name ?? "Blancaflor",
    middle_name: over.middle_name ?? null, sex: over.sex ?? null,
    phone: over.phone ?? null, email: over.email ?? null,
    birthdate: over.birthdate ?? null, address: over.address ?? null,
    created_at: over.created_at ?? "2025-01-01T00:00:00Z",
    visit_count: over.visit_count ?? 0,
  };
}

describe("pickCanonical", () => {
  it("prefers most visits, then most complete, then oldest", () => {
    const most = p({ id: "v", visit_count: 3, created_at: "2025-06-01T00:00:00Z" });
    const complete = p({ id: "c", visit_count: 0, phone: "09170000000", email: "a@b.com", birthdate: "1990-01-01" });
    const old = p({ id: "o", visit_count: 0, created_at: "2024-01-01T00:00:00Z" });
    expect(pickCanonical([complete, old, most]).id).toBe("v");
    expect(pickCanonical([old, complete]).id).toBe("c");      // complete beats older
    const oldA = p({ id: "oa", created_at: "2024-01-01T00:00:00Z" });
    const oldB = p({ id: "ob", created_at: "2025-01-01T00:00:00Z" });
    expect(pickCanonical([oldB, oldA]).id).toBe("oa");        // oldest wins
  });
  it("tie-breaks equal timestamps by lowest DRM number", () => {
    const a = p({ id: "a", drm_id: "DRM-1838" });
    const b = p({ id: "b", drm_id: "DRM-1837" });
    expect(pickCanonical([a, b]).id).toBe("b");
  });
});

describe("classify via planCluster", () => {
  const canon = p({ id: "canon", drm_id: "DRM-0001", birthdate: "1990-05-05", sex: "F", phone: "09171112222", email: "x@y.com", created_at: "2024-01-01T00:00:00Z" });

  it("Tier 1: same DOB -> auto name+dob", () => {
    const m = p({ id: "m", birthdate: "1990-05-05" });
    const plan = planCluster([canon, m]);
    expect(plan.canonical.id).toBe("canon");
    expect(plan.auto).toEqual([{ row: expect.objectContaining({ id: "m" }), tier: "name+dob" }]);
  });
  it("Tier 2: same phone, no DOB on member -> auto name+phone", () => {
    const m = p({ id: "m", phone: "09171112222" });
    expect(planCluster([canon, m]).auto[0].tier).toBe("name+phone");
  });
  it("Tier 2': same email only -> auto name+email", () => {
    const m = p({ id: "m", email: "X@Y.com" });
    expect(planCluster([canon, m]).auto[0].tier).toBe("name+email");
  });
  it("DOB conflict -> review dob-conflict (even if phone matches)", () => {
    const m = p({ id: "m", birthdate: "1991-01-01", phone: "09171112222" });
    expect(planCluster([canon, m]).review).toEqual([{ row: expect.objectContaining({ id: "m" }), reason: "dob-conflict" }]);
  });
  it("sex conflict -> review sex-conflict", () => {
    const m = p({ id: "m", sex: "M", phone: "09171112222" });
    expect(planCluster([canon, m]).review[0].reason).toBe("sex-conflict");
  });
  it("name-only (no corroboration) -> review name-only", () => {
    const m = p({ id: "m" });
    expect(planCluster([canon, m]).review[0].reason).toBe("name-only");
  });
  it("mixed cluster: true dup auto-merges, odd member -> review (partial)", () => {
    const dup = p({ id: "dup", birthdate: "1990-05-05" });
    const odd = p({ id: "odd", birthdate: "1977-12-12" });
    const plan = planCluster([canon, dup, odd]);
    expect(plan.auto.map((a) => a.row.id)).toEqual(["dup"]);
    expect(plan.review.map((r) => r.row.id)).toEqual(["odd"]);
  });
});

describe("completeness", () => {
  it("counts populated optional fields", () => {
    expect(completeness(p({ phone: "1", email: "a@b.com" }))).toBe(2);
    expect(completeness(p({}))).toBe(0);
  });
});

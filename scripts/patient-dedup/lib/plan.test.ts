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
  it("name-only, member NOT a stub (has a non-matching phone) -> review name-only", () => {
    const m = p({ id: "m", phone: "09993334444" });
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

describe("name-stub rule (Tier 3)", () => {
  // A richer record with DOB+phone; the canonical in every case below.
  const rich = (first: string) =>
    p({ id: "canon", first_name: first, birthdate: "1990-05-05", sex: "F", phone: "09171112222", email: "x@y.com" });
  // A bare stub: no dob/phone/email. The backfill-created duplicate.
  const stub = (id: string, first: string) => p({ id, first_name: first });

  it("bare stub with the SAME given name -> auto name-stub", () => {
    const plan = planCluster([rich("Robi"), stub("m", "Robi")]);
    expect(plan.canonical.id).toBe("canon");
    expect(plan.auto).toEqual([{ row: expect.objectContaining({ id: "m" }), tier: "name-stub" }]);
  });

  it("bare stub whose given name is a prefix of the canonical's -> auto name-stub", () => {
    // canonical "Zoe Maribelle" (rich), stub "Zoe"
    const plan = planCluster([rich("Zoe Maribelle"), stub("m", "Zoe")]);
    expect(plan.auto[0]).toMatchObject({ row: { id: "m" }, tier: "name-stub" });
  });

  it("bare stub whose given name EXTENDS the canonical's -> auto name-stub", () => {
    // canonical "Zoe" (rich), stub "Zoe Maribelle" — refinement is symmetric
    const plan = planCluster([rich("Zoe"), stub("m", "Zoe Maribelle")]);
    expect(plan.auto[0]).toMatchObject({ row: { id: "m" }, tier: "name-stub" });
  });

  it("two bare stubs, divergent second tokens -> review name-only (not the same person)", () => {
    // "Juan Carlos" vs "Juan Miguel": same matchKey, neither name a prefix of the other
    const a = stub("a", "Juan Carlos");
    const b = stub("b", "Juan Miguel");
    expect(planCluster([a, b]).review[0].reason).toBe("name-only");
  });

  it("member is NOT a stub (has a DOB, non-conflicting) but name refines -> NOT name-stub", () => {
    // member has a DOB the canonical lacks; this is not a bare stub, so it stays
    // name-only (we don't merge on name-prefix alone once real identifiers exist).
    const canon = p({ id: "canon", first_name: "Zoe Maribelle", phone: "09171112222" });
    const m = p({ id: "m", first_name: "Zoe", birthdate: "2001-02-03" });
    expect(planCluster([canon, m]).review[0].reason).toBe("name-only");
  });

  it("stub with a refining name but conflicting SEX -> review sex-conflict (guard wins)", () => {
    const canon = p({ id: "canon", first_name: "Zoe Maribelle", sex: "F", birthdate: "1990-05-05", phone: "09171112222" });
    const m = p({ id: "m", first_name: "Zoe", sex: "M" }); // no dob/phone/email = stub, but sex conflicts
    expect(planCluster([canon, m]).review[0].reason).toBe("sex-conflict");
  });

  it("ambiguous bare stub (prefixes two divergent fuller names) -> review, not a guess", () => {
    // "Angelo" could be "Angelo Ray" OR "Angelo Raymond" — don't pick one.
    const canon = p({ id: "canon", first_name: "Angelo Raymond", birthdate: "1990-01-01", phone: "09171112222" }); // richest -> canonical
    const ray = p({ id: "ray", first_name: "Angelo Ray" });   // divergent fuller sibling
    const bare = p({ id: "bare", first_name: "Angelo" });      // ambiguous bare stub
    const plan = planCluster([canon, ray, bare]);
    expect(plan.auto).toEqual([]);                              // nothing auto-merged
    expect(plan.review.map((r) => r.row.id).sort()).toEqual(["bare", "ray"]);
    expect(plan.review.every((r) => r.reason === "name-only")).toBe(true);
  });

  it("non-ambiguous typo siblings still auto-merge (both extend the same bare canonical)", () => {
    // canonical bare "Inara"; "Inara Lilian" and "Inara Liliana" both extend it,
    // neither is itself extended by a divergent name -> both merge.
    const canon = p({ id: "canon", first_name: "Inara", created_at: "2024-01-01T00:00:00Z" });
    const a = p({ id: "a", first_name: "Inara Lilian" });
    const b = p({ id: "b", first_name: "Inara Liliana" });
    const plan = planCluster([canon, a, b]);
    expect(plan.canonical.id).toBe("canon");
    expect(plan.auto.map((x) => x.row.id).sort()).toEqual(["a", "b"]);
  });
});

describe("completeness", () => {
  it("counts populated optional fields", () => {
    expect(completeness(p({ phone: "1", email: "a@b.com" }))).toBe(2);
    expect(completeness(p({}))).toBe(0);
  });
});

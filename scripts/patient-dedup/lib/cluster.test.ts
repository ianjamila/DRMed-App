// scripts/patient-dedup/lib/cluster.test.ts
import { describe, it, expect } from "vitest";
import { clusterByName } from "./cluster";
import type { PatientRow } from "./types";

function p(over: Partial<PatientRow>): PatientRow {
  return {
    id: over.id ?? "x", drm_id: over.drm_id ?? "DRM-0001",
    first_name: over.first_name ?? null, last_name: over.last_name ?? null,
    middle_name: over.middle_name ?? null, sex: over.sex ?? null,
    phone: over.phone ?? null, email: over.email ?? null,
    birthdate: over.birthdate ?? null, address: over.address ?? null,
    created_at: over.created_at ?? "2025-01-01T00:00:00Z",
    visit_count: over.visit_count ?? 0,
  };
}

describe("clusterByName", () => {
  it("groups rows with the same matchKey", () => {
    const rows = [
      p({ id: "a", last_name: "Blancaflor", first_name: "Elmer" }),
      p({ id: "b", last_name: "Blancaflor", first_name: "Elmer Jr" }),
      p({ id: "c", last_name: "Blancaflor", first_name: "Elmer" }),
    ];
    const clusters = clusterByName(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("does NOT join different surnames sharing a phone (families)", () => {
    const rows = [
      p({ id: "mom", last_name: "Reyes", first_name: "Ana", phone: "09170000000" }),
      p({ id: "kid", last_name: "Reyes-Cruz", first_name: "Ben", phone: "09170000000" }),
    ];
    expect(clusterByName(rows)).toHaveLength(0);
  });

  it("excludes singletons", () => {
    const rows = [
      p({ id: "a", last_name: "Solo", first_name: "Han" }),
      p({ id: "b", last_name: "Blancaflor", first_name: "Elmer" }),
      p({ id: "c", last_name: "Blancaflor", first_name: "Elmer" }),
    ];
    const clusters = clusterByName(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it("skips rows with empty name key", () => {
    const rows = [
      p({ id: "a", last_name: null, first_name: null }),
      p({ id: "b", last_name: "", first_name: "" }),
    ];
    expect(clusterByName(rows)).toHaveLength(0);
  });
});

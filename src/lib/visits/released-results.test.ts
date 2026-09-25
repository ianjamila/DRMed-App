import { describe, expect, it } from "vitest";
import { foldCompletedWork, type CompletedWorkRow } from "./released-results";

const row = (visit_id: string, kind: string, p: Partial<CompletedWorkRow> = {}): CompletedWorkRow => ({
  id: `${visit_id}-${kind}-${Math.random()}`,
  visit_id,
  status: "released",
  is_package_header: false,
  services: { kind },
  ...p,
});

describe("foldCompletedWork (loadCompletedWorkCounts' fold)", () => {
  it("counts results and doctor lines apart, per visit, headers excluded", () => {
    const m = foldCompletedWork([
      row("v1", "lab_test"),
      row("v1", "lab_test"),
      row("v1", "lab_package", { is_package_header: true }),
      row("v1", "doctor_consultation"),
      row("v2", "doctor_procedure"),
    ]);
    expect(m.get("v1")).toEqual({ results: 2, consults: 1, procedures: 0 });
    expect(m.get("v2")).toEqual({ results: 0, consults: 0, procedures: 1 });
    expect(m.has("v3")).toBe(false);
  });
  it("accepts the embed as an array too (PostgREST typing)", () => {
    const m = foldCompletedWork([row("v1", "x", { services: [{ kind: "doctor_consultation" }] })]);
    expect(m.get("v1")).toEqual({ results: 0, consults: 1, procedures: 0 });
  });
});

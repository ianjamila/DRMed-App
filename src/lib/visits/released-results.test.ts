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

// The three surfaces that widened from "released results" to "completed
// work" (#228 follow-ups). Reverting any of them to the results-only helper
// would pass every pure test above and only show in a browser, so pin the
// wiring: each must count via the completed-work helpers, none via the
// results-only one.
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("completed-work consumers", () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");
  it("Reception Queue badge counts completed work from the rows it loads", () => {
    const s = src("app/(staff)/staff/(dashboard)/visits/queue/page.tsx");
    expect(s).toMatch(/completedWorkCount\(/);
    expect(s).toContain("Completed work · {completed}");
    expect(s).not.toMatch(/countReleasedLines|loadReleasedResultCounts/);
  });
  it("Patient AR filter + badge read completed work per visit", () => {
    const s = src("app/(staff)/staff/(dashboard)/admin/accounting/patient-ar/page.tsx");
    expect(s).toMatch(/loadCompletedWorkCounts\(/);
    expect(s).toContain("Completed work · {completed}");
    expect(s).toContain("Exceptions (non-HMO)");
    expect(s).not.toMatch(/loadReleasedResultCounts/);
  });
  it.each(["void", "edit", "move"])("the %s payment action alerts on completed work", (dir) => {
    const s = src(`app/(staff)/staff/(dashboard)/payments/[id]/${dir}/actions.ts`);
    expect(s).toMatch(/loadCompletedWorkCounts\(/);
    expect(s).toMatch(/sendReleasedPaymentRemovedAlert\(/);
    expect(s).toMatch(/after\(\(\) =>/);
    expect(s).not.toMatch(/loadReleasedResultCounts/);
  });
});

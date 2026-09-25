import { describe, expect, it } from "vitest";
import { buildArRows } from "./patient-ar-rows";

const v = (id: string, hmo: string | null = null) => ({ id, hmo_provider_id: hmo });
const counts = new Map([
  ["lab", { results: 2, consults: 0, procedures: 0 }],
  ["consult-only", { results: 0, consults: 1, procedures: 0 }],
  ["procedure-only", { results: 0, consults: 0, procedures: 1 }],
  ["hmo", { results: 3, consults: 0, procedures: 0 }],
]);
const candidates = [
  { v: v("lab"), outstanding: 500 },
  { v: v("consult-only"), outstanding: 800 },
  { v: v("procedure-only"), outstanding: 300 },
  { v: v("plain"), outstanding: 1200 },
  { v: v("hmo", "h1"), outstanding: 900 },
  { v: v("zero"), outstanding: 0 },
  { v: v("overpaid"), outstanding: -50 },
];

describe("buildArRows (Patient AR row derivation)", () => {
  it("default scope keeps every positive balance and drops zero / negative ones", () => {
    const r = buildArRows({ candidates, completedByVisit: counts, completedOnly: false });
    expect(r.owing.map((x) => x.v.id)).toEqual(["lab", "consult-only", "procedure-only", "plain", "hmo"]);
    expect(r.owing).toBe(r.owingAll);
  });
  it("completed work counts doctor-only visits, not only released results", () => {
    const r = buildArRows({ candidates, completedByVisit: counts, completedOnly: false });
    const by = Object.fromEntries(r.owingAll.map((x) => [x.v.id, x.completed]));
    expect(by).toEqual({ lab: 2, "consult-only": 1, "procedure-only": 1, plain: 0, hmo: 0 });
    expect(r.completedCount).toBe(3);
  });
  it("an HMO visit is never badged, whatever it released", () => {
    const r = buildArRows({ candidates, completedByVisit: counts, completedOnly: true });
    expect(r.owing.some((x) => x.v.id === "hmo")).toBe(false);
  });
  it("the Completed work filter narrows the set the cards and pager describe", () => {
    const r = buildArRows({ candidates, completedByVisit: counts, completedOnly: true });
    expect(r.owing.map((x) => x.v.id)).toEqual(["lab", "consult-only", "procedure-only"]);
    expect(r.owing.reduce((s, x) => s + x.outstanding, 0)).toBe(1600);
    // The chip count is over the whole owing set, not the filtered one.
    expect(r.completedCount).toBe(3);
    expect(r.owingAll).toHaveLength(5);
  });
  it("a visit with no completed-work entry reads 0", () => {
    const r = buildArRows({ candidates, completedByVisit: new Map(), completedOnly: true });
    expect(r.owing).toEqual([]);
    expect(r.completedCount).toBe(0);
  });
});

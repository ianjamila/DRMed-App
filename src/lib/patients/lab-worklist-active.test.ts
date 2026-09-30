// Owner decision 2026-09-30: deleted and merged-away patients are HIDDEN from
// the lab worklists (queue + results archive) and from the dashboard cards
// that count them — not just badged. Read as text (no database), like
// query-surfaces.test.ts. The filter only works when every hop to the patient
// is `!inner` (CLAUDE.md: PostgREST ignores a filter on a LEFT-joined embed),
// so this pins the call AND the embed shape.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DASH = "src/app/(staff)/staff/(dashboard)";
const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const APPLIED = /activeEmbeddedPatients\(\s*query,\s*"visits\.patients"\s*\)/;

describe.each([
  ["queue", `${DASH}/queue/page.tsx`],
  ["results", `${DASH}/results/page.tsx`],
])("%s page list query", (_name, file) => {
  const src = read(file);
  // The main list chain is the one that pages with an exact count.
  const start = src.indexOf('.from("test_requests")');
  const end = src.indexOf("await query", start);

  it("applies activeEmbeddedPatients(query, \"visits.patients\") before it is awaited", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toMatch(APPLIED);
  });

  it("every list select (visits!inner + services!inner) embeds patients!inner under visits", () => {
    // The result_test_requests membership read is a lookup keyed off rows already
    // filtered (0184: a result belongs to one patient), so it is not a list select.
    const selects = (src.match(/`[^`]*`/g) ?? []).filter(
      (t) => /visits!inner/.test(t) && /services!inner/.test(t),
    );
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s, s).toMatch(/patients!inner/);
  });
});

describe("dashboard test_requests worklist cards and the waiting-room display", () => {
  // Reception's "Visits today" strip is order VOLUME by class, not a mirror of
  // a worklist tab, so it deliberately spans every patient.
  // The 4th column counts wraps over OTHER tables (lab: the "Updated (last 7
  // days)" card reads result_amendments, reaching the patient through its test).
  const cases: [string, number, number, number][] = [
    [`${DASH}/_dashboards/lab-dashboard.tsx`, 8, 8, 1],
    [`${DASH}/_dashboards/admin-dashboard.tsx`, 6, 6, 0],
    [`${DASH}/_dashboards/reception-dashboard.tsx`, 3, 2, 0],
    // The waiting-room display names patients in the room (in progress / up next).
    ["src/app/display/page.tsx", 2, 2, 0],
  ];
  it.each(cases)("%s: %i test_requests reads, %i apply the active-patient filter", (file, reads, applied, other) => {
    const src = read(file);
    expect(src.match(/\.from\("test_requests"\)/g)?.length).toBe(reads);
    expect(src.match(/activeEmbeddedPatients\(/g)?.length).toBe(applied + other);
    expect(src.match(/"visits\.patients"/g)?.length).toBe(applied);
  });

  it("the lab \"Updated (last 7 days)\" card filters its amendments by the test's patient", () => {
    const src = read(`${DASH}/_dashboards/lab-dashboard.tsx`);
    const at = src.indexOf('.from("result_amendments")');
    expect(at).toBeGreaterThan(-1);
    const chain = src.slice(at, src.indexOf("SKIP_COUNT", at));
    expect(chain).toMatch(/test_requests!inner\(id, visits!inner\(id, patients!inner\(id\)\)\)/);
    expect(chain).toContain('"test_requests.visits.patients"');
  });
});

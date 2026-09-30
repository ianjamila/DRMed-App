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
  const cases: [string, number, number][] = [
    [`${DASH}/_dashboards/lab-dashboard.tsx`, 9, 9],
    [`${DASH}/_dashboards/admin-dashboard.tsx`, 6, 6],
    [`${DASH}/_dashboards/reception-dashboard.tsx`, 3, 2],
    // The waiting-room display names patients in the room (in progress / up next).
    ["src/app/display/page.tsx", 2, 2],
  ];
  it.each(cases)("%s: %i test_requests reads, %i apply the active-patient filter", (file, reads, applied) => {
    const src = read(file);
    expect(src.match(/\.from\("test_requests"\)/g)?.length).toBe(reads);
    expect(src.match(/activeEmbeddedPatients\(/g)?.length).toBe(applied);
    expect(src.match(/"visits\.patients"/g)?.length).toBe(applied);
  });

  it("the lab \"Updated (last 7 days)\" card counts tests with the archive's ?updated=7d predicates", () => {
    const src = read(`${DASH}/_dashboards/lab-dashboard.tsx`);
    // Counting result_amendments rows counted a test corrected twice as 2
    // and corrections on deleted visits the archive hides (2026-09-30).
    expect(src).not.toContain('.from("result_amendments")');
    const at = src.indexOf("let updated7dQuery");
    expect(at).toBeGreaterThan(-1);
    const chain = src.slice(at, src.indexOf("const updated7dPromise", at));
    expect(chain).toContain('.from("test_requests")');
    expect(chain).toMatch(/result_test_requests!inner\(results!inner\(amended_at\)\)/);
    expect(chain).toContain('.gte("result_test_requests.results.amended_at", since7d)');
    expect(chain).toContain('.is("deleted_at", null)');
    expect(chain).toContain('.is("visits.deleted_at", null)');
    expect(chain).toContain('.not("services.kind", "in", DOCTOR_KINDS_PG_LIST)');
    expect(chain).toContain('activeEmbeddedPatients(updated7dQuery, "visits.patients")');
    expect(chain).toContain('.in("services.section", sections)');
  });
});

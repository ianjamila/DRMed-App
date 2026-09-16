import { describe, it, expect } from "vitest";
import {
  ARCHIVE_SORT_COLUMNS,
  DEFAULT_ARCHIVE_SORT,
  archiveOrderPlan,
  type ArchiveSortColumn,
} from "./archive-query";

describe("ARCHIVE_SORT_COLUMNS / DEFAULT_ARCHIVE_SORT", () => {
  it("does not include a 'tests' column — that count is a second, post-fetch query", () => {
    expect(ARCHIVE_SORT_COLUMNS).not.toContain("tests" as unknown as ArchiveSortColumn);
  });

  it("fallback matches the archive's original hardcoded order (visit_date desc)", () => {
    expect(DEFAULT_ARCHIVE_SORT).toEqual({ key: "visit_date", dir: "desc" });
  });
});

describe("archiveOrderPlan", () => {
  it("reproduces the exact pre-existing default order for visit_date desc", () => {
    expect(archiveOrderPlan({ key: "visit_date", dir: "desc" })).toEqual([
      { column: "visit_date", ascending: false },
      { column: "created_at", ascending: false },
      { column: "id", ascending: true },
    ]);
  });

  it("flips visit_date's secondary key (created_at) to match direction", () => {
    expect(archiveOrderPlan({ key: "visit_date", dir: "asc" })).toEqual([
      { column: "visit_date", ascending: true },
      { column: "created_at", ascending: true },
      { column: "id", ascending: true },
    ]);
  });

  it("sorts patient by the embedded PostgREST path, not the referencedTable option", () => {
    // Deliberately NOT `{ column: "last_name", ... }` with a referencedTable
    // side-channel — supabase-js's `referencedTable` option was verified
    // (against local PostgREST) to leave the parent `visits` rows in their
    // original order. The raw embedded-path column string is what actually
    // reorders the parent, and only works because `patients!inner` is
    // already part of `VISIT_SELECT`.
    expect(archiveOrderPlan({ key: "patient_last_name", dir: "asc" })).toEqual([
      { column: "patients(last_name)", ascending: true },
      { column: "id", ascending: true },
    ]);
  });

  it("every other sortable column gets no secondary key beyond the id tie-break", () => {
    const others: ArchiveSortColumn[] = [
      "visit_number",
      "total_php",
      "paid_php",
      "payment_status",
    ];
    for (const key of others) {
      const plan = archiveOrderPlan({ key, dir: "desc" });
      expect(plan).toHaveLength(2);
      expect(plan[1]).toEqual({ column: "id", ascending: true });
    }
  });

  it("every plan ends on id ascending — the total-order tie-break .range() needs", () => {
    for (const key of ARCHIVE_SORT_COLUMNS) {
      for (const dir of ["asc", "desc"] as const) {
        const plan = archiveOrderPlan({ key, dir });
        expect(plan.at(-1)).toEqual({ column: "id", ascending: true });
      }
    }
  });
});

// A CSV window can contain 1,000 visits, then fan out to many more bill lines.
// Exercise both enrichment queries, including a sibling set over 1,000 rows.
it("keeps every split sibling and billed line past the PostgREST cap", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { fetchArchiveWindow } = await import("./archive-query");
  const visits = ["a", "b"].flatMap((side) => Array.from({ length: 600 }, (_, i) => ({
    id: `${side}${String(i).padStart(4, "0")}`, visit_group_id: `g${i}`,
    visit_number: `${side}${i}`, visit_date: "2026-09-01", created_at: "2026-09-01T01:00:00Z",
    payment_status: "paid", total_php: 6, paid_php: 6, deleted_at: null, delete_reason: null,
    patients: { id: `p${i}`, drm_id: `DRM-${i}`, first_name: "A", middle_name: null, last_name: "B" },
    payments: [],
  })));
  const lines = visits.flatMap((v) => Array.from({ length: 6 }, (_, i) => ({
    id: `${v.id}-${i}`, visit_id: v.id, services: { kind: i === 5 ? "doctor_consultation" : "lab_test" },
  })));
  const childOffsets: number[] = [];
  const client = createClient<import("@/types/database").Database>("https://archive.test", "key", {
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      const isLines = url.pathname.endsWith("test_requests");
      const ids = url.searchParams.get(isLines ? "visit_id" : "visit_group_id");
      const selected = ids?.slice(4, -1).split(",");
      if (selected) expect(selected.length).toBeLessThanOrEqual(200);
      const matching = isLines
        ? lines.filter((l) => selected?.includes(l.visit_id))
        : visits.filter((v) => !selected || selected.includes(v.visit_group_id));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (isLines) childOffsets.push(offset);
      const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 1000));
      expect(url.searchParams.get("order")).toMatch(/id\.asc$/);
      return new Response(JSON.stringify(matching.slice(offset, offset + limit)), {
        headers: { "Content-Type": "application/json", "Content-Range": `${offset}-${offset + limit - 1}/${matching.length}` },
      });
    } },
  });
  const result = await fetchArchiveWindow(client, {
    start: "", end: "", classes: new Set(["lab", "consult", "procedure"]), view: "active",
  }, DEFAULT_ARCHIVE_SORT, 0, 600);
  expect(result.rows).toHaveLength(600);
  expect(result.rows.every((r) => r.members.length === 2 && r.testCount === 12)).toBe(true);
  expect(result.rows.reduce((sum, r) => sum + r.total, 0)).toBe(7200);
  expect(childOffsets).toContain(1000);
});

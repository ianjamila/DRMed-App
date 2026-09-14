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

import { describe, expect, it } from "vitest";
import {
  compareStaffAdvanceRows,
  compareStaffAdvanceSummaryRows,
  STAFF_ADVANCES_CSV_HEADER,
  STAFF_ADVANCES_DEFAULT_SORT,
  STAFF_ADVANCES_SUMMARY_DEFAULT_SORT,
  staffAdvancesCsvFilename,
  staffAdvancesCsvHref,
  staffAdvancesCsvRows,
  type StaffAdvanceRow,
  type StaffAdvanceSummaryRow,
} from "./staff-advances";
import type { SortSpec } from "@/lib/ui/table-params";

const rows: StaffAdvanceRow[] = [
  { id: "a1", staff_id: "s1", business_date: "2026-09-08", original_amount_php: 2000, outstanding_balance_php: 500, status: "outstanding", source_adjustment_id: null },
  { id: "a2", staff_id: "s2", business_date: "2026-09-01", original_amount_php: 1000, outstanding_balance_php: 0, status: "settled", source_adjustment_id: "adj-1" },
];
const staffById = new Map([["s1", { full_name: "Ana Cruz", role: "reception" }]]);

describe("staffAdvancesCsvRows", () => {
  it("names the staff member and falls back to the id prefix when the profile is gone", () => {
    const out = staffAdvancesCsvRows(rows, staffById);
    expect(out[0]).toEqual([...STAFF_ADVANCES_CSV_HEADER]);
    expect(out[1]).toEqual(["2026-09-08", "Ana Cruz", "reception", "2000.00", "500.00", "outstanding"]);
    expect(out[2]).toEqual(["2026-09-01", "s2", "", "1000.00", "0.00", "settled"]);
  });
});

describe("href / filename", () => {
  it("has no filters and stamps the day", () => {
    expect(staffAdvancesCsvHref()).toBe("/api/admin/reports/staff-advances.csv");
    expect(staffAdvancesCsvFilename("2026-09-08")).toBe("staff-advances-2026-09-08.csv");
  });
});

describe("compareStaffAdvanceRows (the ledger table)", () => {
  it("defaults to most-recent business_date first", () => {
    expect(STAFF_ADVANCES_DEFAULT_SORT).toEqual({ key: "date", dir: "desc" });
    const sorted = [...rows].sort((a, b) =>
      compareStaffAdvanceRows(a, b, STAFF_ADVANCES_DEFAULT_SORT, staffById),
    );
    expect(sorted.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("sorts the raw ISO business_date, not a formatted display string", () => {
    const dir: SortSpec<"date"> = { key: "date", dir: "asc" };
    const sorted = [...rows].sort((a, b) =>
      compareStaffAdvanceRows(a, b, dir, staffById),
    );
    expect(sorted.map((r) => r.id)).toEqual(["a2", "a1"]);
  });

  it("sorts 'staff' by the resolved name and sinks an unresolved staff_id last in both directions", () => {
    const unresolved: StaffAdvanceRow = {
      id: "a3",
      staff_id: "ghost",
      business_date: "2026-09-05",
      original_amount_php: 300,
      outstanding_balance_php: 300,
      status: "outstanding",
      source_adjustment_id: null,
    };
    const set = [...rows, unresolved];

    const asc = [...set].sort((a, b) =>
      compareStaffAdvanceRows(a, b, { key: "staff", dir: "asc" }, staffById),
    );
    expect(asc.map((r) => r.id)).toEqual(["a1", "a2", "a3"]);

    const desc = [...set].sort((a, b) =>
      compareStaffAdvanceRows(a, b, { key: "staff", dir: "desc" }, staffById),
    );
    // Still last on desc — a null never floats to the top just because the
    // direction flipped.
    expect(desc.at(-1)?.id).toBe("a3");
  });

  it("sorts 'original' and 'outstanding' numerically", () => {
    const byOriginal = [...rows].sort((a, b) =>
      compareStaffAdvanceRows(a, b, { key: "original", dir: "asc" }, staffById),
    );
    expect(byOriginal.map((r) => r.id)).toEqual(["a2", "a1"]);

    const byOutstanding = [...rows].sort((a, b) =>
      compareStaffAdvanceRows(a, b, { key: "outstanding", dir: "desc" }, staffById),
    );
    expect(byOutstanding.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("sorts 'status' alphabetically", () => {
    const sorted = [...rows].sort((a, b) =>
      compareStaffAdvanceRows(a, b, { key: "status", dir: "asc" }, staffById),
    );
    expect(sorted.map((r) => r.status)).toEqual(["outstanding", "settled"]);
  });

  it("tie-breaks on the uuid id, ascending, when the sort key is equal", () => {
    const tied: StaffAdvanceRow[] = [
      { ...rows[0], id: "z", business_date: "2026-09-08" },
      { ...rows[0], id: "a", business_date: "2026-09-08" },
    ];
    const sorted = [...tied].sort((a, b) =>
      compareStaffAdvanceRows(a, b, STAFF_ADVANCES_DEFAULT_SORT, staffById),
    );
    expect(sorted.map((r) => r.id)).toEqual(["a", "z"]);
  });
});

describe("compareStaffAdvanceSummaryRows (the outstanding-by-staff table)", () => {
  const summary: StaffAdvanceSummaryRow[] = [
    {
      staff_id: "s1",
      full_name: "Ana Cruz",
      role: "reception",
      advance_count: 2,
      outstanding_php: 500,
      oldest_advance_date: "2026-09-01",
    },
    {
      staff_id: "s2",
      full_name: "Ben Reyes",
      role: "medtech",
      advance_count: 1,
      outstanding_php: 2000,
      oldest_advance_date: null,
    },
    {
      staff_id: "s3",
      full_name: "Cara Diaz",
      role: "reception",
      advance_count: 5,
      outstanding_php: 800,
      oldest_advance_date: "2026-08-15",
    },
  ];

  it("defaults to the biggest outstanding balance first", () => {
    expect(STAFF_ADVANCES_SUMMARY_DEFAULT_SORT).toEqual({ key: "outstanding", dir: "desc" });
    const sorted = [...summary].sort((a, b) =>
      compareStaffAdvanceSummaryRows(a, b, STAFF_ADVANCES_SUMMARY_DEFAULT_SORT),
    );
    expect(sorted.map((r) => r.staff_id)).toEqual(["s2", "s3", "s1"]);
  });

  it("sorts 'staff' and 'role' alphabetically", () => {
    const byStaff = [...summary].sort((a, b) =>
      compareStaffAdvanceSummaryRows(a, b, { key: "staff", dir: "asc" }),
    );
    expect(byStaff.map((r) => r.staff_id)).toEqual(["s1", "s2", "s3"]);

    const byRole = [...summary].sort((a, b) =>
      compareStaffAdvanceSummaryRows(a, b, { key: "role", dir: "asc" }),
    );
    expect(byRole.map((r) => r.role)).toEqual(["medtech", "reception", "reception"]);
  });

  it("sorts 'advances' numerically", () => {
    const sorted = [...summary].sort((a, b) =>
      compareStaffAdvanceSummaryRows(a, b, { key: "advances", dir: "desc" }),
    );
    expect(sorted.map((r) => r.staff_id)).toEqual(["s3", "s1", "s2"]);
  });

  it("sorts 'oldest' with the null (never-set) date last in both directions", () => {
    const asc = [...summary].sort((a, b) =>
      compareStaffAdvanceSummaryRows(a, b, { key: "oldest", dir: "asc" }),
    );
    expect(asc.map((r) => r.staff_id)).toEqual(["s3", "s1", "s2"]);

    const desc = [...summary].sort((a, b) =>
      compareStaffAdvanceSummaryRows(a, b, { key: "oldest", dir: "desc" }),
    );
    expect(desc.map((r) => r.staff_id)).toEqual(["s1", "s3", "s2"]);
  });

  it("tie-breaks on staff_id, ascending, when the sort key is equal", () => {
    const tied: StaffAdvanceSummaryRow[] = [
      { ...summary[0], staff_id: "z1" },
      { ...summary[0], staff_id: "a1" },
    ];
    const sorted = [...tied].sort((a, b) =>
      compareStaffAdvanceSummaryRows(a, b, { key: "outstanding", dir: "asc" }),
    );
    expect(sorted.map((r) => r.staff_id)).toEqual(["a1", "z1"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  STAFF_ADVANCES_CSV_HEADER,
  staffAdvancesCsvFilename,
  staffAdvancesCsvHref,
  staffAdvancesCsvRows,
  type StaffAdvanceRow,
} from "./staff-advances";

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

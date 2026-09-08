/** Staff advances — shared by the admin report page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { chunk, fetchAllRows, IN_CHUNK, unique } from "./paging";

type AnyClient = SupabaseClient<Database>;

export interface StaffAdvanceSummaryRow {
  staff_id: string;
  full_name: string;
  role: string;
  advance_count: number;
  outstanding_php: number | null;
  oldest_advance_date: string | null;
}

export interface StaffAdvanceRow {
  id: string;
  staff_id: string;
  business_date: string;
  original_amount_php: number;
  outstanding_balance_php: number;
  status: string;
  source_adjustment_id: string | null;
}

export type StaffNameMap = ReadonlyMap<string, { full_name: string; role: string }>;

export interface StaffAdvancesReport {
  summary: StaffAdvanceSummaryRow[];
  rows: StaffAdvanceRow[];
  staffById: StaffNameMap;
  truncated: boolean;
}

export async function loadStaffAdvances(
  client: AnyClient,
  maxRows: number,
): Promise<StaffAdvancesReport> {
  const { data: summaryRaw } = await client
    .from("v_staff_advances_outstanding")
    .select("*")
    .gt("outstanding_php", 0)
    .order("outstanding_php", { ascending: false })
    .returns<StaffAdvanceSummaryRow[]>();

  const { rows, truncated } = await fetchAllRows<StaffAdvanceRow>(
    (from, to) =>
      client
        .from("staff_advances")
        .select("id, staff_id, business_date, original_amount_php, outstanding_balance_php, status, source_adjustment_id")
        .order("business_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<StaffAdvanceRow[]>(),
    maxRows,
  );

  // Names for the ledger — the page used to show a bare UUID prefix.
  const staffById = new Map<string, { full_name: string; role: string }>();
  for (const ids of chunk(unique(rows.map((r) => r.staff_id)), IN_CHUNK)) {
    const { data } = await client
      .from("staff_profiles")
      .select("id, full_name, role")
      .in("id", ids);
    for (const s of data ?? []) staffById.set(s.id, { full_name: s.full_name, role: s.role });
  }

  return { summary: summaryRaw ?? [], rows, staffById, truncated };
}

export const STAFF_ADVANCES_CSV_HEADER = [
  "Date",
  "Staff",
  "Role",
  "Original PHP",
  "Outstanding PHP",
  "Status",
] as const;

export function staffAdvancesCsvRows(
  rows: readonly StaffAdvanceRow[],
  staffById: StaffNameMap,
): unknown[][] {
  return [
    [...STAFF_ADVANCES_CSV_HEADER],
    ...rows.map((r) => {
      const who = staffById.get(r.staff_id);
      return [
        r.business_date,
        // Full id in the export (audit-grade); the page truncates it for width.
        who?.full_name ?? r.staff_id,
        who?.role ?? "",
        Number(r.original_amount_php).toFixed(2),
        Number(r.outstanding_balance_php).toFixed(2),
        r.status,
      ];
    }),
  ];
}

export function staffAdvancesCsvHref(): string {
  return "/api/admin/reports/staff-advances.csv";
}

export function staffAdvancesCsvFilename(today: string): string {
  return `staff-advances-${today}.csv`;
}

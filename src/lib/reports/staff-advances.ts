/** Staff advances — shared by the admin report page and its CSV. Not `server-only`. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { SortSpec } from "@/lib/ui/table-params";
import { humaniseCode } from "@/lib/format/humanise-code";
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

// staff_advances.status — the CHECK constraint in 0043. The report shows these
// words; the CSV keeps the stored code.
export const STAFF_ADVANCE_STATUS_LABEL: Record<string, string> = {
  outstanding: "Outstanding",
  settled: "Paid back",
  voided: "Voided",
  written_off: "Written off",
};

export function staffAdvanceStatusLabel(status: string): string {
  return STAFF_ADVANCE_STATUS_LABEL[status] ?? humaniseCode(status);
}

export type StaffNameMap = ReadonlyMap<string, { full_name: string; role: string }>;

export interface StaffAdvancesReport {
  summary: StaffAdvanceSummaryRow[];
  rows: StaffAdvanceRow[];
  staffById: StaffNameMap;
  truncated: boolean;
}

/**
 * Sortable columns for the "Recent advances" ledger table.
 *
 * This is the only report page with two independently-sortable tables, so
 * the ledger owns the page's plain `?sort=&dir=&page=&size=` params and the
 * summary table below owns its own `?ssort=&sdir=` — see the page for how
 * each table's hrefs carry the other's state along rather than clobbering it.
 */
export const STAFF_ADVANCES_SORTABLE_COLUMNS = [
  "date",
  "staff",
  "original",
  "outstanding",
  "status",
] as const;
export type StaffAdvanceSortColumn = (typeof STAFF_ADVANCES_SORTABLE_COLUMNS)[number];

// Most-recent-first is the useful default for a ledger — "what happened
// lately" is the question this table exists to answer.
export const STAFF_ADVANCES_DEFAULT_SORT: SortSpec<StaffAdvanceSortColumn> = {
  key: "date",
  dir: "desc",
};

/**
 * The ledger comparator needs `staffById` (rule: extra argument for a column
 * resolved through a lookup map, same shape as `compareStuckRows`'s
 * `claimerNames`) because `staff_id` alone isn't what the "Staff" column
 * prints — the resolved name is.
 */
export function compareStaffAdvanceRows(
  a: StaffAdvanceRow,
  b: StaffAdvanceRow,
  sort: SortSpec<StaffAdvanceSortColumn>,
  staffById: StaffNameMap,
): number {
  const dirMul = sort.dir === "asc" ? 1 : -1;
  let cmp: number;

  if (sort.key === "staff") {
    // A staff row can go missing (deleted profile) while their advances
    // stay on the ledger — sink those to the bottom regardless of direction,
    // same rule `users/page.tsx` applies to a never-signed-in staff member.
    const an = staffById.get(a.staff_id)?.full_name ?? null;
    const bn = staffById.get(b.staff_id)?.full_name ?? null;
    if (an === null && bn === null) cmp = 0;
    else if (an === null) return 1;
    else if (bn === null) return -1;
    else cmp = dirMul * an.localeCompare(bn);
  } else {
    switch (sort.key) {
      case "date":
        // `business_date` is already YYYY-MM-DD, so string compare orders it
        // by real date — sort keys off the raw ISO value, never the
        // `manilaDate`-formatted display string the cell renders.
        cmp = dirMul * a.business_date.localeCompare(b.business_date);
        break;
      case "original":
        cmp = dirMul * (a.original_amount_php - b.original_amount_php);
        break;
      case "outstanding":
        cmp = dirMul * (a.outstanding_balance_php - b.outstanding_balance_php);
        break;
      case "status":
        cmp = dirMul * a.status.localeCompare(b.status);
        break;
      default:
        cmp = 0;
    }
  }

  // staff_advances.id is a uuid, not the audit_log's numeric id.
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
}

/**
 * Sortable columns for the "Outstanding by staff" summary table. One row per
 * staff member with an open balance — a handful of rows, same call as
 * `Closures`: sort, no pager.
 */
export const STAFF_ADVANCES_SUMMARY_SORTABLE_COLUMNS = [
  "staff",
  "role",
  "advances",
  "outstanding",
  "oldest",
] as const;
export type StaffAdvanceSummarySortColumn =
  (typeof STAFF_ADVANCES_SUMMARY_SORTABLE_COLUMNS)[number];

// Biggest exposure first — "who do we need to settle with" is the question
// this table answers.
export const STAFF_ADVANCES_SUMMARY_DEFAULT_SORT: SortSpec<StaffAdvanceSummarySortColumn> = {
  key: "outstanding",
  dir: "desc",
};

export function compareStaffAdvanceSummaryRows(
  a: StaffAdvanceSummaryRow,
  b: StaffAdvanceSummaryRow,
  sort: SortSpec<StaffAdvanceSummarySortColumn>,
): number {
  const dirMul = sort.dir === "asc" ? 1 : -1;
  let cmp: number;

  if (sort.key === "oldest") {
    // A staff member with zero advances left after settling everything
    // never appears here (the loader's `.gt("outstanding_php", 0)` keeps
    // this table to open balances only), but the view's `oldest_advance_date`
    // is still typed nullable — sink a null to the bottom either direction.
    const ad = a.oldest_advance_date;
    const bd = b.oldest_advance_date;
    if (ad === null && bd === null) cmp = 0;
    else if (ad === null) return 1;
    else if (bd === null) return -1;
    else cmp = dirMul * ad.localeCompare(bd);
  } else {
    switch (sort.key) {
      case "staff":
        cmp = dirMul * a.full_name.localeCompare(b.full_name);
        break;
      case "role":
        cmp = dirMul * a.role.localeCompare(b.role);
        break;
      case "advances":
        cmp = dirMul * (a.advance_count - b.advance_count);
        break;
      case "outstanding":
        // Typed nullable, but the `.gt("outstanding_php", 0)` filter this
        // loader applies means every row here already has a positive value —
        // `?? 0` is a type-safe fallback, not a real null-last rule.
        cmp = dirMul * ((a.outstanding_php ?? 0) - (b.outstanding_php ?? 0));
        break;
      default:
        cmp = 0;
    }
  }

  return cmp !== 0 ? cmp : a.staff_id.localeCompare(b.staff_id);
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

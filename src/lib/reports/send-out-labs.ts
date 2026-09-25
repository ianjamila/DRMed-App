/**
 * Pure pivots + formatting for the Send-out Labs report (0164): the
 * partner-lab spend/margin/turnaround summaries built on
 * `send_out_spend_by_lab` / `send_out_monthly_margin` / `send_out_turnaround_by_lab`.
 *
 * No `server-only` import — the page, the CSV export route and vitest all
 * import this. Month arithmetic goes through `firstOfMonthISO` /
 * `isoDateParts` only, never `Date`, per `manila-usage.test.ts`.
 */
import { firstOfMonthISO, isoDateParts } from "@/lib/dates/manila";

export const NOT_TAGGED_LABEL = "Not tagged";
/** Stable map key standing in for `vendor_id === null` ("Not tagged"). */
const NOT_TAGGED_KEY = "__not_tagged__";

/** `send_out_turnaround_by_lab`'s (0164) fallback `lab_name` for a send-out
 *  service with no partner lab linked. */
export const NOT_LINKED_LABEL = "Not linked to a partner lab";

export interface SpendByLabRow {
  month: string; // YYYY-MM-DD, first of the Manila month (send_out_spend_by_lab)
  vendor_id: string | null;
  vendor_name: string | null;
  spend_php: number;
  entries: number;
}

export interface MonthlyMarginRow {
  month: string; // YYYY-MM-DD, first of the Manila month (send_out_monthly_margin)
  tests: number;
  revenue_php: number;
  spend_php: number;
  margin_php: number;
}

export interface TurnaroundRow {
  vendor_id: string | null;
  lab_name: string;
  tests: number;
  avg_hours: number;
  median_hours: number;
  p90_hours: number;
  with_promise: number;
  within_promise: number;
}

/**
 * `YYYY-MM-01` keys for every Manila month spanning `start`..`end`
 * (inclusive of both months), NEWEST FIRST — the order every table in this
 * report renders in. Pure string/integer arithmetic; no `Date`.
 */
export function enumerateMonths(start: string, end: string): string[] {
  const s = isoDateParts(start);
  const e = isoDateParts(end);
  const startKey = firstOfMonthISO(s.year, s.month);

  const months: string[] = [];
  let year = e.year;
  let month = e.month;
  // A month range spanning centuries would loop this many times; a report
  // period never will, so this is a safety valve, not a real limit.
  for (let guard = 0; guard < 2400; guard++) {
    const key = firstOfMonthISO(year, month);
    months.push(key);
    if (key === startKey) break;
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return months;
}

function labKey(vendorId: string | null): string {
  return vendorId ?? NOT_TAGGED_KEY;
}

function labLabel(vendorId: string | null, vendorName: string | null): string {
  if (!vendorId) return NOT_TAGGED_LABEL;
  return vendorName ?? "Unknown lab";
}

export interface SpendMatrixColumn {
  key: string;
  vendorId: string | null;
  label: string;
}

export interface SpendMatrixRow {
  month: string;
  /** Keyed by `SpendMatrixColumn.key`. */
  byLab: Record<string, number>;
  totalPhp: number;
}

export interface SpendMatrix {
  months: string[]; // newest first, one row per month
  columns: SpendMatrixColumn[]; // labs found, spend-desc, "Not tagged" always last
  rows: SpendMatrixRow[];
  totals: SpendMatrixRow; // month === "" — the totals row
}

/**
 * Months (rows, newest first) × labs (columns, spend-desc, "Not tagged"
 * always last) + a totals row/column. `months` is passed in rather than
 * derived from `rows` so a month with zero spend still gets a row.
 */
export function buildSpendMatrix(
  rows: readonly SpendByLabRow[],
  months: readonly string[],
): SpendMatrix {
  const labTotals = new Map<string, { vendorId: string | null; label: string; total: number }>();
  for (const r of rows) {
    const key = labKey(r.vendor_id);
    const existing = labTotals.get(key);
    if (existing) {
      existing.total += r.spend_php;
    } else {
      labTotals.set(key, {
        vendorId: r.vendor_id,
        label: labLabel(r.vendor_id, r.vendor_name),
        total: r.spend_php,
      });
    }
  }
  // "Not tagged" always shows as a column, even with zero spend this period.
  if (!labTotals.has(NOT_TAGGED_KEY)) {
    labTotals.set(NOT_TAGGED_KEY, { vendorId: null, label: NOT_TAGGED_LABEL, total: 0 });
  }

  const columns: SpendMatrixColumn[] = Array.from(labTotals.entries())
    .map(([key, v]) => ({ key, vendorId: v.vendorId, label: v.label }))
    .sort((a, b) => {
      if (a.key === NOT_TAGGED_KEY) return 1;
      if (b.key === NOT_TAGGED_KEY) return -1;
      return labTotals.get(b.key)!.total - labTotals.get(a.key)!.total;
    });

  const byMonth = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = labKey(r.vendor_id);
    const monthMap = byMonth.get(r.month) ?? new Map<string, number>();
    monthMap.set(key, (monthMap.get(key) ?? 0) + r.spend_php);
    byMonth.set(r.month, monthMap);
  }

  const rowsOut: SpendMatrixRow[] = months.map((month) => {
    const monthMap = byMonth.get(month);
    const byLab: Record<string, number> = {};
    let totalPhp = 0;
    for (const col of columns) {
      const v = monthMap?.get(col.key) ?? 0;
      byLab[col.key] = v;
      totalPhp += v;
    }
    return { month, byLab, totalPhp };
  });

  const totals: SpendMatrixRow = { month: "", byLab: {}, totalPhp: 0 };
  for (const col of columns) {
    const sum = rowsOut.reduce((s, r) => s + (r.byLab[col.key] ?? 0), 0);
    totals.byLab[col.key] = sum;
    totals.totalPhp += sum;
  }

  return { months: [...months], columns, rows: rowsOut, totals };
}

export interface LabShare {
  vendorId: string | null;
  label: string;
  spendPhp: number;
  sharePct: number; // 0-100, 0 when there is no spend at all
}

/** Each lab's share of total Send Out spend in the period, spend-desc. */
export function computeLabShares(rows: readonly SpendByLabRow[]): LabShare[] {
  const totals = new Map<string, { vendorId: string | null; label: string; total: number }>();
  let grandTotal = 0;
  for (const r of rows) {
    grandTotal += r.spend_php;
    const key = labKey(r.vendor_id);
    const existing = totals.get(key);
    if (existing) {
      existing.total += r.spend_php;
    } else {
      totals.set(key, {
        vendorId: r.vendor_id,
        label: labLabel(r.vendor_id, r.vendor_name),
        total: r.spend_php,
      });
    }
  }
  return Array.from(totals.values())
    .map((v) => ({
      vendorId: v.vendorId,
      label: v.label,
      spendPhp: v.total,
      sharePct: grandTotal > 0 ? (v.total / grandTotal) * 100 : 0,
    }))
    .sort((a, b) => b.spendPhp - a.spendPhp);
}

export interface SendOutSummary {
  totalSpendPhp: number;
  testsBilled: number;
  billedPhp: number;
  marginPhp: number;
  labShares: LabShare[];
}

/** The four summary tiles + the lab-share breakdown. */
export function buildSummary(
  spendRows: readonly SpendByLabRow[],
  marginRows: readonly MonthlyMarginRow[],
): SendOutSummary {
  const totalSpendPhp = spendRows.reduce((s, r) => s + r.spend_php, 0);
  const testsBilled = marginRows.reduce((s, r) => s + r.tests, 0);
  const billedPhp = marginRows.reduce((s, r) => s + r.revenue_php, 0);
  return {
    totalSpendPhp,
    testsBilled,
    billedPhp,
    marginPhp: billedPhp - totalSpendPhp,
    labShares: computeLabShares(spendRows),
  };
}

/**
 * `marginRows` filled out over every month in the period (zeros for months
 * the RPC didn't return), newest first — so the profit-by-month table lists
 * the same months as the spend-by-lab matrix above it.
 */
export function fillMonthlyMargin(
  rows: readonly MonthlyMarginRow[],
  months: readonly string[],
): MonthlyMarginRow[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return months.map(
    (month) =>
      byMonth.get(month) ?? {
        month,
        tests: 0,
        revenue_php: 0,
        spend_php: 0,
        margin_php: 0,
      },
  );
}

/** `null` when there was no billed amount to take a margin of (nothing to divide by). */
export function marginPct(revenuePhp: number, marginPhp: number): number | null {
  if (revenuePhp === 0) return null;
  return (marginPhp / revenuePhp) * 100;
}

/**
 * Most-tested lab first, tie-broken by name; a row with no partner lab
 * linked (`vendor_id === null`, "Not linked to a partner lab") always sorts
 * last, however many tests it has — same rule as "Not tagged" in the spend
 * matrix above.
 */
export function sortTurnaroundRows(rows: readonly TurnaroundRow[]): TurnaroundRow[] {
  return [...rows].sort((a, b) => {
    const aUnlinked = a.vendor_id === null;
    const bUnlinked = b.vendor_id === null;
    if (aUnlinked !== bUnlinked) return aUnlinked ? 1 : -1;
    return b.tests - a.tests || a.lab_name.localeCompare(b.lab_name);
  });
}

/**
 * Hours under 48 are shown as hours (one decimal, matching the RPC's own
 * rounding); at or past 48 hours the reading is shown in days instead — a
 * send-out turnaround is routinely multi-day, and nobody reads "76.0 hrs" as
 * quickly as "3.2 days".
 */
export function formatTurnaroundHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return "—";
  if (hours < 48) return `${hours.toFixed(1)} hrs`;
  return `${(hours / 24).toFixed(1)} days`;
}

/** `withinPromise / withPromise` as a whole-number percent; "—" when nothing carried a promised turnaround. */
export function withinPromisePct(withPromise: number, withinPromise: number): string {
  if (withPromise <= 0) return "—";
  return `${Math.round((withinPromise / withPromise) * 100)}%`;
}

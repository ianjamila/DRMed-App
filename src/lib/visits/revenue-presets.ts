/**
 * One-click date ranges for the admin "Revenue by classification" dropdown
 * (Visit Records and the admin dashboard). Pure calendar logic built on
 * `buildPeriodPresets`, so the "which month is it?" arithmetic stays off `Date`
 * (see M2 in period-presets.ts) and is unit-testable away from the JSX.
 */
import { buildPeriodPresets } from "@/lib/reports/period-presets";
import { firstOfMonthISO, isoDateParts, lastOfMonthISO } from "@/lib/dates/manila";

export const REVENUE_PRESET_KEYS = [
  "this-month",
  "last-month",
  "ytd",
  "last-year",
  "all",
] as const;
export type RevenuePresetKey = (typeof REVENUE_PRESET_KEYS)[number];

export interface RevenuePreset {
  key: RevenuePresetKey;
  label: string;
  /** "" means open-ended (the "All dates" preset). */
  start: string;
  end: string;
}

export const DEFAULT_REVENUE_PRESET: RevenuePresetKey = "this-month";

export function isRevenuePresetKey(value: string | null | undefined): value is RevenuePresetKey {
  return (REVENUE_PRESET_KEYS as readonly string[]).includes(value ?? "");
}

export function buildRevenuePresets(todayISO: string): RevenuePreset[] {
  const byKey = new Map(buildPeriodPresets(todayISO).map((p) => [p.key, p]));
  const pick = (key: Exclude<RevenuePresetKey, "all">): RevenuePreset => {
    const p = byKey.get(key);
    if (!p) throw new Error(`buildPeriodPresets no longer returns "${key}"`);
    return { key, label: p.label, start: p.start, end: p.end };
  };
  return [
    pick("this-month"),
    pick("last-month"),
    pick("ytd"),
    pick("last-year"),
    { key: "all", label: "All dates", start: "", end: "" },
  ];
}

/** The preset whose range is exactly [start, end], if any. */
export function matchRevenuePreset(
  presets: readonly RevenuePreset[],
  start: string,
  end: string,
): RevenuePreset | undefined {
  return presets.find((p) => p.start === start && p.end === end);
}

/**
 * Year-on-year change for the dropdown's "same dates last year" line, e.g.
 * "+12%" / "−5%" / "0%". Null when last year had nothing to compare against —
 * a percentage over ₱0 is meaningless, so the caller shows the amount alone.
 */
export function yearOnYearChange(current: number, prior: number): string | null {
  if (!(prior > 0)) return null;
  const pct = Math.round(((current - prior) / prior) * 100);
  if (pct === 0) return "0%";
  return pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
}

export interface TrendMonth {
  /** YYYY-MM */
  key: string;
  /** Short month name, e.g. "Sep". */
  label: string;
  year: number;
  start: string;
  /** Last day of the month — or today, for the current (partial) month. */
  end: string;
  partial: boolean;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The trailing `count` calendar months ending with the current one, oldest
 * first — the windows behind the dropdown's 12-month trend. Integer calendar
 * arithmetic only (no `Date`), so the 1st of a month is not the month before.
 */
export function trendMonths(todayISO: string, count = 12): TrendMonth[] {
  const { year, month } = isoDateParts(todayISO);
  const out: TrendMonth[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const start = firstOfMonthISO(year, month - back);
    const { year: y, month: m } = isoDateParts(start);
    const partial = back === 0;
    out.push({
      key: start.slice(0, 7),
      label: MONTH_SHORT[m - 1],
      year: y,
      start,
      end: partial ? todayISO : lastOfMonthISO(y, m),
      partial,
    });
  }
  return out;
}

/** One month of the trend, as /api/admin/revenue-trend returns it. */
export interface RevenueTrendPoint {
  key: string;
  label: string;
  year: number;
  partial: boolean;
  lab: number;
  consult: number;
  procedure: number;
}

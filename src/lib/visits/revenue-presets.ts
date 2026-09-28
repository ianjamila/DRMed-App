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
  /** The month's window — what a click on its bar opens in Visit Records. */
  start: string;
  end: string;
  lab: number;
  consult: number;
  procedure: number;
  /**
   * The same dates one year earlier (`priorYearRange` — so the current,
   * partial month is compared day-for-day, not against a whole month).
   */
  prior: { lab: number; consult: number; procedure: number };
}

export function trendTotal(p: { lab: number; consult: number; procedure: number }): number {
  return p.lab + p.consult + p.procedure;
}

/** "↑ +12%" / "↓ −5%" direction for a trend month vs the same dates last year. */
export function trendDirection(p: RevenueTrendPoint): {
  dir: "up" | "down" | "flat" | "none";
  change: string | null;
} {
  const change = yearOnYearChange(trendTotal(p), trendTotal(p.prior));
  if (change === null) return { dir: "none", change: null };
  if (change === "0%") return { dir: "flat", change };
  return { dir: change.startsWith("+") ? "up" : "down", change };
}

/**
 * The 12-month table as CSV rows (header first) for the bookkeeper. Plain
 * numbers (no ₱, no thousands separators) so a spreadsheet reads them as
 * numbers; month as YYYY-MM so it sorts.
 */
export function revenueTrendCsvRows(points: readonly RevenueTrendPoint[]): (string | number)[][] {
  const money = (n: number) => Number(n.toFixed(2));
  return [
    [
      "Month",
      "Partial month",
      "Lab Tests PHP",
      "Doctor Consults PHP",
      "Doctor Procedures PHP",
      "Total PHP",
      "Same dates last year: Lab Tests PHP",
      "Same dates last year: Doctor Consults PHP",
      "Same dates last year: Doctor Procedures PHP",
      "Same dates last year: Total PHP",
      "Change vs last year %",
    ],
    ...points.map((p) => [
      p.key,
      p.partial ? `to ${p.end}` : "",
      money(p.lab),
      money(p.consult),
      money(p.procedure),
      money(trendTotal(p)),
      money(p.prior.lab),
      money(p.prior.consult),
      money(p.prior.procedure),
      money(trendTotal(p.prior)),
      // A number, not "+12%": a leading "+" is neutralised as a formula by the
      // CSV writer, and a bare number is what a spreadsheet can chart.
      trendTotal(p.prior) > 0
        ? Math.round(((trendTotal(p) - trendTotal(p.prior)) / trendTotal(p.prior)) * 100)
        : "",
    ]),
  ];
}

/**
 * Visit Records over one trend month, with its revenue dropdown open. `view`
 * (active / deleted / all) is carried so the list matches what the bar counted.
 */
export function trendMonthHref(
  point: Pick<RevenueTrendPoint, "start" | "end">,
  view: string = "active",
): string {
  const qs = new URLSearchParams({ start: point.start, end: point.end });
  if (view !== "active") qs.set("view", view);
  qs.set("rev", "1");
  return `/staff/visits?${qs}`;
}

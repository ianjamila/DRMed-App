/**
 * Period controls shared by the Marketing reports (Patient Sources, Booking
 * Sources): presets, custom-range validation and links that keep every other
 * query param (mode, grain, channel) when the period changes.
 *
 * Calendar arithmetic only — YYYY-MM-DD strings via manila.ts, never a Date
 * read back in the runtime's zone (the M2 lesson in period-presets.ts).
 */
import { buildPeriodPresets, type PeriodPreset } from "@/lib/reports/period-presets";
import { daysBetweenISO, daysInMonth, isISODate, isoDateParts, shiftISODate } from "@/lib/dates/manila";

/** The report functions refuse longer periods (0189 _ps_check_period). */
export const MAX_PERIOD_DAYS = 400;

const PERIOD_ERROR =
  "That period can't be shown — pick a start on or before the end, at most 400 days apart. Showing this month instead.";

export function buildMarketingPresets(todayISO: string): PeriodPreset[] {
  const base = new Map(buildPeriodPresets(todayISO).map((p) => [p.key, p]));
  const yesterday = shiftISODate(todayISO, -1);
  const keep = ["this-month", "last-month", "ytd", "12m", "last-year"].map((k) => base.get(k)!);
  return [
    { key: "today", label: "Today", start: todayISO, end: todayISO },
    { key: "yesterday", label: "Yesterday", start: yesterday, end: yesterday },
    { key: "last-7", label: "Last 7 days", start: shiftISODate(todayISO, -6), end: todayISO },
    ...keep,
  ];
}

export interface ResolvedPeriod {
  from: string;
  to: string;
  /** The matching preset, or null for a custom range. */
  presetKey: string | null;
  error: string | null;
}

export function resolvePeriod(sp: { from?: string; to?: string }, todayISO: string): ResolvedPeriod {
  const presets = buildMarketingPresets(todayISO);
  const thisMonth = presets.find((p) => p.key === "this-month")!;
  const match = (from: string, to: string) =>
    presets.find((p) => p.start === from && p.end === to)?.key ?? null;

  if (sp.from === undefined && sp.to === undefined) {
    return { from: thisMonth.start, to: thisMonth.end, presetKey: "this-month", error: null };
  }
  const valid =
    isCalendarDate(sp.from) &&
    isCalendarDate(sp.to) &&
    sp.from <= sp.to &&
    daysBetweenISO(sp.from, sp.to) <= MAX_PERIOD_DAYS;
  if (!valid) {
    return { from: thisMonth.start, to: thisMonth.end, presetKey: "this-month", error: PERIOD_ERROR };
  }
  return { from: sp.from!, to: sp.to!, presetKey: match(sp.from!, sp.to!), error: null };
}

/** A YYYY-MM-DD that is also a real day — isISODate checks the shape only (P21). */
function isCalendarDate(v: string | undefined): v is string {
  if (!isISODate(v)) return false;
  const { year, month, day } = isoDateParts(v);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** `pathname?…` keeping `current` params, overridden by `patch`; null deletes. */
export function periodHref(
  pathname: string,
  current: Readonly<Record<string, string | undefined>>,
  patch: Readonly<Record<string, string | null | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (typeof v === "string" && v !== "" && !(k in patch)) params.set(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string" && v !== "") params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Next 16 search params may be string[] — the first value wins. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Patient Sources owner email (5b) — the pure half: which periods a digest covers,
 * retry validation, the saved-spend roll-up, and (Task 7) the renderer. Every COUNT
 * comes from the report; nothing here re-derives one. No `server-only`: unit-testable.
 */
import { daysBetweenISO, isISODate, isoDateParts, isoWeekday, lastOfMonthISO, shiftISODate } from "@/lib/dates/manila";
import { PATIENT_SOURCES_MIN_DATE } from "./period";
import {
  comparisonPeriod,
  lastCompletedMonth,
  lastCompletedWeek,
  previousMonth,
  previousWeek,
  type Period,
  type ReferrerRow,
  type RevenueRow,
  type SeriesRow,
  type SpendTotalRow,
  type SummaryRow,
} from "./patient-sources";

export type DigestKind = "week" | "month";
export type DigestAlertKey = "patient_sources_weekly" | "patient_sources_monthly";
export const DIGEST_ALERT_KEY: Record<DigestKind, DigestAlertKey> = {
  week: "patient_sources_weekly",
  month: "patient_sources_monthly",
};

/** One period's figures — each from ONE report call (one snapshot). */
export interface DigestPeriodData {
  period: Period;
  summary: SummaryRow;
  /** Served per day, per channel (the report's `series` at day grain, served mode). */
  servedByDay: SeriesRow[];
  /** New per day, per channel (the report's `new_by_day`). */
  newByDay: SeriesRow[];
  revenue: RevenueRow[];
  referrers: ReferrerRow[];
}

export interface DigestData {
  kind: DigestKind;
  cur: DigestPeriodData;
  /** null when the period before starts before Patient Sources' first date. */
  prev: DigestPeriodData | null;
  /** Saved spend per date × platform over [prev.from ?? cur.from, cur.to]. */
  spend: SpendTotalRow[];
  /** false = the ad-spend table has never held a row ("nothing ever saved"). */
  spendEverSaved: boolean;
  /** When the figures were read — the "Numbers as of" stamp. */
  readAt: Date;
}

/** The last day of a digest period that starts on `from`. */
export function periodEnd(kind: DigestKind, from: string): string {
  if (kind === "week") return shiftISODate(from, 6);
  const { year, month } = isoDateParts(from);
  return lastOfMonthISO(year, month);
}

/**
 * The period a digest sent on `todayISO` covers (the last completed week/month),
 * the period before it (null when it would start before the first date), and
 * `tooEarly` when the CURRENT period itself starts before the first date.
 * A retry for an earlier period passes the day AFTER that period as `todayISO`.
 */
export function digestPeriods(kind: DigestKind, todayISO: string): { cur: Period; prev: Period | null; tooEarly: boolean } {
  const cur = kind === "week" ? lastCompletedWeek(todayISO) : lastCompletedMonth(todayISO);
  const before = kind === "week" ? previousWeek(cur) : previousMonth(cur);
  return { cur, prev: comparisonPeriod(before, PATIENT_SOURCES_MIN_DATE), tooEarly: cur.from < PATIENT_SOURCES_MIN_DATE };
}

export const RETRY_MAX_AGE_DAYS = 62;

/** Why `?period_from=` is not a valid retry target, or null when it is. */
export function retryPeriodError(kind: DigestKind, from: string, todayISO: string): string | null {
  if (!isISODate(from) || shiftISODate(from, 0) !== from) return "period_from must be a real date like 2026-10-05.";
  if (kind === "week" && isoWeekday(from) !== 1) return "period_from must be a Monday for the weekly email.";
  if (kind === "month" && isoDateParts(from).day !== 1) return "period_from must be the 1st of a month for the monthly email.";
  if (periodEnd(kind, from) >= todayISO) return "That period is not finished yet.";
  if (daysBetweenISO(from, todayISO) > RETRY_MAX_AGE_DAYS) return `That period started more than ${RETRY_MAX_AGE_DAYS} days ago.`;
  return null;
}

export interface RawSpendRow {
  spend_date: string;
  platform: string;
  spend_php: number | string;
}

/**
 * Per-ad rows → one total per date × platform, summed in whole cents — the same
 * result the admin-only totals RPC gives (`sum(spend_php)` per date and platform;
 * a test pins the equivalence on a multi-page fixture). An unknown platform throws:
 * dropping it would quietly understate spend.
 */
export function aggregateSpend(rows: readonly RawSpendRow[]): SpendTotalRow[] {
  const totals = new Map<string, { spend_date: string; platform: "meta" | "google"; cents: number }>();
  for (const r of rows) {
    if (r.platform !== "meta" && r.platform !== "google") throw new Error(`ad spend: unknown platform "${r.platform}"`);
    const key = `${r.spend_date}|${r.platform}`;
    const t = totals.get(key) ?? { spend_date: r.spend_date, platform: r.platform, cents: 0 };
    t.cents += Math.round(Number(r.spend_php) * 100);
    totals.set(key, t);
  }
  return [...totals.values()]
    .sort((a, b) => a.spend_date.localeCompare(b.spend_date) || a.platform.localeCompare(b.platform))
    .map((t) => ({ spend_date: t.spend_date, platform: t.platform, spend_php: t.cents / 100 }));
}

/** Spend rows inside a period (cost per new patient must never see the other period's spend). */
export function spendIn(spend: readonly SpendTotalRow[], p: Period): SpendTotalRow[] {
  return spend.filter((s) => s.spend_date >= p.from && s.spend_date <= p.to);
}
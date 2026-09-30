/**
 * First-night check — the pure half. Given the numbers every "New patients"
 * screen shows for a range of days, decide whether the screens agree and
 * whether any day jumped (an import night). No I/O: `first-night-check.server.ts`
 * fetches, this module judges, the admin panel and the CLI both render the
 * report it returns.
 *
 * A "mismatch" is never smoothed over: if two screens genuinely differ, the
 * check reports both numbers and which screens they came from.
 */
import { daysBetweenISO, daysInMonth, isISODate, isoDateParts, manilaDate, shiftISODate } from "@/lib/dates/manila";
import { PATIENT_SOURCES_MIN_DATE } from "./period";
import { formatNewCounts } from "./patient-sources";

export const DEFAULT_THRESHOLD = 40;
export const MIN_THRESHOLD = 1;
export const MAX_THRESHOLD = 100_000;
export const DEFAULT_DAYS = 7;
/** The admin panel makes ~3 report calls per day, so it stays small. */
export const PANEL_MAX_DAYS = 31;
/** The report functions refuse longer periods (0189 _ps_check_period). */
export const CLI_MAX_DAYS = 400;

export interface Counts { confirmed: number; unconfirmed: number }
export interface CheckParams { from: string; to: string; threshold: number }

export type ParseResult = { ok: true; params: CheckParams } | { ok: false; errors: string[] };

function isRealDate(v: string | null | undefined): v is string {
  if (!isISODate(v)) return false;
  const { year, month, day } = isoDateParts(v);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

const blank = (v: string | null | undefined) => v === undefined || v === null || v.trim() === "";

/**
 * Validate the range + threshold. A blank "to" means today; a blank "from"
 * means six days before "to" (the last seven days). Messages are written for
 * the clinic owner, one per problem.
 */
export function parseCheckParams(
  raw: { from?: string | null; to?: string | null; threshold?: string | number | null },
  opts: { maxDays: number; today: string },
): ParseResult {
  const errors: string[] = [];
  const toRaw = blank(raw.to) ? opts.today : raw.to!.trim();
  const fromRaw = blank(raw.from) ? (isRealDate(toRaw) ? shiftISODate(toRaw, -(DEFAULT_DAYS - 1)) : "") : raw.from!.trim();

  const fromOk = isRealDate(fromRaw);
  const toOk = isRealDate(toRaw);
  if (!fromOk) errors.push("The first day isn't a real date — use the format 2026-09-30.");
  if (!toOk) errors.push("The last day isn't a real date — use the format 2026-09-30.");

  if (fromOk && fromRaw < PATIENT_SOURCES_MIN_DATE) {
    errors.push("Patient Sources starts on 1 December 2023 — pick a first day on or after that.");
  }
  if (toOk && toRaw > opts.today) errors.push("The last day can't be in the future — the latest is today.");
  if (fromOk && toOk) {
    if (fromRaw > toRaw) errors.push("The first day must be on or before the last day.");
    else {
      const days = daysBetweenISO(fromRaw, toRaw) + 1;
      if (days > opts.maxDays) errors.push(`Pick at most ${opts.maxDays} days at a time — that range is ${days} days.`);
    }
  }

  let threshold = DEFAULT_THRESHOLD;
  const tRaw = raw.threshold === undefined || raw.threshold === null ? "" : String(raw.threshold).trim();
  if (tRaw !== "") {
    const n = /^\d+$/.test(tRaw) ? Number(tRaw) : NaN;
    if (!Number.isInteger(n) || n < MIN_THRESHOLD || n > MAX_THRESHOLD) {
      errors.push(`The spike threshold must be a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD.toLocaleString("en-PH")}.`);
    } else threshold = n;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, params: { from: fromRaw, to: toRaw, threshold } };
}

/** Every calendar day from..to inclusive. */
export function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftISODate(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Input (what the server engine collects) and report (what the front doors show)
// ---------------------------------------------------------------------------

export interface DayInput {
  date: string;
  /** Patient Sources summary for this one day. */
  summary: Counts | null;
  /** The chart's bucket for this day (0/0 when the chart has no bucket — the series omits empty days). */
  chart: Counts | null;
  /** The dashboard "New today" tile as it would read on this day. */
  tile: Counts | null;
  /** Patient records created this Manila day (context only, never judged). */
  created: { app: number; imported: number } | null;
}

export interface LoadError { what: string; date?: string; message: string }

export interface SyncInfo {
  paused: boolean | null;
  lastSyncedAt: string | null;
  lastRunStatus: "succeeded" | "partial" | "failed" | null;
  undatedRegistrations: number;
}

export interface CheckInput {
  params: CheckParams;
  /** Patient Sources summary for the whole range. */
  patientSourcesCard: Counts | null;
  /** The Booking Sources "New patients" tile text, from its own separate call. */
  bookingCardText: string | null;
  /** The Patient Sources chart summed over the whole range. */
  chartTotal: Counts | null;
  days: DayInput[];
  loadErrors: LoadError[];
  sync: SyncInfo | null;
}

export type Verdict = "pass" | "spike" | "mismatch" | "error";
export type MismatchKind =
  | "booking_card" | "chart_total" | "dashboard_total" | "sum_of_days" | "day_chart" | "day_dashboard";

export interface Mismatch {
  kind: MismatchKind;
  /** Plain name of the screen that disagrees with the reference. */
  surface: string;
  date: string | null;
  /** What the reference (Patient Sources) shows, as text. */
  expected: string;
  /** What this screen shows, as text. */
  actual: string;
  message: string;
}

export interface TotalsRow {
  key: "patient_sources" | "booking_sources" | "chart" | "dashboard" | "sum_of_days";
  label: string;
  counts: Counts | null;
  text: string | null;
  /** null = could not be compared (not loaded, or it is the reference). */
  agrees: boolean | null;
}

export interface DayRow extends DayInput {
  /** The day's New count — the highest any screen shows; null when none loaded. */
  count: number | null;
  spike: boolean;
  mismatch: boolean;
}

export interface CheckReport {
  verdict: Verdict;
  headline: string;
  advice: string;
  params: CheckParams;
  totals: TotalsRow[];
  days: DayRow[];
  mismatches: Mismatch[];
  spikes: { date: string; count: number }[];
  errors: LoadError[];
  stats: { threshold: number; median: number; max: number; maxDate: string | null };
  sync: SyncInfo | null;
}

const sameCounts = (a: Counts, b: Counts) => a.confirmed === b.confirmed && a.unconfirmed === b.unconfirmed;
const total = (c: Counts) => c.confirmed + c.unconfirmed;
const text = (c: Counts) => formatNewCounts(c.confirmed, c.unconfirmed);

export const SURFACE = {
  patientSources: "Patient Sources",
  booking: "Booking Sources",
  chart: "Patient Sources chart",
  dashboard: "Dashboard “New today”",
  sumOfDays: "Day-by-day total",
} as const;

function sumCounts(list: readonly (Counts | null)[]): Counts | null {
  if (list.some((c) => c === null)) return null;
  return (list as Counts[]).reduce((s, c) => ({ confirmed: s.confirmed + c.confirmed, unconfirmed: s.unconfirmed + c.unconfirmed }), {
    confirmed: 0, unconfirmed: 0,
  });
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const dayLabel = (iso: string) => manilaDate(iso);

export function evaluateCheck(input: CheckInput): CheckReport {
  const { params } = input;
  const mismatches: Mismatch[] = [];
  const reference = input.patientSourcesCard;

  const push = (m: Omit<Mismatch, "message"> & { message?: string }) =>
    mismatches.push({ ...m, message: m.message ?? `${m.surface} shows ${m.actual} but Patient Sources shows ${m.expected}${m.date ? ` on ${dayLabel(m.date)}` : ""}` });

  // -- range totals ---------------------------------------------------------
  const tileTotal = sumCounts(input.days.map((d) => d.tile));
  const dayTotal = sumCounts(input.days.map((d) => d.summary));

  if (reference) {
    if (input.bookingCardText !== null && input.bookingCardText !== text(reference)) {
      push({ kind: "booking_card", surface: SURFACE.booking, date: null, expected: text(reference), actual: input.bookingCardText });
    }
    if (input.chartTotal && !sameCounts(input.chartTotal, reference)) {
      push({ kind: "chart_total", surface: SURFACE.chart, date: null, expected: text(reference), actual: text(input.chartTotal) });
    }
    if (tileTotal && !sameCounts(tileTotal, reference)) {
      push({ kind: "dashboard_total", surface: SURFACE.dashboard, date: null, expected: text(reference), actual: text(tileTotal) });
    }
    if (dayTotal && !sameCounts(dayTotal, reference)) {
      push({ kind: "sum_of_days", surface: SURFACE.sumOfDays, date: null, expected: text(reference), actual: text(dayTotal),
        message: `Adding up each day gives ${text(dayTotal)} but the whole range shows ${text(reference)} — a person should be New on exactly one day` });
    }
  }

  // -- per day --------------------------------------------------------------
  const days: DayRow[] = input.days.map((d) => {
    let mismatch = false;
    if (d.summary) {
      if (d.chart && !sameCounts(d.chart, d.summary)) {
        mismatch = true;
        push({ kind: "day_chart", surface: SURFACE.chart, date: d.date, expected: text(d.summary), actual: text(d.chart) });
      }
      if (d.tile && !sameCounts(d.tile, d.summary)) {
        mismatch = true;
        push({ kind: "day_dashboard", surface: SURFACE.dashboard, date: d.date, expected: text(d.summary), actual: text(d.tile) });
      }
    }
    const seen = [d.summary, d.chart, d.tile].filter((c): c is Counts => c !== null).map(total);
    const count = seen.length > 0 ? Math.max(...seen) : null;
    return { ...d, count, spike: count !== null && count > params.threshold, mismatch };
  });

  // -- stats + spikes -------------------------------------------------------
  const counted = days.filter((d): d is DayRow & { count: number } => d.count !== null);
  const spikes = counted.filter((d) => d.spike).map((d) => ({ date: d.date, count: d.count }));
  const top = counted.reduce<(DayRow & { count: number }) | null>((best, d) => (best === null || d.count > best.count ? d : best), null);
  const stats = {
    threshold: params.threshold,
    median: median(counted.map((d) => d.count)),
    max: top?.count ?? 0,
    maxDate: top?.date ?? null,
  };

  // -- totals table ---------------------------------------------------------
  const agree = (c: Counts | null): boolean | null => (reference && c ? sameCounts(c, reference) : null);
  const totals: TotalsRow[] = [
    { key: "patient_sources", label: SURFACE.patientSources, counts: reference, text: reference ? text(reference) : null, agrees: null },
    {
      key: "booking_sources", label: SURFACE.booking, counts: null, text: input.bookingCardText,
      agrees: reference && input.bookingCardText !== null ? input.bookingCardText === text(reference) : null,
    },
    { key: "chart", label: SURFACE.chart, counts: input.chartTotal, text: input.chartTotal ? text(input.chartTotal) : null, agrees: agree(input.chartTotal) },
    { key: "dashboard", label: SURFACE.dashboard, counts: tileTotal, text: tileTotal ? text(tileTotal) : null, agrees: agree(tileTotal) },
    { key: "sum_of_days", label: SURFACE.sumOfDays, counts: dayTotal, text: dayTotal ? text(dayTotal) : null, agrees: agree(dayTotal) },
  ];

  // -- verdict --------------------------------------------------------------
  const errors = input.loadErrors;
  const verdict: Verdict = errors.length > 0 ? "error" : mismatches.length > 0 ? "mismatch" : spikes.length > 0 ? "spike" : "pass";

  let headline: string;
  let advice: string;
  if (verdict === "error") {
    const names = [...new Set(errors.map((e) => e.what))];
    headline = `The check couldn't finish — ${names.join(", ")} could not be loaded`;
    advice = "These figures are unknown, not zero. Run the check again; if it keeps failing, tell the developer.";
  } else if (verdict === "mismatch") {
    const more = mismatches.length > 1 ? ` (and ${mismatches.length - 1} more)` : "";
    headline = `Screens disagree — ${mismatches[0].message}${more}`;
    advice = "Do not trust the New patients numbers until this is explained. Send this page (or the command output) to the developer.";
  } else if (verdict === "spike") {
    headline = spikes.length === 1
      ? `A day jumped above ${params.threshold.toLocaleString("en-PH")} new patients`
      : `${spikes.length} days jumped above ${params.threshold.toLocaleString("en-PH")} new patients`;
    advice = "The screens agree with each other, but a normal day is a handful of new patients. Check whether imported records are being counted as new.";
  } else {
    headline = "All screens agree";
    advice = "Every screen shows the same New patients numbers, and no day was unusually high.";
  }

  return { verdict, headline, advice, params, totals, days, mismatches, spikes, errors, stats, sync: input.sync };
}

/** Exit code for the CLI: 0 pass, 1 mismatch or error, 2 spike only. */
export function exitCodeFor(verdict: Verdict): 0 | 1 | 2 {
  return verdict === "pass" ? 0 : verdict === "spike" ? 2 : 1;
}

/** The CLI command that reproduces a panel run (shown at the bottom of the panel). */
export function cliCommand(p: CheckParams): string {
  return `npm run first-night:check -- --from ${p.from} --to ${p.to} --threshold ${p.threshold}`;
}

/** Plain-text report for the terminal. */
export function formatReportText(r: CheckReport): string {
  const L: string[] = [];
  L.push(r.headline, r.advice, "");
  L.push(`Range: ${r.params.from} to ${r.params.to} · spike threshold ${r.params.threshold}`);
  L.push(`Daily New patients: median ${r.stats.median}, highest ${r.stats.max}${r.stats.maxDate ? ` (${r.stats.maxDate})` : ""}`, "");
  L.push("Whole range");
  for (const t of r.totals) {
    const mark = t.agrees === null ? " " : t.agrees ? "=" : "!";
    L.push(`  ${mark} ${t.label.padEnd(24)} ${t.text ?? "not available"}`);
  }
  const head = ["Date", "Summary", "Chart", "Dashboard", "Created app/imported", "Flag"];
  const cell = (c: Counts | null) => (c ? `${c.confirmed}+${c.unconfirmed}` : "?");
  const rows = r.days.map((d) => [
    d.date, cell(d.summary), cell(d.chart), cell(d.tile),
    d.created ? `${d.created.app} / ${d.created.imported}` : "?",
    [d.spike ? "SPIKE" : "", d.mismatch ? "MISMATCH" : ""].filter(Boolean).join(" "),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  L.push("", "Day by day — each count is confirmed+unconfirmed New patients");
  L.push(head.map((h, i) => h.padEnd(widths[i])).join("  "));
  for (const row of rows) L.push(row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  if (r.mismatches.length > 0) { L.push("", "Disagreements"); for (const m of r.mismatches) L.push(`  - ${m.message}`); }
  if (r.errors.length > 0) { L.push("", "Could not load"); for (const e of r.errors) L.push(`  - ${e.what}${e.date ? ` (${e.date})` : ""}: ${e.message}`); }
  if (r.sync) {
    L.push("", `Sheet sync: ${r.sync.paused ? "paused" : r.sync.paused === false ? "on" : "unknown"} · last synced ${r.sync.lastSyncedAt ?? "never"} · last run ${r.sync.lastRunStatus ?? "none"} · ${r.sync.undatedRegistrations} undated registrations (not on any day)`);
  }
  return L.join("\n");
}

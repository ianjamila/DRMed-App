/**
 * Patient Sources (Sheet Sync PR 2) — the pure half: types of the 0189 report
 * functions, labels, the per-channel table, chart rows, cost per new patient,
 * the dashboard tile wording, CSV rows and the error classifier. Every COUNT
 * comes from SQL; nothing here re-derives one.
 */
import { REFERRAL_NOT_RECORDED_LABEL, referralSourceLabel } from "@/lib/patients/referral-sources";
import { humaniseCode } from "@/lib/format/humanise-code";
import { daysBetweenISO, isoDateParts, shiftISODate } from "@/lib/dates/manila";

export const NOT_RECORDED = "not_recorded";
export type Mode = "new" | "served";
export type Grain = "day" | "week" | "month";

export interface SummaryRow {
  new_confirmed: number;
  new_unconfirmed: number;
  returning_first_recorded: number;
  served_confirmed: number;
  served_unconfirmed: number;
  undated_registrations: number;
  source_recorded: number;
  source_total: number;
  sheet_last_dates: Record<string, string | null>;
  sync_paused: boolean | null;
  last_synced_at: string | null;
  sheet_rows_present: boolean;
  last_run_status: "succeeded" | "partial" | "failed" | null;
}
export interface SeriesRow { bucket_start: string; channel: string; confirmed: number; unconfirmed: number }
export interface RevenueRow { channel: string; confirmed_php: number; unconfirmed_php: number }
export interface OverlapRow { patient_id: string; drm_id: string; service_date: string; app_php: number; sheet_php: number }
export interface ReferrerRow { doctor_label: string; new_confirmed: number; new_unconfirmed: number }

/** Every section of the Patient Sources page from ONE `patient_sources_report` call (0206). */
export interface PatientSourcesReport {
  summary: SummaryRow;
  series: SeriesRow[];
  current: SeriesRow[];
  previous: SeriesRow[] | null;
  new_by_day: SeriesRow[];
  revenue: RevenueRow[];
  overlaps: OverlapRow[];
  referrers: ReferrerRow[];
}

const SUMMARY_COUNTS = [
  "new_confirmed", "new_unconfirmed", "returning_first_recorded", "served_confirmed", "served_unconfirmed",
  "undated_registrations", "source_recorded", "source_total",
] as const;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Maps each element with `row`; null if the input is not an array or any element is rejected. */
function rowsOf<T>(v: unknown, row: (o: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const r = isObj(x) ? row(x) : null;
    if (r === null) return null;
    out.push(r);
  }
  return out;
}
function seriesRow(o: Record<string, unknown>): SeriesRow | null {
  const confirmed = num(o.confirmed), unconfirmed = num(o.unconfirmed);
  if (typeof o.bucket_start !== "string" || typeof o.channel !== "string" || confirmed === null || unconfirmed === null) return null;
  return { bucket_start: o.bucket_start, channel: o.channel, confirmed, unconfirmed };
}
function revenueRow(o: Record<string, unknown>): RevenueRow | null {
  const c = num(o.confirmed_php), u = num(o.unconfirmed_php);
  if (typeof o.channel !== "string" || c === null || u === null) return null;
  return { channel: o.channel, confirmed_php: c, unconfirmed_php: u };
}
function overlapRow(o: Record<string, unknown>): OverlapRow | null {
  const a = num(o.app_php), s = num(o.sheet_php);
  if (typeof o.patient_id !== "string" || typeof o.drm_id !== "string" || typeof o.service_date !== "string" || a === null || s === null) return null;
  return { patient_id: o.patient_id, drm_id: o.drm_id, service_date: o.service_date, app_php: a, sheet_php: s };
}
function referrerRow(o: Record<string, unknown>): ReferrerRow | null {
  const c = num(o.new_confirmed), u = num(o.new_unconfirmed);
  if (typeof o.doctor_label !== "string" || c === null || u === null) return null;
  return { doctor_label: o.doctor_label, new_confirmed: c, new_unconfirmed: u };
}

/** Validates the jsonb reply of `patient_sources_report`; null when it is not the expected shape. */
export function parsePatientSourcesReport(raw: unknown): PatientSourcesReport | null {
  if (!isObj(raw) || !isObj(raw.summary)) return null;
  const sm = raw.summary;
  const counts: Record<string, number> = {};
  for (const k of SUMMARY_COUNTS) {
    const n = num(sm[k]);
    if (n === null) return null;
    counts[k] = n;
  }
  const summary = { ...(sm as unknown as SummaryRow), ...counts } as SummaryRow;
  const series = rowsOf(raw.series, seriesRow);
  const current = rowsOf(raw.current, seriesRow);
  const newByDay = rowsOf(raw.new_by_day, seriesRow);
  const previous = raw.previous === null ? null : rowsOf(raw.previous, seriesRow);
  const revenue = rowsOf(raw.revenue, revenueRow);
  const overlaps = rowsOf(raw.overlaps, overlapRow);
  const referrers = rowsOf(raw.referrers, referrerRow);
  if (!series || !current || !newByDay || (raw.previous !== null && !previous) || !revenue || !overlaps || !referrers) return null;
  return { summary, series, current, previous, new_by_day: newByDay, revenue, overlaps, referrers };
}
export interface PeopleRow {
  identity_kind: "confirmed" | "unconfirmed";
  identity: string;
  patient_id: string | null;
  drm_id: string | null;
  display_name: string | null;
  first_date: string;
  total_count: number;
}
export interface SpendTotalRow { spend_date: string; platform: "meta" | "google"; spend_php: number }
/** One saved ad row (0203 ad_spend_rows): per ad per day. null leads/bookings/impressions/clicks = the file did not say. */
export interface AdSpendDbRow {
  spend_date: string;
  platform: "meta" | "google";
  campaign_key: string;
  campaign_label: string;
  ad_key: string;
  ad_label: string | null;
  spend_php: number;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  platform_bookings: number | null;
}

export type ReportErrorKind = "converted" | "forbidden" | "invalid" | "error";
export type ReportResult<T> = { ok: true; data: T } | { ok: false; kind: ReportErrorKind; message: string };

const ERROR_MESSAGE: Record<ReportErrorKind, string> = {
  converted: "Patient Sources is being switched to the converted records — ask the developer.",
  forbidden: "Patient Sources is for admins only. If you are using View as, switch back to Admin.",
  invalid: "That period can't be shown — pick a start on or before the end, at most 400 days apart.",
  error: "Couldn't load Patient Sources. Reload the page — these figures are unknown, not zero.",
};

export function classifyReportError(err: unknown): { ok: false; kind: ReportErrorKind; message: string } {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
  const kind: ReportErrorKind =
    code === "0A000" ? "converted" : code === "42501" ? "forbidden" : code === "22023" ? "invalid" : "error";
  return { ok: false, kind, message: ERROR_MESSAGE[kind] };
}

export function parseMode(v: string | undefined): Mode {
  return v === "served" ? "served" : "new";
}
export function parseGrain(v: string | undefined): Grain {
  return v === "week" || v === "month" ? v : "day";
}
export const MODE_LABEL: Record<Mode, string> = { new: "New customers", served: "All customers served" };
export const GRAIN_LABEL: Record<Grain, string> = { day: "Day", week: "Week", month: "Month" };

export function channelLabel(channel: string): string {
  if (channel === NOT_RECORDED) return REFERRAL_NOT_RECORDED_LABEL;
  const label = referralSourceLabel(channel);
  return label && label !== channel ? label : humaniseCode(channel);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function bucketLabel(grain: Grain, iso: string): string {
  const { year, month, day } = isoDateParts(iso);
  if (grain === "month") return `${MONTHS[month - 1]} ${year}`;
  const d = `${day} ${MONTHS[month - 1]}`;
  return grain === "week" ? `Wk of ${d}` : d;
}

export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const len = daysBetweenISO(from, to);
  const prevTo = shiftISODate(from, -1);
  return { from: shiftISODate(prevTo, -len), to: prevTo };
}

export interface ChannelTableRow {
  channel: string;
  label: string;
  confirmed: number;
  unconfirmed: number;
  total: number;
  share: number;
  /** null when the previous period starts before Patient Sources' first date (no comparison). */
  previousTotal: number | null;
  change: number | null;
}

function totalsByChannel(rows: readonly SeriesRow[]): Map<string, { confirmed: number; unconfirmed: number }> {
  const m = new Map<string, { confirmed: number; unconfirmed: number }>();
  for (const r of rows) {
    const t = m.get(r.channel) ?? { confirmed: 0, unconfirmed: 0 };
    t.confirmed += Number(r.confirmed);
    t.unconfirmed += Number(r.unconfirmed);
    m.set(r.channel, t);
  }
  return m;
}

/** `current` / `previous` are 'period'-grain rows (one bucket each). */
export function channelTable(current: readonly SeriesRow[], previous: readonly SeriesRow[] | null): ChannelTableRow[] {
  const cur = totalsByChannel(current);
  const prev = totalsByChannel(previous ?? []);
  const grand = [...cur.values()].reduce((s, t) => s + t.confirmed + t.unconfirmed, 0);
  const channels = new Set([...cur.keys(), ...prev.keys()]);
  return [...channels]
    .map((channel) => {
      const c = cur.get(channel) ?? { confirmed: 0, unconfirmed: 0 };
      const p = prev.get(channel) ?? { confirmed: 0, unconfirmed: 0 };
      const total = c.confirmed + c.unconfirmed;
      const previousTotal = previous === null ? null : p.confirmed + p.unconfirmed;
      return {
        channel,
        label: channelLabel(channel),
        confirmed: c.confirmed,
        unconfirmed: c.unconfirmed,
        total,
        share: grand > 0 ? total / grand : 0,
        previousTotal,
        change: previousTotal === null ? null : total - previousTotal,
      };
    })
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label) || a.channel.localeCompare(b.channel));
}

const PALETTE = [
  "#1d4ed8", "#0891b2", "#16a34a", "#ca8a04", "#dc2626", "#7c3aed",
  "#db2777", "#0d9488", "#ea580c", "#4f46e5", "#65a30d", "#64748b",
];
export interface ChartChannel { key: string; label: string; color: string }
export type ChartDatum = { bucket: string; label: string } & Record<string, string | number>;

export function chartData(rows: readonly SeriesRow[], grain: Grain): { rows: ChartDatum[]; channels: ChartChannel[] } {
  const totals = totalsByChannel(rows);
  const channels = [...totals.entries()]
    .sort((a, b) => b[1].confirmed + b[1].unconfirmed - (a[1].confirmed + a[1].unconfirmed) || a[0].localeCompare(b[0]))
    .map(([key], i) => ({ key, label: channelLabel(key), color: PALETTE[i % PALETTE.length] }));
  const buckets = [...new Set(rows.map((r) => r.bucket_start))].sort();
  const byKey = new Map(rows.map((r) => [`${r.bucket_start}|${r.channel}`, r]));
  return {
    channels,
    rows: buckets.map((bucket) => {
      const d: ChartDatum = { bucket, label: bucketLabel(grain, bucket) };
      for (const c of channels) {
        const r = byKey.get(`${bucket}|${c.key}`);
        d[`${c.key}__c`] = r ? Number(r.confirmed) : 0;
        d[`${c.key}__u`] = r ? Number(r.unconfirmed) : 0;
      }
      return d;
    }),
  };
}

export const AD_PLATFORMS = [
  { platform: "meta", label: "Meta (Facebook)", channel: "online_facebook" },
  { platform: "google", label: "Google", channel: "online_google" },
] as const;

export interface CostPerNew {
  platform: "meta" | "google";
  label: string;
  spendPhp: number;
  days: number;
  newConfirmed: number;
  newUnconfirmed: number;
  costPerNewPhp: number | null;
}

/** Spend ÷ new customers of the matching channel, over days that have spend only (spec §2.3). */
export function costPerNewPatient(spend: readonly SpendTotalRow[], newByDay: readonly SeriesRow[]): CostPerNew[] {
  return AD_PLATFORMS.map(({ platform, label, channel }) => {
    const days = new Map<string, number>();
    for (const s of spend) {
      if (s.platform === platform && Number(s.spend_php) > 0) {
        days.set(s.spend_date, (days.get(s.spend_date) ?? 0) + Number(s.spend_php));
      }
    }
    let newConfirmed = 0;
    let newUnconfirmed = 0;
    for (const r of newByDay) {
      if (r.channel === channel && days.has(r.bucket_start)) {
        newConfirmed += Number(r.confirmed);
        newUnconfirmed += Number(r.unconfirmed);
      }
    }
    const spendPhp = Math.round([...days.values()].reduce((a, b) => a + b, 0) * 100) / 100;
    const people = newConfirmed + newUnconfirmed;
    return {
      platform,
      label,
      spendPhp,
      days: days.size,
      newConfirmed,
      newUnconfirmed,
      costPerNewPhp: people > 0 ? Math.round((spendPhp / people) * 100) / 100 : null,
    };
  });
}

/** P19: what the page says about sheet data — null when it is included and current. */
export function sheetBanner(
  s: Pick<SummaryRow, "sheet_rows_present" | "sync_paused" | "last_run_status">,
): string | null {
  if (!s.sheet_rows_present) {
    return "Sheet data is not included yet — the sheet sync has not loaded anything. Showing app records only.";
  }
  if (s.last_run_status === "partial" || s.last_run_status === "failed") {
    return "The last sheet sync did not finish every tab — some sheet data may be out of date. Check “Latest service date in the sheet” below and Admin Tools › Sheet Sync.";
  }
  if (s.sync_paused) {
    return "The sheet sync is paused — sheet data is included up to the dates below and is not being refreshed.";
  }
  return null;
}

/** Admin dashboard tile: "5 Walk-in · 3 Facebook · … · N more (M unconfirmed)". */
export function formatNewToday(rows: readonly SeriesRow[]): { total: number; unconfirmed: number; hint: string } {
  const totals = [...totalsByChannel(rows).entries()]
    .map(([channel, t]) => ({ channel, n: t.confirmed + t.unconfirmed, u: t.unconfirmed }))
    .filter((t) => t.n > 0)
    .sort((a, b) => b.n - a.n || channelLabel(a.channel).localeCompare(channelLabel(b.channel)));
  const total = totals.reduce((s, t) => s + t.n, 0);
  const unconfirmed = totals.reduce((s, t) => s + t.u, 0);
  if (total === 0) return { total: 0, unconfirmed: 0, hint: "No new patients recorded yet today" };
  const top = totals.slice(0, 4).map((t) => `${t.n} ${channelLabel(t.channel)}`);
  const rest = totals.slice(4).reduce((s, t) => s + t.n, 0);
  const parts = rest > 0 ? [...top, `${rest} more`] : top;
  return { total, unconfirmed, hint: parts.join(" · ") + (unconfirmed > 0 ? ` (${unconfirmed} unconfirmed)` : "") };
}

/** Counts CSV: the summary (same numbers as the cards) above the channel × bucket table. */
export function seriesCsvRows(
  p: { from: string; to: string; mode: Mode; grain: Grain },
  summary: SummaryRow,
  series: readonly SeriesRow[],
): (string | number)[][] {
  return [
    ["Patient Sources", `${p.from} to ${p.to}`, MODE_LABEL[p.mode], GRAIN_LABEL[p.grain]],
    ["New customers — confirmed", summary.new_confirmed],
    ["New customers — unconfirmed", summary.new_unconfirmed],
    ["Returning, first time in our records", summary.returning_first_recorded],
    ["All customers served — confirmed", summary.served_confirmed],
    ["All customers served — unconfirmed", summary.served_unconfirmed],
    ["Source recorded", `${summary.source_recorded} of ${summary.source_total}`],
    ["Registrations with no date (not on any day)", summary.undated_registrations],
    [],
    ["Period start", "Channel", "Confirmed", "Unconfirmed"],
    ...series.map((r) => [r.bucket_start, channelLabel(r.channel), Number(r.confirmed), Number(r.unconfirmed)]),
  ];
}

/** "6 confirmed · 0 unconfirmed" — the one wording the Patient Sources card, the Booking Sources tile and the first-night check share. */
export function formatNewCounts(confirmed: number, unconfirmed: number): string {
  return `${confirmed.toLocaleString("en-PH")} confirmed · ${unconfirmed.toLocaleString("en-PH")} unconfirmed`;
}

/**
 * The "New patients" tile on Booking Sources. Patient Sources refuses a period
 * that starts before PATIENT_SOURCES_MIN_DATE (0193), so that page skips the
 * summary call (`summary === null`) and says so instead of showing an error.
 */
export function newPatientsTile(
  summary: ReportResult<SummaryRow> | null,
): { value: string; error: boolean; linked: boolean } {
  if (summary === null) return { value: "Not available before Dec 2023", error: false, linked: false };
  if (!summary.ok) return { value: "—", error: true, linked: true };
  return {
    value: formatNewCounts(summary.data.new_confirmed, summary.data.new_unconfirmed),
    error: false,
    linked: true,
  };
}

/**
 * Patient Sources owner email (5b) — the pure half: which periods a digest covers,
 * retry validation, the saved-spend roll-up, and (Task 7) the renderer. Every COUNT
 * comes from the report; nothing here re-derives one. No `server-only`: unit-testable.
 */
import {
  daysBetweenISO, isISODate, isoDateParts, isoWeekday, lastOfMonthISO, manilaDate, shiftISODate,
} from "@/lib/dates/manila";
import { emailButton, emailDetailBox, emailFinePrint, emailParagraph, escapeHtml, renderEmailShell } from "@/lib/notifications/branded-email";
import { formatPhp } from "./format";
import { PATIENT_SOURCES_MIN_DATE } from "./period";
import {
  asOfLabel, biggestMover, bucketLabel, channelDeltas, channelLabel, channelTable, comparisonPeriod, costPerNewPatient,
  formatNewCounts, lastCompletedMonth, lastCompletedWeek, previousMonth, previousWeek, sheetBanner, sheetDatesText,
  sundayObservation, type Period, type ReferrerRow, type RevenueRow, type SeriesRow, type SpendTotalRow, type SummaryRow,
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
    const cents = Math.round(Number(r.spend_php) * 100);
    // A non-numeric amount would print as ₱NaN; fail the digest instead (nothing is sent).
    if (!Number.isFinite(cents)) throw new Error(`ad spend: bad amount on ${r.spend_date} ${r.platform}`);
    t.cents += cents;
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
// ---------------------------------------------------------------------------
// Renderer — one list of blocks, rendered to html (inline styles) AND plain text
// ---------------------------------------------------------------------------

interface Block {
  html: string;
  text: string;
}

const NAVY = "#263F91";
const SOFT = "#6b7280";
const INK = "#1a2537";
const RULE = "#e5eaf2";
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun (half day)"] as const;

const n = (x: number) => x.toLocaleString("en-PH");
const newTotal = (s: SummaryRow) => s.new_confirmed + s.new_unconfirmed;
const servedTotal = (s: SummaryRow) => s.served_confirmed + s.served_unconfirmed;
const signed = (x: number) => (x > 0 ? `+${n(x)}` : x < 0 ? `-${n(Math.abs(x))}` : "0");

function deltaText(now: number, before: number | null): string {
  if (before === null) return "no comparison";
  const change = now - before;
  return change === 0 ? "= no change" : `${change > 0 ? "▲" : "▼"} ${n(Math.abs(change))}`;
}
function moneyDelta(now: number, before: number): string {
  const change = now - before;
  return change === 0 ? "= no change" : `${change > 0 ? "▲" : "▼"} ${formatPhp(Math.abs(change))}`;
}

const heading = (title: string): Block => ({
  html: `<h3 style="margin:24px 0 6px;font-size:16px;color:${NAVY};">${escapeHtml(title)}</h3>`,
  text: `\n${title}`,
});
const para = (t: string): Block => ({ html: emailParagraph(escapeHtml(t)), text: t });
const fine = (t: string): Block => ({ html: emailFinePrint(escapeHtml(t)), text: t });
const detail = (rows: Array<{ label: string; value: string }>): Block => ({
  html: emailDetailBox(rows),
  text: rows.map((r) => `${r.label}: ${r.value}`).join("\n"),
});

function table(head: readonly string[], rows: readonly (readonly string[])[]): Block {
  const cell = (v: string, i: number, tag: "th" | "td") =>
    `<${tag} align="${i === 0 ? "left" : "right"}" style="padding:6px 8px;font-size:13px;border-bottom:1px solid ${RULE};${
      tag === "th" ? `color:${SOFT};font-weight:600;` : ""
    }">${escapeHtml(v)}</${tag}>`;
  const html =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 14px;color:${INK};border-collapse:collapse;">` +
    `<tr>${head.map((h, i) => cell(h, i, "th")).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((v, i) => cell(v, i, "td")).join("")}</tr>`).join("") +
    `</table>`;
  return { html, text: [head, ...rows].map((r) => r.join(" | ")).join("\n") };
}

const sumDay = (rows: readonly SeriesRow[], day: string) =>
  rows.filter((r) => r.bucket_start === day).reduce((s, r) => s + Number(r.confirmed) + Number(r.unconfirmed), 0);

function revenueBlocks(cur: DigestPeriodData, prev: DigestPeriodData | null, unit: DigestKind): Block[] {
  const total = (rows: readonly RevenueRow[]) => rows.reduce((s, r) => s + Number(r.confirmed_php) + Number(r.unconfirmed_php), 0);
  const curTotal = total(cur.revenue);
  const prevTotal = prev ? total(prev.revenue) : null;
  if (curTotal === 0 && (prevTotal === null || prevTotal === 0)) return [];
  const out: Block[] = [heading("Revenue by channel")];
  const rows = cur.revenue
    .map((r) => ({ r, sum: Number(r.confirmed_php) + Number(r.unconfirmed_php) }))
    .filter((x) => x.sum > 0)
    .sort((a, b) => b.sum - a.sum || channelLabel(a.r.channel).localeCompare(channelLabel(b.r.channel)));
  const hasUnconfirmed = cur.revenue.some((r) => Number(r.unconfirmed_php) > 0);
  if (rows.length === 0) out.push(para(`No revenue by channel was recorded this ${unit}.`));
  else {
    out.push(
      table(
        hasUnconfirmed ? ["Channel", "Confirmed", "Unconfirmed"] : ["Channel", "Confirmed"],
        rows.map(({ r }) =>
          hasUnconfirmed
            ? [channelLabel(r.channel), formatPhp(Number(r.confirmed_php)), formatPhp(Number(r.unconfirmed_php))]
            : [channelLabel(r.channel), formatPhp(Number(r.confirmed_php))],
        ),
      ),
    );
  }
  out.push(
    para(
      `Total${hasUnconfirmed ? " (confirmed + unconfirmed)" : ""} ${formatPhp(curTotal)}` +
        (prevTotal === null ? " (no comparison)." : `, before ${formatPhp(prevTotal)} (${moneyDelta(curTotal, prevTotal)}).`),
    ),
  );
  return out;
}

function costBlocks(data: DigestData): Block[] {
  const unit = data.kind;
  const cur = costPerNewPatient(spendIn(data.spend, data.cur.period), data.cur.newByDay).filter((r) => r.days > 0);
  const out: Block[] = [heading("Cost per new patient")];
  if (cur.length === 0) {
    out.push(para(`No ad spend saved for this ${unit}.`));
    if (!data.spendEverSaved) out.push(fine("Ad spend is saved from Ad Performance → Save them to clinic records."));
    return out;
  }
  const before = data.prev
    ? new Map(costPerNewPatient(spendIn(data.spend, data.prev.period), data.prev.newByDay).map((r) => [r.platform, r]))
    : null;
  const cost = (r: { days: number; costPerNewPhp: number | null }) =>
    r.days === 0 ? "no spend saved" : r.costPerNewPhp === null ? "no new patients" : formatPhp(r.costPerNewPhp);
  out.push(
    table(
      data.prev ? ["Platform", "Spend", "New on spend days", "Cost per new", "Before"] : ["Platform", "Spend", "New on spend days", "Cost per new"],
      cur.map((r) => {
        const row = [r.label, formatPhp(r.spendPhp), n(r.newConfirmed + r.newUnconfirmed), cost(r)];
        if (data.prev) row.push(before!.get(r.platform) ? cost(before!.get(r.platform)!) : "no spend saved");
        return row;
      }),
    ),
  );
  return out;
}

/** "Patient sources, Wk of 28 Sep: 12 new (▲ 4)" — the change is left out when there is no comparison. */
export function digestSubject(data: DigestData): string {
  const label = bucketLabel(data.kind, data.cur.period.from);
  const now = newTotal(data.cur.summary);
  if (!data.prev) return `Patient sources, ${label}: ${n(now)} new`;
  const change = now - newTotal(data.prev.summary);
  return `Patient sources, ${label}: ${n(now)} new (${change > 0 ? "▲" : change < 0 ? "▼" : "="} ${n(Math.abs(change))})`;
}

export function renderPatientSourcesDigest(
  data: DigestData,
  opts: { appUrl: string },
): { subject: string; html: string; text: string } {
  const unit = data.kind;
  const { cur, prev } = data;
  const subject = digestSubject(data);
  const blocks: Block[] = [];

  blocks.push(
    para(
      `${manilaDate(cur.period.from)} to ${manilaDate(cur.period.to)}` +
        (prev ? `, compared with ${manilaDate(prev.period.from)} to ${manilaDate(prev.period.to)}.` : ". No comparison is available for this period."),
    ),
  );

  // Data health: the page's own banner condition and wording, the sheet dates under it.
  const banner = sheetBanner(cur.summary);
  if (banner) {
    blocks.push(para(banner));
    const dates = sheetDatesText(cur.summary).trim();
    if (dates) blocks.push(fine(dates));
  }

  // Headline.
  const newNow = newTotal(cur.summary);
  const newBefore = prev ? newTotal(prev.summary) : null;
  const newValue =
    newNow === 0 && (newBefore === null || newBefore === 0)
      ? `No new patients recorded this ${unit}`
      : `${n(newNow)} (${formatNewCounts(cur.summary.new_confirmed, cur.summary.new_unconfirmed)}) · ${deltaText(newNow, newBefore)}`;
  blocks.push(
    detail([
      { label: "New patients", value: newValue },
      { label: "Served", value: `${n(servedTotal(cur.summary))} · ${deltaText(servedTotal(cur.summary), prev ? servedTotal(prev.summary) : null)}` },
      {
        label: "Returning (first recorded)",
        value: `${n(cur.summary.returning_first_recorded)} · ${deltaText(cur.summary.returning_first_recorded, prev ? prev.summary.returning_first_recorded : null)}`,
      },
    ]),
  );

  if (prev) {
    const mover = biggestMover(channelDeltas(cur.newByDay, prev.newByDay));
    blocks.push(
      para(
        mover
          ? `Biggest mover: ${mover.label} ${mover.change > 0 ? "▲" : "▼"} ${n(Math.abs(mover.change))} (${n(mover.now)} now, ${n(mover.before)} before${
              mover.pct === null ? "" : `, ${mover.pct > 0 ? "+" : "-"}${Math.round(Math.abs(mover.pct) * 100)}%`
            }).`
          : "No channel moved by more than 2.",
      ),
    );
  }
  const sunday = sundayObservation(cur.servedByDay, prev ? prev.servedByDay : null, unit);
  if (sunday) blocks.push(para(sunday));

  // Weekly day row. Daily served counts are never summed into a total.
  if (data.kind === "week") {
    const days = Array.from({ length: 7 }, (_, i) => shiftISODate(cur.period.from, i));
    const newRow = days.map((d) => sumDay(cur.newByDay, d));
    const servedRow = days.map((d) => sumDay(cur.servedByDay, d));
    if ([...newRow, ...servedRow].some((v) => v > 0)) {
      blocks.push(heading("By day"));
      blocks.push(table(["", ...DAY_LABELS], [["New", ...newRow.map(n)], ["Served that day", ...servedRow.map(n)]]));
      blocks.push(fine("Daily served counts are not added up: the served total above counts a repeat visitor once."));
    }
  }

  // New by channel — every channel non-zero in either period, in channel-table order.
  const channels = channelTable(cur.newByDay, prev ? prev.newByDay : null).filter((r) => r.total > 0 || (r.previousTotal ?? 0) > 0);
  if (channels.length > 0) {
    blocks.push(heading("New patients by channel"));
    blocks.push(
      table(
        prev ? ["Channel", `This ${unit}`, "Before", "Change"] : ["Channel", `This ${unit}`],
        channels.map((r) =>
          prev ? [r.label, n(r.total), n(r.previousTotal ?? 0), signed(r.change ?? 0)] : [r.label, n(r.total)],
        ),
      ),
    );
  }

  blocks.push(...revenueBlocks(cur, prev, unit));

  // Top 5 referrers.
  blocks.push(heading("Top referring doctors"));
  const refs = cur.referrers
    .map((r) => ({ label: r.doctor_label, n: r.new_confirmed + r.new_unconfirmed }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, 5);
  blocks.push(refs.length > 0 ? table(["Doctor", "New"], refs.map((r) => [r.label, n(r.n)])) : para(`No referring doctor recorded this ${unit}.`));

  blocks.push(...costBlocks(data));

  // Footer: stamp, button, fine print.
  const url =
    `${opts.appUrl.replace(/\/$/, "")}/staff/marketing/patients` +
    `?from=${cur.period.from}&to=${cur.period.to}&grain=day&mode=new`;
  blocks.push(fine(asOfLabel(data.readAt)));
  blocks.push({ html: emailButton("Open Patient Sources", url), text: `Open Patient Sources: ${url}` });
  blocks.push(fine("Confirmed counts are patient records. Unconfirmed counts are names in the reception sheet not yet matched to a patient record."));
  blocks.push(fine("You get this as an admin; change it in Admin Tools › Email Alerts."));

  return {
    subject,
    html: renderEmailShell({ heading: `Patient sources: ${bucketLabel(unit, cur.period.from)}`, contentHtml: blocks.map((b) => b.html).join("") }),
    text: [subject, ...blocks.map((b) => b.text)].join("\n\n"),
  };
}

export type DigestParams = { ok: true; periodFrom: string | null; includeUnknown: boolean } | { ok: false; error: string };

/**
 * The cron routes' query string (CRON_SECRET callers only). `period_from` re-runs an
 * EARLIER period (Monday / 1st, finished, ≤ 62 days old); `include_unknown=1` — only
 * with `period_from`, after checking the Resend dashboard — re-sends rows left in
 * the `unknown` state. Nothing re-sends an unknown row automatically.
 */
export function parseDigestParams(search: URLSearchParams, kind: DigestKind, todayISO: string): DigestParams {
  const periodFrom = search.get("period_from");
  const includeUnknown = search.get("include_unknown") === "1";
  if (periodFrom === null) {
    return includeUnknown ? { ok: false, error: "include_unknown needs period_from." } : { ok: true, periodFrom: null, includeUnknown: false };
  }
  const problem = retryPeriodError(kind, periodFrom, todayISO);
  return problem ? { ok: false, error: problem } : { ok: true, periodFrom, includeUnknown };
}

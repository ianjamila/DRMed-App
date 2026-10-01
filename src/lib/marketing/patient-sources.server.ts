/**
 * Patient Sources — the ONE caller of the 0189 report RPCs. Every surface
 * (page, people list, dashboard tile, CSV routes) reads through these
 * loaders rather than calling `supabase.rpc(...)` directly, so the RPC
 * names appear only here (`patient-sources-surfaces.test.ts` pins that) and
 * paging past PostgREST's 1,000-row cap happens in exactly one place.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { PAGE_SIZE, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import {
  classifyReportError, parsePatientSourcesReport, type PatientSourcesReport,
  type Grain, type Mode, type OverlapRow, type PeopleRow, type ReferrerRow, type ReportResult,
  type RevenueRow, type SeriesRow, type SpendTotalRow, type SummaryRow, type AdSpendDbRow,
  trendWeeks, type Period,
} from "./patient-sources";

type Db = SupabaseClient<Database>;
type PgErr = { code?: string; message?: string } | null;

function fail(where: string, error: PgErr | unknown) {
  const out = classifyReportError(error);
  if (out.kind === "error") console.error(`[patient-sources] ${where} failed`, (error as PgErr)?.code ?? error);
  return out;
}

/** Pages a set-returning RPC with .range() (PostgREST caps a response at 1,000 rows) keeping the SQLSTATE. */
async function pageAll<T>(
  where: string,
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgErr }>,
  maxRows = REPORT_EXPORT_MAX_ROWS,
): Promise<ReportResult<{ rows: T[]; truncated: boolean }>> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) return fail(where, error);
    const page = data ?? [];
    rows.push(...page);
    if (rows.length > maxRows) return { ok: true, data: { rows: rows.slice(0, maxRows), truncated: true } };
    if (page.length < PAGE_SIZE) return { ok: true, data: { rows, truncated: false } };
  }
}

export async function loadPatientSourcesSummary(supabase: Db, from: string, to: string): Promise<ReportResult<SummaryRow>> {
  const { data, error } = await supabase.rpc("patient_sources_summary", { p_from: from, p_to: to }).single();
  if (error || !data) return fail("summary", error);
  return { ok: true, data: data as unknown as SummaryRow };
}

export interface ReportQuery {
  from: string;
  to: string;
  grain: Grain;
  mode: Mode;
  /** The comparison period, or null when there is none (e.g. it would start before Patient Sources' first date). */
  prev: { from: string; to: string } | null;
}

/**
 * Every section of the Patient Sources page from ONE call (0206): the database
 * builds the identity core once, and every card reads the same snapshot.
 * One jsonb value, so PostgREST's 1,000-row cap does not apply.
 */
export async function loadPatientSourcesReport(supabase: Db, q: ReportQuery): Promise<ReportResult<PatientSourcesReport>> {
  const { data, error } = await supabase.rpc("patient_sources_report", {
    p_from: q.from, p_to: q.to, p_grain: q.grain, p_mode: q.mode,
    // A deliberate SQL null ("no comparison"): CLI 2.118 types every SQL argument as non-null.
    p_prev_from: (q.prev?.from ?? null) as string, p_prev_to: (q.prev?.to ?? null) as string,
  });
  if (error) return fail("report", error);
  const report = parsePatientSourcesReport(data);
  if (!report) return fail("report (malformed reply)", { code: "XX000" });
  return { ok: true, data: report };
}

export function loadPatientSourcesSeries(supabase: Db, from: string, to: string, grain: Grain | "period", mode: Mode) {
  return pageAll<SeriesRow>("series", (a, b) =>
    supabase
      .rpc("patient_sources_series", { p_from: from, p_to: to, p_grain: grain, p_mode: mode })
      .order("bucket_start")
      .order("channel")
      .range(a, b) as unknown as PromiseLike<{ data: SeriesRow[] | null; error: PgErr }>,
  );
}

export async function loadNewPatientsToday(supabase: Db, todayISO: string): Promise<ReportResult<SeriesRow[]>> {
  const res = await loadPatientSourcesSeries(supabase, todayISO, todayISO, "day", "new");
  return res.ok ? { ok: true, data: res.data.rows } : res;
}

export interface PatientSourcesTrend {
  weeks: Period[];
  newByDay: SeriesRow[];
  spend: { ok: true; rows: SpendTotalRow[] } | { ok: false };
  /** ISO instant the report was read — the card's "as of" stamp. */
  readAt: string;
  todayISO: string;
}

/**
 * The admin dashboard trend card (spec §3.2): ONE report call over the 8
 * completed weeks through today (its `new_by_day` feeds the bars, "this week
 * so far" and today's tile), plus saved ad spend over the 8 weeks. An admin
 * session on the admin-only dashboard — never call this with the service key
 * (ad_spend_daily_totals refuses it; a refused call crashes prod's image).
 */
export async function loadPatientSourcesTrend(supabase: Db, todayISO: string): Promise<ReportResult<PatientSourcesTrend>> {
  const weeks = trendWeeks(todayISO, 8);
  const [report, spend] = await Promise.all([
    loadPatientSourcesReport(supabase, { from: weeks[0].from, to: todayISO, grain: "week", mode: "new", prev: null }),
    loadAdSpendTotals(supabase, weeks[0].from, weeks[weeks.length - 1].to),
  ]);
  if (!report.ok) return report;
  return {
    ok: true,
    data: {
      weeks,
      newByDay: report.data.new_by_day,
      spend: spend.ok ? { ok: true, rows: spend.data.rows } : { ok: false },
      readAt: new Date().toISOString(),
      todayISO,
    },
  };
}

export async function loadPatientSourcesRevenue(supabase: Db, from: string, to: string): Promise<ReportResult<RevenueRow[]>> {
  const { data, error } = await supabase.rpc("patient_sources_revenue", { p_from: from, p_to: to });
  if (error) return fail("revenue", error);
  return { ok: true, data: (data ?? []) as unknown as RevenueRow[] };
}

export function loadPatientSourcesOverlaps(supabase: Db, from: string, to: string) {
  return pageAll<OverlapRow>("overlaps", (a, b) =>
    supabase
      .rpc("patient_sources_overlaps", { p_from: from, p_to: to })
      .order("service_date")
      .order("drm_id")
      .range(a, b) as unknown as PromiseLike<{ data: OverlapRow[] | null; error: PgErr }>,
  );
}

export async function loadPatientSourcesReferrers(supabase: Db, from: string, to: string): Promise<ReportResult<ReferrerRow[]>> {
  const { data, error } = await supabase.rpc("patient_sources_referrers", { p_from: from, p_to: to, p_limit: 20 });
  if (error) return fail("referrers", error);
  return { ok: true, data: (data ?? []) as unknown as ReferrerRow[] };
}

export interface PeopleQuery {
  from: string;
  to: string;
  mode: "new" | "returning" | "served";
  channel: string | null;
}

export async function loadPeoplePage(
  supabase: Db, q: PeopleQuery, limit: number, offset: number,
): Promise<ReportResult<{ rows: PeopleRow[]; total: number }>> {
  const { data, error } = await supabase.rpc("patient_sources_people", {
    p_from: q.from, p_to: q.to, p_mode: q.mode, p_channel: q.channel as string, p_limit: limit, p_offset: offset,
  });
  if (error) return fail("people", error);
  const rows = (data ?? []) as unknown as PeopleRow[];
  if (rows.length > 0) return { ok: true, data: { rows, total: Number(rows[0].total_count) } };
  if (offset === 0) return { ok: true, data: { rows, total: 0 } };
  // Past the end (a bookmarked page after a merge/delete/restatement): the
  // window count only travels with rows, so ask for the first row to learn the
  // real total instead of reporting "0 of 0" (Codex plan review #11).
  const first = await loadPeoplePage(supabase, q, 1, 0);
  return first.ok ? { ok: true, data: { rows: [], total: first.data.total } } : first;
}

/** Every person for the CSV, 1,000 at a time via the function's own limit/offset (its order is total). */
export async function loadAllPeople(supabase: Db, q: PeopleQuery): Promise<ReportResult<{ rows: PeopleRow[]; truncated: boolean }>> {
  const rows: PeopleRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await loadPeoplePage(supabase, q, PAGE_SIZE, offset);
    if (!page.ok) return page;
    rows.push(...page.data.rows);
    if (rows.length >= REPORT_EXPORT_MAX_ROWS) {
      return { ok: true, data: { rows: rows.slice(0, REPORT_EXPORT_MAX_ROWS), truncated: page.data.total > REPORT_EXPORT_MAX_ROWS } };
    }
    if (page.data.rows.length < PAGE_SIZE) return { ok: true, data: { rows, truncated: false } };
  }
}

export function loadAdSpendTotals(supabase: Db, from: string, to: string) {
  return pageAll<SpendTotalRow>("ad spend", (a, b) =>
    supabase
      .rpc("ad_spend_daily_totals", { p_from: from, p_to: to })
      .order("spend_date")
      .order("platform")
      .range(a, b) as unknown as PromiseLike<{ data: SpendTotalRow[] | null; error: PgErr }>,
  );
}

/**
 * Every saved ad row in [from, to] (at most 400 days - the RPC refuses more), for the Ad Performance
 * screen. The RPC orders by its unique key (date, platform, campaign_key, ad_key), a TOTAL order, so
 * .range() paging past PostgREST's 1,000-row cap cannot drop or repeat a row; the caller must show
 * `truncated` in-band.
 */
export function loadAdSpendRows(supabase: Db, from: string, to: string) {
  return pageAll<AdSpendDbRow>("ad spend rows", (a, b) =>
    supabase
      .rpc("ad_spend_rows", { p_from: from, p_to: to })
      .order("spend_date")
      .order("platform")
      .order("campaign_key")
      .order("ad_key")
      .range(a, b) as unknown as PromiseLike<{ data: AdSpendDbRow[] | null; error: PgErr }>,
  );
}

export interface SpendCoverageRow { platform: "meta" | "google"; first_date: string; last_date: string; days: number; total_php: number }
export async function loadAdSpendCoverage(supabase: Db): Promise<ReportResult<SpendCoverageRow[]>> {
  const { data, error } = await supabase.rpc("ad_spend_coverage");
  if (error) return fail("ad spend coverage", error);
  return { ok: true, data: (data ?? []) as unknown as SpendCoverageRow[] };
}

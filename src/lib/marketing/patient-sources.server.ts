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
  classifyReportError,
  type Grain, type Mode, type OverlapRow, type PeopleRow, type ReferrerRow, type ReportResult,
  type RevenueRow, type SeriesRow, type SpendTotalRow, type SummaryRow,
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

export interface SpendCoverageRow { platform: "meta" | "google"; first_date: string; last_date: string; days: number; total_php: number }
export async function loadAdSpendCoverage(supabase: Db): Promise<ReportResult<SpendCoverageRow[]>> {
  const { data, error } = await supabase.rpc("ad_spend_coverage");
  if (error) return fail("ad spend coverage", error);
  return { ok: true, data: (data ?? []) as unknown as SpendCoverageRow[] };
}

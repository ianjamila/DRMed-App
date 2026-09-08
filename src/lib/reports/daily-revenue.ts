/**
 * Daily revenue by service — shared by the admin report page and its CSV.
 * Not `server-only`: takes a client so it works from an RSC and a Route
 * Handler alike (the archive-query pattern).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { fetchAllRows } from "./paging";

type AnyClient = SupabaseClient<Database>;

export interface DailyRevenueParams {
  from: string;
  to: string;
}

/** Month-to-date by default (what the page has always shown). Bad dates fall back rather than error. */
export function parseDailyRevenueParams(
  sp: { from?: string; to?: string },
  today: string = todayManilaISODate(),
): DailyRevenueParams {
  const monthStart = `${today.slice(0, 7)}-01`;
  return {
    from: isISODate(sp.from) ? sp.from : monthStart,
    to: isISODate(sp.to) ? sp.to : today,
  };
}

export interface DailyRevenueRow {
  business_date: string;
  service_code: string;
  service_name: string;
  service_kind: string;
  revenue_php: number | null;
  released_count: number | null;
}

export interface DailyRevenueReport {
  rows: DailyRevenueRow[];
  byDate: Map<string, DailyRevenueRow[]>;
  truncated: boolean;
}

export function groupByDate(rows: readonly DailyRevenueRow[]): Map<string, DailyRevenueRow[]> {
  const byDate = new Map<string, DailyRevenueRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.business_date) ?? [];
    list.push(r);
    byDate.set(r.business_date, list);
  }
  return byDate;
}

export async function loadDailyRevenue(
  client: AnyClient,
  params: DailyRevenueParams,
  maxRows: number,
): Promise<DailyRevenueReport> {
  // (business_date, service_code) is a total order — services.code is unique.
  const { rows, truncated } = await fetchAllRows<DailyRevenueRow>(
    (from, to) =>
      client
        .from("v_daily_revenue_by_service")
        .select("business_date, service_code, service_name, service_kind, revenue_php, released_count")
        .gte("business_date", params.from)
        .lte("business_date", params.to)
        .order("business_date", { ascending: false })
        .order("service_code", { ascending: true })
        .range(from, to)
        .returns<DailyRevenueRow[]>(),
    maxRows,
  );
  return { rows, byDate: groupByDate(rows), truncated };
}

export const DAILY_REVENUE_CSV_HEADER = [
  "Date",
  "Service code",
  "Service",
  "Kind",
  "Releases",
  "Revenue PHP",
] as const;

export function dailyRevenueCsvRows(rows: readonly DailyRevenueRow[]): unknown[][] {
  return [
    [...DAILY_REVENUE_CSV_HEADER],
    ...rows.map((r) => [
      r.business_date,
      r.service_code,
      r.service_name,
      r.service_kind,
      r.released_count ?? 0,
      Number(r.revenue_php ?? 0).toFixed(2),
    ]),
  ];
}

export function dailyRevenueCsvHref(p: DailyRevenueParams): string {
  return `/api/admin/reports/daily-revenue.csv?${new URLSearchParams({ from: p.from, to: p.to })}`;
}

export function dailyRevenueCsvFilename(p: DailyRevenueParams): string {
  return `daily-revenue-${p.from}_${p.to}.csv`;
}

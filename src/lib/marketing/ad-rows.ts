/**
 * Pure helpers for the Ad Performance screen's data: which saved days to load,
 * how a saved database row becomes a dashboard row, and how a browser's old
 * localStorage rows (key drmed_ad_data_v1) are turned back into an upload file.
 * No DB, no browser globals - unit-tested in ad-rows.test.ts.
 */
import { shiftISODate } from "@/lib/dates/manila";
import type { AdSpendDbRow } from "@/lib/marketing/patient-sources";

/** The dashboard's row shape (unchanged from the browser-only version). */
export interface AdRow {
  date: string;
  platform: string;
  campaign: string;
  ad: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  bookings: number;
}

/** The RPC refuses a period longer than this many days (start to end). */
export const AD_WINDOW_DAYS = 400;

export interface AdWindow {
  from: string;
  to: string;
  /** True when the saved spend reaches back further than the window, so the oldest days are not loaded. */
  cutOff: boolean;
  /** First / last saved day over both platforms (before any cut). */
  coverageFrom: string;
  coverageTo: string;
}

/** All saved coverage, or its latest 400 days. null = nothing is saved. */
export function adWindow(coverage: readonly { first_date: string; last_date: string }[]): AdWindow | null {
  if (coverage.length === 0) return null;
  const coverageFrom = coverage.reduce((m, c) => (c.first_date < m ? c.first_date : m), coverage[0]!.first_date);
  const coverageTo = coverage.reduce((m, c) => (c.last_date > m ? c.last_date : m), coverage[0]!.last_date);
  const earliest = shiftISODate(coverageTo, -AD_WINDOW_DAYS);
  const cutOff = coverageFrom < earliest;
  return { from: cutOff ? earliest : coverageFrom, to: coverageTo, cutOff, coverageFrom, coverageTo };
}

const PLATFORM_LABEL: Record<string, string> = { meta: "Meta", google: "Google" };

function adName(r: AdSpendDbRow): string {
  if (r.ad_key === "(campaign)") return "—";
  if (r.ad_label && r.ad_label.trim()) return r.ad_label.trim();
  return r.ad_key.startsWith("id:") ? `Ad ${r.ad_key.slice(3)}` : r.ad_key;
}

/**
 * Saved rows -> dashboard rows. A campaign shows under ONE name (its most
 * recent saved label) even if the platform spelled it differently on other
 * days. Unknown (null) impressions / clicks / leads / bookings count as 0, the
 * same as the browser version did for a column the file did not have.
 */
export function savedRowsToAdRows(rows: readonly AdSpendDbRow[]): AdRow[] {
  const latestLabel = new Map<string, { date: string; label: string }>();
  for (const r of rows) {
    const k = `${r.platform}|${r.campaign_key}`;
    const prev = latestLabel.get(k);
    if (!prev || r.spend_date >= prev.date) latestLabel.set(k, { date: r.spend_date, label: r.campaign_label });
  }
  return rows.map((r) => ({
    date: r.spend_date,
    platform: PLATFORM_LABEL[r.platform] ?? r.platform,
    campaign: latestLabel.get(`${r.platform}|${r.campaign_key}`)?.label || r.campaign_key,
    ad: adName(r),
    spend: Number(r.spend_php),
    impressions: r.impressions ?? 0,
    clicks: r.clicks ?? 0,
    leads: r.leads ?? 0,
    bookings: r.platform_bookings ?? 0,
  }));
}

/** True when some saved rows carry no leads or bookings figure (the uploaded file had no such column or cell). */
export function hasUnknownFunnel(rows: readonly AdSpendDbRow[]): boolean {
  return rows.some((r) => r.leads === null || r.platform_bookings === null);
}

/* ---------------- one-time move of a browser's old rows ---------------- */

export const LEGACY_STORE_KEY = "drmed_ad_data_v1";

export function isAdRow(v: unknown): v is AdRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.date === "string" &&
    typeof r.platform === "string" &&
    typeof r.campaign === "string" &&
    typeof r.ad === "string" &&
    typeof r.spend === "number" &&
    typeof r.impressions === "number" &&
    typeof r.clicks === "number" &&
    typeof r.leads === "number" &&
    typeof r.bookings === "number"
  );
}

/** Rows an old browser session stored; [] when there are none, they are corrupt, or storage is blocked. */
export function readLegacyRows(): AdRow[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(LEGACY_STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAdRow) : [];
  } catch {
    return [];
  }
}

/** Removes the old rows. Returns false when storage refused (blocked), so the caller can say so. */
export function clearLegacyRows(): boolean {
  try {
    window.localStorage.removeItem(LEGACY_STORE_KEY);
    return true;
  } catch {
    return false;
  }
}

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const NO_AD = new Set(["", "—", "-"]);

export interface LegacyCsv {
  csv: string;
  /** Rows written to the file. */
  rows: number;
  /** Rows left out because their platform is neither Meta nor Google (the server refuses such a file). */
  skippedOtherPlatform: number;
}

/**
 * The old rows as a file in the Ad Performance template's shape, ready for
 * saveAdSpendAction (which re-parses it on the server like any upload). A
 * campaign-day whose rows have no ad name is saved as a campaign total; if only
 * some rows lack one they are called "Unnamed ad", so one campaign-day never
 * mixes a total with per-ad rows (the server refuses that mix).
 */
export function legacyRowsToCsv(rows: readonly AdRow[]): LegacyCsv {
  const usable = rows.filter((r) => r.platform === "Meta" || r.platform === "Google");
  const namedGroups = new Set<string>();
  for (const r of usable) {
    if (!NO_AD.has(r.ad.trim())) namedGroups.add(JSON.stringify([r.date, r.platform, r.campaign]));
  }
  const lines = ["platform,date,campaign,ad,spend,impressions,clicks,leads,bookings"];
  for (const r of usable) {
    const named = namedGroups.has(JSON.stringify([r.date, r.platform, r.campaign]));
    const ad = NO_AD.has(r.ad.trim()) ? (named ? "Unnamed ad" : "") : r.ad.trim();
    lines.push(
      [r.platform, r.date, r.campaign, ad, r.spend, r.impressions, r.clicks, r.leads, r.bookings].map(csvCell).join(","),
    );
  }
  return { csv: lines.join("\n") + "\n", rows: usable.length, skippedOtherPlatform: rows.length - usable.length };
}

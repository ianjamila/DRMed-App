/**
 * Ad spend CSV → rows for ad_spend_import (spec §2.2; plan P14). Pure, so the
 * server action and the tests share it. The server re-parses the raw file —
 * rows computed in the browser are never trusted.
 *
 * Contract: DAILY rows only (a date range with different ends is rejected, never
 * collapsed to its first day); Meta or Google must be recognisable, else the
 * whole file is refused; a currency that is present and not PHP refuses the
 * file; duplicates of (date, platform, campaign, ad) are summed.
 */
import { daysInMonth } from "@/lib/dates/manila";
import { normaliseCampaignName } from "@/lib/marketing/campaign-results";

export type AdPlatform = "meta" | "google";
export type AdSpendRejectReason = "date_range" | "bad_date" | "no_campaign" | "bad_spend";

export const REJECT_REASON_LABEL: Record<AdSpendRejectReason, string> = {
  date_range: "covers more than one day — export with a 1-day breakdown",
  bad_date: "date not readable",
  no_campaign: "no campaign name",
  bad_spend: "spend missing or not a number of zero or more",
};

export interface AdSpendRow {
  spend_date: string;
  platform: AdPlatform;
  campaign_key: string;
  ad_key: string;
  campaign_label: string;
  spend_php: number;
  impressions: number | null;
  clicks: number | null;
}

export type AdSpendParse =
  | { ok: true; rows: AdSpendRow[]; rejected: { reason: AdSpendRejectReason; count: number }[]; currencyAssumed: boolean }
  | { ok: false; error: string };

export type AdSpendSaveResult =
  | { ok: true; data: { inserted: number; replaced: number; days: number; currencyAssumed: boolean; rejected: { reason: string; count: number }[] } }
  | { ok: false; error: string };

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number) => String(n).padStart(2, "0");
/** "Sep", "Sept", "September" → 9; anything else → null. */
const monthOf = (name: string): number | null =>
  MONTH_INDEX[name.slice(0, 4).toLowerCase()] ?? MONTH_INDEX[name.slice(0, 3).toLowerCase()] ?? null;

function isoOf(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parseOneDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
  if (m) {
    // Month first unless the first number cannot be a month — same rule as the
    // in-browser Ad Performance view (plan P14).
    let month = +m[1];
    let day = +m[2];
    if (month > 12) [month, day] = [day, month];
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return isoOf(year, month, day);
  }
  m = t.match(/^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/); // "Sep 1, 2026" / "Mon, Sep 1, 2026"
  if (m) {
    const mon = monthOf(m[1]);
    if (mon) return isoOf(+m[3], mon, +m[2]);
  }
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/); // "1 September 2026"
  if (m) {
    const mon = monthOf(m[2]);
    if (mon) return isoOf(+m[3], mon, +m[1]);
  }
  return null;
}

export function parseDateCell(raw: string): { ok: true; date: string } | { ok: false; reason: "date_range" | "bad_date" } {
  const s = String(raw ?? "").trim();
  const range = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (range) {
    const a = parseOneDate(range[1]);
    const b = parseOneDate(range[2]);
    if (!a || !b) return { ok: false, reason: "bad_date" };
    return a === b ? { ok: true, date: a } : { ok: false, reason: "date_range" };
  }
  const d = parseOneDate(s);
  return d ? { ok: true, date: d } : { ok: false, reason: "bad_date" };
}

/** Text from the real header row on: drops a BOM and any title lines above it (Google exports). */
export function locateHeader(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const i = lines.findIndex((l) => /campaign/i.test(l) && /(^|,|")\s*(day|date|reporting starts)\s*("|,|$)/i.test(l));
  return (i > 0 ? lines.slice(i) : lines).join("\n");
}

const h = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Blank → null (missing, rejected); "0" → 0 (a real zero, kept — P14). */
function money(v: string | undefined): number | null {
  const s = String(v ?? "").replace(/[₱,\s]|php/gi, "");
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
function count(v: string | undefined): number | null {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

export function parseAdSpendCsv(records: readonly Record<string, string>[], headers: readonly string[]): AdSpendParse {
  const byNorm = new Map(headers.map((x) => [h(x), x]));
  const col = (...names: string[]) => names.map((n) => byNorm.get(n)).find((x) => x !== undefined);
  const colStarts = (prefix: string) => headers.find((x) => h(x).startsWith(prefix));

  const platformCol = col("platform", "source", "network");
  const metaSpendCol = colStarts("amount spent");
  const isMeta = !platformCol && (metaSpendCol !== undefined || col("reporting starts") !== undefined);
  const isGoogle = !platformCol && !isMeta && col("cost") !== undefined && col("campaign") !== undefined;
  if (!platformCol && !isMeta && !isGoogle) {
    return { ok: false, error: "This file is not a Meta or Google Ads export, and it has no Platform column." };
  }

  // Currency (P14): a present, non-PHP currency refuses the whole file.
  const headerCurrency = metaSpendCol?.match(/\(([A-Za-z]{3})\)/)?.[1]?.toUpperCase() ?? null;
  if (headerCurrency && headerCurrency !== "PHP") {
    return { ok: false, error: `This export is in ${headerCurrency}. Export it in PHP.` };
  }
  const currencyCol = col("currency code", "currency");
  if (currencyCol) {
    const other = records.map((r) => String(r[currencyCol] ?? "").trim().toUpperCase()).find((c) => c !== "" && c !== "PHP");
    if (other) return { ok: false, error: `This export is in ${other}. Export it in PHP.` };
  }

  const dayCol = col("day", "date");
  const startCol = col("reporting starts");
  const endCol = col("reporting ends");
  const campaignCol = col("campaign name", "campaign");
  const adIdCol = col("ad id");
  const adNameCol = col("ad name", "ad");
  const spendCol = metaSpendCol ?? col("cost", "spend", "amount");
  const imprCol = col("impressions", "impr.", "impr");
  const clickCol = col("link clicks", "clicks");
  if (!spendCol) {
    return { ok: false, error: "This file has no spend column (Amount spent, Cost or Spend) — nothing was saved." };
  }

  const rejected = new Map<AdSpendRejectReason, number>();
  const reject = (r: AdSpendRejectReason) => rejected.set(r, (rejected.get(r) ?? 0) + 1);
  const rows = new Map<string, AdSpendRow>();

  for (const r of records) {
    const campaign = String((campaignCol && r[campaignCol]) ?? "").trim();
    if (/^total\b/i.test(campaign) || (dayCol && /^total\b/i.test(String(r[dayCol] ?? "").trim()))) continue;

    let platform: AdPlatform;
    if (platformCol) {
      const v = String(r[platformCol] ?? "");
      if (/face|meta|insta|\big\b/i.test(v)) platform = "meta";
      else if (/google|search|goog|adwords/i.test(v)) platform = "google";
      else {
        // Spec §2.2: an unrecognised platform refuses the whole file.
        return {
          ok: false,
          error: `A row's platform is "${v.trim() || "blank"}" — only Meta and Google spend can be saved. Remove the other rows and upload again.`,
        };
      }
    } else {
      platform = isMeta ? "meta" : "google";
    }

    let date: string;
    if (startCol && endCol && String(r[startCol] ?? "").trim() && String(r[endCol] ?? "").trim()) {
      const a = parseDateCell(r[startCol]);
      const b = parseDateCell(r[endCol]);
      if (!a.ok || !b.ok) { reject(!a.ok ? a.reason : (b as { reason: AdSpendRejectReason }).reason); continue; }
      if (a.date !== b.date) { reject("date_range"); continue; }
      date = a.date;
    } else {
      const d = parseDateCell(String((dayCol && r[dayCol]) ?? ""));
      if (!d.ok) { reject(d.reason); continue; }
      date = d.date;
    }

    if (!campaign) { reject("no_campaign"); continue; }
    const spend = money(r[spendCol]);
    if (spend === null || spend < 0) { reject("bad_spend"); continue; }
    const impressions = imprCol ? count(r[imprCol]) : null;
    const clicks = clickCol ? count(r[clickCol]) : null;

    const adId = adIdCol ? String(r[adIdCol] ?? "").trim() : "";
    const adName = adNameCol ? normaliseCampaignName(String(r[adNameCol] ?? "")) : "";
    const campaignKey = normaliseCampaignName(campaign);
    const adKey = adId ? `id:${adId}` : adName || "(campaign)";
    const key = `${date}|${platform}|${campaignKey}|${adKey}`;
    const prev = rows.get(key);
    if (prev) {
      prev.spend_php = Math.round((prev.spend_php + spend) * 100) / 100;
      prev.impressions = impressions === null && prev.impressions === null ? null : (prev.impressions ?? 0) + (impressions ?? 0);
      prev.clicks = clicks === null && prev.clicks === null ? null : (prev.clicks ?? 0) + (clicks ?? 0);
    } else {
      rows.set(key, {
        spend_date: date, platform, campaign_key: campaignKey.slice(0, 300), ad_key: adKey.slice(0, 300),
        campaign_label: campaign.slice(0, 300), spend_php: spend, impressions, clicks,
      });
    }
  }

  return {
    ok: true,
    rows: [...rows.values()],
    rejected: [...rejected.entries()].map(([reason, n]) => ({ reason, count: n })),
    currencyAssumed: !headerCurrency && !currencyCol,
  };
}

export function describeAdSpendSave(res: AdSpendSaveResult): string {
  if (!res.ok) return `Not saved to clinic records: ${res.error}`;
  const rejectedTotal = res.data.rejected.reduce((s, r) => s + r.count, 0);
  const detail = rejectedTotal > 0 ? ` (${res.data.rejected.map((r) => `${r.count} ${r.reason}`).join("; ")})` : "";
  const days = `${res.data.days} day${res.data.days === 1 ? "" : "s"}`;
  const rows = `${rejectedTotal} row${rejectedTotal === 1 ? "" : "s"} rejected`;
  return `Saved to clinic records: ${days}, ${rows}${detail}.` +
    (res.data.currencyAssumed ? " No currency column — pesos assumed." : "");
}

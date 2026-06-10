// Pure cumulative AR roll-forward helpers for the B1.4 HMO AR subledger report.
// NO "server-only" import — unit-tested with vitest.

import { enumerateDays, num } from "./daily-report";

export interface HmoArRow {
  business_date: string | null;
  provider_name: string | null;
  source: string | null;
  billed_in_php: number | string | null;
  paid_out_php: number | string | null;
}

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface HmoArCell {
  billedIn: number;
  paidOut: number;
  ending: number; // cumulative through end of this day
}

export interface HmoArProviderRow {
  provider: string;
  byDay: Record<string, HmoArCell>; // keyed on range days only
  rangeBilledIn: number;
  rangePaidOut: number;
  endingBalance: number; // cumulative all-time through range.to
}

export interface HmoArMatrix {
  days: string[]; // range days
  providers: HmoArProviderRow[]; // sorted by endingBalance desc; (unknown HMO) last
  total: HmoArProviderRow; // provider = "TOTAL"
}

const UNKNOWN = "(unknown HMO)";

interface Move {
  billedIn: number;
  paidOut: number;
}

/** Per-provider cumulative AR roll-forward. `rows` MUST already be bounded to
 *  business_date <= range.to (the page fetches with only an upper bound so the
 *  opening balance is correct); we defensively ignore later dates anyway. */
export function buildHmoArMatrix(rows: HmoArRow[], range: DateRange): HmoArMatrix {
  const days = enumerateDays(range.from, range.to);
  const rangeSet = new Set(days);

  // provider -> (dateISO -> {billedIn, paidOut})
  const byProvider = new Map<string, Map<string, Move>>();
  for (const r of rows) {
    const date = r.business_date ?? "";
    if (!date || date > range.to) continue; // defensive: only movement through `to`
    const provider = r.provider_name ?? UNKNOWN;
    if (!byProvider.has(provider)) byProvider.set(provider, new Map());
    const m = byProvider.get(provider)!;
    const prev = m.get(date) ?? { billedIn: 0, paidOut: 0 };
    prev.billedIn += num(r.billed_in_php);
    prev.paidOut += num(r.paid_out_php);
    m.set(date, prev);
  }

  const providers: HmoArProviderRow[] = [];
  for (const [provider, moves] of byProvider) {
    const byDay: Record<string, HmoArCell> = {};
    for (const d of days) byDay[d] = { billedIn: 0, paidOut: 0, ending: 0 };

    // Walk every date with movement plus every range day, ascending, carrying cum.
    const allDates = Array.from(new Set([...moves.keys(), ...days])).sort();
    let cum = 0;
    let rangeBilledIn = 0;
    let rangePaidOut = 0;
    for (const d of allDates) {
      if (d > range.to) continue;
      const mv = moves.get(d) ?? { billedIn: 0, paidOut: 0 };
      cum += mv.billedIn - mv.paidOut;
      if (rangeSet.has(d)) {
        byDay[d] = { billedIn: mv.billedIn, paidOut: mv.paidOut, ending: cum };
        rangeBilledIn += mv.billedIn;
        rangePaidOut += mv.paidOut;
      }
    }
    providers.push({ provider, byDay, rangeBilledIn, rangePaidOut, endingBalance: cum });
  }

  // Sort by ending desc, (unknown HMO) forced last.
  providers.sort((a, b) => {
    if (a.provider === UNKNOWN) return 1;
    if (b.provider === UNKNOWN) return -1;
    return b.endingBalance - a.endingBalance;
  });

  // TOTAL row = Σ providers per range day + overall.
  const totalByDay: Record<string, HmoArCell> = {};
  for (const d of days) totalByDay[d] = { billedIn: 0, paidOut: 0, ending: 0 };
  let tBilled = 0;
  let tPaid = 0;
  let tEnding = 0;
  for (const p of providers) {
    for (const d of days) {
      totalByDay[d].billedIn += p.byDay[d].billedIn;
      totalByDay[d].paidOut += p.byDay[d].paidOut;
      totalByDay[d].ending += p.byDay[d].ending;
    }
    tBilled += p.rangeBilledIn;
    tPaid += p.rangePaidOut;
    tEnding += p.endingBalance;
  }

  return {
    days,
    providers,
    total: {
      provider: "TOTAL",
      byDay: totalByDay,
      rangeBilledIn: tBilled,
      rangePaidOut: tPaid,
      endingBalance: tEnding,
    },
  };
}

// ---------------------------------------------------------------------------
// Task 5: summarizeAging — pivot the aging view
// ---------------------------------------------------------------------------

export const AGING_BUCKETS = ["0-30", "31-60", "61-90", "91-180", "180+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgingRow {
  provider_name: string | null;
  bucket: string | null;
  total_php: number | string | null;
  item_count: number | string | null;
}

export interface AgingProviderRow {
  provider: string;
  buckets: Record<string, number>; // one entry per AGING_BUCKETS
  total: number;
}

export interface AgingSummary {
  providers: AgingProviderRow[]; // sorted by total desc
  grandByBucket: Record<string, number>;
  grandTotal: number;
}

export function summarizeAging(rows: AgingRow[]): AgingSummary {
  const byProvider = new Map<string, AgingProviderRow>();
  const grandByBucket: Record<string, number> = {};
  for (const b of AGING_BUCKETS) grandByBucket[b] = 0;
  let grandTotal = 0;

  for (const r of rows) {
    const provider = r.provider_name ?? UNKNOWN;
    const bucket = r.bucket ?? "";
    if (!(AGING_BUCKETS as readonly string[]).includes(bucket)) continue;
    const value = num(r.total_php);
    if (!byProvider.has(provider)) {
      const buckets: Record<string, number> = {};
      for (const b of AGING_BUCKETS) buckets[b] = 0;
      byProvider.set(provider, { provider, buckets, total: 0 });
    }
    const row = byProvider.get(provider)!;
    row.buckets[bucket] += value;
    row.total += value;
    grandByBucket[bucket] += value;
    grandTotal += value;
  }

  const providers = Array.from(byProvider.values()).sort((a, b) => b.total - a.total);
  return { providers, grandByBucket, grandTotal };
}

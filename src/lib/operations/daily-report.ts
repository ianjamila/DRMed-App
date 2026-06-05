// Pure pivot + formatting helpers for the Operations daily report (B1.1).
// NO "server-only" import — unit-tested with vitest and shared with the CSV route.

export type Section = "lab" | "consult";

// Raw channel keys as stored by v_ops_daily_channel: payments.method values,
// plus 'hmo' (visits.hmo_provider_id set) and a defensive 'unpaid'.
export type ChannelKey =
  | "cash" | "gcash" | "bpi" | "bank_transfer" | "card" | "hmo" | "unpaid";

// Display order in the matrix. 'unpaid' is intentionally excluded — it only
// renders if a non-zero unpaid row actually exists (see buildDailyMatrix).
export const CHANNEL_ORDER: ChannelKey[] = [
  "cash", "gcash", "bpi", "bank_transfer", "card", "hmo",
];

const CHANNEL_LABELS: Record<ChannelKey, string> = {
  cash: "Cash",
  gcash: "GCash",
  bpi: "BPI",
  bank_transfer: "BDO", // the manual sheet labels bank transfers "BDO"
  card: "Card pay",
  hmo: "HMO",
  unpaid: "Unpaid",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel as ChannelKey] ?? channel;
}

/** Coerce a Supabase numeric (often a string) / null / "" to a finite number. */
export function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Inclusive list of ISO (YYYY-MM-DD) dates from `from` to `to`; [] if to < from. */
export function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const start = Date.parse(from + "T00:00:00Z");
  const end = Date.parse(to + "T00:00:00Z");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return days;
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export interface ChannelRow {
  business_date: string;
  section: Section;
  channel: string;
  line_count: number | string;
  distinct_customers: number | string;
  sales_gross: number | string;
  discount: number | string;
  net: number | string;
}

export interface TotalsRow {
  business_date: string;
  section: Section;
  line_count: number | string;
  distinct_customers: number | string;
  sales_gross: number | string;
  discount: number | string;
  net: number | string;
  pf_collected: number | string;
}

export type MetricKind = "customers" | "count" | "sales" | "discount" | "net" | "pf";

export interface MatrixRow {
  label: string;
  metric: MetricKind;
  channel?: ChannelKey;
  byDay: Record<string, number>;
  total: number;
}

export interface MatrixSection {
  section: Section;
  title: string;
  rows: MatrixRow[];
}

export interface DailyMatrix {
  days: string[];
  sections: MatrixSection[];
  totals: { revenue: MatrixRow; discount: MatrixRow; net: MatrixRow };
}

const SECTION_TITLE: Record<Section, string> = {
  lab: "Lab tests",
  consult: "Doctor consult",
};

const COUNT_LABEL: Record<Section, string> = {
  lab: "# tests",
  consult: "# consults",
};

function emptyRow(label: string, metric: MetricKind, days: string[], channel?: ChannelKey): MatrixRow {
  const byDay: Record<string, number> = {};
  for (const d of days) byDay[d] = 0;
  return { label, metric, channel, byDay, total: 0 };
}

function addTo(row: MatrixRow, day: string, value: number): void {
  if (!(day in row.byDay)) return;
  row.byDay[day] += value;
  row.total += value;
}

export function buildDailyMatrix(
  channelRows: ChannelRow[],
  totalsRows: TotalsRow[],
  days: string[],
): DailyMatrix {
  const daySet = new Set(days);
  const sections: MatrixSection[] = [];

  const liveChannels: Record<Section, Set<ChannelKey>> = {
    lab: new Set(),
    consult: new Set(),
  };
  for (const r of channelRows) {
    if (!daySet.has(r.business_date)) continue;
    const ch = r.channel as ChannelKey;
    if (CHANNEL_ORDER.includes(ch) && (num(r.sales_gross) !== 0 || num(r.discount) !== 0)) {
      liveChannels[r.section].add(ch);
    }
    if (ch === "unpaid" && (num(r.sales_gross) !== 0 || num(r.discount) !== 0)) {
      liveChannels[r.section].add("unpaid" as ChannelKey);
    }
  }

  for (const section of ["lab", "consult"] as Section[]) {
    const channelsForSection = [...CHANNEL_ORDER, "unpaid" as ChannelKey].filter((c) =>
      liveChannels[section].has(c),
    );

    const customers = emptyRow("Distinct customers", "customers", days);
    const count = emptyRow(COUNT_LABEL[section], "count", days);
    const salesByChannel = new Map<ChannelKey, MatrixRow>();
    const discByChannel = new Map<ChannelKey, MatrixRow>();
    for (const c of channelsForSection) {
      salesByChannel.set(c, emptyRow(`Sales — ${channelLabel(c)}`, "sales", days, c));
      discByChannel.set(c, emptyRow(`Discounts — ${channelLabel(c)}`, "discount", days, c));
    }
    const salesTotal = emptyRow("Sales — total", "sales", days);
    const discTotal = emptyRow("Discounts — total", "discount", days);
    const net = emptyRow("Gross profit", "net", days);
    const pf = section === "consult" ? emptyRow("PF collected", "pf", days) : null;

    for (const r of channelRows) {
      if (r.section !== section || !daySet.has(r.business_date)) continue;
      const ch = r.channel as ChannelKey;
      const sRow = salesByChannel.get(ch);
      const dRow = discByChannel.get(ch);
      if (sRow) addTo(sRow, r.business_date, num(r.sales_gross));
      if (dRow) addTo(dRow, r.business_date, num(r.discount));
    }

    for (const r of totalsRows) {
      if (r.section !== section || !daySet.has(r.business_date)) continue;
      addTo(customers, r.business_date, num(r.distinct_customers));
      addTo(count, r.business_date, num(r.line_count));
      addTo(salesTotal, r.business_date, num(r.sales_gross));
      addTo(discTotal, r.business_date, num(r.discount));
      addTo(net, r.business_date, num(r.net));
      if (pf) addTo(pf, r.business_date, num(r.pf_collected));
    }

    const rows: MatrixRow[] = [
      customers,
      count,
      ...channelsForSection.map((c) => salesByChannel.get(c)!),
      salesTotal,
      ...channelsForSection.map((c) => discByChannel.get(c)!),
      discTotal,
      net,
    ];
    if (pf) rows.push(pf);

    sections.push({ section, title: SECTION_TITLE[section], rows });
  }

  const revenue = emptyRow("Total revenue (lab + consult)", "sales", days);
  const discount = emptyRow("Total discounts (lab + consult)", "discount", days);
  const net = emptyRow("Gross profit (lab + consult)", "net", days);
  for (const r of totalsRows) {
    if (!daySet.has(r.business_date)) continue;
    addTo(revenue, r.business_date, num(r.sales_gross));
    addTo(discount, r.business_date, num(r.discount));
    addTo(net, r.business_date, num(r.net));
  }

  return { days, sections, totals: { revenue, discount, net } };
}

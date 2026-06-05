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

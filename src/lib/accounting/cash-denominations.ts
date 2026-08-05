/**
 * Philippine cash denominations for the end-of-day till count.
 *
 * NO "server-only" import — vitest-tested, shared by the EOD client component,
 * the close Server Action, the admin operations cash report, and the printable
 * count sheet.
 *
 * MIRROR OF THE SQL TABLE in `supabase/migrations/0132_eod_denomination_count.sql`
 * (`public.cash_denomination_total_php` + the P0048 guard's slug whitelist).
 * Both copies must list the same 11 slugs with the same peso values — the
 * local-stack parity test in that migration's test notes asserts it. If you add
 * or remove a denomination here, change the migration in the same PR.
 *
 * The ₱20 bill and the ₱20 coin are DELIBERATELY separate rows: they are two
 * physical piles on the counting table, and reception counts them separately.
 * That is what the `bill_` / `coin_` key prefix buys us.
 *
 * 5- and 1-sentimo coins are omitted — out of practical circulation.
 */

export interface CashDenomination {
  key: DenominationKey;
  /** Face value in pesos. */
  value_php: number;
  form: "bill" | "coin";
  /** Short label for grids that already group by Bills / Coins. */
  label: string;
  /**
   * Form-explicit label for anywhere the Bills/Coins grouping isn't visible
   * (summary strings, CSV rows). Without it "₱20" is ambiguous — the ₱20 bill
   * and the ₱20 coin are separate rows.
   */
  full_label: string;
}

export const DENOMINATION_KEYS = [
  "bill_1000",
  "bill_500",
  "bill_200",
  "bill_100",
  "bill_50",
  "bill_20",
  "coin_20",
  "coin_10",
  "coin_5",
  "coin_1",
  "coin_0.25",
] as const;

export type DenominationKey = (typeof DENOMINATION_KEYS)[number];

/** Bills descending, then coins descending — the order the piles are laid out. */
export const CASH_DENOMINATIONS: readonly CashDenomination[] = [
  { key: "bill_1000", value_php: 1000, form: "bill", label: "₱1,000", full_label: "₱1,000 bills" },
  { key: "bill_500", value_php: 500, form: "bill", label: "₱500", full_label: "₱500 bills" },
  { key: "bill_200", value_php: 200, form: "bill", label: "₱200", full_label: "₱200 bills" },
  { key: "bill_100", value_php: 100, form: "bill", label: "₱100", full_label: "₱100 bills" },
  { key: "bill_50", value_php: 50, form: "bill", label: "₱50", full_label: "₱50 bills" },
  { key: "bill_20", value_php: 20, form: "bill", label: "₱20", full_label: "₱20 bills" },
  { key: "coin_20", value_php: 20, form: "coin", label: "₱20", full_label: "₱20 coins" },
  { key: "coin_10", value_php: 10, form: "coin", label: "₱10", full_label: "₱10 coins" },
  { key: "coin_5", value_php: 5, form: "coin", label: "₱5", full_label: "₱5 coins" },
  { key: "coin_1", value_php: 1, form: "coin", label: "₱1", full_label: "₱1 coins" },
  { key: "coin_0.25", value_php: 0.25, form: "coin", label: "25¢", full_label: "25¢ coins" },
] as const;

export const BILL_DENOMINATIONS = CASH_DENOMINATIONS.filter((d) => d.form === "bill");
export const COIN_DENOMINATIONS = CASH_DENOMINATIONS.filter((d) => d.form === "coin");

/** Piece counts keyed by denomination slug. Missing key === zero pieces. */
export type DenominationCounts = Partial<Record<DenominationKey, number>>;

const VALUE_CENTAVOS: Record<DenominationKey, number> = Object.fromEntries(
  CASH_DENOMINATIONS.map((d) => [d.key, Math.round(d.value_php * 100)]),
) as Record<DenominationKey, number>;

const KEY_SET: ReadonlySet<string> = new Set(DENOMINATION_KEYS);

/**
 * Peso total of a count.
 *
 * Sums in CENTAVOS with integer arithmetic and divides once at the end, so a
 * pile of ₱0.25 coins can't drift the way `n * 0.25` accumulated in floats
 * would. The SQL helper doesn't need this trick — `numeric` is already exact.
 */
export function denominationsTotal(counts: DenominationCounts): number {
  let centavos = 0;
  for (const key of DENOMINATION_KEYS) {
    const pieces = counts[key];
    if (!pieces) continue;
    centavos += Math.round(pieces) * VALUE_CENTAVOS[key];
  }
  return centavos / 100;
}

/** Key-wise sum of two counts — used to fold a day's multiple shift closes into one. */
export function mergeDenominations(
  a: DenominationCounts | null,
  b: DenominationCounts | null,
): DenominationCounts | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const out: DenominationCounts = {};
  for (const key of DENOMINATION_KEYS) {
    const sum = (a[key] ?? 0) + (b[key] ?? 0);
    if (sum !== 0) out[key] = sum;
  }
  return out;
}

/**
 * Validate a `counted_denominations` jsonb value coming back from the database.
 *
 * Returns null for anything that isn't a well-formed count — unknown keys,
 * non-integers, negatives, non-objects. Read surfaces then degrade to "not
 * recorded" instead of crashing. Defensive only: the P0048 guard makes
 * malformed rows unreachable through normal writes, and NULL is legal for
 * closes that predate the feature.
 */
export function parseDenominations(value: unknown): DenominationCounts | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;

  const out: DenominationCounts = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!KEY_SET.has(key)) return null;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
    if (raw !== 0) out[key as DenominationKey] = raw;
  }
  return out;
}

/**
 * Compact one-liner: "₱1,000 bills ×3 · ₱20 coins ×4 · 25¢ coins ×8".
 * Zero counts are skipped. Uses `full_label` because the sub-rows this feeds
 * carry no Bills/Coins grouping to disambiguate the two ₱20 piles.
 */
export function formatDenominationSummary(counts: DenominationCounts | null): string {
  if (!counts) return "";
  const parts: string[] = [];
  for (const d of CASH_DENOMINATIONS) {
    const pieces = counts[d.key];
    if (!pieces) continue;
    parts.push(`${d.full_label} ×${pieces}`);
  }
  return parts.join(" · ");
}

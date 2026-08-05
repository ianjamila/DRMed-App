/**
 * Trends across a range of end-of-day cash counts.
 *
 * NO "server-only" import — pure, vitest-covered, shared by the admin
 * operations cash page.
 *
 * WHAT THIS CAN AND CANNOT KNOW — read before extending.
 * -----------------------------------------------------
 * It is tempting to build "which pile is short most often". We CANNOT measure
 * that. A short/over is a single figure for the whole till; nothing in the
 * system records which denominations were *received* during the day (payments
 * store an amount, not a pile), so there is no expected-per-denomination
 * figure to diff the count against. Claiming "the ₱1,000 pile was short" would
 * be fabricated causation.
 *
 * What IS derivable is arithmetic, and it's the same reasoning a bookkeeper
 * does out loud: if the day is off by exactly ₱1,000, that is *consistent with*
 * one ₱1,000 note in the wrong place, and is not consistent with a miscount of
 * the ₱50 pile alone. So this module attributes each off day to the LARGEST
 * denomination value that divides the difference exactly — the tidiest
 * single-pile story — and says plainly when no whole pile explains it (which is
 * itself diagnostic: a centavo residue means a keying error, not a miscount).
 *
 * Everything here is phrased as "consistent with", never "was". Keep it that
 * way in the UI copy too.
 */
import {
  CASH_DENOMINATIONS,
  type DenominationCounts,
  type DenominationKey,
} from "./cash-denominations";

/** One day's close as this module needs it. */
export interface DailyCount {
  day: string;
  variance: number;
  /** Merged piece counts, or null when the close predates the count sheet. */
  denominations: DenominationCounts | null;
}

/** Distinct face values, descending. The two ₱20 piles collapse to one value. */
const DISTINCT_VALUES: number[] = [...new Set(CASH_DENOMINATIONS.map((d) => d.value_php))].sort(
  (a, b) => b - a,
);

const toCentavos = (php: number) => Math.round(php * 100);

/**
 * Label for a face value. ₱20 maps to two slugs (bill and coin), and this
 * module works in values, so it must say so rather than pick one arbitrarily.
 */
export function valueLabel(valuePhp: number): string {
  const forms = CASH_DENOMINATIONS.filter((d) => d.value_php === valuePhp);
  const short = forms[0]?.label ?? `₱${valuePhp}`;
  if (forms.length > 1) return `${short} bills or coins`;
  return forms[0]?.form === "coin" ? `${short} coins` : `${short} bills`;
}

export interface VarianceAttribution {
  day: string;
  variance: number;
  /** Largest face value dividing |variance| exactly; null when none does. */
  valuePhp: number | null;
  /** How many pieces of that value the difference works out to. */
  pieces: number;
  label: string;
}

/**
 * The tidiest single-pile explanation for one day's difference.
 *
 * Divisibility is tested in integer centavos — `61 % 0.25` in floating point
 * is not reliably zero, and this whole feature exists because ₱0.25 piles are
 * where float arithmetic goes wrong.
 */
export function attributeVariance(day: string, variance: number): VarianceAttribution {
  const abs = Math.abs(toCentavos(variance));
  if (abs === 0) {
    return { day, variance, valuePhp: null, pieces: 0, label: "Balanced" };
  }
  for (const value of DISTINCT_VALUES) {
    const unit = toCentavos(value);
    if (abs % unit === 0) {
      return {
        day,
        variance,
        valuePhp: value,
        pieces: abs / unit,
        label: valueLabel(value),
      };
    }
  }
  // Not a whole number of any pile — e.g. off by ₱0.10. Not a counting error.
  return { day, variance, valuePhp: null, pieces: 0, label: "No whole-pile explanation" };
}

export interface CompositionRow {
  key: DenominationKey;
  label: string;
  /** Days whose count recorded at least one piece of this denomination. */
  daysPresent: number;
  totalPieces: number;
  /** Mean pieces over the days it appeared — not over all days. */
  avgPieces: number;
}

export interface AttributionBucket {
  valuePhp: number | null;
  label: string;
  days: number;
  /** Signed peso sum of the differences in this bucket. */
  netPhp: number;
}

export interface DenominationTrend {
  /** Days in range that have a close at all. */
  closedDays: number;
  /** Of those, how many recorded a denomination breakdown. */
  countedDays: number;
  balancedDays: number;
  shortDays: number;
  overDays: number;
  netVariancePhp: number;
  composition: CompositionRow[];
  /** Off days grouped by their explanation, most frequent first. */
  buckets: AttributionBucket[];
  /** Per-day detail for the off days, most recent first. */
  offDays: VarianceAttribution[];
}

export function buildDenominationTrend(rows: DailyCount[]): DenominationTrend {
  const closedDays = rows.length;
  const countedDays = rows.filter((r) => r.denominations !== null).length;

  let balancedDays = 0;
  let shortDays = 0;
  let overDays = 0;
  let netVariancePhp = 0;
  const offDays: VarianceAttribution[] = [];

  for (const r of rows) {
    netVariancePhp += r.variance;
    if (r.variance === 0) {
      balancedDays++;
      continue;
    }
    if (r.variance < 0) shortDays++;
    else overDays++;
    offDays.push(attributeVariance(r.day, r.variance));
  }
  netVariancePhp = Math.round(netVariancePhp * 100) / 100;

  const composition: CompositionRow[] = CASH_DENOMINATIONS.map((d) => {
    let daysPresent = 0;
    let totalPieces = 0;
    for (const r of rows) {
      const pieces = r.denominations?.[d.key] ?? 0;
      if (pieces > 0) {
        daysPresent++;
        totalPieces += pieces;
      }
    }
    return {
      key: d.key,
      label: d.full_label,
      daysPresent,
      totalPieces,
      avgPieces: daysPresent === 0 ? 0 : Math.round((totalPieces / daysPresent) * 10) / 10,
    };
  });

  const byValue = new Map<string, AttributionBucket>();
  for (const a of offDays) {
    const mapKey = a.valuePhp === null ? "none" : String(a.valuePhp);
    const bucket = byValue.get(mapKey) ?? {
      valuePhp: a.valuePhp,
      label: a.label,
      days: 0,
      netPhp: 0,
    };
    bucket.days++;
    bucket.netPhp = Math.round((bucket.netPhp + a.variance) * 100) / 100;
    byValue.set(mapKey, bucket);
  }
  const buckets = [...byValue.values()].sort(
    // Most frequent first; ties broken by the bigger pile, which is the more
    // actionable one. The "no explanation" bucket sorts last within its count.
    (a, b) => b.days - a.days || (b.valuePhp ?? -1) - (a.valuePhp ?? -1),
  );

  return {
    closedDays,
    countedDays,
    balancedDays,
    shortDays,
    overDays,
    netVariancePhp,
    composition,
    buckets,
    offDays: [...offDays].sort((a, b) => b.day.localeCompare(a.day)),
  };
}

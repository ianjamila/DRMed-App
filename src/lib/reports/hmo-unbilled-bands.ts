/**
 * The three ways admin slices "unbilled HMO claims" (`v_hmo_unbilled`) —
 * shared by the admin dashboard's HMO unbilled card and the HMO claims
 * page's "All unbilled" tab so the age arithmetic can never drift between
 * the two surfaces.
 *
 * - "threshold" (default) — the view's own `past_threshold` column, which is
 *   `days_since_release > hmo_providers.unbilled_threshold_days` — a
 *   PER-PROVIDER cutoff (default 14 days), not a fixed number. This flags a
 *   claim the moment it's actually late for that specific HMO, instead of
 *   waiting for an arbitrary 90-day mark that misses routine billing.
 * - "90" — a fixed `days_since_release >= 90`, regardless of provider
 *   threshold. Kept for the aged-AR read the finance side still wants.
 * - "all" — every unbilled row, any age.
 *
 * `is_historic` rows (legacy claims that were never billed at all) count in
 * every band — they are still genuinely unbilled, just older than the
 * system that would otherwise be tracking them.
 *
 * `v_hmo_unbilled` is UTC-clocked (`current_date`, deliberately left that
 * way by migration 0141 — see its header comment) so `days_since_release`
 * and `past_threshold` are accurate at day granularity, not to the minute —
 * a row can land one bucket early/late right at the UTC day boundary, but
 * money never relocates to a different posting_date because of it.
 */
export type HmoUnbilledAgeBand = "threshold" | "90" | "all";

export const HMO_UNBILLED_AGE_BANDS: readonly HmoUnbilledAgeBand[] = [
  "threshold",
  "90",
  "all",
];

export const HMO_UNBILLED_AGE_BAND_LABELS: Record<HmoUnbilledAgeBand, string> = {
  threshold: "Past HMO deadline",
  "90": "90+ days",
  all: "All unbilled",
};

export const HMO_UNBILLED_AGE_BAND_SHORT_LABELS: Record<HmoUnbilledAgeBand, string> = {
  threshold: "Due",
  "90": "90+",
  all: "All",
};

export function isHmoUnbilledAgeBand(
  value: string | null | undefined,
): value is HmoUnbilledAgeBand {
  return value === "threshold" || value === "90" || value === "all";
}

interface UnbilledAgeFields {
  days_since_release: number | null;
  past_threshold: boolean | null;
}

export function matchesHmoUnbilledAgeBand(
  row: UnbilledAgeFields,
  band: HmoUnbilledAgeBand,
): boolean {
  switch (band) {
    case "all":
      return true;
    case "90":
      return Number(row.days_since_release ?? 0) >= 90;
    case "threshold":
      return Boolean(row.past_threshold);
  }
}

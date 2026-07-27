/**
 * Line-discount arithmetic for the admin-managed `discount_types` catalog —
 * the single source of truth shared by the new-visit form (live preview) and
 * the visit-create Server Action (authoritative recompute).
 *
 * Rules:
 *  - `percent` rows take percent% off the line base, rounded to centavos.
 *  - `fixed` rows take a flat peso amount, capped at the base.
 *  - `custom` rows read a counter-typed peso amount, capped at the base.
 *  - Statutory rows (Senior / PWD, RA 9994 / RA 10754) apply only to
 *    senior/PWD-eligible services — lab packages are already bundled at a
 *    discount and get 0. Non-statutory discounts ignore that flag.
 *
 * Pure module — no `server-only`, no DB — so it stays unit-testable and can
 * run in both client components and Server Actions.
 */

export interface DiscountTypeLite {
  code: string;
  label: string;
  kind: "percent" | "fixed" | "custom";
  percent: number | null;
  amount_php: number | null;
  is_statutory: boolean;
}

interface LineDiscountArgs {
  /** The selected discount type, or null for "No discount". */
  discountType: DiscountTypeLite | null;
  /** The line's base price the discount applies to. */
  base: number;
  /** Raw counter input for `custom` rows; parsed here, garbage → 0. */
  customRaw?: string;
  /** services.senior_pwd_eligible !== false. Gates statutory rows only. */
  seniorPwdEligible?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Peso discount for a line. Never negative, never more than the base. */
export function lineDiscount({
  discountType,
  base,
  customRaw = "",
  seniorPwdEligible = true,
}: LineDiscountArgs): number {
  if (!discountType) return 0;
  if (discountType.is_statutory && !seniorPwdEligible) return 0;

  let off = 0;
  if (discountType.kind === "percent" && discountType.percent != null) {
    off = round2(base * (discountType.percent / 100));
  } else if (discountType.kind === "fixed" && discountType.amount_php != null) {
    off = discountType.amount_php;
  } else if (discountType.kind === "custom") {
    const n = Number(customRaw);
    off = Number.isFinite(n) ? n : 0;
  }
  return Math.min(Math.max(0, off), Math.max(0, base));
}

/**
 * The discount options offered for a line: everything, minus statutory
 * (Senior / PWD) rows when the service is ineligible.
 */
export function discountOptionsFor<T extends { is_statutory: boolean }>(
  types: T[],
  seniorPwdEligible: boolean,
): T[] {
  return seniorPwdEligible ? types : types.filter((t) => !t.is_statutory);
}

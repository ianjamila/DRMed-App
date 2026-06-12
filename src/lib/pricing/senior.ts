/**
 * Senior / PWD pricing — the single source of truth shared by the quote
 * workbench, the new-visit form, and the visit-create Server Action.
 *
 * Rules (RA 9994 / RA 10754):
 *  - Eligible services get the lab's curated peso discount when set, otherwise
 *    the statutory 20% off the line's base price.
 *  - Ineligible services (e.g. lab packages — already bundled at a discount)
 *    get NO senior/PWD discount. Eligibility is the `senior_pwd_eligible`
 *    column on `services`, which defaults to true.
 *
 * Pure module — no `server-only`, no DB — so it stays unit-testable and can run
 * in both client components and Server Actions.
 */

/** Statutory senior-citizen / PWD discount rate when no peso amount is curated. */
export const SENIOR_PWD_RATE = 0.2;

/**
 * Eligibility with default-true semantics: a service is eligible unless the
 * flag is explicitly `false`. `null`/`undefined` (e.g. rows predating the
 * column, or a partial select) are treated as eligible.
 */
export function isSeniorPwdEligible(s: {
  senior_pwd_eligible?: boolean | null;
}): boolean {
  return s.senior_pwd_eligible !== false;
}

interface SeniorArgs {
  /** The line's base price (cash or HMO, post-consult-fee) the discount applies to. */
  base: number;
  /** Curated peso discount on the service, or null to use the statutory rate. */
  seniorDiscountPhp: number | null;
  /** Whether the service is senior/PWD eligible. */
  eligible: boolean;
}

/** Peso discount for a senior/PWD line. Always 0 for ineligible services. */
export function seniorPwdDiscount({
  base,
  seniorDiscountPhp,
  eligible,
}: SeniorArgs): number {
  if (!eligible) return 0;
  const off =
    seniorDiscountPhp != null
      ? seniorDiscountPhp
      : Math.round(base * SENIOR_PWD_RATE * 100) / 100;
  // Never negative, never more than the base.
  return Math.min(Math.max(0, off), base);
}

/**
 * Senior/PWD price for display. Returns `null` for ineligible services so the
 * caller can render "Not applicable" rather than a misleading number.
 */
export function seniorPwdPrice(args: SeniorArgs): number | null {
  if (!args.eligible) return null;
  return Math.max(0, args.base - seniorPwdDiscount(args));
}

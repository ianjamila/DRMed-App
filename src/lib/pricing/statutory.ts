/**
 * Statutory-discount detection for the receipt pages.
 *
 * The discount catalog (`discount_types`) is admin-managed, so "is this line
 * the Senior/PWD statutory discount" must be answered from the data flag
 * (`is_statutory`), never by string-matching the `senior_pwd_20` code —
 * that literal is a seed value, not a guarantee. Callers fetch the set of
 * statutory codes once per page render (there is currently exactly one,
 * `senior_pwd_20`, enforced as a singleton by migration 0128) and pass it in
 * here.
 *
 * Pure module — no `server-only`, no DB — so it stays unit-testable and can
 * run in both client components and Server Actions.
 */

/** True when `code` names one of the catalog's statutory discount rows. */
export function isStatutoryDiscountCode(
  code: string | null | undefined,
  statutoryCodes: ReadonlySet<string>,
): boolean {
  return code != null && statutoryCodes.has(code);
}

/**
 * True when any line in `lines` carries a statutory discount — the receipt
 * pages use this to decide whether to print the Senior/PWD ID block.
 */
export function hasStatutoryDiscountLine(
  lines: readonly { discountKind: string | null }[],
  statutoryCodes: ReadonlySet<string>,
): boolean {
  return lines.some((l) => isStatutoryDiscountCode(l.discountKind, statutoryCodes));
}

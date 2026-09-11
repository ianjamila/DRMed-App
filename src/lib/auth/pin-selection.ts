/**
 * N9 — which of a patient's `visit_pins` rows a portal login attempt should
 * be checked against.
 *
 * A repeat patient can legitimately hold more than one still-valid PIN at
 * once: every new visit mints a fresh PIN without expiring an earlier one
 * still inside its 60-day window
 * (`src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`), and re-issuing
 * a lost PIN (`src/lib/actions/visits/reissue-pin.ts`) rewrites a row's hash
 * in place without touching its `created_at`. `portal/login/actions.ts` used
 * to accept only the row with the newest `created_at` — so the PIN printed
 * on the receipt a patient is physically holding could stop being the one
 * login accepts, with no indication why. Login now checks the submitted PIN
 * against every unexpired, unlocked row instead of just the newest.
 *
 * Pure — no DB, no bcrypt. The caller already restricts the query to
 * unexpired rows (`expires_at > now`); this applies the per-row lockout gate
 * on top and orders deterministically for the caller's bcrypt comparisons.
 */

export interface VisitPinCandidate {
  id: string;
  visit_id: string;
  pin_hash: string;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
}

export interface PinSelection {
  /**
   * Unexpired rows that are NOT currently locked out, newest first. The
   * caller should bcrypt-compare the submitted PIN against every one of
   * these (stopping at the first match) rather than only the first.
   */
  active: VisitPinCandidate[];
  /**
   * True when the patient has at least one unexpired PIN but every one of
   * them is currently locked out — the caller should reject the attempt
   * without running any bcrypt comparison, exactly as the single-PIN gate
   * used to.
   */
  allLocked: boolean;
}

/** A row's lockout is still in effect at `nowMs`. */
function isLocked(row: Pick<VisitPinCandidate, "locked_until">, nowMs: number): boolean {
  const lockedUntilMs = row.locked_until ? new Date(row.locked_until).getTime() : 0;
  return lockedUntilMs > nowMs;
}

export function selectActivePins(
  rows: readonly VisitPinCandidate[],
  nowMs: number,
): PinSelection {
  const active = rows
    .filter((r) => !isLocked(r, nowMs))
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  return {
    active,
    allLocked: rows.length > 0 && active.length === 0,
  };
}

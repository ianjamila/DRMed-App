/**
 * Humanised labels for the doctor-PF subledger enums.
 *
 * Two audiences, two vocabularies (see CLAUDE.md "Plain language by audience"):
 *
 * - The bookkeeper screens (`pf-payouts/[id]`) keep the accounting term —
 *   "Cash — accrued at release" says *when* the liability was recognised,
 *   which is the whole point of the basis column there.
 * - The acknowledgment slip goes to the doctor, who only needs to know who
 *   ultimately paid for the visit, so it uses the short labels.
 *
 * Pure logic (no `server-only`, no DB) so both server and client components
 * can import it.
 */

/** How the payout left the clinic. `doctor_pf_disbursements.method`. */
export function formatPfMethod(method: string): string {
  switch (method) {
    case "cash":
      return "Cash";
    case "gcash":
      return "GCash";
    case "bank_transfer":
      return "Bank transfer";
    default:
      return method;
  }
}

/** Bookkeeper wording for `doctor_pf_entries.recognition_basis`. */
export function formatPfBasis(basis: string): string {
  switch (basis) {
    case "cash_at_release":
      return "Cash — accrued at release";
    case "hmo_at_settlement":
      return "HMO — accrued at settlement";
    case "clawback":
      return "Clawback";
    default:
      return basis;
  }
}

/** Doctor-facing wording for the same column — who paid, not when it accrued. */
export function pfBasisShortLabel(basis: string): string {
  switch (basis) {
    case "cash_at_release":
      return "Cash";
    case "hmo_at_settlement":
      return "Insurance";
    case "clawback":
      return "Adjustment";
    default:
      return basis;
  }
}

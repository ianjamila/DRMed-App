/**
 * Pure rules for tagging a "Send Out" expense with the partner lab it paid.
 *
 * No DB, no "server-only" — this half stays vitest-coverable and safe to
 * import from a client component (the cash-drawer payout modal reads
 * `SEND_OUT_ACCOUNT_CODE` to decide whether to show the lab picker). The
 * Supabase-backed halves (loading the active partner-lab list, verifying a
 * picked vendor server-side) live in `partner-labs.server.ts`.
 */

/** The petty-cash / expense category that means "paid a partner lab". */
export const SEND_OUT_CATEGORY = "Send Out" as const;

/** Chart-of-accounts code the Send Out category books to (see expense-mappings.ts). */
export const SEND_OUT_ACCOUNT_CODE = "6420" as const;

export function isSendOutCategory(category: string): boolean {
  return category === SEND_OUT_CATEGORY;
}

export interface PartnerLab {
  id: string;
  name: string;
}

/**
 * The "which lab?" rule, shared by every surface that can post a Send Out
 * expense (Petty Cash tab, Cash Drawer payout, Quick expense):
 *   - a Send Out expense MUST carry a lab
 *   - a lab can ONLY be carried by a Send Out expense
 *
 * Returns a user-facing error, or null when the pairing is valid.
 */
export function sendOutLabRule(
  isSendOut: boolean,
  vendorId: string | null | undefined,
): string | null {
  if (isSendOut && !vendorId) return "Pick which lab you paid.";
  if (!isSendOut && vendorId) return "A lab can only be picked for a Send Out expense.";
  return null;
}

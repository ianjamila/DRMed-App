import type { GiftCodeStatus } from "./labels";

export type GiftCodeRefundEligibility =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Whether an unredeemed gift-code SALE can be refunded from the counter
 * (refundGiftCodeSaleAction). Pure so both the reception-facing form (a
 * quick client-side hint before submitting) and the server action itself
 * (the authoritative check, against the row's status read at write time) can
 * share one set of messages instead of drifting.
 *
 * Only 'purchased' is refundable — the point of this whole flow is to undo a
 * mis-keyed SALE while the voucher is still sitting unused. 'redeemed' is a
 * different problem (the code has already been applied to a visit's
 * payment) with its own undo path; 'generated' has no sale to refund;
 * 'cancelled' is already a dead end via the admin path.
 */
export function giftCodeRefundEligibility(
  status: GiftCodeStatus,
): GiftCodeRefundEligibility {
  switch (status) {
    case "purchased":
      return { ok: true };
    case "generated":
      return {
        ok: false,
        error: "This code hasn't been sold yet — there's nothing to refund.",
      };
    case "redeemed":
      return {
        ok: false,
        error:
          "This code has already been redeemed and applied to a visit's payment. Void that payment instead — it puts the code back to Purchased, and you can refund the sale from here afterwards.",
      };
    case "cancelled":
      return {
        ok: false,
        error: "This code was already cancelled and can't be refunded.",
      };
  }
}

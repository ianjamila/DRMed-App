-- =============================================================================
-- 0142_gift_code_refund.sql
-- =============================================================================
-- Go-live gap: cash-drawer/actions.ts (0139/Finding 8) correctly refuses the
-- generic Void on a gift-code-sale drawer entry — it only reverses the cash,
-- never touches `gift_codes`, so voiding it would leave the code 'purchased'
-- and still spendable while the cash is gone. The ONLY remaining undo path
-- was Admin → Gift codes → Cancel, which sets status='cancelled' — a
-- PERMANENT terminal state (see 0013's `gift_codes_status_consistency`
-- check). So a plain mis-keyed sale (wrong buyer name, wrong tender, typo,
-- customer changed their mind) burned a printed voucher for good.
--
-- This adds a proper cancel-and-refund for an UNREDEEMED sale
-- (refundGiftCodeSaleAction, gift-codes/actions.ts), reachable by reception
-- as well as admin. It reverses the sale's accounting exactly the way
-- cancelGiftCodeAction already does (void the eod_cash_adjustments row for a
-- cash sale — its trigger posts the reversal JE automatically; reverse the
-- direct sale JE via reverseJournalEntryBySource for a non-cash sale) but
-- lands the code back at status='generated' instead of 'cancelled'.
--
-- Decision: a refunded code IS re-sellable. The voucher itself isn't
-- defective — reception mis-keyed a SALE, not the code — and the clinic has
-- already printed/minted it, so there is no reason to burn a good physical
-- voucher over a keying error. `status='generated'` already means "not yet
-- sold, not spendable" (sellGiftCodeAction only accepts 'generated'; the
-- redemption path only accepts 'purchased'), so returning to that state both
-- satisfies "cannot be spent" and makes the code available for the next sale
-- in the same motion — no new terminal status needed.
--
-- The purchase fields (purchased_at/by/contact/method/reference, sold_by)
-- get cleared by the app on refund, mirroring sellGiftCodeAction's own
-- undoSale() rollback, so a re-sold code doesn't show stale buyer info. What
-- WOULD be lost by that clearing — that this physical code was once sold and
-- refunded — is preserved here as its own fact, the same way `cancelled_at /
-- cancelled_by / cancellation_reason` already preserve the cancel fact
-- alongside (not instead of) the generated/purchased/redeemed timestamps.
-- =============================================================================

alter table public.gift_codes
  add column refunded_at   timestamptz,
  add column refunded_by   uuid references auth.users(id) on delete set null,
  add column refund_reason text;

-- Reason is required and recorded, like every other reversal in this app
-- (payments.void_reason, eod_cash_adjustments.void_reason,
-- gift_codes.cancellation_reason) — enforced here, not only in the Zod
-- schema, so the invariant holds for any future writer too. `refunded_by` is
-- deliberately NOT included (matching cancelled_by's precedent): it's an
-- `on delete set null` FK, so a deleted staff row would otherwise violate a
-- symmetric check through no fault of the data.
alter table public.gift_codes
  add constraint gift_codes_refund_consistency check (
    (refunded_at is null) = (refund_reason is null)
  );

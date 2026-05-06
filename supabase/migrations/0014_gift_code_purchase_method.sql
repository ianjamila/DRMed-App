-- =============================================================================
-- 0014_gift_code_purchase_method.sql
-- =============================================================================
-- Phase 11.3 follow-up: gift code sales aren't tied to a visit, but the
-- payments table requires visit_id. Capture purchase tender directly on
-- the gift_codes row instead and drop the unused purchase_payment_id FK
-- introduced in 0013. The redeemed_payment_id FK stays — redemption
-- always happens against a real visit, so it gets a real payment row.
-- =============================================================================

alter table public.gift_codes
  drop column purchase_payment_id;

alter table public.gift_codes
  add column purchase_method text
    check (purchase_method is null
      or purchase_method in ('cash', 'gcash', 'maya', 'card', 'bank_transfer')),
  add column purchase_reference_number text;

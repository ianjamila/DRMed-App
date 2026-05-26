-- =============================================================================
-- 0067_normalize_senior_discount.sql
-- =============================================================================
-- Data cleanup. The `services.senior_discount_php` column was populated with
-- the SENIOR PRICE (what a senior pays) for 169 services instead of the
-- intended SENIOR DISCOUNT AMOUNT (the value subtracted from base price). The
-- visit-form code reads this column as the discount amount when the patient
-- picks `discount_kind='senior_pwd_20'`, which caused every affected service
-- to be discounted at 80%-116% off list instead of the intended 20%.
--
-- Policy decision (2026-05-26): senior/PWD discount is a flat 20% off across
-- the entire catalog. No per-service customization. NULL the column so the
-- visit-form's existing `base * 0.20` fallback fires for every service.
--
-- The column is kept (not dropped) so future per-service overrides remain
-- possible without a schema change.
--
-- Affects: 169 services in production at apply time. Idempotent — on a fresh
-- clone or re-run, the WHERE clause matches no rows.
--
-- Historical impact: visits issued prior to this migration retain whatever
-- discount/final price was recorded in test_requests.final_price_php. This
-- migration does NOT retroactively rebill them. Reception should manually
-- review historical visits if a refund / rebill is warranted.
-- =============================================================================

update public.services
  set senior_discount_php = null
where senior_discount_php is not null;

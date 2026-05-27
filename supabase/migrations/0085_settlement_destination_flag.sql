-- =============================================================================
-- 0085_settlement_destination_flag.sql
-- =============================================================================
-- 12.B follow-up. Lets admins manage HMO settlement payment methods through
-- the existing Chart of Accounts UI (no code changes needed to add a new
-- method like "Maya wallet", a new bank, etc.).
--
-- A CoA account is a valid HMO-settlement destination if is_settlement_destination=true.
-- Seeds the obvious set (Cash on hand, BPI, BDO, GCash) so existing behavior
-- is preserved.
--
-- Also drops the paid_payment_method enum check on historic_hmo_claims; the
-- column now stores the CoA code as free text, matching the chosen account.
-- =============================================================================

alter table public.chart_of_accounts
  add column is_settlement_destination boolean not null default false;

comment on column public.chart_of_accounts.is_settlement_destination is
  '12.B: when true, this account appears in the Mark-as-paid payment method dropdown for HMO settlements (and similar AR collection flows).';

-- Seed: enable for the obvious cash/bank/wallet accounts.
update public.chart_of_accounts
   set is_settlement_destination = true
 where code in ('1010', '1020', '1021', '1030');

-- Relax the enum constraint on paid_payment_method; the column now stores
-- the CoA code that was selected, so an admin can add new methods without a
-- migration.
alter table public.historic_hmo_claims
  drop constraint if exists historic_hmo_claims_paid_payment_method_check;

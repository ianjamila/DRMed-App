-- =============================================================================
-- 0079_v_hmo_ar_aging_includes_historic.sql
-- =============================================================================
-- 12.B follow-up. The HMO aging view drives:
--   * /staff/admin/accounting/hmo-claims top-level "Aging matrix" tab
--   * /staff/admin/accounting/hmo-claims/[providerId] "Aging" tab
--
-- It already unions batched + unbatched live items. We extend it with a third
-- union arm: still-outstanding historic claims from historic_hmo_claims
-- (status in pending/overdue), aged from claim_date. Provider matching is by
-- lowercase name to hmo_providers.name.
-- =============================================================================

create or replace view public.v_hmo_ar_aging as
with unioned as (
  -- Batched but not fully resolved: age from test_request.released_at
  select
    b.provider_id,
    hp.name                                                       as provider_name,
    (i.billed_amount_php - i.paid_amount_php
       - i.patient_billed_amount_php - i.written_off_amount_php)  as unresolved_balance_php,
    (current_date - tr.released_at::date)                         as age_days
  from public.hmo_claim_items i
  join public.hmo_claim_batches b on b.id = i.batch_id
  join public.test_requests tr    on tr.id = i.test_request_id
  join public.hmo_providers hp    on hp.id = b.provider_id
  where b.voided_at is null
    and (i.billed_amount_php - i.paid_amount_php
         - i.patient_billed_amount_php - i.written_off_amount_php) > 0
    and tr.released_at is not null
  union all
  -- Unbatched: age from test_request.released_at
  select
    v.hmo_provider_id,
    hp.name,
    tr.hmo_approved_amount_php,
    (current_date - tr.released_at::date)
  from public.test_requests tr
  join public.visits v          on v.id = tr.visit_id
  join public.hmo_providers hp  on hp.id = v.hmo_provider_id
  where tr.status = 'released'
    and v.hmo_provider_id is not null
    and coalesce(tr.hmo_approved_amount_php, 0) > 0
    and not exists (
      select 1 from public.hmo_claim_items i2
       where i2.test_request_id = tr.id and i2.batch_voided = false
    )
  union all
  -- 12.B historic: age from historic_hmo_claims.claim_date
  select
    hp.id                                       as provider_id,
    hp.name                                     as provider_name,
    h.final_amount_php                          as unresolved_balance_php,
    (current_date - h.claim_date)               as age_days
  from public.historic_hmo_claims h
  join public.hmo_providers hp on lower(hp.name) = lower(h.hmo_provider)
  where h.status in ('pending', 'overdue')
    and h.final_amount_php > 0
)
select
  provider_id,
  provider_name,
  case
    when age_days <= 30  then '0-30'
    when age_days <= 60  then '31-60'
    when age_days <= 90  then '61-90'
    when age_days <= 180 then '91-180'
    else '180+'
  end                                       as bucket,
  sum(unresolved_balance_php)               as total_php,
  count(*)                                  as item_count
from unioned
group by provider_id, provider_name, bucket;

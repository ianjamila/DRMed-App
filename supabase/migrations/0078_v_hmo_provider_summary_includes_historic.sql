-- =============================================================================
-- 0078_v_hmo_provider_summary_includes_historic.sql
-- =============================================================================
-- 12.B follow-up. The live HMO claims page at /staff/admin/accounting/hmo-claims
-- queries v_hmo_provider_summary which aggregates the live 12.3 subledger
-- (hmo_claim_items). Our 12.B history import populated the parallel audit-only
-- historic_hmo_claims table (migration 0076).
--
-- This view update folds historic data into total_unresolved_ar_php and
-- oldest_open_released_at so the existing dashboard cards reflect the historic
-- backfill without requiring UI changes. Matching is by hmo_providers.name
-- to historic_hmo_claims.hmo_provider (both title-cased on import).
--
-- Once live ops generate hmo_claim_items, those add to the live aggregate and
-- the historic aggregate stays static — the sum is total AR (live + historic).
-- =============================================================================

create or replace view public.v_hmo_provider_summary as
select
  hp.id                                       as provider_id,
  hp.name                                     as provider_name,
  hp.due_days_for_invoice,
  hp.unbilled_threshold_days,

  -- Live 12.3 unresolved AR.
  coalesce((
    select sum(i.billed_amount_php - i.paid_amount_php
                - i.patient_billed_amount_php - i.written_off_amount_php)
      from public.hmo_claim_items i
      join public.hmo_claim_batches b on b.id = i.batch_id
     where b.provider_id = hp.id
       and b.voided_at is null
       and (i.billed_amount_php - i.paid_amount_php
            - i.patient_billed_amount_php - i.written_off_amount_php) > 0
  ), 0)
  -- Plus 12.B historic unresolved AR for the same provider (case-insensitive
  -- name match against historic_hmo_claims.hmo_provider).
  + coalesce((
    select sum(h.final_amount_php)
      from public.historic_hmo_claims h
     where lower(h.hmo_provider) = lower(hp.name)
       and h.status in ('pending', 'overdue')
  ), 0) as total_unresolved_ar_php,

  coalesce((select sum(billed_amount_php) from public.v_hmo_unbilled where provider_id = hp.id), 0)
    as total_unbilled_php,
  coalesce((select sum(unresolved_balance_php) from public.v_hmo_stuck where provider_id = hp.id), 0)
    as total_stuck_php,

  -- Oldest open: earliest of (live released_at, historic claim_date) for
  -- still-outstanding claims.
  least(
    (select min(tr.released_at)
       from public.hmo_claim_items i
       join public.hmo_claim_batches b on b.id = i.batch_id
       join public.test_requests tr   on tr.id = i.test_request_id
      where b.provider_id = hp.id
        and b.voided_at is null
        and (i.billed_amount_php - i.paid_amount_php
             - i.patient_billed_amount_php - i.written_off_amount_php) > 0
    ),
    (select (min(h.claim_date))::timestamptz
       from public.historic_hmo_claims h
      where lower(h.hmo_provider) = lower(hp.name)
        and h.status in ('pending', 'overdue')
    )
  ) as oldest_open_released_at,

  coalesce((
    select sum(a.amount_php)
      from public.hmo_payment_allocations a
      join public.hmo_claim_items i   on i.id = a.item_id
      join public.hmo_claim_batches b on b.id = i.batch_id
     where b.provider_id = hp.id
       and a.voided_at is null
       and a.created_at >= date_trunc('year', current_date)
  ), 0) as paid_ytd_php,
  coalesce((
    select sum(r.amount_php)
      from public.hmo_claim_resolutions r
      join public.hmo_claim_items i   on i.id = r.item_id
      join public.hmo_claim_batches b on b.id = i.batch_id
     where b.provider_id = hp.id
       and r.destination = 'patient_bill'
       and r.voided_at is null
       and r.resolved_at >= date_trunc('year', current_date)
  ), 0) as patient_billed_ytd_php,
  coalesce((
    select sum(r.amount_php)
      from public.hmo_claim_resolutions r
      join public.hmo_claim_items i   on i.id = r.item_id
      join public.hmo_claim_batches b on b.id = i.batch_id
     where b.provider_id = hp.id
       and r.destination = 'write_off'
       and r.voided_at is null
       and r.resolved_at >= date_trunc('year', current_date)
  ), 0) as written_off_ytd_php
from public.hmo_providers hp
where hp.is_active = true;

-- =============================================================================
-- 0080_v_hmo_unbilled_stuck_includes_historic.sql
-- =============================================================================
-- 12.B follow-up. Extends v_hmo_unbilled and v_hmo_stuck to surface historic
-- claims (from historic_hmo_claims) alongside the live workflow, so the
-- partner can review the backlog through the existing webapp UI:
--
--   * v_hmo_unbilled — adds historic outstanding rows with no submission date
--     (i.e., invoice never sent). These are claims the partner's xlsx tracker
--     marked overdue/pending but billing_status was "FOR INVOICE CREATION".
--   * v_hmo_stuck — adds historic outstanding rows with submission date past
--     the provider's due_days_for_invoice threshold.
--
-- Both views now expose an `is_historic` boolean. The new-batch flow filters
-- `is_historic = false` so historic rows can't be incorrectly batched (they're
-- already in their final state per the xlsx tracker).
--
-- test_request_id for historic rows = historic_hmo_claims.id (uuid). visit_id
-- is null. The UI keys off test_request_id ?? visit_id-released_at, so this
-- gives a stable React key.
-- =============================================================================

create or replace view public.v_hmo_unbilled as
select
  tr.id                                          as test_request_id,
  tr.visit_id,
  v.hmo_provider_id                              as provider_id,
  hp.name                                        as provider_name,
  tr.released_at,
  tr.hmo_approved_amount_php                     as billed_amount_php,
  (current_date - tr.released_at::date)          as days_since_release,
  ((current_date - tr.released_at::date) > hp.unbilled_threshold_days)
                                                 as past_threshold,
  false                                          as is_historic
from public.test_requests tr
join public.visits v          on v.id = tr.visit_id
join public.hmo_providers hp  on hp.id = v.hmo_provider_id
where tr.status = 'released'
  and v.hmo_provider_id is not null
  and coalesce(tr.hmo_approved_amount_php, 0) > 0
  and not exists (
    select 1 from public.hmo_claim_items i
     where i.test_request_id = tr.id
       and i.batch_voided = false
  )
union all
-- 12.B historic: outstanding claims (pending/overdue) where partner's tracker
-- never recorded a date_submitted — i.e., invoice never sent.
select
  h.id                                           as test_request_id,
  null::uuid                                     as visit_id,
  hp.id                                          as provider_id,
  hp.name                                        as provider_name,
  h.claim_date::timestamptz                      as released_at,
  h.final_amount_php::numeric(10,2)              as billed_amount_php,
  (current_date - h.claim_date)                  as days_since_release,
  ((current_date - h.claim_date) > hp.unbilled_threshold_days)
                                                 as past_threshold,
  true                                           as is_historic
from public.historic_hmo_claims h
join public.hmo_providers hp on lower(hp.name) = lower(h.hmo_provider)
where h.status in ('pending', 'overdue')
  and h.date_submitted is null
  and h.final_amount_php > 0;


create or replace view public.v_hmo_stuck as
select
  i.id                                                          as item_id,
  i.batch_id,
  b.provider_id,
  hp.name                                                       as provider_name,
  b.submitted_at,
  (current_date - b.submitted_at)                               as days_since_submission,
  (i.billed_amount_php - i.paid_amount_php
     - i.patient_billed_amount_php - i.written_off_amount_php)  as unresolved_balance_php,
  false                                                         as is_historic
from public.hmo_claim_items i
join public.hmo_claim_batches b on b.id = i.batch_id
join public.hmo_providers hp    on hp.id = b.provider_id
where b.status in ('submitted', 'acknowledged', 'partial_paid')
  and b.voided_at is null
  and (i.billed_amount_php - i.paid_amount_php
       - i.patient_billed_amount_php - i.written_off_amount_php) > 0
  and b.submitted_at is not null
  and (current_date - b.submitted_at) > hp.due_days_for_invoice
union all
-- 12.B historic: outstanding claims that WERE submitted (date_submitted set)
-- but no payment past the provider's due window.
select
  h.id                                           as item_id,
  null::uuid                                     as batch_id,
  hp.id                                          as provider_id,
  hp.name                                        as provider_name,
  h.date_submitted                               as submitted_at,
  (current_date - h.date_submitted)              as days_since_submission,
  h.final_amount_php::numeric(12,2)              as unresolved_balance_php,
  true                                           as is_historic
from public.historic_hmo_claims h
join public.hmo_providers hp on lower(hp.name) = lower(h.hmo_provider)
where h.status in ('pending', 'overdue')
  and h.date_submitted is not null
  and h.final_amount_php > 0
  and (current_date - h.date_submitted) > hp.due_days_for_invoice;

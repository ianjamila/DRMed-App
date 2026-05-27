-- =============================================================================
-- 0082_v_hmo_views_kind.sql
-- =============================================================================
-- Split HMO claims into lab vs doctor for billing/tracking. The partner bills
-- HMOs separately for lab work and doctor consultations (different invoices,
-- different submission cycles). This migration adds a `kind` column to
-- v_hmo_unbilled, v_hmo_stuck, and v_hmo_ar_aging:
--
--   * 'lab'    — lab_test, lab_package, home_service, vaccine, send-out, or
--                LAB SERVICE source_tab from historic_hmo_claims
--   * 'doctor' — doctor_consultation, doctor_procedure, or DOCTOR CONSULTATION
--                source_tab from historic_hmo_claims
--
-- UI will use this to provide separate Lab and Doctor sections on the
-- provider drilldown + top-level dashboard.
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
  false                                          as is_historic,
  p.first_name || ' ' || p.last_name             as patient_name,
  s.name                                         as service_description,
  case
    when s.kind in ('doctor_consultation', 'doctor_procedure') then 'doctor'
    else 'lab'
  end                                            as kind
from public.test_requests tr
join public.visits v          on v.id = tr.visit_id
join public.hmo_providers hp  on hp.id = v.hmo_provider_id
join public.services s        on s.id = tr.service_id
left join public.patients p   on p.id = v.patient_id
where tr.status = 'released'
  and v.hmo_provider_id is not null
  and coalesce(tr.hmo_approved_amount_php, 0) > 0
  and not exists (
    select 1 from public.hmo_claim_items i
     where i.test_request_id = tr.id
       and i.batch_voided = false
  )
union all
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
  true                                           as is_historic,
  h.patient_name                                 as patient_name,
  h.service_description                          as service_description,
  case h.source_tab
    when 'DOCTOR CONSULTATION' then 'doctor'
    else 'lab'
  end                                            as kind
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
  false                                                         as is_historic,
  p.first_name || ' ' || p.last_name                            as patient_name,
  s.name                                                        as service_description,
  case
    when s.kind in ('doctor_consultation', 'doctor_procedure') then 'doctor'
    else 'lab'
  end                                                           as kind
from public.hmo_claim_items i
join public.hmo_claim_batches b on b.id = i.batch_id
join public.hmo_providers hp    on hp.id = b.provider_id
join public.test_requests tr    on tr.id = i.test_request_id
join public.services s          on s.id = tr.service_id
join public.visits v            on v.id = tr.visit_id
left join public.patients p     on p.id = v.patient_id
where b.status in ('submitted', 'acknowledged', 'partial_paid')
  and b.voided_at is null
  and (i.billed_amount_php - i.paid_amount_php
       - i.patient_billed_amount_php - i.written_off_amount_php) > 0
  and b.submitted_at is not null
  and (current_date - b.submitted_at) > hp.due_days_for_invoice
union all
select
  h.id                                           as item_id,
  null::uuid                                     as batch_id,
  hp.id                                          as provider_id,
  hp.name                                        as provider_name,
  h.date_submitted                               as submitted_at,
  (current_date - h.date_submitted)              as days_since_submission,
  h.final_amount_php::numeric(12,2)              as unresolved_balance_php,
  true                                           as is_historic,
  h.patient_name                                 as patient_name,
  h.service_description                          as service_description,
  case h.source_tab
    when 'DOCTOR CONSULTATION' then 'doctor'
    else 'lab'
  end                                            as kind
from public.historic_hmo_claims h
join public.hmo_providers hp on lower(hp.name) = lower(h.hmo_provider)
where h.status in ('pending', 'overdue')
  and h.date_submitted is not null
  and h.final_amount_php > 0
  and (current_date - h.date_submitted) > hp.due_days_for_invoice;


create or replace view public.v_hmo_ar_aging as
with unioned as (
  select
    b.provider_id,
    hp.name                                                       as provider_name,
    (i.billed_amount_php - i.paid_amount_php
       - i.patient_billed_amount_php - i.written_off_amount_php)  as unresolved_balance_php,
    (current_date - tr.released_at::date)                         as age_days,
    case
      when s.kind in ('doctor_consultation', 'doctor_procedure') then 'doctor'
      else 'lab'
    end                                                           as kind
  from public.hmo_claim_items i
  join public.hmo_claim_batches b on b.id = i.batch_id
  join public.test_requests tr    on tr.id = i.test_request_id
  join public.services s          on s.id = tr.service_id
  join public.hmo_providers hp    on hp.id = b.provider_id
  where b.voided_at is null
    and (i.billed_amount_php - i.paid_amount_php
         - i.patient_billed_amount_php - i.written_off_amount_php) > 0
    and tr.released_at is not null
  union all
  select
    v.hmo_provider_id,
    hp.name,
    tr.hmo_approved_amount_php,
    (current_date - tr.released_at::date),
    case
      when s.kind in ('doctor_consultation', 'doctor_procedure') then 'doctor'
      else 'lab'
    end                                                           as kind
  from public.test_requests tr
  join public.visits v          on v.id = tr.visit_id
  join public.services s        on s.id = tr.service_id
  join public.hmo_providers hp  on hp.id = v.hmo_provider_id
  where tr.status = 'released'
    and v.hmo_provider_id is not null
    and coalesce(tr.hmo_approved_amount_php, 0) > 0
    and not exists (
      select 1 from public.hmo_claim_items i2
       where i2.test_request_id = tr.id and i2.batch_voided = false
    )
  union all
  select
    hp.id                                       as provider_id,
    hp.name                                     as provider_name,
    h.final_amount_php                          as unresolved_balance_php,
    (current_date - h.claim_date)               as age_days,
    case h.source_tab
      when 'DOCTOR CONSULTATION' then 'doctor'
      else 'lab'
    end                                         as kind
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
  count(*)                                  as item_count,
  kind
from unioned
group by provider_id, provider_name, bucket, kind;

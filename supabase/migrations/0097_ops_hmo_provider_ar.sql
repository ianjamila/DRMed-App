-- =============================================================================
-- 0097_ops_hmo_provider_ar.sql
-- =============================================================================
-- B1.4 — per-provider HMO LAB receivables movement view.
-- Design spec: docs/superpowers/specs/2026-06-10-partB-b1.4-hmo-ar-subledger-design.md
--
-- Read-layer only. Emits one row per (business_date, provider_name, source) with
-- the day's billed-in (added to AR) and paid-out (collected) amounts. Unions the
-- live 12.3 subledger (hmo_claim_items) with the 12.B historic import
-- (historic_hmo_claims), lab-family only. The cumulative ending balance is a
-- UI/range concern computed in the pure core, NOT here.
-- =============================================================================

create or replace view public.v_ops_daily_hmo_provider_ar
with (security_invoker = on) as
-- live IN: billed lab claims, by Manila release date
select
  (tr.released_at at time zone 'Asia/Manila')::date          as business_date,
  hp.name                                                    as provider_name,
  'live'::text                                               as source,
  coalesce(sum(i.billed_amount_php), 0)::numeric(14,2)       as billed_in_php,
  0::numeric(14,2)                                           as paid_out_php
from public.hmo_claim_items i
join public.hmo_claim_batches b on b.id = i.batch_id
join public.hmo_providers hp    on hp.id = b.provider_id
join public.test_requests tr    on tr.id = i.test_request_id
join public.services s          on s.id = tr.service_id
where b.voided_at is null
  and tr.released_at is not null
  and s.kind in ('lab_test', 'lab_package', 'vaccine', 'home_service')
group by 1, 2
union all
-- live OUT: paid lab claims, by HMO response date
select
  i.hmo_response_date,
  hp.name,
  'live'::text,
  0::numeric(14,2),
  coalesce(sum(i.paid_amount_php), 0)::numeric(14,2)
from public.hmo_claim_items i
join public.hmo_claim_batches b on b.id = i.batch_id
join public.hmo_providers hp    on hp.id = b.provider_id
join public.test_requests tr    on tr.id = i.test_request_id
join public.services s          on s.id = tr.service_id
where b.voided_at is null
  and i.hmo_response = 'paid'
  and i.hmo_response_date is not null
  and s.kind in ('lab_test', 'lab_package', 'vaccine', 'home_service')
group by 1, 2
union all
-- historic IN: all billed lab claims, by claim_date (any status; $0 unknowns net to 0)
select
  h.claim_date,
  h.hmo_provider,
  'historic'::text,
  coalesce(sum(h.final_amount_php), 0)::numeric(14,2),
  0::numeric(14,2)
from public.historic_hmo_claims h
where h.source_tab = 'LAB SERVICE'
group by 1, 2
union all
-- historic OUT: dated-paid lab claims, by date_paid
select
  h.date_paid,
  h.hmo_provider,
  'historic'::text,
  0::numeric(14,2),
  coalesce(sum(h.final_amount_php), 0)::numeric(14,2)
from public.historic_hmo_claims h
where h.source_tab = 'LAB SERVICE'
  and h.status = 'paid'
  and h.date_paid is not null
group by 1, 2;

alter view public.v_ops_daily_hmo_provider_ar owner to postgres;

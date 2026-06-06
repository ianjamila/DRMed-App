-- 0095_ops_cash_views.sql
-- Part B / B1.2 — Cash-collected + credit-card read-layer.
-- Cash-basis views over payments.received_at (vs B1.1's accrual released_at).
-- security_invoker = on + NO grant to anon/authenticated: only the service-role
-- admin client reads these (clinic-wide financials past patient RLS).
-- See docs/superpowers/specs/2026-06-07-partB-b1.2-cash-collected-design.md.

-- (business_date, section, method) — gross cash receipts. -------------------
-- Section is classified per-visit via EXISTS (one row per visit) so payments
-- do NOT fan out by test count. 'consult'-wins for the 1 historical mixed visit.
create or replace view public.v_ops_daily_collections
with (security_invoker = on) as
select
  (p.received_at at time zone 'Asia/Manila')::date as business_date,
  case
    when exists (
      select 1 from public.test_requests tr
      join public.services s on s.id = tr.service_id
      where tr.visit_id = p.visit_id and s.kind = 'doctor_consultation'
    ) then 'consult'
    when exists (select 1 from public.test_requests tr where tr.visit_id = p.visit_id)
      then 'lab'
    else 'unknown'
  end as section,
  p.method,
  count(*)                                      as line_count,
  coalesce(sum(p.amount_php), 0)::numeric(14,2) as amount
from public.payments p
where p.voided_at is null
  and p.method <> 'hmo'   -- not a cash receipt; HMO via v_ops_daily_hmo_received
group by 1, 2, p.method;

alter view public.v_ops_daily_collections owner to postgres;

-- (received_date, source) — "Received HMO Receivable" line. ----------------
create or replace view public.v_ops_daily_hmo_received
with (security_invoker = on) as
select
  i.hmo_response_date                                as received_date,
  'live'::text                                       as source,
  count(*)                                           as claim_count,
  coalesce(sum(i.paid_amount_php), 0)::numeric(14,2) as amount
from public.hmo_claim_items i
join public.hmo_claim_batches b on b.id = i.batch_id
where i.hmo_response = 'paid'
  and i.hmo_response_date is not null
  and b.voided_at is null
group by i.hmo_response_date
union all
select
  h.date_paid                                        as received_date,
  'historic'::text                                   as source,
  count(*)                                           as claim_count,
  coalesce(sum(h.final_amount_php), 0)::numeric(14,2) as amount
from public.historic_hmo_claims h
where h.status = 'paid'
  and h.date_paid is not null
group by h.date_paid;

alter view public.v_ops_daily_hmo_received owner to postgres;

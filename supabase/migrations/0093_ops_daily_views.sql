-- 0093_ops_daily_views.sql
-- Part B / B1.1 — Operational daily report read-layer.
-- Three read-only views over released test_requests, keyed on GROSS base_price_php
-- (the manual DAILY MONITORING sheet's "SALES"), unlike v_daily_revenue_by_service
-- which sums net final_price_php. security_invoker = on + NO grant to anon/
-- authenticated: only the service-role admin client reads these (they expose
-- clinic-wide financials past patient RLS). See
-- docs/superpowers/specs/2026-06-05-partB-daily-report-design.md.

-- (business_date, section, channel) grain ---------------------------------
create or replace view public.v_ops_daily_channel
with (security_invoker = on) as
with base as (
  select
    (tr.released_at at time zone 'Asia/Manila')::date as business_date,
    case when s.kind = 'doctor_consultation' then 'consult' else 'lab' end as section,
    case
      when v.hmo_provider_id is not null then 'hmo'
      else coalesce(pm.method, 'unpaid')
    end as channel,
    v.patient_id,
    tr.base_price_php, tr.discount_amount_php, tr.final_price_php
  from public.test_requests tr
  join public.services s on s.id = tr.service_id
  join public.visits   v on v.id = tr.visit_id
  -- The visit's dominant (largest, non-voided) payment method.
  left join lateral (
    select p.method
    from public.payments p
    where p.visit_id = v.id and p.voided_at is null
    order by p.amount_php desc nulls last
    limit 1
  ) pm on true
  where tr.status = 'released'
)
select
  business_date, section, channel,
  count(*)                                              as line_count,
  count(distinct patient_id)                            as distinct_customers,
  coalesce(sum(base_price_php), 0)::numeric(14,2)       as sales_gross,
  coalesce(sum(discount_amount_php), 0)::numeric(14,2)  as discount,
  coalesce(sum(final_price_php), 0)::numeric(14,2)      as net
from base
group by business_date, section, channel;

alter view public.v_ops_daily_channel owner to postgres;

-- (business_date, section) grain — for cross-channel distinct + PF ---------
-- section is computed in a CTE (a plain grouping column) so the pf_collected
-- FILTER can reference it and GROUP BY doesn't choke on the bare s.kind.
create or replace view public.v_ops_daily_totals
with (security_invoker = on) as
with base as (
  select
    (tr.released_at at time zone 'Asia/Manila')::date as business_date,
    case when s.kind = 'doctor_consultation' then 'consult' else 'lab' end as section,
    v.patient_id,
    tr.base_price_php, tr.discount_amount_php, tr.final_price_php, tr.doctor_pf_php
  from public.test_requests tr
  join public.services s on s.id = tr.service_id
  join public.visits   v on v.id = tr.visit_id
  where tr.status = 'released'
)
select
  business_date, section,
  count(*)                                            as line_count,
  count(distinct patient_id)                          as distinct_customers,
  coalesce(sum(base_price_php), 0)::numeric(14,2)      as sales_gross,
  coalesce(sum(discount_amount_php), 0)::numeric(14,2) as discount,
  coalesce(sum(final_price_php), 0)::numeric(14,2)     as net,
  coalesce(sum(doctor_pf_php) filter (where section = 'consult'), 0)::numeric(14,2) as pf_collected
from base
group by business_date, section;

alter view public.v_ops_daily_totals owner to postgres;

-- (business_date, physician) grain — consult productivity -----------------
create or replace view public.v_ops_daily_doctor
with (security_invoker = on) as
select
  (tr.released_at at time zone 'Asia/Manila')::date as business_date,
  ph.id   as physician_id,
  ph.full_name,
  ph.specialty,
  ph.compensation_arrangement,
  count(*)                                          as consult_count,
  coalesce(sum(tr.base_price_php), 0)::numeric(14,2) as sales_gross,
  coalesce(sum(tr.doctor_pf_php), 0)::numeric(14,2)  as pf_collected
from public.test_requests tr
join public.services s on s.id = tr.service_id
join public.visits   v on v.id = tr.visit_id
left join public.physicians ph on ph.id = v.attending_physician_id
where tr.status = 'released' and s.kind = 'doctor_consultation'
group by business_date, ph.id, ph.full_name, ph.specialty, ph.compensation_arrangement;

alter view public.v_ops_daily_doctor owner to postgres;

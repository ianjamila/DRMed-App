-- scripts/ops-daily/validate.sql
-- B1.1 operational-views reconciliation. Run against PROD via the Supabase MCP
-- (reference figures live only in prod's legacy backfill). NOT a CI test.
-- Expected golden day — Dec 4 2023 LAB: tests=50, distinct=12, gross=23985,
-- discount=1668, net=22317, hmo lines=13; CONSULT sales=discount=7400, count≈10
-- (1 still-held ambiguous consult ⇒ sheet says 11).

-- 1. Golden day LAB totals.
select 'lab golden' as check, *
from public.v_ops_daily_totals
where business_date = date '2023-12-04' and section = 'lab';
-- assert: line_count=50, distinct_customers=12, sales_gross=23985.00,
--         discount=1668.00, net=22317.00

-- 2. Golden day LAB by channel — HMO must be 13 lines.
select 'lab golden by channel' as check, channel, line_count, sales_gross
from public.v_ops_daily_channel
where business_date = date '2023-12-04' and section = 'lab'
order by channel;
-- assert: the 'hmo' row has line_count=13

-- 3. Golden day CONSULT totals.
select 'consult golden' as check, *
from public.v_ops_daily_totals
where business_date = date '2023-12-04' and section = 'consult';
-- assert: sales_gross=7400.00, discount=7400.00, line_count≈10

-- 4. Multi-method channel rule — find a recent day whose visits used >1 method,
--    then confirm the channel split is coherent (no 'unpaid' on released rows,
--    HMO only where hmo_provider_id set). Pick a 2025/2026 day with activity.
select 'recent days w/ multiple channels' as check,
       business_date, count(distinct channel) as channels, sum(line_count) as lines
from public.v_ops_daily_channel
where business_date >= date '2025-01-01'
group by business_date
having count(distinct channel) >= 3
order by business_date desc
limit 5;
-- pick one business_date from this list for the next two checks (call it :D)

-- 5. For that day, the per-channel sales must sum to the section total
--    (channel partition is exhaustive & non-overlapping).
--    Replace the date below with a date from check 4.
select 'channel sum ties to totals' as check, c.section,
       sum(c.sales_gross) as channel_sum,
       max(t.sales_gross) as totals_value
from public.v_ops_daily_channel c
join public.v_ops_daily_totals  t
  on t.business_date = c.business_date and t.section = c.section
where c.business_date = date '2025-01-01'   -- <-- REPLACE with :D
group by c.section;
-- assert: channel_sum = totals_value for each section

-- 6. No 'unpaid' channel on any released row (payment-gating guarantees paid).
select 'unpaid leak' as check, count(*) as unpaid_rows
from public.v_ops_daily_channel
where channel = 'unpaid';
-- assert: unpaid_rows = 0 (if >0, surface in the UI but do not fail the build)

-- 7. Doctor view ties to consult totals (LEFT JOIN keeps unattributed).
select 'doctor view ties to consult total' as check,
       d.business_date,
       sum(d.consult_count) as doctor_sum,
       max(t.line_count)    as consult_total
from public.v_ops_daily_doctor d
join public.v_ops_daily_totals t
  on t.business_date = d.business_date and t.section = 'consult'
where d.business_date = date '2023-12-04'
group by d.business_date;
-- assert: doctor_sum = consult_total (unattributed rows included)

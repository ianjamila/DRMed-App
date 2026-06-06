-- validate-cash.sql — B1.2 golden-day reconciliation. Run against PROD via the
-- Supabase MCP after applying 0095. Each query prints expected vs view output.

-- 1) Dec 1 2023: Lab CASH 7960, Consult CASH 100, total 8060 (excl. rent).
select 'dec1-collections' tag, section, method, line_count, amount
from public.v_ops_daily_collections
where business_date = date '2023-12-01'
order by section, method;
-- EXPECT: (consult,cash,1,100.00) (lab,cash,5,7960.00)

-- 2) 2026-05-23 multi-method split by section (card 1876 / cash 1500 / gcash 1999).
select 'may23-collections' tag, section, method, line_count, amount
from public.v_ops_daily_collections
where business_date = date '2026-05-23'
order by section, method;
-- EXPECT methods card/cash/gcash summing to 1876/1500/1999 across sections.

-- 3) Grand totals by method for a recent month tie back to raw payments.
select 'method-tie' tag, c.method, c.amount as view_amt, p.raw_amt
from (
  select method, sum(amount) amount from public.v_ops_daily_collections
  where business_date >= date '2026-05-01' and business_date < date '2026-06-01'
  group by method
) c
join (
  select method, sum(amount_php) raw_amt from public.payments
  where voided_at is null and method <> 'hmo'
    and (received_at at time zone 'Asia/Manila')::date >= date '2026-05-01'
    and (received_at at time zone 'Asia/Manila')::date <  date '2026-06-01'
  group by method
) p using (method);
-- EXPECT view_amt = raw_amt for every method (no fan-out, no leakage).

-- 4) HMO received: historic paid total ties (2265 claims / 1965966, minus 44 no-date).
select 'hmo-received-total' tag, source, sum(claim_count) claims, sum(amount) amt
from public.v_ops_daily_hmo_received group by source;
-- EXPECT historic ~2221 claims (44 of 2265 have null date_paid, excluded).

-- 5) No 'unknown' section leakage (0 expected today).
select 'unknown-section' tag, count(*) rows_, coalesce(sum(amount),0) amt
from public.v_ops_daily_collections where section = 'unknown';
-- EXPECT 0 / 0.

-- 6) EOD recon source empty today (forward-looking panel).
select 'eod-closes' tag, count(*) closed_rows
from public.eod_close_records where status = 'closed';
-- EXPECT 0 (re-check post-launch).

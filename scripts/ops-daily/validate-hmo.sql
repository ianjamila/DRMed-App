-- scripts/ops-daily/validate-hmo.sql — run via Supabase MCP on prod.
-- B1.4 per-provider HMO LAB AR reconciliation. Run BEFORE building any UI.
-- Design spec: docs/superpowers/specs/2026-06-10-partB-b1.4-hmo-ar-subledger-design.md

-- 1) Per-provider all-time roll-forward ending (cumulative IN - dated-OUT).
select provider_name,
       sum(billed_in_php)                       as all_billed_in,
       sum(paid_out_php)                         as all_paid_out,
       sum(billed_in_php) - sum(paid_out_php)    as ending_balance
from public.v_ops_daily_hmo_provider_ar
group by provider_name
order by ending_balance desc;

-- Expected (sheet col-869 exact): Intellicare 583453, Maxicare 408608,
-- iCare 113628, Amaphil 7133.20, Avega 44432. Grand TOTAL ~= 1,895,216 (<=0.3%).

-- 2) Grand total roll-forward ending.
select sum(billed_in_php) - sum(paid_out_php) as hmo_receivables_balance
from public.v_ops_daily_hmo_provider_ar;

-- 3) Documented variance vs GL-AR snapshot (v_hmo_provider_summary).
select s.provider_name,
       s.total_unresolved_ar_php                              as gl_ar,
       rf.ending                                              as rollforward,
       rf.ending - s.total_unresolved_ar_php                  as delta_undated_paid_plus_unknown
from public.v_hmo_provider_summary s
join (
  select provider_name, sum(billed_in_php) - sum(paid_out_php) as ending
  from public.v_ops_daily_hmo_provider_ar group by provider_name
) rf on lower(rf.provider_name) = lower(s.provider_name)
order by gl_ar desc;

-- 4) Aging buckets sum == aging grand total; and lab + consult reconciliation.
select bucket, sum(total_php) from public.v_hmo_ar_aging group by bucket order by bucket;
select sum(total_php) as aging_grand_total from public.v_hmo_ar_aging;
select coalesce(sum(final_amount_php),0) as consult_ar
from public.historic_hmo_claims
where source_tab = 'DOCTOR CONSULTATION' and status in ('pending','overdue');
-- Expect: aging_grand_total ~= rollforward TOTAL (lab) + consult_ar.

-- 5) Gate must equal the pure-core matrix. buildHmoArMatrix drops rows with a
-- null business_date or business_date > range.to; the historic-IN arm has no
-- date filter, so a null claim_date would be counted by query 1 but dropped by
-- the UI. Require null_date_billed = 0 and future_rows = 0 so SQL gate == UI.
select count(*) filter (where business_date is null)                         as null_date_rows,
       coalesce(sum(billed_in_php) filter (where business_date is null),0)    as null_date_billed,
       count(*) filter (where business_date > current_date)                   as future_rows
from public.v_ops_daily_hmo_provider_ar;

-- 6) Provider-name union integrity. The core keys providers on the exact string;
-- the live arm groups by hmo_providers.name, the historic arm by raw
-- historic_hmo_claims.hmo_provider text. Eyeball: exactly the sheet's 10
-- (Maxicare, Valucare, Cocolife, Med Asia, Intellicare, Avega, Generali, Etiqa,
-- iCare, Amaphil) + (unknown HMO). No near-duplicates differing by case/space —
-- a split would still pass queries 1+2 yet render a doubled, wrong row.
select provider_name,
       '['||provider_name||']'                  as bracketed,  -- reveals trailing/leading space
       count(*)                                  as movement_rows,
       array_agg(distinct source order by source) as sources
from public.v_ops_daily_hmo_provider_ar
group by provider_name
order by provider_name;

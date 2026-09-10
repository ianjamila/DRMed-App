-- 0095_ops_cash_views.sql
-- Part B / B1.2 — Cash-collected + credit-card read-layer.
-- Cash-basis views over payments.received_at (vs B1.1's accrual released_at).
-- security_invoker = on; read in practice only by the service-role admin client
-- (clinic-wide financials past patient RLS).
-- (Corrected 2026-09-10: "NO grant to anon/authenticated" was never true — see
-- the note at the foot of this file.)
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

-- ---------------------------------------------------------------------------
-- GRANTS ON THIS FILE'S VIEWS — measured on prod 2026-09-10, not assumed
-- ---------------------------------------------------------------------------
-- These views DO carry the default anon + authenticated grants. Supabase's
-- `alter default privileges for role postgres in schema public grant all on
-- tables` applies to every new view, and no migration ever revoked it here, so
-- the original "NO grant to anon/authenticated" comments were wrong from the
-- day they were written. Verified via information_schema.role_table_grants.
--
-- The views are nonetheless NOT readable, because `security_invoker = on` makes
-- them run with the CALLER's rights and the base-table RLS policies then apply.
-- Persona simulation on prod (`set local role …`, rolled back):
--
--     role                     rows returned
--     anon                     0  (all six v_ops_daily_* views)
--     medtech (authenticated)  0  (all six)
--     postgres / service_role  782 – 2,230 depending on the view
--
-- So the protection is real; only the mechanism named in the comment was wrong.
-- The grant is the door, RLS is the lock — the standard Supabase model, and the
-- same reasoning 0134 used when it deliberately KEPT `authenticated` on the two
-- 0043 report views.
--
-- Deliberately NOT revoking. Every reader of these views in src/ goes through
-- createAdminClient() (service_role), so a revoke would be safe — but it would
-- be a schema change with no security gain, and the app-facing reason to keep
-- the grant is the same as 0134's: if a route ever needs to read one as the
-- signed-in admin through the RLS client, the door has to be open for the lock
-- to be the thing that decides.
--
-- CONTRAST — 0135. The four v_hmo_* views had the same default grants but were
-- SECURITY DEFINER, so RLS never ran and anon really did read 2,031 rows of
-- patient names. Grant open AND lock absent. That is the combination that
-- matters; a default grant on its own is not a finding.

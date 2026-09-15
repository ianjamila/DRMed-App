-- =============================================================================
-- 0146_view_soft_delete_filters.sql
-- =============================================================================
-- Soft-delete filters for the SQL view layer — the half of the 0125 rule that
-- the TypeScript guard can never see.
--
-- THE GAP
-- -------
-- CLAUDE.md has required `deleted_at is null` on every read of `visits` and
-- `test_requests` since 0125, and #169 made that machine-checked for app code
-- (src/lib/visits/query-surfaces.test.ts). That scanner reads TypeScript. Ten
-- views read the same two tables in SQL, where it cannot follow, and nine of
-- them carried no `deleted_at` predicate at all.
--
-- WHY "RELEASED" IS NOT A FILTER
-- ------------------------------
-- Most of these views select on nothing but `tr.status = 'released'`, which
-- reads like it excludes deleted rows: 0125 raises P0043 when you soft-delete
-- an already-released line. But that guard fires `before update of deleted_at`
-- only — it blocks DELETING a released line, and nothing blocks RELEASING an
-- already-deleted one. A line deleted at `ready_for_release` can still be
-- released afterwards. Same trap that #169 found in Lab TAT and the accounting
-- sheet; the ordering claim is unenforced in the direction these views need.
--
-- TWO FILTERS, NOT ONE
-- --------------------
-- Soft-deleting a VISIT does not cascade to its `test_requests` (0125's only
-- cascade is package header -> components). A deleted visit keeps a full set of
-- lines whose own `deleted_at` is still null, so filtering `tr.deleted_at`
-- alone catches nothing in the commonest case. Measured on prod the day this
-- was written: 8 deleted visits, 0 deleted lines. Every view below that reads
-- a line therefore checks BOTH, and three of them gain a `visits` join to do
-- it — `test_requests.visit_id` is NOT NULL with zero orphan rows, so those
-- joins are row-preserving and no view's column list changes.
--
-- NO NUMBERS MOVE TODAY
-- ---------------------
-- Prod currently has zero rows that are both released and soft-deleted, so
-- every view below returns exactly what it returned before. This closes the
-- gap rather than correcting a live figure — the live figure this programme
-- did correct was Lab TAT's Pending tile (25 phantom lines, all on deleted
-- visits), and that one was app-side, fixed in #169.
--
-- THE ONE JUDGEMENT CALL, WRITTEN DOWN
-- ------------------------------------
-- `v_hmo_stuck`, `v_hmo_ar_aging`'s claim-item leg and `v_ops_daily_hmo_
-- provider_ar` describe a receivable that has ALREADY been submitted to an
-- HMO. Filtering them means a visit deleted after submission drops out of the
-- clinic's AR — i.e. nobody chases money that was genuinely billed. That is a
-- real risk and the opposite error from the one this migration fixes.
--
-- Filtered anyway, for two reasons. An HMO visit stays `payment_status =
-- 'unpaid'` forever (0133), which is exactly what keeps it deletable (P0042),
-- so this state is reachable and will not announce itself. And a submitted
-- claim on a deleted visit is not an accounting question — it is a visit that
-- should never have been deletable. The right fix for THAT is a guard at
-- delete time (a P0050 raise when a visit has non-voided `hmo_claim_items`),
-- which is a behaviour change and deliberately not in this migration.
-- Reachable today, but not yet reached: prod has 0 claim items whose line or
-- visit is deleted.
--
-- SECURITY
-- --------
-- `create or replace view` REPLACES the view's options rather than merging
-- them, so omitting the WITH clause silently reverts `security_invoker` to off
-- and base-table RLS stops applying (supabase/supabase#35823). All ten views
-- carry `security_invoker = on` on prod today — four of them got it by ALTER
-- in 0134/0135, so it does NOT appear in their `create` statements upstream —
-- and every redefinition below restates it inline.
--
-- Grants survive `create or replace` (only reloptions are replaced), so none
-- are restated. The five previously-revoked views get a defensive re-revoke at
-- the tail anyway: it is a no-op if grants survived as expected, and the cost
-- of being wrong is reopening the anon-readable disclosure 0135 closed.
-- supabase/seed.sql already carries the matching local re-revokes; no change
-- needed there.
--
-- `v_hmo_provider_summary` selects from `v_hmo_unbilled` and `v_hmo_stuck`, so
-- those two are redefined first. No column list changes, so nothing breaks.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- v_hmo_unbilled — released HMO lines not yet in a claim batch.
-- Body from 0082; hardened by 0135. Leg 2 (historic_hmo_claims) is untouched.
-- This is the picklist the HMO claim batch is built from, so an unfiltered row
-- here is not a miscount — it is an unbillable line offered for billing, which
-- the app-side action (#169) then rejects with "one or more test requests not
-- found". Correct, but a mystery to the operator. This is the fix.
-- -----------------------------------------------------------------------------
create or replace view public.v_hmo_unbilled
with (security_invoker = on) as
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
  and tr.deleted_at is null          -- 0146
  and v.deleted_at is null           -- 0146: visits do not cascade to lines
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


-- -----------------------------------------------------------------------------
-- v_hmo_stuck — submitted claims past the provider's due days.
-- Body from 0082; hardened by 0135. Already joins visits, so both halves are
-- one-line additions. See "the one judgement call" in the header.
-- -----------------------------------------------------------------------------
create or replace view public.v_hmo_stuck
with (security_invoker = on) as
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
  and tr.deleted_at is null          -- 0146
  and v.deleted_at is null           -- 0146
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


-- -----------------------------------------------------------------------------
-- v_hmo_ar_aging — AR buckets. Body from 0082; hardened by 0135.
-- Leg 1 (claim items) had no `visits` join at all and gains one. Leg 2 (the
-- unbilled shape) already joins visits. Leg 3 is historic and untouched.
-- -----------------------------------------------------------------------------
create or replace view public.v_hmo_ar_aging
with (security_invoker = on) as
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
  -- 0146: visit_id is NOT NULL, so this inner join adds no rows and drops none
  -- that were not already excluded by the predicate below.
  join public.visits v            on v.id = tr.visit_id
  where b.voided_at is null
    and tr.deleted_at is null        -- 0146
    and v.deleted_at is null         -- 0146
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
    and tr.deleted_at is null        -- 0146
    and v.deleted_at is null         -- 0146
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


-- -----------------------------------------------------------------------------
-- v_hmo_provider_summary — per-provider rollup. Body from 0078; hardened by 0135.
--
-- Its `total_unbilled_php` / `total_stuck_php` read v_hmo_unbilled and
-- v_hmo_stuck, so those tighten automatically from the definitions above. Two
-- subqueries read the tables DIRECTLY and do not:
--   * total_unresolved_ar_php's live leg sums hmo_claim_items with no join to
--     test_requests at all — so it would keep counting a deleted line's claim
--     and disagree with total_stuck_php on the same row.
--   * oldest_open_released_at joins test_requests for min(released_at).
-- Both gain the join and the two filters. The historic legs are untouched.
-- -----------------------------------------------------------------------------
create or replace view public.v_hmo_provider_summary
with (security_invoker = on) as
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
      join public.test_requests tr    on tr.id = i.test_request_id   -- 0146
      join public.visits v            on v.id = tr.visit_id          -- 0146
     where b.provider_id = hp.id
       and b.voided_at is null
       and tr.deleted_at is null                                     -- 0146
       and v.deleted_at is null                                      -- 0146
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
       join public.visits v           on v.id = tr.visit_id          -- 0146
      where b.provider_id = hp.id
        and b.voided_at is null
        and tr.deleted_at is null                                    -- 0146
        and v.deleted_at is null                                     -- 0146
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


-- -----------------------------------------------------------------------------
-- v_daily_revenue_by_service — the admin daily-revenue report and its CSV.
-- Body from 0043; hardened by 0134 (anon revoked, `authenticated` KEPT because
-- the CSV route reads it through the RLS-scoped client).
-- Had no `visits` join; gains one. A deleted line here overstates a financial
-- report directly.
-- -----------------------------------------------------------------------------
create or replace view public.v_daily_revenue_by_service
with (security_invoker = on) as
select
  (tr.released_at at time zone 'Asia/Manila')::date as business_date,
  s.id   as service_id,
  s.code as service_code,
  s.name as service_name,
  s.kind as service_kind,
  count(*)                                              as released_count,
  coalesce(sum(tr.final_price_php), 0)::numeric(14,2)   as revenue_php,
  coalesce(sum(tr.discount_amount_php), 0)::numeric(14,2) as discount_php
from public.test_requests tr
join public.services s on s.id = tr.service_id
join public.visits   v on v.id = tr.visit_id            -- 0146
where tr.status = 'released'
  and tr.deleted_at is null                             -- 0146
  and v.deleted_at is null                              -- 0146
group by business_date, s.id, s.code, s.name, s.kind;


-- -----------------------------------------------------------------------------
-- v_ops_daily_channel — (business_date, section, channel) grain. Body from 0093.
-- Already joins visits; both filters go in the CTE's where.
-- -----------------------------------------------------------------------------
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
    and tr.deleted_at is null       -- 0146
    and v.deleted_at is null        -- 0146
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


-- -----------------------------------------------------------------------------
-- v_ops_daily_totals — (business_date, section) grain. Body from 0093.
-- -----------------------------------------------------------------------------
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
    and tr.deleted_at is null       -- 0146
    and v.deleted_at is null        -- 0146
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


-- -----------------------------------------------------------------------------
-- v_ops_daily_doctor — per-physician consult productivity. Body from 0136
-- (supersedes 0093 and 0129 — this is the one v_ops_daily_* already registered
-- in hardened-views.test.ts).
-- -----------------------------------------------------------------------------
create or replace view public.v_ops_daily_doctor
with (security_invoker = on) as
select
  (tr.released_at at time zone 'Asia/Manila')::date as business_date,
  ph.id   as physician_id,
  ph.full_name,
  ph.specialty,
  pc.compensation_arrangement,
  count(*)                                          as consult_count,
  coalesce(sum(tr.base_price_php), 0::numeric)::numeric(14,2) as sales_gross,
  coalesce(sum(tr.doctor_pf_php), 0::numeric)::numeric(14,2)  as pf_collected,
  pc.clinic_cut_php
from test_requests tr
  join services s on s.id = tr.service_id
  join visits v on v.id = tr.visit_id
  left join physicians ph on ph.id = v.attending_physician_id
  left join physician_compensation pc on pc.physician_id = ph.id
where tr.status = 'released'
  and tr.deleted_at is null         -- 0146
  and v.deleted_at is null          -- 0146
  and s.kind = 'doctor_consultation'
group by ((tr.released_at at time zone 'Asia/Manila')::date),
         ph.id, ph.full_name, ph.specialty,
         pc.compensation_arrangement, pc.clinic_cut_php;


-- -----------------------------------------------------------------------------
-- v_ops_daily_collections — cash collections by method. Body from 0095.
--
-- The ONLY view of the ten whose money is safe without this migration: its
-- rows, amounts and count all come from `payments`, and P0045 blocks inserting
-- a payment against a deleted visit, so a deleted visit holds none. (That is
-- the claim the earlier audit made about all five v_ops_daily_* views; it is
-- true of this one alone.)
--
-- Its SECTION classifier is a different matter. It asks whether the payment's
-- visit has any consult line, with no deleted_at filter, so a deleted
-- consultation line can file a lab visit's cash under `consult`. That
-- misreports no money, only which bucket it lands in — but it is the same
-- one-line predicate, so it is fixed here rather than left as the last
-- unfiltered read in the layer.
--
-- The visit itself needs no check: the payment's existence proves it is live.
-- -----------------------------------------------------------------------------
create or replace view public.v_ops_daily_collections
with (security_invoker = on) as
select
  (p.received_at at time zone 'Asia/Manila')::date as business_date,
  case
    when exists (
      select 1 from public.test_requests tr
      join public.services s on s.id = tr.service_id
      where tr.visit_id = p.visit_id
        and tr.deleted_at is null          -- 0146
        and s.kind = 'doctor_consultation'
    ) then 'consult'
    when exists (
      select 1 from public.test_requests tr
       where tr.visit_id = p.visit_id
         and tr.deleted_at is null         -- 0146
    ) then 'lab'
    else 'unknown'
  end as section,
  p.method,
  count(*)                                      as line_count,
  coalesce(sum(p.amount_php), 0)::numeric(14,2) as amount
from public.payments p
where p.voided_at is null
  and p.method <> 'hmo'   -- not a cash receipt; HMO via v_ops_daily_hmo_received
group by 1, 2, p.method;


-- -----------------------------------------------------------------------------
-- v_ops_daily_hmo_provider_ar — daily HMO receivable movement. Body from 0097.
-- Both LIVE legs join test_requests with no `visits` join; both gain one. The
-- two historic legs read historic_hmo_claims only and are untouched.
-- See "the one judgement call" in the header — these are submitted claims.
-- -----------------------------------------------------------------------------
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
join public.visits v            on v.id = tr.visit_id        -- 0146
where b.voided_at is null
  and tr.deleted_at is null                                  -- 0146
  and v.deleted_at is null                                   -- 0146
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
join public.visits v            on v.id = tr.visit_id        -- 0146
where b.voided_at is null
  and tr.deleted_at is null                                  -- 0146
  and v.deleted_at is null                                   -- 0146
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


-- -----------------------------------------------------------------------------
-- Defensive re-revokes.
--
-- `create or replace view` replaces reloptions, not privileges, so the grants
-- 0134/0135 left in place survive every redefinition above and these are
-- no-ops. They are here because the cost of that being wrong is reopening the
-- live anon-readable disclosure 0135 closed (2,031 rows / 292 named patients
-- and their tests), and a no-op revoke is cheap insurance against it.
--
-- Note the asymmetry, which is deliberate and predates this migration:
--   * the four v_hmo_* views revoke anon AND authenticated — nothing reads them
--     through the RLS-scoped client
--   * v_daily_revenue_by_service revokes anon ONLY — the daily-revenue CSV
--     route reads it as `authenticated`, so that grant is load-bearing
-- supabase/seed.sql already carries the matching local re-revokes (a fresh
-- `db reset` re-grants everything via `grant all on all tables`), so this
-- migration needs no change there.
--
-- The five v_ops_daily_* views keep their anon/authenticated grants, as they
-- have since 0093 — `security_invoker = on` plus base-table RLS is what stops
-- those roles seeing rows. 0093's header claims they were never granted, which
-- is not what prod shows; that mismatch is real but it is not this migration's
-- to fix, and changing it would need the reading pages checked first.
-- -----------------------------------------------------------------------------
revoke all on public.v_hmo_unbilled         from anon, authenticated;
revoke all on public.v_hmo_stuck            from anon, authenticated;
revoke all on public.v_hmo_ar_aging         from anon, authenticated;
revoke all on public.v_hmo_provider_summary from anon, authenticated;
revoke all on public.v_daily_revenue_by_service from anon;

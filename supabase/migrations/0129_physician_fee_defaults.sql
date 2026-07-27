-- =============================================================================
-- 0129_physician_fee_defaults.sql — Partner revisions PR I (per-doctor fees)
-- =============================================================================
-- Audit item: "Hardcoded ₱100 clinic cut (src/lib/visits/consultation-fee.ts:8);
-- no per-doctor default fee or % split — reception retypes fees each visit,
-- unauditable."
--
-- Adds two per-doctor overrides to physicians:
--   * default_consultation_fee_php — prefills the new-visit consult fee box.
--     NULL = no default (form stays blank, today's behavior).
--   * clinic_cut_php — overrides the arrangement-based clinic-fee default
--     (₱100 for pf_split, ₱0 for rent_paying/shareholder) set in 0064. NULL =
--     fall back to that arrangement default.
--
-- Every existing physician is backfilled with an EXPLICIT clinic_cut_php so
-- the configured cut is auditable per-doctor rather than implied by
-- arrangement alone. This changes no computed behavior today — the backfilled
-- values exactly match what defaultClinicFee(arrangement) already returns.
--
-- The v_ops_daily_doctor view (0093) is recreated to also surface
-- clinic_cut_php, so the daily-report doctor rollup can respect a per-doctor
-- override instead of inferring "clinic keeps zero" from arrangement alone.
-- =============================================================================

alter table public.physicians
  add column default_consultation_fee_php numeric(10,2)
    check (default_consultation_fee_php is null or default_consultation_fee_php >= 0),
  add column clinic_cut_php numeric(10,2)
    check (clinic_cut_php is null or clinic_cut_php >= 0);

comment on column public.physicians.default_consultation_fee_php is
  'Per-doctor default consultation fee, used to prefill the consult fee input on new visits. NULL = no default (the form stays blank, as before this column existed).';

comment on column public.physicians.clinic_cut_php is
  'Per-doctor override of the clinic''s cut of a consult/procedure fee. NULL = fall back to the arrangement-based default (₱100 for pf_split, ₱0 for rent_paying/shareholder). See defaultClinicFee() in src/lib/visits/consultation-fee.ts.';

-- Backfill: give every existing physician an explicit, auditable cut that
-- matches today's arrangement-based default exactly (no behavior change).
update public.physicians
set clinic_cut_php = case
  when compensation_arrangement = 'pf_split' then 100
  else 0
end;

-- ---------------------------------------------------------------------------
-- Recreate v_ops_daily_doctor (0093) to also expose clinic_cut_php, so the
-- daily-report doctor rollup can respect a per-doctor override rather than
-- inferring "clinic keeps zero" purely from arrangement. Adding a column via
-- CREATE OR REPLACE VIEW is additive and safe (Postgres only forbids removing
-- or reordering existing output columns).
-- ---------------------------------------------------------------------------
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
  coalesce(sum(tr.doctor_pf_php), 0)::numeric(14,2)  as pf_collected,
  ph.clinic_cut_php
from public.test_requests tr
join public.services s on s.id = tr.service_id
join public.visits   v on v.id = tr.visit_id
left join public.physicians ph on ph.id = v.attending_physician_id
where tr.status = 'released' and s.kind = 'doctor_consultation'
group by business_date, ph.id, ph.full_name, ph.specialty, ph.compensation_arrangement, ph.clinic_cut_php;

alter view public.v_ops_daily_doctor owner to postgres;

-- =============================================================================
-- 0083_historic_hmo_billed_by.sql
-- =============================================================================
-- 12.B follow-up. When the partner reviews the historic-HMO backlog through
-- the webapp and confirms a row was actually billed (just not recorded in the
-- xlsx tracker), we need to:
--   * stamp date_submitted (which moves the row out of "unbilled" view)
--   * record who recorded the update and when
--
-- These two new columns enable that audit trail without touching the existing
-- date_submitted column semantics.
-- =============================================================================

alter table public.historic_hmo_claims
  add column billed_by_staff_id uuid references public.staff_profiles(id),
  add column billed_recorded_at timestamptz;

comment on column public.historic_hmo_claims.billed_by_staff_id is
  '12.B: admin staff who confirmed this historic claim was actually billed (sets date_submitted).';
comment on column public.historic_hmo_claims.billed_recorded_at is
  '12.B: wall-clock timestamp when billed_by_staff_id recorded the confirmation.';

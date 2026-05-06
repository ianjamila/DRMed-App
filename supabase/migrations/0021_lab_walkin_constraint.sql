-- =============================================================================
-- 0021_lab_walkin_constraint.sql
-- =============================================================================
-- Lab requests without a time-sensitive service (no ultrasound, no specific
-- modality) don't need a real time slot — patients walk in during clinic
-- hours. Those bookings are 'confirmed' (so reception sees them in today's
-- queue) but carry scheduled_at=null. The 0019 constraint reserved null
-- scheduled_at exclusively for 'pending_callback'; relax it so the
-- application owns the rule (status + null scheduled_at combinations are
-- meaningful per branch and are validated in the booking action).
-- =============================================================================

alter table public.appointments
  drop constraint appointments_scheduled_when_required;

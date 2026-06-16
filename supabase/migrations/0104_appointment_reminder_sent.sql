-- =============================================================================
-- 0104_appointment_reminder_sent.sql
-- =============================================================================
-- Idempotency stamp for the day-before reminder cron
-- (/api/cron/appointment-reminders). NULL = not yet reminded; the cron sets it
-- to now() after processing an appointment (sent OR skipped-no-email) so each
-- appointment is reminded at most once. The partial index keeps the daily
-- "due" scan cheap.
-- =============================================================================

alter table public.appointments
  add column if not exists reminder_sent_at timestamptz;

create index if not exists idx_appointments_reminder_due
  on public.appointments (scheduled_at)
  where reminder_sent_at is null;

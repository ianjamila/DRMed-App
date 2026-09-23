-- =============================================================================
-- 0153 — Online booking pause switch
-- =============================================================================
-- A global singleton (same shape as consent_settings, 0086) that lets an admin
-- pause the patient-facing online booking surfaces — public /schedule and the
-- portal's /portal/book — without a deploy. While paused, both pages show a
-- "contact reception" notice and submitBookingAction refuses new bookings.
-- Staff booking (the "+ New appointment" slide-over) and walk-ins are
-- unaffected: reception keeps booking on the patient's behalf.
--
-- paused_message is an optional admin-written note shown on the notice (e.g.
-- "Online booking returns on 1 October."). Null = the built-in copy only. The
-- length cap mirrors PAUSED_MESSAGE_MAX in src/lib/booking/online-booking-copy.ts.
--
-- Reads and writes both go through the service-role client (server components
-- and an admin-only server action, audited app-side), so anon needs no policy.
-- The staff read policy exists so the table is never "RLS on, no policy";
-- there is deliberately no write policy (the audit_log / patient_consents
-- pattern) and no second permissive SELECT policy (0151 consolidated those).
-- =============================================================================

create table if not exists public.booking_settings (
  id boolean primary key default true,          -- single-row guard
  online_booking_paused boolean not null default false,
  paused_message text,
  updated_at timestamptz not null default now(),
  constraint booking_settings_singleton check (id = true),
  constraint booking_settings_paused_message_len check (
    paused_message is null or char_length(paused_message) between 1 and 400
  )
);

insert into public.booking_settings (id, online_booking_paused)
values (true, false)
on conflict (id) do nothing;

alter table public.booking_settings enable row level security;

create policy "booking_settings: staff read"
  on public.booking_settings
  for select
  to authenticated
  using ((select public.has_role(array['reception','medtech','pathologist','admin','xray_technician'])));

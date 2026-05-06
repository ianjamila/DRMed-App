-- =============================================================================
-- 0019_schedule_rework_schema.sql
-- =============================================================================
-- Schema work for the /schedule rework (Group B). New shape:
--
--   - specialty_codes + physician_specialties: stricter linkage so the
--     online doctor picker can show only physicians of the chosen
--     specialty (with "general" available for all).
--   - services.fasting_required + requires_time_slot: surface the
--     fasting disclaimer on the lab/package branches and gate the time
--     slot picker (default off → only ultrasound and similar imaging
--     prompt for a slot).
--   - services.allow_concurrent: relax the per-slot conflict guard for
--     services where multiple bookings on the same time are routine
--     (consultations that run short, ultrasounds with multiple rooms…).
--     Defaults to true so v1 lets everything through; admin can opt
--     specific services into strict-single in the future without code.
--   - appointments.scheduled_at nullable + status 'pending_callback':
--     diagnostic packages, home-service requests, and by-appointment-only
--     doctors land here so reception calls back to confirm a real slot.
--   - appointments.booking_group_id: multi-service bookings create one
--     appointment per service (option A from the design call) but share
--     a booking_group_id so reception sees them as one logical request.
--   - appointments.home_service_requested: marks rows that came from the
--     home service branch — reception flags the patient appropriately.
-- =============================================================================

create table public.specialty_codes (
  code        text primary key,
  label       text not null,
  display_order int not null default 100,
  created_at  timestamptz not null default now()
);

create table public.physician_specialties (
  physician_id uuid not null references public.physicians(id) on delete cascade,
  code         text not null references public.specialty_codes(code) on delete cascade,
  primary key (physician_id, code)
);

create index idx_physician_specialties_code
  on public.physician_specialties (code);

alter table public.services
  add column specialty_code      text references public.specialty_codes(code),
  add column fasting_required    boolean not null default false,
  add column requires_time_slot  boolean not null default false,
  add column allow_concurrent    boolean not null default true;

create index idx_services_specialty on public.services (specialty_code);

alter table public.appointments
  alter column scheduled_at drop not null;

alter table public.appointments
  add column booking_group_id      uuid,
  add column home_service_requested boolean not null default false;

create index idx_appointments_booking_group
  on public.appointments (booking_group_id)
  where booking_group_id is not null;

-- Rebuild the status CHECK to include pending_callback.
alter table public.appointments
  drop constraint appointments_status_check;

alter table public.appointments
  add constraint appointments_status_check
  check (status in (
    'pending_callback',
    'confirmed',
    'arrived',
    'cancelled',
    'no_show',
    'completed'
  ));

-- A null scheduled_at is only valid for pending_callback rows; everything
-- else must have a real time. Existing rows are unaffected.
alter table public.appointments
  add constraint appointments_scheduled_when_required
  check (status = 'pending_callback' or scheduled_at is not null);

-- RLS unchanged for specialty_codes + physician_specialties — public read
-- so the marketing booking flow can render the picker without auth.
alter table public.specialty_codes enable row level security;
alter table public.physician_specialties enable row level security;

create policy "specialty_codes: public read"
  on public.specialty_codes for select to anon, authenticated using (true);
create policy "specialty_codes: admin manage"
  on public.specialty_codes for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "physician_specialties: public read"
  on public.physician_specialties for select to anon, authenticated using (true);
create policy "physician_specialties: admin manage"
  on public.physician_specialties for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

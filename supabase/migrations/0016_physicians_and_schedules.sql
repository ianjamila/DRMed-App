-- =============================================================================
-- 0016_physicians_and_schedules.sql
-- =============================================================================
-- Phase 9: promote the static physicians roster from
-- src/lib/marketing/physicians.ts into the DB, add recurring + override
-- scheduling, and tag appointments with the booked physician.
--
-- Booking flow (post-Phase-9): patient picks specialty → physician →
-- slot, where the slot picker intersects recurring availability with
-- per-day overrides and the existing clinic_closures table. Reception
-- sees appointments.physician_id without having to ask.
--
-- "By appointment" physicians (no recurring rows) are listed on the
-- public /physicians page but filtered out of the online booking picker;
-- reception books them via the existing internal flow.
-- =============================================================================

create table public.physicians (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  full_name    text not null,
  specialty    text not null,
  group_label  text,
  is_active    boolean not null default true,
  photo_path   text,
  bio          text,
  display_order int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_physicians_active_order
  on public.physicians (display_order, full_name)
  where is_active = true;

create trigger trg_physicians_updated_at
  before update on public.physicians
  for each row execute function public.touch_updated_at();

-- Recurring weekly availability blocks. day_of_week uses Postgres
-- convention (0 = Sunday) to match `extract(dow from ...)`.
create table public.physician_schedules (
  id            uuid primary key default gen_random_uuid(),
  physician_id  uuid not null references public.physicians(id) on delete cascade,
  day_of_week   int not null check (day_of_week between 0 and 6),
  start_time    time not null,
  end_time      time not null check (end_time > start_time),
  valid_from    date not null default current_date,
  valid_until   date,
  notes         text,
  created_at    timestamptz not null default now()
);

create index idx_physician_schedules_lookup
  on public.physician_schedules (physician_id, day_of_week);

-- One-off overrides: a vacation, conference, or schedule swap. start_time
-- null means "unavailable all day"; otherwise it's an override window
-- that replaces the recurring block on that date.
create table public.physician_schedule_overrides (
  id            uuid primary key default gen_random_uuid(),
  physician_id  uuid not null references public.physicians(id) on delete cascade,
  override_on   date not null,
  start_time    time,
  end_time      time,
  reason        text,
  created_at    timestamptz not null default now(),
  -- Either both null (full-day off) or both set with end > start.
  constraint physician_overrides_window_consistency check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null and end_time > start_time)
  )
);

create index idx_physician_overrides_lookup
  on public.physician_schedule_overrides (physician_id, override_on);

alter table public.appointments
  add column physician_id uuid references public.physicians(id);

alter table public.physicians enable row level security;
alter table public.physician_schedules enable row level security;
alter table public.physician_schedule_overrides enable row level security;

-- Public can browse the active roster and read schedules so the
-- marketing /physicians page and the booking slot picker work without
-- auth. Schedules + overrides are intrinsically tied to the physician
-- they belong to (cascade on delete) so leaking them adds no risk
-- beyond what /physicians already exposes.
create policy "physicians: public read active"
  on public.physicians
  for select to anon, authenticated
  using (is_active = true);

create policy "physicians: staff read all"
  on public.physicians
  for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "physicians: admin manage"
  on public.physicians
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "physician_schedules: public read"
  on public.physician_schedules
  for select to anon, authenticated
  using (true);

create policy "physician_schedules: admin manage"
  on public.physician_schedules
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "physician_overrides: public read"
  on public.physician_schedule_overrides
  for select to anon, authenticated
  using (true);

create policy "physician_overrides: admin manage"
  on public.physician_schedule_overrides
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

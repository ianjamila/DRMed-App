-- =============================================================================
-- 0006_services_pricing_and_history.sql
-- =============================================================================
-- Phase 6.6: dual-pricing on services (cash / HMO / senior discount), section
-- label for the marketing catalog and quick-quote, send-out flag, plus a
-- price-history table fed by an AFTER trigger so admins always see who
-- changed what and when.
--
-- This is the slice of Phase 7A's `accounting_capture` migration that Phase
-- 6.6 needs in isolation: only the `services` deltas + `service_price_history`.
-- The test_requests/visits/patients deltas land in a later migration with the
-- Phase 7B reception encoding UI.
-- =============================================================================


-- services additions: dual price + senior discount + send-out flag + section label.
alter table public.services
  add column hmo_price_php       numeric(10,2) check (hmo_price_php is null or hmo_price_php >= 0),
  add column senior_discount_php numeric(10,2) check (senior_discount_php is null or senior_discount_php >= 0),
  add column is_send_out         boolean not null default false,
  add column send_out_lab        text,
  add column section             text check (section in (
    'package',
    'chemistry',
    'hematology',
    'immunology',
    'urinalysis',
    'microbiology',
    'imaging_xray',
    'imaging_ultrasound',
    'vaccine',
    'send_out',
    'consultation',
    'procedure',
    'home_service'
  ));

-- Extend the kind check to cover doctor procedures, home services, and vaccines.
alter table public.services drop constraint services_kind_check;
alter table public.services
  add constraint services_kind_check
  check (kind in (
    'lab_test',
    'lab_package',
    'doctor_consultation',
    'doctor_procedure',
    'home_service',
    'vaccine'
  ));

create index if not exists idx_services_section on public.services(section);


-- =============================================================================
-- service_price_history — append-only snapshot of every price change.
-- Trigger writes one row per services INSERT and per UPDATE that changes any
-- of the three price columns. The /staff/services/[id]/edit page reads the
-- last 20 rows for the audit trail.
-- =============================================================================
create table public.service_price_history (
  id                   bigint generated always as identity primary key,
  service_id           uuid not null references public.services(id) on delete cascade,
  price_php            numeric(10,2),
  hmo_price_php        numeric(10,2),
  senior_discount_php  numeric(10,2),
  effective_from       timestamptz not null default now(),
  changed_by           uuid references auth.users(id),
  change_reason        text
);

create index idx_service_price_history_service
  on public.service_price_history(service_id, effective_from desc);

alter table public.service_price_history enable row level security;

-- Any active staff role can read history; only admins are expected to mutate
-- prices, but we don't need a separate insert policy because the trigger runs
-- as security definer and bypasses RLS for the snapshot row.
create policy "service_price_history: staff read"
  on public.service_price_history
  for select
  to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));


-- =============================================================================
-- Trigger to snapshot price changes.
-- =============================================================================
create or replace function public.snapshot_service_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT')
     or (new.price_php is distinct from old.price_php)
     or (new.hmo_price_php is distinct from old.hmo_price_php)
     or (new.senior_discount_php is distinct from old.senior_discount_php) then
    insert into public.service_price_history
      (service_id, price_php, hmo_price_php, senior_discount_php, changed_by)
    values
      (new.id, new.price_php, new.hmo_price_php, new.senior_discount_php, auth.uid());
  end if;
  return new;
end;
$$;

create trigger trg_services_price_history
  after insert or update on public.services
  for each row execute function public.snapshot_service_price();


-- =============================================================================
-- Backfill: snapshot the current price for every existing service so the
-- history panel is non-empty on day one. effective_from is stamped to each
-- row's `created_at` (or now() if missing) and changed_by is null since
-- this is a system backfill, not a user action.
-- =============================================================================
insert into public.service_price_history
  (service_id, price_php, hmo_price_php, senior_discount_php, effective_from, changed_by, change_reason)
select
  id,
  price_php,
  hmo_price_php,
  senior_discount_php,
  coalesce(created_at, now()),
  null,
  'initial backfill'
from public.services;

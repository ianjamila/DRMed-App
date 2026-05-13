-- =============================================================================
-- 0011_accounting_capture.sql
-- =============================================================================
-- Phase 7B Slice 1: the rest of the originally-planned 7A schema. Migration
-- 0006 only carried the slice that Phase 6.6 needed (services pricing +
-- service_price_history). This one lands everything else the live ops Sheet
-- needs reception to capture so Phase 7C exports can match the existing
-- accountant workflow without re-keying.
--
-- Reference: live ops Sheet 199CjfHAO9XqVJ1Yty4eheqCTkg1CJn9YtmPeR6muVDM,
--            13 distinct tabs reviewed during Phase 7 reshape.
-- =============================================================================


-- =============================================================================
-- hmo_providers — managed list. Admin maintains via /staff/admin/hmo-providers.
-- Contract fields mirror reception's "HMO contract management" tab so
-- accounting can stop double-entering provider info.
-- =============================================================================
create table public.hmo_providers (
  id                       uuid primary key default gen_random_uuid(),
  name                     text unique not null,
  is_active                boolean not null default true,
  due_days_for_invoice     int,                    -- e.g. Maxicare = 30
  contract_start_date      date,
  contract_end_date        date,
  contact_person_name      text,
  contact_person_address   text,
  contact_person_phone     text,
  contact_person_email     text,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger trg_hmo_providers_updated_at
  before update on public.hmo_providers
  for each row execute function public.touch_updated_at();

alter table public.hmo_providers enable row level security;

-- Public can read active providers (so the marketing site can list them).
create policy "hmo_providers: public read active"
  on public.hmo_providers
  for select to anon, authenticated
  using (is_active = true);

-- Staff can read all, including inactive (admin tooling).
create policy "hmo_providers: staff read all"
  on public.hmo_providers
  for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "hmo_providers: admin manage"
  on public.hmo_providers
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));


-- =============================================================================
-- test_requests — per-line snapshots + discounts so 7C export rows are
-- reproducible even after a price change. Several columns map 1:1 to the
-- accountant's spreadsheet headers (TEST NO, BASE PRICE, DISCOUNT KIND, …).
-- =============================================================================
create sequence public.test_number_seq start with 16800 increment by 1;
-- Sequence start matches reception's mid-March 2026 watermark; admin can
-- bump via `select setval(...)` if backfill values are higher.

alter table public.test_requests
  add column test_number               bigint unique default nextval('public.test_number_seq'),
  add column base_price_php            numeric(10,2)
    check (base_price_php is null or base_price_php >= 0),
  add column hmo_provider_id           uuid references public.hmo_providers(id),
  add column hmo_approval_date         date,
  add column hmo_authorization_no      text,
  add column hmo_approved_amount_php   numeric(10,2)
    check (hmo_approved_amount_php is null or hmo_approved_amount_php >= 0),
  add column discount_kind             text check (discount_kind in
    ('senior_pwd_20', 'pct_10', 'pct_5', 'other_pct_20', 'custom')),
  add column discount_amount_php       numeric(10,2) not null default 0
    check (discount_amount_php >= 0),
  add column clinic_fee_php            numeric(10,2)
    check (clinic_fee_php is null or clinic_fee_php >= 0),
  add column doctor_pf_php             numeric(10,2)
    check (doctor_pf_php is null or doctor_pf_php >= 0),
  add column final_price_php           numeric(10,2)
    check (final_price_php is null or final_price_php >= 0),
  add column release_medium            text check (release_medium in
    ('physical', 'email', 'viber', 'gcash', 'pickup', 'other')),
  add column receptionist_remarks      text,
  add column home_service_address      text,
  add column home_service_fee_php      numeric(10,2)
    check (home_service_fee_php is null or home_service_fee_php >= 0),
  add column assigned_medtech_id       uuid references public.staff_profiles(id),
  add column procedure_description     text;

create index idx_test_requests_test_number       on public.test_requests(test_number);
create index idx_test_requests_hmo_provider      on public.test_requests(hmo_provider_id) where hmo_provider_id is not null;
create index idx_test_requests_assigned_medtech  on public.test_requests(assigned_medtech_id) where assigned_medtech_id is not null;


-- =============================================================================
-- visits — denormalised HMO authorisation (one per visit).
-- =============================================================================
alter table public.visits
  add column hmo_provider_id      uuid references public.hmo_providers(id),
  add column hmo_approval_date    date,
  add column hmo_authorization_no text;

create index idx_visits_hmo_provider on public.visits(hmo_provider_id) where hmo_provider_id is not null;


-- =============================================================================
-- patients — fields the master roster carries: referral attribution, default
-- release medium, senior/PWD ID, RA 10173 consent timestamp, and a flag the
-- system maintains for quick "is this a returning patient?" lookups.
-- =============================================================================
alter table public.patients
  add column referral_source           text check (referral_source in (
    'doctor_referral',
    'customer_referral',
    'online_facebook',
    'online_website',
    'online_google',
    'walk_in',
    'tenant_employee_northridge',
    'other'
  )),
  add column referred_by_doctor        text,
  add column preferred_release_medium  text check (preferred_release_medium in (
    'physical', 'email', 'viber', 'gcash', 'pickup'
  )),
  add column senior_pwd_id_kind        text check (senior_pwd_id_kind in ('senior', 'pwd')),
  add column senior_pwd_id_number      text,
  add column consent_signed_at         timestamptz,
  add column is_repeat_patient         boolean not null default false;


-- Maintain `is_repeat_patient` automatically: flip to true when a patient
-- has more than one non-cancelled visit. Cheaper than a view and visible to
-- the form badge without an extra query.
create or replace function public.maintain_repeat_patient_flag()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  if (tg_op = 'INSERT') then
    select count(*) into v_count from public.visits where patient_id = new.patient_id;
    if v_count > 1 then
      update public.patients set is_repeat_patient = true
      where id = new.patient_id and is_repeat_patient = false;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_visits_repeat_flag
  after insert on public.visits
  for each row execute function public.maintain_repeat_patient_flag();

-- Backfill: any patient that already has 2+ visits flips now.
update public.patients p
set is_repeat_patient = true
where (select count(*) from public.visits v where v.patient_id = p.id) > 1;


-- =============================================================================
-- payments.method — extend the allowed set with the additional methods the
-- ops sheet actually uses. cash/gcash/maya/card/bank_transfer already exist
-- (per migration 0001).
-- =============================================================================
alter table public.payments drop constraint payments_method_check;
alter table public.payments
  add constraint payments_method_check
  check (method in (
    'cash', 'gcash', 'maya', 'card', 'bank_transfer',
    'hmo', 'bpi', 'maybank'
  ));


-- =============================================================================
-- sync_state — watermark table for the 7C cron. One row per export tab.
-- =============================================================================
create table public.sync_state (
  key             text primary key,
  last_synced_at  timestamptz not null,
  last_visit_id   uuid,
  notes           text,
  updated_at      timestamptz not null default now()
);

create trigger trg_sync_state_updated_at
  before update on public.sync_state
  for each row execute function public.touch_updated_at();

alter table public.sync_state enable row level security;

-- Read-only for staff (admin debugging); writes happen via service-role from
-- the cron handler, so no with-check policy needed for inserts/updates.
create policy "sync_state: admin read"
  on public.sync_state
  for select to authenticated
  using (public.has_role(array['admin']));


-- ===========================================================================
-- Baseline HMO providers seed (added retroactively 2026-05-14 — fix fresh-clone
-- db reset). Originally seeded via the reception admin UI; never put into a
-- migration. Idempotent so it's a no-op on prod (rows already exist).
-- 0034 adds the remaining 5 providers (Cocolife, Med Asia, Generali, Amaphil,
-- Pacific Cross) via the same INSERT ... ON CONFLICT pattern.
-- ===========================================================================
insert into public.hmo_providers (name, is_active, due_days_for_invoice) values
  ('Avega',       true, 30),
  ('Etiqa',       true, 30),
  ('iCare',       true, 30),
  ('Intellicare', true, 30),
  ('Maxicare',    true, 30),
  ('Valucare',    true, 30)
on conflict (name) do nothing;

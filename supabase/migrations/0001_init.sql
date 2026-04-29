-- =============================================================================
-- 0001_init.sql — drmed.ph initial schema (Phase 1)
-- =============================================================================
-- Tables, sequences, helper functions, triggers, RLS policies, and storage
-- bucket for the Philippine medical lab platform.
--
-- Compliance: Philippine Data Privacy Act (RA 10173).
-- Auth model: staff via Supabase Auth, patients via custom DRM-ID + PIN flow
-- bridged into RLS via the `app.current_patient_id` setting.
-- =============================================================================


-- =============================================================================
-- EXTENSIONS
-- =============================================================================
create extension if not exists pgcrypto;


-- =============================================================================
-- SEQUENCES + ID GENERATORS
-- =============================================================================
create sequence if not exists public.drm_id_seq start with 1;
create sequence if not exists public.visit_number_seq start with 1;

create or replace function public.generate_drm_id()
returns text
language sql
volatile
as $$
  select 'DRM-' || lpad(nextval('public.drm_id_seq')::text, 4, '0');
$$;

create or replace function public.generate_visit_number()
returns text
language sql
volatile
as $$
  select lpad(nextval('public.visit_number_seq')::text, 4, '0');
$$;


-- =============================================================================
-- updated_at autotouch trigger function
-- =============================================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =============================================================================
-- TABLES — order matters because of FKs
-- =============================================================================

-- staff_profiles ---------------------------------------------------------------
create table public.staff_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  role        text not null check (role in ('reception', 'medtech', 'pathologist', 'admin')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- patients ---------------------------------------------------------------------
create table public.patients (
  id          uuid primary key default gen_random_uuid(),
  drm_id      text unique not null default public.generate_drm_id(),
  first_name  text not null,
  last_name   text not null,
  middle_name text,
  birthdate   date not null,
  sex         text check (sex in ('male', 'female')),
  phone       text,
  email       text,
  address     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);

-- services ---------------------------------------------------------------------
create table public.services (
  id                uuid primary key default gen_random_uuid(),
  code              text unique not null,
  name              text not null,
  description       text,
  price_php         numeric(10,2) not null check (price_php >= 0),
  is_active         boolean not null default true,
  turnaround_hours  int,
  -- Toggled per service in Phase 5; default false skips the pathologist signoff step.
  requires_signoff  boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- visits -----------------------------------------------------------------------
create table public.visits (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid not null references public.patients(id),
  visit_number    text unique not null default public.generate_visit_number(),
  visit_date      date not null default current_date,
  payment_status  text not null default 'unpaid'
                    check (payment_status in ('unpaid', 'partial', 'paid', 'waived')),
  total_php       numeric(10,2) not null default 0 check (total_php >= 0),
  paid_php        numeric(10,2) not null default 0 check (paid_php >= 0),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id)
);

-- visit_pins -------------------------------------------------------------------
create table public.visit_pins (
  id              uuid primary key default gen_random_uuid(),
  visit_id        uuid unique not null references public.visits(id) on delete cascade,
  pin_hash        text not null,
  expires_at      timestamptz not null default (now() + interval '60 days'),
  last_used_at    timestamptz,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

-- test_requests ----------------------------------------------------------------
create table public.test_requests (
  id                uuid primary key default gen_random_uuid(),
  visit_id          uuid not null references public.visits(id),
  service_id        uuid not null references public.services(id),
  status            text not null default 'requested'
                      check (status in ('requested', 'in_progress', 'result_uploaded',
                                        'ready_for_release', 'released', 'cancelled')),
  requested_by      uuid not null references auth.users(id),
  requested_at      timestamptz not null default now(),
  assigned_to       uuid references auth.users(id),
  started_at        timestamptz,
  completed_at      timestamptz,
  signed_off_at     timestamptz,
  signed_off_by     uuid references auth.users(id),
  released_at       timestamptz,
  released_by       uuid references auth.users(id),
  cancelled_reason  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- results ----------------------------------------------------------------------
create table public.results (
  id                uuid primary key default gen_random_uuid(),
  test_request_id   uuid unique not null references public.test_requests(id) on delete cascade,
  storage_path      text not null,
  file_size_bytes   int check (file_size_bytes is null or file_size_bytes > 0),
  uploaded_by       uuid not null references auth.users(id),
  uploaded_at       timestamptz not null default now(),
  -- Internal medtech notes — NOT visible to patient.
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- payments ---------------------------------------------------------------------
create table public.payments (
  id                uuid primary key default gen_random_uuid(),
  visit_id          uuid not null references public.visits(id),
  amount_php        numeric(10,2) not null check (amount_php > 0),
  method            text check (method in ('cash', 'gcash', 'maya', 'card', 'bank_transfer')),
  reference_number  text,
  received_by       uuid not null references auth.users(id),
  received_at       timestamptz not null default now(),
  notes             text,
  created_at        timestamptz not null default now()
);

-- appointments -----------------------------------------------------------------
create table public.appointments (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid references public.patients(id),
  walk_in_name    text,
  walk_in_phone   text,
  service_id      uuid references public.services(id),
  scheduled_at    timestamptz not null,
  status          text not null default 'confirmed'
                    check (status in ('confirmed', 'arrived', 'cancelled', 'no_show', 'completed')),
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  -- Either a registered patient OR a walk-in identification must be present.
  constraint appointments_identification_check
    check (patient_id is not null or (walk_in_name is not null and walk_in_phone is not null))
);

-- audit_log --------------------------------------------------------------------
create table public.audit_log (
  id            bigserial primary key,
  actor_id      uuid,
  actor_type    text not null check (actor_type in ('staff', 'patient', 'system', 'anonymous')),
  patient_id    uuid references public.patients(id),
  action        text not null,
  resource_type text,
  resource_id   uuid,
  metadata      jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);


-- =============================================================================
-- INDEXES
-- =============================================================================
create index idx_patients_phone           on public.patients(phone) where phone is not null;
create index idx_patients_email           on public.patients(email) where email is not null;
create index idx_patients_last_first      on public.patients(last_name, first_name);

create index idx_visits_patient_id        on public.visits(patient_id);
create index idx_visits_visit_date        on public.visits(visit_date);
create index idx_visits_payment_status    on public.visits(payment_status);

create index idx_test_requests_visit_id     on public.test_requests(visit_id);
create index idx_test_requests_service_id   on public.test_requests(service_id);
create index idx_test_requests_status       on public.test_requests(status);
create index idx_test_requests_assigned_to  on public.test_requests(assigned_to)
  where assigned_to is not null;

create index idx_payments_visit_id        on public.payments(visit_id);

create index idx_appointments_scheduled_at on public.appointments(scheduled_at);
create index idx_appointments_status       on public.appointments(status);
create index idx_appointments_patient_id   on public.appointments(patient_id)
  where patient_id is not null;

create index idx_audit_log_patient_id     on public.audit_log(patient_id) where patient_id is not null;
create index idx_audit_log_actor_id       on public.audit_log(actor_id) where actor_id is not null;
create index idx_audit_log_created_at     on public.audit_log(created_at desc);
create index idx_audit_log_action         on public.audit_log(action);


-- =============================================================================
-- HELPER FUNCTIONS — staff role checks (security definer to bypass RLS internally)
-- =============================================================================
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_profiles
    where id = auth.uid() and is_active = true
  );
$$;

create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.staff_profiles
  where id = auth.uid() and is_active = true;
$$;

create or replace function public.has_role(roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_profiles
    where id = auth.uid()
      and is_active = true
      and role = any(roles)
  );
$$;


-- =============================================================================
-- HELPER FUNCTIONS — patient session bridge for RLS
-- =============================================================================
-- Patients are NOT in auth.users. Server actions call set_patient_context() at
-- the start of a transaction; current_patient_id() reads it back inside RLS.
create or replace function public.current_patient_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_patient_id', true), '')::uuid;
$$;

create or replace function public.set_patient_context(p_patient_id uuid)
returns void
language sql
volatile
as $$
  -- second arg `true` => transaction-local; the calling SQL must run in the
  -- same transaction as the queries that rely on the setting.
  select set_config('app.current_patient_id', p_patient_id::text, true);
$$;


-- =============================================================================
-- BUSINESS-RULE TRIGGERS
-- =============================================================================

-- Payment-gating: blocks transitions to status='released' unless the parent
-- visit is paid (or waived). The DB trigger is the source of truth — UI checks
-- exist for UX but cannot be relied on.
create or replace function public.enforce_payment_before_release()
returns trigger
language plpgsql
as $$
declare
  v_payment_status text;
begin
  if new.status = 'released' and (old.status is null or old.status <> 'released') then
    select payment_status into v_payment_status
    from public.visits
    where id = new.visit_id;

    if v_payment_status not in ('paid', 'waived') then
      raise exception
        'cannot release test result: visit payment_status must be paid or waived (current: %)',
        v_payment_status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_test_requests_payment_gate
  before update on public.test_requests
  for each row
  execute function public.enforce_payment_before_release();


-- Recalculate visits.paid_php and payment_status whenever a payment is recorded.
-- Preserves 'waived' status — once waived, a payment doesn't re-classify the visit.
create or replace function public.recalc_visit_payment()
returns trigger
language plpgsql
as $$
declare
  v_total numeric(10,2);
  v_paid  numeric(10,2);
  v_calculated_status text;
begin
  select total_php into v_total
  from public.visits where id = new.visit_id for update;

  select coalesce(sum(amount_php), 0) into v_paid
  from public.payments where visit_id = new.visit_id;

  if v_total = 0 or v_paid >= v_total then
    v_calculated_status := 'paid';
  elsif v_paid > 0 then
    v_calculated_status := 'partial';
  else
    v_calculated_status := 'unpaid';
  end if;

  update public.visits
  set paid_php = v_paid,
      payment_status = case
        when payment_status = 'waived' then 'waived'
        else v_calculated_status
      end,
      updated_at = now()
  where id = new.visit_id;

  return new;
end;
$$;

create trigger trg_payments_recalc
  after insert on public.payments
  for each row
  execute function public.recalc_visit_payment();


-- Auto-advance test_requests.status when a result PDF is uploaded.
-- in_progress → result_uploaded   (if service.requires_signoff)
-- in_progress → ready_for_release (otherwise)
create or replace function public.advance_test_on_result_upload()
returns trigger
language plpgsql
as $$
declare
  v_request public.test_requests%rowtype;
  v_requires_signoff boolean;
begin
  select * into v_request
  from public.test_requests where id = new.test_request_id;

  if v_request.status <> 'in_progress' then
    return new;
  end if;

  select coalesce(s.requires_signoff, false) into v_requires_signoff
  from public.services s where s.id = v_request.service_id;

  update public.test_requests
  set status = case when v_requires_signoff
                    then 'result_uploaded'
                    else 'ready_for_release' end,
      completed_at = now(),
      updated_at = now()
  where id = new.test_request_id;

  return new;
end;
$$;

create trigger trg_results_advance_test
  after insert on public.results
  for each row
  execute function public.advance_test_on_result_upload();


-- =============================================================================
-- updated_at triggers
-- =============================================================================
create trigger trg_staff_profiles_updated_at before update on public.staff_profiles
  for each row execute function public.touch_updated_at();
create trigger trg_patients_updated_at       before update on public.patients
  for each row execute function public.touch_updated_at();
create trigger trg_services_updated_at       before update on public.services
  for each row execute function public.touch_updated_at();
create trigger trg_visits_updated_at         before update on public.visits
  for each row execute function public.touch_updated_at();
create trigger trg_test_requests_updated_at  before update on public.test_requests
  for each row execute function public.touch_updated_at();
create trigger trg_results_updated_at        before update on public.results
  for each row execute function public.touch_updated_at();


-- =============================================================================
-- ROW LEVEL SECURITY — enable on every table
-- =============================================================================
alter table public.staff_profiles enable row level security;
alter table public.patients       enable row level security;
alter table public.services       enable row level security;
alter table public.visits         enable row level security;
alter table public.visit_pins     enable row level security;
alter table public.test_requests  enable row level security;
alter table public.results        enable row level security;
alter table public.payments       enable row level security;
alter table public.appointments   enable row level security;
alter table public.audit_log      enable row level security;


-- =============================================================================
-- RLS POLICIES
-- =============================================================================

-- staff_profiles --------------------------------------------------------------
create policy "staff_profiles: self select"
  on public.staff_profiles for select to authenticated
  using (id = auth.uid());

create policy "staff_profiles: admin manage"
  on public.staff_profiles for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));


-- patients --------------------------------------------------------------------
create policy "patients: staff full"
  on public.patients for all to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']))
  with check (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "patients: patient self select"
  on public.patients for select to anon, authenticated
  using (id = public.current_patient_id());


-- services --------------------------------------------------------------------
-- Public read (marketing site needs the active service catalog).
create policy "services: public read active"
  on public.services for select to anon, authenticated
  using (is_active = true);

-- Admin sees everything (including inactive) and writes.
create policy "services: admin all"
  on public.services for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- Staff (non-admin) see all rows including inactive (for visit-creation UI).
create policy "services: staff read"
  on public.services for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist']));


-- visits ----------------------------------------------------------------------
create policy "visits: staff full"
  on public.visits for all to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']))
  with check (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "visits: patient self select"
  on public.visits for select to anon, authenticated
  using (patient_id = public.current_patient_id());


-- visit_pins ------------------------------------------------------------------
-- Reception/admin manage. PIN verification at sign-in goes through the
-- service-role client (bypasses RLS), so no patient-facing policy is needed.
create policy "visit_pins: reception/admin manage"
  on public.visit_pins for all to authenticated
  using (public.has_role(array['reception', 'admin']))
  with check (public.has_role(array['reception', 'admin']));


-- test_requests ---------------------------------------------------------------
create policy "test_requests: staff select"
  on public.test_requests for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "test_requests: reception/admin write"
  on public.test_requests for all to authenticated
  using (public.has_role(array['reception', 'admin']))
  with check (public.has_role(array['reception', 'admin']));

create policy "test_requests: medtech/pathologist update"
  on public.test_requests for update to authenticated
  using (public.has_role(array['medtech', 'pathologist']))
  with check (public.has_role(array['medtech', 'pathologist']));

create policy "test_requests: patient released only"
  on public.test_requests for select to anon, authenticated
  using (
    status = 'released'
    and visit_id in (
      select id from public.visits where patient_id = public.current_patient_id()
    )
  );


-- results ---------------------------------------------------------------------
create policy "results: staff select"
  on public.results for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "results: medtech/pathologist/admin write"
  on public.results for all to authenticated
  using (public.has_role(array['medtech', 'pathologist', 'admin']))
  with check (public.has_role(array['medtech', 'pathologist', 'admin']));

create policy "results: patient released only"
  on public.results for select to anon, authenticated
  using (
    test_request_id in (
      select tr.id
      from public.test_requests tr
      join public.visits v on v.id = tr.visit_id
      where tr.status = 'released'
        and v.patient_id = public.current_patient_id()
    )
  );


-- payments --------------------------------------------------------------------
-- medtech and pathologist have NO access (default deny).
create policy "payments: reception/admin manage"
  on public.payments for all to authenticated
  using (public.has_role(array['reception', 'admin']))
  with check (public.has_role(array['reception', 'admin']));

create policy "payments: patient self select"
  on public.payments for select to anon, authenticated
  using (
    visit_id in (
      select id from public.visits where patient_id = public.current_patient_id()
    )
  );


-- appointments ----------------------------------------------------------------
create policy "appointments: staff manage"
  on public.appointments for all to authenticated
  using (public.has_role(array['reception', 'admin']))
  with check (public.has_role(array['reception', 'admin']));

-- Public booking (rate-limited via Edge Function in Phase 6).
create policy "appointments: public insert"
  on public.appointments for insert to anon, authenticated
  with check (true);


-- audit_log -------------------------------------------------------------------
-- Inserts come from the service-role client in server actions (RLS bypassed).
-- Only admin can read.
create policy "audit_log: admin select"
  on public.audit_log for select to authenticated
  using (public.has_role(array['admin']));


-- =============================================================================
-- STORAGE — private bucket for result PDFs
-- =============================================================================
-- Path convention: <patient_id>/<visit_id>/<test_request_id>.pdf
-- All access goes through service-role-issued signed URLs (5-minute TTL).
-- No bucket-level RLS policies: server actions use service-role client.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'results',
  'results',
  false,
  10485760,                    -- 10 MB
  array['application/pdf']
)
on conflict (id) do nothing;

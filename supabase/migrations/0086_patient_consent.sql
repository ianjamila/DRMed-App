-- =============================================================================
-- 0086 — Patient data-privacy consent (RA 10173)
-- =============================================================================
-- Event-log table + denormalized current-state on patients, a feature-flagged
-- release gate, and a private artifact bucket. See
-- docs/superpowers/specs/2026-05-29-patient-consent-form-design.md
-- =============================================================================

-- 1) Settings: single-row feature flag for the release gate.
create table if not exists public.consent_settings (
  id boolean primary key default true,         -- single-row guard
  gate_required boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint consent_settings_singleton check (id = true)
);
insert into public.consent_settings (id, gate_required)
values (true, false)
on conflict (id) do nothing;

-- 2) Event-log table.
create table if not exists public.patient_consents (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  event_type text not null check (event_type in ('granted','withdrawn')),
  method text check (method in ('paper_wet_signature','onscreen_signature','portal_acceptance')),
  notice_version text,
  signatory text check (signatory in ('self','guardian','representative')),
  signatory_name text,
  signatory_relationship text,
  artifact_path text,
  reason text,
  actor_kind text not null check (actor_kind in ('staff','patient')),
  created_by uuid references public.staff_profiles(id),
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),

  -- Field-presence rules:
  constraint pc_grant_fields check (
    event_type <> 'granted'
    or (method is not null and notice_version is not null and signatory is not null and reason is null)
  ),
  constraint pc_withdraw_fields check (
    event_type <> 'withdrawn'
    or (method is null and notice_version is null and signatory is null and reason is not null)
  ),
  constraint pc_signatory_detail check (
    signatory is null or signatory = 'self'
    or (signatory_name is not null and signatory_relationship is not null)
  )
);

create index if not exists patient_consents_patient_idx
  on public.patient_consents (patient_id, created_at desc);

-- 3) Denormalized current-state columns on patients.
alter table public.patients
  add column if not exists consent_current boolean not null default false,
  add column if not exists consent_withdrawn_at timestamptz,
  add column if not exists consent_method text,
  add column if not exists consent_notice_version text;
-- consent_signed_at already exists (migration 0011).

-- 4) Sync trigger: recompute patients current-state from the latest event.
create or replace function public.sync_patient_consent_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest public.patient_consents%rowtype;
begin
  select * into v_latest
  from public.patient_consents
  where patient_id = new.patient_id
  order by created_at desc, id desc
  limit 1;

  if v_latest.event_type = 'granted' then
    update public.patients set
      consent_current = true,
      consent_signed_at = v_latest.created_at,
      consent_withdrawn_at = null,
      consent_method = v_latest.method,
      consent_notice_version = v_latest.notice_version
    where id = new.patient_id;
  else
    update public.patients set
      consent_current = false,
      consent_withdrawn_at = v_latest.created_at
      -- consent_signed_at left as the historical grant time on purpose.
    where id = new.patient_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_patient_consents_sync on public.patient_consents;
create trigger trg_patient_consents_sync
  after insert on public.patient_consents
  for each row execute function public.sync_patient_consent_state();

-- 5) Release gate: block transition to released unless current consent (flag on).
create or replace function public.enforce_consent_before_release()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_required boolean;
  v_consent boolean;
begin
  if new.status = 'released' and (old.status is null or old.status <> 'released') then
    select gate_required into v_required from public.consent_settings where id = true;
    if coalesce(v_required, false) then
      select p.consent_current into v_consent
      from public.visits v
      join public.patients p on p.id = v.patient_id
      where v.id = new.visit_id;

      if not coalesce(v_consent, false) then
        raise exception
          'cannot release test result: patient data-privacy consent is not on file (RA 10173)'
          using errcode = 'check_violation';
        -- NOTE: message intentionally contains the word "consent" so callers
        -- (finalise-consolidated, translatePgError) can distinguish it from the
        -- payment gate, which contains "payment_status".
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_test_requests_consent_gate on public.test_requests;
create trigger trg_test_requests_consent_gate
  before update on public.test_requests
  for each row execute function public.enforce_consent_before_release();

-- 6) Private bucket for signed-artifact storage (scanned forms / signature PNGs).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'consent-artifacts', 'consent-artifacts', false,
  5242880,                                          -- 5 MB cap
  array['application/pdf','image/png','image/jpeg']
)
on conflict (id) do nothing;
-- No `to authenticated` policies: service-role only, mirroring 0052_signatures_bucket.

-- 7) RLS for patient_consents: writes happen through the service-role admin
--    client from Server Actions (service-role bypasses RLS).
alter table public.patient_consents enable row level security;

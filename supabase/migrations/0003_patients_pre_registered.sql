-- =============================================================================
-- 0003_patients_pre_registered.sql
-- =============================================================================
-- Track which patients self-registered through the public form (Phase 6) vs.
-- walk-ins entered by reception. Pre-registered rows show a "verify identity"
-- badge in the staff portal until a receptionist confirms the patient.
-- =============================================================================

alter table public.patients
  add column pre_registered boolean not null default false;

create index idx_patients_pre_registered
  on public.patients(pre_registered)
  where pre_registered = true;

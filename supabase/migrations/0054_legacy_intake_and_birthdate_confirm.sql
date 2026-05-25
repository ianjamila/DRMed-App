-- =============================================================================
-- 0054_legacy_intake_and_birthdate_confirm.sql
-- =============================================================================
-- Loosens patients.birthdate to allow null (legacy ops sheet often lacks
-- DOB); adds a birthdate_confirmed flag so reception can mark records they
-- have visually verified against a physical ID; adds a legacy_intake jsonb
-- to preserve the original sheet row verbatim; adds a legacy_import_runs
-- audit table so any batched import can be rolled back with one DELETE.
-- =============================================================================

alter table public.patients
  alter column birthdate drop not null,
  add column birthdate_confirmed boolean not null default false,
  add column legacy_intake jsonb,
  add column legacy_import_run_id uuid;

-- Existing rows are real reception-entered patients, so their DOB (when
-- present) is considered confirmed. The default false applies only to
-- future legacy-imported rows.
update public.patients
   set birthdate_confirmed = true
 where birthdate is not null;

create table public.legacy_import_runs (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  rows_in         int,
  rows_inserted   int,
  rows_skipped    int,
  rows_flagged    int,
  dry_run         boolean not null,
  run_by          uuid references auth.users(id),
  notes           text
);

alter table public.patients
  add constraint patients_legacy_import_run_fk
  foreign key (legacy_import_run_id) references public.legacy_import_runs(id);

create index idx_patients_legacy_import_run
  on public.patients(legacy_import_run_id)
  where legacy_import_run_id is not null;

-- Reception name-search needs to be fuzzy: half the imported rows lack
-- DOB and email, so name is the primary lookup tool.
create extension if not exists pg_trgm;

create index idx_patients_name_trgm
  on public.patients using gin (
    (lower(coalesce(first_name,'') || ' '
       || coalesce(last_name,'') || ' '
       || coalesce(middle_name,''))) gin_trgm_ops
  );

-- RLS: legacy_import_runs is service-role-only (no staff or patient policy).
alter table public.legacy_import_runs enable row level security;

-- =============================================================================
-- Relax the birthdate CHECK constraint (originally added in 0035) so that
-- legacy-imported customer rows (which often lack DOB) are accepted without
-- having to mis-mark them as is_historical=true. is_historical retains its
-- original semantic ("imported from HMO history, not a live patient
-- relationship") and is unsuitable for live-but-incomplete customer rows.
-- =============================================================================
alter table public.patients
  drop constraint if exists patients_birthdate_required_when_not_historical;

alter table public.patients
  add constraint patients_birthdate_required_for_walkins
  check (
    is_historical = true
    or legacy_import_run_id is not null
    or birthdate is not null
  );

-- =============================================================================
-- 0025_patients_merge.sql
-- =============================================================================
-- Adds a soft-delete-style merge mechanism to the patients table. When
-- two rows are determined to be the same person (typo in email, name
-- variations, etc.) reception/admin merges the duplicate into the
-- canonical row: visits / appointments / audit_log get reassigned, and
-- the source row stays in place but is tombstoned via merged_into_id +
-- merged_at. The row is never hard-deleted so the audit trail remains
-- intact and the original DRM-ID still resolves to a known endpoint.
-- =============================================================================

alter table public.patients
  add column merged_into_id uuid references public.patients(id),
  add column merged_at      timestamptz;

create index idx_patients_merged_into_id
  on public.patients(merged_into_id)
  where merged_into_id is not null;

-- Defensive constraint: a row can't merge into itself.
alter table public.patients
  add constraint patients_no_self_merge
  check (merged_into_id is null or merged_into_id <> id);

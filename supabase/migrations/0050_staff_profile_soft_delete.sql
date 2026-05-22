-- 0050: soft-delete support for staff_profiles
--
-- Admin can delete a staff user from /staff/users. The row stays in the
-- table (so audit logs continue to resolve actor_id → name) but is
-- excluded from the active set and surfaced separately on a "Deleted
-- users" panel.
--
-- requireSignedInStaff is updated in code to treat deleted_at IS NOT NULL
-- as "no profile" — the user cannot sign back in, even though their
-- auth.users row may still exist.
--
-- Partial index speeds the common "list existing staff users" query
-- (deleted_at IS NULL).

alter table staff_profiles
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references staff_profiles(id) on delete set null;

comment on column staff_profiles.deleted_at is
  'When the row was soft-deleted by an admin. NULL = active record.';
comment on column staff_profiles.deleted_by is
  'Which admin staff_profiles.id performed the soft-delete. SET NULL if that admin is themselves later deleted.';

create index if not exists staff_profiles_active_idx
  on staff_profiles (id) where deleted_at is null;

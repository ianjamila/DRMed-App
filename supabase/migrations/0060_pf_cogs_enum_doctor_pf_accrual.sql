-- =============================================================================
-- 0060_pf_cogs_enum_doctor_pf_accrual.sql
-- =============================================================================
-- 12.5 sub-project. PG 15 forbids `ALTER TYPE ADD VALUE` mixed with other
-- transactional DDL in the same migration. This file isolates one enum value.
-- See spec §8 for the migration ordering rationale.
-- =============================================================================

alter type public.je_source_kind add value if not exists 'doctor_pf_accrual';

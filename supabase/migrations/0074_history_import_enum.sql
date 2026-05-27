-- =============================================================================
-- 0074_history_import_enum.sql
-- =============================================================================
-- 12.B sub-project (history import from DR MED MASTERSHEET.xlsx).
-- PG 15 forbids `ALTER TYPE ADD VALUE` mixed with other transactional DDL in
-- the same migration. This file isolates the single enum value; 0075 follows
-- with the chart_of_accounts seed.
-- =============================================================================

alter type public.je_source_kind add value if not exists 'history_import';

-- 0048_ap_subledger_schema.sql
-- Phase 12.4 — Operating-Expense / AP Subledger — Schema layer.
-- Design spec: docs/superpowers/specs/2026-05-20-12.4-ap-subledger-design.md
-- Behavior (functions + triggers) lives in 0049.
-- Builds on 12.1 (GL foundation), 12.2 (Op→GL bridge), 12.3 (HMO AR subledger).

-- ==========================================================================
-- Section 0 — Enum extensions (must precede any function referencing them).
-- ==========================================================================

alter type public.je_source_kind add value if not exists 'bill_post';
alter type public.je_source_kind add value if not exists 'bill_payment';

-- ==========================================================================
-- Section 1 — Extensions (defense; likely already enabled by 0034).
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =============================================================================
-- 0063_pf_cogs_enum_cogs_send_out_trueup.sql
-- =============================================================================
alter type public.je_source_kind add value if not exists 'cogs_send_out_trueup';

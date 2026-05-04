-- =============================================================================
-- 0010_drop_compute_result_flag_trigger.sql
-- =============================================================================
-- Phase 13.3 follow-up: with age-banded ranges (migration 0009), flag
-- computation needs to know the patient's age + sex to pick the right
-- reference range. The Phase 13.1 trigger only knew about the param's
-- default ref columns, so it would mark normal neonates as "L" (or worse,
-- miss real abnormalities at the high end of paediatric ranges).
--
-- Rather than reimplement the picker in plpgsql against the joined
-- patient/visit chain, flag computation moves to the application:
-- finaliseStructuredAction now writes the flag explicitly as part of the
-- upsert payload using the same pickRangeForPatient helper the form uses.
--
-- This keeps a single source of truth (TypeScript) for range selection and
-- avoids stale flags when ranges are edited (the recompute is naturally
-- driven by the next finalise / re-finalise).
-- =============================================================================

drop trigger if exists trg_result_values_compute_flag on public.result_values;
drop function if exists public.compute_result_flag();

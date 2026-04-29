-- =============================================================================
-- 0002_function_search_path.sql
-- =============================================================================
-- Pin search_path = public on functions defined in 0001 that didn't already
-- have it. Prevents search-path injection (Supabase advisor lint 0011).
-- =============================================================================

alter function public.generate_drm_id()                set search_path = public;
alter function public.generate_visit_number()          set search_path = public;
alter function public.touch_updated_at()               set search_path = public;
alter function public.current_patient_id()             set search_path = public;
alter function public.set_patient_context(uuid)        set search_path = public;
alter function public.enforce_payment_before_release() set search_path = public;
alter function public.recalc_visit_payment()           set search_path = public;
alter function public.advance_test_on_result_upload()  set search_path = public;

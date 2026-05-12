-- =============================================================================
-- 0031_op_gl_bridge_fixes.sql
-- =============================================================================
-- Fix-forward addressing two gaps surfaced in controller review after
-- migration 0030 (12.2.1) smoke:
--
--   GAP 1 — resolve_revenue_account and resolve_discount_account only handled
--   four of the six valid services.kind enum values. Production has 4 rows of
--   kind='home_service' and 2 rows of kind='vaccine', both of which fell
--   through to 9999 Suspense on release, polluting the GL and triggering
--   admin reclassification notifications.
--
--   Fix: extend both resolvers to cover all six kinds:
--     lab_test, lab_package, home_service, vaccine → 4100 / 4910
--     doctor_consultation, doctor_procedure        → 4200 | 4500 / 4920
--
--   GAP 2 — smoke test left je_year_counters.next_n at 13 for fiscal_year
--   2026 (JEs JE-2026-0003 through JE-2026-0012 were generated; cleanup
--   removed the JE rows but the counter is never decremented on delete).
--   Reset to 1 so the first real production JE in 2026 is JE-2026-0001.
-- =============================================================================

-- ---- Resolver fix: resolve_revenue_account ----------------------------------
-- All six kind values now have an explicit mapping:
--   lab_test, lab_package, home_service, vaccine → 4100 Lab Tests Sales Revenue
--   doctor_consultation                          → 4200 Doctor Consultation Sales Revenue
--   doctor_procedure                             → 4500 Procedures
-- Any future/unknown kind still falls back to 9999 Suspense.

create or replace function public.resolve_revenue_account(p_service_kind text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_code text;
begin
  v_code := case p_service_kind
    when 'lab_test'            then '4100'
    when 'lab_package'         then '4100'
    when 'home_service'        then '4100'
    when 'vaccine'             then '4100'
    when 'doctor_consultation' then '4200'
    when 'doctor_procedure'    then '4500'
    else null
  end;
  if v_code is null then
    return public.coa_uuid_for_code('9999');
  end if;
  return coalesce(public.coa_uuid_for_code(v_code), public.coa_uuid_for_code('9999'));
end;
$$;

-- ---- Resolver fix: resolve_discount_account ---------------------------------
-- Lab-side (lab_test, lab_package, home_service, vaccine) → 4910
-- Doctor-side (doctor_consultation, doctor_procedure)     → 4920
-- Any unknown kind → 4920 (conservative: lumps into doctor discount contra)

create or replace function public.resolve_discount_account(p_service_kind text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_code text;
begin
  v_code := case
    when p_service_kind in ('lab_test', 'lab_package', 'home_service', 'vaccine') then '4910'
    else '4920'
  end;
  return coalesce(public.coa_uuid_for_code(v_code), public.coa_uuid_for_code('9999'));
end;
$$;

-- ---- Counter reset: 2026 JE sequence ----------------------------------------
-- Smoke test left next_n = 13; reset so first real production JE is JE-2026-0001.

update public.je_year_counters
   set next_n = 1
 where fiscal_year = 2026;

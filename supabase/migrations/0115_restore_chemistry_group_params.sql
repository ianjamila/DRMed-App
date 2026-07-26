-- =============================================================================
-- 0115_restore_chemistry_group_params.sql
-- =============================================================================
-- Data repair. The consolidated CHEMISTRY report-group template seeded by
-- `0053_chemistry_seed` lost 13 of its 14 parameter rows in production.
--
-- What 0053 built (2026-05-22):
--   * a CHEMISTRY report_group,
--   * `services.report_group_id = CHEMISTRY` on the 12 chemistry services,
--   * their per-service `result_templates` deactivated, and
--   * ONE group template (`service_id is null`, `report_group_id = CHEMISTRY`)
--     carrying 14 param rows — 12 analytes, with Creatinine and Uric Acid
--     split into F/M variants.
--
-- What prod actually held before this migration: 1 param row — "Uric Acid" (F,
-- sort_order 40). That is precisely the row protected from deletion by a
-- `result_values.parameter_id` FK (no ON DELETE CASCADE), which is how we know
-- the other 13 were deleted after the fact rather than never inserted: the
-- statement recorded for 0053 in `supabase_migrations.schema_migrations` does
-- contain all 14 value rows. No audit_log entry exists for the deletion, and
-- neither the admin template editor (keyed on `service_id`; the group template
-- has `service_id is null`) nor `scripts/wipe-operational.ts` (never touches
-- `result_template_params`) can produce it — so it was an ad-hoc SQL session.
--
-- Why this is the fix, and why reactivating the per-service templates is not:
-- `queue/[id]/page.tsx` redirects UNCONDITIONALLY to the consolidated form for
-- any service carrying a `report_group_id`, so the 12 deactivated per-service
-- templates are unreachable whether active or not. Chemistry result entry is
-- broken because the form the medtech is redirected to renders a single field.
-- Prod evidence: 3 consolidated results ever attempted, 1 result value ever
-- recorded. The 12 per-service templates are deliberately left inactive.
--
-- Idempotent by (template_id, parameter_name, gender): re-running is a no-op,
-- and on a fresh database built from migrations 0053 has already inserted all
-- 14 rows so this migration matches nothing. It never UPDATEs or DELETEs, so
-- the surviving Uric Acid (F) row keeps its id and its result_values reference.
-- Values below are copied verbatim from 0053 — same analytes, units, reference
-- ranges, genders, sort orders and SI→conventional factors.
-- =============================================================================

with tpl as (
  select rt.id
    from public.result_templates rt
    join public.report_groups rg on rg.id = rt.report_group_id
   where rg.code = 'CHEMISTRY'
     and rt.service_id is null
),
seed (sort_order, parameter_name, unit_si, unit_conv,
      ref_low_si, ref_high_si, ref_low_conv, ref_high_conv,
      gender, si_to_conv_factor) as (
  values
    (10,  'FBS',           'mmol/L', 'mg/dL', 4.1::numeric,   5.9::numeric,
                                              73.87::numeric, 106.31::numeric,
                                              null::text,     18.0182::numeric),
    (20,  'BUN',           'mmol/L', 'mg/dL', 2.1::numeric,   7.1::numeric,
                                              5.88::numeric,  19.89::numeric,
                                              null::text,     2.8::numeric),
    (30,  'Creatinine',    'umol/L', 'mg/dL', 45::numeric,    84::numeric,
                                              0.51::numeric,  0.95::numeric,
                                              'F'::text,      0.0113::numeric),
    (31,  'Creatinine',    'umol/L', 'mg/dL', 59::numeric,    104::numeric,
                                              0.67::numeric,  1.18::numeric,
                                              'M'::text,      0.0113::numeric),
    (40,  'Uric Acid',     'umol/L', 'mg/dL', 142::numeric,   339::numeric,
                                              2.38::numeric,  5.7::numeric,
                                              'F'::text,      0.01681::numeric),
    (41,  'Uric Acid',     'umol/L', 'mg/dL', 202.3::numeric, 416.5::numeric,
                                              3.4::numeric,   6.99::numeric,
                                              'M'::text,      0.01681::numeric),
    (50,  'Triglycerides', 'mmol/L', 'mg/dL', 0::numeric,     1.7::numeric,
                                              0::numeric,     150.44::numeric,
                                              null::text,     88.5::numeric),
    (60,  'Cholesterol',   'mmol/L', 'mg/dL', 0::numeric,     5.2::numeric,
                                              0::numeric,     200::numeric,
                                              null::text,     38.6::numeric),
    (70,  'HDL',           'mmol/L', 'mg/dL', 0.78::numeric,  2.2::numeric,
                                              30::numeric,    85::numeric,
                                              null::text,     38.46::numeric),
    (80,  'LDL',           'mmol/L', 'mg/dL', 0::numeric,     3.3::numeric,
                                              0::numeric,     127.41::numeric,
                                              null::text,     38.6::numeric),
    (90,  'VLDL',          'mmol/L', 'mg/dL', 0::numeric,     0.78::numeric,
                                              0::numeric,     30::numeric,
                                              null::text,     38.46::numeric),
    (100, 'SGPT (ALT)',    'U/L',    'U/L',   0::numeric,     41::numeric,
                                              0::numeric,     41::numeric,
                                              null::text,     1::numeric),
    (110, 'SGOT (AST)',    'U/L',    'U/L',   0::numeric,     37::numeric,
                                              0::numeric,     37::numeric,
                                              null::text,     1::numeric),
    (120, 'HBA1C',         '%',      '%',     4.5::numeric,   6.5::numeric,
                                              4.5::numeric,   6.5::numeric,
                                              null::text,     1::numeric)
)
insert into public.result_template_params
  (template_id, sort_order, section, is_section_header, parameter_name,
   input_type, unit_si, unit_conv,
   ref_low_si, ref_high_si, ref_low_conv, ref_high_conv,
   gender, si_to_conv_factor, allowed_values, abnormal_values, placeholder)
select t.id, s.sort_order, null, false, s.parameter_name,
       'numeric', s.unit_si, s.unit_conv,
       s.ref_low_si, s.ref_high_si, s.ref_low_conv, s.ref_high_conv,
       s.gender, s.si_to_conv_factor, null, null, null
  from tpl t
  cross join seed s
 where not exists (
   select 1
     from public.result_template_params p
    where p.template_id = t.id
      and p.parameter_name = s.parameter_name
      and p.gender is not distinct from s.gender
 );

-- Guard: the consolidated form is only usable with the full analyte set, so
-- fail the migration loudly rather than leaving a half-repaired template.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.result_template_params p
    join public.result_templates rt on rt.id = p.template_id
    join public.report_groups rg on rg.id = rt.report_group_id
   where rg.code = 'CHEMISTRY'
     and rt.service_id is null;

  if v_count <> 14 then
    raise exception
      'CHEMISTRY group template must carry 14 params after repair, found %',
      v_count;
  end if;
end $$;

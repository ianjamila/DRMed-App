-- =============================================================================
-- 0053_chemistry_seed.sql
-- =============================================================================
-- Chemistry consolidated form seed.
--
-- 1. Insert the CHEMISTRY report_group.
-- 2. Map 12 active chemistry services to the group:
--      FBS_RBS, BUN, CREATININE, BUA_URIC_ACID, TRIGLYCERIDES, CHOLESTEROL,
--      HDL_LDL_VLDL, SGPT_ALT, SGOT_AST, HBA1C, LIPID_PROFILE,
--      LIPID_PROFILE_PACKAGE.
-- 3. Deactivate the per-service Chemistry-overlapping templates.
-- 4. Insert the 13-row consolidated dual_unit template + 14 param rows
--    (Creatinine and Uric Acid have gender-specific overrides → 2 rows each).
-- =============================================================================

-- ----- 1. Chemistry report group --------------------------------------------
insert into public.report_groups (code, name)
values ('CHEMISTRY', 'Chemistry')
on conflict (code) do nothing;

-- ----- 2. Map active chemistry services to the group ------------------------
update public.services
   set report_group_id = (select id from public.report_groups where code='CHEMISTRY')
 where code in (
   'FBS_RBS', 'BUN', 'CREATININE', 'BUA_URIC_ACID',
   'TRIGLYCERIDES', 'CHOLESTEROL', 'HDL_LDL_VLDL',
   'SGPT_ALT', 'SGOT_AST', 'HBA1C',
   'LIPID_PROFILE', 'LIPID_PROFILE_PACKAGE'
 );

-- ----- 3. Deactivate per-service Chemistry-overlapping templates ------------
update public.result_templates
   set is_active = false
 where service_id in (
   select id from public.services
    where code in (
      'FBS_RBS', 'BUN', 'CREATININE', 'BUA_URIC_ACID',
      'TRIGLYCERIDES', 'CHOLESTEROL', 'HDL_LDL_VLDL',
      'SGPT_ALT', 'SGOT_AST', 'HBA1C',
      'LIPID_PROFILE', 'LIPID_PROFILE_PACKAGE'
    )
 );

-- ----- 4. Chemistry consolidated template -----------------------------------
with new_tpl as (
  insert into public.result_templates (service_id, report_group_id, layout,
                                       header_notes, footer_notes, is_active)
  values (
    null,
    (select id from public.report_groups where code='CHEMISTRY'),
    'dual_unit',
    null,
    null,
    true
  )
  returning id
)
insert into public.result_template_params
  (template_id, sort_order, section, is_section_header, parameter_name,
   input_type, unit_si, unit_conv,
   ref_low_si, ref_high_si, ref_low_conv, ref_high_conv,
   gender, si_to_conv_factor, allowed_values, abnormal_values, placeholder)
select t.id, x.sort_order, null, false, x.parameter_name,
       'numeric', x.unit_si, x.unit_conv,
       x.ref_low_si, x.ref_high_si, x.ref_low_conv, x.ref_high_conv,
       x.gender, x.si_to_conv_factor, null, null, null
  from new_tpl t
  cross join (values
    -- (sort_order, parameter_name, unit_si, unit_conv,
    --  ref_low_si, ref_high_si, ref_low_conv, ref_high_conv,
    --  gender, si_to_conv_factor)
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
  ) as x(sort_order, parameter_name, unit_si, unit_conv,
         ref_low_si, ref_high_si, ref_low_conv, ref_high_conv,
         gender, si_to_conv_factor);

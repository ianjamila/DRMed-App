-- =============================================================================
-- 0020_seed_specialties_and_flags.sql
-- =============================================================================
-- Data migration paired with 0019:
--
--   * 15 specialty_codes rows — one per consultation specialty + the
--     virtual "general" code that every physician accepts.
--   * services.specialty_code populated by mapping each CONSULT_* code
--     to its specialty.
--   * services.fasting_required marked for FBS / RBS, lipid, and OGTT
--     tests (the ones reception currently flags on the receipt).
--   * services.requires_time_slot marked for every ULTRASOUND_* —
--     reception assigns a real Wed/Fri 8 AM slot for these manually.
--   * physician_specialties: each physician's primary specialty plus
--     "general" so the General Consultation specialty resolves to the
--     full roster.
-- =============================================================================

insert into public.specialty_codes (code, label, display_order) values
  ('general',          'General Consultation',  10),
  ('family_medicine',  'Family Medicine',       20),
  ('obgyn',            'OB-GYN',                30),
  ('pediatrics',       'Pediatrics',            40),
  ('cardiology',       'Cardiology',            50),
  ('pulmonology',      'Pulmonology',           60),
  ('gastroenterology', 'Gastroenterology',      70),
  ('nephrology',       'Nephrology',            80),
  ('diabetology',      'Diabetology',           90),
  ('oncology',         'Oncology',             100),
  ('ent',              'ENT',                  110),
  ('ophthalmology',    'Ophthalmology',        120),
  ('radiology',        'Radiology',            130),
  ('surgery',          'Surgery',              140),
  ('psychiatry',       'Psychiatry',           150)
on conflict (code) do nothing;

-- Map each consultation service to its specialty. The CONSULT_* code
-- prefixes are stable so a plain CASE works without extra config.
update public.services set specialty_code = case
  when code = 'CONSULT_IM_CARDIO' then 'cardiology'
  when code = 'CONSULT_IM_DIABE'  then 'diabetology'
  when code = 'CONSULT_ENT'       then 'ent'
  when code = 'CONSULT_FAMMED'    then 'family_medicine'
  when code = 'CONSULT_IM_GASTRO' then 'gastroenterology'
  when code = 'CONSULT_IM_NEPHRO' then 'nephrology'
  when code = 'CONSULT_OBGYN'     then 'obgyn'
  when code = 'CONSULT_IM_ONCO'   then 'oncology'
  when code = 'CONSULT_OPHTHA'    then 'ophthalmology'
  when code = 'CONSULT_PEDIA'     then 'pediatrics'
  when code = 'CONSULT_PSYCH'     then 'psychiatry'
  when code = 'CONSULT_IM_PULMO'  then 'pulmonology'
  when code = 'CONSULT_RADIO'     then 'radiology'
  when code = 'CONSULT_SURGERY'   then 'surgery'
end
where kind = 'doctor_consultation';

-- Fasting flags. Conservative match — only services whose names clearly
-- indicate the fast.
update public.services set fasting_required = true
where code in (
  'FBS_RBS',
  'LIPID_PROFILE',
  'LIPID_PROFILE_PACKAGE',
  'OGTT_75G',
  'OGTT_100G'
);

-- Imaging that needs a real time slot.
update public.services set requires_time_slot = true
where code like 'ULTRASOUND_%';

-- Physician specialties — one row for the doctor's primary specialty
-- (derived from the free-text physicians.specialty field). General is
-- added to every physician below.
insert into public.physician_specialties (physician_id, code)
select id, code from (
  select p.id,
    case
      when p.specialty ilike 'OB-GYN'           then 'obgyn'
      when p.specialty ilike 'Family Medicine'  then 'family_medicine'
      when p.specialty ilike 'Pediatrician'     then 'pediatrics'
      when p.specialty ilike '%Cardiologist%'   then 'cardiology'
      when p.specialty ilike '%Pulmonologist%'  then 'pulmonology'
      when p.specialty ilike '%Gastroenterologist%' then 'gastroenterology'
      when p.specialty ilike '%Oncologist%'     then 'oncology'
      when p.specialty ilike '%Diabetologist%'  then 'diabetology'
      when p.specialty ilike '%Nephrologist%'   then 'nephrology'
      when p.specialty ilike 'ENT'              then 'ent'
      when p.specialty ilike 'Ophthalmologist'  then 'ophthalmology'
      when p.specialty ilike 'Radiologist'      then 'radiology'
      when p.specialty ilike 'Surgeon'          then 'surgery'
      when p.specialty ilike 'Psychiatrist'     then 'psychiatry'
    end as code
  from public.physicians p
) mapped
where code is not null
on conflict do nothing;

-- General consultation is available for all active physicians.
insert into public.physician_specialties (physician_id, code)
select id, 'general' from public.physicians where is_active
on conflict do nothing;

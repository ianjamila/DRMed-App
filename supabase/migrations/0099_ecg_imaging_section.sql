-- =============================================================================
-- 0099_ecg_imaging_section.sql
-- =============================================================================
-- Partner request: 12-Lead ECG is handled by the X-ray technician, not the
-- medtech bench.  Reclassify the ECG service from section='chemistry' to the
-- new section='imaging_ecg' so it appears in the xray_technician queue and
-- disappears from the medtech queue.
--
-- Changes:
--   1. Drop the existing services.section CHECK constraint and re-add it with
--      'imaging_ecg' appended after 'imaging_ultrasound' in the allowed list.
--   2. Move ECG row: set section = 'imaging_ecg' where code = 'ECG'.
--
-- Notes:
--   - imaging sections carry kind='lab_test'; there is no imaging "kind".
--   - The constraint is named services_section_check (PostgreSQL's default
--     auto-name for an inline column CHECK on the section column).
--   - Drop is guarded with IF EXISTS so re-running this migration is safe.
-- =============================================================================

-- 1. Expand the section allowlist to include the new 'imaging_ecg' value.
alter table public.services
  drop constraint if exists services_section_check;

alter table public.services
  add constraint services_section_check
  check (section in (
    'package',
    'chemistry',
    'hematology',
    'immunology',
    'urinalysis',
    'microbiology',
    'imaging_xray',
    'imaging_ultrasound',
    'imaging_ecg',
    'vaccine',
    'send_out',
    'consultation',
    'procedure',
    'home_service'
  ));

-- 2. Move 12-Lead ECG out of chemistry and into imaging_ecg.
update public.services
  set section = 'imaging_ecg'
  where code = 'ECG';

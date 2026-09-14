-- =============================================================================
-- 0144_backfill_retired_service_sections.sql
-- =============================================================================
-- The Lab TAT report groups by `services.section`, so every released line whose
-- service carries no section lands in a single "(unset)" row. After PR #162's
-- doctor-line fix that row was still ~2,491 lines deep — genuine lab work,
-- invisible in a per-section report and blank in the CSV's Section column.
--
-- They come from TWELVE retired catalog rows. All twelve are already
-- `is_active = false`: they are the pre-repricing duplicates that the live,
-- sectioned catalog replaced (`SGPT` → `SGPT_ALT`, `LIPID` →
-- `LIPID_PROFILE_PACKAGE`, `USABDOMEN` → `ULTRASOUND_WHOLE_ABDOMEN`, …), kept
-- for FK/history exactly like the per-specialty consultations 0090 retired.
-- Being inactive is what makes this safe and final: no picker offers them, so
-- no NEW line can ever land on one. This backfill is a pure history fix —
-- assign the section the work was actually done in, once, and the "(unset)"
-- bucket stops hiding it.
--
-- Each section below is MATCHED from the live row that replaced the retired
-- one, never guessed:
--
--   SGPT, SGOT   → chemistry          (live SGPT_ALT / SGOT_AST are chemistry)
--   FBS, CREA    → chemistry          (live CREATININE is chemistry)
--   CBC          → hematology         (a complete blood count is bench haem)
--   HBSAG        → immunology         (live HBSAG_SCREENING is immunology)
--   XRAYCHEST    → imaging_xray       (live XRAY_CHEST_PA is imaging_xray)
--   USABDOMEN    → imaging_ultrasound (live ULTRASOUND_WHOLE_ABDOMEN)
--   LIPID,
--   THYROID,
--   THYROID_FUNCTION_TSH_FT4
--                → package            (see below)
--
-- The three package rows are matched on KIND, not on name. `LIPID` is a
-- `lab_package`, and the live `lab_package` it maps to is
-- `LIPID_PROFILE_PACKAGE`, which sits in `package` — even though the live
-- lab_test of the same name (`LIPID_PROFILE`) sits in `chemistry`. Sectioning
-- a package by the bench that happens to run most of its components would put
-- the two thyroid packages in three different sections between them; the
-- kind→section rule keeps every package in one place and matches how the live
-- catalog is already organised.
--
-- `LEGACY-LAB` ("Legacy lab test", ₱0, 334 released lines, 2024-02 → 2026-05)
-- is deliberately LEFT UNSECTIONED. It is the import catch-all from the
-- pre-app data migration: one code standing in for whatever the paper record
-- said, spanning every bench. There is no section it honestly belongs to, and
-- inventing one would attribute 334 lines of mixed provenance to a bench that
-- may never have run them. It stays in "(unset)", which — now that it is the
-- only thing there — is an accurate label rather than a dumping ground.
--
-- Idempotent and deliberately narrow: the WHERE clause re-states
-- `section is null` and `is_active = false`, so re-running is a no-op and the
-- statement can never touch a live catalog row even if a code were reused.

update public.services as s
set section = v.section
from (values
  ('SGPT',                     'chemistry'),
  ('SGOT',                     'chemistry'),
  ('FBS',                      'chemistry'),
  ('CREA',                     'chemistry'),
  ('CBC',                      'hematology'),
  ('HBSAG',                    'immunology'),
  ('XRAYCHEST',                'imaging_xray'),
  ('USABDOMEN',                'imaging_ultrasound'),
  ('LIPID',                    'package'),
  ('THYROID',                  'package'),
  ('THYROID_FUNCTION_TSH_FT4', 'package')
) as v(code, section)
where s.code = v.code
  and s.section is null
  and s.is_active = false
  and s.kind in ('lab_test', 'lab_package');

-- Guard: after this runs, the only unsectioned LAB service left must be the
-- LEGACY-LAB catch-all. A new unsectioned lab service appearing here means
-- someone seeded a catalog row without a section — fail the migration rather
-- than silently growing the "(unset)" bucket back.
do $$
declare
  leftovers text;
begin
  select string_agg(code, ', ' order by code)
    into leftovers
  from public.services
  where section is null
    and kind in ('lab_test', 'lab_package')
    and code <> 'LEGACY-LAB';

  if leftovers is not null then
    raise exception
      'Unsectioned lab services remain after backfill: %. Give each a section (or add it to this migration if it is another retired duplicate).',
      leftovers;
  end if;
end $$;

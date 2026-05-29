-- Allow the public /register self-registration flow to record RA 10173 consent
-- via a new patient_consents.method value. Additive + safe: only widens the
-- method CHECK constraint. No RLS/audit changes (no new table); the existing
-- sync_patient_consent_state() trigger already denormalises method/version onto
-- patients on insert. The pc_grant_fields CHECK still requires method +
-- notice_version + signatory for a 'granted' row, which self_registration supplies.
--
-- The constraint was created inline in 0086, so Postgres auto-named it
-- patient_consents_method_check (consistent across environments). Drop by name
-- (IF EXISTS) and re-add with the widened value set.

alter table public.patient_consents
  drop constraint if exists patient_consents_method_check;

alter table public.patient_consents
  add constraint patient_consents_method_check
    check (method in (
      'paper_wet_signature',
      'onscreen_signature',
      'portal_acceptance',
      'self_registration'
    ));

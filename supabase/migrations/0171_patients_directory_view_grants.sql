-- 0171: v_patients_directory — logged-in staff may read it; nobody else gets anything.
--
-- 0143 created the view with only `grant select ... to authenticated`, but the
-- schema's default privileges had already handed ALL privileges (select,
-- insert, update, delete, truncate, references, trigger) to BOTH anon and
-- authenticated. Nothing was exposed — the view is security_invoker, so anon
-- reads run under patients RLS and return 0 rows (verified on prod
-- 2026-09-24), and the lateral join makes it non-updatable — but a logged-out
-- role holding every privilege on the patient directory is exactly the ACL
-- that turns into a leak the day the view or a policy changes.
--
-- Same shape as 0150 for v_patients_without_consent: revoke everything from
-- public/anon/authenticated first (a column or partial revoke is a no-op under
-- a table-level grant), then grant back the one privilege the Patients list
-- uses. service_role and postgres are untouched. `create or replace view`
-- keeps grants, so a later redefinition (e.g. patient-delete's planned 0167)
-- inherits this; supabase/seed.sql mirrors it so `db reset` does not hand the
-- privileges back locally (seed-grant-parity.test.ts).

revoke all on public.v_patients_directory from public, anon, authenticated;
grant select on public.v_patients_directory to authenticated;

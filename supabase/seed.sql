-- =============================================================================
-- supabase/seed.sql — runs automatically after migrations on `supabase db reset`
-- =============================================================================
-- LOCAL / CI ONLY. `db.seed` in config.toml is a reset-time mechanism; this file
-- is never executed against a hosted project, and `supabase db push` ignores it.
--
-- WHY THIS EXISTS
-- ---------------
-- A hosted Supabase project ships default ACLs that grant anon, authenticated
-- and service_role DML on every new table in `public`. A local stack does not:
-- after a reset every table comes out as
--
--     anon=Dxtm/postgres authenticated=Dxtm/postgres service_role=Dxtm/postgres
--
-- which is TRUNCATE / REFERENCES / TRIGGER / MAINTAIN and no SELECT, INSERT,
-- UPDATE or DELETE at all. The database replays cleanly and is then unusable:
-- the seed scripts fail with `permission denied for table services`, and the app
-- cannot read anything. Every reset has needed the same manual GRANT afterwards,
-- rediscovered each time.
--
-- Applying it here means `supabase db reset` produces a working local database
-- on its own, which is the point of making the replay complete in the first
-- place.
--
-- ⚠ TABLES AND SEQUENCES ONLY — NEVER ROUTINES.
-- `grant ... on all functions in schema public` would hand EXECUTE back to anon
-- and authenticated and silently undo migration 0118, which spent a whole PR
-- revoking it from 75 SECURITY DEFINER functions. Function grants are the
-- migrations' business; this file must not touch them.
--
-- Access control is unaffected: RLS is still the gate. These grants are what
-- lets a policy be evaluated at all — without them PostgREST fails before RLS
-- is ever consulted.
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

-- Existing objects (everything the migrations just created).
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;

-- Objects created later in this local database — e.g. a new migration applied
-- with `supabase migration up` rather than a full reset — so the grant does not
-- have to be remembered a second time. Again: no `on functions` clause here.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

do $$
begin
  raise notice
    'seed.sql: granted table + sequence access in public to anon/authenticated/service_role (local reset only; RLS still governs access; function grants deliberately untouched — see 0118).';
end $$;

-- ⚠ Same hazard as the routines above, one level down: the blanket
-- `grant all on all tables` includes VIEWS, so it hands `anon` back the SELECT
-- that migration 0134 deliberately revoked on the two 0043 admin-report views.
-- Prod never sees this (`db push` ignores seed.sql), so without the carve-out a
-- fresh local database silently disagrees with prod on exactly the grant 0134
-- exists to remove. Re-revoke, explicitly and by name — same classify-don't-
-- blanket rule as 0118.
revoke all on public.v_daily_revenue_by_service   from anon;
revoke all on public.v_staff_advances_outstanding from anon;

-- Same carve-out for 0135. These five go further than 0134 — `authenticated`
-- is revoked too, because no route reads them through the RLS-scoped client —
-- so the local re-revoke has to name both roles or a fresh local database
-- disagrees with prod on the grant that closed the anon HMO disclosure.
revoke all on public.v_hmo_unbilled         from anon, authenticated;
revoke all on public.v_hmo_stuck            from anon, authenticated;
revoke all on public.v_hmo_ar_aging         from anon, authenticated;
revoke all on public.v_hmo_provider_summary from anon, authenticated;
revoke all on public.v_inventory_balances   from anon, authenticated;

-- And 0136's side table. RLS already denies anon here, so this is defence in
-- depth rather than the only lock — but without it a local database hard-denies
-- nothing while prod hard-denies at the grant, and the replay stops matching
-- what it is supposed to prove.
revoke all on public.physician_compensation from anon;

-- And 0148's nine operational daily views. Unlike 0134/0135, nothing granted
-- these explicitly — the `alter default privileges` lines above hand every new
-- view in `public` to anon/authenticated on creation, which is exactly how the
-- grants 0148 removes got there in the first place. So this carve-out is not
-- undoing a deliberate grant, it is stopping the blanket from re-applying one.
-- RLS + security_invoker already return zero rows to either role; this keeps
-- the local ACL identical to prod so a replay proves what it claims to.
revoke all on public.v_ops_daily_channel          from anon, authenticated;
revoke all on public.v_ops_daily_collections      from anon, authenticated;
revoke all on public.v_ops_daily_doctor           from anon, authenticated;
revoke all on public.v_ops_daily_expense_accounts from anon, authenticated;
revoke all on public.v_ops_daily_expenses         from anon, authenticated;
revoke all on public.v_ops_daily_hmo_provider_ar  from anon, authenticated;
revoke all on public.v_ops_daily_hmo_received     from anon, authenticated;
revoke all on public.v_ops_daily_pnl              from anon, authenticated;
revoke all on public.v_ops_daily_totals           from anon, authenticated;

-- 0150: preserve the consent report's authenticated-SELECT-only ACL after the
-- blanket local grants above, matching the migration and production.
revoke all on public.v_patients_without_consent from public, anon, authenticated;
grant select on public.v_patients_without_consent to authenticated;
-- 0171: the Patients list view — authenticated SELECT only, like 0150, after the
-- blanket local grants above, matching the migration and production.
revoke all on public.v_patients_directory from public, anon, authenticated;
grant select on public.v_patients_directory to authenticated;
-- 0154: the Website Messages inbox. The public contact form inserts with the
-- service-role client, so anon gets nothing (0004's anon INSERT policy is
-- gone), and staff get SELECT + UPDATE only — RLS narrows that to
-- reception/admin, and "Closed" is how a message is dismissed, never DELETE.
revoke all on public.contact_messages from anon;
revoke all on public.contact_messages from authenticated;
grant select, update on public.contact_messages to authenticated;
-- 0154, second table: the append-only reply log. Staff read and insert (as
-- themselves, per RLS); nobody updates or deletes a reply that was sent.
revoke all on public.contact_message_replies from anon;
revoke all on public.contact_message_replies from authenticated;
grant select, insert on public.contact_message_replies to authenticated;
-- 0155: Email Alerts settings are admin-only (RLS) and never reachable by anon.
-- Settings rows are seeded by the migration — staff may update, never insert
-- or delete them; recipient rows are fully managed by admins.
revoke all on public.staff_alert_settings from anon;
revoke all on public.staff_alert_settings from authenticated;
grant select, update on public.staff_alert_settings to authenticated;
revoke all on public.staff_alert_recipients from anon;
revoke all on public.staff_alert_recipients from authenticated;
grant select, insert, update, delete on public.staff_alert_recipients to authenticated;

-- 0167: patient views (the directory view's mirror already exists from 0171 —
-- do not duplicate it). The dedup view is service_role-only; the admin
-- inclusive view is authenticated-only (its WHERE limits it to admins).
revoke all on public.v_patients_directory_admin from public, anon, authenticated, service_role;
grant select on public.v_patients_directory_admin to authenticated;
revoke all on public.v_patient_dedup_candidate_pairs from public, anon, authenticated;
grant select on public.v_patient_dedup_candidate_pairs to service_role;

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

-- 0119: stop the anon/authenticated EXECUTE grants from coming back on every new
--       function. Companion to 0118 — 0118 cleans up the functions that already
--       exist, this one fixes the source.
--
-- THE ROOT CAUSE
-- --------------
-- This is the third time this defect has shipped (0112 -> 0113 -> 0118). It keeps
-- recurring because two separate mechanisms grant EXECUTE on every newly created
-- function in `public`, and both have to be dealt with:
--
--   1. Supabase's own default privileges. `pg_default_acl` carries an entry for
--      (role postgres, schema public, functions) granting EXECUTE to `anon`,
--      `authenticated` and `service_role`. Migrations run as `postgres`, so every
--      function a migration creates picks these up directly.
--
--   2. Postgres's HARD-WIRED default, which grants EXECUTE on new functions to
--      PUBLIC. This one is not visible in `pg_default_acl` at all, and anon and
--      authenticated inherit it. It is the reason 65 of the 75 functions 0118 had
--      to fix were still reachable even where the direct grants were absent.
--
-- THE NON-OBVIOUS PART
-- --------------------
-- `ALTER DEFAULT PRIVILEGES ... IN SCHEMA public ... REVOKE EXECUTE ON FUNCTIONS
-- FROM PUBLIC` does NOT work. It reports success and stores nothing, and new
-- functions remain PUBLIC-executable. Verified on Postgres 17: after running the
-- schema-scoped revoke against a replica of this project's exact default-ACL
-- state, a freshly created function still came out `anon = true`. Writing only
-- that statement would have looked like a fix and changed nothing.
--
-- Only the SCHEMA-LESS form removes the hard-wired PUBLIC grant, because a
-- schema-qualified default-ACL entry is ADDED to the hard-wired default, whereas
-- the schema-less entry replaces it. Hence the split below: the PUBLIC revoke has
-- to be global, and the anon/authenticated revoke has to be schema-scoped to
-- cancel Supabase's own entry.
--
-- BLAST RADIUS
-- ------------
-- The global revoke would otherwise apply to every schema `postgres` creates
-- functions in — which on this project also includes `extensions` (49 extension
-- functions, e.g. from a future `create extension`). Those are expected to be
-- world-executable, and a column DEFAULT calling one is evaluated as the
-- *inserting* role, so quietly tightening them could break writes. The last
-- statement therefore restores the permissive defaults for `extensions` only,
-- keeping this change targeted at `public`.
--
-- Existing functions are NOT affected by any of this — default privileges apply
-- only to objects created afterwards. 0118 is what fixes the current ones.
--
-- CONSEQUENCE FOR FUTURE MIGRATIONS  <-- read this before adding a function
-- ---------------------------------
-- From here on, a new function in `public` is reachable by `postgres` and
-- `service_role` only. That is the right default for this codebase: essentially
-- every function here is called through the service-role admin client.
--
-- If you add a function that genuinely needs to be callable by the browser or by
-- a signed-in staff session — an RLS helper like `current_patient_id()` or
-- `has_role()`, or a public RPC — you must now say so explicitly:
--
--     grant execute on function public.your_fn(...) to anon, authenticated;
--
-- That is the point: public reachability becomes a deliberate, greppable, one-line
-- declaration in the migration instead of an invisible default.
--
-- Note this cannot cover functions created by `supabase_admin` (its own
-- default-ACL entry for `public` also grants anon/authenticated, and `postgres`
-- cannot alter another role's defaults). Migrations run as `postgres`, so that
-- path is not used by this repo.

-- 1. Drop Postgres's hard-wired PUBLIC EXECUTE on new functions. MUST be
--    schema-less — the `in schema public` form silently does nothing here.
alter default privileges for role postgres
  revoke execute on functions from public;

-- 2. Cancel Supabase's anon/authenticated grants for new functions in `public`.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

-- 3. Keep `service_role` — the admin client is how this app calls its functions.
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

-- 4. Undo step 1's reach into `extensions`, so installing an extension keeps
--    behaving exactly as it does today.
alter default privileges for role postgres in schema extensions
  grant execute on functions to public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Self-verification: create a throwaway function and check what it actually
-- inherits. Asserting on `pg_default_acl` alone would not have caught the
-- schema-scoped-revoke trap described above, because that statement stores a
-- plausible-looking entry while changing nothing.
-- ---------------------------------------------------------------------------
do $$
begin
  create function public.drmed_0119_probe() returns int language sql as 'select 1';

  if has_function_privilege('anon', 'public.drmed_0119_probe()', 'EXECUTE') then
    raise exception '0119: new functions in public are still anon-executable — the default-privilege fix did not take';
  end if;

  if has_function_privilege('authenticated', 'public.drmed_0119_probe()', 'EXECUTE') then
    raise exception '0119: new functions in public are still authenticated-executable — the default-privilege fix did not take';
  end if;

  if not has_function_privilege('service_role', 'public.drmed_0119_probe()', 'EXECUTE') then
    raise exception '0119: service_role did NOT inherit EXECUTE on new functions — the admin client would break on every function added from now on';
  end if;

  if not has_function_privilege('postgres', 'public.drmed_0119_probe()', 'EXECUTE') then
    raise exception '0119: postgres did not inherit EXECUTE on new functions';
  end if;

  -- An explicit opt-in must still work, or anon-facing helpers become unwritable.
  execute 'grant execute on function public.drmed_0119_probe() to anon';
  if not has_function_privilege('anon', 'public.drmed_0119_probe()', 'EXECUTE') then
    raise exception '0119: explicit `grant execute ... to anon` no longer works';
  end if;

  drop function public.drmed_0119_probe();
end $$;

-- Belt and braces: make sure the probe is gone even if the block above was
-- edited later and left it behind.
drop function if exists public.drmed_0119_probe();

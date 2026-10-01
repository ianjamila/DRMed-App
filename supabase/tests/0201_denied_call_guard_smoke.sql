-- =============================================================================
-- 0201_denied_call_guard_smoke.sql
-- =============================================================================
-- DB proof for migration 0201 (api_request_guard, PostgREST db-pre-request).
-- Runs inside BEGIN/ROLLBACK and leaves no state.
--
-- SAFE ON EVERY IMAGE: it never makes a refused function call (that is the
-- call that segfaults images 17.6.1.106/.111). It calls only the guard, which
-- every request role may execute, and asks the catalog with
-- has_function_privilege(), which answers without refusing anything.
--
-- The end-to-end proof (real PostgREST v14 in front of image .111: before
-- 0201 one anonymous request restarts the server; after it the same request
-- gets a normal 401/42501) was run 2026-09-30 in throwaway containers — see
-- the PR. Re-run that way, never against prod.
--
-- Run (local stack, from the repo root, with 0201 applied):
--   /opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0201_denied_call_guard_smoke.sql
--
-- What it proves:
--   1. The authenticator carries pgrst.db_pre_request = public.api_request_guard.
--   2. anon, authenticated and service_role can all run the guard.
--   3. As anon, /rpc/<a service_role-only function> is refused with 42501 by
--      the guard itself; the guard's message matches Postgres's own.
--   4. As anon, /rpc/<an anon-executable function>, a missing function, a
--      table path and no path at all pass the guard.
--   5. The schema is chosen the way PostgREST chooses it: Content-Profile on a
--      POST, Accept-Profile on a GET/HEAD — the OTHER header is ignored, so a
--      GET carrying Content-Profile: graphql_public still means public. Since
--      0207 public is always checked too (see 0207_request_guard_smoke.sql).
--   5b. request.path is raw: an encoded name (zz%5Fguard...) and any other
--      non-identifier name is refused, not looked up.
--   6. As service_role, the service_role-only function passes.
--   7. No function taking a table row (a PostgREST computed field or
--      relationship) is denied to a role that can SELECT that table.
--   8. Every function in public/graphql_public has a plain identifier name
--      (the guard refuses any other).
-- =============================================================================

begin;

-- A service_role-only probe (0119 default) and an anon-executable one.
create function public.zz_guard_probe_denied() returns int language sql as 'select 1';
revoke all on function public.zz_guard_probe_denied() from public, anon, authenticated;
grant execute on function public.zz_guard_probe_denied() to service_role;
create function public.zz_guard_probe_ok() returns int language sql as 'select 2';
grant execute on function public.zz_guard_probe_ok() to anon;

do $$
begin
  -- 1
  if not exists (select 1 from pg_db_role_setting s
                  where s.setrole = 'authenticator'::regrole and s.setdatabase = 0
                    and 'pgrst.db_pre_request=public.api_request_guard' = any(s.setconfig)) then
    raise exception 'FAIL 1: authenticator has no pgrst.db_pre_request';
  end if;
  -- 2
  if exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(role)
              where not has_function_privilege(r.role, 'public.api_request_guard()', 'EXECUTE')) then
    raise exception 'FAIL 2: a request role cannot run the guard';
  end if;
  raise notice 'ok 1-2';
end;
$$;

set local role anon;

do $$
declare
  v_state text;
  v_msg   text;
begin
  -- 3
  perform set_config('request.path', '/rpc/zz_guard_probe_denied', true);
  perform set_config('request.method', 'POST', true);
  perform set_config('request.headers', '{}', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 3: guard let an anon call to a service_role-only function through';
  exception when insufficient_privilege then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42501' or v_msg <> 'permission denied for function zz_guard_probe_denied' then
      raise exception 'FAIL 3: unexpected refusal % %', v_state, v_msg;
    end if;
  end;
  -- 4
  perform set_config('request.path', '/rpc/zz_guard_probe_ok', true);
  perform public.api_request_guard();
  perform set_config('request.path', '/rpc/zz_no_such_function', true);
  perform public.api_request_guard();
  perform set_config('request.path', '/test_requests', true);
  perform public.api_request_guard();
  perform set_config('request.path', '', true);
  perform public.api_request_guard();
  -- 5: since 0207 the guard always checks public too (request.headers keeps
  -- only the LAST of a repeated profile header, PostgREST uses the FIRST), so
  -- a POST naming graphql_public is refused as well — PostgREST would 404 it.
  perform set_config('request.path', '/rpc/zz_guard_probe_denied', true);
  perform set_config('request.headers', '{"content-profile":"graphql_public"}', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 5: a POST naming graphql_public skipped the public check (0207)';
  exception when insufficient_privilege then null;
  end;
  -- ...and a GET ignores Content-Profile (PostgREST runs it in public): refused
  perform set_config('request.method', 'GET', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 5: a GET with Content-Profile slipped past the guard';
  exception when insufficient_privilege then null;
  end;
  -- ...and a POST ignores Accept-Profile
  perform set_config('request.method', 'POST', true);
  perform set_config('request.headers', '{"accept-profile":"graphql_public"}', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 5: a POST with Accept-Profile slipped past the guard';
  exception when insufficient_privilege then null;
  end;
  -- 5b: an encoded or otherwise non-identifier name is refused outright
  perform set_config('request.headers', '{}', true);
  perform set_config('request.path', '/rpc/zz%5Fguard%5Fprobe%5Fdenied', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 5b: an encoded name slipped past the guard';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.path', '/rpc/ZZ_GUARD_PROBE_OK', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 5b: a non-identifier name slipped past the guard';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok 3-5b';
end;
$$;

reset role;
set local role service_role;

do $$
begin
  -- 6
  perform set_config('request.path', '/rpc/zz_guard_probe_denied', true);
  perform set_config('request.headers', '{}', true);
  perform public.api_request_guard();
  raise notice 'ok 6';
end;
$$;

reset role;

do $$
declare
  v_bad text;
begin
  -- 7
  select string_agg(format('%s can SELECT %s but not run %s', r.role, c.relname, p.oid::regprocedure), '; ')
    into v_bad
    from (values ('anon'), ('authenticated')) r(role)
    join pg_proc p on p.pronargs >= 1
    join pg_namespace pn on pn.oid = p.pronamespace and pn.nspname = 'public'
    join pg_type t on t.oid = p.proargtypes[0]
    join pg_class c on c.oid = t.typrelid and c.relkind in ('r', 'p', 'v', 'm', 'f')
   where has_table_privilege(r.role, c.oid, 'SELECT')
     and not has_function_privilege(r.role, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'FAIL 7: %', v_bad;
  end if;
  -- 8
  select string_agg(format('%I.%s', n.nspname, p.proname), ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'graphql_public')
     and p.proname !~ '^[a-z_][a-z0-9_]*$';
  if v_bad is not null then
    raise exception 'FAIL 8: %', v_bad;
  end if;
  raise notice 'ok 7-8 — all 0201 checks passed';
end;
$$;

rollback;

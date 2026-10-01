-- =============================================================================
-- 0207_request_guard_smoke.sql
-- =============================================================================
-- DB proof for migration 0207 (api_request_guard hardening). Runs inside
-- BEGIN/ROLLBACK and leaves no state.
--
-- SAFE ON EVERY IMAGE: like the 0201 smoke it never makes a refused function
-- call (the call that segfaults images 17.6.1.106/.111) — it calls only the
-- guard. The end-to-end proof with real PostgREST v14.5 in front of image
-- .111 is supabase/tests/0207_request_guard_e2e.sh (throwaway containers).
--
-- Run (local stack, from the repo root, with 0201 + 0207 applied):
--   /opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0207_request_guard_smoke.sql
--
-- What it proves:
--   1. The guard is SECURITY INVOKER with no pinned settings (a pinned
--      search_path would hide the schema PostgREST chose).
--   2. Any percent-encoded path is refused — /%72pc/<fn>, /r%70c/<fn>, and a
--      non-rpc path — even when the decoded function is open to the role.
--   3. The schema PostgREST chose (first in search_path) is checked even when
--      the profile header names another one (the repeated-header case).
--   4. public is always checked, whatever the header and search_path say.
--   5. Legitimate calls still pass: an open function in public, graphql_public
--      .graphql with graphql_public chosen, a table path, no path.
-- =============================================================================

begin;

create function public.zz_guard_probe_denied() returns int language sql as 'select 1';
revoke all on function public.zz_guard_probe_denied() from public, anon, authenticated;
grant execute on function public.zz_guard_probe_denied() to service_role;
create function public.zz_guard_probe_ok() returns int language sql as 'select 2';
grant execute on function public.zz_guard_probe_ok() to anon;
-- A second "exposed" schema whose same-named function is closed while the
-- public one is open (the reverse of the repeated-header attack).
create schema zz_guard_other;
grant usage on schema zz_guard_other to anon;
create function zz_guard_other.zz_guard_probe_ok() returns int language sql as 'select 3';
revoke all on function zz_guard_other.zz_guard_probe_ok() from public, anon, authenticated;

do $$
begin
  -- 1
  if exists (select 1 from pg_proc
              where oid = 'public.api_request_guard()'::regprocedure
                and (prosecdef or proconfig is not null)) then
    raise exception 'FAIL 1: guard must be SECURITY INVOKER with no pinned settings';
  end if;
  raise notice 'ok 1';
end;
$$;

set local role anon;

do $$
declare
  v_path text;
begin
  perform set_config('request.method', 'POST', true);
  perform set_config('request.headers', '{}', true);
  perform set_config('search_path', 'public', true);
  -- 2
  foreach v_path in array array['/%72pc/zz_guard_probe_denied', '/r%70c/zz_guard_probe_denied',
                                 '/%72pc/zz_guard_probe_ok', '/test%5Frequests'] loop
    perform set_config('request.path', v_path, true);
    begin
      perform public.api_request_guard();
      raise exception 'FAIL 2: encoded path % passed the guard', v_path;
    exception when insufficient_privilege then null;
    end;
  end loop;
  raise notice 'ok 2';

  -- 3: PostgREST chose public (first in search_path) but the header that
  -- reaches request.headers names graphql_public — still refused
  perform set_config('request.path', '/rpc/zz_guard_probe_denied', true);
  perform set_config('request.headers', '{"content-profile":"graphql_public"}', true);
  perform set_config('search_path', 'public, public', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 3: the chosen schema (search_path) was not checked';
  exception when insufficient_privilege then null;
  end;
  -- ...and the reverse: PostgREST chose zz_guard_other (closed) while the
  -- header says public (open)
  perform set_config('request.path', '/rpc/zz_guard_probe_ok', true);
  perform set_config('request.headers', '{"content-profile":"public"}', true);
  perform set_config('search_path', 'zz_guard_other, public', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 3: a closed function in the chosen schema passed';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok 3';

  -- 4: header and search_path both say graphql_public — public is still checked
  perform set_config('request.path', '/rpc/zz_guard_probe_denied', true);
  perform set_config('request.headers', '{"content-profile":"graphql_public"}', true);
  perform set_config('search_path', 'graphql_public, public', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 4: public was not checked';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok 4';

  -- 5
  perform set_config('request.headers', '{}', true);
  perform set_config('search_path', 'public, public', true);
  perform set_config('request.path', '/rpc/zz_guard_probe_ok', true);
  perform public.api_request_guard();
  perform set_config('request.method', 'GET', true);
  perform public.api_request_guard();
  perform set_config('request.path', '/test_requests', true);
  perform public.api_request_guard();
  perform set_config('request.path', '', true);
  perform public.api_request_guard();
  perform set_config('request.method', 'POST', true);
  perform set_config('request.path', '/rpc/graphql', true);
  perform set_config('request.headers', '{"content-profile":"graphql_public"}', true);
  perform set_config('search_path', 'graphql_public, public', true);
  perform public.api_request_guard();
  raise notice 'ok 5 — all 0207 checks passed';
end;
$$;

rollback;

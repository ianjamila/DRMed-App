-- 0201_denied_call_guard.sql — stop one anonymous request from restarting prod.
--
-- Supabase Postgres images 17.6.1.106 and 17.6.1.111 (prod runs .111) SEGFAULT
-- the whole server when a function call is refused by EXECUTE privilege — every
-- connection drops and the database restarts. Proven 2026-09-30 against the
-- exact image with PostgREST v14 in front: an anonymous
-- `POST /rest/v1/rpc/<service_role-only fn>` (the anon key is public) crashes
-- it, and so does `GET /rest/v1/test_requests?select=id,lab_search(...)`,
-- even when RLS shows the caller zero rows (the privilege check runs when the
-- plan starts). A refused TABLE or VIEW read does not crash — it returns the
-- normal 42501. Image .167 is fixed; moving prod there needs a Supabase support
-- ticket. Until then:
--
-- 1. api_request_guard() runs before EVERY PostgREST request (db-pre-request).
--    For /rpc/<name> it refuses with the normal 42501 when <name> in the
--    schema PostgREST will use is closed to the request role (any overload),
--    or when <name> is not a plain identifier (request.path is raw, so an
--    encoded name like lab%5Fsearch would otherwise slip past) — so the
--    executor's own refusal (the crashing path) is never reached. It is
--    SECURITY INVOKER on purpose: has_function_privilege() must answer for the
--    request role, and it only reads the catalog (a boolean, no refusal).
-- 2. lab_search(test_requests) — a computed relationship on a table anon can
--    SELECT (the patient portal reads its own tests through RLS) — becomes
--    executable by anon. That grants nothing: its body reads lab_search_rows,
--    which anon still cannot SELECT, so anon gets "permission denied for view"
--    (a table-level refusal, which does not crash) instead of a function-level
--    one. The guard cannot catch this path — PostgREST does not expose the
--    query string to the pre-request function.
-- 3. The post-condition below fails this migration if any other function that
--    takes a table row (a computed field/relationship) is denied to a role that
--    can SELECT that table, so a future one cannot reopen path 2 unnoticed.
--
-- Rollback (instant, no redeploy):
--   alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';

create or replace function public.api_request_guard()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_path    text := pg_catalog.current_setting('request.path', true);
  v_method  text := pg_catalog.upper(coalesce(pg_catalog.current_setting('request.method', true), ''));
  v_raw     text := pg_catalog.current_setting('request.headers', true);
  v_headers jsonb;
  v_schema  text;
  v_fn      text;
begin
  if v_path is null or v_path not like '/rpc/%' then
    return;
  end if;
  v_fn := pg_catalog.substr(v_path, 6);
  -- request.path is the RAW path: /rpc/lab%5Fsearch reaches lab_search while
  -- the text here still reads "lab%5Fsearch". Every function in the exposed
  -- schemas has a plain lower-case name (the post-condition below keeps it
  -- that way), so anything else is refused rather than decoded.
  if v_fn !~ '^[a-z_][a-z0-9_]*$' then
    raise exception 'permission denied for function %', v_fn using errcode = '42501';
  end if;
  -- The schema PostgREST will use: Accept-Profile for GET/HEAD, Content-Profile
  -- for every other method (the other header is ignored), else public.
  if v_raw is not null and pg_catalog.pg_input_is_valid(v_raw, 'jsonb') then
    v_headers := v_raw::jsonb;
  end if;
  v_schema := case when v_method in ('GET', 'HEAD') then v_headers ->> 'accept-profile'
                   else v_headers ->> 'content-profile' end;
  if v_schema is null or v_schema = ''
     or not exists (select 1 from pg_catalog.pg_namespace n where n.nspname = v_schema) then
    v_schema := 'public';
  end if;
  -- Refuse when ANY overload of the name is closed to the request role:
  -- which overload PostgREST picks depends on the arguments, and a wrong
  -- guess here is a crash. (No name in the exposed schemas has overloads.)
  if exists (select 1
               from pg_catalog.pg_proc p
               join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = v_schema and p.proname = v_fn
                and not pg_catalog.has_function_privilege(p.oid, 'EXECUTE')) then
    -- Same SQLSTATE and wording as Postgres's own refusal, so PostgREST answers
    -- exactly as it would have (401 for anon, 403 for a signed-in role).
    raise exception 'permission denied for function %', v_fn using errcode = '42501';
  end if;
end;
$$;

comment on function public.api_request_guard() is
  'PostgREST db-pre-request (0201): refuses an /rpc call the request role cannot execute before Postgres does — images 17.6.1.106/.111 segfault on that refusal. Safe to drop once prod runs a fixed image (>= 17.6.1.167), after resetting pgrst.db_pre_request.';

-- Every request role runs the guard. If one of them could not, the guard call
-- itself would be the refused call that crashes the server.
revoke all on function public.api_request_guard() from public;
grant execute on function public.api_request_guard() to anon, authenticated, service_role;

grant execute on function public.lab_search(public.test_requests) to anon;

alter role authenticator set pgrst.db_pre_request = 'public.api_request_guard';
notify pgrst, 'reload config';

do $$
declare
  v_bad text;
begin
  if exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(role)
              where not has_function_privilege(r.role, 'public.api_request_guard()', 'EXECUTE')) then
    raise exception '0201: every request role must be able to run api_request_guard()';
  end if;

  if not exists (select 1
                   from pg_db_role_setting s
                  where s.setrole = 'authenticator'::regrole and s.setdatabase = 0
                    and 'pgrst.db_pre_request=public.api_request_guard' = any(s.setconfig)) then
    raise exception '0201: authenticator must carry pgrst.db_pre_request=public.api_request_guard';
  end if;

  -- The guard refuses any /rpc name that is not a plain identifier, so every
  -- function PostgREST can expose must have one.
  select string_agg(format('%I.%s', n.nspname, p.proname), ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'graphql_public')
     and p.proname !~ '^[a-z_][a-z0-9_]*$';
  if v_bad is not null then
    raise exception '0201: api_request_guard refuses these names — rename them or widen its identifier rule: %', v_bad;
  end if;

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
    raise exception '0201: a refused computed-field call crashes images .106/.111 — grant EXECUTE (the body''s own table checks still apply): %', v_bad;
  end if;
end;
$$;

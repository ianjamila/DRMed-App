-- 0207_request_guard_encoded_paths.sql — close two ways past 0201's guard.
--
-- 0201's api_request_guard() (PostgREST db-pre-request) keeps a refused
-- function call from reaching Postgres, which segfaults images 17.6.1.106/.111
-- (prod runs .111) on that refusal. A post-merge Codex review found, and a
-- throwaway .111 + PostgREST v14.5 stack PROVED on 2026-09-30, two anonymous
-- requests that still restarted the server with 0201 in place:
--
-- 1. An encoded route: POST|GET|HEAD /%72pc/<fn> or /r%70c/<fn>. PostgREST
--    routes on the DECODED path segments, but request.path is RAW, so 0201's
--    `v_path not like '/rpc/%'` early return let it through. Every exposed
--    table, view and function has a plain name, so no legitimate request has
--    a percent-escape in its path: the guard now refuses any such path.
-- 2. The profile header sent twice (Content-Profile: public, then another
--    exposed schema): PostgREST uses the FIRST value, request.headers keeps
--    only the LAST, so 0201 checked the wrong schema. PostgREST puts the
--    schema it chose first in search_path before the guard runs, so the guard
--    now reads current_schemas() — which is why it no longer pins its own
--    search_path (a function-level SET would hide the caller's). Every name in
--    the body is schema-qualified and pg_catalog is searched first whenever the
--    path does not name it; it stays SECURITY INVOKER, so it can do nothing the
--    request role could not. It checks that schema, public and the header's
--    value, refusing if the name is closed in ANY of them (refuses more, never
--    less: a POST to graphql_public.<name> now also answers 42501 when
--    public.<name> is closed — PostgREST would have said 404 anyway).
--    Supabase's "function search path mutable" advisor will list this
--    function; that is deliberate (see above).
--
-- Legitimate traffic was re-proved on the same stack: allowed RPCs (GET/POST,
-- default and other schema), table reads and the API root all answer 200.
-- supabase/tests/0207_request_guard_e2e.sh reruns the whole proof in
-- throwaway containers (never against prod).
--
-- Rollback: re-run 0201's function body; or turn the guard off entirely:
--   alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';

create or replace function public.api_request_guard()
returns void
language plpgsql
stable
security invoker
-- NO `set search_path` here: it would hide the request's search_path, which is
-- the one reliable record of the schema PostgREST chose (see below). Every
-- name in the body is schema-qualified, and pg_catalog is searched first
-- whenever the path does not name it, so built-in operators always win.
as $$
declare
  v_path    text := pg_catalog.current_setting('request.path', true);
  v_method  text := pg_catalog.upper(coalesce(pg_catalog.current_setting('request.method', true), ''));
  v_raw     text := pg_catalog.current_setting('request.headers', true);
  v_headers jsonb;
  v_fn      text;
  v_schemas text[];
begin
  if v_path is null then
    return;
  end if;
  -- request.path is RAW, but PostgREST routes on the DECODED segments:
  -- /%72pc/<fn> and /r%70c/<fn> are /rpc/<fn> to it while this text does not
  -- start with /rpc/. Every table, view and function PostgREST exposes has a
  -- plain name, so no legitimate request needs a percent-escape anywhere in
  -- the path: refuse them all instead of decoding.
  if pg_catalog.strpos(v_path, '%') > 0 then
    raise exception 'permission denied for this request path' using errcode = '42501';
  end if;
  if v_path not like '/rpc/%' then
    return;
  end if;
  v_fn := pg_catalog.substr(v_path, 6);
  if v_fn !~ '^[a-z_][a-z0-9_]*$' then
    raise exception 'permission denied for function %', v_fn using errcode = '42501';
  end if;
  -- Which schema PostgREST will call into. The profile header alone is NOT
  -- enough: with the header sent twice PostgREST uses the FIRST value while
  -- request.headers keeps only the LAST (proven 2026-09-30 on v14.5), so the
  -- guard would check the wrong schema. PostgREST puts the schema it chose
  -- first in search_path before this runs — that is authoritative. Check it,
  -- the default schema and whatever the header says: refusing when the name
  -- is closed in ANY of them can only refuse more, never less.
  if v_raw is not null and pg_catalog.pg_input_is_valid(v_raw, 'jsonb') then
    v_headers := v_raw::jsonb;
  end if;
  v_schemas := array['public',
                     (pg_catalog.current_schemas(false))[1],
                     case when v_method in ('GET', 'HEAD') then v_headers ->> 'accept-profile'
                          else v_headers ->> 'content-profile' end];
  -- Refuse when ANY overload of the name is closed to the request role:
  -- which overload PostgREST picks depends on the arguments, and a wrong
  -- guess here is a crash. (No name in the exposed schemas has overloads.)
  if exists (select 1
               from pg_catalog.pg_proc p
               join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname operator(pg_catalog.=) any (v_schemas)
                and p.proname operator(pg_catalog.=) v_fn
                and not pg_catalog.has_function_privilege(p.oid, 'EXECUTE')) then
    -- Same SQLSTATE and wording as Postgres's own refusal, so PostgREST answers
    -- exactly as it would have (401 for anon, 403 for a signed-in role).
    raise exception 'permission denied for function %', v_fn using errcode = '42501';
  end if;
end;
$$;

comment on function public.api_request_guard() is
  'PostgREST db-pre-request (0201, hardened 0207): refuses an /rpc call the request role cannot execute before Postgres does — images 17.6.1.106/.111 segfault on that refusal — and any percent-encoded path. Reads the request search_path on purpose (no pinned search_path). Safe to drop once prod runs a fixed image (>= 17.6.1.167), after resetting pgrst.db_pre_request.';

-- Every request role runs the guard. If one of them could not, the guard call
-- itself would be the refused call that crashes the server.
revoke all on function public.api_request_guard() from public;
grant execute on function public.api_request_guard() to anon, authenticated, service_role;

do $$
declare
  v_bad text;
begin
  if exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(role)
              where not has_function_privilege(r.role, 'public.api_request_guard()', 'EXECUTE')) then
    raise exception '0207: every request role must be able to run api_request_guard()';
  end if;

  if exists (select 1 from pg_proc
              where oid = 'public.api_request_guard()'::regprocedure
                and (prosecdef or proconfig is not null)) then
    raise exception '0207: api_request_guard() must be SECURITY INVOKER with no pinned settings — a pinned search_path hides the schema PostgREST chose';
  end if;

  if not exists (select 1
                   from pg_db_role_setting s
                  where s.setrole = 'authenticator'::regrole and s.setdatabase = 0
                    and 'pgrst.db_pre_request=public.api_request_guard' = any(s.setconfig)) then
    raise exception '0207: authenticator must carry pgrst.db_pre_request=public.api_request_guard';
  end if;

  -- The guard now checks public as well as the chosen schema, so a name that
  -- exists in both would refuse a legitimate graphql_public call when the
  -- public one is closed. None does; keep it that way.
  select string_agg(p.proname, ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'graphql_public'
   where exists (select 1 from pg_proc q join pg_namespace m on m.oid = q.pronamespace
                  where m.nspname = 'public' and q.proname = p.proname);
  if v_bad is not null then
    raise exception '0207: graphql_public and public share function names (the guard would refuse the graphql_public call): %', v_bad;
  end if;
end;
$$;

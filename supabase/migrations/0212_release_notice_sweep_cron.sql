-- 0212_release_notice_sweep_cron.sql
-- =============================================================================
-- Release-notice outbox — PR 2 of 3: the 5-minute sweeper schedule.
-- Spec: docs/superpowers/specs/2026-10-01-release-notice-outbox-design.md
--
-- Owner decision 3: a Supabase pg_cron job every 5 minutes calls the protected
-- app route /api/cron/release-notices through pg_net (Vercel crons stay daily,
-- vercel.json is NOT touched). The route URL and the shared secret live in
-- Vault, never in this file or in a table:
--
--   vault secret `release_notice_sweep_url`      the full route URL, e.g.
--                                                https://drmed.ph/api/cron/release-notices
--   vault secret `release_notice_cron_secret`    the app's CRON_SECRET (sent as
--                                                `Authorization: Bearer <secret>`)
--
-- public.release_notice_sweep_tick() is what the job runs. It does NOTHING
-- unless release_notices_enabled() is true AND both secrets exist and are
-- non-empty — so applying this migration changes nothing until the owner sets
-- the two secrets AND flips release_notice_settings.enabled. Rollback = flip the
-- flag off (the job keeps ticking and doing nothing) or
-- `select cron.unschedule('release-notice-sweep')`.
--
-- The tick is SECURITY DEFINER because it reads vault.decrypted_secrets, which
-- the request roles must never see. It is owned by postgres, pins its
-- search_path, and EXECUTE is revoked from public, anon, authenticated AND
-- service_role (only the owner — and pg_cron, which runs the job as the role
-- that scheduled it, postgres — can run it). Because anon/authenticated cannot
-- execute it, 0201/0207's api_request_guard (which reads has_function_privilege
-- and keeps no list) answers a refused /rpc call itself before Postgres does —
-- required, as prod's image segfaults on that refusal (memory
-- supabase-postgres-denied-function-segfault). It takes no table row, so it is
-- not a computed field either.
--
-- Extensions: pg_cron in pg_catalog and pg_net in extensions (Supabase's
-- documented homes). `if not exists`, so a project that already enabled either
-- from the dashboard is untouched. If the image does not ship pg_cron at all
-- (a bare local Postgres) the schedule step is skipped with a WARNING instead of
-- failing the migration; the post-condition then only checks the function. On a
-- Supabase project (local stack included) pg_cron is available and the job is
-- created and verified.
--
-- The request is fire-and-forget: pg_net queues it and returns a request id; the
-- app route does the work. The 30 s client timeout only bounds how long pg_net
-- waits for the response (recorded in net._http_response); the route finishes on
-- its own. A tick that cannot run raises, which pg_cron records in
-- cron.job_run_details — it never fails silently.
-- =============================================================================

create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  else
    raise warning '0212: pg_cron is not available on this image — the release-notice-sweep job is NOT scheduled';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The tick
-- ---------------------------------------------------------------------------
create or replace function public.release_notice_sweep_tick()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  -- Strict flag first: OFF (or any error reading it) = nothing happens.
  if not public.release_notices_enabled() then
    return null;
  end if;

  select ds.decrypted_secret into v_url
    from vault.decrypted_secrets ds
   where ds.name = 'release_notice_sweep_url'
   order by ds.created_at desc
   limit 1;
  select ds.decrypted_secret into v_secret
    from vault.decrypted_secrets ds
   where ds.name = 'release_notice_cron_secret'
   order by ds.created_at desc
   limit 1;

  -- Either secret missing or blank: do nothing (the owner has not wired it yet).
  if coalesce(btrim(v_url), '') = '' or coalesce(btrim(v_secret), '') = '' then
    return null;
  end if;

  select net.http_post(
           url                  := btrim(v_url),
           headers              := jsonb_build_object(
                                     'Content-Type',  'application/json',
                                     'Authorization', 'Bearer ' || btrim(v_secret)),
           body                 := '{}'::jsonb,
           timeout_milliseconds := 30000)
    into v_req;
  return v_req;
end;
$$;

comment on function public.release_notice_sweep_tick() is
  '0212: the pg_cron release-notice-sweep tick. Does nothing unless release_notices_enabled() AND the Vault secrets release_notice_sweep_url + release_notice_cron_secret both exist; then pg_net POSTs the route with Authorization: Bearer <secret>. SECURITY DEFINER (reads vault.decrypted_secrets), owner postgres, EXECUTE revoked from everyone else.';

alter function public.release_notice_sweep_tick() owner to postgres;
revoke all on function public.release_notice_sweep_tick() from public, anon, authenticated, service_role;
grant execute on function public.release_notice_sweep_tick() to postgres;

-- ---------------------------------------------------------------------------
-- The schedule (idempotent: any existing job of that name goes first)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('cron.job') is null then
    return;   -- pg_cron absent (warned above)
  end if;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'release-notice-sweep';
  perform cron.schedule('release-notice-sweep', '*/5 * * * *', 'select public.release_notice_sweep_tick()');
end;
$$;

-- ---------------------------------------------------------------------------
-- Post-condition
-- ---------------------------------------------------------------------------
do $$
declare
  f      constant text := 'public.release_notice_sweep_tick()';
  v_acl  aclitem[];
  v_item aclitem;
  v_owner oid;
begin
  if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef) then
    raise exception '0212: % must be SECURITY DEFINER', f;
  end if;
  if not coalesce((select p.proconfig @> array['search_path=pg_catalog, public, pg_temp']
                     from pg_proc p where p.oid = f::regprocedure), false) then
    raise exception '0212: % must pin search_path', f;
  end if;
  select p.proowner, p.proacl into v_owner, v_acl from pg_proc p where p.oid = f::regprocedure;
  if v_owner <> 'postgres'::regrole then
    raise exception '0212: % must be owned by postgres', f;
  end if;
  if v_acl is null then
    raise exception '0212: % has the default ACL (PUBLIC can execute)', f;
  end if;
  foreach v_item in array v_acl loop
    if (aclexplode(array[v_item])).grantee <> v_owner then
      raise exception '0212: % may be executed by someone other than its owner (%)', f, v_item;
    end if;
  end loop;
  if has_function_privilege('anon', f, 'EXECUTE')
     or has_function_privilege('authenticated', f, 'EXECUTE')
     or has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception '0212: % must not be executable by anon / authenticated / service_role', f;
  end if;

  if to_regclass('cron.job') is not null then
    if (select count(*) from cron.job j
         where j.jobname = 'release-notice-sweep'
           and j.schedule = '*/5 * * * *'
           and j.command = 'select public.release_notice_sweep_tick()'
           and j.active) <> 1 then
      raise exception '0212: the release-notice-sweep job must exist exactly once, active, every 5 minutes';
    end if;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception '0212: pg_net must be installed';
  end if;
end;
$$;

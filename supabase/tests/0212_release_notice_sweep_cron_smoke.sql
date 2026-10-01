-- =============================================================================
-- 0212_release_notice_sweep_cron_smoke.sql
-- =============================================================================
-- DB proof for migration 0212 (release_notice_sweep_tick + the pg_cron job).
-- Runs inside BEGIN/ROLLBACK and leaves no state (the vault secrets, the flag
-- flip and the queued pg_net request all roll back). It never makes a refused
-- function call as a request role (that segfaults prod's image) — it checks
-- has_function_privilege and calls api_request_guard() only.
--
-- Run (local stack, from the repo root, with 0210 + 0212 applied):
--   docker exec -i supabase_db_DRMed psql -U postgres -v ON_ERROR_STOP=1 -X \
--     < supabase/tests/0212_release_notice_sweep_cron_smoke.sql
--
-- What it proves:
--   1. Flag OFF: the tick returns NULL even with both secrets present, and
--      queues no HTTP request.
--   2. Flag ON with no secret, one secret, or a blank secret: NULL, nothing queued.
--   3. Flag ON with both secrets: one POST is queued with Authorization:
--      Bearer <secret> to the Vault URL.
--   4. The tick is SECURITY DEFINER, owner postgres, EXECUTE for the owner only
--      (anon / authenticated / service_role / PUBLIC refused) and the 0201/0207
--      api_request_guard answers an /rpc call from anon / authenticated itself.
--   5. The job exists once, active, every 5 minutes, running the tick; the
--      schedule step is idempotent (running it again leaves one job).
-- =============================================================================

begin;

create temp table smoke_res (k text, v text) on commit drop;

-- 1 ---------------------------------------------------------------------------
select vault.create_secret('https://example.invalid/api/cron/release-notices', 'release_notice_sweep_url');
select vault.create_secret('smoke-secret-0212', 'release_notice_cron_secret');

do $$
declare v_before bigint; v_r bigint;
begin
  select count(*) into v_before from net.http_request_queue;
  update public.release_notice_settings set enabled = false where id is true;
  v_r := public.release_notice_sweep_tick();
  if v_r is not null then raise exception 'FAIL 1: flag OFF must return NULL, got %', v_r; end if;
  if (select count(*) from net.http_request_queue) <> v_before then
    raise exception 'FAIL 1: flag OFF queued a request';
  end if;
  raise notice 'ok 1';
end $$;

-- 2 ---------------------------------------------------------------------------
do $$
declare v_before bigint; v_r bigint;
begin
  update public.release_notice_settings set enabled = true where id is true;
  select count(*) into v_before from net.http_request_queue;

  -- blank secret
  perform vault.update_secret(s.id, '   ') from vault.secrets s where s.name = 'release_notice_cron_secret';
  v_r := public.release_notice_sweep_tick();
  if v_r is not null then raise exception 'FAIL 2: blank secret must return NULL'; end if;

  -- missing secret
  perform vault.update_secret(s.id, new_name := 'zz_renamed_secret') from vault.secrets s where s.name = 'release_notice_cron_secret';
  v_r := public.release_notice_sweep_tick();
  if v_r is not null then raise exception 'FAIL 2: missing secret must return NULL'; end if;

  -- missing url (secret restored)
  perform vault.update_secret(s.id, new_secret := 'smoke-secret-0212', new_name := 'release_notice_cron_secret') from vault.secrets s where s.name = 'zz_renamed_secret';
  perform vault.update_secret(s.id, new_name := 'zz_renamed_url') from vault.secrets s where s.name = 'release_notice_sweep_url';
  v_r := public.release_notice_sweep_tick();
  if v_r is not null then raise exception 'FAIL 2: missing url must return NULL'; end if;

  if (select count(*) from net.http_request_queue) <> v_before then
    raise exception 'FAIL 2: a no-op tick queued a request';
  end if;
  raise notice 'ok 2';
end $$;

-- 3 ---------------------------------------------------------------------------
do $$
declare v_before bigint; v_r bigint; v_n int;
begin
  perform vault.update_secret(s.id, new_name := 'release_notice_sweep_url') from vault.secrets s where s.name = 'zz_renamed_url';
  select count(*) into v_before from net.http_request_queue;
  v_r := public.release_notice_sweep_tick();
  if v_r is null then raise exception 'FAIL 3: both secrets + flag ON must queue a request'; end if;
  if (select count(*) from net.http_request_queue) <> v_before + 1 then
    raise exception 'FAIL 3: exactly one request must be queued';
  end if;
  select count(*) into v_n from net.http_request_queue q
   where q.id = v_r
     and q.method = 'POST'
     and q.url = 'https://example.invalid/api/cron/release-notices'
     and q.headers ->> 'Authorization' = 'Bearer smoke-secret-0212';
  if v_n <> 1 then raise exception 'FAIL 3: queued request has the wrong url / method / Authorization'; end if;
  raise notice 'ok 3';
end $$;

-- 4 ---------------------------------------------------------------------------
do $$
declare f constant text := 'public.release_notice_sweep_tick()';
begin
  if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef
                   and proowner = 'postgres'::regrole
                   and proconfig @> array['search_path=pg_catalog, public, pg_temp']) then
    raise exception 'FAIL 4: not SECURITY DEFINER / postgres / pinned search_path';
  end if;
  if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE')
     or has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception 'FAIL 4: a request role can execute the tick';
  end if;
  if (select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid = f::regprocedure and a.grantee <> p.proowner) <> 0 then
    raise exception 'FAIL 4: someone besides the owner holds EXECUTE';
  end if;
  raise notice 'ok 4a';
end $$;

set local role anon;
do $$
begin
  perform set_config('request.method', 'POST', true);
  perform set_config('request.path', '/rpc/release_notice_sweep_tick', true);
  perform set_config('request.headers', '{}', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 4: the guard let anon reach the tick';
  exception when sqlstate '42501' then
    raise notice 'ok 4b (anon refused by the guard)';
  end;
end $$;
reset role;

set local role authenticated;
do $$
begin
  perform set_config('request.method', 'POST', true);
  perform set_config('request.path', '/rpc/release_notice_sweep_tick', true);
  perform set_config('request.headers', '{}', true);
  begin
    perform public.api_request_guard();
    raise exception 'FAIL 4: the guard let authenticated reach the tick';
  exception when sqlstate '42501' then
    raise notice 'ok 4c (authenticated refused by the guard)';
  end;
end $$;
reset role;

-- 5 ---------------------------------------------------------------------------
do $$
begin
  if (select count(*) from cron.job where jobname = 'release-notice-sweep' and schedule = '*/5 * * * *'
        and command = 'select public.release_notice_sweep_tick()' and active) <> 1 then
    raise exception 'FAIL 5: job missing or wrong';
  end if;
  -- the migration's own schedule step, run again
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'release-notice-sweep';
  perform cron.schedule('release-notice-sweep', '*/5 * * * *', 'select public.release_notice_sweep_tick()');
  if (select count(*) from cron.job where jobname = 'release-notice-sweep') <> 1 then
    raise exception 'FAIL 5: rescheduling left more than one job';
  end if;
  raise notice 'ok 5';
end $$;

rollback;

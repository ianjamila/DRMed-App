-- =============================================================================
-- 0210_release_notice_outbox_smoke.sql
-- =============================================================================
-- DB proof for migration 0210 (release_notices, claim_release_notice,
-- finish_release_notice, retry_release_notice, the strict flag).
-- Sequential only: the functions under racing sessions are proven by
-- scripts/release-notice-concurrency-proof.ts
-- (npm run release-notice:concurrency-proof). Runs inside BEGIN/ROLLBACK.
--
-- Run (local stack, from the repo root, with 0210 applied):
--   docker exec -i supabase_db_DRMed psql -U postgres -v ON_ERROR_STOP=1 -X \
--     < supabase/tests/0210_release_notice_outbox_smoke.sql
--
-- What it proves:
--   1. Flag OFF (seeded): claim returns nothing, even for a due row; a missing
--      settings row or a NULL read is OFF too.
--   2. The backoff schedule: attempts 1..5 fail -> retry at +5m, +15m, +1h,
--      +4h, +12h; the sixth failed attempt -> abandoned.
--   3. The 24 h cap: a retry whose next try would fall after created_at + 24 h
--      is abandoned instead (and one just inside the window is not).
--   4. Terminal statuses (sent / skipped / suppressed / cancelled) set
--      resolved_at (sent also sent_at) and clear the lease.
--   5. A stale lease token changes nothing and returns no row.
--   6. A channel already `sent` is never overwritten; sms 'unknown' survives a
--      reclaim and is handed to the sender.
--   7. The sweeper ignores a row younger than 2 minutes; p_id does not.
--   8. An expired lease is reclaimed (attempts + 1, new token); an expired
--      lease on an out-of-attempts row is closed `abandoned`.
--   9. last_error is truncated and address-shaped text is redacted.
--  10. retry_release_notice: only abandoned / retry rows; refuses a sending row.
--  11. Constraints: unique (visit_id, released_at), status / channel checks.
--  12. ACLs: service_role only (anon / authenticated / PUBLIC refused).
-- =============================================================================

begin;

insert into public.patients (id, drm_id, first_name, last_name, birthdate)
values ('a0000000-0000-4000-8000-000000000210', 'DRM-SMOKE210', 'Smoke210', 'Fixture', '1990-01-01');
insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
values ('a1000000-0000-4000-8000-000000000210', 'V-SMOKE210-1', 'a0000000-0000-4000-8000-000000000210',
        (now() at time zone 'Asia/Manila')::date, 'unpaid', 0, 0);

create temp table smoke_ctx (n int) on commit drop;

-- helper: a fresh notice, optionally aged
create or replace function pg_temp.mk_notice(p_age interval default interval '1 hour')
returns uuid language plpgsql as $$
declare v_id uuid; v_n int;
begin
  insert into smoke_ctx values (1);
  select count(*) into v_n from smoke_ctx;
  insert into public.release_notices (visit_id, released_at, test_request_ids, created_at, next_attempt_at)
  values ('a1000000-0000-4000-8000-000000000210', now() - make_interval(secs => v_n), array[gen_random_uuid()],
          now() - p_age, now() - p_age)
  returning id into v_id;
  return v_id;
end $$;

-- 1 ---------------------------------------------------------------------------
do $$
declare v_id uuid := pg_temp.mk_notice();
begin
  if (select enabled from public.release_notice_settings) is not false then
    raise exception '1: the flag is not seeded OFF';
  end if;
  if public.release_notices_enabled() then raise exception '1: enabled() true while OFF'; end if;
  if exists (select 1 from public.claim_release_notice()) then raise exception '1: sweeper claimed while OFF'; end if;
  if exists (select 1 from public.claim_release_notice(v_id)) then raise exception '1: inline claimed while OFF'; end if;
  if (select status from public.release_notices where id = v_id) <> 'pending' then
    raise exception '1: an OFF claim changed the row';
  end if;

  -- a missing settings row is OFF, a NULL cannot exist (not null) but a deleted row reads OFF
  update public.release_notice_settings set enabled = true;
  if not public.release_notices_enabled() then raise exception '1: enabled() false while ON'; end if;
  delete from public.release_notice_settings;
  if public.release_notices_enabled() then raise exception '1: a missing row must read OFF'; end if;
  if exists (select 1 from public.claim_release_notice(v_id)) then raise exception '1: claimed with the row missing'; end if;
  insert into public.release_notice_settings (id, enabled) values (true, true);   -- ON for the rest
  raise notice '1 ok: OFF / missing row claim nothing';
end $$;

-- 2 + 3 + 4 -------------------------------------------------------------------
do $$
declare
  v_id uuid; r public.release_notices; k int; want interval;
  wants interval[] := array['5 minutes','15 minutes','1 hour','4 hours','12 hours']::interval[];
begin
  -- 2: the schedule, attempt by attempt
  v_id := pg_temp.mk_notice(interval '10 minutes');
  for k in 1..5 loop
    update public.release_notices set next_attempt_at = now() - interval '1 second' where id = v_id and status = 'retry';
    select * into r from public.claim_release_notice(v_id);
    if r.id is null or r.attempts <> k then raise exception '2: attempt % claim failed (%)', k, r.attempts; end if;
    select * into r from public.finish_release_notice(v_id, r.lease_token, 'retry', 'failed', null, null, null, 'boom');
    want := wants[k];
    if r.status <> 'retry' then raise exception '2: attempt % should wait, got %', k, r.status; end if;
    if abs(extract(epoch from (r.next_attempt_at - clock_timestamp() - want))) > 5 then
      raise exception '2: attempt % next_attempt_at %, wanted ~ +%', k, r.next_attempt_at, want;
    end if;
  end loop;
  update public.release_notices set next_attempt_at = now() - interval '1 second' where id = v_id;
  select * into r from public.claim_release_notice(v_id);
  if r.attempts <> 6 then raise exception '2: sixth claim attempts %', r.attempts; end if;
  select * into r from public.finish_release_notice(v_id, r.lease_token, 'retry', 'failed', null, null, null, 'boom');
  if r.status <> 'abandoned' or r.resolved_at is null or r.lease_token is not null then
    raise exception '2: the sixth failure must abandon, got % / %', r.status, r.resolved_at;
  end if;
  raise notice '2 ok: 5m,15m,1h,4h,12h then abandoned';

  -- 3: the 24 h cap. attempt 1 would retry at +5 m.
  v_id := pg_temp.mk_notice(interval '23 hours 56 minutes');   -- +5m lands at 24h01m: past the cap
  select * into r from public.claim_release_notice(v_id);
  select * into r from public.finish_release_notice(v_id, r.lease_token, 'retry', 'failed');
  if r.status <> 'abandoned' then raise exception '3: a retry past 24h must abandon, got %', r.status; end if;
  v_id := pg_temp.mk_notice(interval '23 hours 50 minutes');   -- +5m lands at 23h55m: inside
  select * into r from public.claim_release_notice(v_id);
  select * into r from public.finish_release_notice(v_id, r.lease_token, 'retry', 'failed');
  if r.status <> 'retry' then raise exception '3: a retry inside 24h must wait, got %', r.status; end if;
  raise notice '3 ok: 24h cap';

  -- 4: terminals
  for k in 1..4 loop
    v_id := pg_temp.mk_notice();
    select * into r from public.claim_release_notice(v_id);
    select * into r from public.finish_release_notice(v_id, r.lease_token,
      (array['sent','skipped','suppressed','cancelled'])[k], 'sent', 'skipped', 'em_1', null, null,
      case when k > 1 then 'why' end);
    if r.status <> (array['sent','skipped','suppressed','cancelled'])[k]
       or r.resolved_at is null or r.lease_token is not null or r.lease_expires_at is not null
       or (k = 1) <> (r.sent_at is not null) then
      raise exception '4: terminal % wrong: % resolved % sent %', k, r.status, r.resolved_at, r.sent_at;
    end if;
  end loop;
  raise notice '4 ok: terminals';
end $$;

-- 5 + 6 -----------------------------------------------------------------------
do $$
declare v_id uuid := pg_temp.mk_notice(); r public.release_notices; old uuid;
begin
  select * into r from public.claim_release_notice(v_id);
  old := r.lease_token;
  -- email goes out, SMS is in flight (unknown), then the lease expires
  update public.release_notices set email_state = 'sent', email_provider_id = 'em_9', sms_state = 'unknown',
         lease_expires_at = now() - interval '1 second' where id = v_id;
  select * into r from public.claim_release_notice(v_id);
  if r.attempts <> 2 or r.lease_token = old then raise exception '6: expired lease not reclaimed with a new token'; end if;
  if r.sms_state <> 'unknown' or r.email_state <> 'sent' then raise exception '6: claim altered channel states'; end if;

  -- 5: the OLD token is fenced
  if exists (select 1 from public.finish_release_notice(v_id, old, 'sent', 'sent', 'sent')) then
    raise exception '5: a stale token finished the row';
  end if;
  if (select status from public.release_notices where id = v_id) <> 'sending' then raise exception '5: stale finish changed status'; end if;
  if exists (select 1 from public.finish_release_notice(v_id, gen_random_uuid(), 'sent')) then raise exception '5: random token finished'; end if;

  -- 6: 'sent' is never overwritten, provider id kept
  select * into r from public.finish_release_notice(v_id, r.lease_token, 'retry', 'failed', 'failed', 'em_x', null, null);
  if r.email_state <> 'sent' then raise exception '6: email_state overwritten'; end if;
  raise notice '5+6 ok: stale token fenced; sent sticky; sms unknown handed back';
end $$;

-- 7 + 8 + 9 -------------------------------------------------------------------
do $$
declare v_young uuid; v_old uuid; r public.release_notices; v_ex uuid; v_big uuid;
begin
  update public.release_notices set status = 'cancelled', resolved_at = now(), lease_token = null, lease_expires_at = null
   where status in ('pending', 'retry', 'sending');           -- clear earlier fixtures from the due set
  v_young := pg_temp.mk_notice(interval '30 seconds');
  v_old   := pg_temp.mk_notice(interval '5 minutes');
  if (select count(*) from public.claim_release_notice(null, 50)) <> 1 then raise exception '7: sweeper must take exactly the old row'; end if;
  if (select status from public.release_notices where id = v_young) <> 'pending' then raise exception '7: sweeper took a young row'; end if;
  if (select count(*) from public.claim_release_notice(v_young)) <> 1 then raise exception '7: inline claim must take the young row'; end if;
  raise notice '7 ok: sweeper ignores young rows, inline does not';

  -- 8: expired lease reclaimed; out-of-attempts expired lease abandoned
  v_ex := pg_temp.mk_notice();
  perform 1 from public.claim_release_notice(v_ex);
  update public.release_notices set lease_expires_at = now() - interval '1 second' where id = v_ex;
  select * into r from public.claim_release_notice(null, 50);
  if r.id is distinct from v_ex or r.attempts <> 2 then raise exception '8: sweeper did not reclaim the expired lease'; end if;
  update public.release_notices set attempts = 6, lease_expires_at = now() - interval '1 second' where id = v_ex;
  if exists (select 1 from public.claim_release_notice(null, 50)) then raise exception '8: leased an out-of-attempts row'; end if;
  if (select status from public.release_notices where id = v_ex) <> 'abandoned' then raise exception '8: out-of-attempts expired lease not abandoned'; end if;
  raise notice '8 ok: reclaim + abandon';

  -- 9: error handling
  v_big := pg_temp.mk_notice();
  select * into r from public.claim_release_notice(v_big);
  select * into r from public.finish_release_notice(v_big, r.lease_token, 'retry', 'failed', null, null, null,
    'Resend 422: to=jane.doe@example.com rejected ' || repeat('x', 900));
  if r.last_error like '%@%' or r.last_error not like '%[redacted]%' or char_length(r.last_error) > 500 then
    raise exception '9: last_error not redacted/truncated: %', left(r.last_error, 80);
  end if;
  raise notice '9 ok: error redacted + truncated';
end $$;

-- 10 --------------------------------------------------------------------------
do $$
declare v_a uuid := pg_temp.mk_notice(); v_s uuid := pg_temp.mk_notice(); v_d uuid := pg_temp.mk_notice(); r public.release_notices;
begin
  update public.release_notices set status = 'abandoned', resolved_at = now(), attempts = 6 where id = v_a;
  if not public.retry_release_notice(v_a) then raise exception '10: abandoned row not reset'; end if;
  select * into r from public.release_notices where id = v_a;
  if r.status <> 'retry' or r.attempts <> 0 or r.resolved_at is not null or r.next_attempt_at > clock_timestamp() then
    raise exception '10: reset wrong: % % %', r.status, r.attempts, r.resolved_at;
  end if;

  select * into r from public.claim_release_notice(v_s);       -- live lease
  if public.retry_release_notice(v_s) then raise exception '10: reset a sending row with a live lease'; end if;
  if (select attempts from public.release_notices where id = v_s) <> 1 then raise exception '10: sending row altered'; end if;

  update public.release_notices set status = 'sent', sent_at = now(), resolved_at = now() where id = v_d;
  if public.retry_release_notice(v_d) then raise exception '10: reset a sent row'; end if;
  if public.retry_release_notice(gen_random_uuid()) then raise exception '10: reset a missing row'; end if;
  raise notice '10 ok: retry only abandoned/retry, never a live lease';
end $$;

-- 11 --------------------------------------------------------------------------
do $$
declare v_id uuid := pg_temp.mk_notice(); v_at timestamptz;
begin
  select released_at into v_at from public.release_notices where id = v_id;
  begin
    insert into public.release_notices (visit_id, released_at, test_request_ids)
    values ('a1000000-0000-4000-8000-000000000210', v_at, array[gen_random_uuid()]);
    raise exception '11: duplicate (visit_id, released_at) accepted';
  exception when unique_violation then null; end;
  begin
    update public.release_notices set status = 'bogus' where id = v_id;
    raise exception '11: bogus status accepted';
  exception when check_violation then null; end;
  begin
    update public.release_notices set sms_state = 'maybe' where id = v_id;
    raise exception '11: bogus sms_state accepted';
  exception when check_violation then null; end;
  begin
    update public.release_notices set status = 'sent', resolved_at = now() where id = v_id;
    raise exception '11: sent without sent_at accepted';
  exception when check_violation then null; end;
  begin
    update public.release_notices set status = 'sending' where id = v_id;
    raise exception '11: sending without a lease accepted';
  exception when check_violation then null; end;
  raise notice '11 ok: constraints';
end $$;

-- 12 --------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.release_notices_enabled()', 'public.claim_release_notice(uuid,integer)',
    'public.finish_release_notice(uuid,uuid,text,text,text,text,text,text,text)', 'public.retry_release_notice(uuid)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
       or not has_function_privilege('service_role', f, 'execute') then
      raise exception '12: bad ACL on %', f;
    end if;
  end loop;
  raise notice '12 ok: ACLs';
end $$;

rollback;

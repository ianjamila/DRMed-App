-- =============================================================================
-- 0214_release_notice_enqueue_smoke.sql
-- =============================================================================
-- DB proof for migration 0214 (release_visit_results enqueues the release notice,
-- undo_visit_release cancels it, cancel_release_notice is the fenced cancel).
-- Sequential only — the races are in scripts/report-release-concurrency-proof.ts
-- (N1-N4, control mutants M14-M16). Runs inside BEGIN/ROLLBACK and leaves no state
-- (the flag flips roll back with it). Self-contained fixtures.
--
-- A whole smoke is ONE transaction, so every call shares one now(): visits are
-- separate per scenario so each release is the only one of its visit, and section 7
-- exercises the same-transaction case on purpose.
--
-- Run (local stack, from the repo root, with 0210 + 0214 applied):
--   docker exec -i supabase_db_DRMed psql -U postgres -v ON_ERROR_STOP=1 -X \
--     < supabase/tests/0214_release_notice_enqueue_smoke.sql
--
-- What it proves:
--   1. Flag OFF: no row, and the result has exactly 0205's keys (no notice_id).
--   2. Flag ON: ONE row per call covering every released line (a combined
--      report's mates and a plain line), status pending, next_attempt_at and
--      released_at = the stamp the lines got, the medium, the bulk_batch_id.
--   3. Undo leaves a partly undone notice alone, then cancels it once every
--      test is un-released (resolved_at set, lease cleared).
--   4. Undo never touches a 'sending' notice.
--   5. Undo cancels a 'retry' notice.
--   6. Undo cancels whatever the flag says (a pending row outlives a flag-off).
--   7. Two calls in one transaction merge into one pending row; a re-release
--      that collides with a cancelled row releases without a notice_id.
--   8. A payment-gate refusal leaves no notice; a refused-only call enqueues none.
--   9. cancel_release_notice: pending / retry -> cancelled (true), never sending,
--      terminal or an unknown id (false); the reason is redacted.
--  10. Grants.
-- =============================================================================

begin;

create or replace function pg_temp.u(p text) returns uuid language sql immutable as $$
  select (lpad(p, 8, '0') || '-0000-4000-8000-000000000214')::uuid
$$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  (pg_temp.u('a0'), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke214-medtech@example.test', '', now(), now(), now()),
  (pg_temp.u('a2'), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke214-admin@example.test', '', now(), now(), now());
insert into public.staff_profiles (id, full_name, role, is_active) values
  (pg_temp.u('a0'), 'Smoke214 Medtech', 'medtech', true),
  (pg_temp.u('a2'), 'Smoke214 Admin', 'admin', true);
insert into public.report_groups (id, code, name) values (pg_temp.u('b0'), 'SMK214', 'Smoke214 Chemistry');
insert into public.services (id, code, name, price_php, kind, section, report_group_id) values
  (pg_temp.u('c0'), 'SMK214-A', 'Smoke214 A', 100, 'lab_test', 'chemistry', pg_temp.u('b0')),
  (pg_temp.u('c1'), 'SMK214-B', 'Smoke214 B', 100, 'lab_test', 'chemistry', pg_temp.u('b0')),
  (pg_temp.u('c2'), 'SMK214-C', 'Smoke214 C', 100, 'lab_test', 'chemistry', pg_temp.u('b0'));
insert into public.services (id, code, name, price_php, kind, section) values
  (pg_temp.u('c4'), 'SMK214-U', 'Smoke214 Urinalysis', 100, 'lab_test', 'urinalysis');
insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values (pg_temp.u('d0'), 'DRM-SMK214', 'Smoke214', 'Patient', '1990-01-01', 'female');

-- V1..V6, V8 paid; V7 unpaid (the payment gate).
insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
select pg_temp.u(v), 'V-SMK214-' || v, pg_temp.u('d0'), (now() at time zone 'Asia/Manila')::date,
       case when v = 'e7' then 'unpaid' else 'paid' end, 1000, case when v = 'e7' then 0 else 1000 end
  from unnest(array['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']) v;

-- (test, visit, service, status)
insert into public.test_requests (id, visit_id, service_id, requested_by, status, base_price_php, final_price_php)
select pg_temp.u(t.id), pg_temp.u(t.visit), pg_temp.u(t.svc), pg_temp.u('a0'), t.st, 100, 100
  from (values
    ('f1', 'e1', 'c4', 'ready_for_release'),
    ('f2', 'e2', 'c0', 'ready_for_release'), ('f3', 'e2', 'c1', 'ready_for_release'),
    ('f4', 'e2', 'c2', 'ready_for_release'), ('f5', 'e2', 'c4', 'ready_for_release'),
    ('f6', 'e3', 'c4', 'ready_for_release'), ('f7', 'e3', 'c4', 'ready_for_release'),
    ('f8', 'e4', 'c4', 'ready_for_release'),
    ('f9', 'e5', 'c4', 'ready_for_release'),
    ('fa', 'e6', 'c4', 'ready_for_release'), ('fb', 'e6', 'c4', 'ready_for_release'),
    ('fc', 'e7', 'c4', 'ready_for_release'),
    ('fd', 'e8', 'c4', 'requested')
  ) as t(id, visit, svc, st);

insert into public.results (id, uploaded_by) values (pg_temp.u('90'), pg_temp.u('a0'));
insert into public.result_test_requests (result_id, test_request_id)
select pg_temp.u('90'), pg_temp.u(t) from unnest(array['f2', 'f3', 'f4']) t;

-- helpers ---------------------------------------------------------------------
create or replace function pg_temp.run_as(p_user uuid, p_sql text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    execute 'set local role service_role';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  execute p_sql into v;
  execute 'reset role';
  return v;
exception when others then
  execute 'reset role';
  raise;
end $$;

create or replace function pg_temp.expect_error(p_label text, p_user uuid, p_sql text, p_state text) returns void
language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    perform pg_temp.run_as(p_user, p_sql);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_state then
      raise exception '%: expected %, got % (%)', p_label, p_state, v_state, v_msg;
    end if;
    raise notice '% ok: % (%)', p_label, v_state, v_msg;
    return;
  end;
  raise exception '%: expected %, call succeeded', p_label, p_state;
end $$;

create or replace function pg_temp.expect(p_label text, p_got text, p_want text) returns void
language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception '%: expected [%], got [%]', p_label, p_want, p_got;
  end if;
  raise notice '% ok: %', p_label, p_got;
end $$;

create or replace function pg_temp.release(p_visit text, p_ids text[], p_medium text default 'email', p_audit text default null)
returns jsonb language sql as $$
  select pg_temp.run_as(pg_temp.u('a0'),
    format('select public.release_visit_results(%L::uuid, %L::uuid[], %L, null, %L::jsonb)',
           pg_temp.u(p_visit), (select array_agg(pg_temp.u(x)) from unnest(p_ids) x), p_medium, p_audit))
$$;
create or replace function pg_temp.undo(p_visit text, p_ids text[]) returns jsonb language sql as $$
  select pg_temp.run_as(pg_temp.u('a2'),
    format('select public.undo_visit_release(%L::uuid, %L::uuid[], null, null, ''smoke214'')',
           pg_temp.u(p_visit), (select array_agg(pg_temp.u(x)) from unnest(p_ids) x)))
$$;
create or replace function pg_temp.n_notices(p_visit text) returns text language sql as $$
  select count(*)::text from public.release_notices where visit_id = pg_temp.u(p_visit)
$$;
create or replace function pg_temp.notice(p_visit text) returns public.release_notices language sql as $$
  select n from public.release_notices n where n.visit_id = pg_temp.u(p_visit) order by n.created_at, n.id limit 1
$$;
create or replace function pg_temp.ids(p_ids text[]) returns text language sql as $$
  select string_agg(pg_temp.u(x)::text, ',' order by pg_temp.u(x)) from unnest(p_ids) x
$$;
create or replace function pg_temp.flag(p boolean) returns void language sql as $$
  update public.release_notice_settings set enabled = p where id is true
$$;

-- 1. flag OFF: byte-identical to 0205 -----------------------------------------
do $$
declare v jsonb;
begin
  perform pg_temp.flag(false);
  v := pg_temp.release('e1', array['f1']);
  perform pg_temp.expect('1 released', jsonb_array_length(v -> 'released')::text, '1');
  perform pg_temp.expect('1 result keys are 0205''s', (select string_agg(k, ',' order by k) from jsonb_object_keys(v) k), 'refused,released');
  perform pg_temp.expect('1 no notice row', pg_temp.n_notices('e1'), '0');
end $$;

-- 2. flag ON: one row per call, covering every released line ------------------
do $$
declare v jsonb; n public.release_notices; t timestamptz;
begin
  perform pg_temp.flag(true);
  -- select f2 only: the report's mates f3, f4 are released with it ("also released"); f5 is plain.
  v := pg_temp.release('e2', array['f2', 'f5'], 'email',
         '{"metadata": {"bulk_batch_id": "batch-214"}, "ip": "203.0.113.9"}');
  perform pg_temp.expect('2 released lines', jsonb_array_length(v -> 'released')::text, '4');
  perform pg_temp.expect('2 exactly one notice', pg_temp.n_notices('e2'), '1');
  n := pg_temp.notice('e2');
  select released_at into t from public.test_requests where id = pg_temp.u('f2');
  perform pg_temp.expect('2 notice_id returned', v ->> 'notice_id', n.id::text);
  perform pg_temp.expect('2 status', n.status, 'pending');
  perform pg_temp.expect('2 covers every released id (mates included)',
    (select string_agg(x::text, ',' order by x) from unnest(n.test_request_ids) x), pg_temp.ids(array['f2', 'f3', 'f4', 'f5']));
  perform pg_temp.expect('2 medium', n.release_medium, 'email');
  perform pg_temp.expect('2 bulk_batch_id', n.bulk_batch_id, 'batch-214');
  perform pg_temp.expect('2 released_at = the stamp the lines got', (n.released_at = t)::text, 'true');
  perform pg_temp.expect('2 every line has that stamp',
    (select count(*)::text from public.test_requests where id = any (n.test_request_ids) and released_at = n.released_at), '4');
  perform pg_temp.expect('2 due now', (n.next_attempt_at = n.released_at)::text, 'true');
  perform pg_temp.expect('2 no lease, no attempts, unresolved',
    concat_ws('/', n.attempts, n.lease_token is null, n.resolved_at is null, n.audited_at is null), '0/t/t/t');
end $$;

-- 3. undo: partly undone is left alone, fully undone is cancelled ---------------
do $$
declare n public.release_notices;
begin
  perform pg_temp.undo('e2', array['f5']);
  n := pg_temp.notice('e2');
  perform pg_temp.expect('3 partly undone (f5 only) stays pending', n.status, 'pending');
  perform pg_temp.undo('e2', array['f2']);   -- whole report f2, f3, f4
  n := pg_temp.notice('e2');
  perform pg_temp.expect('3 fully undone (some earlier) -> cancelled', n.status, 'cancelled');
  perform pg_temp.expect('3 resolved, lease cleared, audited',
    concat_ws('/', n.resolved_at is not null, n.lease_token is null, n.lease_expires_at is null, n.audited_at is not null, n.sent_at is null),
    't/t/t/t/t');
  perform pg_temp.expect('3 reason', n.skip_reason, 'release undone');
end $$;

-- 4. undo never touches a sending notice --------------------------------------------
do $$
declare n public.release_notices; nid uuid; got jsonb;
begin
  perform pg_temp.flag(true);
  perform pg_temp.release('e3', array['f6', 'f7']);
  nid := (pg_temp.notice('e3')).id;
  got := pg_temp.run_as(null, format($q$select to_jsonb(c) from public.claim_release_notice(%L::uuid, 1) c$q$, nid));
  perform pg_temp.expect('4 claimed', got ->> 'status', 'sending');
  perform pg_temp.undo('e3', array['f6', 'f7']);
  n := pg_temp.notice('e3');
  perform pg_temp.expect('4 sending notice untouched by a full undo',
    concat_ws('/', n.status, n.lease_token is not null, n.resolved_at is null), 'sending/t/t');
end $$;

-- 5. a retry notice is cancelled ------------------------------------------------------
do $$
declare n public.release_notices; nid uuid; tok uuid;
begin
  perform pg_temp.release('e4', array['f8']);
  nid := (pg_temp.notice('e4')).id;
  tok := (pg_temp.run_as(null, format($q$select to_jsonb(c) from public.claim_release_notice(%L::uuid, 1) c$q$, nid)) ->> 'lease_token')::uuid;
  perform pg_temp.run_as(null, format($q$select to_jsonb(f) from public.finish_release_notice(%L::uuid, %L::uuid, 'retry', null, null, null, null, 'boom') f$q$, nid, tok));
  perform pg_temp.expect('5 retry before undo', (pg_temp.notice('e4')).status, 'retry');
  perform pg_temp.undo('e4', array['f8']);
  n := pg_temp.notice('e4');
  perform pg_temp.expect('5 retry -> cancelled', concat_ws('/', n.status, n.resolved_at is not null, n.lease_token is null), 'cancelled/t/t');
end $$;

-- 6. the cancel does not depend on the flag -------------------------------------------
do $$
declare n public.release_notices;
begin
  perform pg_temp.flag(true);
  perform pg_temp.release('e5', array['f9']);      -- no p_audit: no bulk_batch_id
  perform pg_temp.expect('6 pending, no batch id', concat_ws('/', (pg_temp.notice('e5')).status, (pg_temp.notice('e5')).bulk_batch_id is null), 'pending/t');
  perform pg_temp.flag(false);
  perform pg_temp.undo('e5', array['f9']);
  perform pg_temp.expect('6 cancelled with the flag OFF', (pg_temp.notice('e5')).status, 'cancelled');
end $$;

-- 7. same transaction: merge; and a re-release over a cancelled row ----------------------
do $$
declare v1 jsonb; v2 jsonb; v3 jsonb;
begin
  perform pg_temp.flag(true);
  v1 := pg_temp.release('e6', array['fa']);
  v2 := pg_temp.release('e6', array['fb']);      -- same transaction => same now()
  perform pg_temp.expect('7 second call returns the SAME notice', v2 ->> 'notice_id', v1 ->> 'notice_id');
  perform pg_temp.expect('7 one row', pg_temp.n_notices('e6'), '1');
  perform pg_temp.expect('7 merged ids',
    (select string_agg(x::text, ',' order by x) from unnest((pg_temp.notice('e6')).test_request_ids) x), pg_temp.ids(array['fa', 'fb']));
  perform pg_temp.undo('e6', array['fa', 'fb']);
  perform pg_temp.expect('7 cancelled', (pg_temp.notice('e6')).status, 'cancelled');
  v3 := pg_temp.release('e6', array['fa']);       -- collides with the cancelled row
  perform pg_temp.expect('7 re-release over a cancelled row still releases', jsonb_array_length(v3 -> 'released')::text, '1');
  perform pg_temp.expect('7 ...without a notice_id and without a second row', concat_ws('/', v3 ? 'notice_id', pg_temp.n_notices('e6')), 'f/1');
end $$;

-- 8. rollbacks and refusals leave nothing ----------------------------------------------
select null from pg_temp.expect_error('8 unpaid visit: payment gate', pg_temp.u('a0'),
  format($q$select public.release_visit_results(%L::uuid, %L::uuid[], 'email')$q$, pg_temp.u('e7'), array[pg_temp.u('fc')]), '23514');
select null from pg_temp.expect('8 the refused release left no notice', pg_temp.n_notices('e7'), '0');
do $$
declare v jsonb;
begin
  v := pg_temp.release('e8', array['fd']);       -- requested, not ready: refused, nothing released
  perform pg_temp.expect('8 nothing released', jsonb_array_length(v -> 'released')::text, '0');
  perform pg_temp.expect('8 no notice_id, no row', concat_ws('/', v ? 'notice_id', pg_temp.n_notices('e8')), 'f/0');
end $$;

-- 9. cancel_release_notice: fenced ---------------------------------------------------------
insert into public.release_notices (id, visit_id, released_at, test_request_ids, status, attempts, lease_token, lease_expires_at, sent_at, resolved_at)
values
  (pg_temp.u('01'), pg_temp.u('e1'), now() - interval '1 minute', array[pg_temp.u('f1')], 'pending', 0, null, null, null, null),
  (pg_temp.u('02'), pg_temp.u('e1'), now() - interval '2 minutes', array[pg_temp.u('f1')], 'retry', 1, null, null, null, null),
  (pg_temp.u('03'), pg_temp.u('e1'), now() - interval '3 minutes', array[pg_temp.u('f1')], 'sending', 1, gen_random_uuid(), now() + interval '3 minutes', null, null),
  (pg_temp.u('04'), pg_temp.u('e1'), now() - interval '4 minutes', array[pg_temp.u('f1')], 'sent', 1, null, null, now(), now()),
  (pg_temp.u('05'), pg_temp.u('e1'), now() - interval '5 minutes', array[pg_temp.u('f1')], 'pending', 0, null, null, null, null);
do $$
declare n public.release_notices;
begin
  perform pg_temp.expect('9 pending -> true', pg_temp.run_as(null, format('select to_jsonb(public.cancel_release_notice(%L::uuid, %L))', pg_temp.u('01'), 'flag turned off')) #>> '{}', 'true');
  select * into n from public.release_notices where id = pg_temp.u('01');
  perform pg_temp.expect('9 cancelled, resolved, audited, no lease',
    concat_ws('/', n.status, n.resolved_at is not null, n.audited_at is not null, n.lease_token is null, n.skip_reason), 'cancelled/t/t/t/flag turned off');
  perform pg_temp.expect('9 second cancel -> false', pg_temp.run_as(null, format('select to_jsonb(public.cancel_release_notice(%L::uuid))', pg_temp.u('01'))) #>> '{}', 'false');
  perform pg_temp.expect('9 retry -> true', pg_temp.run_as(null, format('select to_jsonb(public.cancel_release_notice(%L::uuid))', pg_temp.u('02'))) #>> '{}', 'true');
  perform pg_temp.expect('9 sending -> false', pg_temp.run_as(null, format('select to_jsonb(public.cancel_release_notice(%L::uuid))', pg_temp.u('03'))) #>> '{}', 'false');
  select * into n from public.release_notices where id = pg_temp.u('03');
  perform pg_temp.expect('9 sending untouched', concat_ws('/', n.status, n.lease_token is not null, n.resolved_at is null), 'sending/t/t');
  perform pg_temp.expect('9 sent -> false', pg_temp.run_as(null, format('select to_jsonb(public.cancel_release_notice(%L::uuid))', pg_temp.u('04'))) #>> '{}', 'false');
  select * into n from public.release_notices where id = pg_temp.u('04');
  perform pg_temp.expect('9 sent untouched', n.status, 'sent');
  perform pg_temp.expect('9 unknown id -> false', pg_temp.run_as(null, format('select to_jsonb(public.cancel_release_notice(%L::uuid))', gen_random_uuid())) #>> '{}', 'false');
  perform pg_temp.run_as(null, format('select to_jsonb(public.cancel_release_notice(%L::uuid, %L))', pg_temp.u('05'), 'sent to jane@example.com / +63 917 123 4567 failed'));
  select * into n from public.release_notices where id = pg_temp.u('05');
  perform pg_temp.expect('9 reason is redacted', concat_ws('/', n.skip_reason !~ '@', n.skip_reason !~ '[0-9]{4}'), 't/t');
end $$;

-- 10. grants ---------------------------------------------------------------------------------
select null from pg_temp.expect('10 cancel_release_notice: service_role only',
  (has_function_privilege('service_role', 'public.cancel_release_notice(uuid,text)', 'EXECUTE')
   and not has_function_privilege('authenticated', 'public.cancel_release_notice(uuid,text)', 'EXECUTE')
   and not has_function_privilege('anon', 'public.cancel_release_notice(uuid,text)', 'EXECUTE')
   and not has_function_privilege('public', 'public.cancel_release_notice(uuid,text)', 'EXECUTE'))::text, 'true');
select null from pg_temp.expect('10 cancel_release_notice: invoker rights, pinned search_path',
  (select (not prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'])::text
     from pg_proc where oid = 'public.cancel_release_notice(uuid,text)'::regprocedure), 'true');
select null from pg_temp.expect('10 release / undo grants unchanged (authenticated + service_role, not anon)',
  (has_function_privilege('authenticated', 'public.release_visit_results(uuid,uuid[],text,uuid,jsonb)', 'EXECUTE')
   and has_function_privilege('service_role', 'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)', 'EXECUTE')
   and not has_function_privilege('anon', 'public.release_visit_results(uuid,uuid[],text,uuid,jsonb)', 'EXECUTE')
   and not has_function_privilege('anon', 'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)', 'EXECUTE'))::text, 'true');
select null from pg_temp.expect('10 release / undo stay SECURITY DEFINER with a pinned search_path',
  (select bool_and(prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'])::text
     from pg_proc where oid in ('public.release_visit_results(uuid,uuid[],text,uuid,jsonb)'::regprocedure,
                                'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)'::regprocedure)), 'true');
select null from pg_temp.expect('10 the table is still closed to anon / authenticated',
  (not has_table_privilege('anon', 'public.release_notices', 'SELECT')
   and not has_table_privilege('authenticated', 'public.release_notices', 'SELECT'))::text, 'true');

\echo '0214 smoke: all checks passed'
rollback;

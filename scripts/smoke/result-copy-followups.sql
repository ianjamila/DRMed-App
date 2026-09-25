-- =============================================================================
-- smoke/result-copy-followups.sql — 0179 on a local stack (rolls back)
-- =============================================================================
-- docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--   < scripts/smoke/result-copy-followups.sql
--
-- One patient, one imaging_xray test, one uploaded result, corrected four
-- times. Checks, in order:
--   1. Withdraw, not delete — an edit that drops an unacknowledged alert
--      withdraws it (kept, timestamped, attributed) instead of deleting it.
--   2. Re-page — a later edit whose alert list matches the withdrawn one
--      again inserts a NEW live row (the withdrawn one is not a match).
--   3. Acknowledged untouched — an edit never withdraws an acknowledged alert.
--   4. The FINALISE path (0172's result_finalise_commit) is unchanged: it
--      still deletes pre-0172 leftovers outright (that is not a correction).
--   5. Copy state — result_copy_states_internal's portal/print staleness and
--      followed_up flags, including that only a reception/admin print row
--      counts (a medtech print does not).
--   6. Grants — result_outdated_copies is reception/admin only;
--      result_copy_state is staff-wide but section-gated for lab roles.
--   7. result_mark_copy_contacted — only the LATEST amendment can be marked,
--      is idempotent (one audit row), and the previous one raises P0068.
--   8. Notify claim/record — result_claim_patient_notify pays out once;
--      result_record_patient_notify's success and failure paths.
-- Everything is inside one transaction that ROLLS BACK. The two-session
-- claim/mark-contacted races (assertion 9) run OUTSIDE this file, on their
-- own committed fixture — see the Task 4 report for that recipe.
-- =============================================================================
\set ON_ERROR_STOP on
begin;

-- ----- fixture ---------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('20000000-0000-4000-8000-00000000a201', 'smoke2-reception@example.test', 'authenticated', 'authenticated'),
  ('20000000-0000-4000-8000-00000000a202', 'smoke2-admin@example.test', 'authenticated', 'authenticated'),
  ('20000000-0000-4000-8000-00000000a203', 'smoke2-medtech@example.test', 'authenticated', 'authenticated');
insert into public.staff_profiles (id, full_name, role) values
  ('20000000-0000-4000-8000-00000000a201', 'Smoke2 Reception', 'reception'),
  ('20000000-0000-4000-8000-00000000a202', 'Smoke2 Admin', 'admin'),
  ('20000000-0000-4000-8000-00000000a203', 'Smoke2 Medtech', 'medtech');

insert into public.patients (id, first_name, last_name, birthdate, email, phone)
values ('20000000-0000-4000-8000-00000000b201', 'Smoke2', 'Patient', '1985-05-05',
        'smoke2.patient@example.test', '+639170000000');
insert into public.visits (id, patient_id)
values ('20000000-0000-4000-8000-00000000c201', '20000000-0000-4000-8000-00000000b201');

-- imaging_xray: outside medtech's sections (chemistry, hematology, ...), so
-- it exercises the section-gate in assertion 6.
insert into public.services (id, code, name, price_php, section) values
  ('20000000-0000-4000-8000-00000000d201', 'ZZSMK2_XR', 'Smoke2 X-ray', 100, 'imaging_xray');

insert into public.test_requests (id, visit_id, service_id, requested_by, status) values
  ('20000000-0000-4000-8000-00000000e201', '20000000-0000-4000-8000-00000000c201',
   '20000000-0000-4000-8000-00000000d201', '20000000-0000-4000-8000-00000000a202', 'ready_for_release');

insert into public.results (id, uploaded_by, storage_path, generation_kind, amended_at, amendment_count)
values ('20000000-0000-4000-8000-00000000f201', '20000000-0000-4000-8000-00000000a202',
        'v/g1.v1.pdf', 'uploaded', now() - interval '1 day', 0);
insert into public.result_test_requests (result_id, test_request_id) values
  ('20000000-0000-4000-8000-00000000f201', '20000000-0000-4000-8000-00000000e201');

create temp table smoke2_state (
  param_id uuid, alert1_id uuid, alert2_id uuid,
  amend1_id uuid, amend2_id uuid, amend3_id uuid, amend4_id uuid
) on commit drop;
grant select, update on smoke2_state to authenticated;
insert into smoke2_state (param_id) values ((select id from public.result_template_params limit 1));

with ins as (
  insert into public.critical_alerts
    (result_id, test_request_id, parameter_id, direction, parameter_name, observed_value_si)
  select '20000000-0000-4000-8000-00000000f201', '20000000-0000-4000-8000-00000000e201',
         param_id, 'high', 'Smoke2 K', 7.1
    from smoke2_state
  returning id
)
update smoke2_state set alert1_id = ins.id from ins;

-- ----- 1. withdraw, not delete ------------------------------------------------
do $$
declare
  v_out   jsonb;
  v_amend uuid;
  v_row   public.critical_alerts%rowtype;
begin
  v_out := public.result_edit_commit(
    '20000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-00000000f201', 0,
    '20000000-0000-4000-8000-00000000a202', 'first correction, value re-run',
    '20000000-0000-4000-8000-00000000e201', 'v/g1.v2.pdf', 100, null, null, '[]'::jsonb);
  if (v_out ->> 'alerts_removed')::int <> 1 then
    raise exception '1: expected 1 alert withdrawn, got %', v_out;
  end if;
  v_amend := (v_out ->> 'amendment_id')::uuid;
  update smoke2_state set amend1_id = v_amend;

  select * into v_row from public.critical_alerts where id = (select alert1_id from smoke2_state);
  if not found then
    raise exception '1: the alert row was deleted instead of withdrawn';
  end if;
  if v_row.withdrawn_at is null
     or v_row.withdrawn_by <> '20000000-0000-4000-8000-00000000a202'::uuid
     or v_row.withdrawn_by_amendment <> v_amend then
    raise exception '1: alert should be withdrawn by the editor on this amendment, got %', v_row;
  end if;
  raise notice '1 withdraw-not-delete OK';
end $$;

-- ----- 2. re-page --------------------------------------------------------------
do $$
declare
  v_out    jsonb;
  v_amend  uuid;
  v_new_id uuid;
begin
  v_out := public.result_edit_commit(
    '20000000-0000-4000-8000-0000000000b2', '20000000-0000-4000-8000-00000000f201', 1,
    '20000000-0000-4000-8000-00000000a202', 'second correction, value re-pages',
    '20000000-0000-4000-8000-00000000e201', 'v/g1.v3.pdf', 100, null, null,
    (select jsonb_build_array(jsonb_build_object(
       'test_request_id', '20000000-0000-4000-8000-00000000e201',
       'parameter_id', param_id, 'parameter_name', 'Smoke2 K',
       'direction', 'high', 'observed_value_si', 7.1, 'threshold_si', 7.0
     )) from smoke2_state));
  if jsonb_array_length(v_out -> 'alerts_added') <> 1 then
    raise exception '2: expected 1 alert re-paged, got %', v_out;
  end if;
  v_amend := (v_out ->> 'amendment_id')::uuid;
  update smoke2_state set amend2_id = v_amend;

  select id into v_new_id from public.critical_alerts
   where result_id = '20000000-0000-4000-8000-00000000f201' and withdrawn_at is null;
  if v_new_id is null then
    raise exception '2: expected a new, un-withdrawn alert row';
  end if;
  update smoke2_state set alert2_id = v_new_id;
  raise notice '2 re-page OK';
end $$;

-- ----- 3. acknowledged untouched -----------------------------------------------
do $$
declare
  v_out jsonb;
begin
  update public.critical_alerts
     set acknowledged_at = now(), acknowledged_by = '20000000-0000-4000-8000-00000000a202'
   where id = (select alert2_id from smoke2_state);

  v_out := public.result_edit_commit(
    '20000000-0000-4000-8000-0000000000b3', '20000000-0000-4000-8000-00000000f201', 2,
    '20000000-0000-4000-8000-00000000a202', 'third correction, no alert change',
    '20000000-0000-4000-8000-00000000e201', 'v/g1.v4.pdf', 100, null, null, '[]'::jsonb);
  update smoke2_state set amend3_id = (v_out ->> 'amendment_id')::uuid;

  if (select withdrawn_at from public.critical_alerts where id = (select alert2_id from smoke2_state))
       is not null then
    raise exception '3: an acknowledged alert must never be withdrawn';
  end if;
  raise notice '3 acknowledged-untouched OK';
end $$;

-- ----- 4. finalise path still deletes ------------------------------------------
do $$
begin
  if not (select prosrc ~ 'delete from public\.critical_alerts'
            from pg_proc where proname = 'result_finalise_commit') then
    raise exception '4: result_finalise_commit no longer deletes critical_alerts';
  end if;
  raise notice '4 finalise-path-still-deletes OK';
end $$;

-- ----- 5. copy state -------------------------------------------------------------
do $$
declare
  v_amended timestamptz;
  v_state   record;
begin
  select amended_at into v_amended from public.results where id = '20000000-0000-4000-8000-00000000f201';
  update public.results set patient_last_downloaded_at = v_amended - interval '1 hour'
   where id = '20000000-0000-4000-8000-00000000f201';

  select * into v_state
    from public.result_copy_states_internal(array['20000000-0000-4000-8000-00000000f201'::uuid]);
  if not v_state.portal_outdated or v_state.followed_up then
    raise exception '5a: expected portal_outdated=true, followed_up=false, got %', v_state;
  end if;

  -- A medtech-only print row must not count (the CTE filters role in reception/admin).
  insert into public.audit_log (actor_type, action, resource_type, resource_id, metadata)
  values ('staff', 'result.printed_staff', 'result', '20000000-0000-4000-8000-00000000f201',
          jsonb_build_object('result_id', '20000000-0000-4000-8000-00000000f201',
                             'amendment_count', '0', 'role', 'medtech'));
  select * into v_state
    from public.result_copy_states_internal(array['20000000-0000-4000-8000-00000000f201'::uuid]);
  if v_state.printed_outdated then
    raise exception '5b: a medtech-only print row must not set printed_outdated';
  end if;

  insert into public.audit_log (actor_type, action, resource_type, resource_id, metadata)
  values ('staff', 'result.printed_staff', 'result', '20000000-0000-4000-8000-00000000f201',
          jsonb_build_object('result_id', '20000000-0000-4000-8000-00000000f201',
                             'amendment_count', '0', 'role', 'reception'));
  select * into v_state
    from public.result_copy_states_internal(array['20000000-0000-4000-8000-00000000f201'::uuid]);
  if not v_state.printed_outdated then
    raise exception '5c: a reception print row at an old amendment_count must set printed_outdated';
  end if;
  raise notice '5 copy-state OK';
end $$;

-- ----- 6. grants -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-00000000a203","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.result_outdated_copies();
    raise exception '6a: medtech should not be able to call result_outdated_copies';
  exception when insufficient_privilege then
    raise notice '6a medtech-blocked OK';
  end;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-00000000a201","role":"authenticated"}', true);
do $$
declare v_row record; v_n int;
begin
  select * into v_row from public.result_outdated_copies()
   where result_id = '20000000-0000-4000-8000-00000000f201';
  if not found or v_row.patient_name is null then
    raise exception '6b: reception should see the row with a patient name, got %', v_row;
  end if;

  select count(*) into v_n
    from public.result_copy_state('{20000000-0000-4000-8000-00000000f201}'::uuid[]);
  if v_n <> 1 then
    raise exception '6c: reception result_copy_state should return 1 row, got %', v_n;
  end if;
  raise notice '6b-c reception sees the row OK';
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-00000000a203","role":"authenticated"}', true);
do $$
declare v_n int;
begin
  select count(*) into v_n
    from public.result_copy_state('{20000000-0000-4000-8000-00000000f201}'::uuid[]);
  if v_n <> 0 then
    raise exception '6d: medtech (x-ray outside their sections) should return 0 rows, got %', v_n;
  end if;
  raise notice '6d medtech-excluded OK';
end $$;
reset role;

-- ----- 7. mark contacted -------------------------------------------------------
-- audit_log's SELECT policy is admin-only for `authenticated`, so the audit
-- row checks below run as postgres (superuser, bypasses RLS) between the
-- reception-JWT calls to the RPC itself.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-00000000a201","role":"authenticated"}', true);
do $$
declare v_latest uuid;
begin
  select amend3_id into v_latest from smoke2_state;
  perform public.result_mark_copy_contacted(v_latest);
  if not (select followed_up from
            public.result_copy_state('{20000000-0000-4000-8000-00000000f201}'::uuid[])) then
    raise exception '7a: followed_up should be true after mark contacted';
  end if;
  raise notice '7a mark-contacted-sets-followed-up OK';
end $$;

reset role;
do $$
declare v_latest uuid; v_n int;
begin
  select amend3_id into v_latest from smoke2_state;
  select count(*) into v_n from public.audit_log
   where action = 'result.patient_contacted' and metadata ->> 'amendment_id' = v_latest::text;
  if v_n <> 1 then
    raise exception '7b: expected exactly 1 patient_contacted audit row, got %', v_n;
  end if;
  raise notice '7b one-audit-row OK';
end $$;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-00000000a201","role":"authenticated"}', true);
do $$
declare v_latest uuid; v_prev uuid;
begin
  select amend3_id, amend2_id into v_latest, v_prev from smoke2_state;
  begin
    perform public.result_mark_copy_contacted(v_prev);
    raise exception '7c: marking the PREVIOUS amendment should fail';
  exception when sqlstate 'P0068' then
    raise notice '7c previous-amendment-P0068 OK';
  end;
  -- Idempotent: calling it again on the latest amendment is a no-op.
  perform public.result_mark_copy_contacted(v_latest);
end $$;
reset role;

do $$
declare v_n int;
begin
  select count(*) into v_n from public.audit_log where action = 'result.patient_contacted';
  if v_n <> 1 then
    raise exception '7d: calling it again should not write a second audit row, got %', v_n;
  end if;
  raise notice '7d idempotent-no-second-audit-row OK';
end $$;

-- ----- 8. notify once ------------------------------------------------------------
do $$
declare
  v_latest uuid;
  v_row    record;
  v_n      int;
  v_state  record;
begin
  select amend3_id into v_latest from smoke2_state;

  select * into v_row from public.result_claim_patient_notify(v_latest);
  if v_row.result_id is null then
    raise exception '8a: the first claim should return a row';
  end if;

  select count(*) into v_n from public.result_claim_patient_notify(v_latest);
  if v_n <> 0 then
    raise exception '8b: the second claim should return 0 rows, got %', v_n;
  end if;

  perform public.result_record_patient_notify(v_latest, '{email}'::text[], null);
  select * into v_state
    from public.result_copy_states_internal(array['20000000-0000-4000-8000-00000000f201'::uuid]);
  if not v_state.followed_up then
    raise exception '8c: followed_up should be true after a successful notify, got %', v_state;
  end if;
  raise notice '8a-c notify-success-path OK';
end $$;

-- A fresh amendment (amend3 is already claimed) for the notify-FAILURE path.
do $$
declare v_out jsonb;
begin
  v_out := public.result_edit_commit(
    '20000000-0000-4000-8000-0000000000b4', '20000000-0000-4000-8000-00000000f201', 3,
    '20000000-0000-4000-8000-00000000a202', 'fourth correction, notify-failure fixture',
    '20000000-0000-4000-8000-00000000e201', 'v/g1.v5.pdf', 100, null, null, '[]'::jsonb);
  update smoke2_state set amend4_id = (v_out ->> 'amendment_id')::uuid;
end $$;

do $$
declare
  v_amend4 uuid;
  v_state  record;
begin
  select amend4_id into v_amend4 from smoke2_state;
  perform public.result_claim_patient_notify(v_amend4);
  perform public.result_record_patient_notify(v_amend4, '{}'::text[], 'provider down');

  select * into v_state
    from public.result_copy_states_internal(array['20000000-0000-4000-8000-00000000f201'::uuid]);
  if v_state.followed_up then
    raise exception '8d: followed_up should be false after a failed notify with no contact, got %', v_state;
  end if;
  raise notice '8d notify-failure-followed-up-false OK';
end $$;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-00000000a201","role":"authenticated"}', true);
do $$
declare v_state record;
begin
  select * into v_state
    from public.result_copy_state('{20000000-0000-4000-8000-00000000f201}'::uuid[]);
  if not v_state.notify_failed then
    raise exception '8e: result_copy_state should report notify_failed=true, got %', v_state;
  end if;
  raise notice '8e notify-failed-via-result_copy_state OK';
end $$;
reset role;

-- the ACL-only functions stay closed to a signed-in JWT with the wrong role,
-- and 0179's ACLs are additionally pinned by result-copy-followups-migration.test.ts.

rollback;

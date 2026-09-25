-- =============================================================================
-- 0172_result_edit_commit_smoke.sql
-- =============================================================================
-- DB smoke test for migration 0172. Runs inside BEGIN/ROLLBACK and leaves no
-- state behind. Each check raises on unexpected behaviour and notices on
-- success. Self-contained: mints its own auth users, staff, services, template,
-- patient, visit, tests and results.
--
-- What it proves:
--   A. One lock for draft / finalise / edit (result_save_draft,
--      result_finalise_commit, result_edit_commit):
--      1. an edit before finalise is refused (P0066);
--      2. finalise writes values + PDF pointer + finalised_at + alerts at once
--         and the status-flip trigger fires inside it;
--      3. a second finalise and a draft after finalise are refused (P0066).
--   B. result_edit_commit:
--      4. an edit snapshots the prior values, replaces them, bumps the version,
--         and leaves every test's status / released_at / released_by /
--         release_medium untouched;
--      5. a stale expected count is refused (P0065);
--      6. the same attempt id replays the committed edit and writes nothing;
--      7. alerts: a new crossing is added, an unacknowledged one that no longer
--         applies is withdrawn, an acknowledged one is kept, an identical one is
--         not duplicated, and a changed critical value re-pages;
--      8. a result with an unfinished live member is refused (P0066).
--   C. Reads (as the signed-in user, through RLS):
--      9. an in-section medtech who never held the test reads a finished
--         result's values and history; an x-ray technician and reception read
--         neither; an in-progress result stays holder-only;
--     10. a deleted member in ANOTHER section hides the result from a medtech;
--         a deleted member in their own section does not.
--   D. Write doors closed: 11. JWT writes to results / result_values /
--      result_amendments are refused; 12. the three commit functions are not
--      executable by authenticated.
--   E. Delete guard: 13. P0067 blocks soft-deleting a member of a finished
--      combined report, including through a package-header cascade;
--      14. CONTROL — with the P0067 clause removed, the same delete succeeds, so
--      the refusal above is P0067's doing and not P0042/P0043/P0044's.
--
-- Run against the local stack:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f /dev/stdin < supabase/tests/0172_result_edit_commit_smoke.sql
-- =============================================================================

begin;

-- --- Fixture ----------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000172', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke167-holder@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000172', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke167-other@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000172', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke167-xray@example.test', '', now(), now(), now()),
  ('a3000000-0000-4000-8000-000000000172', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke167-reception@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role) values
  ('a0000000-0000-4000-8000-000000000172', 'Smoke Holder', 'medtech'),
  ('a1000000-0000-4000-8000-000000000172', 'Smoke Other Medtech', 'medtech'),
  ('a2000000-0000-4000-8000-000000000172', 'Smoke Xray', 'xray_technician'),
  ('a3000000-0000-4000-8000-000000000172', 'Smoke Reception', 'reception');

insert into public.services (id, code, name, price_php, kind, section) values
  ('c0000000-0000-4000-8000-000000000172', 'SMK167-GLU', 'Smoke Glucose', 100, 'lab_test', 'chemistry'),
  ('c1000000-0000-4000-8000-000000000172', 'SMK167-BUN', 'Smoke BUN', 100, 'lab_test', 'chemistry'),
  ('c2000000-0000-4000-8000-000000000172', 'SMK167-XR', 'Smoke X-ray', 100, 'lab_test', 'imaging_xray');

insert into public.result_templates (id, service_id, layout)
values ('b0000000-0000-4000-8000-000000000172', 'c0000000-0000-4000-8000-000000000172', 'simple');
insert into public.result_template_params (id, template_id, sort_order, parameter_name, input_type) values
  ('b1000000-0000-4000-8000-000000000172', 'b0000000-0000-4000-8000-000000000172', 1, 'P1', 'numeric'),
  ('b2000000-0000-4000-8000-000000000172', 'b0000000-0000-4000-8000-000000000172', 2, 'P2', 'numeric'),
  ('b3000000-0000-4000-8000-000000000172', 'b0000000-0000-4000-8000-000000000172', 3, 'P3', 'numeric');

insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values ('d0000000-0000-4000-8000-000000000172', 'DRM-SMK167', 'Smoke', 'Patient', '1990-01-01', 'female');

-- Unpaid on purpose: it is what leaves a ready_for_release line deletable, so
-- the P0067 control (14) can show the delete would otherwise succeed.
insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
values ('e0000000-0000-4000-8000-000000000172', 'V-SMK167', 'd0000000-0000-4000-8000-000000000172',
        (now() at time zone 'Asia/Manila')::date, 'unpaid', 300, 0);

-- R1: the combined report under test — T1 + T2, held by the holder.
insert into public.test_requests (id, visit_id, service_id, status, requested_by, assigned_to,
                                  base_price_php, final_price_php) values
  ('f0000000-0000-4000-8000-000000000172', 'e0000000-0000-4000-8000-000000000172',
   'c0000000-0000-4000-8000-000000000172', 'in_progress', 'a0000000-0000-4000-8000-000000000172',
   'a0000000-0000-4000-8000-000000000172', 100, 100),
  ('f1000000-0000-4000-8000-000000000172', 'e0000000-0000-4000-8000-000000000172',
   'c1000000-0000-4000-8000-000000000172', 'in_progress', 'a0000000-0000-4000-8000-000000000172',
   'a0000000-0000-4000-8000-000000000172', 100, 100);
insert into public.results (id, generation_kind, uploaded_by)
values ('10000000-0000-4000-8000-000000000172', 'structured', 'a0000000-0000-4000-8000-000000000172');
insert into public.result_test_requests (result_id, test_request_id) values
  ('10000000-0000-4000-8000-000000000172', 'f0000000-0000-4000-8000-000000000172'),
  ('10000000-0000-4000-8000-000000000172', 'f1000000-0000-4000-8000-000000000172');

-- R2: still on the bench (in progress, holder only).
insert into public.test_requests (id, visit_id, service_id, status, requested_by, assigned_to,
                                  base_price_php, final_price_php)
values ('f2000000-0000-4000-8000-000000000172', 'e0000000-0000-4000-8000-000000000172',
        'c0000000-0000-4000-8000-000000000172', 'in_progress', 'a0000000-0000-4000-8000-000000000172',
        'a0000000-0000-4000-8000-000000000172', 100, 100);
insert into public.results (id, generation_kind, uploaded_by)
values ('20000000-0000-4000-8000-000000000172', 'structured', 'a0000000-0000-4000-8000-000000000172');
insert into public.result_test_requests (result_id, test_request_id)
values ('20000000-0000-4000-8000-000000000172', 'f2000000-0000-4000-8000-000000000172');
insert into public.result_values (result_id, parameter_id, numeric_value_si, is_blank)
values ('20000000-0000-4000-8000-000000000172', 'b1000000-0000-4000-8000-000000000172', 7, false);

-- R3: finished, one live chemistry member + one DELETED x-ray member.
-- R4: finished, one live chemistry member + one DELETED chemistry member.
-- deleted_at is set on INSERT so the delete guard (an UPDATE trigger) is not involved.
insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php, deleted_at, delete_reason) values
  ('f3000000-0000-4000-8000-000000000172', 'e0000000-0000-4000-8000-000000000172',
   'c0000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 100, 100, null, null),
  ('f4000000-0000-4000-8000-000000000172', 'e0000000-0000-4000-8000-000000000172',
   'c2000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 100, 100, now(), 'smoke'),
  ('f5000000-0000-4000-8000-000000000172', 'e0000000-0000-4000-8000-000000000172',
   'c0000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 100, 100, null, null),
  ('f6000000-0000-4000-8000-000000000172', 'e0000000-0000-4000-8000-000000000172',
   'c1000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 100, 100, now(), 'smoke');
insert into public.results (id, generation_kind, uploaded_by, storage_path, file_size_bytes, finalised_at) values
  ('30000000-0000-4000-8000-000000000172', 'structured', 'a0000000-0000-4000-8000-000000000172', 'r3.pdf', 10, now()),
  ('40000000-0000-4000-8000-000000000172', 'structured', 'a0000000-0000-4000-8000-000000000172', 'r4.pdf', 10, now());
insert into public.result_test_requests (result_id, test_request_id) values
  ('30000000-0000-4000-8000-000000000172', 'f3000000-0000-4000-8000-000000000172'),
  ('30000000-0000-4000-8000-000000000172', 'f4000000-0000-4000-8000-000000000172'),
  ('40000000-0000-4000-8000-000000000172', 'f5000000-0000-4000-8000-000000000172'),
  ('40000000-0000-4000-8000-000000000172', 'f6000000-0000-4000-8000-000000000172');
insert into public.result_values (result_id, parameter_id, numeric_value_si, is_blank) values
  ('30000000-0000-4000-8000-000000000172', 'b1000000-0000-4000-8000-000000000172', 5, false),
  ('40000000-0000-4000-8000-000000000172', 'b1000000-0000-4000-8000-000000000172', 5, false);

-- --- A + B: draft / finalise / edit ------------------------------------------

do $smoke$
declare
  k_r1     constant uuid := '10000000-0000-4000-8000-000000000172';
  k_t1     constant uuid := 'f0000000-0000-4000-8000-000000000172';
  k_t2     constant uuid := 'f1000000-0000-4000-8000-000000000172';
  k_holder constant uuid := 'a0000000-0000-4000-8000-000000000172';
  k_other  constant uuid := 'a1000000-0000-4000-8000-000000000172';
  k_p1     constant uuid := 'b1000000-0000-4000-8000-000000000172';
  k_p2     constant uuid := 'b2000000-0000-4000-8000-000000000172';
  k_p3     constant uuid := 'b3000000-0000-4000-8000-000000000172';
  k_try1   constant uuid := '90000000-0000-4000-8000-000000000172';
  v_state  text;
  v_raised boolean;
  v_out    jsonb;
  v_n      int;
  v_before text;
  v_after  text;
begin
  -- A0. Drafts work while unfinalised.
  perform public.result_save_draft(k_r1,
    jsonb_build_array(jsonb_build_object('parameter_id', k_p1, 'numeric_value_si', 1.5)));
  select count(*) into v_n from public.result_values where result_id = k_r1;
  if v_n <> 1 then raise exception 'A0: draft did not write (% rows)', v_n; end if;

  -- A1. An edit before finalise is refused.
  v_raised := false;
  begin
    perform public.result_edit_commit(gen_random_uuid(), k_r1, 0, k_other, 'fixing a value',
      k_t1, 'x.pdf', 10, '[]'::jsonb, null, null);
  exception when others then
    v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0066' then
    raise exception 'A1: edit before finalise should raise P0066 (raised=%, state=%)', v_raised, v_state;
  end if;
  raise notice 'A1 ok: edit before finalise refused (P0066)';

  -- A2. Finalise: values, pointer, finalised_at, alerts and the status flip together.
  v_out := public.result_finalise_commit(k_r1, k_holder,
    jsonb_build_array(
      jsonb_build_object('parameter_id', k_p1, 'numeric_value_si', 1.0, 'flag', 'L'),
      jsonb_build_object('parameter_id', k_p2, 'numeric_value_si', 20, 'flag', 'H')),
    'r1.v1.aaaaaaaa.pdf', 100, now(), null,
    jsonb_build_array(
      jsonb_build_object('test_request_id', k_t1, 'parameter_id', k_p1, 'parameter_name', 'P1',
                         'direction', 'low', 'observed_value_si', 1.0, 'threshold_si', 2),
      jsonb_build_object('test_request_id', k_t2, 'parameter_id', k_p2, 'parameter_name', 'P2',
                         'direction', 'high', 'observed_value_si', 20, 'threshold_si', 15)));
  if jsonb_array_length(v_out->'alerts_added') <> 2 then
    raise exception 'A2: expected 2 alerts at finalise, got %', v_out;
  end if;
  select count(*) into v_n from public.test_requests
   where id in (k_t1, k_t2) and status in ('ready_for_release', 'result_uploaded');
  if v_n <> 2 then raise exception 'A2: status flip did not fire inside finalise (% flipped)', v_n; end if;
  select count(*) into v_n from public.result_values where result_id = k_r1;
  if v_n <> 2 then raise exception 'A2: finalise should replace the draft set (% rows)', v_n; end if;
  raise notice 'A2 ok: finalise atomic, statuses flipped, 2 alerts';

  -- A3. Second finalise and a late draft are both refused.
  v_raised := false;
  begin
    perform public.result_finalise_commit(k_r1, k_holder, '[]'::jsonb, 'again.pdf', 10, now(), null, '[]'::jsonb);
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0066' then raise exception 'A3: re-finalise should raise P0066'; end if;
  v_raised := false;
  begin
    perform public.result_save_draft(k_r1,
      jsonb_build_array(jsonb_build_object('parameter_id', k_p1, 'numeric_value_si', 99)));
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0066' then raise exception 'A3: draft after finalise should raise P0066'; end if;
  raise notice 'A3 ok: re-finalise and late draft refused (P0066)';

  -- Release T1 (a real release would need the GL bridge; the fixture only
  -- needs the released columns set, so triggers are bypassed for this one write).
  set local session_replication_role = replica;
  update public.test_requests
     set status = 'released', released_at = now() - interval '1 hour',
         released_by = k_holder, release_medium = 'email'
   where id = k_t1;
  set local session_replication_role = origin;

  -- The pathologist acknowledges the P2 high alert.
  update public.critical_alerts set acknowledged_at = now(), acknowledged_by = k_holder
   where result_id = k_r1 and parameter_id = k_p2;

  select string_agg(id || status || coalesce(released_at::text, '') || coalesce(released_by::text, '')
                    || coalesce(release_medium, ''), ',' order by id)
    into v_before from public.test_requests where id in (k_t1, k_t2);

  -- B4. The edit: P1 corrected out of critical, P2 unchanged (acked), P3 new crossing.
  v_out := public.result_edit_commit(k_try1, k_r1, 0, k_other, 'transcription corrected',
    k_t1, 'r1.v2.bbbbbbbb.pdf', 120,
    jsonb_build_array(
      jsonb_build_object('parameter_id', k_p1, 'numeric_value_si', 3.0),
      jsonb_build_object('parameter_id', k_p2, 'numeric_value_si', 20, 'flag', 'H'),
      jsonb_build_object('parameter_id', k_p3, 'numeric_value_si', 0.5, 'flag', 'L')),
    null,
    jsonb_build_array(
      jsonb_build_object('test_request_id', k_t2, 'parameter_id', k_p2, 'parameter_name', 'P2',
                         'direction', 'high', 'observed_value_si', 20, 'threshold_si', 15),
      jsonb_build_object('test_request_id', k_t1, 'parameter_id', k_p3, 'parameter_name', 'P3',
                         'direction', 'low', 'observed_value_si', 0.5, 'threshold_si', 1)));
  if (v_out->>'amendment_seq')::int <> 1 or (v_out->>'replayed')::boolean then
    raise exception 'B4: unexpected edit outcome %', v_out;
  end if;
  select string_agg(id || status || coalesce(released_at::text, '') || coalesce(released_by::text, '')
                    || coalesce(release_medium, ''), ',' order by id)
    into v_after from public.test_requests where id in (k_t1, k_t2);
  if v_before is distinct from v_after then
    raise exception 'B4: an edit changed test status/release fields: % -> %', v_before, v_after;
  end if;
  if (select storage_path from public.results where id = k_r1) <> 'r1.v2.bbbbbbbb.pdf'
     or (select amendment_count from public.results where id = k_r1) <> 1
     or (select finalised_at is null from public.results where id = k_r1) then
    raise exception 'B4: results row not updated as expected';
  end if;
  if (select jsonb_array_length(prior_values_json) from public.result_amendments where attempt_id = k_try1) <> 2 then
    raise exception 'B4: snapshot should hold the 2 prior values';
  end if;
  if (select numeric_value_si from public.result_values where result_id = k_r1 and parameter_id = k_p1) <> 3.0 then
    raise exception 'B4: values were not replaced';
  end if;
  raise notice 'B4 ok: edit committed, snapshot taken, status/release fields untouched';

  -- B7 (first half). Alerts after the edit.
  if jsonb_array_length(v_out->'alerts_added') <> 1 or (v_out->>'alerts_removed')::int <> 1 then
    raise exception 'B7: expected 1 added (P3) and 1 withdrawn (P1), got %', v_out;
  end if;
  if not exists (select 1 from public.critical_alerts where result_id = k_r1 and parameter_id = k_p2
                  and acknowledged_at is not null) then
    raise exception 'B7: the acknowledged P2 alert was touched';
  end if;
  select count(*) into v_n from public.critical_alerts where result_id = k_r1 and parameter_id = k_p2;
  if v_n <> 1 then raise exception 'B7: identical P2 crossing was duplicated (% rows)', v_n; end if;

  -- B5. Stale form.
  v_raised := false;
  begin
    perform public.result_edit_commit(gen_random_uuid(), k_r1, 0, k_other, 'a stale second edit',
      k_t1, 'r1.v2.cccccccc.pdf', 10, '[]'::jsonb, null, null);
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0065' then
    raise exception 'B5: stale edit should raise P0065 (raised=%, state=%)', v_raised, v_state;
  end if;
  raise notice 'B5 ok: stale edit refused (P0065)';

  -- B6. Replay of the committed attempt returns it and writes nothing.
  v_out := public.result_edit_commit(k_try1, k_r1, 0, k_other, 'transcription corrected',
    k_t1, 'r1.v2.bbbbbbbb.pdf', 120, '[]'::jsonb, null, '[]'::jsonb);
  if not (v_out->>'replayed')::boolean
     or (select amendment_count from public.results where id = k_r1) <> 1
     or (select count(*) from public.result_values where result_id = k_r1) <> 3 then
    raise exception 'B6: replay should be a no-op returning the first commit, got %', v_out;
  end if;
  raise notice 'B6 ok: same attempt id replays without writing';

  -- B7 (second half). P1 corrected to a DIFFERENT critical value re-pages; P3
  -- withdrawn; the acknowledged P2 stays even though no longer desired.
  v_out := public.result_edit_commit(gen_random_uuid(), k_r1, 1, k_other, 'rerun on second sample',
    k_t1, 'r1.v3.dddddddd.pdf', 130,
    jsonb_build_array(jsonb_build_object('parameter_id', k_p1, 'numeric_value_si', 0.9, 'flag', 'L')),
    null,
    jsonb_build_array(
      jsonb_build_object('test_request_id', k_t1, 'parameter_id', k_p1, 'parameter_name', 'P1',
                         'direction', 'low', 'observed_value_si', 0.9, 'threshold_si', 2)));
  if jsonb_array_length(v_out->'alerts_added') <> 1 or (v_out->>'alerts_removed')::int <> 1
     or (v_out->>'alerts_kept_acknowledged')::int <> 1 then
    raise exception 'B7: expected +1 / -1 / 1 kept, got %', v_out;
  end if;
  raise notice 'B7 ok: alerts added / withdrawn / acknowledged kept / no duplicates / re-page';

  -- B8. An unfinished live member blocks the edit.
  update public.test_requests set status = 'in_progress' where id = k_t2;
  v_raised := false;
  begin
    perform public.result_edit_commit(gen_random_uuid(), k_r1, 2, k_other, 'should not pass',
      k_t1, 'x.pdf', 10, '[]'::jsonb, null, null);
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0066' then raise exception 'B8: unfinished member should raise P0066'; end if;
  update public.test_requests set status = 'ready_for_release' where id = k_t2;
  raise notice 'B8 ok: unfinished member refused (P0066)';
end
$smoke$;

-- --- C + D: reads and closed write doors, as the signed-in user ---------------

create function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;

do $smoke$
declare
  k_r1 constant uuid := '10000000-0000-4000-8000-000000000172';
  k_r2 constant uuid := '20000000-0000-4000-8000-000000000172';
  k_r3 constant uuid := '30000000-0000-4000-8000-000000000172';
  k_r4 constant uuid := '40000000-0000-4000-8000-000000000172';
  v_vals int; v_hist int; v_r2 int; v_r3 int; v_r4 int;
  v_state text; v_raised boolean;
begin
  -- 9. In-section non-holder medtech.
  perform pg_temp.as_user('a1000000-0000-4000-8000-000000000172');
  select count(*) into v_vals from public.result_values where result_id = k_r1;
  select count(*) into v_hist from public.result_amendments where result_id = k_r1;
  select count(*) into v_r2 from public.result_values where result_id = k_r2;
  select count(*) into v_r3 from public.result_values where result_id = k_r3;
  select count(*) into v_r4 from public.result_values where result_id = k_r4;
  perform set_config('role', 'postgres', true);
  if v_vals = 0 or v_hist <> 2 then
    raise exception 'C9: non-holder medtech should read finished values + history (vals=%, hist=%)', v_vals, v_hist;
  end if;
  if v_r2 <> 0 then raise exception 'C9: an in-progress result must stay holder-only (%)', v_r2; end if;
  if v_r3 <> 0 then raise exception 'C10: deleted member in another section must hide the result (%)', v_r3; end if;
  if v_r4 = 0 then raise exception 'C10: deleted member in own section must not hide the result'; end if;

  -- The holder still reads their bench draft (0151 owner policy).
  perform pg_temp.as_user('a0000000-0000-4000-8000-000000000172');
  select count(*) into v_r2 from public.result_values where result_id = k_r2;
  perform set_config('role', 'postgres', true);
  if v_r2 = 0 then raise exception 'C9: holder lost their in-progress values'; end if;

  -- X-ray technician and reception read neither values nor history.
  perform pg_temp.as_user('a2000000-0000-4000-8000-000000000172');
  select count(*) into v_vals from public.result_values where result_id = k_r1;
  select count(*) into v_hist from public.result_amendments where result_id = k_r1;
  perform set_config('role', 'postgres', true);
  if v_vals + v_hist <> 0 then raise exception 'C9: x-ray tech read chemistry (% / %)', v_vals, v_hist; end if;
  perform pg_temp.as_user('a3000000-0000-4000-8000-000000000172');
  select count(*) into v_vals from public.result_values where result_id = k_r1;
  select count(*) into v_hist from public.result_amendments where result_id = k_r1;
  perform set_config('role', 'postgres', true);
  if v_vals + v_hist <> 0 then raise exception 'C9: reception read results (% / %)', v_vals, v_hist; end if;
  raise notice 'C9/C10 ok: section + finished read rule, holder draft kept, deleted-member rule';

  -- 11. JWT writes are refused.
  perform pg_temp.as_user('a0000000-0000-4000-8000-000000000172');
  v_raised := false;
  begin
    insert into public.result_values (result_id, parameter_id, numeric_value_si, is_blank)
    values (k_r2, 'b2000000-0000-4000-8000-000000000172', 1, false);
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised then perform set_config('role', 'postgres', true);
    raise exception 'D11: JWT insert into result_values succeeded'; end if;
  update public.results set amendment_count = 99 where id = k_r1;
  get diagnostics v_vals = row_count;
  if v_vals <> 0 then perform set_config('role', 'postgres', true);
    raise exception 'D11: JWT update of results changed % rows', v_vals; end if;
  v_raised := false;
  begin
    insert into public.result_amendments (result_id, test_request_id, prior_storage_path,
      prior_uploaded_by, prior_uploaded_at, reason, amended_by, amendment_seq)
    values (k_r1, 'f0000000-0000-4000-8000-000000000172', 'x', 'a0000000-0000-4000-8000-000000000172',
            now(), 'forged', 'a0000000-0000-4000-8000-000000000172', 50);
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised then perform set_config('role', 'postgres', true);
    raise exception 'D11: JWT insert into result_amendments succeeded'; end if;

  -- 12. The commit functions are not callable by a signed-in user.
  v_raised := false;
  begin
    perform public.result_edit_commit(gen_random_uuid(), k_r1, 2, 'a0000000-0000-4000-8000-000000000172',
      'direct call', 'f0000000-0000-4000-8000-000000000172', 'x.pdf', 10, null, null, null);
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  perform set_config('role', 'postgres', true);
  if not v_raised or v_state <> '42501' then
    raise exception 'D12: authenticated could call result_edit_commit (raised=%, state=%)', v_raised, v_state;
  end if;
  if has_function_privilege('authenticated', 'public.result_finalise_commit(uuid,uuid,jsonb,text,int,timestamptz,jsonb,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.result_save_draft(uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.result_edit_commit(uuid,uuid,int,uuid,text,uuid,text,int,jsonb,jsonb,jsonb)', 'execute') then
    raise exception 'D12: a commit function is executable by authenticated/anon';
  end if;
  raise notice 'D11/D12 ok: JWT writes refused, commit functions service-role only';
end
$smoke$;

-- --- E: delete guard ------------------------------------------------------------

do $smoke$
declare
  k_t2 constant uuid := 'f1000000-0000-4000-8000-000000000172';
  v_state text; v_raised boolean;
begin
  -- 13. T2 (ready_for_release, unpaid visit) is on the finished combined R1.
  v_raised := false;
  begin
    update public.test_requests set deleted_at = now(), delete_reason = 'smoke'
     where id = k_t2;
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0067' then
    raise exception 'E13: deleting a finished combined member should raise P0067 (raised=%, state=%)', v_raised, v_state;
  end if;
  raise notice 'E13 ok: combined-report member delete refused (P0067)';
end
$smoke$;

-- 13b. Package cascade: a header whose component sits on a finished combined
-- report cannot be deleted either (the guard runs at every trigger depth).
insert into public.services (id, code, name, price_php, kind, section)
values ('c3000000-0000-4000-8000-000000000172', 'SMK167-PKG', 'Smoke Package', 200, 'lab_package', 'package')
on conflict do nothing;
do $smoke$
declare
  k_hdr  constant uuid := 'f7000000-0000-4000-8000-000000000172';
  k_comp constant uuid := 'f8000000-0000-4000-8000-000000000172';
  k_sib  constant uuid := 'f9000000-0000-4000-8000-000000000172';
  k_res  constant uuid := '50000000-0000-4000-8000-000000000172';
  v_state text; v_raised boolean;
begin
  insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, is_package_header)
  values (k_hdr, 'e0000000-0000-4000-8000-000000000172', 'c3000000-0000-4000-8000-000000000172',
          'in_progress', 'a0000000-0000-4000-8000-000000000172', 200, 200, true);
  insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, parent_id) values
    (k_comp, 'e0000000-0000-4000-8000-000000000172', 'c0000000-0000-4000-8000-000000000172',
     'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 0, 0, k_hdr),
    (k_sib, 'e0000000-0000-4000-8000-000000000172', 'c1000000-0000-4000-8000-000000000172',
     'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 0, 0, k_hdr);
  insert into public.results (id, generation_kind, uploaded_by, storage_path, file_size_bytes, finalised_at)
  values (k_res, 'structured', 'a0000000-0000-4000-8000-000000000172', 'r5.pdf', 10, now());
  insert into public.result_test_requests (result_id, test_request_id)
  values (k_res, k_comp), (k_res, k_sib);

  v_raised := false;
  begin
    update public.test_requests set deleted_at = now(), delete_reason = 'smoke' where id = k_hdr;
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0067' then
    raise exception 'E13b: package delete over a finished combined component should raise P0067 (raised=%, state=%)',
      v_raised, v_state;
  end if;
  if exists (select 1 from public.test_requests where id in (k_hdr, k_comp, k_sib) and deleted_at is not null) then
    raise exception 'E13b: the refused package delete left rows deleted';
  end if;
  raise notice 'E13b ok: package cascade refused as a whole (P0067)';
end
$smoke$;

-- --- F15: whole-visit soft delete of a finished combined report ------------
-- The visits guard (trg_visits_deletable_guard / enforce_deletable_visit,
-- 0125) is a SEPARATE trigger/function from the test_requests guard P0067
-- lives in. It never looks at result_test_requests, so a visit holding a
-- finished combined report (both members ready_for_release, unpaid) deletes
-- as a whole, and — because deleting a VISIT does NOT cascade to its
-- test_requests (0125's only cascade is package header -> components,
-- CLAUDE.md) — the members are left exactly as they were. Restore then works
-- the same way (the guard only checks the null -> not-null transition).

insert into public.patients (id, drm_id, first_name, last_name, birthdate, sex)
values ('d1000000-0000-4000-8000-000000000172', 'DRM-SMK167F15', 'Smoke', 'F15Patient', '1990-01-01', 'female');

insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
values ('e1000000-0000-4000-8000-000000000172', 'V-SMK167F15', 'd1000000-0000-4000-8000-000000000172',
        (now() at time zone 'Asia/Manila')::date, 'unpaid', 200, 0);

insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php) values
  ('70000000-0000-4000-8000-000000000172', 'e1000000-0000-4000-8000-000000000172',
   'c0000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 100, 100),
  ('71000000-0000-4000-8000-000000000172', 'e1000000-0000-4000-8000-000000000172',
   'c1000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 100, 100);

insert into public.results (id, generation_kind, uploaded_by, storage_path, file_size_bytes, finalised_at)
values ('60000000-0000-4000-8000-000000000172', 'structured', 'a0000000-0000-4000-8000-000000000172', 'f15.pdf', 10, now());

insert into public.result_test_requests (result_id, test_request_id) values
  ('60000000-0000-4000-8000-000000000172', '70000000-0000-4000-8000-000000000172'),
  ('60000000-0000-4000-8000-000000000172', '71000000-0000-4000-8000-000000000172');

do $smoke$
declare
  k_visit constant uuid := 'e1000000-0000-4000-8000-000000000172';
  k_t1    constant uuid := '70000000-0000-4000-8000-000000000172';
  k_t2    constant uuid := '71000000-0000-4000-8000-000000000172';
begin
  update public.visits set deleted_at = now(), deleted_by = 'a3000000-0000-4000-8000-000000000172',
    delete_reason = 'F15 smoke' where id = k_visit;

  if (select deleted_at from public.visits where id = k_visit) is null then
    raise exception 'F15: whole-visit delete did not take effect';
  end if;
  if exists (select 1 from public.test_requests where id in (k_t1, k_t2) and deleted_at is not null) then
    raise exception 'F15: visit delete incorrectly cascaded to test_requests (should not — 0125)';
  end if;
  raise notice 'F15a ok: whole-visit delete of a finished combined report succeeded, members untouched';

  update public.visits set deleted_at = null, deleted_by = null, delete_reason = null where id = k_visit;
  if (select deleted_at from public.visits where id = k_visit) is not null then
    raise exception 'F15: visit restore did not take effect';
  end if;
  raise notice 'F15b ok: visit restore succeeded';
end
$smoke$;

-- --- F16: the RE-CREATED enforce_deletable_test_request still raises P0043 /
-- P0044 / P0050 / P0042 (0172 replaced the whole function body to add
-- P0067). Check order inside the function: released (P0043) -> package
-- component (P0044) -> combined report (P0067) -> open HMO claim (P0050) ->
-- visit not unpaid (P0042). Each case here uses a single-test line NOT
-- linked to any shared result, so P0067 never pre-empts P0050 / P0042. ------

-- F16a: P0043 — released.
insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php)
values ('72000000-0000-4000-8000-000000000172', 'e1000000-0000-4000-8000-000000000172',
        'c0000000-0000-4000-8000-000000000172', 'released', 'a0000000-0000-4000-8000-000000000172', 100, 100);

-- F16b: P0044 — direct component delete (header + component; component is
-- NOT linked to any shared result).
insert into public.services (id, code, name, price_php, kind, section)
values ('c4000000-0000-4000-8000-000000000172', 'SMK167-PKG16', 'Smoke Package F16', 200, 'lab_package', 'package')
on conflict do nothing;
insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php, is_package_header)
values ('73000000-0000-4000-8000-000000000172', 'e1000000-0000-4000-8000-000000000172',
        'c4000000-0000-4000-8000-000000000172', 'in_progress', 'a0000000-0000-4000-8000-000000000172', 200, 200, true);
insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php, parent_id)
values ('74000000-0000-4000-8000-000000000172', 'e1000000-0000-4000-8000-000000000172',
        'c0000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 0, 0,
        '73000000-0000-4000-8000-000000000172');

-- F16c: P0050 — open HMO claim. Visit stays unpaid (0133 keeps an HMO visit
-- unpaid forever) so P0042 cannot fire first.
insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php)
values ('75000000-0000-4000-8000-000000000172', 'e1000000-0000-4000-8000-000000000172',
        'c1000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 100, 100);
insert into public.hmo_providers (id, name)
values ('80000000-0000-4000-8000-000000000172', 'Smoke HMO F16')
on conflict do nothing;
insert into public.hmo_claim_batches (id, provider_id, status)
values ('81000000-0000-4000-8000-000000000172', '80000000-0000-4000-8000-000000000172', 'submitted');
insert into public.hmo_claim_items (id, batch_id, test_request_id, billed_amount_php, batch_voided)
values ('82000000-0000-4000-8000-000000000172', '81000000-0000-4000-8000-000000000172',
        '75000000-0000-4000-8000-000000000172', 100, false);

-- F16d: P0042 — visit not unpaid.
insert into public.visits (id, visit_number, patient_id, visit_date, payment_status, total_php, paid_php)
values ('e2000000-0000-4000-8000-000000000172', 'V-SMK167F16D', 'd1000000-0000-4000-8000-000000000172',
        (now() at time zone 'Asia/Manila')::date, 'paid', 100, 100);
insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php)
values ('76000000-0000-4000-8000-000000000172', 'e2000000-0000-4000-8000-000000000172',
        'c0000000-0000-4000-8000-000000000172', 'ready_for_release', 'a0000000-0000-4000-8000-000000000172', 100, 100);

do $smoke$
declare
  v_raised boolean;
  v_state  text;
begin
  -- F16a: P0043.
  v_raised := false;
  begin
    update public.test_requests set deleted_at = now(), delete_reason = 'smoke'
     where id = '72000000-0000-4000-8000-000000000172';
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0043' then
    raise exception 'F16a: released line should raise P0043 (raised=%, state=%)', v_raised, v_state;
  end if;
  raise notice 'F16a ok: released line delete refused (P0043)';

  -- F16b: P0044.
  v_raised := false;
  begin
    update public.test_requests set deleted_at = now(), delete_reason = 'smoke'
     where id = '74000000-0000-4000-8000-000000000172';
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0044' then
    raise exception 'F16b: direct package-component delete should raise P0044 (raised=%, state=%)', v_raised, v_state;
  end if;
  raise notice 'F16b ok: direct package-component delete refused (P0044)';

  -- F16c: P0050.
  v_raised := false;
  begin
    update public.test_requests set deleted_at = now(), delete_reason = 'smoke'
     where id = '75000000-0000-4000-8000-000000000172';
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0050' then
    raise exception 'F16c: open HMO claim should raise P0050 (raised=%, state=%)', v_raised, v_state;
  end if;
  raise notice 'F16c ok: open HMO claim delete refused (P0050)';

  -- F16d: P0042.
  v_raised := false;
  begin
    update public.test_requests set deleted_at = now(), delete_reason = 'smoke'
     where id = '76000000-0000-4000-8000-000000000172';
  exception when others then v_state := sqlstate; v_raised := true;
  end;
  if not v_raised or v_state <> 'P0042' then
    raise exception 'F16d: not-unpaid visit should raise P0042 (raised=%, state=%)', v_raised, v_state;
  end if;
  raise notice 'F16d ok: not-unpaid visit delete refused (P0042)';
end
$smoke$;

-- 14. CONTROL: strip the P0067 clause and the same member delete succeeds, so
-- the refusal above is P0067's doing (the visit is unpaid, T2 is not released
-- and not a component — nothing else in the guard objects).
do $smoke$
declare
  v_src text;
begin
  select pg_get_functiondef('public.enforce_deletable_test_request()'::regprocedure) into v_src;
  v_src := regexp_replace(v_src,
    'if exists \(\s*select 1\s*from public\.result_test_requests rtr.*?errcode = ''P0067'';\s*end if;',
    '', 's');
  if v_src like '%P0067%' then raise exception 'E14: control failed to strip the P0067 clause'; end if;
  execute v_src;
  update public.test_requests set deleted_at = now(), delete_reason = 'smoke control'
   where id = 'f1000000-0000-4000-8000-000000000172';
  if not found then raise exception 'E14: control delete matched no row'; end if;
  raise notice 'E14 ok: CONTROL — without P0067 the same delete succeeds';
end
$smoke$;

rollback;

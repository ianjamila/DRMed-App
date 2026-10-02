-- 0223_result_finalise_create_locks.sql
-- =============================================================================
-- result_finalise_commit and result_create_linked take the locks the global
-- order promises, and the status-flip trigger stops writing to lines it never
-- locked.
--
-- THE BUGS (reproduced as KNOWN by scripts/result-lifecycle-concurrency-proof.ts,
-- scenarios C4, F6a, F6d, F8b - now asserted):
--
--  result_finalise_commit (0184) validated its linked lines ("live" and
--  "in progress") from a snapshot and never locked them or their visit. The
--  status flip then ran later, inside the results UPDATE, in
--  advance_test_on_result_upload (0051), which walked result_test_requests in
--  HEAP order and UPDATEd each line with no status guard:
--   * F6a  finalise vs unclaim_panel_members: the unclaim commits while the
--          finalise is past its checks - the first line is flipped to
--          ready_for_release over the unclaim's 'requested', the second is
--          skipped. A finalised report over tests handed back to the queue.
--   * F8b  finalise vs delete_test_request_lines of a member, delete first: the
--          0172 guard (P0067) sees an unfinalised draft and lets the delete
--          through; the finalise had checked "live" from a snapshot and then
--          finalises a PDF over a deleted test - the very state P0067 exists
--          to prevent.
--   * F6d  finalise vs release_visit_results with a reverse-ordered junction:
--          release locks lines by id, the trigger took them in junction heap
--          order (higher id first) and met release in a cycle: 40P01.
--  result_create_linked (0184) took patient (shared) -> lines FOR UPDATE and
--  never the visit row, while a visit soft delete (the app's UPDATE) takes
--  patient (shared) -> visit row: neither waited on the other, so a draft
--  result could be linked to a line of a visit deleted meanwhile (C4).
--
-- THE FIX - the global lock order (membership -> patient (shared) -> visit row
-- -> lines ORDER BY id -> write; release 0198 and delete / restore 0216 already
-- keep it), applied to the two functions that did not:
--   result_finalise_commit: membership (shared) -> patient (shared) -> results
--     row FOR UPDATE -> the linked VISIT rows FOR SHARE, ORDER BY id -> the
--     linked test_requests ORDER BY id FOR NO KEY UPDATE (the mode the status
--     flip's UPDATE needs; it does not block the FK-child inserts a result link
--     or an HMO item make) -> ONLY THEN the live / in-progress checks, on a
--     fresh statement. The visit set is re-read under the locks (P0072, retry,
--     if a line moved to another visit). New refusal, existing code P0066: a
--     linked test or its visit was deleted ("a test on this result has been
--     deleted - reload the page"); the app never finalises a result with a
--     deleted member (finalise-consolidated re-derives live rows and the full
--     membership first), so this only ever fires on the race. FOR SHARE on the
--     visit is the mode release (0198) takes: it conflicts with a visit soft
--     delete (FOR NO KEY UPDATE) and with delete / restore (FOR UPDATE), is
--     compatible with release and with another finalise, and the status flip
--     never upgrades it (the 0183 waived guard, which can take the visit FOR
--     UPDATE, returns early on a bare status change without taking that lock) -
--     so two finalises or a finalise
--     and a release on one visit cannot upgrade-deadlock.
--   result_create_linked: membership (exclusive, the new id) -> patient
--     (shared) -> the lines' VISIT rows FOR SHARE, ORDER BY id -> lines FOR
--     UPDATE ORDER BY id -> the live recount (a deleted visit or line is P0066
--     "a test was not found or has been deleted - reload the page", as before)
--     -> a visit-set re-check (P0072) -> the patient re-check -> insert.
--   advance_test_on_result_upload (the results UPDATE trigger): walks the
--     junction ORDER BY test_request_id and flips a line only WHERE status =
--     'in_progress', so a line handed back / moved on while its UPDATE waited is
--     left alone. With result_finalise_commit now holding every line before the
--     trigger runs this is defence in depth for the finalise path; it is the
--     only protection for any other writer that sets finalised_at (proof: F6g).
--
-- Left alone: advance_test_on_rtr_insert (the link-insert trigger) - every
-- caller (result_create_linked) already holds the line FOR UPDATE, so no
-- concurrent writer can change the line between its read and its UPDATE;
-- result_save_draft and result_edit_commit take no line locks and flip no line.
--
-- Every function body below is the live one (0184 for the two RPCs, 0051 for the
-- trigger) VERBATIM plus the hunks marked "-- 0223". Signatures, SECURITY
-- DEFINER, search_path and ACLs are unchanged: the two RPCs restate 0184's
-- revoke / grant (service_role only); the trigger function keeps the grants and
-- the (empty) function config it already has - create or replace does not touch
-- the ACL. No new error code. DEPLOY: additive and behaviour-preserving except
-- for the new refusals on the race; push before the PR merges (the app is
-- unchanged).
-- Proof: npm run result-lifecycle:concurrency-proof -- --control (C4, F6a, F6d,
-- F8b, F6g, F11 and control mutants MC7, MF5-MF8, MT1).
-- =============================================================================

-- ----- 1. result_finalise_commit (0184's body + the 0223 locks) ----------------
create or replace function public.result_finalise_commit(
  p_result_id       uuid,
  p_finaliser       uuid,
  p_values          jsonb,        -- the COMPLETE value set the PDF was rendered from
  p_storage_path    text,
  p_file_size_bytes int,
  p_finalised_at    timestamptz,  -- the instant printed on the PDF
  p_new_image       jsonb,        -- null = no image (non-imaging layouts)
  p_alerts          jsonb         -- crossings of p_values; '[]' = none
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result     public.results%rowtype;
  v_live       int;
  v_bad        int;
  v_patient_id uuid;
  v_drm_id     text;
  v_added      jsonb := '[]'::jsonb;
  v_patients   uuid[];  -- 0184
  v_lines      uuid[];  -- 0223
  v_visits     uuid[];  -- 0223
begin
  -- 0184: the result-membership lock (shared), then the patient lifecycle
  -- lock, before the result row lock.
  perform public.lifecycle_lock_results(array[p_result_id], false);
  v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null));
  perform public.lifecycle_lock_and_assert(v_patients, false);

  select * into v_result
    from public.results
   where id = p_result_id
   for update;
  if not found then
    raise exception 'result not found' using errcode = 'P0066';
  end if;
  -- 0184: the result's patients must still be the ones we locked.
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null))
       is distinct from v_patients then
    raise exception 'the patient on this result changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;
  if v_result.generation_kind <> 'structured' then
    raise exception 'this result was uploaded as a PDF' using errcode = 'P0066';
  end if;
  if v_result.finalised_at is not null then
    raise exception 'this result is already finalised — use Edit results to change it'
      using errcode = 'P0066';
  end if;

  -- 0223: lock what the checks below read, in the global order (membership ->
  -- patient -> results row -> VISIT rows -> test_requests lines by id), BEFORE
  -- reading them. The membership lock is held, so the linked set cannot change
  -- under us. Without these locks the checks ran on a snapshot while an unclaim,
  -- a delete of a member, or a release could still commit, and the status-flip
  -- trigger then wrote to lines the checks had never seen change.
  v_lines  := array(select rtr.test_request_id from public.result_test_requests rtr where rtr.result_id = p_result_id);
  v_visits := array(select distinct tr.visit_id from public.test_requests tr where tr.id = any(v_lines) order by 1);
  perform 1 from public.visits v where v.id = any(v_visits) order by v.id for share; -- 0223
  perform 1 from public.test_requests tr where tr.id = any(v_lines) order by tr.id for no key update; -- 0223
  if array(select distinct tr.visit_id from public.test_requests tr where tr.id = any(v_lines) order by 1)
       is distinct from v_visits then -- 0223
    raise exception 'a test on this result moved to another visit while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  select count(*),
         count(*) filter (where tr.status not in ('in_progress', 'result_uploaded'))
    into v_live, v_bad
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
   where rtr.result_id = p_result_id
     and tr.deleted_at is null
     and v.deleted_at is null;
  if v_live = 0 then
    raise exception 'no live test is linked to this result' using errcode = 'P0066';
  end if;
  if v_live < cardinality(v_lines) then -- 0223: a member (or its visit) was deleted; the PDF would report a test the bill no longer has
    raise exception 'a test on this result has been deleted — reload the page' using errcode = 'P0066';
  end if;
  if v_bad > 0 then
    raise exception 'a test on this result is not in progress' using errcode = 'P0066';
  end if;

  select v.patient_id, p.drm_id
    into v_patient_id, v_drm_id
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
    join public.patients p on p.id = v.patient_id
   where rtr.result_id = p_result_id
   limit 1;

  delete from public.result_values where result_id = p_result_id;
  insert into public.result_values (
    result_id, parameter_id, numeric_value_si, numeric_value_conv,
    text_value, select_value, flag, is_blank
  )
  select p_result_id, x.parameter_id, x.numeric_value_si, x.numeric_value_conv,
         x.text_value, x.select_value, x.flag, coalesce(x.is_blank, false)
    from jsonb_to_recordset(coalesce(p_values, '[]'::jsonb)) as x(
      parameter_id uuid, numeric_value_si numeric, numeric_value_conv numeric,
      text_value text, select_value text, flag text, is_blank boolean
    );

  update public.results
     set storage_path       = p_storage_path,
         file_size_bytes    = p_file_size_bytes,
         finalised_at       = p_finalised_at,
         uploaded_by        = p_finaliser,
         uploaded_at        = now(),
         image_storage_path = case when p_new_image is null then image_storage_path
                                   else p_new_image->>'storage_path' end,
         image_filename     = case when p_new_image is null then image_filename
                                   else p_new_image->>'filename' end,
         image_mime_type    = case when p_new_image is null then image_mime_type
                                   else p_new_image->>'mime_type' end,
         image_size_bytes   = case when p_new_image is null then image_size_bytes
                                   else (p_new_image->>'size_bytes')::int end,
         image_uploaded_at  = case when p_new_image is null then image_uploaded_at
                                   else now() end,
         image_uploaded_by  = case when p_new_image is null then image_uploaded_by
                                   else p_finaliser end
   where id = p_result_id;

  -- A result is finalised once, so there should be no alerts yet. Any left by
  -- a pre-0172 attempt are cleared unless acknowledged (never touched).
  delete from public.critical_alerts
   where result_id = p_result_id
     and acknowledged_at is null;

  with ins as (
    insert into public.critical_alerts (
      result_id, test_request_id, parameter_id, parameter_name, direction,
      observed_value_si, threshold_si, patient_id, patient_drm_id
    )
    select p_result_id, d.test_request_id, d.parameter_id, d.parameter_name,
           d.direction, d.observed_value_si, d.threshold_si, v_patient_id, v_drm_id
      from jsonb_to_recordset(coalesce(p_alerts, '[]'::jsonb)) as d(
        test_request_id uuid, parameter_id uuid, parameter_name text,
        direction text, observed_value_si numeric, threshold_si numeric
      )
     where not exists (
       select 1 from public.critical_alerts ca
        where ca.result_id = p_result_id
          and ca.parameter_id = d.parameter_id
          and ca.direction = d.direction
          and ca.observed_value_si is not distinct from d.observed_value_si
     )
    returning parameter_name, direction, observed_value_si, threshold_si
  )
  select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) into v_added from ins;

  return jsonb_build_object('alerts_added', v_added);
end;
$$;

-- ----- 2. result_create_linked (0184's body + the 0223 visit lock) -----------------
create or replace function public.result_create_linked(
  p_actor            uuid,
  p_test_request_ids uuid[],
  p_generation_kind  text,
  p_report_group_id  uuid default null,
  p_storage_path     text default null,
  p_file_size_bytes  int  default null,
  p_notes            text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ids      uuid[] := public.lifecycle_norm(array_remove(p_test_request_ids, null));
  v_patients uuid[];
  v_live     int;
  v_result   uuid;
  v_visits   uuid[];  -- 0223
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role in ('medtech', 'pathologist', 'xray_technician', 'admin')
       and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only active lab staff can record a result' using errcode = '42501';
  end if;
  if p_generation_kind is null or p_generation_kind not in ('structured', 'uploaded') then
    raise exception 'unknown result kind %', p_generation_kind using errcode = '22023';
  end if;
  if p_generation_kind = 'uploaded' and (p_storage_path is null or p_file_size_bytes is null) then
    raise exception 'an uploaded result needs its stored PDF' using errcode = '22023';
  end if;
  if p_generation_kind = 'structured' and p_storage_path is not null then
    raise exception 'a structured draft has no PDF until it is finalised' using errcode = '22023';
  end if;
  if p_report_group_id is not null and p_generation_kind <> 'structured' then
    raise exception 'only a structured result can be a consolidated report' using errcode = '22023';
  end if;
  if cardinality(v_ids) = 0 or cardinality(v_ids) <> cardinality(p_test_request_ids) then
    raise exception 'list each test once' using errcode = '22023';
  end if;

  -- The new result's id is minted here so its MEMBERSHIP lock (exclusive —
  -- this call creates the membership) is taken first, as everywhere else:
  -- membership lock → patient locks → row locks.
  v_result := gen_random_uuid();
  perform public.lifecycle_lock_results(array[v_result], true);
  v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_test_requests(v_ids), null));
  -- 0184 deviation from plan text: lock_and_assert BEFORE the one-patient
  -- check (not after, as the plan's Step 2 SQL had it) — matching the
  -- guard trigger's own order ((c) lock_and_assert, then (d) one-patient-
  -- per-result, lines ~858-880 above). An inactive/merged/vanished patient
  -- mixed into the set must win with P0058 over the generic 23514, which is
  -- also what the plan's own smoke s10.7 asserts (an active + a deleted
  -- patient's test together → P0058, not 23514).
  perform public.lifecycle_lock_and_assert(v_patients, false);
  if cardinality(v_patients) > 1 then
    raise exception 'a result can only hold one patient''s tests — create a separate result for each patient'
      using errcode = '23514';
  end if;

  -- 0223: the visit rows of the requested lines (shared, id order) BEFORE the lines, as release
  -- (0198) and delete / restore (0216) take them. A visit soft delete (patient shared -> visit
  -- row) used to run alongside this call - neither waited - so a draft result could be linked to
  -- a line of a visit deleted meanwhile. Re-read under the locks just below.
  v_visits := array(select distinct tr.visit_id from public.test_requests tr where tr.id = any(v_ids) order by 1); -- 0223
  perform 1 from public.visits v where v.id = any(v_visits) order by v.id for share; -- 0223
  perform 1 from public.test_requests tr where tr.id = any(v_ids) order by tr.id for update;
  select count(*) into v_live
    from public.test_requests tr
    join public.visits v on v.id = tr.visit_id
   where tr.id = any(v_ids) and tr.deleted_at is null and v.deleted_at is null;
  if v_live <> cardinality(v_ids) then
    raise exception 'a test was not found or has been deleted — reload the page' using errcode = 'P0066';
  end if;
  if array(select distinct tr.visit_id from public.test_requests tr where tr.id = any(v_ids) order by 1)
       is distinct from v_visits then -- 0223: a line moved to a visit this call never locked
    raise exception 'the visit of a test changed while the result was being saved — try again'
      using errcode = 'P0072';
  end if;
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_test_requests(v_ids), null))
       is distinct from v_patients then
    raise exception 'the patient on this test changed while the result was being saved — try again'
      using errcode = 'P0072';
  end if;
  if exists (select 1 from public.result_test_requests rtr where rtr.test_request_id = any(v_ids)) then
    raise exception 'this test already has a result — reload the page' using errcode = 'P0066';
  end if;

  insert into public.results (id, generation_kind, storage_path, file_size_bytes, uploaded_by, notes,
                              report_group_id, finalised_by_staff_id, finalised_at)
  values (v_result, p_generation_kind, p_storage_path, p_file_size_bytes, p_actor, nullif(btrim(coalesce(p_notes, '')), ''),
          p_report_group_id, case when p_report_group_id is not null then p_actor end, null);

  insert into public.result_test_requests (result_id, test_request_id)
  select v_result, x from unnest(v_ids) x;

  return v_result;
end;
$$;

-- ----- 3. advance_test_on_result_upload (0051's body + id order and a status guard) --
create or replace function public.advance_test_on_result_upload()
returns trigger
language plpgsql
as $$
declare
  v_should_advance boolean;
  v_rtr            record;
  v_request        public.test_requests%rowtype;
  v_requires_signoff boolean;
begin
  if (tg_op = 'INSERT') then
    -- Uploaded PDFs are complete the moment they're inserted.
    -- Structured rows might be finalised at insert time (rare but allowed).
    v_should_advance := (new.generation_kind = 'uploaded')
                     or (new.generation_kind = 'structured' and new.finalised_at is not null);
  else
    -- UPDATE: only advance when a previously-draft structured result becomes
    -- finalised. Avoids re-firing on subsequent edits and on uploaded-row
    -- updates (e.g. notes changes).
    v_should_advance := new.generation_kind = 'structured'
                     and new.finalised_at is not null
                     and old.finalised_at is null;
  end if;

  if not v_should_advance then
    return new;
  end if;

  -- Walk the junction: flip every linked test_request that is still in_progress.
  for v_rtr in
    select test_request_id
    from public.result_test_requests
    where result_id = new.id
    order by test_request_id -- 0223: id order, as every other writer of these lines
  loop
    select * into v_request
    from public.test_requests
    where id = v_rtr.test_request_id;

    if v_request.status <> 'in_progress' then
      continue;
    end if;

    select coalesce(s.requires_signoff, false) into v_requires_signoff
    from public.services s where s.id = v_request.service_id;

    update public.test_requests
    set status = case when v_requires_signoff
                      then 'result_uploaded'
                      else 'ready_for_release' end,
        completed_at = now(),
        updated_at = now()
    where id = v_rtr.test_request_id
      and status = 'in_progress'; -- 0223: a line handed back / moved on while this UPDATE waited for its lock is left alone
  end loop;

  return new;
end;
$$;

revoke all on function public.result_finalise_commit(
  uuid, uuid, jsonb, text, int, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.result_finalise_commit(
  uuid, uuid, jsonb, text, int, timestamptz, jsonb, jsonb
) to service_role;

revoke all on function public.result_create_linked(uuid, uuid[], text, uuid, text, int, text) from public, anon, authenticated;
grant execute on function public.result_create_linked(uuid, uuid[], text, uuid, text, int, text) to service_role;

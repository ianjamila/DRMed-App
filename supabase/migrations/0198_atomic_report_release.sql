-- 0198_atomic_report_release.sql
-- =============================================================================
-- Release and undo-release of lab results in ONE locked transaction (P0081).
--
-- Since #261 the lab releases from the Queue, the visit page and
-- finalise-consolidated through one TypeScript pipeline: read the report
-- membership, plan the whole-report rule (a combined report — one `results`
-- row shared by several tests — goes out WHOLE or not at all, because the
-- portal serves its PDF only once every linked test is released), then
-- UPDATE the planned rows. Plan and write were separate round trips, so the
-- rule could break under a race and was only DETECTED afterwards
-- (REPORT_CHANGED_REASON): the report stayed half-released.
--
-- The concrete break: a combined report {A released, B ready} (legacy, or
-- mid-flight). A release (UPDATE … WHERE status = 'ready_for_release') and an
-- undo (UPDATE … WHERE status = 'released') touch DIFFERENT rows — B and A —
-- so neither ever waits for the other, both commit, and the report ends
-- {A ready, B released}: split, with nobody told. Each UPDATE only re-checks
-- the rows it actually locks, so no WHERE clause can close this; the rows a
-- statement skips are the problem.
--
-- release_visit_results() and undo_visit_release() fix it by planning UNDER
-- LOCK: both take the same locks in the same order, re-read every member of
-- every report they touch after the locks are granted, decide, and write in
-- one statement. The loser of a race waits, then plans on what the winner
-- committed. Each report ends wholly released or wholly not; nothing else
-- changes when a report is refused.
--
-- LOCK ORDER (0184's protocol: advisory locks first, sorted by key → row
-- locks → fresh re-read), used by BOTH functions:
--   1. result-membership lock, SHARED, on every report the selection touches
--      (lifecycle_lock_results) — a link insert/delete takes it EXCLUSIVE,
--      so the membership read in step 5 cannot change underneath; the
--      selection's reports are re-read after the lock and a change aborts
--      with 40001 (retried once by the app, withLifecycleRetry);
--   2. patient lifecycle lock, SHARED, on the visit's patient
--      (lifecycle_lock_and_assert — P0058 when deleted/merged);
--   3. the visit row FOR SHARE. A payment void/insert/correction and a
--      waive lock the visit FOR UPDATE (recalc_visit_payment,
--      guard_payment_on_waived_visit 0183, waive_visit_balance 0183), and a
--      visit delete updates it: each of those now either finishes before the
--      release plans (the release then sees the new payment status or the
--      deletion) or waits until the release commits. Neither function ever
--      updates the visit row itself, so two releases/undos sharing the lock
--      can never deadlock on an upgrade. waive_visit_balance's own order is
--      visit → test_requests by id: the same as step 4 here, which removes
--      0183's accepted waive-vs-undo cycle for undo_visit_release callers;
--   4. every test_requests row of this visit that the call may read or
--      write — the selection, every member of every touched report, and the
--      package header above each of them — FOR UPDATE, ORDER BY id. FOR
--      UPDATE (not NO KEY UPDATE) because it also blocks FOR KEY SHARE, the
--      lock a new result_test_requests link takes on its test: no selected
--      test can join a new report while this call holds it, and the report
--      set is re-read once more after these locks (40001 when it moved in
--      the gap between step 1 and here).
--      LockRows sits above the sort, so the lock order is the id order
--      whatever plan the planner picks (the concurrency proof checks both
--      the local seq-scan and prod's indexed plan). The header is locked so
--      two releases of sibling package components serialise: the second
--      one's fn_release_header_when_components_done then sees the first
--      one's component released and releases the header, where two parallel
--      ones would each have seen the other still pending and left the
--      header at ready_for_release;
--   5. re-read under the locks, plan, one UPDATE, return what it did.
-- One cycle remains and is left to Postgres: soft-deleting a line locks the
-- line, then its cascade updates the visit (fn_queue_delete_cascade), the
-- reverse of steps 3→4. Only an HMO visit can be both deletable (unpaid) and
-- releasable, so it needs a delete and a release of the same HMO visit at the
-- same instant; one side aborts with 40P01 ("try again"), nothing half done,
-- and the release side retries once by itself (withLifecycleRetry).
-- claim_panel_members / unclaim_panel_members (0191) only ever write rows
-- that are requested / in_progress, and a report with such a member is
-- refused here before any write — so they never write a row this function
-- is about to write, and cannot deadlock with it on rows it only reads.
--
-- Triggers still decide as before: the payment gate (0133) and the consent
-- gate raise check_violation (the whole call rolls back — every report or
-- none), the GL bridge posts one journal entry per released line (0030's
-- unique index still guards duplicates), the undo bridge reverses it.
--
-- WHO. SECURITY DEFINER, because the 0184 lock primitives are revoked from
-- every runtime role and the membership read must never be RLS-truncated
-- (a hidden member would make a half-released report look whole). The
-- functions therefore authorise the caller themselves (release_actor):
-- a signed-in staff member (JWT, `authenticated`) always acts as themselves;
-- the service-role client (finalise-consolidated) must name the staff member
-- it acts for. The role is the EFFECTIVE role (0182 View-as), sections come
-- from lab_sections_for_role (0190's SQL mirror of sectionsForRole), so a
-- forged call can release nothing outside the caller's sections.
--
-- The app keeps what the database cannot do: the friendly pre-checks, the
-- per-row audit rows (the functions return what they changed, with the
-- prior release medium/time for undo read under the lock), notices and
-- staff alerts. Refusals that concern one report or row come back in the
-- result as codes the app words (REPORT_REFUSAL in report-release-scope.ts);
-- refusals of the whole call raise P0081 with a message that passes through.
-- =============================================================================

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- release_actor: who is acting, with which EFFECTIVE role. Private helper.
-- ---------------------------------------------------------------------------
create or replace function public.release_actor(p_actor uuid)
returns table (actor_id uuid, actor_role text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_id     uuid;
begin
  if v_uid is not null then
    -- A signed-in staff member acts as themselves, never as someone else.
    if p_actor is not null and p_actor <> v_uid then
      raise exception 'You can only release or undo results as yourself.' using errcode = '42501';
    end if;
    v_id := v_uid;
  elsif v_claims is not null and (v_claims::jsonb ->> 'role') = 'service_role' and p_actor is not null then
    -- The service-role client (finalise-consolidated) names its staff member.
    v_id := p_actor;
  else
    raise exception 'Sign in to release or undo results.' using errcode = '42501';
  end if;

  -- Mirrors staff_role() (0182): an admin mid-View-as acts as the viewed role.
  return query
    select sp.id,
           case when sp.role = 'admin' and sp.view_as_until > now() then sp.view_as_role
                else sp.role end
      from public.staff_profiles sp
     where sp.id = v_id
       and sp.is_active = true;
  if not found then
    raise exception 'Only active staff can release or undo results.' using errcode = '42501';
  end if;
end;
$$;

comment on function public.release_actor(uuid) is
  'Private helper of release_visit_results / undo_visit_release (0198): the acting staff member (auth.uid(), or p_actor for a service-role caller) and their EFFECTIVE role (0182 View-as). Raises 42501 otherwise.';

revoke all on function public.release_actor(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- release_report_locks: steps 1–4 of the header's lock order, shared by both
-- functions. Returns the (sorted, distinct) report ids the selection touches.
-- Private helper.
-- ---------------------------------------------------------------------------
create or replace function public.release_report_locks(
  p_visit_id uuid,
  p_ids      uuid[],
  p_deleted_message text
)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_reports  uuid[];
  v_patient  uuid;
  v_visit    record;
  v_lock_ids uuid[];
begin
  -- 1. Result-membership lock (shared), then re-read: a selected test linked
  --    to or unlinked from a report meanwhile means the plan would be stale.
  v_reports := array(
    select distinct rtr.result_id
      from public.result_test_requests rtr
     where rtr.test_request_id = any (p_ids)
     order by 1);
  perform public.lifecycle_lock_results(v_reports, false);
  if array(
       select distinct rtr.result_id
         from public.result_test_requests rtr
        where rtr.test_request_id = any (p_ids)
        order by 1) is distinct from v_reports then
    raise exception 'The tests on this report changed just now — try again.' using errcode = '40001';
  end if;

  -- 2. Patient lifecycle lock (shared); P0058 when deleted or merged.
  select v.patient_id into v_patient from public.visits v where v.id = p_visit_id;
  if not found then
    raise exception 'Visit not found.' using errcode = 'P0081';
  end if;
  perform public.lifecycle_lock_and_assert(array[v_patient], false);

  -- 3. The visit row (shared), re-read under the lock.
  select v.patient_id, v.deleted_at into v_visit
    from public.visits v
   where v.id = p_visit_id
   for share;
  if v_visit.patient_id is distinct from v_patient then
    raise exception 'the patient on this visit changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;
  if v_visit.deleted_at is not null then
    raise exception '%', p_deleted_message using errcode = 'P0081';
  end if;

  -- 4. Every row of this visit the call may read or write, in id order: the
  --    selection, every member of every touched report, their package headers.
  v_lock_ids := array(
    select x from unnest(p_ids) x
    union
    select rtr.test_request_id
      from public.result_test_requests rtr
     where rtr.result_id = any (v_reports));
  v_lock_ids := v_lock_ids || array(
    select distinct tr.parent_id
      from public.test_requests tr
     where tr.id = any (v_lock_ids)
       and tr.visit_id = p_visit_id
       and tr.parent_id is not null);
  perform 1
     from public.test_requests tr
    where tr.id = any (v_lock_ids)
      and tr.visit_id = p_visit_id
    order by tr.id
      for update;

  -- The report set once more, now that no selected test can be linked anew.
  if array(
       select distinct rtr.result_id
         from public.result_test_requests rtr
        where rtr.test_request_id = any (p_ids)
        order by 1) is distinct from v_reports then
    raise exception 'The tests on this report changed just now — try again.' using errcode = '40001';
  end if;

  return v_reports;
end;
$$;

comment on function public.release_report_locks(uuid, uuid[], text) is
  'Private helper of release_visit_results / undo_visit_release (0198): takes the membership (shared) → patient (shared) → visit (FOR SHARE) → test_requests (FOR UPDATE, id order) locks and returns the report ids the selection touches. 40001 when the selection''s reports changed before the lock; P0081 when the visit is missing or deleted.';

revoke all on function public.release_report_locks(uuid, uuid[], text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- release_visit_results
-- ---------------------------------------------------------------------------
create or replace function public.release_visit_results(
  p_visit_id         uuid,
  p_test_request_ids uuid[],
  p_medium           text,
  p_actor            uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor     uuid;
  v_role      text;
  v_sections  text[];
  v_ids       uuid[];
  v_reports   uuid[];
  v_combined  uuid[] := '{}';  -- every member of every touched combined report
  v_ok        uuid[] := '{}';  -- combined reports released whole by this call
  v_release   uuid[] := '{}';
  v_refused   jsonb  := '[]'::jsonb;
  v_released  jsonb  := '[]'::jsonb;
  v_count     int    := 0;
  v_reason    text;
  r           record;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from public.release_actor(p_actor) a;
  v_sections := public.lab_sections_for_role(v_role);  -- null = every section, {} = none

  if p_medium is null or p_medium not in ('physical', 'email', 'viber', 'gcash', 'pickup', 'other') then
    raise exception 'Choose how the result was released.' using errcode = 'P0081';
  end if;
  v_ids := array(
    select distinct x from unnest(coalesce(p_test_request_ids, '{}'::uuid[])) x
     where x is not null order by x);
  if cardinality(v_ids) = 0 then
    raise exception 'Nothing was selected to release.' using errcode = 'P0081';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'Too many tests selected — select fewer.' using errcode = 'P0081';
  end if;

  v_reports := public.release_report_locks(
    p_visit_id, v_ids, 'This visit was deleted from the queue. Restore it before releasing results.');

  -- 5a. Combined reports (more than one linked test) the selection touches:
  --     whole or not at all. Every member counts, deleted ones included (the
  --     portal checks every link). Same rules and order as planReportRelease.
  for r in
    select rtr.result_id,
           array_agg(tr.id) as member_ids,
           bool_or(v_sections is not null
                   and (s.section is null or not (s.section = any (v_sections)))) as outside,
           bool_or(tr.is_package_header) as has_header,
           bool_or(tr.visit_id <> p_visit_id) as other_visit,
           bool_or(coalesce(s.kind in ('doctor_consultation', 'doctor_procedure'), false)) as has_doctor,
           bool_or(tr.deleted_at is not null and tr.status <> 'released') as deleted_unreleased,
           count(*) filter (where tr.deleted_at is null
                              and tr.status not in ('ready_for_release', 'released')) as n_unfinished,
           array_agg(tr.id) filter (where tr.deleted_at is null
                                      and tr.status = 'ready_for_release') as ready_ids,
           array_agg(tr.id) filter (where tr.id = any (v_ids)) as selected_ids
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      left join public.services s on s.id = tr.service_id
     where rtr.result_id = any (v_reports)
     group by rtr.result_id
    having count(*) > 1
     order by rtr.result_id
  loop
    v_combined := v_combined || r.member_ids;
    v_reason := case
      when r.outside            then 'report_outside_sections'
      when r.has_header         then 'report_package_header'
      when r.other_visit        then 'report_other_visit'
      when r.has_doctor         then 'report_doctor_member'
      when r.deleted_unreleased then 'report_deleted_member'
      when r.n_unfinished > 0   then 'report_not_finished'
    end;
    if v_reason is not null then
      v_refused := v_refused || coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', x, 'code', v_reason, 'report_id', r.result_id, 'count', r.n_unfinished) order by x)
          from unnest(r.selected_ids) x), '[]'::jsonb);
    else
      v_ok := v_ok || r.result_id;
      v_release := v_release || coalesce(r.ready_ids, '{}'::uuid[]);
    end if;
  end loop;

  -- 5b. Plain selected tests (not on a combined report).
  for r in
    select x as id, tr.id as tr_id, tr.visit_id, tr.status, tr.deleted_at,
           tr.is_package_header, s.section,
           coalesce(s.kind in ('doctor_consultation', 'doctor_procedure'), false) as is_doctor
      from unnest(v_ids) x
      left join public.test_requests tr on tr.id = x
      left join public.services s on s.id = tr.service_id
     where not (x = any (v_combined))
     order by x
  loop
    if r.tr_id is null or r.visit_id <> p_visit_id or r.deleted_at is not null
       or r.is_package_header or r.is_doctor or r.status <> 'ready_for_release' then
      null;  -- reported as not_ready below
    elsif v_sections is not null and (r.section is null or not (r.section = any (v_sections))) then
      v_refused := v_refused || jsonb_build_array(jsonb_build_object(
        'id', r.id, 'code', 'outside_sections', 'report_id', null, 'count', 0));
    else
      v_release := v_release || r.id;
    end if;
  end loop;

  v_release := array(select distinct x from unnest(v_release) x order by x);
  if cardinality(v_release) > 500 then
    raise exception 'Too many tests once whole reports are included — select fewer.' using errcode = 'P0081';
  end if;

  -- 6. The one write. Every planned row is locked and was re-read above, so
  --    a short count cannot come from another session; refuse rather than
  --    leave a report part-released if it ever does.
  if cardinality(v_release) > 0 then
    with upd as (
      update public.test_requests t
         set status         = 'released',
             released_at    = now(),
             released_by    = v_actor,
             release_medium = p_medium
       where t.id = any (v_release)
         and t.visit_id = p_visit_id
         and t.status = 'ready_for_release'
         and t.deleted_at is null
      returning t.id, t.service_id, t.released_at
    )
    select count(*),
           coalesce(jsonb_agg(jsonb_build_object(
             'id', upd.id,
             'name', coalesce(s.name, 'Result'),
             'report_id', rtr.result_id,
             'selected', upd.id = any (v_ids),
             'released_at', upd.released_at) order by upd.id), '[]'::jsonb)
      into v_count, v_released
      from upd
      left join public.services s on s.id = upd.service_id
      left join public.result_test_requests rtr
        on rtr.test_request_id = upd.id and rtr.result_id = any (v_ok);
    if v_count <> cardinality(v_release) then
      raise exception 'These tests changed while releasing — nothing was released. Try again.'
        using errcode = '40001';
    end if;
  end if;

  -- 7. Every selected test not released and not refused above: no longer
  --    (or never) a ready line of this visit — already released, deleted,
  --    moved on, a header or a consultation.
  v_refused := v_refused || coalesce((
    select jsonb_agg(jsonb_build_object('id', x, 'code', 'not_ready', 'report_id', null, 'count', 0) order by x)
      from unnest(v_ids) x
     where not (x = any (v_release))
       and not exists (select 1 from jsonb_array_elements(v_refused) e where (e ->> 'id')::uuid = x)), '[]'::jsonb);

  return jsonb_build_object('released', v_released, 'refused', v_refused);
end;
$$;

comment on function public.release_visit_results(uuid, uuid[], text, uuid) is
  'Releases the selected ready tests of one visit (0198), each combined report WHOLE or not at all, planned and written under the membership → patient → visit → test_requests locks. Returns {released: [{id, name, report_id, selected, released_at}], refused: [{id, code, report_id, count}]}; every selected id lands in exactly one of them. Codes: not_ready, outside_sections, report_outside_sections, report_package_header, report_other_visit, report_doctor_member, report_deleted_member, report_not_finished (count = unfinished members). Raises P0081 (whole call refused, message passes through), 40001/P0072 (retry), P0058 (patient inactive), 42501, and the payment/consent gates'' check_violation.';

revoke all on function public.release_visit_results(uuid, uuid[], text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_visit_results(uuid, uuid[], text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- undo_visit_release
-- ---------------------------------------------------------------------------
-- (A 3-argument draft of this function existed only on local stacks.)
drop function if exists public.undo_visit_release(uuid, uuid[], uuid);

create or replace function public.undo_visit_release(
  p_visit_id             uuid,
  p_test_request_ids     uuid[],
  p_actor                uuid default null,
  -- The 10-minute batch Undo (undoReleaseBatchAction): {test_request_id:
  -- released_at} of the EXACT release that batch made. When given, a line is
  -- undone only while it still carries that release, and a combined report
  -- only when EVERY member does — otherwise it is skipped (changed_since),
  -- never undone in part and never raised. Null for every other caller.
  p_expected_released_at jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor    uuid;
  v_role     text;
  v_sections text[];
  v_ids      uuid[];
  v_reports  uuid[];
  v_expanded uuid[];
  v_ok       uuid[] := '{}';
  v_cands    uuid[];
  v_undone   jsonb;
  v_count    int;
  v_batch    boolean := p_expected_released_at is not null
                         and jsonb_typeof(p_expected_released_at) <> 'null';
  v_refused  uuid[]  := '{}';  -- members of reports a batch Undo must leave alone
  v_skipped  jsonb;
  r          record;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from public.release_actor(p_actor) a;
  v_sections := public.lab_sections_for_role(v_role);

  if v_batch then
    begin
      if jsonb_typeof(p_expected_released_at) <> 'object' then
        raise exception using errcode = '22023';
      end if;
      perform (e.key)::uuid, (e.value)::timestamptz from jsonb_each_text(p_expected_released_at) e;
    exception when others then
      raise exception 'Couldn''t read which release to undo — try again.' using errcode = 'P0081';
    end;
  end if;

  v_ids := array(
    select distinct x from unnest(coalesce(p_test_request_ids, '{}'::uuid[])) x
     where x is not null order by x);
  if cardinality(v_ids) = 0 then
    raise exception 'No tests selected.' using errcode = 'P0081';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'Too many tests selected — select fewer.' using errcode = 'P0081';
  end if;

  v_reports := public.release_report_locks(
    p_visit_id, v_ids, 'This visit was deleted from the queue. Restore it before undoing a release.');

  -- Whole-report expansion (0172, expandUndoReleaseScope): every member of a
  -- touched combined report is undone with it, whatever its own status; the
  -- WHOLE request is refused when any member (deleted ones included) is
  -- outside the caller's sections, a package header, or on another visit.
  v_expanded := v_ids;
  for r in
    select rtr.result_id,
           array_agg(tr.id) as member_ids,
           bool_or(v_sections is not null
                   and (s.section is null or not (s.section = any (v_sections)))) as outside,
           bool_or(tr.is_package_header) as has_header,
           bool_or(tr.visit_id <> p_visit_id) as other_visit
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      left join public.services s on s.id = tr.service_id
     where rtr.result_id = any (v_reports)
     group by rtr.result_id
    having count(*) > 1
     order by rtr.result_id
  loop
    if r.outside then
      raise exception 'This report has tests outside the sections you can act on, so it can''t be undone from here — ask an admin.'
        using errcode = 'P0081';
    elsif r.has_header then
      raise exception 'This report includes a package header, which shouldn''t happen — ask an admin to check it.'
        using errcode = 'P0081';
    elsif r.other_visit then
      raise exception 'This report spans more than one visit, which shouldn''t happen — ask an admin to check it.'
        using errcode = 'P0081';
    end if;
    -- Batch Undo: the report comes back only if every member (deleted ones
    -- included) is still exactly the release this batch made.
    if v_batch and exists (
         select 1
           from unnest(r.member_ids) m
           join public.test_requests tr on tr.id = m
          where not (p_expected_released_at ? m::text
                     and tr.status = 'released'
                     and tr.deleted_at is null
                     and tr.released_at = (p_expected_released_at ->> m::text)::timestamptz)) then
      v_refused := v_refused || r.member_ids;
      continue;
    end if;
    v_ok := v_ok || r.result_id;
    v_expanded := v_expanded || r.member_ids;
  end loop;

  -- The released, live, non-header lines among them this role may act on.
  -- Headers only ever flip through the 0110 cascade (fn_undo_release_bridge),
  -- never directly: a header back at ready with its components released
  -- would re-release (with a fresh journal entry) on the next payment change.
  v_cands := array(
    select tr.id
      from public.test_requests tr
      left join public.services s on s.id = tr.service_id
     where tr.id = any (v_expanded)
       and tr.visit_id = p_visit_id
       and tr.status = 'released'
       and not tr.is_package_header
       and tr.deleted_at is null
       and (v_sections is null or s.section = any (v_sections))
       and not (tr.id = any (v_refused))
       and (not v_batch
            or (p_expected_released_at ? tr.id::text
                and tr.released_at = (p_expected_released_at ->> tr.id::text)::timestamptz))
     order by tr.id);
  if cardinality(v_cands) = 0 and not v_batch then
    raise exception 'None of the selected tests can be unreleased.' using errcode = 'P0081';
  end if;

  -- The prior release medium/time are read under the row lock, so the audit
  -- rows the app writes from them describe the release actually undone.
  with prior as (
    select tr.id, tr.release_medium, tr.released_at
      from public.test_requests tr
     where tr.id = any (v_cands)
  ),
  upd as (
    update public.test_requests t
       set status         = 'ready_for_release',
           released_at    = null,
           released_by    = null,
           release_medium = null
     where t.id = any (v_cands)
       and t.status = 'released'
    returning t.id
  )
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', upd.id,
           'prior_release_medium', prior.release_medium,
           'prior_released_at', prior.released_at,
           'report_id', rtr.result_id) order by upd.id), '[]'::jsonb)
    into v_count, v_undone
    from upd
    join prior on prior.id = upd.id
    left join public.result_test_requests rtr
      on rtr.test_request_id = upd.id and rtr.result_id = any (v_ok);
  if v_count <> cardinality(v_cands) then
    raise exception 'These tests changed while undoing — nothing was changed. Try again.'
      using errcode = '40001';
  end if;

  -- Selected lines not undone: no longer released (or, for a batch Undo, no
  -- longer this batch's release, or on a report that is not).
  v_skipped := coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x, 'code', case when v_batch then 'changed_since' else 'not_released' end) order by x)
      from unnest(v_ids) x
     where not (x = any (v_cands))), '[]'::jsonb);

  return jsonb_build_object('undone', v_undone, 'skipped', v_skipped);
end;
$$;

comment on function public.undo_visit_release(uuid, uuid[], uuid, jsonb) is
  'Undoes the release of the selected tests of one visit (0198), expanded to every member of each touched combined report (0172), under the same locks as release_visit_results. Returns {undone: [{id, prior_release_medium, prior_released_at, report_id}], skipped: [{id, code: not_released|changed_since}]}. p_expected_released_at (batch Undo) limits it to lines — and whole reports — still carrying that exact release, and then never raises for nothing-to-undo. Raises P0081 (whole request refused, message passes through), 40001/P0072 (retry), P0058 (patient inactive), 42501.';

revoke all on function public.undo_visit_release(uuid, uuid[], uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.undo_visit_release(uuid, uuid[], uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Post-checks
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.release_actor(uuid)',
    'public.release_report_locks(uuid,uuid[],text)',
    'public.release_visit_results(uuid,uuid[],text,uuid)',
    'public.undo_visit_release(uuid,uuid[],uuid,jsonb)'
  ] loop
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception '0198 post-check: % is not SECURITY DEFINER', f;
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '0198 post-check: anon can execute %', f;
    end if;
  end loop;
  foreach f in array array['public.release_actor(uuid)', 'public.release_report_locks(uuid,uuid[],text)'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE')
       or has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '0198 post-check: % must stay private', f;
    end if;
  end loop;
  foreach f in array array['public.release_visit_results(uuid,uuid[],text,uuid)', 'public.undo_visit_release(uuid,uuid[],uuid,jsonb)'] loop
    if not has_function_privilege('authenticated', f, 'EXECUTE')
       or not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '0198 post-check: % must be executable by authenticated and service_role', f;
    end if;
  end loop;
end;
$$;

reset lock_timeout;

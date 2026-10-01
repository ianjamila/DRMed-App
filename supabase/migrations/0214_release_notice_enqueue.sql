-- 0214_release_notice_enqueue.sql
-- =============================================================================
-- Release-notice outbox, PR 3 of 3: release_visit_results ENQUEUES the notice and
-- undo_visit_release CANCELS it.
-- Spec: docs/superpowers/specs/2026-10-01-release-notice-outbox-design.md
--
-- release_visit_results (0205 + this)
--   When release_notices_enabled() is true, inserts ONE release_notices row per
--   call — status pending, next_attempt_at = now(), released_at = the stamp the
--   lines got, the medium, the bulk_batch_id of the audit metadata, and the id of
--   EVERY line the call released (report-mates included) — in the same
--   transaction, after the line writes, and returns it as notice_id. With the
--   flag OFF (the seeded default) nothing is inserted and the result is
--   byte-identical to 0205's. See the comment at the insert for the
--   same-transaction merge and the never-block-a-release guard.
-- undo_visit_release (0205 + this)
--   Cancels this visit's pending / retry notices whose every test is no longer
--   released with the release that stamped it (status cancelled, resolved_at
--   set, lease cleared). Partly undone rows and 'sending' rows are untouched.
--   Runs whatever the flag says.
-- cancel_release_notice(p_id, p_reason)
--   Fenced cancel for the app: pending / retry -> cancelled, never sending or a
--   terminal row; returns whether it cancelled. The fast path uses it when the
--   flag was flipped OFF between the release (which enqueued) and the send, so
--   the notice is never both legacy-sent and swept later. service_role only.
--
-- Everything else in the two functions is 0205's, verbatim (the diff is the
-- three additions marked "0214"); signatures, SECURITY DEFINER, search_path, the
-- comments' contract and the ACLs are restated by name below.
--
-- Lock order. The notices table is touched only AFTER every line lock the two
-- functions take (release: after the line UPDATE; undo: after the line UPDATE),
-- so it adds no edge to the membership -> patient -> visit -> lines order.
-- Claimers (claim_release_notice, FOR UPDATE SKIP LOCKED) take only notices rows
-- and never wait, so they cannot sit in a wait cycle with release / undo; the
-- undo's UPDATE waits for a claimer at most while that claimer's short
-- transaction ends. Proof: scripts/report-release-concurrency-proof.ts (N0, N1, N2, N3a, N3b, N5, N6; control mutants M14-M18).
-- No P-codes: nothing new is raised.
-- =============================================================================

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- release_visit_results
-- ---------------------------------------------------------------------------
create or replace function public.release_visit_results(
  p_visit_id         uuid,
  p_test_request_ids uuid[],
  p_medium           text,
  p_actor            uuid  default null,
  -- {metadata: {...caller extras}, ip, user_agent} for the audit rows (0205).
  p_audit            jsonb default null
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
  v_extras    jsonb;
  v_ip        inet;
  v_ua        text;
  v_notice    uuid;        -- 0214: the release_notices row this call enqueued, if any
  r           record;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from public.release_actor(p_actor) a;
  v_sections := public.lab_sections_for_role(v_role);  -- null = every section, {} = none
  select c.extras, c.ip, c.user_agent into v_extras, v_ip, v_ua
    from public.release_audit_context(p_audit,
           array['source', 'bulk', 'selection', 'bulk_batch_id', 'package_header_id', 'result_id']) c;

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

  -- 6. The one write, and one `test_request.released` audit row per released
  --    row (0205) in the same transaction. Every planned row is locked and was
  --    re-read above, so a short count cannot come from another session;
  --    refuse rather than leave a report part-released if it ever does (the
  --    raise rolls the audit rows back with the write).
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
    ),
    aud as (
      insert into public.audit_log
        (actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent, created_at)
      select v_actor, 'staff', 'test_request.released', 'test_request', upd.id,
             jsonb_build_object('bulk', true, 'selection', true)
               || v_extras
               || jsonb_build_object(
                    'visit_id', p_visit_id,
                    'release_medium', p_medium,
                    -- The exact instant stamped (full precision, never through
                    -- a JS Date): the 10-minute Undo restores a row only while
                    -- it still carries this release.
                    'released_at', upd.released_at),
             v_ip, v_ua, clock_timestamp()
        from upd
      returning 1
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

    -- 0214: the durable "result ready" notice, enqueued in THIS transaction and
    -- only AFTER the line writes (so a rollback — the 40001 above, P0072 from a
    -- trigger, a lost connection — leaves no orphan notice). One row per call
    -- covering every line it released, report-mates included: the patient is told
    -- about what was released. released_at = now(), the very stamp the lines got.
    -- Gated by the strict flag; with it OFF nothing here runs and the result is
    -- byte-identical to 0205's. The unique (visit_id, released_at) cannot collide
    -- inside one call; two calls sharing one transaction (so one now()) merge into
    -- the first one's pending row instead of failing the release. The outbox must
    -- never block a clinical release: a failure here is logged and the release
    -- goes ahead WITHOUT a notice_id, so the app falls back to its legacy send.
    if public.release_notices_enabled() then
      begin
        insert into public.release_notices
          (visit_id, released_at, test_request_ids, release_medium, bulk_batch_id, status, next_attempt_at)
        values
          (p_visit_id, now(), v_release, p_medium, left(nullif(v_extras ->> 'bulk_batch_id', ''), 100), 'pending', now())
        on conflict (visit_id, released_at) do update
           set test_request_ids = array(
                 select distinct x
                   from unnest(release_notices.test_request_ids || excluded.test_request_ids) x
                  order by x)
         where release_notices.status = 'pending'
        returning id into v_notice;
      exception when others then
        v_notice := null;
        raise warning 'release_visit_results: could not enqueue the release notice (% %)', sqlstate, sqlerrm;
      end;
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

  return jsonb_build_object('released', v_released, 'refused', v_refused)
         || case when v_notice is null then '{}'::jsonb else jsonb_build_object('notice_id', v_notice) end;
end;
$$;

comment on function public.release_visit_results(uuid, uuid[], text, uuid, jsonb) is
  'Releases the selected ready tests of one visit (0198), each combined report WHOLE or not at all, planned and written under the membership → patient → visit → test_requests locks, with one test_request.released audit row per released row in the same transaction (0205; p_audit = {metadata, ip, user_agent}). With release_notices_enabled() (0214) it also enqueues ONE release_notices row for every line the call released, in the same transaction after the line writes. Returns {released: [{id, name, report_id, selected, released_at}], refused: [{id, code, report_id, count}]} plus notice_id (the enqueued row) only when one was enqueued; every selected id lands in exactly one of released / refused. Codes: not_ready, outside_sections, report_outside_sections, report_package_header, report_other_visit, report_doctor_member, report_deleted_member, report_not_finished (count = unfinished members). Raises P0081 (whole call refused, message passes through), 40001/P0072 (retry), P0058 (patient inactive), 42501, and the payment/consent gates'' check_violation.';

revoke all on function public.release_visit_results(uuid, uuid[], text, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.release_visit_results(uuid, uuid[], text, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- undo_visit_release
-- ---------------------------------------------------------------------------
create or replace function public.undo_visit_release(
  p_visit_id             uuid,
  p_test_request_ids     uuid[],
  p_actor                uuid  default null,
  -- The 10-minute batch Undo (undoReleaseBatchAction): {test_request_id:
  -- released_at} of the EXACT release that batch made. When given, a line is
  -- undone only while it still carries that release, and a combined report
  -- only when EVERY member does — otherwise it is skipped (changed_since),
  -- never undone in part and never raised. Every value must be a timestamp
  -- string (0205). Null for every other caller.
  p_expected_released_at jsonb default null,
  -- Why the release is undone — required, written on every audit row (0205).
  p_reason               text  default null,
  -- {metadata: {...caller extras}, ip, user_agent} for the audit rows (0205).
  p_audit                jsonb default null
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
  v_why      text    := btrim(p_reason);
  v_extras   jsonb;
  v_ip       inet;
  v_ua       text;
  r          record;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from public.release_actor(p_actor) a;
  v_sections := public.lab_sections_for_role(v_role);
  -- via / undo_of_batch mark the 10-minute batch Undo: accepted only with its map.
  select c.extras, c.ip, c.user_agent into v_extras, v_ip, v_ua
    from public.release_audit_context(p_audit,
           array['bulk', 'bulk_batch_id', 'sample_visit_delete']
           || case when v_batch then array['via', 'undo_of_batch'] else '{}'::text[] end) c;

  if v_why is null or v_why = '' then
    raise exception 'Give a reason for undoing the release.' using errcode = 'P0081';
  end if;
  if length(v_why) > 2000 then
    raise exception 'The reason is too long — keep it under 2,000 characters.' using errcode = 'P0081';
  end if;

  if v_batch then
    begin
      if jsonb_typeof(p_expected_released_at) <> 'object' then
        raise exception using errcode = '22023';
      end if;
      -- 0205: every value a timestamp STRING — a JSON null (or number, …)
      -- would make the report check below unknown rather than false.
      if exists (select 1 from jsonb_each(p_expected_released_at) e
                  where jsonb_typeof(e.value) <> 'string') then
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
    -- included) is still exactly the release this batch made. `is not true`
    -- (0205): an unknown answer — a released member with no released_at —
    -- counts as changed, so the report is skipped whole, never split.
    if v_batch and exists (
         select 1
           from unnest(r.member_ids) m
           join public.test_requests tr on tr.id = m
          where (p_expected_released_at ? m::text
                 and tr.status = 'released'
                 and tr.deleted_at is null
                 and tr.released_at = (p_expected_released_at ->> m::text)::timestamptz) is not true) then
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

  -- The prior release medium/time and the patient's view count are read under
  -- the row lock, so the audit rows (0205: written here, in this transaction)
  -- describe the release actually undone.
  with prior as (
    select tr.id, tr.release_medium, tr.released_at, coalesce(vc.viewed_count, 0) as viewed_count
      from public.test_requests tr
      left join public.result_view_counts(v_cands) vc on vc.test_request_id = tr.id
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
  ),
  done as (
    select upd.id, prior.release_medium, prior.released_at, prior.viewed_count, rtr.result_id as report_id
      from upd
      join prior on prior.id = upd.id
      left join public.result_test_requests rtr
        on rtr.test_request_id = upd.id and rtr.result_id = any (v_ok)
  ),
  aud as (
    insert into public.audit_log
      (actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent, created_at)
    select v_actor, 'staff', 'test_request.release_undone', 'test_request', done.id,
           v_extras
             || jsonb_build_object(
                  'visit_id', p_visit_id,
                  'reason', v_why,
                  'prior_release_medium', done.release_medium,
                  'prior_released_at', done.released_at,
                  -- RA 10173: undoing does not un-see a result the patient opened.
                  'viewed_count', done.viewed_count,
                  -- Set only when reverted as part of a whole-report undo (0172).
                  'report_result_id', done.report_id),
           v_ip, v_ua, clock_timestamp()
      from done
    returning 1
  )
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', done.id,
           'prior_release_medium', done.release_medium,
           'prior_released_at', done.released_at,
           'report_id', done.report_id) order by done.id), '[]'::jsonb)
    into v_count, v_undone
    from done;
  if v_count <> cardinality(v_cands) then
    raise exception 'These tests changed while undoing — nothing was changed. Try again.'
      using errcode = '40001';
  end if;

  -- 0214: cancel this visit's release notices that have nothing left to announce.
  -- A notice is spent when NONE of its tests is still released with the release
  -- that stamped it (undone in this call, or earlier). A partly undone notice is
  -- left alone: the sender's re-check trims it to what is still released. Only
  -- pending / retry rows: a 'sending' row has a live lease and belongs to its
  -- sender (which re-checks), and terminal rows are history. Runs whatever the
  -- flag says: a stale pending row must not outlive its release because the flag
  -- was flipped off. Locked after every line, so no new lock-order edge; a claimer
  -- holding the row makes this wait for the claim (SKIP LOCKED never waits on us),
  -- and the WHERE is re-checked on the row it left, so a row just leased ('sending')
  -- is skipped, never cancelled. audited_at is stamped: this undo already wrote its
  -- own release_undone audit rows, and a later result.notice_cancelled row carrying
  -- the old bulk_batch_id would read as an unrelated change to a re-release's Undo.
  update public.release_notices n
     set status           = 'cancelled',
         resolved_at      = clock_timestamp(),
         audited_at       = clock_timestamp(),
         lease_token      = null,
         lease_expires_at = null,
         skip_reason      = 'release undone'
   where n.visit_id = p_visit_id
     and n.status in ('pending', 'retry')
     and not exists (
           select 1
             from unnest(n.test_request_ids) m(id)
             join public.test_requests tr on tr.id = m.id
            where tr.status = 'released'
              and tr.released_at = n.released_at);

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

comment on function public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb) is
  'Undoes the release of the selected tests of one visit (0198), expanded to every member of each touched combined report (0172), under the same locks as release_visit_results, with one test_request.release_undone audit row per undone row in the same transaction (0205; p_reason required, p_audit = {metadata, ip, user_agent}). In the same transaction (0214) it cancels this visit''s pending / retry release notices none of whose tests is still released with that release (partly undone and sending rows are left alone). Returns {undone: [{id, prior_release_medium, prior_released_at, report_id}], skipped: [{id, code: not_released|changed_since}]}. p_expected_released_at (batch Undo; every value a timestamp string) limits it to lines — and whole reports — still carrying that exact release, and then never raises for nothing-to-undo. Raises P0081 (whole request refused, message passes through), 40001/P0072 (retry), P0058 (patient inactive), 42501.';

revoke all on function public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- cancel_release_notice(p_id, p_reason): the app's fenced cancel
-- ---------------------------------------------------------------------------
-- pending / retry -> cancelled (resolved_at set, lease cleared), and nothing
-- else: a 'sending' row has a live lease and belongs to its sender, a terminal
-- row is history. Returns whether it cancelled, so a false tells the caller the
-- row is already owned or finished and must not be sent by another path too.
-- The reason is redacted of address- and phone-shaped text and cut to 200 chars,
-- like finish_release_notice's. audited_at is stamped: the caller (the flag-off
-- fast path, which then sends through the legacy notifier and writes ITS own
-- result.notified row) owns the audit trail, and a later result.notice_cancelled
-- row would contradict it. SECURITY INVOKER, service_role only.
create or replace function public.cancel_release_notice(p_id uuid, p_reason text default null)
returns boolean
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id     uuid;
  v_reason text;
begin
  v_reason := nullif(left(regexp_replace(regexp_replace(coalesce(p_reason, ''),
      '[^[:space:]@<>"'']+@[^[:space:]<>"'']+', '[redacted]', 'g'),
      '\+?[0-9][0-9 ()-]{6,}[0-9]', '[redacted]', 'g'), 200), '');
  update public.release_notices n
     set status           = 'cancelled',
         resolved_at      = clock_timestamp(),
         audited_at       = clock_timestamp(),
         lease_token      = null,
         lease_expires_at = null,
         skip_reason      = coalesce(v_reason, n.skip_reason)
   where n.id = p_id
     and n.status in ('pending', 'retry')
  returning n.id into v_id;
  return v_id is not null;
end;
$$;

comment on function public.cancel_release_notice(uuid, text) is
  '0214: fenced cancel of a release notice — pending / retry become cancelled (resolved_at set, lease cleared, audited_at stamped: the caller owns the audit trail); a sending or terminal row is never touched. Returns whether it cancelled. The reason is redacted and cut to 200 chars. service_role only.';

revoke all on function public.cancel_release_notice(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_release_notice(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Post-condition
-- ---------------------------------------------------------------------------
do $$
declare
  f   text;
  def text;
begin
  foreach f in array array['public.release_visit_results(uuid,uuid[],text,uuid,jsonb)',
                           'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)'] loop
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception '0214 post-check: % is not SECURITY DEFINER', f;
    end if;
    if not coalesce((select proconfig @> array['search_path=pg_catalog, public, pg_temp'] from pg_proc where oid = f::regprocedure), false) then
      raise exception '0214 post-check: % lost its pinned search_path', f;
    end if;
    if has_function_privilege('anon', f, 'EXECUTE')
       or not has_function_privilege('authenticated', f, 'EXECUTE')
       or not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '0214 post-check: % must be executable by authenticated and service_role, not anon', f;
    end if;
  end loop;

  def := pg_get_functiondef('public.release_visit_results(uuid,uuid[],text,uuid,jsonb)'::regprocedure);
  if def not like '%release_notices_enabled()%' or def not like '%insert into public.release_notices%'
     or def not like '%notice_id%'
     -- the enqueue comes AFTER the line writes
     or position('insert into public.release_notices' in def) < position('update public.test_requests t' in def) then
    raise exception '0214 post-check: release_visit_results does not enqueue after its line writes';
  end if;
  def := pg_get_functiondef('public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)'::regprocedure);
  if def not like '%update public.release_notices%' or def not like '%n.status in (''pending'', ''retry'')%' then
    raise exception '0214 post-check: undo_visit_release does not cancel pending/retry notices';
  end if;

  f := 'public.cancel_release_notice(uuid,text)';
  if has_function_privilege('anon', f, 'EXECUTE')
     or has_function_privilege('authenticated', f, 'EXECUTE')
     or not has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception '0214 post-check: % must be EXECUTE service_role only', f;
  end if;
  if exists (select 1 from pg_proc where oid = f::regprocedure
              and (prosecdef or not coalesce(proconfig @> array['search_path=pg_catalog, public, pg_temp'], false))) then
    raise exception '0214 post-check: % must be SECURITY INVOKER with a pinned search_path', f;
  end if;
end;
$$;

reset lock_timeout;

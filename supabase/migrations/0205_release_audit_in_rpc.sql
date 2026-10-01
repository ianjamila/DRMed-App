-- 0205_release_audit_in_rpc.sql
-- =============================================================================
-- Two follow-ups on 0198 (release_visit_results / undo_visit_release), from the
-- final review of the lab-release-on-queue programme.
--
-- 1. A batch Undo map with a JSON null could split a combined report.
--    undo_visit_release's batch mode (p_expected_released_at, the 10-minute
--    Undo) restores a combined report only when EVERY member still carries the
--    exact release the batch made. The check was written
--      not (map ? member and status = 'released' and … and released_at = map->>member)
--    For {"<member>": null} — or a released member whose released_at is null,
--    which no constraint forbids — the comparison is NULL, `not NULL` is NULL,
--    the member did not count as "changed", the report was NOT refused, and the
--    other members were undone without it: the split 0198 exists to prevent.
--    Now: (a) every map value must be a JSON string that reads as a timestamp,
--    else the whole call is refused (P0081, as for any unreadable map); and
--    (b) the report check is `(…) is not true`, so an unknown answer counts as
--    "changed since" and the report is skipped whole.
--
-- 2. The release / undo audit rows are written INSIDE the call.
--    Until now the TypeScript wrappers wrote `test_request.released` /
--    `test_request.release_undone` rows AFTER the RPC had committed, so a
--    direct authenticated RPC call — or a response lost on the way back —
--    left a release or undo with no audit row (and no undo reason). The rows
--    are now inserted in the same transaction as the status change: a
--    committed release/undo always has its rows, a rolled-back one never does.
--    The metadata keys are exactly the ones the wrappers wrote:
--      released: visit_id, release_medium, bulk, selection, <caller extras
--                — source, bulk_batch_id, package_header_id, result_id …>,
--                released_at (the exact stamp, full precision)
--      undone:   visit_id, reason, prior_release_medium, prior_released_at,
--                viewed_count, <caller extras — bulk, via, undo_of_batch,
--                bulk_batch_id, sample_visit_delete>, report_result_id
--    The caller's extras (p_audit.metadata) are allow-listed per function —
--    release: source, bulk, selection, bulk_batch_id, package_header_id,
--    result_id; undo: bulk, bulk_batch_id, sample_visit_delete, plus via /
--    undo_of_batch only with a batch map — scalars only, anything else P0081
--    (a direct call must not plant e.g. acting_as). They may set bulk /
--    selection (the visit page's single release writes false) but can never
--    overwrite a key the function knows (visit_id, the medium, the stamps,
--    the reason, the view count, the report): those are applied last. viewed_count (result_view_counts) is the SQL
--    twin of countResultViews (src/lib/results/viewed-count.ts), read under
--    the row locks — how often the patient had opened the result at the
--    moment of undo (RA 10173). ip / user agent come from p_audit; an
--    unreadable ip is stored as null rather than failing the release.
--    created_at is clock_timestamp(), not the transaction's now(): the batch
--    Undo's "changed since" check orders audit rows by created_at, and a call
--    that waited on a lock must not stamp its rows before the change it
--    waited for.
--    An undo now REQUIRES a reason (p_reason; P0081 when blank) — every app
--    path already demanded one; a direct call no longer escapes it.
--
-- Signatures: both functions gain trailing defaulted parameters, so the old
-- ones are dropped (not overloaded). Named-argument callers that omit the new
-- parameters still resolve — release keeps working unchanged; undo without
-- p_reason is refused.
-- Lock order, plan, refusal codes and return shapes are 0198's, unchanged.
-- =============================================================================

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- release_audit_context: the ip / user agent / caller metadata of p_audit.
-- Private helper. The caller's extras are ALLOW-LISTED per function (p_allowed)
-- and must be scalars: both RPCs are executable by `authenticated`, so a
-- staff member calling one directly must not be able to plant other keys —
-- e.g. `acting_as` (0187's View-as stamp) — in an audit row. ip / user agent
-- are what the caller reports (advisory, as they always were).
-- ---------------------------------------------------------------------------
create or replace function public.release_audit_context(p_audit jsonb, p_allowed text[])
returns table (extras jsonb, ip inet, user_agent text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_audit jsonb := case when jsonb_typeof(p_audit) = 'null' then null else p_audit end;
  v_meta  jsonb;
  v_ip    inet;
begin
  if v_audit is not null and jsonb_typeof(v_audit) <> 'object' then
    raise exception 'Couldn''t record this change in the audit log — try again.' using errcode = 'P0081';
  end if;
  v_meta := case when jsonb_typeof(v_audit -> 'metadata') is null or jsonb_typeof(v_audit -> 'metadata') = 'null'
                 then '{}'::jsonb else v_audit -> 'metadata' end;
  if jsonb_typeof(v_meta) <> 'object'
     or length(v_meta::text) > 4000
     or exists (select 1 from jsonb_each(v_meta) e
                 where not (e.key = any (p_allowed))
                    or jsonb_typeof(e.value) not in ('string', 'boolean', 'number')) then
    raise exception 'Couldn''t record this change in the audit log — try again.' using errcode = 'P0081';
  end if;
  begin
    v_ip := nullif(v_audit ->> 'ip', '')::inet;
  exception when others then
    v_ip := null;
  end;
  return query select v_meta, v_ip, left(nullif(v_audit ->> 'user_agent', ''), 512);
end;
$$;

comment on function public.release_audit_context(jsonb, text[]) is
  'Private helper of release_visit_results / undo_visit_release (0205): reads p_audit {metadata, ip, user_agent}; metadata keys must be in p_allowed with scalar values (P0081 otherwise); JSON null = absent; an unreadable ip becomes null.';

revoke all on function public.release_audit_context(jsonb, text[]) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- result_view_counts: the SQL twin of countResultViews (viewed-count.ts) —
-- per test, the `result.downloaded` rows naming it by any of the historical
-- shapes, each row counted once. One pass over the downloads for the whole
-- undo, not one per line (it runs under the undo's row locks). Private helper.
-- ---------------------------------------------------------------------------
create or replace function public.result_view_counts(p_test_request_ids uuid[])
returns table (test_request_id uuid, viewed_count integer)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select t.id, count(a.id)::integer
    from unnest(p_test_request_ids) t(id)
    left join public.audit_log a
      on a.action = 'result.downloaded'
     and a.resource_type = 'result'
     and (a.metadata ->> 'test_request_id' = t.id::text
          or a.metadata -> 'merged_component_ids' @> jsonb_build_array(t.id::text)
          or a.metadata -> 'test_request_ids' @> jsonb_build_array(t.id::text)
          or a.resource_id in (select rtr.result_id
                                 from public.result_test_requests rtr
                                where rtr.test_request_id = t.id))
   group by t.id;
$$;

comment on function public.result_view_counts(uuid[]) is
  'Private helper of undo_visit_release (0205): per test, how many result.downloaded audit rows name it (the SQL twin of countResultViews in src/lib/results/viewed-count.ts).';

revoke all on function public.result_view_counts(uuid[]) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- release_visit_results (0198 body + the audit rows)
-- ---------------------------------------------------------------------------
drop function if exists public.release_visit_results(uuid, uuid[], text, uuid);

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

comment on function public.release_visit_results(uuid, uuid[], text, uuid, jsonb) is
  'Releases the selected ready tests of one visit (0198), each combined report WHOLE or not at all, planned and written under the membership → patient → visit → test_requests locks, with one test_request.released audit row per released row in the same transaction (0205; p_audit = {metadata, ip, user_agent}). Returns {released: [{id, name, report_id, selected, released_at}], refused: [{id, code, report_id, count}]}; every selected id lands in exactly one of them. Codes: not_ready, outside_sections, report_outside_sections, report_package_header, report_other_visit, report_doctor_member, report_deleted_member, report_not_finished (count = unfinished members). Raises P0081 (whole call refused, message passes through), 40001/P0072 (retry), P0058 (patient inactive), 42501, and the payment/consent gates'' check_violation.';

revoke all on function public.release_visit_results(uuid, uuid[], text, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.release_visit_results(uuid, uuid[], text, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- undo_visit_release (0198 body + the null-safe batch check + the audit rows)
-- ---------------------------------------------------------------------------
drop function if exists public.undo_visit_release(uuid, uuid[], uuid, jsonb);

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
  'Undoes the release of the selected tests of one visit (0198), expanded to every member of each touched combined report (0172), under the same locks as release_visit_results, with one test_request.release_undone audit row per undone row in the same transaction (0205; p_reason required, p_audit = {metadata, ip, user_agent}). Returns {undone: [{id, prior_release_medium, prior_released_at, report_id}], skipped: [{id, code: not_released|changed_since}]}. p_expected_released_at (batch Undo; every value a timestamp string) limits it to lines — and whole reports — still carrying that exact release, and then never raises for nothing-to-undo. Raises P0081 (whole request refused, message passes through), 40001/P0072 (retry), P0058 (patient inactive), 42501.';

revoke all on function public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Post-checks
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  if to_regprocedure('public.release_visit_results(uuid,uuid[],text,uuid)') is not null
     or to_regprocedure('public.undo_visit_release(uuid,uuid[],uuid,jsonb)') is not null then
    raise exception '0205 post-check: a 0198 signature survived';
  end if;
  foreach f in array array[
    'public.release_audit_context(jsonb,text[])',
    'public.result_view_counts(uuid[])',
    'public.release_visit_results(uuid,uuid[],text,uuid,jsonb)',
    'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)'
  ] loop
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception '0205 post-check: % is not SECURITY DEFINER', f;
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception '0205 post-check: anon can execute %', f;
    end if;
  end loop;
  foreach f in array array['public.release_audit_context(jsonb,text[])', 'public.result_view_counts(uuid[])'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE')
       or has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '0205 post-check: % must stay private', f;
    end if;
  end loop;
  foreach f in array array['public.release_visit_results(uuid,uuid[],text,uuid,jsonb)',
                           'public.undo_visit_release(uuid,uuid[],uuid,jsonb,text,jsonb)'] loop
    if not has_function_privilege('authenticated', f, 'EXECUTE')
       or not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '0205 post-check: % must be executable by authenticated and service_role', f;
    end if;
  end loop;
end;
$$;

reset lock_timeout;

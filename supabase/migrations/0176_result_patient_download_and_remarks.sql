-- =============================================================================
-- 0176_result_patient_download_and_remarks.sql
-- =============================================================================
-- Two owner decisions (2026-09-25) that follow the finished-result edit (0172).
--
-- 1. A patient sees "Result updated" in the portal ONLY when they had already
--    downloaded the file before its latest edit, and it disappears once they
--    download the new version. Portal downloads were recorded only in
--    audit_log, which patients cannot read, so the result row now carries the
--    patient's last download time:
--
--      results.patient_last_downloaded_at — marker = it is set AND it is
--      earlier than results.amended_at (both readable under the patient row
--      policy through the existing table grant; no reason is ever exposed).
--
--    result_note_patient_download() is the one writer (service_role; every
--    portal download path and the data-export ZIP call it). The backfill below
--    derives the value from the audit rows already written. It cannot see a
--    PAST data-export ZIP: those rows are 'patient.data_exported' and, before
--    this migration, named no result — so a patient whose only earlier copy
--    came from an export gets no marker for edits made before their next
--    download. Nothing to backfill from; not a bug in the writer.
--
-- 2. A corrected report keeps its original report date; the clinic sees
--    "Updated <when> by <who> — <reason>" in the existing Remarks lists (lab
--    queue, Results archive, the test and chemistry pages' history). The reason
--    lives in result_amendments, whose read is section-gated (0172) and gives
--    reception nothing. result_amendment_remarks() is the narrow reader: same
--    row shape as queue_claim_remarks (0160), staff names instead of ids, and
--    the per-result gate is staff_can_read_finished_result (0172) — reception
--    and out-of-section lab staff get no rows.
--
-- 3. result_edit_commit (0172) records what each edit did to critical alerts
--    on its amendment row (commit_outcome) and returns it on replay, so a
--    lost-response retry still writes result.critical_alert_withdrawn.
--
-- Raises nothing new, so no P-code (the redefined function keeps 0172's
-- P0065/P0066).
-- =============================================================================

-- ----- 1. The patient's last download ----------------------------------------

alter table public.results
  add column if not exists patient_last_downloaded_at timestamptz;

comment on column public.results.patient_last_downloaded_at is
  'When the patient last downloaded this result''s PDF from the portal (any path: single, combined report, package, data export). Written only by result_note_patient_download(). The portal shows "Result updated" while it is earlier than amended_at.';

-- Writer. p_served is a JSON array of {result_id, storage_path}: the result and
-- the exact object the download handed out (read BEFORE signing). Time is the
-- database's, never the app server's.
--
-- If the served object is no longer the current PDF, an edit committed between
-- the portal's read and this write — the patient got the OLD file. Record a
-- time just before amended_at so the marker still shows. Monotonic: an older
-- write never moves the value back (a patient who already fetched the new file
-- keeps it hidden).
create or replace function public.result_note_patient_download(p_served jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_served is null or jsonb_typeof(p_served) <> 'array' then
    return 0;
  end if;

  with served as (
    select distinct on (s.result_id) s.result_id, s.storage_path
      from jsonb_to_recordset(p_served) as s(result_id uuid, storage_path text)
      join public.results cur on cur.id = s.result_id
     where s.result_id is not null
     -- One result listed twice with two different paths (no caller does this
     -- today): prefer the entry that is NOT the current file, so the marker
     -- errs on showing rather than hiding.
     order by s.result_id,
              (s.storage_path is not distinct from cur.storage_path),
              s.storage_path
  )
  update public.results r
     set patient_last_downloaded_at = greatest(
           coalesce(r.patient_last_downloaded_at, '-infinity'::timestamptz),
           case
             when r.storage_path is not distinct from s.storage_path then now()
             else least(now(), coalesce(r.amended_at, now()) - interval '1 microsecond')
           end
         )
    from served s
   where r.id = s.result_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 0119: public functions are service_role-only by default; revoke by name
-- anyway (hosted Supabase keeps a direct anon grant otherwise).
revoke all on function public.result_note_patient_download(jsonb) from public;
revoke execute on function public.result_note_patient_download(jsonb) from anon, authenticated;
grant execute on function public.result_note_patient_download(jsonb) to service_role;

-- Backfill from the patient download audit rows (viewed-count.ts documents the
-- shapes):
--   * resource_id = a results.id — every single-test and combined-report row;
--   * metadata.test_request_id — single-test rows (their resource_id is the
--     result too; kept so an older row without it still counts);
--   * package_consolidated rows — resource_id is the HEADER test, so the
--     results come from merged_component_ids (and the normalised
--     test_request_ids) through result_test_requests.
-- Only rows written by a patient count. Latest download per result wins.
with dl as (
  select a.created_at, a.resource_id, a.metadata
    from public.audit_log a
   where a.action = 'result.downloaded'
     and a.resource_type = 'result'
     and a.actor_type = 'patient'
),
hits as (
  select r.id as result_id, dl.created_at
    from dl
    join public.results r on r.id = dl.resource_id
  union all
  select rtr.result_id, dl.created_at
    from dl
    join public.result_test_requests rtr
      on rtr.test_request_id::text = dl.metadata ->> 'test_request_id'
  union all
  select rtr.result_id, dl.created_at
    from dl
    cross join lateral (
      select jsonb_array_elements_text(
               case when jsonb_typeof(dl.metadata -> k) = 'array'
                    then dl.metadata -> k else '[]'::jsonb end) as id
        from unnest(array['merged_component_ids', 'test_request_ids']) as k
    ) g
    join public.result_test_requests rtr on rtr.test_request_id::text = g.id
   where dl.metadata ->> 'kind' = 'package_consolidated'
),
latest as (
  select result_id, max(created_at) as at
    from hits
   group by result_id
)
update public.results r
   set patient_last_downloaded_at = latest.at
  from latest
 where r.id = latest.result_id
   and (r.patient_last_downloaded_at is null or r.patient_last_downloaded_at < latest.at);

-- ----- 2. Clinic-only edit remarks -------------------------------------------

-- One row per (asked-for member test, amendment) of every result the caller may
-- read finished. A combined report's amendment is filed under one anchor test
-- (result_amendments.test_request_id) but belongs to every member, so the join
-- is through result_test_requests; the app collapses the per-member copies.
create or replace function public.result_amendment_remarks(p_test_request_ids uuid[])
returns table (
  test_request_id uuid,
  action text,
  created_at timestamptz,
  actor_name text,
  previous_holder_name text,
  new_holder_name text,
  reason text
)
language sql
stable
security definer
set search_path = public
as $$
  with ids as (
    select distinct u.id
      from unnest(p_test_request_ids[1:200]) as u(id)
  ),
  results_asked as (
    select distinct rtr.result_id
      from public.result_test_requests rtr
      join ids on ids.id = rtr.test_request_id
  ),
  -- The gate, once per result: reception, and lab staff for a report that is
  -- not wholly in their sections (or not finished), get nothing.
  readable as (
    select ra.result_id
      from results_asked ra
     where public.staff_can_read_finished_result(ra.result_id)
  )
  select rtr.test_request_id,
         'result.amended'::text,
         am.amended_at,
         editor.full_name,
         null::text,
         null::text,
         nullif(btrim(am.reason), '')
    from readable
    join public.result_amendments am on am.result_id = readable.result_id
    join public.result_test_requests rtr on rtr.result_id = am.result_id
    join ids on ids.id = rtr.test_request_id
    left join public.staff_profiles editor on editor.id = am.amended_by
   order by rtr.test_request_id, am.amended_at;
$$;

revoke all on function public.result_amendment_remarks(uuid[]) from public;
revoke execute on function public.result_amendment_remarks(uuid[]) from anon;
grant execute on function public.result_amendment_remarks(uuid[]) to authenticated, service_role;

-- ----- 3. A replayed edit reports what it did to critical alerts ------------------
-- Codex review 2026-09-25: when the app loses result_edit_commit's response and
-- confirms the commit by probing attempt_id, it had no way to know which
-- unacknowledged critical alerts the edit withdrew, so the
-- result.critical_alert_withdrawn audit row was silently skipped (and the RPC's
-- own replay branch answered zero). The outcome is now stored on the amendment
-- row in the same transaction and returned on replay; the probe reads it too.
-- The function below is 0172's, unchanged except for the two marked 0176 hunks.

alter table public.result_amendments
  add column if not exists commit_outcome jsonb;

comment on column public.result_amendments.commit_outcome is
  'What this edit did to critical alerts ({alerts_added, alerts_removed, alerts_kept_acknowledged}), written by result_edit_commit in the same transaction so a replay or lost-response probe can audit it. NULL for edits made before 0176.';

create or replace function public.result_edit_commit(
  p_attempt_id               uuid,
  p_result_id                uuid,
  p_expected_amendment_count int,
  p_editor                   uuid,
  p_reason                   text,
  p_anchor_test_request_id   uuid,
  p_new_storage_path         text,
  p_new_file_size_bytes      int,
  p_values                   jsonb,  -- null = PDF-only edit, values untouched
  p_new_image                jsonb,  -- null = keep the current image columns
  p_alerts                   jsonb   -- null = leave critical_alerts alone
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing    public.result_amendments%rowtype;
  v_result      public.results%rowtype;
  v_seq         int;
  v_reason      text := btrim(coalesce(p_reason, ''));
  v_live        int;
  v_unfinished  int;
  v_patient_id  uuid;
  v_drm_id      text;
  v_snapshot    jsonb;
  v_amend_id    uuid;
  v_added       jsonb := '[]'::jsonb;
  v_removed     int := 0;
  v_kept_ack    int := 0;
begin
  -- 1) Serialise every edit, draft and finalise of this result on its row.
  select * into v_result
    from public.results
   where id = p_result_id
   for update;
  if not found then
    raise exception 'result not found' using errcode = 'P0066';
  end if;

  -- 2) Replay: this attempt already committed (the app lost the response and
  --    asked again). Checked UNDER the lock, so two overlapping calls with one
  --    attempt id cannot both pass — the second waits, then finds the first
  --    committed and returns it instead of failing the stale check below.
  select * into v_existing
    from public.result_amendments
   where attempt_id = p_attempt_id;
  if found then
    if v_existing.result_id <> p_result_id then
      raise exception 'this edit attempt belongs to another result' using errcode = 'P0066';
    end if;
    -- 0176: answer with what the original attempt DID to critical alerts
    -- (recorded below), so a retried or probed commit still audits every
    -- alert it added and withdrew. Rows from before 0176 have no record.
    return coalesce(
             v_existing.commit_outcome,
             jsonb_build_object('alerts_added', '[]'::jsonb, 'alerts_removed', 0,
                                'alerts_kept_acknowledged', 0, 'outcome_unknown', true)
           )
           || jsonb_build_object(
                'replayed', true,
                'amendment_id', v_existing.id,
                'amendment_seq', v_existing.amendment_seq,
                'prior_storage_path', v_existing.prior_storage_path
              );
  end if;

  -- 3) Editable?
  if v_result.storage_path is null then
    raise exception 'this result has no finished PDF yet' using errcode = 'P0066';
  end if;
  if v_result.generation_kind = 'structured' and v_result.finalised_at is null then
    raise exception 'this result has not been finalised yet' using errcode = 'P0066';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 2000 then
    raise exception 'the reason must be 5 to 2000 characters' using errcode = 'P0066';
  end if;

  select count(*),
         count(*) filter (
           where tr.status not in ('result_uploaded', 'ready_for_release', 'released')
         )
    into v_live, v_unfinished
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
   where rtr.result_id = p_result_id
     and tr.deleted_at is null
     and v.deleted_at is null;
  if v_live = 0 then
    raise exception 'every test on this result was deleted' using errcode = 'P0066';
  end if;
  if v_unfinished > 0 then
    raise exception 'a test on this result is not finished' using errcode = 'P0066';
  end if;

  select v.patient_id, p.drm_id
    into v_patient_id, v_drm_id
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
    join public.patients p on p.id = v.patient_id
   where rtr.result_id = p_result_id
     and rtr.test_request_id = p_anchor_test_request_id
     and tr.deleted_at is null
     and v.deleted_at is null;
  if not found then
    raise exception 'the anchor test is not a live test on this result' using errcode = 'P0066';
  end if;

  -- 4) Stale form: someone saved an edit since this one was opened.
  if v_result.amendment_count <> p_expected_amendment_count then
    raise exception 'this result was edited by someone else since you opened it'
      using errcode = 'P0065';
  end if;
  v_seq := p_expected_amendment_count + 1;

  -- 5) Snapshot, taken under the same lock as the overwrite.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'parameter_id', rv.parameter_id,
               'parameter_name', rtp.parameter_name,
               'numeric_value_si', rv.numeric_value_si,
               'numeric_value_conv', rv.numeric_value_conv,
               'text_value', rv.text_value,
               'select_value', rv.select_value,
               'flag', rv.flag,
               'is_blank', rv.is_blank
             )
             order by rtp.sort_order, rv.parameter_id
           ),
           '[]'::jsonb
         )
    into v_snapshot
    from public.result_values rv
    left join public.result_template_params rtp on rtp.id = rv.parameter_id
   where rv.result_id = p_result_id;

  insert into public.result_amendments (
    result_id, test_request_id,
    prior_storage_path, prior_uploaded_by, prior_uploaded_at,
    prior_file_size_bytes, prior_notes,
    prior_values_json,
    prior_image_storage_path, prior_image_filename,
    prior_image_mime_type, prior_image_size_bytes,
    reason, amended_by, amendment_seq, attempt_id
  ) values (
    p_result_id, p_anchor_test_request_id,
    v_result.storage_path, v_result.uploaded_by, v_result.uploaded_at,
    v_result.file_size_bytes, v_result.notes,
    case when v_result.generation_kind = 'structured' then v_snapshot else null end,
    v_result.image_storage_path, v_result.image_filename,
    v_result.image_mime_type, v_result.image_size_bytes,
    v_reason, p_editor, v_seq, p_attempt_id
  )
  returning id into v_amend_id;

  -- 6) New values (flags were computed in TypeScript — 0010).
  if p_values is not null then
    delete from public.result_values where result_id = p_result_id;
    insert into public.result_values (
      result_id, parameter_id, numeric_value_si, numeric_value_conv,
      text_value, select_value, flag, is_blank
    )
    select p_result_id, x.parameter_id, x.numeric_value_si, x.numeric_value_conv,
           x.text_value, x.select_value, x.flag, coalesce(x.is_blank, false)
      from jsonb_to_recordset(p_values) as x(
        parameter_id uuid, numeric_value_si numeric, numeric_value_conv numeric,
        text_value text, select_value text, flag text, is_blank boolean
      );
  end if;

  -- 7) Point the result at the new PDF. finalised_at is untouched, so
  --    advance_test_on_result_upload cannot fire, and test_requests is never
  --    written here.
  update public.results
     set storage_path       = p_new_storage_path,
         file_size_bytes    = p_new_file_size_bytes,
         uploaded_by        = p_editor,
         uploaded_at        = now(),
         amended_at         = now(),
         amendment_count    = v_seq,
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
                                   else p_editor end
   where id = p_result_id;

  -- 8) Critical alerts. Identity = (parameter_id, direction, observed value).
  --    Lock this result's alerts first so an acknowledgement in flight either
  --    lands before (and is then kept) or waits for this commit.
  if p_alerts is not null then
    perform 1 from public.critical_alerts where result_id = p_result_id for update;

    with desired as (
      select x.test_request_id, x.parameter_id, x.parameter_name, x.direction,
             x.observed_value_si, x.threshold_si
        from jsonb_to_recordset(p_alerts) as x(
          test_request_id uuid, parameter_id uuid, parameter_name text,
          direction text, observed_value_si numeric, threshold_si numeric
        )
    ),
    ins as (
      insert into public.critical_alerts (
        result_id, test_request_id, parameter_id, parameter_name, direction,
        observed_value_si, threshold_si, patient_id, patient_drm_id
      )
      select p_result_id, d.test_request_id, d.parameter_id, d.parameter_name,
             d.direction, d.observed_value_si, d.threshold_si, v_patient_id, v_drm_id
        from desired d
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

    with gone as (
      delete from public.critical_alerts ca
       where ca.result_id = p_result_id
         and ca.acknowledged_at is null
         and not exists (
           select 1
             from jsonb_to_recordset(p_alerts) as d(
               parameter_id uuid, direction text, observed_value_si numeric
             )
            where d.parameter_id = ca.parameter_id
              and d.direction = ca.direction
              and d.observed_value_si is not distinct from ca.observed_value_si
         )
      returning 1
    )
    select count(*) into v_removed from gone;

    select count(*) into v_kept_ack
      from public.critical_alerts
     where result_id = p_result_id
       and acknowledged_at is not null;
  end if;

  -- 0176: keep this attempt's alert outcome on its amendment row, in the
  -- same transaction, for a replay or a lost-response probe to report.
  update public.result_amendments
     set commit_outcome = jsonb_build_object(
           'alerts_added', v_added,
           'alerts_removed', v_removed,
           'alerts_kept_acknowledged', v_kept_ack
         )
   where id = v_amend_id;

  return jsonb_build_object(
    'replayed', false,
    'amendment_id', v_amend_id,
    'amendment_seq', v_seq,
    'prior_storage_path', v_result.storage_path,
    'alerts_added', v_added,
    'alerts_removed', v_removed,
    'alerts_kept_acknowledged', v_kept_ack
  );
end;
$$;
revoke all on function public.result_edit_commit(
  uuid, uuid, int, uuid, text, uuid, text, int, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.result_edit_commit(
  uuid, uuid, int, uuid, text, uuid, text, int, jsonb, jsonb, jsonb
) to service_role;

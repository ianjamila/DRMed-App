-- =============================================================================
-- undo-0179-local.sql — LOCAL SHARED STACK ONLY. Never run against prod.
-- =============================================================================
-- Reverses everything 0179_result_copy_followups.sql adds, so it can be
-- re-applied after a fix without a full `supabase db reset` (the local stack
-- is shared with other sessions). Run inside one transaction:
--
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -1 -q < scripts/smoke/undo-0179-local.sql
--
-- Order: drop the 5 new wrapper/internal functions, restore result_edit_commit
-- to its exact 0176 body, drop the new indexes, drop the new columns, then
-- re-create idx_critical_alerts_unacked with its pre-0179 (0027) definition.
-- The `-1` flag above wraps the whole script in one transaction, so it either
-- fully applies or fully rolls back.
-- =============================================================================
\set ON_ERROR_STOP on

drop function if exists public.result_record_patient_notify(uuid, text[], text);
drop function if exists public.result_claim_patient_notify(uuid);
drop function if exists public.result_mark_copy_contacted(uuid);
drop function if exists public.result_outdated_copies(boolean);
drop function if exists public.result_copy_state(uuid[]);
drop function if exists public.result_copy_states_internal(uuid[]);

-- result_edit_commit — exactly 0176's body (supabase/migrations/0176_result_patient_download_and_remarks.sql).
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

-- Drop the new indexes (0179 sections 2, 3).
drop index if exists public.idx_results_corrected;
drop index if exists public.idx_audit_log_result_printed;
drop index if exists public.idx_critical_alerts_withdrawn;
drop index if exists public.idx_critical_alerts_unacked;

-- Drop the new columns (0179 sections 1, 2).
alter table public.critical_alerts
  drop column if exists withdrawn_by_amendment,
  drop column if exists withdrawn_by,
  drop column if exists withdrawn_at;

alter table public.result_amendments
  drop column if exists patient_notify_error,
  drop column if exists patient_notified_channels,
  drop column if exists patient_notified_at,
  drop column if exists patient_contacted_by,
  drop column if exists patient_contacted_at;

-- Restore idx_critical_alerts_unacked to its pre-0179 (0027) definition.
create index idx_critical_alerts_unacked
  on public.critical_alerts(created_at desc)
  where acknowledged_at is null;

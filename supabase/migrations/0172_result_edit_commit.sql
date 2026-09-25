-- =============================================================================
-- 0172_result_edit_commit.sql
-- =============================================================================
-- Editing a FINISHED result (result_uploaded / ready_for_release / released),
-- for the chemistry combined report and the single-test paths alike.
--
-- 1. Who may READ a finished result's clinical values follows the lab section,
--    for the live values AND for the edit history's snapshots:
--    lab_sections_for_role() mirrors SECTIONS_BY_ROLE in
--    src/lib/auth/role-sections.ts (pinned by result-edit-migration.test.ts),
--    staff_can_read_finished_result() applies it. Owner decision 2026-09-24:
--    any medtech in the test's section may edit a finished result, so they
--    must be able to read it — until now medtech SELECT on result_values was
--    the holder only (0151). result_amendments.prior_values_json holds the
--    same values and was readable by every staff role, reception included.
--
-- 2. One write path. Every app write to results / result_values /
--    result_amendments already runs on the service-role client; the JWT write
--    policies were unused doors around the version check below, so they go.
--
-- 3. result_edit_commit(): the whole edit in one transaction — snapshot, new
--    values, new PDF pointer, critical-alert reconciliation — under a row lock
--    on the result, rejecting a stale form (P0065) and anything not editable
--    (P0066). Idempotent per attempt_id so an app that lost the response can
--    ask whether its attempt committed. Never writes test_requests: status,
--    release time, releaser and medium cannot change.
--
-- 4. P0067: a line that belongs to a finished combined report (one PDF shared
--    by several tests, e.g. Chemistry) cannot be soft-deleted on its own.
--
-- P-codes: P0065 stale edit, P0066 not editable, P0067 combined-report delete.
-- =============================================================================

-- ----- 1. Section-aware read access ------------------------------------------

create or replace function public.lab_sections_for_role(p_role text)
returns text[]
language sql
immutable
set search_path = public
as $$
  -- NULL = unrestricted (admin, pathologist); '{}' = no access.
  select case p_role
    when 'admin' then null
    when 'pathologist' then null
    when 'medtech' then array[
      'chemistry', 'hematology', 'immunology', 'urinalysis', 'microbiology', 'send_out'
    ]::text[]
    when 'xray_technician' then array[
      'imaging_xray', 'imaging_ultrasound', 'imaging_ecg'
    ]::text[]
    else array[]::text[]
  end;
$$;
revoke all on function public.lab_sections_for_role(text) from public, anon, authenticated;
grant execute on function public.lab_sections_for_role(text) to authenticated, service_role;

-- A finished result is readable by pathologist/admin, and by a medtech or
-- x-ray technician when
--   * EVERY linked test — deleted ones included, since a deleted member's
--     values still sit on the shared result — is inside their sections (a
--     NULL section is outside every list), and
--   * every LIVE linked test (test and visit not deleted) is finished, and
--     there is at least one.
-- The same rule gates editing (result_edit_commit checks the live-finished
-- half; the Server Actions check the section half through this function), so
-- a deleted member never locks a report and never widens who can read it.
create or replace function public.staff_can_read_finished_result(p_result_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role     text := public.staff_role();
  v_sections text[];
begin
  if v_role is null then
    return false;
  end if;
  if v_role in ('admin', 'pathologist') then
    return true;
  end if;
  if v_role not in ('medtech', 'xray_technician') then
    return false;
  end if;
  v_sections := public.lab_sections_for_role(v_role);

  return exists (
      select 1
        from public.result_test_requests rtr
        join public.test_requests tr on tr.id = rtr.test_request_id
        join public.visits v on v.id = tr.visit_id
       where rtr.result_id = p_result_id
         and tr.deleted_at is null
         and v.deleted_at is null
    )
    and not exists (
      select 1
        from public.result_test_requests rtr
        join public.test_requests tr on tr.id = rtr.test_request_id
        join public.services s on s.id = tr.service_id
       where rtr.result_id = p_result_id
         and (s.section is null or not (s.section = any (v_sections)))
    )
    and not exists (
      select 1
        from public.result_test_requests rtr
        join public.test_requests tr on tr.id = rtr.test_request_id
        join public.visits v on v.id = tr.visit_id
       where rtr.result_id = p_result_id
         and tr.deleted_at is null
         and v.deleted_at is null
         and tr.status not in ('result_uploaded', 'ready_for_release', 'released')
    );
end;
$$;
revoke all on function public.staff_can_read_finished_result(uuid) from public, anon, authenticated;
grant execute on function public.staff_can_read_finished_result(uuid) to authenticated, service_role;

-- result_values: the 0151 holder policy stays (bench drafts); this adds the
-- in-section read of finished results.
create policy "result_values: section staff read finished"
  on public.result_values
  as permissive
  for select
  to authenticated
  using (public.staff_can_read_finished_result(result_id));

-- result_amendments: the snapshots carry the same values. Replaces the
-- all-staff (reception included) read.
drop policy if exists "result_amendments: staff read" on public.result_amendments;
create policy "result_amendments: section staff read"
  on public.result_amendments
  as permissive
  for select
  to authenticated
  using (public.staff_can_read_finished_result(result_id));

-- ----- 2. One write path -------------------------------------------------------

drop policy if exists "results: medtech/pathologist/admin write" on public.results;
drop policy if exists "result_values: medtech write own claimed test" on public.result_values;
drop policy if exists "result_values: medtech update own claimed test" on public.result_values;
drop policy if exists "result_values: admin delete" on public.result_values;
drop policy if exists "result_amendments: medtech/pathologist/admin write" on public.result_amendments;

-- ----- 3. result_edit_commit ---------------------------------------------------

alter table public.result_amendments
  add column if not exists attempt_id uuid;
create unique index if not exists uq_result_amendments_attempt_id
  on public.result_amendments (attempt_id)
  where attempt_id is not null;

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
    return jsonb_build_object(
      'replayed', true,
      'amendment_id', v_existing.id,
      'amendment_seq', v_existing.amendment_seq,
      'prior_storage_path', v_existing.prior_storage_path,
      'alerts_added', '[]'::jsonb,
      'alerts_removed', 0,
      'alerts_kept_acknowledged', 0
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

-- ----- 3b. Finalise and draft share the same lock ------------------------------
-- A structured result is written three ways: draft saves, the first finalise,
-- and edits. Before 0172 the first two were separate service-role writes with
-- the check in TypeScript, so a paused draft could land after a finalise and
-- change values under the stored PDF, and the consolidated finalise wrote its
-- critical alerts AFTER the report was already visible and editable. Both now
-- run in one transaction under the same row lock as result_edit_commit.

-- The first finalise: values, PDF pointer, finalised_at, image and the initial
-- critical alerts together. Writing finalised_at fires
-- advance_test_on_result_upload inside this transaction, so the status flip
-- lands with everything else or not at all.
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
begin
  select * into v_result
    from public.results
   where id = p_result_id
   for update;
  if not found then
    raise exception 'result not found' using errcode = 'P0066';
  end if;
  if v_result.generation_kind <> 'structured' then
    raise exception 'this result was uploaded as a PDF' using errcode = 'P0066';
  end if;
  if v_result.finalised_at is not null then
    raise exception 'this result is already finalised — use Edit results to change it'
      using errcode = 'P0066';
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
revoke all on function public.result_finalise_commit(
  uuid, uuid, jsonb, text, int, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.result_finalise_commit(
  uuid, uuid, jsonb, text, int, timestamptz, jsonb, jsonb
) to service_role;

-- A draft save: upsert values on an UNFINALISED structured result only.
create or replace function public.result_save_draft(
  p_result_id uuid,
  p_values    jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.results%rowtype;
begin
  select * into v_result
    from public.results
   where id = p_result_id
   for update;
  if not found then
    raise exception 'result not found' using errcode = 'P0066';
  end if;
  if v_result.generation_kind <> 'structured' or v_result.finalised_at is not null then
    raise exception 'this result is already finalised — use Edit results to change it'
      using errcode = 'P0066';
  end if;

  insert into public.result_values (
    result_id, parameter_id, numeric_value_si, numeric_value_conv,
    text_value, select_value, flag, is_blank
  )
  select p_result_id, x.parameter_id, x.numeric_value_si, x.numeric_value_conv,
         x.text_value, x.select_value, x.flag, coalesce(x.is_blank, false)
    from jsonb_to_recordset(coalesce(p_values, '[]'::jsonb)) as x(
      parameter_id uuid, numeric_value_si numeric, numeric_value_conv numeric,
      text_value text, select_value text, flag text, is_blank boolean
    )
  on conflict (result_id, parameter_id) do update
     set numeric_value_si   = excluded.numeric_value_si,
         numeric_value_conv = excluded.numeric_value_conv,
         text_value         = excluded.text_value,
         select_value       = excluded.select_value,
         flag               = excluded.flag,
         is_blank           = excluded.is_blank;
end;
$$;
revoke all on function public.result_save_draft(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.result_save_draft(uuid, jsonb) to service_role;

-- ----- 4. Combined-report delete guard (P0067) --------------------------------
-- Latest body from 0147 + the P0067 block.
create or replace function public.enforce_deletable_test_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_status text;
begin
  if not (old.deleted_at is null and new.deleted_at is not null) then
    return new;
  end if;

  if old.status = 'released' then
    raise exception 'test has a released result' using errcode = 'P0043';
  end if;

  -- Components are deleted by the header cascade (fn_queue_delete_cascade,
  -- depth 2) — a direct component delete would silently break the package's
  -- component set while the header keeps billing the full package price.
  if old.parent_id is not null and pg_trigger_depth() <= 1 then
    raise exception 'package component — delete the whole package instead'
      using errcode = 'P0044';
  end if;

  -- 0172: this line is one of several tests on a finished combined report
  -- (one PDF shared by every member — Chemistry). Deleting it on its own would
  -- leave a PDF that still reports a test the bill no longer has. Checked at
  -- every depth, so a package delete whose component sits on such a report is
  -- refused as a whole.
  if exists (
    select 1
      from public.result_test_requests rtr
      join public.results r on r.id = rtr.result_id
     where rtr.test_request_id = old.id
       and r.storage_path is not null
       and exists (
         select 1 from public.result_test_requests other
          where other.result_id = r.id
            and other.test_request_id <> old.id
       )
  ) then
    raise exception 'test is part of a finished combined report — it cannot be deleted on its own'
      using errcode = 'P0067';
  end if;

  -- 0147: this line's own money is already billed to an HMO. Placed before
  -- the payment_status check so the specific reason wins over the generic one
  -- — though for an HMO visit that check never fires anyway (0133 keeps it
  -- unpaid). This also covers the package cascade: a component carrying an
  -- open claim raises here at depth 2 and aborts the whole header delete,
  -- which is what should happen.
  if exists (
    select 1 from public.hmo_claim_items ci
     where ci.test_request_id = old.id
       and not ci.batch_voided
  ) then
    raise exception 'test has an open HMO claim — void the claim batch first'
      using errcode = 'P0050';
  end if;

  select payment_status into v_payment_status
    from public.visits where id = new.visit_id;

  if v_payment_status <> 'unpaid' then
    raise exception 'visit is not unpaid (payment_status=%)', v_payment_status
      using errcode = 'P0042';
  end if;

  return new;
end;
$$;
revoke all on function public.enforce_deletable_test_request() from public, anon, authenticated;

-- 0179 — Corrected-result follow-ups (spec 2026-09-25-result-copy-followups-design.md)
--
-- 1. result_amendments carries the patient follow-up for each correction:
--    contacted by staff, or notified (email/SMS) once, on the editor's opt-in.
-- 2. critical_alerts keeps history: a correction WITHDRAWS an unacknowledged
--    alert it removed (withdrawn_at/by/by_amendment) instead of deleting it.
--    result_edit_commit is 0176's body plus three "-- 0179" hunks, generated
--    from 0176 (src/lib/results/edit-commit-0179-hunks.ts) and pinned by
--    result-copy-followups-migration.test.ts. The FINALISE path's cleanup of
--    pre-0172 leftovers (result_finalise_commit) stays a delete: it is not a
--    correction.
-- 3. One internal copy-state function and five wrappers: which patients hold an
--    out-of-date copy (portal download or a reception/admin print), for
--    reception + admin, never with reasons or values.

-- 1) Follow-up state per correction ------------------------------------------
alter table public.result_amendments
  add column patient_contacted_at      timestamptz,
  add column patient_contacted_by      uuid references auth.users(id),
  add column patient_notified_at       timestamptz,
  add column patient_notified_channels text[],
  add column patient_notify_error      text;

comment on column public.result_amendments.patient_contacted_at is
  'Reception/admin marked the patient contacted about THIS correction (result_mark_copy_contacted).';
comment on column public.result_amendments.patient_notified_at is
  'Send claim for the opt-in "updated copy ready" notice — set once by result_claim_patient_notify; never cleared, so nothing re-sends.';
comment on column public.result_amendments.patient_notify_error is
  'Why the notice did not go out (provider error / skipped). Clinic-only; the follow-up list shows only "Send failed".';

-- 2) Withdrawn critical alerts ------------------------------------------------
alter table public.critical_alerts
  add column withdrawn_at           timestamptz,
  add column withdrawn_by           uuid references auth.users(id),
  add column withdrawn_by_amendment uuid references public.result_amendments(id) on delete set null;

drop index if exists public.idx_critical_alerts_unacked;
create index idx_critical_alerts_unacked
  on public.critical_alerts(created_at desc)
  where acknowledged_at is null and withdrawn_at is null;
create index idx_critical_alerts_withdrawn
  on public.critical_alerts(withdrawn_at desc)
  where withdrawn_at is not null;

-- 3) Print lookups by result (the follow-up list reads these) ---------------
create index if not exists idx_audit_log_result_printed
  on public.audit_log ((metadata->>'result_id'))
  where action = 'result.printed_staff';

-- 4) result_edit_commit — 0176 + the three 0179 hunks (generated) ------------
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
            -- 0179: a withdrawn alert is history, not a live match — a value
            -- corrected back to it pages again.
            and ca.withdrawn_at is null
       )
      returning parameter_name, direction, observed_value_si, threshold_si
    )
    select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) into v_added from ins;

    -- 0179: a removed alert is WITHDRAWN (kept as history), never deleted.
    with gone as (
      update public.critical_alerts ca
         set withdrawn_at = now(),
             withdrawn_by = p_editor,
             withdrawn_by_amendment = v_amend_id
       where ca.result_id = p_result_id
         and ca.acknowledged_at is null
         and ca.withdrawn_at is null
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
       and acknowledged_at is not null
       and withdrawn_at is null; -- 0179
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

-- 5) Copy state ---------------------------------------------------------------
-- One row per result: does the patient hold a copy, is it out of date, and has
-- the latest correction been followed up. p_result_ids null = every corrected
-- result. A "printed copy" is a result.printed_staff row stamped by reception or
-- admin (the roles that hand paper over); lab prints are internal. Service role
-- only — the wrappers below decide who sees which rows and columns.
create or replace function public.result_copy_states_internal(p_result_ids uuid[])
returns table (
  result_id                 uuid,
  anchor_test_request_id    uuid,
  visit_id                  uuid,
  patient_id                uuid,
  amendment_count           int,
  amended_at                timestamptz,
  latest_amendment_id       uuid,
  portal_downloaded_at      timestamptz,
  last_handover_print_count int,
  holds_copy                boolean,
  portal_outdated           boolean,
  printed_outdated          boolean,
  contacted_at              timestamptz,
  contacted_by              uuid,
  notified_at               timestamptz,
  notified_channels         text[],
  notify_error              text,
  followed_up               boolean,
  has_email                 boolean,
  has_phone                 boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with r as (
    select res.id, res.amendment_count, res.amended_at,
           res.patient_last_downloaded_at
      from public.results res
     where case when p_result_ids is null then res.amendment_count > 0
                else res.id = any(p_result_ids) end
  ),
  prints as (
    select (a.metadata->>'result_id')::uuid as result_id,
           max((a.metadata->>'amendment_count')::int) as last_count
      from public.audit_log a
     where a.action = 'result.printed_staff'
       and a.metadata->>'result_id' in (select r.id::text from r)
       and a.metadata->>'role' in ('reception', 'admin')
       and a.metadata->>'amendment_count' ~ '^[0-9]+$'
     group by 1
  )
  select r.id,
         anchor.test_request_id,
         anchor.visit_id,
         v.patient_id,
         r.amendment_count,
         r.amended_at,
         la.id,
         r.patient_last_downloaded_at,
         p.last_count,
         (r.patient_last_downloaded_at is not null or p.last_count is not null),
         (r.amendment_count > 0
            and r.patient_last_downloaded_at is not null
            and r.patient_last_downloaded_at < r.amended_at),
         (r.amendment_count > 0 and p.last_count is not null and p.last_count < r.amendment_count),
         la.patient_contacted_at,
         la.patient_contacted_by,
         la.patient_notified_at,
         la.patient_notified_channels,
         la.patient_notify_error,
         (la.patient_contacted_at is not null
            or (la.patient_notified_at is not null
                and coalesce(cardinality(la.patient_notified_channels), 0) > 0
                and la.patient_notify_error is null)),
         nullif(btrim(pt.email), '') is not null,
         nullif(btrim(pt.phone), '') is not null
    from r
    left join lateral (
      select tr.id as test_request_id, tr.visit_id
        from public.result_test_requests rtr
        join public.test_requests tr on tr.id = rtr.test_request_id
       where rtr.result_id = r.id
         and tr.deleted_at is null
       order by rtr.test_request_id
       limit 1
    ) anchor on true
    left join public.visits v    on v.id = anchor.visit_id
    left join public.patients pt on pt.id = v.patient_id
    left join lateral (
      select ra.*
        from public.result_amendments ra
       where ra.result_id = r.id
         and ra.amendment_seq = r.amendment_count
    ) la on true
    left join prints p on p.result_id = r.id;
$$;
revoke all on function public.result_copy_states_internal(uuid[]) from public, anon, authenticated;
grant execute on function public.result_copy_states_internal(uuid[]) to service_role;

-- Per-result copy state for staff pages (visit chip, edit-form checkbox).
-- Reception/admin see every row; lab roles only results they may read
-- (staff_can_read_finished_result). No reasons, no values, no error text.
create or replace function public.result_copy_state(p_result_ids uuid[])
returns table (
  result_id           uuid,
  latest_amendment_id uuid,
  amendment_count     int,
  amended_at          timestamptz,
  holds_copy          boolean,
  portal_outdated     boolean,
  printed_outdated    boolean,
  followed_up         boolean,
  notified_at         timestamptz,
  notify_failed       boolean,
  has_email           boolean,
  has_phone           boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.staff_role();
begin
  if v_role is null then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if p_result_ids is null or cardinality(p_result_ids) > 200 then
    raise exception 'pass up to 200 result ids' using errcode = '22023';
  end if;
  return query
    select s.result_id, s.latest_amendment_id, s.amendment_count, s.amended_at,
           s.holds_copy, s.portal_outdated, s.printed_outdated, s.followed_up,
           s.notified_at, (s.notify_error is not null), s.has_email, s.has_phone
      from public.result_copy_states_internal(p_result_ids) s
     where v_role in ('reception', 'admin')
        or public.staff_can_read_finished_result(s.result_id);
end;
$$;
revoke all on function public.result_copy_state(uuid[]) from public, anon;
grant execute on function public.result_copy_state(uuid[]) to authenticated, service_role;

-- The follow-up list: patients holding an out-of-date copy of a corrected
-- result whose latest correction is not followed up. Reception + admin only.
create or replace function public.result_outdated_copies(p_include_followed_up boolean default false)
returns table (
  result_id           uuid,
  latest_amendment_id uuid,
  amendment_count     int,
  amended_at          timestamptz,
  visit_id            uuid,
  patient_id          uuid,
  patient_name        text,
  drm_id              text,
  phone               text,
  has_email           boolean,
  test_names          text,
  portal_outdated     boolean,
  printed_outdated    boolean,
  followed_up         boolean,
  contacted_at        timestamptz,
  contacted_by_name   text,
  notified_at         timestamptz,
  notified_channels   text[],
  notify_failed       boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.staff_role();
begin
  if v_role is null or v_role not in ('reception', 'admin') then
    raise exception 'reception or admin only' using errcode = '42501';
  end if;
  return query
    select s.result_id, s.latest_amendment_id, s.amendment_count, s.amended_at,
           s.visit_id, s.patient_id,
           nullif(btrim(concat_ws(' ', pt.first_name, pt.last_name)), ''),
           pt.drm_id, pt.phone, s.has_email,
           (select string_agg(x.name, ', ' order by x.name)
              from (select distinct sv.name
                      from public.result_test_requests rtr
                      join public.test_requests tr
                        on tr.id = rtr.test_request_id and tr.deleted_at is null
                      join public.services sv on sv.id = tr.service_id
                     where rtr.result_id = s.result_id) x),
           s.portal_outdated, s.printed_outdated, s.followed_up,
           s.contacted_at, sp.full_name, s.notified_at, s.notified_channels,
           (s.notify_error is not null)
      from public.result_copy_states_internal(null) s
      join public.visits v on v.id = s.visit_id and v.deleted_at is null
      left join public.patients pt       on pt.id = s.patient_id
      left join public.staff_profiles sp on sp.id = s.contacted_by
     where (s.portal_outdated or s.printed_outdated)
       and (p_include_followed_up or not s.followed_up)
     order by s.amended_at desc, s.result_id;
end;
$$;
revoke all on function public.result_outdated_copies(boolean) from public, anon;
grant execute on function public.result_outdated_copies(boolean) to authenticated, service_role;

-- Mark the patient contacted about a correction. Only the result's LATEST
-- correction can be marked (P0068 otherwise: it was corrected again since the
-- list loaded). Idempotent. Audited in the same transaction.
create or replace function public.result_mark_copy_contacted(p_amendment_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role    text := public.staff_role();
  v_am      public.result_amendments%rowtype;
  v_count   int;
  v_patient uuid;
begin
  if v_role is null or v_role not in ('reception', 'admin') then
    raise exception 'reception or admin only' using errcode = '42501';
  end if;
  select * into v_am from public.result_amendments where id = p_amendment_id for update;
  if not found then
    raise exception 'correction not found' using errcode = 'P0068';
  end if;
  select amendment_count into v_count from public.results where id = v_am.result_id;
  if v_am.amendment_seq is distinct from v_count then
    raise exception 'this result was corrected again' using errcode = 'P0068';
  end if;
  if v_am.patient_contacted_at is not null then
    return v_am.patient_contacted_at;
  end if;
  update public.result_amendments
     set patient_contacted_at = now(),
         patient_contacted_by = auth.uid()
   where id = p_amendment_id;
  select s.patient_id into v_patient
    from public.result_copy_states_internal(array[v_am.result_id]) s;
  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id, metadata)
  values (auth.uid(), 'staff', v_patient, 'result.patient_contacted', 'test_request', v_am.test_request_id,
          jsonb_build_object('result_id', v_am.result_id, 'amendment_id', v_am.id,
                             'amendment_seq', v_am.amendment_seq));
  return now();
end;
$$;
revoke all on function public.result_mark_copy_contacted(uuid) from public, anon;
grant execute on function public.result_mark_copy_contacted(uuid) to authenticated, service_role;

-- The opt-in notice: claim once (returns a row only the first time), then
-- record what went out. Server only.
create or replace function public.result_claim_patient_notify(p_amendment_id uuid)
returns table (result_id uuid, amendment_seq int, anchor_test_request_id uuid, patient_id uuid)
language sql
volatile
security definer
set search_path = public
as $$
  with c as (
    update public.result_amendments
       set patient_notified_at = now()
     where id = p_amendment_id
       and patient_notified_at is null
    returning result_id, amendment_seq
  )
  select c.result_id, c.amendment_seq, s.anchor_test_request_id, s.patient_id
    from c
    cross join lateral public.result_copy_states_internal(array[c.result_id]) s;
$$;
revoke all on function public.result_claim_patient_notify(uuid) from public, anon, authenticated;
grant execute on function public.result_claim_patient_notify(uuid) to service_role;

create or replace function public.result_record_patient_notify(
  p_amendment_id uuid, p_channels text[], p_error text
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.result_amendments
     set patient_notified_channels = coalesce(p_channels, '{}'::text[]),
         patient_notify_error      = nullif(btrim(coalesce(p_error, '')), '')
   where id = p_amendment_id
     and patient_notified_at is not null;
$$;
revoke all on function public.result_record_patient_notify(uuid, text[], text) from public, anon, authenticated;
grant execute on function public.result_record_patient_notify(uuid, text[], text) to service_role;

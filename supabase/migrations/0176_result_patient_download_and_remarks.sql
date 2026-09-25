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
--    derives the value from the audit rows already written.
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
-- Raises nothing, so no P-code.
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
     where s.result_id is not null
     -- A result served twice in one call (a package whose components share a
     -- combined report): prefer the current-looking entry deterministically.
     order by s.result_id, s.storage_path
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

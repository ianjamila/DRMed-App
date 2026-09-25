-- =============================================================================
-- smoke/result-edit-followups.sql — 0176 on a local stack (rolls back)
-- =============================================================================
-- docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--   < scripts/smoke/result-edit-followups.sql
--
-- Builds a throwaway fixture (three staff, one patient, a two-member chemistry
-- report + an x-ray-section member, one edit), then checks:
--   A. result_note_patient_download — current path → now(); a path an edit
--      already replaced → just before amended_at (marker stays); monotonic;
--      no grant to anon/authenticated.
--   B. the 0176 backfill block — all three audit shapes, patient rows only.
--   C. result_amendment_remarks — admin sees the edit on EVERY member with name
--      and reason; reception sees nothing; a medtech sees nothing for a report
--      with a member outside their sections, and sees it once the report is
--      wholly theirs.
-- Everything is inside one transaction that ROLLS BACK.
-- =============================================================================
\set ON_ERROR_STOP on
begin;

-- ----- fixture ---------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-00000000a001', 'smoke-admin@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000000a002', 'smoke-medtech@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000000a003', 'smoke-reception@example.test', 'authenticated', 'authenticated');
insert into public.staff_profiles (id, full_name, role) values
  ('00000000-0000-4000-8000-00000000a001', 'Smoke Admin', 'admin'),
  ('00000000-0000-4000-8000-00000000a002', 'Smoke Medtech', 'medtech'),
  ('00000000-0000-4000-8000-00000000a003', 'Smoke Reception', 'reception');

insert into public.patients (id, first_name, last_name, birthdate)
values ('00000000-0000-4000-8000-00000000b001', 'Smoke', 'Patient', '1990-01-01');
insert into public.visits (id, patient_id)
values ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000b001');

insert into public.services (id, code, name, price_php, section) values
  ('00000000-0000-4000-8000-00000000d001', 'ZZSMK_FBS', 'Smoke FBS', 100, 'chemistry'),
  ('00000000-0000-4000-8000-00000000d002', 'ZZSMK_CREA', 'Smoke Creatinine', 100, 'chemistry'),
  ('00000000-0000-4000-8000-00000000d003', 'ZZSMK_XR', 'Smoke X-ray', 100, 'imaging_xray');

insert into public.test_requests (id, visit_id, service_id, requested_by, status) values
  ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000a001', 'ready_for_release'),
  ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-00000000a001', 'ready_for_release'),
  ('00000000-0000-4000-8000-00000000e003', '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000d003', '00000000-0000-4000-8000-00000000a001', 'ready_for_release');

-- r1: FBS + Creatinine + (for now) the x-ray line — a report the medtech must
-- NOT read while the x-ray member is on it.
insert into public.results (id, uploaded_by, storage_path, generation_kind, finalised_at, amended_at, amendment_count)
values ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000a001',
        'v/r1.v2.aaaa.pdf', 'uploaded', now() - interval '2 days', now() - interval '1 hour', 1);
insert into public.result_test_requests (result_id, test_request_id) values
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000e001'),
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000e002'),
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000e003');
insert into public.result_amendments
  (result_id, test_request_id, prior_storage_path, prior_uploaded_by, prior_uploaded_at, reason, amended_by, amended_at, amendment_seq)
values ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000e001', 'v/r1.pdf',
        '00000000-0000-4000-8000-00000000a001', now() - interval '2 days', '  wrong unit on glucose  ',
        '00000000-0000-4000-8000-00000000a001', now() - interval '1 hour', 1);

-- ----- A. the writer -----------------------------------------------------------
do $$
declare
  v_amended timestamptz;
  v_at      timestamptz;
  v_n       int;
begin
  select amended_at into v_amended from public.results where id = '00000000-0000-4000-8000-00000000f001';

  -- A download that raced the edit: it served the REPLACED file.
  v_n := public.result_note_patient_download(
    '[{"result_id":"00000000-0000-4000-8000-00000000f001","storage_path":"v/r1.pdf"}]'::jsonb);
  select patient_last_downloaded_at into v_at from public.results where id = '00000000-0000-4000-8000-00000000f001';
  if v_n <> 1 or v_at is null or v_at >= v_amended then
    raise exception 'A1: stale download must land before amended_at (n=%, at=%, amended=%)', v_n, v_at, v_amended;
  end if;
  if v_at <> v_amended - interval '1 microsecond' then
    raise exception 'A1: stale download should be amended_at - 1µs, got %', v_at;
  end if;

  -- The patient downloads the CURRENT file: now(), marker clears.
  perform public.result_note_patient_download(
    '[{"result_id":"00000000-0000-4000-8000-00000000f001","storage_path":"v/r1.v2.aaaa.pdf"}]'::jsonb);
  select patient_last_downloaded_at into v_at from public.results where id = '00000000-0000-4000-8000-00000000f001';
  if v_at <> now() or v_at <= v_amended then
    raise exception 'A2: current download must be now() (> amended_at), got %', v_at;
  end if;

  -- A late write of the old file never moves it back (monotonic).
  perform public.result_note_patient_download(
    '[{"result_id":"00000000-0000-4000-8000-00000000f001","storage_path":"v/r1.pdf"}]'::jsonb);
  if (select patient_last_downloaded_at from public.results where id = '00000000-0000-4000-8000-00000000f001') <> now() then
    raise exception 'A3: an older write moved the download time back';
  end if;

  -- Junk input is a no-op, never an error.
  if public.result_note_patient_download(null) <> 0
     or public.result_note_patient_download('{}'::jsonb) <> 0
     or public.result_note_patient_download('[{"storage_path":"x"}]'::jsonb) <> 0 then
    raise exception 'A4: junk input should update nothing';
  end if;

  if has_function_privilege('anon', 'public.result_note_patient_download(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.result_note_patient_download(jsonb)', 'execute') then
    raise exception 'A5: the writer must be service_role only';
  end if;
  if not has_column_privilege('anon', 'public.results', 'patient_last_downloaded_at', 'select') then
    raise exception 'A6: the patient client (anon role) must be able to read the column';
  end if;
  raise notice 'A writer OK';
end $$;

-- ----- B. the backfill ------------------------------------------------------------
-- Two more results: r2 (single test, downloaded twice — keep the LATEST) and r3
-- (package component, downloaded only through a package_consolidated row).
insert into public.results (id, uploaded_by, storage_path, generation_kind) values
  ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000a001', 'v/r2.pdf', 'uploaded'),
  ('00000000-0000-4000-8000-00000000f003', '00000000-0000-4000-8000-00000000a001', 'v/r3.pdf', 'uploaded');
insert into public.test_requests (id, visit_id, service_id, requested_by, status) values
  ('00000000-0000-4000-8000-00000000e004', '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000a001', 'ready_for_release'),
  ('00000000-0000-4000-8000-00000000e005', '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-00000000a001', 'ready_for_release');
insert into public.result_test_requests (result_id, test_request_id) values
  ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000e004'),
  ('00000000-0000-4000-8000-00000000f003', '00000000-0000-4000-8000-00000000e005');
insert into public.audit_log (actor_type, action, resource_type, resource_id, created_at, metadata) values
  ('patient', 'result.downloaded', 'result', '00000000-0000-4000-8000-00000000f002', '2026-09-01T01:00:00Z',
   '{"test_request_id":"00000000-0000-4000-8000-00000000e004"}'),
  ('patient', 'result.downloaded', 'result', '00000000-0000-4000-8000-00000000f002', '2026-09-03T01:00:00Z',
   '{"test_request_id":"00000000-0000-4000-8000-00000000e004","test_request_ids":["00000000-0000-4000-8000-00000000e004"]}'),
  -- package row: resource_id is the HEADER test (here any non-result id)
  ('patient', 'result.downloaded', 'result', '00000000-0000-4000-8000-00000000e001', '2026-09-05T01:00:00Z',
   '{"kind":"package_consolidated","merged_component_ids":["00000000-0000-4000-8000-00000000e005"]}'),
  -- a STAFF row of the same action never counts
  ('staff', 'result.downloaded', 'result', '00000000-0000-4000-8000-00000000f003', '2026-09-20T01:00:00Z', '{}');

-- Re-run the migration's backfill statement verbatim.
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

do $$
begin
  if (select patient_last_downloaded_at from public.results where id = '00000000-0000-4000-8000-00000000f002')
       <> '2026-09-03T01:00:00Z'::timestamptz then
    raise exception 'B1: single-test backfill should take the LATEST patient download';
  end if;
  if (select patient_last_downloaded_at from public.results where id = '00000000-0000-4000-8000-00000000f003')
       <> '2026-09-05T01:00:00Z'::timestamptz then
    raise exception 'B2: package backfill should reach the component result (and ignore the staff row)';
  end if;
  if (select patient_last_downloaded_at from public.results where id = '00000000-0000-4000-8000-00000000f001') <> now() then
    raise exception 'B3: the backfill must never move a newer value back';
  end if;
  raise notice 'B backfill OK';
end $$;

-- ----- C. the remarks reader ------------------------------------------------------
create temp table smoke_ids on commit drop as
  select array['00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000e002',
               '00000000-0000-4000-8000-00000000e003']::uuid[] as ids;
grant select on smoke_ids to authenticated;

-- admin: one row per member of r1, named, reason trimmed.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
do $$
declare v_rows int; v_bad int;
begin
  select count(*), count(*) filter (where actor_name <> 'Smoke Admin' or reason <> 'wrong unit on glucose' or action <> 'result.amended')
    into v_rows, v_bad
    from public.result_amendment_remarks((select ids from smoke_ids));
  if v_rows <> 3 or v_bad <> 0 then
    raise exception 'C1: admin should see the edit on all 3 members, named, reason trimmed (rows=%, bad=%)', v_rows, v_bad;
  end if;
  raise notice 'C1 admin OK';
end $$;

-- reception: nothing (reasons are clinic-lab only).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a003","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.result_amendment_remarks((select ids from smoke_ids))) then
    raise exception 'C2: reception must see no edit remarks';
  end if;
  raise notice 'C2 reception OK';
end $$;

-- medtech: r1 carries an x-ray member → nothing.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.result_amendment_remarks((select ids from smoke_ids))) then
    raise exception 'C3: medtech must not see the edit of a report with an out-of-section member';
  end if;
  raise notice 'C3 medtech out-of-section OK';
end $$;

-- make r1 wholly chemistry: now the medtech sees it on both chemistry members.
reset role;
delete from public.result_test_requests
 where result_id = '00000000-0000-4000-8000-00000000f001'
   and test_request_id = '00000000-0000-4000-8000-00000000e003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
do $$
declare v_rows int;
begin
  select count(*) into v_rows from public.result_amendment_remarks((select ids from smoke_ids));
  if v_rows <> 2 then
    raise exception 'C4: medtech should see the edit on both chemistry members, got %', v_rows;
  end if;
  raise notice 'C4 medtech in-section OK';
end $$;

-- the writer stays closed to a signed-in JWT.
do $$
begin
  begin
    perform public.result_note_patient_download('[]'::jsonb);
    raise exception 'C5: authenticated could call the writer';
  exception when insufficient_privilege then
    raise notice 'C5 writer closed to authenticated OK';
  end;
end $$;

reset role;
rollback;

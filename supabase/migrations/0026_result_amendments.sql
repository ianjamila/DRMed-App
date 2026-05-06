-- =============================================================================
-- 0026_result_amendments.sql
-- =============================================================================
-- Result amendment history. When a released result needs to be corrected
-- (transcription error, re-run with revised value, etc.) the amendment
-- workflow snapshots the prior version into this append-only table and
-- replaces results.storage_path with the new file. Both the patient and
-- the original PDF stay queryable from this trail.
--
-- Lab-medicine standard: the original is never silently overwritten;
-- the amendment reason is mandatory.
-- =============================================================================

create table public.result_amendments (
  id                  uuid primary key default gen_random_uuid(),
  result_id           uuid not null references public.results(id) on delete cascade,
  test_request_id     uuid not null references public.test_requests(id) on delete cascade,
  -- Snapshot of the prior result row at the moment of amendment.
  prior_storage_path  text not null,
  prior_uploaded_by   uuid not null references auth.users(id),
  prior_uploaded_at   timestamptz not null,
  prior_file_size_bytes int,
  prior_notes         text,
  -- Reason is mandatory and audit-visible.
  reason              text not null,
  amended_by          uuid not null references auth.users(id),
  amended_at          timestamptz not null default now(),
  -- 1-based ordinal so successive amendments to the same result are
  -- ordered without relying on amended_at.
  amendment_seq       int not null,
  unique (result_id, amendment_seq)
);

create index idx_result_amendments_test_request
  on public.result_amendments(test_request_id, amended_at desc);
create index idx_result_amendments_result
  on public.result_amendments(result_id, amendment_seq desc);

alter table public.result_amendments enable row level security;

create policy "result_amendments: staff read"
  on public.result_amendments for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

create policy "result_amendments: medtech/pathologist/admin write"
  on public.result_amendments for insert to authenticated
  with check (public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician']));

-- Result rows now carry a denormalised flag so the queue/list pages can
-- show an "amended" badge without joining.
alter table public.results
  add column amended_at  timestamptz,
  add column amendment_count int not null default 0;

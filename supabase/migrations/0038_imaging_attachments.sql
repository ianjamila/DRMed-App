-- =============================================================================
-- 0038 — Imaging attachments for `imaging_report` result templates
-- =============================================================================
-- Adds a private storage bucket `result-images` and image_* columns on
-- public.results so medtechs can attach an ECG / X-ray / Ultrasound image
-- alongside the Findings + Impression text when finalising an imaging report.
--
-- All-or-nothing CHECK ensures the bookkeeping stays consistent: a row
-- either has every image_* field set or none. Reads/writes go through the
-- service-role client (same pattern as the existing `results` bucket), so
-- the bucket carries no per-row RLS policies.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Storage bucket: result-images
-- ---------------------------------------------------------------------------
-- Path convention: <patient_id>/<visit_id>/<test_request_id>.<ext>
-- The medtech UI accepts JPEG/PNG/WebP/PDF. HEIC/HEIF deliberately omitted
-- because @react-pdf/renderer can't embed them without a server-side
-- conversion step — keep the allowlist aligned with what we can actually
-- render in the patient-facing PDF.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'result-images',
  'result-images',
  false,
  26214400,                                                     -- 25 MB
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- results.image_* columns
-- ---------------------------------------------------------------------------
alter table public.results
  add column if not exists image_storage_path text,
  add column if not exists image_filename     text,
  add column if not exists image_mime_type    text,
  add column if not exists image_size_bytes   int,
  add column if not exists image_uploaded_at  timestamptz,
  add column if not exists image_uploaded_by  uuid references public.staff_profiles(id);

-- All-or-nothing: imaging metadata travels together so we never end up with
-- (path set, mime null) or other half-written states from a partial update.
alter table public.results
  drop constraint if exists results_image_fields_check;

alter table public.results
  add constraint results_image_fields_check check (
    (
      image_storage_path is null
      and image_filename     is null
      and image_mime_type    is null
      and image_size_bytes   is null
      and image_uploaded_at  is null
      and image_uploaded_by  is null
    )
    or (
      image_storage_path is not null
      and image_filename     is not null
      and image_mime_type    is not null
      and image_size_bytes   is not null
      and image_uploaded_at  is not null
      and image_uploaded_by  is not null
    )
  );

-- Partial index — only the imaging rows are interesting for lookups.
create index if not exists idx_results_has_image
  on public.results(image_storage_path)
  where image_storage_path is not null;

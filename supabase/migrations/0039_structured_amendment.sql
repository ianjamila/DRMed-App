-- =============================================================================
-- 0039 — Structured-result amendment snapshots
-- =============================================================================
-- Extends result_amendments so amending a structured result captures more
-- than just the prior PDF blob: we also snapshot the per-parameter values
-- (as JSONB) and the prior image attachment (for imaging_report layouts).
--
-- Convention: prior_values_json is populated only when the amendment came
-- from re-editing the structured form. PDF-only amendments (the existing
-- amendResultAction path, generation_kind = 'uploaded') leave it NULL.
-- Likewise prior_image_* are populated only when the prior result had an
-- imaging attachment on file.
-- =============================================================================

alter table public.result_amendments
  add column if not exists prior_values_json        jsonb,
  add column if not exists prior_image_storage_path text,
  add column if not exists prior_image_filename     text,
  add column if not exists prior_image_mime_type    text,
  add column if not exists prior_image_size_bytes   int;

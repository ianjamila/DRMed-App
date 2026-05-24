-- =============================================================================
-- 0052 — Private storage bucket `signatures` for staff signature PNGs
-- =============================================================================
-- Visit-consolidated reports (Phase 12.5) — D3: a private bucket that stores
-- per-staff signature images embedded into result PDFs at render time.
--
-- Path convention: <staff_profiles.id>/<content_hash>.png
--   e.g. 'cd59258f-.../a1b2c3d4e5f6.png'
--
-- Access model:
--   - The renderer (Server Action) reads via the service-role admin client.
--   - NO authenticated read or write. Signatures are forgeable artifacts;
--     they should never be served as signed URLs to the browser.
--   - The seed script uploads via the service-role client.
--
-- file_size_limit / allowed_mime_types: signatures are small PNGs.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'signatures',
  'signatures',
  false,
  524288,                          -- 512 KB cap; real signatures are ~10-100 KB
  array['image/png', 'image/jpeg']
)
on conflict (id) do nothing;

-- No `to authenticated` policies. Service-role bypasses RLS by design and
-- is the only path that should ever read or write this bucket.

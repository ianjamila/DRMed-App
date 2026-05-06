-- =============================================================================
-- 0017_physician_photos_bucket.sql
-- =============================================================================
-- Phase 9 follow-up: public bucket for physician roster photos. Public so
-- the marketing /physicians page can render <img src> directly without
-- signed URLs. 5 MB cap (a typical headshot is < 500 KB even unoptimized).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'physician-photos',
  'physician-photos',
  true,
  5242880, -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

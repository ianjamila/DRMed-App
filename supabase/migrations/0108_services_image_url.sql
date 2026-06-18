-- Per-service image for public listings (Google Merchant product feed +
-- Product JSON-LD). Nullable: when unset, the app falls back to the brand
-- default image. Site-relative path ("/photos/x.jpg") or absolute URL.
--
-- Additive, nullable column on an existing table — existing RLS policies on
-- `services` (table-level) already cover it; no new policy, audit row, or
-- payment-gating concern applies.

alter table public.services
  add column if not exists image_url text;

comment on column public.services.image_url is
  'Optional image for public listings (Merchant feed + Product JSON-LD). Site-relative path or absolute URL; falls back to the brand default when null.';

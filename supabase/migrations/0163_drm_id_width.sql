-- 0163_drm_id_width.sql
-- generate_drm_id() padded to a FIXED width of 4 with lpad, and Postgres lpad
-- truncates a longer string: lpad('10000', 4, '0') = '1000'. So the 10,000th
-- patient would have been given DRM-1000, which already exists, and every patient
-- insert after DRM-9999 would fail the drm_id unique constraint. Prod stood at
-- DRM-7275 on 2026-09-24.
--
-- Width is now greatest(4, length(n)): DRM-0001 … DRM-9999, DRM-10000, DRM-10001 …
-- nextval is called exactly once. IDs are never renumbered, reused or reseeded.
--
-- Same signature, so the existing ACL (PUBLIC/anon/authenticated/service_role
-- EXECUTE — it is a column default, and every inserting role needs it) survives
-- unchanged. create or replace REPLACES proconfig, so the search_path pin from
-- 0002 is restated here. Proof: supabase/tests/0163_drm_id_width_smoke.sql.

create or replace function public.generate_drm_id()
returns text
language sql
volatile
set search_path = public
as $$
  select 'DRM-' || lpad(s.n, greatest(4, length(s.n)), '0')
  from (select nextval('public.drm_id_seq')::text as n) s;
$$;

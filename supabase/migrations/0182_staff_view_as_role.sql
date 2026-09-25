-- =============================================================================
-- 0182_staff_view_as_role.sql
-- =============================================================================
-- Admin "View as role" — spec: docs/superpowers/specs/2026-09-25-staff-view-as-role-design.md
--
-- An admin may carry a temporary override on their OWN staff_profiles row.
-- The caller-identity helpers staff_role() and has_role() (0001) then answer
-- with the EFFECTIVE role: the override while the real role is admin and the
-- expiry is strictly in the future, the real role otherwise. is_staff() is
-- untouched (existence, not role). No policy or function reads
-- staff_profiles.role directly (verified 2026-09-25; 0167's actor check is
-- service-role-only and deliberately real-role), so these two bodies are the
-- whole database change. src/lib/auth/view-as.ts mirrors the CASE and
-- view-as-migration.test.ts pins the two together.
--
-- Deliberately NO constraint tying view_as_role to role = 'admin': another
-- admin demoting a currently-simulating admin must not fail. The CASE ignores
-- an override on a non-admin row, so a stale override is inert.
--
-- The columns are written only by the View-as server actions through the
-- service-role client: while simulating, has_role(array['admin']) is false,
-- so the "admin manage" policy would refuse the admin's own exit.

alter table public.staff_profiles
  add column if not exists view_as_role  text        null,
  add column if not exists view_as_until timestamptz null;

alter table public.staff_profiles
  drop constraint if exists staff_profiles_view_as_role_check,
  drop constraint if exists staff_profiles_view_as_pair_check;

alter table public.staff_profiles
  add constraint staff_profiles_view_as_role_check
    check (view_as_role is null
           or view_as_role in ('reception', 'medtech', 'xray_technician', 'pathologist')),
  add constraint staff_profiles_view_as_pair_check
    check ((view_as_role is null) = (view_as_until is null));

comment on column public.staff_profiles.view_as_role is
  'Admin testing override: the role the app and RLS treat this admin as until view_as_until. Inert unless role = admin. Written only by the View-as server actions (service role).';
comment on column public.staff_profiles.view_as_until is
  'Expiry of view_as_role. Active while strictly greater than now().';

-- Bodies only. Signature, STABLE, SECURITY DEFINER, search_path and ACLs are
-- unchanged — CREATE OR REPLACE keeps grants; asserted below regardless.
create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
           when role = 'admin' and view_as_until > now() then view_as_role
           else role
         end
  from public.staff_profiles
  where id = auth.uid() and is_active = true;
$$;

create or replace function public.has_role(roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_profiles
    where id = auth.uid()
      and is_active = true
      and (case
             when role = 'admin' and view_as_until > now() then view_as_role
             else role
           end) = any(roles)
  );
$$;

-- 0118 keeps anon + authenticated EXECUTE on the caller-identity predicates.
-- If either were lost, every policy that calls them would raise instead of
-- filter — so fail the migration loudly rather than ship a broken app.
do $$
begin
  if not has_function_privilege('anon', 'public.has_role(text[])', 'EXECUTE')
     or not has_function_privilege('anon', 'public.staff_role()', 'EXECUTE')
     or not has_function_privilege('anon', 'public.is_staff()', 'EXECUTE') then
    raise exception '0182: a caller-identity predicate lost anon EXECUTE';
  end if;
  if not has_function_privilege('authenticated', 'public.has_role(text[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.staff_role()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.is_staff()', 'EXECUTE') then
    raise exception '0182: a caller-identity predicate lost authenticated EXECUTE';
  end if;
end $$;

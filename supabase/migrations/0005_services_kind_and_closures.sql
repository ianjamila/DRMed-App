-- =============================================================================
-- 0005_services_kind_and_closures.sql
-- =============================================================================
-- Phase 6.5: split bookable services into Lab vs Doctor branches and gate the
-- public slot picker on admin-defined clinic closures (PH public holidays +
-- ad-hoc closures).
-- =============================================================================

-- Categorize services so the booking form can branch.
alter table public.services
  add column kind text not null default 'lab_test'
    check (kind in ('lab_test', 'lab_package', 'doctor_consultation'));

create index idx_services_kind on public.services(kind);

-- Clinic closures (PH public holidays + ad-hoc closures). The slot picker
-- reads this to grey out unavailable days. closed_on is YYYY-MM-DD in the
-- Asia/Manila timezone.
create table public.clinic_closures (
  closed_on   date primary key,
  reason      text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);

alter table public.clinic_closures enable row level security;

create policy "clinic_closures: public read"
  on public.clinic_closures for select to anon, authenticated using (true);

create policy "clinic_closures: admin manage"
  on public.clinic_closures for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

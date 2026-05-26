-- Migration 0068 — Dashboard card visibility preferences
--
-- Lets admin hide specific dashboard cards per staff role. Used for hiding
-- sensitive surfaces (e.g. revenue, payroll totals, PF accruals) from
-- non-admin dashboards.
--
-- Effective visibility: if a (role, card_id) row exists with visible=false,
-- the card is hidden AND its underlying query is skipped on the server.
-- No row = card is visible (default).

create table public.dashboard_card_prefs (
  role        text not null,
  card_id     text not null,
  visible     boolean not null,
  updated_by  uuid references public.staff_profiles(id),
  updated_at  timestamptz not null default now(),
  primary key (role, card_id),
  check (role in ('reception', 'medtech', 'xray_technician', 'pathologist', 'admin'))
);

create index idx_dashboard_card_prefs_role on public.dashboard_card_prefs(role);

alter table public.dashboard_card_prefs enable row level security;

-- Any authenticated staff member can READ the prefs for their own dashboard
-- to filter cards. Cross-role reads are also fine (the data is itself just
-- which-cards-are-hidden, not the sensitive content).
create policy "dashboard_card_prefs: staff read"
  on public.dashboard_card_prefs
  for select to authenticated
  using (public.is_staff());

-- Only admin can write.
create policy "dashboard_card_prefs: admin write"
  on public.dashboard_card_prefs
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create trigger trg_dashboard_card_prefs_updated_at
  before update on public.dashboard_card_prefs
  for each row execute function public.touch_updated_at();

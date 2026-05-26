-- =============================================================================
-- 0072_budgets.sql
-- =============================================================================
-- Variance / budget-vs-actual v1. One annual budget figure per
-- (fiscal_year, account_id). YTD-budget is derived as
--   annual_amount * (current_month / 12)
-- on the variance page so seasonal accounts (e.g. tax filing in Apr)
-- get coarsely-approximated YTD targets. Per-month overrides can come
-- in v2 if seasonality matters more.
-- =============================================================================

create table public.budgets (
  id                 uuid primary key default gen_random_uuid(),
  fiscal_year        int not null,
  account_id         uuid not null references public.chart_of_accounts(id),
  annual_amount_php  numeric(14,2) not null check (annual_amount_php >= 0),
  notes              text,
  created_by         uuid references public.staff_profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (fiscal_year, account_id)
);

create index idx_budgets_fiscal_year on public.budgets(fiscal_year);

create trigger trg_budgets_updated_at
  before update on public.budgets
  for each row execute function public.touch_updated_at();

alter table public.budgets enable row level security;

create policy "budgets: admin read"
  on public.budgets
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "budgets: admin write"
  on public.budgets
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

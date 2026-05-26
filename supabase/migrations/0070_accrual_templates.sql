-- =============================================================================
-- 0070_accrual_templates.sql
-- =============================================================================
-- Named recurring-accrual templates for 12.7.C. Admin defines a template
-- (name + lines) once; when an accrual is due they hit "Apply" which
-- pre-fills the manual-JE form with the saved lines. v1 is admin-driven —
-- no cron, no automatic apply; just a saved shape.
-- =============================================================================

create table public.accrual_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  frequency     text not null default 'monthly'
                  check (frequency in ('monthly', 'quarterly', 'annual', 'on_demand')),
  is_active     boolean not null default true,
  created_by    uuid references public.staff_profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index uq_accrual_templates_name_active
  on public.accrual_templates(lower(name))
  where is_active = true;

create trigger trg_accrual_templates_updated_at
  before update on public.accrual_templates
  for each row execute function public.touch_updated_at();

-- Per-line template entries. Mirrors journal_lines shape minus the entry_id.
-- The "exactly one of debit / credit" rule isn't enforced at the table level
-- because templates can be saved with zeros while admin is drafting; we
-- enforce it at the manual-JE form when applying.
create table public.accrual_template_lines (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references public.accrual_templates(id) on delete cascade,
  account_id    uuid not null references public.chart_of_accounts(id),
  debit_php     numeric(14,2) not null default 0 check (debit_php >= 0),
  credit_php    numeric(14,2) not null default 0 check (credit_php >= 0),
  description   text,
  line_order    int not null default 0
);

create index idx_accrual_template_lines_template
  on public.accrual_template_lines(template_id, line_order);

alter table public.accrual_templates       enable row level security;
alter table public.accrual_template_lines  enable row level security;

create policy "accrual_templates: admin read"
  on public.accrual_templates
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "accrual_templates: admin write"
  on public.accrual_templates
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "accrual_template_lines: admin read"
  on public.accrual_template_lines
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "accrual_template_lines: admin write"
  on public.accrual_template_lines
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

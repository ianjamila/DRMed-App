-- =============================================================================
-- 0071_bank_reconciliation.sql
-- =============================================================================
-- Bank reconciliation v1. Admin uploads a bank statement (CSV paste) for
-- one of the cash accounts (1010 / 1020 / 1021 / 1030), each transaction
-- becomes one bank_statement_lines row, then a server action auto-matches
-- each line to a posted journal_lines row on the same cash account by
-- amount + date proximity. Unmatched lines surface in the UI for manual
-- match or "post a JE for this" action.
-- =============================================================================

create table public.bank_statements (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.chart_of_accounts(id),
  period_start    date not null,
  period_end      date not null check (period_end >= period_start),
  statement_label text not null,                       -- e.g. "BPI — Sept 2026"
  raw_filename    text,
  uploaded_by     uuid not null references public.staff_profiles(id),
  uploaded_at     timestamptz not null default now(),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_bank_statements_account_period
  on public.bank_statements(account_id, period_start desc);

create trigger trg_bank_statements_updated_at
  before update on public.bank_statements
  for each row execute function public.touch_updated_at();

create table public.bank_statement_lines (
  id                  uuid primary key default gen_random_uuid(),
  statement_id        uuid not null references public.bank_statements(id) on delete cascade,
  transaction_date    date not null,
  description         text,
  reference           text,
  -- Signed amount: positive = inflow (debit to the cash account from the
  -- bank's perspective is a credit, but from OUR perspective receiving cash
  -- is a debit). Storing signed makes matching simpler.
  amount_php          numeric(14,2) not null,
  -- When matched, points to the journal_lines row this bank line settles.
  matched_je_line_id  uuid references public.journal_lines(id) on delete set null,
  matched_at          timestamptz,
  matched_by          uuid references public.staff_profiles(id),
  match_method        text check (match_method in (null, 'auto', 'manual')),
  created_at          timestamptz not null default now()
);

create index idx_bank_statement_lines_statement
  on public.bank_statement_lines(statement_id);

create index idx_bank_statement_lines_unmatched
  on public.bank_statement_lines(statement_id)
  where matched_je_line_id is null;

-- A single journal_lines row should only match one bank_statement_lines
-- row at a time. Partial unique index enforces this (allows many nulls).
create unique index uq_bank_statement_lines_matched_je
  on public.bank_statement_lines(matched_je_line_id)
  where matched_je_line_id is not null;

alter table public.bank_statements        enable row level security;
alter table public.bank_statement_lines   enable row level security;

create policy "bank_statements: admin read"
  on public.bank_statements
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "bank_statements: admin write"
  on public.bank_statements
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "bank_statement_lines: admin read"
  on public.bank_statement_lines
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "bank_statement_lines: admin write"
  on public.bank_statement_lines
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- =============================================================================
-- 0028_gl_foundation.sql
-- =============================================================================
-- Phase 12.1: Double-entry GL spine. Introduces chart of accounts, accounting
-- periods (monthly grain with quarterly close), journal entries + lines, year
-- counters for JE numbering, and the two invariant triggers (debits=credits,
-- period-lock). Nothing posts to the GL yet — 12.2 wires operational events.
--
-- Admin-only via RLS. Reception's flows are unchanged. CoA is admin-managed;
-- account codes are stable identifiers (renames change `name`, never `code`).
--
-- Seed: 108 monthly periods (Jan 2020 — Dec 2028, all `open`), year counters
-- for 2020–2028, and a single safety-net `9999 - Suspense` account.
-- =============================================================================

-- ---- Enums ------------------------------------------------------------------

create type public.account_type as enum (
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
  'contra_revenue',
  'contra_expense',
  'memo'
);

create type public.account_normal_balance as enum ('debit', 'credit');

create type public.period_status as enum ('open', 'closed');

create type public.je_status as enum ('draft', 'posted', 'reversed');

create type public.je_source_kind as enum (
  'manual',
  'payment',
  'test_request',
  'hmo_claim',
  'doctor_payout',
  'expense',
  'payroll_run',
  'opening_balance',
  'reversal'
);

-- ---- chart_of_accounts ------------------------------------------------------

create table public.chart_of_accounts (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null,
  name            text not null,
  type            public.account_type not null,
  parent_id       uuid references public.chart_of_accounts(id),
  normal_balance  public.account_normal_balance not null,
  is_active       boolean not null default true,
  description     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Normal balance must agree with type.
  constraint chart_of_accounts_normal_balance_matches_type check (
    (type in ('asset', 'expense', 'contra_revenue') and normal_balance = 'debit')
    or (type in ('liability', 'equity', 'revenue', 'contra_expense') and normal_balance = 'credit')
    or (type = 'memo')
  )
);

create index idx_chart_of_accounts_type on public.chart_of_accounts(type);
create index idx_chart_of_accounts_parent on public.chart_of_accounts(parent_id)
  where parent_id is not null;
create index idx_chart_of_accounts_active on public.chart_of_accounts(is_active)
  where is_active = true;

create trigger trg_chart_of_accounts_updated_at
  before update on public.chart_of_accounts
  for each row execute function public.touch_updated_at();

alter table public.chart_of_accounts enable row level security;

create policy "chart_of_accounts: admin read"
  on public.chart_of_accounts
  for select to authenticated
  using (public.has_role(array['admin']));

-- ---- accounting_periods -----------------------------------------------------

create table public.accounting_periods (
  id              uuid primary key default gen_random_uuid(),
  period_start    date not null,
  period_end      date not null,
  fiscal_year     int not null,
  fiscal_quarter  int not null check (fiscal_quarter between 1 and 4),
  fiscal_month    int not null check (fiscal_month between 1 and 12),
  status          public.period_status not null default 'open',
  closed_at       timestamptz,
  closed_by       uuid references public.staff_profiles(id),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (period_start, period_end),
  check (period_end > period_start),
  check (period_end - period_start <= 31)
);

create index idx_accounting_periods_dates
  on public.accounting_periods(period_start, period_end);

create index idx_accounting_periods_fy_fq
  on public.accounting_periods(fiscal_year, fiscal_quarter);

create trigger trg_accounting_periods_updated_at
  before update on public.accounting_periods
  for each row execute function public.touch_updated_at();

alter table public.accounting_periods enable row level security;

create policy "accounting_periods: admin read"
  on public.accounting_periods
  for select to authenticated
  using (public.has_role(array['admin']));

-- ---- je_year_counters -------------------------------------------------------
-- One row per fiscal year; je_next_number() locks and increments.

create table public.je_year_counters (
  fiscal_year int primary key,
  next_n      int not null default 1
);

alter table public.je_year_counters enable row level security;
-- No read/write policies — accessed exclusively by service-role from the
-- je_next_number() function. RLS denies everyone else by default.

-- ---- journal_entries --------------------------------------------------------

create table public.journal_entries (
  id            uuid primary key default gen_random_uuid(),
  entry_number  text unique not null,
  posting_date  date not null,
  description   text not null,
  status        public.je_status not null default 'draft',
  source_kind   public.je_source_kind not null,
  source_id     uuid,
  reverses      uuid references public.journal_entries(id),
  reversed_by   uuid references public.journal_entries(id),
  notes         text,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.staff_profiles(id),
  posted_at     timestamptz,
  posted_by     uuid references public.staff_profiles(id)
);

create index idx_journal_entries_posting_date
  on public.journal_entries(posting_date);
create index idx_journal_entries_status
  on public.journal_entries(status);
create index idx_journal_entries_source
  on public.journal_entries(source_kind, source_id)
  where source_id is not null;
create index idx_journal_entries_reverses
  on public.journal_entries(reverses)
  where reverses is not null;

-- ---- journal_lines ----------------------------------------------------------

create table public.journal_lines (
  id           uuid primary key default gen_random_uuid(),
  entry_id     uuid not null references public.journal_entries(id) on delete restrict,
  account_id   uuid not null references public.chart_of_accounts(id),
  debit_php    numeric(14,2) not null default 0,
  credit_php   numeric(14,2) not null default 0,
  description  text,
  line_order   int not null,
  check (debit_php >= 0),
  check (credit_php >= 0),
  check (debit_php = 0 or credit_php = 0),
  check (debit_php > 0 or credit_php > 0)
);

create index idx_journal_lines_entry on public.journal_lines(entry_id);
create index idx_journal_lines_account on public.journal_lines(account_id);

alter table public.journal_entries enable row level security;
alter table public.journal_lines    enable row level security;

create policy "journal_entries: admin read"
  on public.journal_entries
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "journal_lines: admin read"
  on public.journal_lines
  for select to authenticated
  using (public.has_role(array['admin']));

-- ---- Helper functions -------------------------------------------------------

-- Atomically gets and increments the per-year counter; returns 'JE-2026-0001'.
create or replace function public.je_next_number(p_fiscal_year int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next int;
begin
  insert into public.je_year_counters(fiscal_year, next_n)
    values (p_fiscal_year, 1)
    on conflict (fiscal_year) do nothing;

  update public.je_year_counters
    set next_n = next_n + 1
    where fiscal_year = p_fiscal_year
    returning next_n - 1 into v_next;

  return 'JE-' || p_fiscal_year::text || '-' || lpad(v_next::text, 4, '0');
end;
$$;

-- Returns 'open' / 'closed' / 'unknown' for a given posting date.
create or replace function public.period_status_for(p_date date)
returns text
language sql
stable
as $$
  select coalesce(
    (select status::text
       from public.accounting_periods
       where p_date between period_start and period_end
       limit 1),
    'unknown'
  );
$$;

create or replace function public.coa_account_has_open_period_postings(p_account_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.accounting_periods ap
      on je.posting_date between ap.period_start and ap.period_end
    where jl.account_id = p_account_id
      and je.status = 'posted'
      and ap.status = 'open'
  );
$$;

-- Auto-assigns JE-YYYY-NNNN when entry_number is null on insert.
create or replace function public.auto_assign_entry_number()
returns trigger
language plpgsql
as $$
begin
  if new.entry_number is null then
    new.entry_number := public.je_next_number(extract(year from new.posting_date)::int);
  end if;
  return new;
end;
$$;

create trigger trg_je_auto_assign_number
  before insert on public.journal_entries
  for each row execute function public.auto_assign_entry_number();

-- Rejects posted JEs whose posting_date falls in a closed period, EXCEPT
-- when the JE is itself a reversal posted to an open period (the entry
-- being reversed is allowed to live in a closed period).
create or replace function public.je_period_lock_check()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if new.status = 'posted' then
    v_status := public.period_status_for(new.posting_date);
    if v_status = 'closed' then
      raise exception 'Cannot post journal entry dated % — that period is closed.', new.posting_date
        using errcode = 'P0002';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_je_period_lock_check
  before insert or update on public.journal_entries
  for each row execute function public.je_period_lock_check();

-- Recomputes parent JE's sum(debit) vs sum(credit). On a posted entry,
-- mismatch raises P0001. Draft entries are exempt — accountants can save
-- in-progress drafts that don't balance.
create or replace function public.je_lines_balance_check()
returns trigger
language plpgsql
as $$
declare
  v_entry_id     uuid;
  v_status       public.je_status;
  v_number       text;
  v_total_debit  numeric(14,2);
  v_total_credit numeric(14,2);
begin
  v_entry_id := coalesce(new.entry_id, old.entry_id);

  select status, entry_number into v_status, v_number
    from public.journal_entries
    where id = v_entry_id;

  if v_status is null or v_status <> 'posted' then
    return coalesce(new, old);
  end if;

  select
    coalesce(sum(debit_php), 0),
    coalesce(sum(credit_php), 0)
    into v_total_debit, v_total_credit
    from public.journal_lines
    where entry_id = v_entry_id;

  if v_total_debit <> v_total_credit then
    raise exception
      'Journal entry % is unbalanced: debits ₱% vs credits ₱% (off by ₱%).',
      v_number, v_total_debit, v_total_credit, abs(v_total_debit - v_total_credit)
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger trg_je_lines_balance_check
  after insert or update or delete on public.journal_lines
  for each row execute function public.je_lines_balance_check();

-- Also fire on JE status change to 'posted' so we catch flipping draft→posted
-- with unbalanced lines.
create or replace function public.je_status_balance_check()
returns trigger
language plpgsql
as $$
declare
  v_total_debit  numeric(14,2);
  v_total_credit numeric(14,2);
begin
  if new.status = 'posted' and (old.status is distinct from 'posted') then
    select
      coalesce(sum(debit_php), 0),
      coalesce(sum(credit_php), 0)
      into v_total_debit, v_total_credit
      from public.journal_lines
      where entry_id = new.id;

    if v_total_debit <> v_total_credit then
      raise exception
        'Journal entry % cannot be posted: debits ₱% vs credits ₱% (off by ₱%).',
        new.entry_number, v_total_debit, v_total_credit, abs(v_total_debit - v_total_credit)
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_je_status_balance_check
  before update on public.journal_entries
  for each row execute function public.je_status_balance_check();

-- ---- Seed -------------------------------------------------------------------

-- 108 monthly periods: Jan 2020 — Dec 2028. Wider-than-needed range provides
-- margin for opening-balance JEs dated pre-2023 and avoids 'unknown period'
-- gaps for any plausible posting date.
insert into public.accounting_periods (
  period_start, period_end, fiscal_year, fiscal_quarter, fiscal_month, status
)
select
  d                              as period_start,
  (d + interval '1 month' - interval '1 day')::date as period_end,
  extract(year from d)::int      as fiscal_year,
  ((extract(month from d)::int - 1) / 3 + 1)::int  as fiscal_quarter,
  extract(month from d)::int     as fiscal_month,
  'open'
from generate_series(
  '2020-01-01'::date,
  '2028-12-01'::date,
  interval '1 month'
) as d;

-- One row per fiscal year so je_next_number can skip the cold-start insert.
insert into public.je_year_counters (fiscal_year, next_n)
select fy, 1 from generate_series(2020, 2028) as fy;

-- Single safety-net memo account. 12.2 posts here when an operational event
-- has no obvious CoA mapping and surfaces a flag to admin. Real CoA gets
-- populated by the user through the admin UI.
insert into public.chart_of_accounts (code, name, type, normal_balance, description)
values (
  '9999',
  'Suspense',
  'memo',
  'debit',
  'System safety-net account. 12.2 posts here when an operational event lacks a CoA mapping; admin must reclassify.'
);

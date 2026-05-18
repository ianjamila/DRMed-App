-- =============================================================================
-- 0043_eod_cash_reconciliation.sql
-- =============================================================================
-- Phase 12.C: Daily cash reconciliation. Adds reception-facing end-of-day
-- close workflow, cash adjustments subledger, staff-advance receivable
-- subledger, and the GL bridge that turns each cash movement into a
-- balanced JE through the same pattern as 0030 (draft → lines → posted).
--
-- After this migration:
--   * /staff/payments/cash-drawer logs petty cash, salary advances, courier
--     payouts, and float adjustments. Each fires a balanced JE in-transaction.
--   * /staff/payments/eod closes the day; non-zero variance posts a cash
--     short/over JE.
--   * Closed (date, shift) combos are DB-locked (P0015) until admin reopens.
--   * salary_advance payouts mirror into staff_advances; 12.6 (payroll) will
--     draw down outstanding balances via payslip deductions.
--   * /staff/admin/accounting/cash-routing manages the kind → CoA map.
--   * /staff/admin/reports/{daily-revenue,staff-advances} are read-only views.
--
-- NOTE: Existing partial unique index from 0030
--   journal_entries_one_posted_per_source
-- already covers the two new source_kind values; no index change needed.
-- =============================================================================

-- ---- Enum additions --------------------------------------------------------
-- Must run before any function/trigger that references these values.
-- IMPORTANT: ALTER TYPE … ADD VALUE inside a transaction does NOT make the
-- new enum value visible to later statements in that same transaction in
-- PG <12. Supabase runs PG 15+, where the value IS visible — verified by
-- 12.3's migration 0034 (which used the same pattern). If you back-port
-- this to a PG <12 environment, split into two migrations.
alter type public.je_source_kind add value if not exists 'cash_adjustment';
alter type public.je_source_kind add value if not exists 'eod_close';

-- ---- cash_shifts -----------------------------------------------------------
create table public.cash_shifts (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  label       text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_cash_shifts_updated_at
  before update on public.cash_shifts
  for each row execute function public.touch_updated_at();

alter table public.cash_shifts enable row level security;

create policy "cash_shifts: staff read"
  on public.cash_shifts
  for select to authenticated
  using (public.has_role(array['reception','admin']));

create policy "cash_shifts: admin write"
  on public.cash_shifts
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

insert into public.cash_shifts (code, label, sort_order)
values ('default', 'Default shift', 0)
on conflict (code) do nothing;

-- ---- accounting_settings (key-value) -----------------------------------------------
create table public.accounting_settings (
  id            uuid primary key default gen_random_uuid(),
  key           text unique not null check (key in ('default_change_fund_php')),
  value_text    text,
  value_php     numeric(14,2),
  value_jsonb   jsonb,
  description   text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.staff_profiles(id)
);

create trigger trg_accounting_settings_updated_at
  before update on public.accounting_settings
  for each row execute function public.touch_updated_at();

alter table public.accounting_settings enable row level security;

create policy "accounting_settings: admin all"
  on public.accounting_settings
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "accounting_settings: staff read"
  on public.accounting_settings
  for select to authenticated
  using (public.has_role(array['reception','admin']));

insert into public.accounting_settings (key, value_php, description)
values (
  'default_change_fund_php',
  2000.00,
  'Baseline cash drawer float at start of each business date. Adjust via eod_cash_adjustments float_topup/float_pullout.'
)
on conflict (key) do nothing;

-- ---- CoA additions ---------------------------------------------------------
-- Idempotent: existing rows in production are unchanged; missing rows in a
-- fresh local DB get inserted.
insert into public.chart_of_accounts (code, name, type, normal_balance, description) values
  ('1130', 'Staff Advances',     'asset',   'debit', 'Outstanding cash advances to employees. Reduced by payroll deductions in 12.6.'),
  ('6320', 'Courier',            'expense', 'debit', 'Courier and delivery costs (specimen transport, document delivery, etc.).'),
  ('6900', 'Cash Short / Over',  'expense', 'debit', 'Net daily till variances. Negative balance is acceptable (net overs).')
on conflict (code) do nothing;

-- ---- cash_adjustment_account_map -------------------------------------------
-- Mirrors payment_method_account_map from 0030. Admin manages via
-- /staff/admin/accounting/cash-routing.
create table public.cash_adjustment_account_map (
  id                     uuid primary key default gen_random_uuid(),
  kind                   text unique not null check (kind in (
    'petty_cash', 'salary_advance', 'courier', 'other_payout',
    'float_topup', 'float_pullout'
  )),
  account_id             uuid not null references public.chart_of_accounts(id),
  requires_user_choice   boolean not null default false,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger trg_cash_adjustment_account_map_updated_at
  before update on public.cash_adjustment_account_map
  for each row execute function public.touch_updated_at();

alter table public.cash_adjustment_account_map enable row level security;

create policy "cash_adjustment_account_map: admin read"
  on public.cash_adjustment_account_map
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "cash_adjustment_account_map: admin write"
  on public.cash_adjustment_account_map
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

insert into public.cash_adjustment_account_map (kind, account_id, requires_user_choice, notes)
values
  ('petty_cash',     public.coa_uuid_for_code('6400'), true,  'Default for petty cash; reception picks a more specific expense account when adding the row.'),
  ('salary_advance', public.coa_uuid_for_code('1130'), false, 'Always 1130 in v1; not user-overridable.'),
  ('courier',        public.coa_uuid_for_code('6320'), false, 'Dedicated courier expense; fixed mapping.'),
  ('other_payout',   public.coa_uuid_for_code('9999'), true,  'Falls back to Suspense with audit if reception skips contra picker.'),
  ('float_topup',    public.coa_uuid_for_code('1020'), true,  'Source of the cash (bank withdrawal, owner cap, etc.). Default BPI.'),
  ('float_pullout',  public.coa_uuid_for_code('1020'), true,  'Destination of the cash (bank deposit, owner drawing). Default BPI.')
on conflict (kind) do nothing;

-- ---- eod_cash_adjustments --------------------------------------------------
create table public.eod_cash_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  business_date       date not null,
  shift_id            uuid not null references public.cash_shifts(id),
  kind                text not null check (kind in (
    'petty_cash', 'salary_advance', 'courier', 'other_payout',
    'float_topup', 'float_pullout'
  )),
  amount_php          numeric(14,2) not null check (amount_php > 0),
  payee               text,
  payee_staff_id      uuid references public.staff_profiles(id),
  contra_account_id   uuid references public.chart_of_accounts(id),
  notes               text,
  recorded_by         uuid not null references public.staff_profiles(id),
  recorded_at         timestamptz not null default now(),
  voided_at           timestamptz,
  voided_by           uuid references public.staff_profiles(id),
  void_reason         text,
  constraint eod_cash_adjustments_salary_advance_has_staff
    check (kind != 'salary_advance' or payee_staff_id is not null),
  constraint eod_cash_adjustments_void_consistency
    check ((voided_at is null) = (voided_by is null))
);

create index idx_eod_cash_adjustments_date
  on public.eod_cash_adjustments (business_date, shift_id);

create index idx_eod_cash_adjustments_kind
  on public.eod_cash_adjustments (kind);

create index idx_eod_cash_adjustments_active
  on public.eod_cash_adjustments (business_date, shift_id)
  where voided_at is null;

create index idx_eod_cash_adjustments_staff
  on public.eod_cash_adjustments (payee_staff_id)
  where payee_staff_id is not null;

alter table public.eod_cash_adjustments enable row level security;

create policy "eod_cash_adjustments: staff read"
  on public.eod_cash_adjustments
  for select to authenticated
  using (public.has_role(array['reception','admin']));

create policy "eod_cash_adjustments: staff write"
  on public.eod_cash_adjustments
  for all to authenticated
  using (public.has_role(array['reception','admin']))
  with check (public.has_role(array['reception','admin']));

-- ---- eod_close_records -----------------------------------------------------
create table public.eod_close_records (
  id                    uuid primary key default gen_random_uuid(),
  business_date         date not null,
  shift_id              uuid not null references public.cash_shifts(id),
  status                text not null default 'closed'
                          check (status in ('closed', 'reopened')),
  opening_float_php     numeric(14,2) not null,
  cash_payments_php     numeric(14,2) not null,
  cash_payouts_php      numeric(14,2) not null,
  expected_cash_php     numeric(14,2) not null,
  counted_cash_php      numeric(14,2) not null check (counted_cash_php >= 0),
  variance_php          numeric(14,2) not null,
  variance_reason       text,
  closed_by             uuid not null references public.staff_profiles(id),
  closed_at             timestamptz not null default now(),
  reopened_by           uuid references public.staff_profiles(id),
  reopened_at           timestamptz,
  reopen_reason         text,
  created_at            timestamptz not null default now(),
  constraint eod_close_variance_matches
    check (variance_php = counted_cash_php - expected_cash_php),
  constraint eod_close_variance_reason_required
    check (variance_php = 0 or variance_reason is not null),
  constraint eod_close_reopen_reason_required
    check (status != 'reopened' or reopen_reason is not null)
);

-- One ACTIVE close per (business_date, shift_id). Reopened rows linger
-- for audit; a fresh re-close inserts a new row.
create unique index eod_close_records_one_active
  on public.eod_close_records (business_date, shift_id)
  where status = 'closed';

create index idx_eod_close_records_date
  on public.eod_close_records (business_date desc, shift_id);

alter table public.eod_close_records enable row level security;

create policy "eod_close_records: staff read"
  on public.eod_close_records
  for select to authenticated
  using (public.has_role(array['reception','admin']));

create policy "eod_close_records: staff insert"
  on public.eod_close_records
  for insert to authenticated
  with check (public.has_role(array['reception','admin']));

create policy "eod_close_records: admin update"
  on public.eod_close_records
  for update to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- ---- staff_advances --------------------------------------------------------
-- Receivable subledger maintained by the staff_advance_sync trigger.
-- Application code in 12.C never INSERTs here directly.
create table public.staff_advances (
  id                       uuid primary key default gen_random_uuid(),
  staff_id                 uuid not null references public.staff_profiles(id),
  source_adjustment_id     uuid unique not null references public.eod_cash_adjustments(id) on delete restrict,
  business_date            date not null,
  original_amount_php      numeric(14,2) not null check (original_amount_php > 0),
  outstanding_balance_php  numeric(14,2) not null check (outstanding_balance_php >= 0),
  status                   text not null default 'outstanding'
                             check (status in ('outstanding','settled','voided','written_off')),
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger trg_staff_advances_updated_at
  before update on public.staff_advances
  for each row execute function public.touch_updated_at();

create index idx_staff_advances_staff_outstanding
  on public.staff_advances (staff_id)
  where status = 'outstanding';

alter table public.staff_advances enable row level security;

create policy "staff_advances: admin all"
  on public.staff_advances
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "staff_advances: reception read"
  on public.staff_advances
  for select to authenticated
  using (public.has_role(array['reception','admin']));

-- ---- Helper: resolve_cash_adjustment_account -------------------------------
-- Resolves the non-cash side of a cash-adjustment JE.
-- If contra_account_id is provided, use it. Otherwise look up the kind's
-- default from cash_adjustment_account_map. If the map requires user choice
-- and we got here without a chosen account, fall back to 9999 Suspense.
create or replace function public.resolve_cash_adjustment_account(
  p_kind               text,
  p_contra_account_id  uuid
)
returns table (account_id uuid, used_suspense boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_map_account uuid;
  v_requires    boolean;
begin
  if p_contra_account_id is not null then
    return query select p_contra_account_id, false;
    return;
  end if;

  select cam.account_id, cam.requires_user_choice
    into v_map_account, v_requires
    from public.cash_adjustment_account_map cam
    where cam.kind = p_kind;

  if v_map_account is null then
    return query select public.coa_uuid_for_code('9999'), true;
    return;
  end if;

  if v_requires then
    -- User-choice required but skipped → suspense fallback.
    return query select public.coa_uuid_for_code('9999'), true;
    return;
  end if;

  return query select v_map_account, false;
end;
$$;

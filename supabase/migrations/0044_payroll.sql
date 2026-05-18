-- =============================================================================
-- 0044_payroll.sql
-- =============================================================================
-- Phase 12.6: Payroll, attendance, payslips. Adds employees + run lifecycle +
-- DTR ingest + leave management + OT slips + admin-editable contribution &
-- WT brackets, plus the GL bridge that turns each payroll event into balanced
-- JEs through the same pattern as 12.2 / 12.C (draft → lines → posted).
--
-- After this migration:
--   * /staff/admin/payroll/runs runs the semi-monthly payroll cycle:
--       draft → computed → finalised → (per-employee paid) → done
--       (or voided / reopened-voided)
--   * Finalise posts a gross-up JE; Dec 1-15 run posts a SECOND JE for the
--     annual 13th-month payout.
--   * Cash payouts route through eod_cash_adjustments (kind='salary_payout');
--     bank payouts post direct JEs.
--   * employee_leave_records is event-sourced: balance = SUM(days_delta)
--     where effective_date ≤ now AND (expiry IS NULL OR expiry > now).
--   * OT pay requires an approved payroll_ot_slip row (DTR overage alone
--     does NOT pay OT).
--   * Tardiness: ₱1.50/min + half-day deduction if ≥3 tardies/cutoff
--     (rates editable via accounting_settings).
--
-- NEW CoA codes (idempotent seed): 2350 13th-Month Payable, 2360 Salaries
-- Payable, 6121-6124 employer contribution sub-accounts.
-- =============================================================================

-- ---- Enum extensions ------------------------------------------------------
-- Required by later bridge functions. PG 15 allows in-transaction visibility.
alter type public.je_source_kind add value if not exists 'payroll_run';
alter type public.je_source_kind add value if not exists 'payroll_13th_month_payout';

-- Extend 12.C's eod_cash_adjustments.kind for cash payroll payouts.
alter table public.eod_cash_adjustments drop constraint eod_cash_adjustments_kind_check;
alter table public.eod_cash_adjustments add constraint eod_cash_adjustments_kind_check check (kind in (
  'petty_cash','salary_advance','courier','other_payout','float_topup','float_pullout','salary_payout'
));

-- ---- CoA additions --------------------------------------------------------
-- Split employer contributions into per-kind sub-accounts so the P&L can
-- trace each statutory cost separately (cleaner than lumping into 6120).
insert into public.chart_of_accounts (code, name, type, normal_balance, description) values
  ('2350', '13th-Month Payable',                'liability', 'credit', 'Monthly accrual of 13th-month pay; paid out in December Run #1.'),
  ('2360', 'Salaries Payable',                  'liability', 'credit', 'Net pay owed to employees between run finalisation and actual payout.'),
  ('6121', 'Employer SSS Contribution',         'expense',   'debit',  'Employer share of SSS (split from 6120 Benefits for tracing).'),
  ('6122', 'Employer PhilHealth Contribution',  'expense',   'debit',  'Employer share of PhilHealth.'),
  ('6123', 'Employer Pag-IBIG Contribution',    'expense',   'debit',  'Employer share of Pag-IBIG.'),
  ('6124', '13th-Month Pay Expense',            'expense',   'debit',  'Monthly accrual recognised as expense; paired with 2350 13th-Month Payable.')
on conflict (code) do nothing;

-- ---- employees ------------------------------------------------------------
create table public.employees (
  id                            uuid primary key default gen_random_uuid(),
  staff_profile_id              uuid unique not null references public.staff_profiles(id) on delete restrict,
  employee_number               text unique,
  hire_date                     date not null,
  regularization_date           date,
  termination_date              date,
  civil_status                  text check (civil_status in ('single','married','widowed','separated','divorced')),
  basic_daily_rate_php          numeric(10,2) not null check (basic_daily_rate_php > 0),
  monthly_salary_credit_php     numeric(10,2) not null check (monthly_salary_credit_php > 0),
  schedule_kind                 text not null check (schedule_kind in
                                  ('fixed_5day_mon_fri','fixed_6day_mon_sat','shifting_5of6_mon_sat')),
  rest_days                     int[],
  dtr_external_id               text,
  payment_method                text not null default 'cash' check (payment_method in ('cash','bank')),
  bank_name                     text,
  bank_account_number           text,
  bank_account_holder_name      text,
  sss_number                    text,
  philhealth_number             text,
  pagibig_number                text,
  tin                           text,
  tax_status                    text not null default 'standard' check (tax_status in ('standard','minimum_wage_earner')),
  is_active                     boolean not null default true,
  notes                         text,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
create trigger trg_employees_updated_at before update on public.employees
  for each row execute function public.touch_updated_at();
alter table public.employees enable row level security;
create policy "employees: admin all" on public.employees for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));
create policy "employees: self read" on public.employees for select to authenticated
  using (staff_profile_id = auth.uid());

-- ---- employee_allowances --------------------------------------------------
create table public.employee_allowances (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees(id) on delete cascade,
  name                text not null,
  daily_amount_php    numeric(10,2) not null check (daily_amount_php >= 0),
  is_taxable          boolean not null default true,
  effective_from      date not null,
  effective_to        date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint employee_allowances_no_overlap_per_name
    exclude using gist (
      employee_id with =,
      name with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[)') with &&
    )
);
create trigger trg_employee_allowances_updated_at before update on public.employee_allowances
  for each row execute function public.touch_updated_at();
alter table public.employee_allowances enable row level security;
create policy "employee_allowances: admin all" on public.employee_allowances for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

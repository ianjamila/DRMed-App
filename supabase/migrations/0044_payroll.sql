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

-- ---- payroll_periods ------------------------------------------------------
create table public.payroll_periods (
  id                  uuid primary key default gen_random_uuid(),
  period_start        date not null,
  period_end          date not null,
  pay_date            date not null,
  status              text not null default 'open' check (status in ('open','closed')),
  created_at          timestamptz not null default now(),
  closed_at           timestamptz,
  closed_by           uuid references public.staff_profiles(id),
  constraint payroll_periods_dates_consistent check (period_end >= period_start and pay_date >= period_end)
);
create unique index payroll_periods_unique_range on public.payroll_periods (period_start, period_end);
alter table public.payroll_periods enable row level security;
create policy "payroll_periods: admin all" on public.payroll_periods for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- ---- payroll_runs ---------------------------------------------------------
create table public.payroll_runs (
  id                  uuid primary key default gen_random_uuid(),
  period_id           uuid unique not null references public.payroll_periods(id),
  status              text not null default 'draft'
                        check (status in ('draft','computed','finalised','voided')),
  computed_at         timestamptz,
  finalised_at        timestamptz,
  finalised_by        uuid references public.staff_profiles(id),
  voided_at           timestamptz,
  voided_by           uuid references public.staff_profiles(id),
  void_reason         text,
  gross_up_je_id      uuid references public.journal_entries(id),
  thirteenth_payout_je_id uuid references public.journal_entries(id),
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payroll_runs_void_consistency check (
    (voided_at is null and voided_by is null and void_reason is null) or
    (voided_at is not null and voided_by is not null and void_reason is not null and status = 'voided')
  )
);
create trigger trg_payroll_runs_updated_at before update on public.payroll_runs
  for each row execute function public.touch_updated_at();
alter table public.payroll_runs enable row level security;
create policy "payroll_runs: admin all" on public.payroll_runs for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- ---- payroll_employee_runs ------------------------------------------------
create table public.payroll_employee_runs (
  id                              uuid primary key default gen_random_uuid(),
  run_id                          uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id                     uuid not null references public.employees(id),
  -- Attendance summary
  scheduled_days                  int not null default 0,
  days_present                    int not null default 0,
  days_unpaid_absent              int not null default 0,
  days_vl_used                    int not null default 0,
  days_sl_used                    int not null default 0,
  days_regular_holiday_worked     int not null default 0,
  days_regular_holiday_unworked   int not null default 0,
  days_special_holiday_worked     int not null default 0,
  days_special_holiday_unworked   int not null default 0,
  minutes_late_total              int not null default 0,
  tardiness_count                 int not null default 0,
  missing_punch_days              int not null default 0,
  ot_overage_unpaid_minutes_total int not null default 0,
  -- Earnings (currency)
  basic_pay_php                   numeric(12,2) not null default 0,
  allowances_total_php            numeric(12,2) not null default 0,
  ot_pay_php                      numeric(12,2) not null default 0,
  night_diff_pay_php              numeric(12,2) not null default 0,
  holiday_pay_php                 numeric(12,2) not null default 0,
  incentives_total_php            numeric(12,2) not null default 0,
  perfect_attendance_bonus_php    numeric(12,2) not null default 0,
  thirteenth_month_accrual_php    numeric(12,2) not null default 0,
  thirteenth_month_payout_php     numeric(12,2) not null default 0,
  gross_pay_php                   numeric(12,2) not null default 0,
  -- Deductions (currency)
  sss_ee_php                      numeric(12,2) not null default 0,
  sss_er_php                      numeric(12,2) not null default 0,
  philhealth_ee_php               numeric(12,2) not null default 0,
  philhealth_er_php               numeric(12,2) not null default 0,
  pagibig_ee_php                  numeric(12,2) not null default 0,
  pagibig_er_php                  numeric(12,2) not null default 0,
  wt_compensation_php             numeric(12,2) not null default 0,
  tardiness_deduction_php         numeric(12,2) not null default 0,
  staff_advance_settlement_php    numeric(12,2) not null default 0,
  other_deductions_total_php      numeric(12,2) not null default 0,
  -- Final
  net_pay_php                     numeric(12,2) not null default 0,
  -- Payout
  payment_method_used             text check (payment_method_used in ('cash','bank')),
  payout_status                   text not null default 'pending'
                                    check (payout_status in ('pending','paid','voided')),
  paid_at                         timestamptz,
  paid_by                         uuid references public.staff_profiles(id),
  payout_je_id                    uuid references public.journal_entries(id),
  payout_cash_adjustment_id       uuid references public.eod_cash_adjustments(id),
  payslip_file_path               text,
  payslip_generated_at            timestamptz,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint payroll_employee_runs_unique_per_run unique (run_id, employee_id),
  constraint payroll_employee_runs_net_nonneg check (net_pay_php >= 0)
);
create trigger trg_payroll_employee_runs_updated_at before update on public.payroll_employee_runs
  for each row execute function public.touch_updated_at();
create index idx_payroll_employee_runs_employee on public.payroll_employee_runs (employee_id, run_id);
create index idx_payroll_employee_runs_payout_pending on public.payroll_employee_runs (run_id)
  where payout_status = 'pending';
alter table public.payroll_employee_runs enable row level security;
create policy "payroll_employee_runs: admin all" on public.payroll_employee_runs for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));
create policy "payroll_employee_runs: self read" on public.payroll_employee_runs for select to authenticated
  using (employee_id in (select id from public.employees where staff_profile_id = auth.uid()));

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

-- Extend 12.C's cash_adjustment_account_map.kind alongside eod_cash_adjustments.kind
-- so Task 19 below can register the salary_payout routing row.
alter table public.cash_adjustment_account_map drop constraint cash_adjustment_account_map_kind_check;
alter table public.cash_adjustment_account_map add constraint cash_adjustment_account_map_kind_check check (kind in (
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

-- Required for the exclusion constraint below (uuid/text equality inside gist).
create extension if not exists btree_gist;

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

-- ---- payroll_earning_lines ------------------------------------------------
create table public.payroll_earning_lines (
  id                  uuid primary key default gen_random_uuid(),
  employee_run_id     uuid not null references public.payroll_employee_runs(id) on delete cascade,
  kind                text not null check (kind in ('incentive','one_time_bonus','manual_adjustment','ot_supplement')),
  label               text not null,
  quantity            numeric(10,2),
  rate_php            numeric(10,2),
  amount_php          numeric(12,2) not null,
  ref_id              uuid,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.staff_profiles(id),
  constraint payroll_earning_lines_consistency check (
    (quantity is null and rate_php is null) or
    (quantity is not null and rate_php is not null and amount_php = round(quantity * rate_php, 2))
  )
);
alter table public.payroll_earning_lines enable row level security;
create policy "payroll_earning_lines: admin all" on public.payroll_earning_lines for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));
create policy "payroll_earning_lines: self read" on public.payroll_earning_lines for select to authenticated
  using (employee_run_id in (select id from public.payroll_employee_runs per
    join public.employees e on e.id = per.employee_id where e.staff_profile_id = auth.uid()));

-- ---- employee_loans -------------------------------------------------------
create table public.employee_loans (
  id                          uuid primary key default gen_random_uuid(),
  employee_id                 uuid not null references public.employees(id),
  principal_php               numeric(12,2) not null check (principal_php > 0),
  amortization_per_period_php numeric(12,2) not null check (amortization_per_period_php > 0),
  start_period_id             uuid references public.payroll_periods(id),
  outstanding_balance_php     numeric(12,2) not null,
  status                      text not null default 'requested'
                                check (status in ('requested','approved','active','paid_off','written_off','voided')),
  requested_at                timestamptz not null default now(),
  requested_by                uuid references public.staff_profiles(id),
  approved_at                 timestamptz,
  approved_by                 uuid references public.staff_profiles(id),
  approval_notes              text,
  disbursed_at                timestamptz,
  disbursed_by                uuid references public.staff_profiles(id),
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint employee_loans_state_consistency check (
    (status = 'requested'  and approved_at is null and disbursed_at is null) or
    (status = 'approved'   and approved_at is not null and disbursed_at is null) or
    (status in ('active','paid_off','written_off') and approved_at is not null and disbursed_at is not null) or
    (status = 'voided')
  )
);
create trigger trg_employee_loans_updated_at before update on public.employee_loans
  for each row execute function public.touch_updated_at();
create index idx_employee_loans_active on public.employee_loans (employee_id) where status = 'active';
alter table public.employee_loans enable row level security;
create policy "employee_loans: admin all" on public.employee_loans for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- ---- payroll_deduction_lines ----------------------------------------------
create table public.payroll_deduction_lines (
  id                  uuid primary key default gen_random_uuid(),
  employee_run_id     uuid not null references public.payroll_employee_runs(id) on delete cascade,
  kind                text not null check (kind in ('loan_amortization','manual_adjustment','other')),
  label               text not null,
  amount_php          numeric(12,2) not null check (amount_php >= 0),
  loan_id             uuid references public.employee_loans(id),
  created_at          timestamptz not null default now(),
  created_by          uuid references public.staff_profiles(id)
);
alter table public.payroll_deduction_lines enable row level security;
create policy "payroll_deduction_lines: admin all" on public.payroll_deduction_lines for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));
create policy "payroll_deduction_lines: self read" on public.payroll_deduction_lines for select to authenticated
  using (employee_run_id in (select id from public.payroll_employee_runs per
    join public.employees e on e.id = per.employee_id where e.staff_profile_id = auth.uid()));

-- ---- payroll_ot_slips -----------------------------------------------------
create table public.payroll_ot_slips (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees(id),
  work_date           date not null,
  hours_requested     numeric(5,2) not null check (hours_requested > 0),
  reason              text,
  status              text not null default 'pending' check (status in ('pending','approved','rejected','voided')),
  requested_at        timestamptz not null default now(),
  decided_at          timestamptz,
  decided_by          uuid references public.staff_profiles(id),
  decision_notes      text,
  constraint payroll_ot_slips_unique_per_day unique (employee_id, work_date)
);
alter table public.payroll_ot_slips enable row level security;
create policy "payroll_ot_slips: admin all" on public.payroll_ot_slips for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));
create policy "payroll_ot_slips: self read" on public.payroll_ot_slips for select to authenticated
  using (employee_id in (select id from public.employees where staff_profile_id = auth.uid()));

-- ---- payroll_dtr_imports --------------------------------------------------
create table public.payroll_dtr_imports (
  id                  uuid primary key default gen_random_uuid(),
  period_id           uuid not null references public.payroll_periods(id),
  uploaded_at         timestamptz not null default now(),
  uploaded_by         uuid not null references public.staff_profiles(id),
  filename            text,
  raw_csv_text        text not null,
  parsed_rows_count   int not null,
  parse_errors        jsonb,
  notes               text
);
alter table public.payroll_dtr_imports enable row level security;
create policy "payroll_dtr_imports: admin all" on public.payroll_dtr_imports for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- ---- payroll_dtr_rows -----------------------------------------------------
create table public.payroll_dtr_rows (
  id                  uuid primary key default gen_random_uuid(),
  import_id           uuid not null references public.payroll_dtr_imports(id) on delete cascade,
  employee_id         uuid references public.employees(id),
  external_id_raw     text not null,
  work_date           date not null,
  time_in             timestamptz,
  time_out            timestamptz,
  total_hours         numeric(5,2),
  status              text not null default 'parsed'
                        check (status in ('parsed','flagged_no_employee','flagged_missing_punch','superseded')),
  source_row          jsonb not null,
  notes               text
);
create index idx_payroll_dtr_rows_employee_date on public.payroll_dtr_rows (employee_id, work_date);
create index idx_payroll_dtr_rows_status on public.payroll_dtr_rows (status) where status <> 'parsed';
alter table public.payroll_dtr_rows enable row level security;
create policy "payroll_dtr_rows: admin all" on public.payroll_dtr_rows for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- ---- payroll_holidays -----------------------------------------------------
create table public.payroll_holidays (
  id                  uuid primary key default gen_random_uuid(),
  date                date not null,
  kind                text not null check (kind in ('regular','special_non_working','special_working')),
  name                text not null,
  is_active           boolean not null default true,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payroll_holidays_unique_per_date_kind unique (date, kind)
);
create trigger trg_payroll_holidays_updated_at before update on public.payroll_holidays
  for each row execute function public.touch_updated_at();
alter table public.payroll_holidays enable row level security;
create policy "payroll_holidays: admin read" on public.payroll_holidays for select to authenticated
  using (public.has_role(array['admin']));
create policy "payroll_holidays: admin write" on public.payroll_holidays for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- ---- payroll_contribution_brackets ----------------------------------------
create table public.payroll_contribution_brackets (
  id                              uuid primary key default gen_random_uuid(),
  kind                            text not null check (kind in ('sss','philhealth','pagibig')),
  effective_from                  date not null,
  effective_to                    date,
  monthly_salary_credit_min_php   numeric(12,2) not null,
  monthly_salary_credit_max_php   numeric(12,2) not null,
  employee_share_php              numeric(10,2) not null,
  employer_share_php              numeric(10,2) not null,
  notes                           text,
  created_at                      timestamptz not null default now()
);
create index idx_payroll_contribution_brackets_lookup
  on public.payroll_contribution_brackets (kind, effective_from, effective_to);
alter table public.payroll_contribution_brackets enable row level security;
create policy "payroll_contribution_brackets: admin all" on public.payroll_contribution_brackets for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- ---- payroll_wt_brackets --------------------------------------------------
create table public.payroll_wt_brackets (
  id                  uuid primary key default gen_random_uuid(),
  effective_from      date not null,
  effective_to        date,
  taxable_min_php     numeric(12,2) not null,
  taxable_max_php     numeric(12,2),
  base_tax_php        numeric(12,2) not null,
  marginal_rate       numeric(5,4) not null,
  notes               text
);
create index idx_payroll_wt_brackets_lookup on public.payroll_wt_brackets (effective_from, taxable_min_php);
alter table public.payroll_wt_brackets enable row level security;
create policy "payroll_wt_brackets: admin all" on public.payroll_wt_brackets for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- ---- employee_leave_records (event-sourced) -------------------------------
create table public.employee_leave_records (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees(id),
  kind                text not null check (kind in ('VL','SL')),
  record_kind         text not null check (record_kind in
                        ('entitlement','manual_grant','usage','expiry','cash_conversion')),
  days_delta          numeric(5,2) not null,
  effective_date      date not null,
  expiry_date         date,
  period_id           uuid references public.payroll_periods(id),
  reason              text,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.staff_profiles(id),
  constraint employee_leave_records_delta_sign check (
    (record_kind in ('entitlement','manual_grant') and days_delta > 0) or
    (record_kind in ('usage','expiry','cash_conversion') and days_delta <= 0)
  )
);
create index idx_employee_leave_records_balance on public.employee_leave_records (employee_id, kind, effective_date, expiry_date);
alter table public.employee_leave_records enable row level security;
create policy "employee_leave_records: admin all" on public.employee_leave_records for all to authenticated
  using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));
create policy "employee_leave_records: self read" on public.employee_leave_records for select to authenticated
  using (employee_id in (select id from public.employees where staff_profile_id = auth.uid()));

-- ---- FK indexes (filter/join helpers) -----------------------------------
create index idx_payroll_earning_lines_employee_run on public.payroll_earning_lines (employee_run_id);
create index idx_payroll_deduction_lines_employee_run on public.payroll_deduction_lines (employee_run_id);
create index idx_payroll_deduction_lines_loan on public.payroll_deduction_lines (loan_id) where loan_id is not null;
create index idx_payroll_dtr_rows_import on public.payroll_dtr_rows (import_id);
create index idx_payroll_dtr_imports_period on public.payroll_dtr_imports (period_id);

-- ---- cash_adjustment_account_map: salary_payout ---------------------------
insert into public.cash_adjustment_account_map (kind, account_id, requires_user_choice, notes)
values ('salary_payout', public.coa_uuid_for_code('2360'), false,
  'Per-employee cash payout from /cash-drawer on payroll pay date. Routes to Salaries Payable.')
on conflict (kind) do nothing;

-- ---- accounting_settings extensions ---------------------------------------
alter table public.accounting_settings drop constraint accounting_settings_key_check;
alter table public.accounting_settings add constraint accounting_settings_key_check check (key in (
  'default_change_fund_php',
  'tardiness_per_minute_php',
  'tardiness_threshold_for_halfday_deduction',
  'perfect_attendance_bonus_php',
  'standard_workday_minutes',
  'scheduled_start_hour',
  'scheduled_start_minute',
  'scheduled_end_hour',
  'scheduled_end_minute',
  'lunch_break_minutes',
  'night_diff_premium_rate',
  'night_diff_start_hour',
  'night_diff_end_hour',
  'ot_rate_regular_day',
  'ot_rate_rest_day',
  'holiday_pay_regular_worked',
  'holiday_pay_regular_unworked',
  'holiday_pay_special_worked',
  'holiday_pay_special_unworked',
  'staff_advance_settlement_max_pct'
));

insert into public.accounting_settings (key, value_php, description) values
  ('tardiness_per_minute_php', 1.50, 'Salary deduction per minute of tardiness.'),
  ('tardiness_threshold_for_halfday_deduction', 3, 'Tardiness instances per cutoff that trigger an additional half-day deduction.'),
  ('perfect_attendance_bonus_php', 1000, 'Bonus per cutoff for zero tardiness, zero absences, no missing punches.'),
  ('standard_workday_minutes', 480, 'Paid hours per standard workday (8h).'),
  ('scheduled_start_hour', 8, 'Default scheduled start time hour (24h, Asia/Manila).'),
  ('scheduled_start_minute', 0, ''),
  ('scheduled_end_hour', 17, 'Default scheduled end time hour.'),
  ('scheduled_end_minute', 0, ''),
  ('lunch_break_minutes', 60, 'Unpaid lunch break.'),
  ('night_diff_premium_rate', 0.10, 'Premium multiplier for ND-eligible hours.'),
  ('night_diff_start_hour', 22, 'ND window start (22:00).'),
  ('night_diff_end_hour', 6, 'ND window end (06:00 next day).'),
  ('ot_rate_regular_day', 1.25, 'OT premium on a regular work day.'),
  ('ot_rate_rest_day', 1.30, 'Base premium on a rest day; combine with OT multiplier as needed.'),
  ('holiday_pay_regular_worked', 2.00, ''),
  ('holiday_pay_regular_unworked', 1.00, ''),
  ('holiday_pay_special_worked', 1.30, ''),
  ('holiday_pay_special_unworked', 0.00, ''),
  ('staff_advance_settlement_max_pct', 0.50, 'Cap on staff_advance settlement per cutoff, as fraction of post-statutory net.')
on conflict (key) do nothing;

-- ---- PH official holidays — 2026 calendar year ----------------------------
insert into public.payroll_holidays (date, kind, name) values
  -- Regular holidays
  ('2026-01-01', 'regular',             'New Year''s Day'),
  ('2026-04-02', 'regular',             'Maundy Thursday'),
  ('2026-04-03', 'regular',             'Good Friday'),
  ('2026-04-09', 'regular',             'Araw ng Kagitingan'),
  ('2026-05-01', 'regular',             'Labor Day'),
  ('2026-06-12', 'regular',             'Independence Day'),
  ('2026-08-31', 'regular',             'National Heroes Day'),
  ('2026-11-30', 'regular',             'Bonifacio Day'),
  ('2026-12-25', 'regular',             'Christmas Day'),
  ('2026-12-30', 'regular',             'Rizal Day'),
  -- Special non-working
  ('2026-02-25', 'special_non_working', 'EDSA Revolution Anniversary'),
  ('2026-04-04', 'special_non_working', 'Black Saturday'),
  ('2026-08-21', 'special_non_working', 'Ninoy Aquino Day'),
  ('2026-11-01', 'special_non_working', 'All Saints'' Day'),
  ('2026-11-02', 'special_non_working', 'All Souls'' Day'),
  ('2026-12-08', 'special_non_working', 'Feast of the Immaculate Conception'),
  ('2026-12-24', 'special_non_working', 'Christmas Eve'),
  ('2026-12-31', 'special_non_working', 'New Year''s Eve')
on conflict (date, kind) do nothing;

-- ---- SSS contribution brackets — effective 2026-01-01 ---------------------
-- Source: SSS Schedule of Contributions, 2026 update.
-- Each row = one monthly_salary_credit band.
-- Employee + Employer columns are per-month (split ½ per semi-monthly cutoff in compute).
insert into public.payroll_contribution_brackets (kind, effective_from, monthly_salary_credit_min_php, monthly_salary_credit_max_php, employee_share_php, employer_share_php, notes) values
  ('sss', '2026-01-01',     4250,     4750,   202.50,   435.00, 'Monthly basic ₱4,250-4,749'),
  ('sss', '2026-01-01',     4750,     5250,   225.00,   485.00, ''),
  ('sss', '2026-01-01',     5250,     5750,   247.50,   535.00, ''),
  ('sss', '2026-01-01',     5750,     6250,   270.00,   585.00, ''),
  ('sss', '2026-01-01',     6250,     6750,   292.50,   635.00, ''),
  ('sss', '2026-01-01',     6750,     7250,   315.00,   685.00, ''),
  ('sss', '2026-01-01',     7250,     7750,   337.50,   735.00, ''),
  ('sss', '2026-01-01',     7750,     8250,   360.00,   785.00, ''),
  ('sss', '2026-01-01',     8250,     8750,   382.50,   835.00, ''),
  ('sss', '2026-01-01',     8750,     9250,   405.00,   885.00, ''),
  ('sss', '2026-01-01',     9250,     9750,   427.50,   935.00, ''),
  ('sss', '2026-01-01',     9750,    10250,   450.00,   985.00, ''),
  ('sss', '2026-01-01',    10250,    10750,   472.50,  1035.00, ''),
  ('sss', '2026-01-01',    10750,    11250,   495.00,  1085.00, ''),
  ('sss', '2026-01-01',    11250,    11750,   517.50,  1135.00, ''),
  ('sss', '2026-01-01',    11750,    12250,   540.00,  1185.00, ''),
  ('sss', '2026-01-01',    12250,    12750,   562.50,  1235.00, ''),
  ('sss', '2026-01-01',    12750,    13250,   585.00,  1285.00, ''),
  ('sss', '2026-01-01',    13250,    13750,   607.50,  1335.00, ''),
  ('sss', '2026-01-01',    13750,    14250,   630.00,  1385.00, ''),
  ('sss', '2026-01-01',    14250,    14750,   652.50,  1435.00, ''),
  ('sss', '2026-01-01',    14750,    15250,   675.00,  1485.00, ''),
  ('sss', '2026-01-01',    15250,    15750,   697.50,  1535.00, ''),
  ('sss', '2026-01-01',    15750,    16250,   720.00,  1585.00, ''),
  ('sss', '2026-01-01',    16250,    19999.99, 765.00, 1685.00, 'Upper-band approximation; consult current SSS table'),
  ('sss', '2026-01-01',    20000,    99999.99, 900.00, 1900.00, 'Maximum MSC band');

-- ---- PhilHealth premium brackets — effective 2026-01-01 -------------------
-- 5% premium rate (split equally EE/ER). MSC floor ₱10k, ceiling ₱100k.
-- Bands here are ₱500-step "bands of convenience" for daily-rate employees;
-- spec treats them as lookup rows even though PhilHealth's actual formula is
-- continuous percentage-based.
insert into public.payroll_contribution_brackets (kind, effective_from, monthly_salary_credit_min_php, monthly_salary_credit_max_php, employee_share_php, employer_share_php, notes) values
  ('philhealth', '2026-01-01',      0,    10000,  250.00,  250.00, 'Min MSC floor at ₱10k'),
  ('philhealth', '2026-01-01',  10000,    20000,  500.00,  500.00, ''),
  ('philhealth', '2026-01-01',  20000,    30000,  750.00,  750.00, ''),
  ('philhealth', '2026-01-01',  30000,    40000, 1000.00, 1000.00, ''),
  ('philhealth', '2026-01-01',  40000,    50000, 1250.00, 1250.00, ''),
  ('philhealth', '2026-01-01',  50000,   100000, 1500.00, 1500.00, ''),
  ('philhealth', '2026-01-01', 100000, 99999999, 2500.00, 2500.00, 'Ceiling at ₱100k MSC');

-- ---- Pag-IBIG contribution brackets — effective 2026-01-01 ---------------
-- 2% EE + 2% ER, capped at ₱5,000 MSC for v1 (per current rules).
insert into public.payroll_contribution_brackets (kind, effective_from, monthly_salary_credit_min_php, monthly_salary_credit_max_php, employee_share_php, employer_share_php, notes) values
  ('pagibig', '2026-01-01',    0,  1500,  20.00,  20.00, '1% EE/ER for low MSC'),
  ('pagibig', '2026-01-01', 1500,  5000, 100.00, 100.00, '2% EE/ER, capped'),
  ('pagibig', '2026-01-01', 5000, 99999, 100.00, 100.00, 'Ceiling at ₱5k MSC');

-- ---- BIR semi-monthly WT compensation brackets ----------------------------
-- Per BIR Revenue Regulation 11-2018, semi-monthly schedule.
insert into public.payroll_wt_brackets (effective_from, taxable_min_php, taxable_max_php, base_tax_php, marginal_rate, notes) values
  ('2026-01-01',      0.00,  10417.00,      0.00, 0.00,   '0% bracket — no tax up to ₱10,417 semi-monthly'),
  ('2026-01-01',  10417.00,  16667.00,      0.00, 0.20,   '20% over ₱10,417'),
  ('2026-01-01',  16667.00,  33333.00,   1250.00, 0.25,   '25% over ₱16,667 + ₱1,250'),
  ('2026-01-01',  33333.00,  83333.00,   5416.67, 0.30,   '30% over ₱33,333 + ₱5,416.67'),
  ('2026-01-01',  83333.00, 333333.00,  20416.67, 0.32,   '32% over ₱83,333 + ₱20,416.67'),
  ('2026-01-01', 333333.00, null,      100416.67, 0.35,   '35% over ₱333,333 + ₱100,416.67');

-- ---- employee_leave_balance(employee_id, kind, as_of_date) ----------------
create or replace function public.employee_leave_balance(
  p_employee_id uuid,
  p_kind        text,
  p_as_of_date  date default current_date
)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(days_delta), 0)::numeric(5,2)
  from public.employee_leave_records
  where employee_id = p_employee_id
    and kind = p_kind
    and effective_date <= p_as_of_date
    and (expiry_date is null or expiry_date > p_as_of_date);
$$;

grant execute on function public.employee_leave_balance(uuid, text, date) to authenticated;

-- ---- apply_leave_entitlements(p_year int) ---------------------------------
-- Idempotent. For each active employee:
--   * If regularization_date is set: grant pro-rated SL for the calendar year
--     (full 5 days if regularized before Jan 1 of p_year; pro-rated if mid-year).
--   * If 1-year anniversary has passed: grant 12 monthly VL accrual rows for
--     the year's anniversary cycle (annual_entitlement / 12 per month).
--     Annual entitlement = 5 + min(years_since_first_anniversary, 5), capped 10.
create or replace function public.apply_leave_entitlements(p_year int)
returns table (employee_id uuid, kind text, days_granted numeric, notes text)
language plpgsql security definer set search_path = public as $$
declare
  e record;
  v_anniv int;
  v_annual numeric(5,2);
  v_monthly numeric(5,2);
  v_month int;
  v_eff_date date;
  v_expiry date;
  v_days_pro numeric(5,2);
  v_remaining_days int;
begin
  for e in select * from public.employees where is_active = true loop
    -- SL: any regular employee gets annual SL, pro-rated if regularized mid-year
    if e.regularization_date is not null then
      if e.regularization_date <= make_date(p_year, 1, 1) then
        v_days_pro := 5.00;
      else
        -- pro-rate to days remaining in p_year
        v_remaining_days := (make_date(p_year, 12, 31) - e.regularization_date) + 1;
        v_days_pro := round(5.00 * v_remaining_days::numeric / 365, 2);
      end if;
      if v_days_pro > 0 then
        insert into public.employee_leave_records (employee_id, kind, record_kind, days_delta, effective_date, expiry_date, reason)
        values (e.id, 'SL', 'entitlement', v_days_pro,
          greatest(e.regularization_date, make_date(p_year, 1, 1)),
          make_date(p_year, 12, 31),
          format('Annual SL entitlement for %s', p_year))
        on conflict do nothing;
        return query select e.id, 'SL'::text, v_days_pro, format('annual SL for %s', p_year)::text;
      end if;
    end if;

    -- VL: monthly accrual once past 1-year anniversary
    if e.hire_date + interval '1 year' <= make_date(p_year, 12, 31) then
      v_anniv := extract(year from age(make_date(p_year, 1, 1), e.hire_date))::int;
      v_annual := least(5 + greatest(v_anniv - 1, 0), 10)::numeric(5,2);
      v_monthly := round(v_annual / 12, 2);

      for v_month in 1..12 loop
        v_eff_date := make_date(p_year, v_month, extract(day from e.hire_date)::int);
        -- skip months before the 1-year mark
        if v_eff_date < (e.hire_date + interval '1 year')::date then
          continue;
        end if;
        v_expiry := make_date(p_year + 1, 4, 1);
        insert into public.employee_leave_records (employee_id, kind, record_kind, days_delta, effective_date, expiry_date, reason)
        values (e.id, 'VL', 'entitlement', v_monthly, v_eff_date, v_expiry,
          format('Monthly VL accrual %s-%02d (annual entitlement %s)', p_year, v_month, v_annual))
        on conflict do nothing;
      end loop;
      return query select e.id, 'VL'::text, v_monthly * 12, format('monthly VL ~%s', v_annual)::text;
    end if;
  end loop;
end;
$$;

-- ---- apply_leave_expiry(p_year int) ---------------------------------------
-- Run on April 1 each year to forfeit unused VL from p_year-1 (Mar 31 deadline).
-- Also run on Dec 31 implicitly via expiry_date — but for VL the deadline is
-- staggered (Mar 31 of year after), so this function handles the VL case.
-- SL expires on Dec 31 of its own year via its expiry_date row already.
create or replace function public.apply_leave_expiry(p_year int)
returns table (employee_id uuid, kind text, days_expired numeric)
language plpgsql security definer set search_path = public as $$
declare
  e record;
  v_bal numeric(5,2);
begin
  for e in select id from public.employees where is_active = true loop
    -- Only handle VL: any positive balance accrued during p_year that's still
    -- present on April 1 of p_year+1 gets expired here.
    v_bal := public.employee_leave_balance(e.id, 'VL', make_date(p_year + 1, 3, 31));
    if v_bal > 0 then
      insert into public.employee_leave_records (employee_id, kind, record_kind, days_delta, effective_date, reason)
      values (e.id, 'VL', 'expiry', -v_bal, make_date(p_year + 1, 4, 1),
        format('Carryover expiry — %s VL unused by Mar 31 %s', p_year, p_year + 1));
      return query select e.id, 'VL'::text, v_bal;
    end if;
  end loop;
end;
$$;

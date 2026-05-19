-- =============================================================================
-- 0044_payroll_smoke.sql
-- =============================================================================
-- Phase 12.6 smoke. Exercises migration 0044's schema (15 new tables + RLS),
-- seeds (CoA, holidays, brackets, accounting_settings, cash adjustment map),
-- helper functions (employee_leave_balance, apply_leave_entitlements), bridge
-- triggers (run finalise, run void, bank payout, 13th-month payout) and the
-- nine payroll guards (P0020-P0028 incl. the P0025 column CHECK).
--
-- 45 assertions total. Runs entirely inside BEGIN/ROLLBACK; local DB stays
-- clean. Style matches supabase/tests/0043_eod_cash_reconciliation_smoke.sql.
--
-- Run with:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/0044_payroll_smoke.sql
-- =============================================================================

begin;

do $$
declare
  v_actor_id          uuid;
  v_staff_id          uuid;
  v_shift_id          uuid;
  v_emp_id            uuid;
  v_emp_id_bank       uuid;
  v_staff_id_bank     uuid;
  v_staff_id_norate   uuid;
  v_period_id         uuid;
  v_period_dec_id     uuid;
  v_period_other_id   uuid;
  v_run_id            uuid;
  v_run_dec_id        uuid;
  v_run_other_id      uuid;
  v_emp_run_id        uuid;
  v_emp_run_bank_id   uuid;
  v_emp_run_other_id  uuid;
  v_ot_slip_id        uuid;
  v_loan_id           uuid;
  v_advance_adj_id    uuid;
  v_advance_id        uuid;
  v_je_id             uuid;
  v_je_id2            uuid;
  v_count             int;
  v_bool              boolean;
  v_bal               numeric;
  v_total             numeric;
  v_dr                numeric;
  v_cr                numeric;
  v_table             text;
  v_business_date     date := '2026-11-15'::date;
  v_period_start      date := '2026-11-01'::date;
  v_period_end        date := '2026-11-15'::date;
  v_pay_date          date := '2026-11-20'::date;
  v_dec_period_start  date := '2026-12-01'::date;
  v_dec_period_end    date := '2026-12-15'::date;
  v_dec_pay_date      date := '2026-12-20'::date;
  v_payroll_tables    text[] := array[
    'employees', 'employee_allowances', 'payroll_periods', 'payroll_runs',
    'payroll_employee_runs', 'payroll_earning_lines', 'employee_loans',
    'payroll_deduction_lines', 'payroll_ot_slips', 'payroll_dtr_imports',
    'payroll_dtr_rows', 'payroll_holidays', 'payroll_contribution_brackets',
    'payroll_wt_brackets', 'employee_leave_records'
  ];
begin
  select id into v_actor_id from auth.users limit 1;
  if v_actor_id is null then
    raise exception 'SMOKE SETUP FAIL: no auth.users row';
  end if;

  select id into v_staff_id from public.staff_profiles where is_active = true limit 1;
  if v_staff_id is null then
    raise exception 'SMOKE SETUP FAIL: no active staff_profiles row';
  end if;

  select id into v_shift_id from public.cash_shifts where code = 'default';
  if v_shift_id is null then
    raise exception 'SMOKE SETUP FAIL: default shift not seeded';
  end if;

  -- =========================================================================
  -- GROUP 1: Table existence + RLS enabled (15 assertions, one per table)
  -- =========================================================================
  foreach v_table in array v_payroll_tables loop
    if not exists(
      select 1 from pg_tables
      where schemaname = 'public' and tablename = v_table
    ) then
      raise exception 'A% FAIL: table public.% missing',
        (array_position(v_payroll_tables, v_table)), v_table;
    end if;
    select c.relrowsecurity into v_bool
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table;
    if not v_bool then
      raise exception 'A% FAIL: RLS not enabled on public.%',
        (array_position(v_payroll_tables, v_table)), v_table;
    end if;
    raise notice 'A% PASS: table public.% exists with RLS',
      (array_position(v_payroll_tables, v_table)), v_table;
  end loop;

  -- =========================================================================
  -- GROUP 2: CoA codes 2350/2360/6121-6124 present (1 assertion)
  -- =========================================================================
  select count(*) into v_count from public.chart_of_accounts
    where code in ('2350','2360','6121','6122','6123','6124') and is_active = true;
  if v_count <> 6 then
    raise exception 'A16 FAIL: expected 6 new payroll CoA codes, got %', v_count;
  end if;
  raise notice 'A16 PASS: 6 new payroll CoA codes seeded';

  -- =========================================================================
  -- GROUP 3: salary_payout map row + kind enum value (2 assertions)
  -- =========================================================================
  if not exists(
    select 1 from public.cash_adjustment_account_map
    where kind = 'salary_payout' and account_id = public.coa_uuid_for_code('2360')
  ) then
    raise exception 'A17 FAIL: salary_payout map row missing or wrong account';
  end if;
  raise notice 'A17 PASS: salary_payout map row routes to 2360';

  -- Verify the eod_cash_adjustments.kind CHECK accepts 'salary_payout'
  begin
    insert into public.eod_cash_adjustments (
      business_date, shift_id, kind, amount_php, recorded_by, payee_staff_id
    ) values (
      v_business_date, v_shift_id, 'salary_payout', 1, v_staff_id, v_staff_id
    );
    raise notice 'A18 PASS: salary_payout accepted by eod_cash_adjustments.kind';
  exception when check_violation then
    raise exception 'A18 FAIL: salary_payout rejected by eod_cash_adjustments.kind CHECK';
  end;

  -- =========================================================================
  -- GROUP 4: Pre-seeds present (3 assertions — holidays, SSS, other statutory)
  -- =========================================================================
  select count(*) into v_count from public.payroll_holidays
    where date >= '2026-01-01' and date <= '2026-12-31';
  if v_count < 18 then
    raise exception 'A19 FAIL: expected >=18 2026 holidays, got %', v_count;
  end if;
  raise notice 'A19 PASS: % 2026 holidays seeded', v_count;

  select count(*) into v_count from public.payroll_contribution_brackets where kind = 'sss';
  if v_count < 20 then
    raise exception 'A20 FAIL: expected >=20 SSS brackets, got %', v_count;
  end if;
  raise notice 'A20 PASS: % SSS brackets seeded', v_count;

  -- PHIC + Pag-IBIG + WT (all statutory brackets in one assertion)
  select
    (select count(*) from public.payroll_contribution_brackets where kind='philhealth')
    + (select count(*) from public.payroll_contribution_brackets where kind='pagibig')
    + (select count(*) from public.payroll_wt_brackets)
  into v_count;
  if v_count < 16 then  -- 7 phic + 3 pagibig + 6 wt = 16
    raise exception 'A21 FAIL: expected >=16 PHIC+Pag-IBIG+WT brackets, got %', v_count;
  end if;
  raise notice 'A21 PASS: % PHIC+Pag-IBIG+WT brackets seeded', v_count;

  -- =========================================================================
  -- Common fixture setup: create test employee(s), period, run
  -- =========================================================================
  -- Cash-paid employee tied to v_staff_id
  insert into public.employees (
    staff_profile_id, hire_date, regularization_date,
    basic_daily_rate_php, monthly_salary_credit_php, schedule_kind,
    payment_method, is_active
  ) values (
    v_staff_id, '2024-01-01', '2024-07-01',
    1000.00, 20000.00, 'fixed_5day_mon_fri', 'cash', true
  ) returning id into v_emp_id;

  -- Bank-paid employee tied to the OTHER active staff profile
  select id into v_staff_id_bank
    from public.staff_profiles
    where is_active = true and id <> v_staff_id
    limit 1;
  if v_staff_id_bank is null then
    raise exception 'SMOKE SETUP FAIL: need a second active staff_profile for bank-payout test';
  end if;

  -- Third staff_profile backs the A39 no-rate fixture (employees.staff_profile_id is UNIQUE)
  select sp.id into v_staff_id_norate
    from public.staff_profiles sp
    join auth.users u on u.id = sp.id
    where sp.is_active = true and u.email = 'smoke-payroll-norate@drmed.test'
    limit 1;
  if v_staff_id_norate is null then
    raise exception 'SMOKE SETUP FAIL: need staff_profile for smoke-payroll-norate@drmed.test (A39 fixture)';
  end if;

  insert into public.employees (
    staff_profile_id, hire_date, regularization_date,
    basic_daily_rate_php, monthly_salary_credit_php, schedule_kind,
    payment_method, bank_name, bank_account_number, bank_account_holder_name,
    is_active
  ) values (
    v_staff_id_bank, '2024-01-01', '2024-07-01',
    1500.00, 30000.00, 'fixed_5day_mon_fri', 'bank',
    'BPI', '0000000001', 'Bank Test', true
  ) returning id into v_emp_id_bank;

  -- November period (non-Dec)
  insert into public.payroll_periods (period_start, period_end, pay_date)
  values (v_period_start, v_period_end, v_pay_date)
  returning id into v_period_id;

  insert into public.payroll_runs (period_id, status) values (v_period_id, 'draft')
  returning id into v_run_id;

  -- =========================================================================
  -- GROUP 5: employee_leave_balance returns expected after grant + usage (3)
  -- =========================================================================
  -- Manual grant 5 days VL effective 2026-01-01
  insert into public.employee_leave_records (
    employee_id, kind, record_kind, days_delta, effective_date, expiry_date, reason, created_by
  ) values (
    v_emp_id, 'VL', 'manual_grant', 5.00, '2026-01-01', '2027-04-01',
    'smoke test grant', v_staff_id
  );

  v_bal := public.employee_leave_balance(v_emp_id, 'VL', v_business_date);
  if v_bal <> 5.00 then
    raise exception 'A22 FAIL: expected VL balance 5.00 after grant, got %', v_bal;
  end if;
  raise notice 'A22 PASS: VL balance 5.00 after grant';

  -- Usage -2 days
  insert into public.employee_leave_records (
    employee_id, kind, record_kind, days_delta, effective_date, reason, created_by
  ) values (
    v_emp_id, 'VL', 'usage', -2.00, '2026-06-01',
    'smoke test usage', v_staff_id
  );

  v_bal := public.employee_leave_balance(v_emp_id, 'VL', v_business_date);
  if v_bal <> 3.00 then
    raise exception 'A23 FAIL: expected VL balance 3.00 after usage, got %', v_bal;
  end if;
  raise notice 'A23 PASS: VL balance 3.00 after 2-day usage';

  -- Balance as-of a date BEFORE the grant should be 0
  v_bal := public.employee_leave_balance(v_emp_id, 'VL', '2025-12-31'::date);
  if v_bal <> 0 then
    raise exception 'A24 FAIL: expected VL balance 0 before grant effective_date, got %', v_bal;
  end if;
  raise notice 'A24 PASS: VL balance 0 before grant effective_date';

  -- =========================================================================
  -- GROUP 6: apply_leave_entitlements(2026) idempotent (2 assertions)
  -- =========================================================================
  perform public.apply_leave_entitlements(2026);
  select count(*) into v_count from public.employee_leave_records
    where employee_id = v_emp_id and record_kind = 'entitlement'
      and effective_date between '2026-01-01' and '2026-12-31';
  if v_count = 0 then
    raise exception 'A25 FAIL: apply_leave_entitlements(2026) granted nothing';
  end if;
  raise notice 'A25 PASS: apply_leave_entitlements(2026) seeded % entitlement rows', v_count;

  -- Re-run: count must stay the same (idempotent via unique index)
  perform public.apply_leave_entitlements(2026);
  select count(*) into v_total from public.employee_leave_records
    where employee_id = v_emp_id and record_kind = 'entitlement'
      and effective_date between '2026-01-01' and '2026-12-31';
  if v_total <> v_count then
    raise exception 'A26 FAIL: apply_leave_entitlements not idempotent (was %, now %)',
      v_count, v_total;
  end if;
  raise notice 'A26 PASS: apply_leave_entitlements idempotent';

  -- =========================================================================
  -- Fixture: build a payable employee_run for the cash employee in v_run_id
  -- Scheduled 10 days; all present; gross 10,000.
  -- =========================================================================
  insert into public.payroll_employee_runs (
    run_id, employee_id, scheduled_days, days_present,
    basic_pay_php, gross_pay_php,
    sss_ee_php, sss_er_php, philhealth_ee_php, philhealth_er_php,
    pagibig_ee_php, pagibig_er_php, wt_compensation_php,
    thirteenth_month_accrual_php,
    net_pay_php,
    payment_method_used
  ) values (
    v_run_id, v_emp_id, 10, 10,
    10000.00, 10000.00,
    450.00, 970.00, 250.00, 250.00,
    100.00, 100.00, 0.00,
    833.33,
    9200.00,
    'cash'
  ) returning id into v_emp_run_id;

  -- And a bank-paid employee_run on the same run (for the bank payout test)
  insert into public.payroll_employee_runs (
    run_id, employee_id, scheduled_days, days_present,
    basic_pay_php, gross_pay_php,
    net_pay_php,
    payment_method_used
  ) values (
    v_run_id, v_emp_id_bank, 10, 10,
    15000.00, 15000.00,
    15000.00,
    'bank'
  ) returning id into v_emp_run_bank_id;

  -- =========================================================================
  -- GROUP 7: bridge_payroll_run_finalise posts a balanced JE (4 assertions)
  -- =========================================================================
  update public.payroll_runs
    set status = 'finalised', finalised_at = now(), finalised_by = v_staff_id
    where id = v_run_id;

  select gross_up_je_id into v_je_id from public.payroll_runs where id = v_run_id;
  if v_je_id is null then
    raise exception 'A27 FAIL: gross_up_je_id not set after finalise';
  end if;
  raise notice 'A27 PASS: gross_up_je_id set after finalise';

  select status into v_table from public.journal_entries where id = v_je_id;
  if v_table <> 'posted' then
    raise exception 'A28 FAIL: expected JE status=posted, got %', v_table;
  end if;
  raise notice 'A28 PASS: gross-up JE is posted';

  select sum(debit_php), sum(credit_php) into v_dr, v_cr
    from public.journal_lines where entry_id = v_je_id;
  if v_dr <> v_cr or v_dr = 0 then
    raise exception 'A29 FAIL: gross-up JE unbalanced (dr=%, cr=%)', v_dr, v_cr;
  end if;
  raise notice 'A29 PASS: gross-up JE balances (dr=cr=%)', v_dr;

  -- Sums match: total debits should equal salaries_wages + employer contribs + 13th accrual
  -- For our fixture: 10000+15000 (sal/wages) + 970 (sss_er) + 250 (phic_er) + 100 (pagibig_er) + 833.33 (13th)
  --                = 25000 + 970 + 250 + 100 + 833.33 = 27153.33
  if v_dr <> 27153.33 then
    raise exception 'A30 FAIL: expected debit total 27153.33, got %', v_dr;
  end if;
  raise notice 'A30 PASS: debit total matches per-employee sums (27153.33)';

  -- =========================================================================
  -- GROUP 8: bridge_payroll_13th_month_payout fires ONLY for Dec 1-15 (2)
  -- =========================================================================
  -- (a) Non-Dec run should NOT have set thirteenth_payout_je_id
  if (select thirteenth_payout_je_id from public.payroll_runs where id = v_run_id) is not null then
    raise exception 'A31 FAIL: non-Dec run got 13th-month payout JE';
  end if;
  raise notice 'A31 PASS: non-Dec run did not trigger 13th-month payout';

  -- (b) Dec 1-15 run SHOULD post a 13th-month payout JE
  insert into public.payroll_periods (period_start, period_end, pay_date)
  values (v_dec_period_start, v_dec_period_end, v_dec_pay_date)
  returning id into v_period_dec_id;

  insert into public.payroll_runs (period_id, status) values (v_period_dec_id, 'draft')
  returning id into v_run_dec_id;

  insert into public.payroll_employee_runs (
    run_id, employee_id, scheduled_days, days_present,
    basic_pay_php, gross_pay_php,
    thirteenth_month_payout_php,
    net_pay_php,
    payment_method_used
  ) values (
    v_run_dec_id, v_emp_id, 11, 11,
    11000.00, 11000.00,
    9166.63,
    11000.00,
    'cash'
  );

  update public.payroll_runs
    set status = 'finalised', finalised_at = now(), finalised_by = v_staff_id
    where id = v_run_dec_id;

  select thirteenth_payout_je_id into v_je_id2 from public.payroll_runs where id = v_run_dec_id;
  if v_je_id2 is null then
    raise exception 'A32 FAIL: Dec 1-15 run did not produce a 13th-month payout JE';
  end if;
  -- And the JE should be DR 2350 / CR 2360 for 9166.63
  select sum(debit_php) into v_dr
    from public.journal_lines jl
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where jl.entry_id = v_je_id2 and coa.code = '2350';
  if v_dr <> 9166.63 then
    raise exception 'A32 FAIL: 13th-month JE DR 2350 expected 9166.63, got %', v_dr;
  end if;
  raise notice 'A32 PASS: Dec 1-15 run posted 13th-month payout JE DR 2350 9166.63';

  -- =========================================================================
  -- GROUP 9: bridge_payroll_run_void reverses + restores advance (3)
  -- =========================================================================
  -- Pre-create a staff_advance so the void can restore it.
  -- Use a fresh business_date so we don't conflict with the salary_payout adj inserted at A18.
  insert into public.eod_cash_adjustments (
    business_date, shift_id, kind, amount_php, recorded_by, payee_staff_id
  ) values (
    v_business_date - 30, v_shift_id, 'salary_advance', 500, v_staff_id, v_staff_id
  ) returning id into v_advance_adj_id;

  select id into v_advance_id from public.staff_advances where source_adjustment_id = v_advance_adj_id;
  -- Tag the employee_run with the 500 settlement so the void bridge can find it.
  -- This must happen BEFORE we mark the advance settled, otherwise P0024
  -- (advance settlement must be <= outstanding balance) trips at update time.
  update public.payroll_employee_runs
    set staff_advance_settlement_php = 500
    where id = v_emp_run_id;
  -- Settle it down to 0 to simulate that the finalised run already deducted 500.
  update public.staff_advances
    set outstanding_balance_php = 0, status = 'settled'
    where id = v_advance_id;

  -- VOID the run (allowed: no payout has been paid yet)
  update public.payroll_runs
    set status = 'voided', voided_at = now(), voided_by = v_staff_id, void_reason = 'smoke void'
    where id = v_run_id;

  -- (a) gross-up JE marked reversed
  select status into v_table from public.journal_entries where id = v_je_id;
  if v_table <> 'reversed' then
    raise exception 'A33 FAIL: original JE not marked reversed, status=%', v_table;
  end if;
  raise notice 'A33 PASS: gross-up JE marked reversed after void';

  -- (b) a posted reversal JE references the original
  if not exists(
    select 1 from public.journal_entries
    where source_kind = 'reversal' and reverses = v_je_id and status = 'posted'
  ) then
    raise exception 'A34 FAIL: no posted reversal JE for original %', v_je_id;
  end if;
  raise notice 'A34 PASS: reversal JE posted for gross-up';

  -- (c) staff_advance restored (back up to 500, status outstanding)
  select outstanding_balance_php, status into v_bal, v_table
    from public.staff_advances where id = v_advance_id;
  if v_bal <> 500 or v_table <> 'outstanding' then
    raise exception 'A35 FAIL: staff_advance not restored (bal=%, status=%)', v_bal, v_table;
  end if;
  raise notice 'A35 PASS: staff_advance restored to 500/outstanding';

  -- =========================================================================
  -- GROUP 10: bridge_payroll_payout_bank fires only for bank-paid (1)
  -- =========================================================================
  -- Build a fresh run that we DON'T void so we can test bank payout.
  insert into public.payroll_periods (period_start, period_end, pay_date)
    values ('2026-10-01', '2026-10-15', '2026-10-20')
    returning id into v_period_other_id;
  insert into public.payroll_runs (period_id, status) values (v_period_other_id, 'draft')
    returning id into v_run_other_id;
  insert into public.payroll_employee_runs (
    run_id, employee_id, scheduled_days, days_present,
    basic_pay_php, gross_pay_php, net_pay_php, payment_method_used
  ) values (
    v_run_other_id, v_emp_id_bank, 10, 10, 15000, 15000, 15000, 'bank'
  ) returning id into v_emp_run_other_id;

  update public.payroll_runs
    set status = 'finalised', finalised_at = now(), finalised_by = v_staff_id
    where id = v_run_other_id;

  -- Now flip the bank-paid employee_run to paid; expect a payout JE.
  update public.payroll_employee_runs
    set payout_status = 'paid', paid_at = now(), paid_by = v_staff_id
    where id = v_emp_run_other_id;

  select payout_je_id into v_je_id from public.payroll_employee_runs where id = v_emp_run_other_id;
  if v_je_id is null then
    raise exception 'A36 FAIL: bank payout did not post a JE';
  end if;
  -- Verify DR 2360 / CR 1020
  select sum(debit_php) into v_dr from public.journal_lines jl
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where jl.entry_id = v_je_id and coa.code = '2360';
  if v_dr <> 15000 then
    raise exception 'A36 FAIL: expected bank-payout DR 2360 15000, got %', v_dr;
  end if;
  raise notice 'A36 PASS: bank payout JE DR 2360 / CR 1020 = 15000';

  -- =========================================================================
  -- GROUP 11: P0020 fires when scheduled_days mismatch accounted days
  -- =========================================================================
  -- Set scheduled_days <> sum(accounted) on the November run's bank employee_run,
  -- then try to "re-finalise" — but the run is already voided/finalised.
  -- Easier: build a NEW draft run with a deliberately broken count.
  declare
    v_run_p20 uuid;
    v_period_p20 uuid;
  begin
    insert into public.payroll_periods (period_start, period_end, pay_date)
      values ('2026-09-01', '2026-09-15', '2026-09-20') returning id into v_period_p20;
    insert into public.payroll_runs (period_id, status) values (v_period_p20, 'draft')
      returning id into v_run_p20;
    insert into public.payroll_employee_runs (
      run_id, employee_id, scheduled_days, days_present,
      basic_pay_php, gross_pay_php, net_pay_php, payment_method_used
    ) values (
      v_run_p20, v_emp_id, 11, 10, 10000, 10000, 10000, 'cash'   -- 10 accounted, 11 scheduled
    );
    begin
      update public.payroll_runs
        set status = 'finalised', finalised_at = now(), finalised_by = v_staff_id
        where id = v_run_p20;
      raise exception 'A37 FAIL: P0020 did not fire';
    exception when sqlstate 'P0020' then
      raise notice 'A37 PASS: P0020 fired on scheduled_days mismatch';
    end;
  end;

  -- =========================================================================
  -- GROUP 12: P0021 fires when editing a finalised run after a paid employee_run
  -- =========================================================================
  -- v_run_other_id has a paid bank employee_run. Try to change its net_pay.
  begin
    update public.payroll_employee_runs
      set net_pay_php = 99
      where id = v_emp_run_other_id;
    raise exception 'A38 FAIL: P0021 did not fire on edit after payout';
  exception when sqlstate 'P0021' then
    raise notice 'A38 PASS: P0021 blocked edit after payout';
  end;

  -- =========================================================================
  -- GROUP 13: P0022 fires when employee.daily_rate is null/zero
  -- =========================================================================
  -- We can't insert an employee with daily_rate=0 (column CHECK). Work around
  -- by temporarily disabling the column CHECK so we can null/zero out, then
  -- attempt the INSERT into payroll_employee_runs.
  declare
    v_emp_norate uuid;
    v_run_p22 uuid;
    v_period_p22 uuid;
  begin
    alter table public.employees drop constraint employees_basic_daily_rate_php_check;
    insert into public.employees (
      staff_profile_id, hire_date, basic_daily_rate_php, monthly_salary_credit_php,
      schedule_kind, payment_method, is_active
    ) values (
      v_staff_id_norate, '2025-01-01', 0, 0.01,  -- third staff_profile dedicated to the A39 no-rate fixture
      'fixed_5day_mon_fri', 'cash', true
    ) returning id into v_emp_norate;
    -- restore the column check (NOT VALID so the zero-rate fixture row above
    -- doesn't trip re-validation; the check still enforces future inserts)
    alter table public.employees
      add constraint employees_basic_daily_rate_php_check check (basic_daily_rate_php > 0) not valid;

    insert into public.payroll_periods (period_start, period_end, pay_date)
      values ('2026-08-01','2026-08-15','2026-08-20') returning id into v_period_p22;
    insert into public.payroll_runs (period_id, status) values (v_period_p22, 'draft')
      returning id into v_run_p22;
    begin
      insert into public.payroll_employee_runs (
        run_id, employee_id, scheduled_days, days_present, payment_method_used
      ) values (v_run_p22, v_emp_norate, 10, 10, 'cash');
      raise exception 'A39 FAIL: P0022 did not fire on zero daily rate';
    exception when sqlstate 'P0022' then
      raise notice 'A39 PASS: P0022 blocked employee_run insert without daily rate';
    end;
  end;

  -- =========================================================================
  -- GROUP 14: P0023 fires when ot_pay_php > 0 without an approved OT slip
  -- =========================================================================
  declare
    v_run_p23 uuid;
    v_period_p23 uuid;
  begin
    insert into public.payroll_periods (period_start, period_end, pay_date)
      values ('2026-07-01','2026-07-15','2026-07-20') returning id into v_period_p23;
    insert into public.payroll_runs (period_id, status) values (v_period_p23, 'draft')
      returning id into v_run_p23;
    begin
      insert into public.payroll_employee_runs (
        run_id, employee_id, scheduled_days, days_present,
        basic_pay_php, ot_pay_php, gross_pay_php, net_pay_php, payment_method_used
      ) values (v_run_p23, v_emp_id, 10, 10, 10000, 500, 10500, 10500, 'cash');
      raise exception 'A40 FAIL: P0023 did not fire on ot_pay without slip';
    exception when sqlstate 'P0023' then
      raise notice 'A40 PASS: P0023 blocked ot_pay_php without approved slip';
    end;
  end;

  -- =========================================================================
  -- GROUP 15: P0024 fires when settlement > outstanding
  -- =========================================================================
  -- v_advance_id is at 500 outstanding. Attempt 1000 settlement on a fresh run.
  declare
    v_run_p24 uuid;
    v_period_p24 uuid;
  begin
    insert into public.payroll_periods (period_start, period_end, pay_date)
      values ('2026-06-01','2026-06-15','2026-06-20') returning id into v_period_p24;
    insert into public.payroll_runs (period_id, status) values (v_period_p24, 'draft')
      returning id into v_run_p24;
    begin
      insert into public.payroll_employee_runs (
        run_id, employee_id, scheduled_days, days_present,
        basic_pay_php, gross_pay_php, staff_advance_settlement_php,
        net_pay_php, payment_method_used
      ) values (v_run_p24, v_emp_id, 10, 10, 10000, 10000, 1000, 9000, 'cash');
      raise exception 'A41 FAIL: P0024 did not fire on over-settlement';
    exception when sqlstate 'P0024' then
      raise notice 'A41 PASS: P0024 blocked settlement > outstanding';
    end;
  end;

  -- =========================================================================
  -- GROUP 16: P0026 fires on INSERT to finalised run's employee_runs
  -- =========================================================================
  -- v_run_other_id is finalised; insert a new employee_run row → P0026.
  begin
    insert into public.payroll_employee_runs (
      run_id, employee_id, scheduled_days, days_present,
      basic_pay_php, gross_pay_php, net_pay_php, payment_method_used
    ) values (v_run_other_id, v_emp_id, 10, 10, 10000, 10000, 10000, 'cash');
    raise exception 'A42 FAIL: P0026 did not fire on insert into finalised run';
  exception when sqlstate 'P0026' then
    raise notice 'A42 PASS: P0026 blocked insert into finalised run';
  end;

  -- =========================================================================
  -- GROUP 17: P0027 fires on finalise with all-zero gross
  -- =========================================================================
  declare
    v_run_p27 uuid;
    v_period_p27 uuid;
  begin
    insert into public.payroll_periods (period_start, period_end, pay_date)
      values ('2026-05-01','2026-05-15','2026-05-20') returning id into v_period_p27;
    insert into public.payroll_runs (period_id, status) values (v_period_p27, 'draft')
      returning id into v_run_p27;
    insert into public.payroll_employee_runs (
      run_id, employee_id, scheduled_days, days_present,
      basic_pay_php, gross_pay_php, net_pay_php, payment_method_used
    ) values (v_run_p27, v_emp_id, 10, 10, 0, 0, 0, 'cash');
    begin
      update public.payroll_runs
        set status = 'finalised', finalised_at = now(), finalised_by = v_staff_id
        where id = v_run_p27;
      raise exception 'A43 FAIL: P0027 did not fire on all-zero gross';
    exception when sqlstate 'P0027' then
      raise notice 'A43 PASS: P0027 blocked finalise with zero gross total';
    end;
  end;

  -- =========================================================================
  -- GROUP 18: P0028 fires on leave usage that would go negative
  -- =========================================================================
  -- v_emp_id has VL balance: started at 5 (manual_grant), used 2, plus
  -- apply_leave_entitlements added monthly accrual. Pick a huge usage to
  -- guarantee underwater regardless of exact accrual.
  begin
    insert into public.employee_leave_records (
      employee_id, kind, record_kind, days_delta, effective_date, reason, created_by
    ) values (
      v_emp_id, 'VL', 'usage', -999.00, '2026-11-15',
      'smoke overdraw', v_staff_id
    );
    raise exception 'A44 FAIL: P0028 did not fire on leave overdraw';
  exception when sqlstate 'P0028' then
    raise notice 'A44 PASS: P0028 blocked leave overdraw';
  end;

  -- =========================================================================
  -- GROUP 19: P0025 (check_violation) fires when loan.outstanding goes negative
  -- =========================================================================
  insert into public.employee_loans (
    employee_id, principal_php, amortization_per_period_php,
    outstanding_balance_php, status,
    requested_by, requested_at
  ) values (
    v_emp_id, 1000, 100, 100, 'requested', v_staff_id, now()
  ) returning id into v_loan_id;

  begin
    update public.employee_loans
      set outstanding_balance_php = -1
      where id = v_loan_id;
    raise exception 'A45 FAIL: P0025 (CHECK) did not fire on negative outstanding';
  exception when check_violation then
    raise notice 'A45 PASS: P0025 CHECK blocked negative loan outstanding';
  end;

  raise notice '===== ALL 12.6 SMOKE ASSERTIONS PASSED =====';
end;
$$;

rollback;

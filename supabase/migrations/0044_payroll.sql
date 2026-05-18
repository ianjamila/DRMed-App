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

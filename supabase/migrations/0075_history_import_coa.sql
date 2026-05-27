-- =============================================================================
-- 0075_history_import_coa.sql
-- =============================================================================
-- 12.B sub-project. Adds the one chart_of_accounts row required by the
-- history-import scripts: 2500 Due to Shareholders.
--
-- Mode of payment "Ian" / "Freya" in the DR MED MASTERSHEET EXPENSES tab
-- represents shareholder out-of-pocket spend that the clinic owes back. This
-- is a current liability, not equity (equity would imply no expectation of
-- repayment). Booked as CR 2500 against the appropriate expense DR.
-- =============================================================================

insert into public.chart_of_accounts (code, name, type, normal_balance, description, is_active)
values
  ('2500', 'Due to Shareholders',
   'liability', 'credit',
   'Out-of-pocket spend by shareholders (Ian, Freya) awaiting reimbursement.',
   true)
on conflict (code) do nothing;

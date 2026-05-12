-- =============================================================================
-- 0028_gl_foundation_smoke.sql
-- =============================================================================
-- DB integrity smoke test for migrations 0028 + 0029. Runs inside
-- BEGIN/ROLLBACK so it leaves no state behind. Asserts each invariant with
-- raise notice on success and explicit raise exception on unexpected behavior.
--
-- Run with:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0028_gl_foundation_smoke.sql
-- =============================================================================

begin;

do $$
declare
  v_asset_id   uuid;
  v_liab_id    uuid;
  v_je_id      uuid;
  v_je_rev_id  uuid;
  v_count      int;
begin
  -- Set up two real accounts to post against.
  insert into public.chart_of_accounts (code, name, type, normal_balance)
    values ('1001', 'Test Cash', 'asset', 'debit')
    returning id into v_asset_id;
  insert into public.chart_of_accounts (code, name, type, normal_balance)
    values ('2001', 'Test Payable', 'liability', 'credit')
    returning id into v_liab_id;

  -- 1) Balanced posted JE succeeds.
  insert into public.journal_entries (posting_date, description, status, source_kind)
    values ('2026-06-15', 'smoke: balanced', 'posted', 'manual')
    returning id into v_je_id;
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    values (v_je_id, v_asset_id, 1000.00, 0, 1),
           (v_je_id, v_liab_id, 0, 1000.00, 2);
  raise notice 'PASS: balanced JE accepted';

  -- 2) Unbalanced posted JE rejected.
  begin
    insert into public.journal_entries (posting_date, description, status, source_kind)
      values ('2026-06-16', 'smoke: unbalanced', 'posted', 'manual')
      returning id into v_je_id;
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_id, v_asset_id, 1000.00, 0, 1),
             (v_je_id, v_liab_id, 0, 999.99, 2);
    raise exception 'FAIL: unbalanced JE was accepted (should have raised P0001)';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: unbalanced JE rejected with P0001';
  end;

  -- 3) Close Q1 2026 atomically — all three months flip.
  update public.accounting_periods
    set status = 'closed', closed_at = now()
    where fiscal_year = 2026 and fiscal_quarter = 1;
  select count(*) into v_count
    from public.accounting_periods
    where fiscal_year = 2026 and fiscal_quarter = 1 and status = 'closed';
  if v_count <> 3 then
    raise exception 'FAIL: expected 3 closed months for Q1 2026, got %', v_count;
  end if;
  raise notice 'PASS: Q1 2026 atomically closed (3 months)';

  -- 4) Posted JE to closed period rejected.
  begin
    insert into public.journal_entries (posting_date, description, status, source_kind)
      values ('2026-02-15', 'smoke: closed period', 'posted', 'manual');
    raise exception 'FAIL: JE in closed period was accepted (should have raised P0002)';
  exception
    when sqlstate 'P0002' then
      raise notice 'PASS: JE in closed period rejected with P0002';
  end;

  -- 5) Reversal JE in an open period referencing a closed-period JE succeeds.
  --    Original is dated 2026-02-10 (Q1 2026). We reopen Q1 briefly to post it,
  --    then re-close Q1 so it becomes a closed-period entry. The reversal is
  --    then posted to 2026-05-01 (Q2, open), proving the exemption works.
  --    Reopen Q1 temporarily to post the original.
  update public.accounting_periods
    set status = 'open', closed_at = null, closed_by = null
    where fiscal_year = 2026 and fiscal_quarter = 1;
  insert into public.journal_entries (posting_date, description, status, source_kind)
    values ('2026-02-10', 'smoke: original for reversal (Q1 closed-period)', 'posted', 'manual')
    returning id into v_je_id;
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    values (v_je_id, v_asset_id, 500.00, 0, 1),
           (v_je_id, v_liab_id, 0, 500.00, 2);
  --    Re-close Q1 so the original now lives in a closed period.
  update public.accounting_periods
    set status = 'closed', closed_at = now()
    where fiscal_year = 2026 and fiscal_quarter = 1;
  --    Now post a reversal to May 2026 (Q2, still open) referencing the
  --    closed-period entry. This must succeed.
  insert into public.journal_entries (posting_date, description, status, source_kind, reverses)
    values ('2026-05-01', 'smoke: reversal of closed-period entry', 'posted', 'reversal', v_je_id)
    returning id into v_je_rev_id;
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    values (v_je_rev_id, v_asset_id, 0, 500.00, 1),
           (v_je_rev_id, v_liab_id, 500.00, 0, 2);
  raise notice 'PASS: reversal in open period (May 2026) of a closed-period entry (Feb 2026) succeeded';

  -- 6) Draft entries with unbalanced lines are OK.
  insert into public.journal_entries (posting_date, description, status, source_kind)
    values ('2026-06-20', 'smoke: draft unbalanced', 'draft', 'manual')
    returning id into v_je_id;
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    values (v_je_id, v_asset_id, 1000.00, 0, 1);  -- no matching credit
  raise notice 'PASS: draft JE allowed to be unbalanced';

  -- 7) Flipping draft → posted with unbalanced lines is rejected.
  begin
    update public.journal_entries set status = 'posted' where id = v_je_id;
    raise exception 'FAIL: draft→posted on unbalanced JE was accepted';
  exception
    when sqlstate 'P0001' then
      raise notice 'PASS: draft→posted on unbalanced JE rejected with P0001';
  end;

  -- 8) Entry numbers auto-assign with correct format, and the counter resets
  --    per year (a 2027 insert must produce JE-2027-0001).
  declare
    v_en text;
    v_je_2027_id uuid;
    v_en_2027 text;
  begin
    insert into public.journal_entries (posting_date, description, status, source_kind)
      values ('2026-07-01', 'smoke: auto-number 2026', 'posted', 'manual')
      returning id into v_je_id;
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_id, v_asset_id, 1.00, 0, 1),
             (v_je_id, v_liab_id, 0, 1.00, 2);
    select entry_number into v_en from public.journal_entries where id = v_je_id;
    if v_en not like 'JE-2026-%' then
      raise exception 'FAIL: entry_number % does not match JE-2026-NNNN format', v_en;
    end if;
    raise notice 'PASS: 2026 entry_number auto-assigned with correct format: %', v_en;

    -- Insert a JE dated 2027 and verify the counter resets to 0001.
    insert into public.journal_entries (posting_date, description, status, source_kind)
      values ('2027-01-01', 'smoke: auto-number 2027 reset', 'posted', 'manual')
      returning id into v_je_2027_id;
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_2027_id, v_asset_id, 2.00, 0, 1),
             (v_je_2027_id, v_liab_id, 0, 2.00, 2);
    select entry_number into v_en_2027 from public.journal_entries where id = v_je_2027_id;
    if v_en_2027 <> 'JE-2027-0001' then
      raise exception 'FAIL: first 2027 entry_number should be JE-2027-0001, got %', v_en_2027;
    end if;
    raise notice 'PASS: 2027 entry_number resets to JE-2027-0001';
  end;

  -- 9) period_status_for() works for known + unknown.
  if public.period_status_for('2026-02-15') <> 'closed' then
    raise exception 'FAIL: period_status_for(2026-02-15) should be closed';
  end if;
  if public.period_status_for('2026-06-15') <> 'open' then
    raise exception 'FAIL: period_status_for(2026-06-15) should be open';
  end if;
  if public.period_status_for('2099-01-01') <> 'unknown' then
    raise exception 'FAIL: period_status_for(2099-01-01) should be unknown';
  end if;
  raise notice 'PASS: period_status_for() correct for all three cases';

  -- 10) coa_account_has_open_period_postings() is true when the account has
  --     posted lines in an open period.
  --     v_asset_id has lines from steps 1, 5-reversal, 8, and 9 — all posted;
  --     some in open periods (2026-05, 2026-06, 2026-07, 2027-01).
  if not public.coa_account_has_open_period_postings(v_asset_id) then
    raise exception 'FAIL: v_asset_id should have open-period postings';
  end if;
  raise notice 'PASS: coa_account_has_open_period_postings true for asset with open-period lines';

  -- 11) Account with posted lines ONLY in closed periods returns false.
  --     Create a fresh account, post a JE in Q1 2026 (now closed), and
  --     verify the helper returns false.
  declare
    v_closed_only_id uuid;
    v_closed_je_id   uuid;
  begin
    insert into public.chart_of_accounts (code, name, type, normal_balance)
      values ('1099', 'Test Closed-Only', 'asset', 'debit')
      returning id into v_closed_only_id;
    -- Q1 is closed; reopen it briefly to post, then reclose.
    update public.accounting_periods
      set status = 'open', closed_at = null, closed_by = null
      where fiscal_year = 2026 and fiscal_quarter = 1;
    -- Assert the reopen was atomic: all three Q1 months must now be open.
    select count(*) into v_count
      from public.accounting_periods
      where fiscal_year = 2026 and fiscal_quarter = 1 and status = 'open';
    if v_count <> 3 then
      raise exception 'FAIL: reopen should have flipped all 3 Q1 months to open, got %', v_count;
    end if;
    raise notice 'PASS: Q1 2026 reopen is atomic (3 months flipped to open)';

    insert into public.journal_entries (posting_date, description, status, source_kind)
      values ('2026-02-10', 'smoke: closed-period-only line', 'posted', 'manual')
      returning id into v_closed_je_id;
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_closed_je_id, v_closed_only_id, 1.00, 0, 1),
             (v_closed_je_id, v_liab_id,        0,    1.00, 2);
    update public.accounting_periods
      set status = 'closed', closed_at = now()
      where fiscal_year = 2026 and fiscal_quarter = 1;
    if public.coa_account_has_open_period_postings(v_closed_only_id) then
      raise exception 'FAIL: account with only closed-period lines should return false';
    end if;
    raise notice 'PASS: coa_account_has_open_period_postings false for closed-period-only account';
  end;

  -- 12) Zero-line deletion guard (P0003): deleting all lines of a posted JE
  --     must raise P0003, not silently pass (0=0 false-positive).
  declare
    v_p3_je_id uuid;
  begin
    -- Create a balanced posted JE in an open period.
    insert into public.journal_entries (posting_date, description, status, source_kind)
      values ('2026-06-25', 'smoke: zero-line guard setup', 'posted', 'manual')
      returning id into v_p3_je_id;
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_p3_je_id, v_asset_id, 100.00, 0, 1),
             (v_p3_je_id, v_liab_id, 0, 100.00, 2);
    -- Attempt to delete ALL lines in one statement; must raise P0003.
    begin
      delete from public.journal_lines where entry_id = v_p3_je_id;
      raise exception 'FAIL: deleting all lines of a posted JE was accepted (should have raised P0003)';
    exception
      when sqlstate 'P0003' then
        raise notice 'PASS: deleting all lines of a posted JE raised P0003';
    end;
  end;

  -- 12b) Zero-line guard on status flip (P0003): flipping draft→posted with
  --      zero lines must also raise P0003.
  declare
    v_empty_je_id uuid;
  begin
    insert into public.journal_entries (posting_date, description, status, source_kind)
      values ('2026-06-26', 'smoke: zero-line status flip guard', 'draft', 'manual')
      returning id into v_empty_je_id;
    -- No lines inserted — attempt to post.
    begin
      update public.journal_entries set status = 'posted' where id = v_empty_je_id;
      raise exception 'FAIL: posting a zero-line JE was accepted (should have raised P0003)';
    exception
      when sqlstate 'P0003' then
        raise notice 'PASS: posting a zero-line JE raised P0003';
    end;
  end;

  raise notice 'ALL SMOKE TESTS PASSED';
end;
$$;

rollback;

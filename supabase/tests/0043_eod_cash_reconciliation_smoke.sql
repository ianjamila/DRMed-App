-- =============================================================================
-- 0043_eod_cash_reconciliation_smoke.sql
-- =============================================================================
-- 12.C smoke. Exercises bridge triggers, guards (P0015-P0019), staff_advances
-- sync, idempotency, and the cash_drawer_state function.
--
-- Run with:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0043_eod_cash_reconciliation_smoke.sql
-- or via Supabase MCP (note: MCP doesn't honor BEGIN/ROLLBACK — explicit
-- cleanup is at the bottom).
-- =============================================================================

begin;

do $$
declare
  v_actor_id          uuid;
  v_staff_id          uuid;
  v_shift_id          uuid;
  v_adj_id            uuid;
  v_advance_adj_id    uuid;
  v_other_adj_id      uuid;
  v_topup_adj_id      uuid;
  v_close_id          uuid;
  v_je_count          int;
  v_state             jsonb;
  v_advance_row       record;
  v_je                record;
  v_business_date     date := '2026-05-18'::date;
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

  -- ===== Assertion 1: baseline state with zero adjustments ==========
  v_state := public.cash_drawer_state(v_business_date, v_shift_id);
  if (v_state->>'opening_float_php')::numeric <> 2000 then
    raise exception 'A1 FAIL: expected opening_float=2000, got %', v_state->>'opening_float_php';
  end if;
  raise notice 'A1 PASS: baseline opening_float = 2000';

  -- ===== Assertion 2: float_topup +500 ==============================
  insert into public.eod_cash_adjustments (
    business_date, shift_id, kind, amount_php, contra_account_id, recorded_by
  ) values (
    v_business_date, v_shift_id, 'float_topup', 500,
    public.coa_uuid_for_code('1020'), v_staff_id
  ) returning id into v_topup_adj_id;

  v_state := public.cash_drawer_state(v_business_date, v_shift_id);
  if (v_state->>'opening_float_php')::numeric <> 2500 then
    raise exception 'A2 FAIL: expected opening_float=2500, got %', v_state->>'opening_float_php';
  end if;
  raise notice 'A2 PASS: float_topup 500 → opening_float = 2500';

  -- ===== Assertion 3: float_topup JE posts (DR 1010 / CR 1020) ======
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'cash_adjustment' and source_id = v_topup_adj_id and status = 'posted';
  if v_je_count <> 1 then
    raise exception 'A3 FAIL: expected 1 posted JE for topup, got %', v_je_count;
  end if;
  raise notice 'A3 PASS: topup JE posted';

  -- ===== Assertion 4: petty_cash with contra=6400 ===================
  insert into public.eod_cash_adjustments (
    business_date, shift_id, kind, amount_php, contra_account_id, recorded_by, payee
  ) values (
    v_business_date, v_shift_id, 'petty_cash', 350,
    public.coa_uuid_for_code('6400'), v_staff_id, 'Office staples'
  ) returning id into v_adj_id;

  v_state := public.cash_drawer_state(v_business_date, v_shift_id);
  if (v_state->>'cash_payouts_php')::numeric <> 350 then
    raise exception 'A4 FAIL: expected cash_payouts=350, got %', v_state->>'cash_payouts_php';
  end if;
  raise notice 'A4 PASS: petty_cash recorded, payouts=350';

  -- ===== Assertion 5: salary_advance creates staff_advances row =====
  insert into public.eod_cash_adjustments (
    business_date, shift_id, kind, amount_php, recorded_by, payee_staff_id
  ) values (
    v_business_date, v_shift_id, 'salary_advance', 1500, v_staff_id, v_staff_id
  ) returning id into v_advance_adj_id;

  select * into v_advance_row from public.staff_advances where source_adjustment_id = v_advance_adj_id;
  if v_advance_row.outstanding_balance_php <> 1500 or v_advance_row.status <> 'outstanding' then
    raise exception 'A5 FAIL: staff_advances row missing or wrong; got %', v_advance_row;
  end if;
  raise notice 'A5 PASS: salary_advance created staff_advances row';

  -- ===== Assertion 6: salary_advance JE goes DR 1130 / CR 1010 ======
  select je.id, jl.account_id as debit_account, coa.code as debit_code
    into v_je
    from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id and jl.debit_php > 0
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where je.source_kind = 'cash_adjustment' and je.source_id = v_advance_adj_id;
  if v_je.debit_code <> '1130' then
    raise exception 'A6 FAIL: expected DR 1130, got DR %', v_je.debit_code;
  end if;
  raise notice 'A6 PASS: salary_advance JE DR 1130';

  -- ===== Assertion 7: other_payout with null contra falls to 9999 ==
  insert into public.eod_cash_adjustments (
    business_date, shift_id, kind, amount_php, recorded_by, payee
  ) values (
    v_business_date, v_shift_id, 'other_payout', 200, v_staff_id, 'Unknown'
  ) returning id into v_other_adj_id;

  select coa.code into v_je.debit_code
    from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id and jl.debit_php > 0
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where je.source_kind = 'cash_adjustment' and je.source_id = v_other_adj_id;
  if v_je.debit_code <> '9999' then
    raise exception 'A7 FAIL: expected DR 9999 (suspense), got DR %', v_je.debit_code;
  end if;
  raise notice 'A7 PASS: other_payout with null contra → 9999';

  -- ===== Assertion 8: close day with non-zero variance ==============
  v_state := public.cash_drawer_state(v_business_date, v_shift_id);
  insert into public.eod_close_records (
    business_date, shift_id, opening_float_php, cash_payments_php,
    cash_payouts_php, expected_cash_php, counted_cash_php,
    variance_php, variance_reason, closed_by
  ) values (
    v_business_date, v_shift_id,
    (v_state->>'opening_float_php')::numeric,
    (v_state->>'cash_payments_php')::numeric,
    (v_state->>'cash_payouts_php')::numeric,
    (v_state->>'expected_cash_php')::numeric,
    (v_state->>'expected_cash_php')::numeric - 10,
    -10,
    '₱10 short — change error',
    v_staff_id
  ) returning id into v_close_id;

  -- variance JE expected: DR 6900 / CR 1010
  select coa.code into v_je.debit_code
    from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id and jl.debit_php > 0
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where je.source_kind = 'eod_close' and je.source_id = v_close_id;
  if v_je.debit_code <> '6900' then
    raise exception 'A8 FAIL: expected variance JE DR 6900, got DR %', v_je.debit_code;
  end if;
  raise notice 'A8 PASS: short variance JE DR 6900';

  -- ===== Assertion 9: P0015 blocks new adjustment after close ======
  begin
    insert into public.eod_cash_adjustments (
      business_date, shift_id, kind, amount_php, contra_account_id, recorded_by
    ) values (
      v_business_date, v_shift_id, 'petty_cash', 50,
      public.coa_uuid_for_code('6400'), v_staff_id
    );
    raise exception 'A9 FAIL: P0015 did not fire';
  exception when sqlstate 'P0015' then
    raise notice 'A9 PASS: P0015 blocked post-close adjustment';
  end;

  -- ===== Assertion 10: reopen releases the lock =====================
  update public.eod_close_records
    set status = 'reopened',
        reopened_at = now(),
        reopened_by = v_staff_id,
        reopen_reason = 'smoke test reopen'
    where id = v_close_id;

  insert into public.eod_cash_adjustments (
    business_date, shift_id, kind, amount_php, contra_account_id, recorded_by
  ) values (
    v_business_date, v_shift_id, 'petty_cash', 25,
    public.coa_uuid_for_code('6400'), v_staff_id
  );
  raise notice 'A10 PASS: reopen released the P0015 lock';

  -- ===== Assertion 11: P0017 blocks edit of amount after JE ========
  begin
    update public.eod_cash_adjustments
      set amount_php = 9999
      where id = v_adj_id;
    raise exception 'A11 FAIL: P0017 did not fire';
  exception when sqlstate 'P0017' then
    raise notice 'A11 PASS: P0017 blocked post-JE edit';
  end;

  -- ===== Assertion 12: void salary_advance zeros staff_advances ====
  update public.eod_cash_adjustments
    set voided_at = now(), voided_by = v_staff_id, void_reason = 'smoke'
    where id = v_advance_adj_id;

  select * into v_advance_row from public.staff_advances where source_adjustment_id = v_advance_adj_id;
  if v_advance_row.outstanding_balance_php <> 0 or v_advance_row.status <> 'voided' then
    raise exception 'A12 FAIL: staff_advances not zeroed/voided; got %', v_advance_row;
  end if;
  raise notice 'A12 PASS: void salary_advance → staff_advances voided';

  -- ===== Assertion 13: P0018 blocks negative outstanding ===========
  begin
    update public.staff_advances
      set outstanding_balance_php = -1
      where source_adjustment_id = v_advance_adj_id;
    raise exception 'A13 FAIL: P0018 did not fire';
  exception when sqlstate 'P0018' then
    raise notice 'A13 PASS: P0018 blocked overdraw';
  when check_violation then
    -- column CHECK fires first; also acceptable
    raise notice 'A13 PASS: column CHECK blocked overdraw';
  end;

  -- ===== Assertion 14: P0019 blocks mapping to inactive account ====
  -- Use 9999 which is type=memo but is_active=true. Flip an existing CoA to inactive temporarily.
  begin
    update public.chart_of_accounts set is_active = false where code = '6420';
    begin
      update public.cash_adjustment_account_map
        set account_id = public.coa_uuid_for_code('6420')
        where kind = 'courier';
      raise exception 'A14 FAIL: P0019 did not fire';
    exception when sqlstate 'P0019' then
      raise notice 'A14 PASS: P0019 blocked inactive-account mapping';
    end;
    update public.chart_of_accounts set is_active = true where code = '6420';
  end;

  -- ===== Assertion 15: salary_advance CHECK requires payee_staff_id ====
  begin
    insert into public.eod_cash_adjustments (
      business_date, shift_id, kind, amount_php, recorded_by
    ) values (
      v_business_date + 1, v_shift_id, 'salary_advance', 500, v_staff_id
    );
    raise exception 'A15 FAIL: CHECK did not fire for salary_advance w/o payee_staff_id';
  exception when check_violation then
    raise notice 'A15 PASS: CHECK forces payee_staff_id for salary_advance';
  end;

  -- ===== Assertion 16: variance_reason required when variance != 0 ==
  begin
    insert into public.eod_close_records (
      business_date, shift_id, opening_float_php, cash_payments_php,
      cash_payouts_php, expected_cash_php, counted_cash_php,
      variance_php, variance_reason, closed_by
    ) values (
      v_business_date + 1, v_shift_id, 2000, 0, 0, 2000, 1990, -10, null, v_staff_id
    );
    raise exception 'A16 FAIL: CHECK did not fire';
  exception when check_violation then
    raise notice 'A16 PASS: variance_reason required when variance != 0';
  end;

  -- ===== Assertion 17: v_daily_revenue_by_service returns rows =====
  -- Smoke just verifies view shape; data depends on test_requests state.
  perform * from public.v_daily_revenue_by_service limit 1;
  raise notice 'A17 PASS: v_daily_revenue_by_service queryable';

  -- ===== Assertion 18: v_staff_advances_outstanding aggregates =====
  perform * from public.v_staff_advances_outstanding limit 1;
  raise notice 'A18 PASS: v_staff_advances_outstanding queryable';

  -- ===== Assertion 19: every posted JE balances (DR = CR) ==========
  if exists (
    select je.id
    from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id
    where je.source_kind in ('cash_adjustment', 'eod_close')
      and je.status = 'posted'
    group by je.id
    having sum(jl.debit_php) <> sum(jl.credit_php)
  ) then
    raise exception 'A19 FAIL: at least one 12.C JE is unbalanced';
  end if;
  raise notice 'A19 PASS: all 12.C JEs balance';

  -- ===== Assertion 20: cash_drawer_state expected_cash math =========
  v_state := public.cash_drawer_state(v_business_date, v_shift_id);
  -- baseline 2000 + topup 500 = 2500 opening; payouts 350 (petty) + 1500 (advance, voided so excluded) + 200 (other) + 25 (post-reopen petty) = 575
  -- Wait: advance was voided after close → not in active sum. petty 350 + other 200 + post-reopen 25 = 575
  -- cash_payments 0; expected = 2500 + 0 - 575 = 1925
  if (v_state->>'expected_cash_php')::numeric <> 1925 then
    raise exception 'A20 FAIL: expected expected_cash=1925, got %', v_state->>'expected_cash_php';
  end if;
  raise notice 'A20 PASS: cash_drawer_state expected_cash math correct';

  raise notice '===== ALL 12.C SMOKE ASSERTIONS PASSED =====';
end;
$$;

rollback;

-- =============================================================================
-- Explicit cleanup (run if executed via Supabase MCP, which doesn't honor
-- BEGIN/ROLLBACK). Idempotent.
-- =============================================================================

-- Nothing to clean here — the smoke runs inside BEGIN/ROLLBACK. If run via
-- MCP, replace the `rollback;` above with explicit DELETEs:
--
-- update public.journal_entries set reverses = null, reversed_by = null
--   where source_kind in ('cash_adjustment','eod_close','reversal')
--     and posting_date = '2026-05-18';
-- delete from public.journal_lines where entry_id in (
--   select id from public.journal_entries
--   where source_kind in ('cash_adjustment','eod_close','reversal')
--     and posting_date = '2026-05-18'
-- );
-- delete from public.journal_entries
--   where source_kind in ('cash_adjustment','eod_close','reversal')
--     and posting_date = '2026-05-18';
-- delete from public.staff_advances
--   where business_date = '2026-05-18';
-- delete from public.eod_close_records where business_date = '2026-05-18';
-- delete from public.eod_cash_adjustments where business_date in ('2026-05-18','2026-05-19');
-- update public.je_year_counters set next_n = 1 where fiscal_year = 2026;

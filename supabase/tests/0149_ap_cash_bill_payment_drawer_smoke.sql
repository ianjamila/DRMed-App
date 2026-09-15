-- =============================================================================
-- 0149_ap_cash_bill_payment_drawer_smoke.sql
-- =============================================================================
-- The third cash door. Proves the property 0149 exists for — an AP bill paid
-- in cash moves the DRAWER as well as the books, exactly once — plus the four
-- ways it could have gone wrong:
--
--   A  cash bill payment against 1010  → drawer row written, linked, dated to
--      the payment date; expected_cash_php drops by the amount
--   B  the SAME payment credits 1010 exactly ONCE in the GL (the drawer row
--      posts no JE of its own — this is the double-credit 0145 was about)
--   C  a payment against 1020 BPI      → NO drawer row (it never touched the till)
--   D  the paid-on-entry door          → drawer row written too
--   E  voiding the AP payment          → drawer row voided, expected cash restored
--   F  voiding the drawer row directly → P0052
--   G  the biconditional CHECK         → a bare bill_payment row is rejected
--   H  a closed day                    → P0015, and the whole payment rolls back
--   I  VOIDING on a closed day          → P0015 too (the lock guards UPDATE, and
--      the void mirror is an UPDATE) — the common case, not an edge one
--
-- Run it against the LOCAL stack, not prod:
--   supabase db reset && psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -f supabase/tests/0149_ap_cash_bill_payment_drawer_smoke.sql
--
-- It runs inside BEGIN/ROLLBACK, so nothing survives; via Supabase MCP (which
-- does not honour BEGIN/ROLLBACK) use the explicit cleanup at the bottom.
-- =============================================================================

begin;

do $$
declare
  v_actor_id     uuid;
  v_shift_id     uuid;
  v_vendor_id    uuid;
  v_bill_id      uuid;
  v_payment_id   uuid;
  v_bank_pay_id  uuid;
  v_poe_pay_id   uuid;
  v_expense_acct uuid;
  v_till_acct    uuid;
  v_bank_acct    uuid;
  v_adj          record;
  v_state        jsonb;
  v_expected_before numeric(14,2);
  v_credits      int;
  v_date         date := '2026-05-18'::date;
  v_amount       numeric(12,2) := 1234.00;
begin
  -- ---- setup -------------------------------------------------------------
  -- Self-seeding, so this runs on a bare `supabase db reset` with no staff
  -- fixtures loaded. Everything here is rolled back with the rest.
  select id into v_actor_id from public.staff_profiles where is_active = true limit 1;
  if v_actor_id is null then
    v_actor_id := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at)
    values (v_actor_id, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', 'smoke-0149@example.test', '', now(), now(), now());
    insert into public.staff_profiles (id, full_name, role, is_active)
    values (v_actor_id, 'SMOKE 0149 Admin', 'admin', true);
  end if;

  select id into v_shift_id
    from public.cash_shifts where is_active = true order by sort_order, code limit 1;
  if v_shift_id is null then
    raise exception 'SMOKE SETUP FAIL: no active cash shift';
  end if;

  v_till_acct := public.coa_uuid_for_code('1010');
  v_bank_acct := public.coa_uuid_for_code('1020');
  v_expense_acct := public.coa_uuid_for_code('6400');
  if v_till_acct is null or v_bank_acct is null or v_expense_acct is null then
    raise exception 'SMOKE SETUP FAIL: chart of accounts is missing 1010/1020/6400';
  end if;

  insert into public.vendors (name, is_active)
  values ('SMOKE 0149 Vendor', true)
  returning id into v_vendor_id;

  select (jsonb_build_object('x', public.cash_drawer_state(v_date, v_shift_id))->'x'->>'expected_cash_php')::numeric
    into v_expected_before;

  -- ---- A: cash bill payment against 1010 writes the drawer row -----------
  v_bill_id := (public.ap_create_bill_and_post(jsonb_build_object(
      'vendor_id', v_vendor_id,
      'bill_date', v_date,
      'due_date',  v_date,
      'description', 'SMOKE 0149 bill',
      'wt_exempt', true,
      'lines', jsonb_build_array(jsonb_build_object(
        'line_no', 1, 'description', 'smoke', 'amount_php', v_amount,
        'account_id', v_expense_acct))
    ), v_actor_id, gen_random_uuid())->>'bill_id')::uuid;

  v_payment_id := (public.ap_create_bill_payment_with_allocations(jsonb_build_object(
      'vendor_id', v_vendor_id,
      'payment_date', v_date,
      'method', 'cash',
      'cash_account_id', v_till_acct,
      'amount_php', v_amount,
      'allocations', jsonb_build_array(jsonb_build_object(
        'bill_id', v_bill_id, 'allocated_amount', v_amount))
    ), v_actor_id)->>'payment_id')::uuid;

  select * into v_adj from public.eod_cash_adjustments where bill_payment_id = v_payment_id;
  if v_adj.id is null then
    raise exception 'A FAIL: cash bill payment wrote no eod_cash_adjustments row';
  end if;
  if v_adj.kind <> 'bill_payment' then
    raise exception 'A FAIL: drawer row kind is %, expected bill_payment', v_adj.kind;
  end if;
  if v_adj.business_date <> v_date then
    raise exception 'A FAIL: drawer row is dated % not the payment date %', v_adj.business_date, v_date;
  end if;
  if v_adj.amount_php <> v_amount then
    raise exception 'A FAIL: drawer row is % not %', v_adj.amount_php, v_amount;
  end if;
  if v_adj.shift_id <> v_shift_id then
    raise exception 'A FAIL: drawer row landed on the wrong shift';
  end if;

  v_state := public.cash_drawer_state(v_date, v_shift_id);
  if (v_state->>'expected_cash_php')::numeric <> v_expected_before - v_amount then
    raise exception 'A FAIL: expected_cash_php is % , expected %',
      v_state->>'expected_cash_php', v_expected_before - v_amount;
  end if;
  if (v_state->>'bill_payments_php')::numeric <> v_amount then
    raise exception 'A FAIL: bill_payments_php is %, expected %',
      v_state->>'bill_payments_php', v_amount;
  end if;

  -- ---- B: 1010 is credited exactly once ---------------------------------
  select count(*) into v_credits
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    where l.account_id = v_till_acct
      and l.credit_php = v_amount
      and e.status = 'posted'
      and e.posting_date = v_date;
  if v_credits <> 1 then
    raise exception 'B FAIL: 1010 credited % times for one payment (double-post is the 0145 bug)', v_credits;
  end if;
  if exists (
    select 1 from public.journal_entries
    where source_kind = 'cash_adjustment' and source_id = v_adj.id
  ) then
    raise exception 'B FAIL: the drawer row posted its own JE — the AP bridge already did';
  end if;

  -- ---- C: a bank payment writes no drawer row ---------------------------
  v_bank_pay_id := (public.ap_create_bill_payment_with_allocations(jsonb_build_object(
      'vendor_id', v_vendor_id,
      'payment_date', v_date,
      'method', 'bank_transfer',
      'cash_account_id', v_bank_acct,
      'amount_php', 1.00,
      'allocations', jsonb_build_array()
    ), v_actor_id)->>'payment_id')::uuid;

  if exists (select 1 from public.eod_cash_adjustments where bill_payment_id = v_bank_pay_id) then
    raise exception 'C FAIL: a payment against 1020 BPI produced a cash-drawer row';
  end if;

  -- ---- D: the paid-on-entry door is covered too -------------------------
  v_poe_pay_id := (public.ap_create_bill_paid_on_entry(jsonb_build_object(
      'vendor_id', v_vendor_id,
      'bill_date', v_date,
      'due_date',  v_date,
      'description', 'SMOKE 0149 paid on entry',
      'wt_exempt', true,
      'lines', jsonb_build_array(jsonb_build_object(
        'line_no', 1, 'description', 'smoke poe', 'amount_php', 50.00,
        'account_id', v_expense_acct)),
      'payment_date', v_date,
      'method', 'cash',
      'cash_account_id', v_till_acct
    ), v_actor_id)->>'payment_id')::uuid;

  if not exists (
    select 1 from public.eod_cash_adjustments
    where bill_payment_id = v_poe_pay_id and kind = 'bill_payment' and amount_php = 50.00
  ) then
    raise exception 'D FAIL: paid-on-entry left the till without telling the drawer';
  end if;

  -- ---- F: the drawer row cannot be voided on its own (P0052) ------------
  -- Before E, because E voids the payment and frees the row.
  begin
    update public.eod_cash_adjustments
      set voided_at = now(), voided_by = v_actor_id, void_reason = 'smoke'
      where id = v_adj.id;
    raise exception 'F FAIL: a direct void of a bill_payment drawer row was allowed';
  exception when sqlstate 'P0052' then
    null;
  end;

  -- ---- E: voiding the AP payment carries the drawer row with it ---------
  perform public.ap_void_bill_payment_cascade(v_payment_id, 'smoke void', v_actor_id);

  select * into v_adj from public.eod_cash_adjustments where bill_payment_id = v_payment_id;
  if v_adj.voided_at is null then
    raise exception 'E FAIL: the AP void left the drawer row live — the till would be short forever';
  end if;
  if v_adj.voided_by is null then
    raise exception 'E FAIL: voided_by is null, which the void-consistency CHECK forbids';
  end if;

  v_state := public.cash_drawer_state(v_date, v_shift_id);
  if (v_state->>'expected_cash_php')::numeric <> v_expected_before - 50.00 then
    raise exception 'E FAIL: expected_cash_php did not come back after the void (got %, expected %)',
      v_state->>'expected_cash_php', v_expected_before - 50.00;
  end if;

  -- ---- G: the biconditional CHECK ---------------------------------------
  begin
    insert into public.eod_cash_adjustments
      (business_date, shift_id, kind, amount_php, recorded_by)
    values (v_date, v_shift_id, 'bill_payment', 1.00, v_actor_id);
    raise exception 'G FAIL: a bill_payment row with no bill_payment_id was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.eod_cash_adjustments
      (business_date, shift_id, kind, amount_php, recorded_by, bill_payment_id)
    values (v_date, v_shift_id, 'other_payout', 1.00, v_actor_id, v_bank_pay_id);
    raise exception 'G FAIL: a bill_payment_id hidden under kind=other_payout was accepted';
  exception when check_violation then
    null;
  end;

  -- ---- H: a closed day refuses the whole payment (P0015) ----------------
  insert into public.eod_close_records (
    business_date, shift_id, status, opening_float_php, cash_payments_php,
    cash_payouts_php, expected_cash_php, counted_cash_php, variance_php, closed_by
  ) values (v_date, v_shift_id, 'closed', 0, 0, 0, 0, 0, 0, v_actor_id);

  begin
    perform public.ap_create_bill_payment_with_allocations(jsonb_build_object(
      'vendor_id', v_vendor_id,
      'payment_date', v_date,
      'method', 'cash',
      'cash_account_id', v_till_acct,
      'amount_php', 5.00,
      'allocations', jsonb_build_array()
    ), v_actor_id);
    raise exception 'H FAIL: a cash bill payment landed on an already-closed day';
  exception when sqlstate 'P0015' then
    null;
  end;

  -- ---- I: voiding on a closed day is refused too ------------------------
  -- The paid-on-entry payment from D is still live and dated to the day just
  -- closed. Its void mirror is an UPDATE on the drawer row, and the day-close
  -- lock guards UPDATE as well as INSERT — so the whole cascade, reversal JE
  -- included, rolls back. Correct (the count is signed off) and the same way
  -- voidTillCashExpense has behaved since 0043, but it is why the AP payment
  -- page pre-flights the void and P0015 gets a void-specific message.
  begin
    perform public.ap_void_bill_payment_cascade(v_poe_pay_id, 'smoke void on closed day', v_actor_id);
    raise exception 'I FAIL: a till payment was voided out of an already-closed day';
  exception when sqlstate 'P0015' then
    null;
  end;

  raise notice '0149 SMOKE PASS: A B C D E F G H I';
end;
$$;

rollback;

-- =============================================================================
-- Explicit cleanup (only needed if executed via Supabase MCP, which does not
-- honour BEGIN/ROLLBACK). Idempotent.
-- =============================================================================
-- delete from public.eod_cash_adjustments where business_date = '2026-05-18';
-- delete from public.eod_close_records   where business_date = '2026-05-18';
-- delete from public.bill_payment_allocations where payment_id in (
--   select id from public.bill_payments where vendor_id in (
--     select id from public.vendors where name = 'SMOKE 0149 Vendor'));
-- delete from public.bill_payments where vendor_id in (
--   select id from public.vendors where name = 'SMOKE 0149 Vendor');
-- delete from public.bill_lines where bill_id in (
--   select id from public.bills where vendor_id in (
--     select id from public.vendors where name = 'SMOKE 0149 Vendor'));
-- delete from public.bills   where vendor_id in (
--   select id from public.vendors where name = 'SMOKE 0149 Vendor');
-- delete from public.vendors where name = 'SMOKE 0149 Vendor';
-- -- plus the journal_entries / journal_lines cleanup shown in the 0043 smoke.

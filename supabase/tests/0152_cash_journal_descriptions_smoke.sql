-- LOCAL ONLY. Run after migrations with psql -v ON_ERROR_STOP=1 -f this-file.
-- Exercises the real bridge through a temporary trigger table. It deliberately
-- isolates description/posting behavior from the gift-code and AP creation
-- workflows; 0149's smoke separately tests the real bill-payment integration.
begin;

create temporary table cash_description_inputs
  (like public.eod_cash_adjustments including defaults);
create trigger cash_description_bridge after insert on cash_description_inputs
  for each row execute function public.bridge_cash_adjustment_insert();

do $$
declare
  actor uuid := gen_random_uuid();
  shift uuid;
  source uuid;
  entry uuid;
  actual text;
  item record;
  cash_debit numeric;
  cash_credit numeric;
  n integer;
begin
  insert into auth.users (id, email) values (actor, 'smoke-0152@example.test');
  insert into public.staff_profiles (id, full_name, role)
    values (actor, 'SMOKE 0152 Admin', 'admin');
  select id into shift from public.cash_shifts where is_active order by sort_order, code limit 1;
  insert into public.accounting_periods
    (period_start, period_end, fiscal_year, fiscal_quarter, fiscal_month)
    values ('2035-01-01', '2035-01-31', 2035, 1, 1)
    on conflict (period_start, period_end) do nothing;

  for item in select * from (values
    ('petty_cash', 'Petty cash', false),
    ('salary_advance', 'Salary advance', false),
    ('courier', 'Courier / delivery', false),
    ('other_payout', 'Other cash payout', false),
    ('float_topup', 'Cash added to drawer', true),
    ('float_pullout', 'Cash removed from drawer', false),
    ('salary_payout', 'Salary payout', false),
    ('gift_code_sale', 'Gift code sold', true)
  ) as kinds(kind, label, cash_in) loop
    source := gen_random_uuid();
    -- Two inserts with the same source prove idempotency, not just balancing.
    for n in 1..2 loop
      insert into cash_description_inputs
        (id, business_date, shift_id, kind, amount_php, payee, recorded_by)
      values (source, '2035-01-15', shift, item.kind, 123.45,
              case when item.kind = 'petty_cash' then 'Grab' else null end, actor);
    end loop;

    select count(*) into n from public.journal_entries
      where source_kind = 'cash_adjustment' and source_id = source;
    if n <> 1 then raise exception 'duplicate or absent JE for %', item.kind; end if;
    select id, description into entry, actual from public.journal_entries
      where source_kind = 'cash_adjustment' and source_id = source
        and status = 'posted' and posting_date = '2035-01-15';
    if actual is distinct from (item.label || case when item.kind = 'petty_cash' then ' · Grab' else '' end) then
      raise exception 'wrong description for %: %', item.kind, actual;
    end if;
    if (select sum(debit_php) from public.journal_lines where entry_id = entry) <> 123.45
       or (select sum(credit_php) from public.journal_lines where entry_id = entry) <> 123.45 then
      raise exception 'unbalanced or changed amount for %', item.kind;
    end if;
    select debit_php, credit_php into cash_debit, cash_credit
      from public.journal_lines where entry_id = entry
        and account_id = public.coa_uuid_for_code('1010');
    if cash_debit is distinct from (case when item.cash_in then 123.45 else 0 end)
       or cash_credit is distinct from (case when item.cash_in then 0 else 123.45 end) then
      raise exception 'wrong cash direction for %', item.kind;
    end if;
  end loop;

  source := gen_random_uuid();
  insert into cash_description_inputs
    (id, business_date, shift_id, kind, amount_php, recorded_by)
  values (source, '2035-01-15', shift, 'bill_payment', 123.45, actor);
  if exists (select 1 from public.journal_entries where source_id = source) then
    raise exception 'bill payment must not post a second JE';
  end if;
  if has_function_privilege('anon', 'public.bridge_cash_adjustment_insert()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.bridge_cash_adjustment_insert()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.bridge_cash_adjustment_insert()', 'EXECUTE') then
    raise exception 'bridge ACL changed';
  end if;
  raise notice 'PASS: eight descriptions, optional payee, amounts, cash directions, idempotency, bill-payment skip and ACL';
end;
$$;
rollback;

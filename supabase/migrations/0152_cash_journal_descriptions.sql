-- Plain-language descriptions for cash-adjustment journal entries.
-- 0151 is reserved by perf/rls-initplan-realtime; verified across open branches.
-- Copy of the latest bridge (0149), changing ONLY the description expression.
-- Retains bill-payment early return, money direction, idempotency, Manila date,
-- suspense audit and service-role-only ACL. No historical rows are rewritten:
-- production has no cash-adjustment JEs at the time of this migration.

create or replace function public.bridge_cash_adjustment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_je_id          uuid;
  v_existing_je    uuid;
  v_cash_id        uuid;
  v_contra_id      uuid;
  v_used_suspense  boolean;
  v_debit_acct     uuid;
  v_credit_acct    uuid;
begin
  -- 0149: the AP subledger already posted DR 2100 / CR 1010 for this outflow
  -- (ap_bill_payment_bridge, source_kind='bill_payment'). Posting again here
  -- would credit 1010 twice. The row exists only so cash_drawer_state sees the
  -- payout; its GL life belongs to the bill_payment, including the reversal
  -- ap_void_bill_payment_cascade posts on void.
  if NEW.kind = 'bill_payment' then
    return NEW;
  end if;

  -- Idempotency.
  select id into v_existing_je
    from public.journal_entries
    where source_kind = 'cash_adjustment'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  v_cash_id := public.coa_uuid_for_code('1010');

  select r.account_id, r.used_suspense
    into v_contra_id, v_used_suspense
    from public.resolve_cash_adjustment_account(NEW.kind, NEW.contra_account_id) r;

  -- Direction: float_topup and gift_code_sale are cash IN; everything else is
  -- cash OUT (0139 added gift_code_sale — a gift-code sale collects cash over
  -- the counter, same drawer direction as a float top-up).
  if NEW.kind in ('float_topup', 'gift_code_sale') then
    v_debit_acct  := v_cash_id;
    v_credit_acct := v_contra_id;
  else
    v_debit_acct  := v_contra_id;
    v_credit_acct := v_cash_id;
  end if;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    NEW.business_date,
    case NEW.kind
      when 'petty_cash' then 'Petty cash'
      when 'salary_advance' then 'Salary advance'
      when 'courier' then 'Courier / delivery'
      when 'other_payout' then 'Other cash payout'
      when 'float_topup' then 'Cash added to drawer'
      when 'float_pullout' then 'Cash removed from drawer'
      when 'salary_payout' then 'Salary payout'
      when 'gift_code_sale' then 'Gift code sold'
      else initcap(replace(NEW.kind, '_', ' '))
    end || coalesce(' · ' || NEW.payee, ''),
    'draft',
    'cash_adjustment',
    NEW.id,
    NEW.recorded_by
  )
  returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values
    (v_je_id, v_debit_acct,  NEW.amount_php, 0, 1),
    (v_je_id, v_credit_acct, 0, NEW.amount_php, 2);

  update public.journal_entries set status = 'posted' where id = v_je_id;

  if v_used_suspense then
    insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
    values (
      NEW.recorded_by,
      'staff',
      'coa.suspense_post',
      'journal_entries',
      v_je_id,
      jsonb_build_object(
        'source_kind', 'cash_adjustment',
        'source_id',   NEW.id,
        'reason',      'cash adjustment kind required contra choice but received null',
        'kind',        NEW.kind
      )
    );
  end if;

  return NEW;
end;
$$;

revoke execute on function public.bridge_cash_adjustment_insert() from public, anon, authenticated;
grant  execute on function public.bridge_cash_adjustment_insert() to service_role;

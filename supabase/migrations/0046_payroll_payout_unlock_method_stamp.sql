-- 0046 — allow payment_method_used null→non-null transition at payout time
--
-- The 0044 trigger payroll_run_locked_after_payout blocked ANY change to
-- payment_method_used after the first paid sibling in a run. But cash
-- mark-paid stamps payment_method_used at payout time (null on the
-- employee_run row, then 'cash' on the UPDATE that flips payout_status).
-- That stamp triggered the lock and produced "Cannot edit employee_run
-- after payouts have started" — the second cash payout of a run with a
-- prior bank payout (or vice versa) was unreachable.
--
-- Fix: the diff check on payment_method_used now only fires when OLD was
-- already non-null (i.e. the column is being overwritten, not stamped).
-- All other blocked-field semantics are unchanged.

create or replace function public.payroll_run_locked_after_payout()
returns trigger
language plpgsql as $$
declare
  v_run_id uuid;
  v_any_paid boolean;
begin
  if TG_TABLE_NAME = 'payroll_employee_runs' then
    v_run_id := coalesce(NEW.run_id, OLD.run_id);
  else
    v_run_id := coalesce(NEW.id, OLD.id);
  end if;
  select exists(select 1 from public.payroll_employee_runs
    where run_id = v_run_id and payout_status = 'paid')
    into v_any_paid;
  if v_any_paid then
    if TG_TABLE_NAME = 'payroll_employee_runs' then
      if (NEW.payment_method_used is distinct from OLD.payment_method_used
           and OLD.payment_method_used is not null)
         or NEW.basic_pay_php is distinct from OLD.basic_pay_php
         or NEW.gross_pay_php is distinct from OLD.gross_pay_php
         or NEW.net_pay_php is distinct from OLD.net_pay_php
         or NEW.scheduled_days is distinct from OLD.scheduled_days then
        raise exception 'Cannot edit employee_run after payouts have started. Adjust in next period.'
          using errcode = 'P0021';
      end if;
      return NEW;
    end if;
    if TG_TABLE_NAME = 'payroll_runs' and NEW.status is distinct from OLD.status then
      if NEW.status not in ('finalised') then
        raise exception 'Cannot change run status after payouts have started.'
          using errcode = 'P0021';
      end if;
    end if;
  end if;
  return NEW;
end;
$$;

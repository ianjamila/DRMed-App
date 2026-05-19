-- 0047 — fix P0020 finalise guard double-counting holiday-worked days
--
-- The 0044 guard `payroll_run_finalise_requires_dtr` sums `days_present`
-- plus every `days_*_holiday_worked` bucket when checking against
-- `scheduled_days`. But the compute engine (src/lib/payroll/compute.ts
-- §6.2) counts a holiday that the employee WORKED in BOTH `days_present`
-- AND the matching `days_*_holiday_worked` bucket — by design, since
-- `basic_paid_days = present_regular + present_*_holiday + vl_used +
-- sl_used`. So a regular employee who shows up on Labor Day registers
-- `days_present = 1` + `days_regular_holiday_worked = 1`, which the
-- guard sees as 2 accounted days against 1 scheduled, blocking finalise.
--
-- Fix: drop the *_holiday_worked buckets from the accounted sum since
-- they're already subsumed in `days_present`. The *_holiday_UNWORKED
-- buckets stay (they aren't in days_present and represent
-- nobody-shows-up-on-the-holiday days). Discovered during the 12.6 D5
-- E2E smoke (project_12.6_followups.md item 26).
--
-- Net effect: the day-balance equation is now
--   accounted = days_present + days_vl_used + days_sl_used
--               + days_unpaid_absent
--               + days_regular_holiday_unworked
--               + days_special_holiday_unworked
-- which equals `scheduled_days` whenever every scheduled day is
-- accounted for exactly once.

create or replace function public.payroll_run_finalise_requires_dtr()
returns trigger
language plpgsql as $$
declare
  v_offender record;
begin
  if NEW.status <> 'finalised' or OLD.status = 'finalised' then
    return NEW;
  end if;
  select er.id, er.scheduled_days,
    (er.days_present + er.days_vl_used + er.days_sl_used + er.days_unpaid_absent
     + er.days_regular_holiday_unworked
     + er.days_special_holiday_unworked) as accounted
    into v_offender
    from public.payroll_employee_runs er
    where er.run_id = NEW.id
      and (er.days_present + er.days_vl_used + er.days_sl_used + er.days_unpaid_absent
           + er.days_regular_holiday_unworked
           + er.days_special_holiday_unworked)
          <> er.scheduled_days
    limit 1;
  if v_offender.id is not null then
    raise exception 'Cannot finalise: employee_run % has % accounted vs % scheduled days. Check DTR + leave records.',
      v_offender.id, v_offender.accounted, v_offender.scheduled_days
      using errcode = 'P0020';
  end if;
  return NEW;
end;
$$;

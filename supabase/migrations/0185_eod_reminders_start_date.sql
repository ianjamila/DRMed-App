-- 0185: End of Day reminders — an admin-set start date, and the reader that
-- lists the days since then that were never closed.
--
-- No day has ever been closed on prod (eod_close_records is empty), so a
-- reminder that looked back over all history would flag every day the clinic
-- has been open. The owner picks when closing starts to count; until then the
-- setting is blank and every reminder stays silent. Closing a past day is NOT
-- restricted by this date — the End of Day picker still reaches any day on or
-- before today (CloseEodSchema). The date only decides what is flagged.
--
-- Read by: Cash In & Out and End of Day (the "not closed" nudge) and Admin ›
-- Operations › Cash & cards (the "Not closed" rows). Written by Money Routing.

-- ---- the setting --------------------------------------------------------------
-- accounting_settings.key is a closed list (0043, widened by 0044). Restate it
-- with the new key; a key on prod outside this list makes the ADD fail loudly
-- rather than silently dropping it.
alter table public.accounting_settings drop constraint accounting_settings_key_check;
alter table public.accounting_settings add constraint accounting_settings_key_check check (key in (
  'default_change_fund_php',
  'tardiness_per_minute_php',
  'tardiness_threshold_for_halfday_deduction',
  'perfect_attendance_bonus_php',
  'standard_workday_minutes',
  'scheduled_start_hour',
  'scheduled_start_minute',
  'scheduled_end_hour',
  'scheduled_end_minute',
  'lunch_break_minutes',
  'night_diff_premium_rate',
  'night_diff_start_hour',
  'night_diff_end_hour',
  'ot_rate_regular_day',
  'ot_rate_rest_day',
  'holiday_pay_regular_worked',
  'holiday_pay_regular_unworked',
  'holiday_pay_special_worked',
  'holiday_pay_special_unworked',
  'staff_advance_settlement_max_pct',
  'eod_reminders_start_date'
));

-- The reader casts value_text to a date; a malformed value would turn every
-- page that shows a reminder into an error page, so refuse it at the door.
alter table public.accounting_settings
  add constraint accounting_settings_eod_start_is_date check (
    key <> 'eod_reminders_start_date'
    or value_text is null
    or value_text ~ '^\d{4}-\d{2}-\d{2}$'
  );

insert into public.accounting_settings (key, value_text, description)
values (
  'eod_reminders_start_date',
  null,
  'First business date (YYYY-MM-DD) the End of Day reminders count from. Blank = reminders off.'
)
on conflict (key) do nothing;

-- ---- the reader ---------------------------------------------------------------
-- Days in [p_from, p_to] — clamped to [start date, yesterday in Manila] — that
-- moved cash through this shift's drawer and have no 'closed' record. "Moved
-- cash" and "closed" are read from cash_drawer_state itself, so a day flagged
-- here is exactly a day whose End of Day screen shows an open count with
-- something to count. Today is never flagged: it is still being worked.
create or replace function public.eod_unclosed_days(
  p_from     date,
  p_to       date,
  p_shift_id uuid
)
returns setof date
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_start date;
  v_from  date;
  v_to    date;
  v_day   date;
  v_state jsonb;
begin
  -- The CHECK only pins the shape; a shape-valid non-date (2026-13-45) reads
  -- as "off" here instead of failing every page that shows a reminder.
  begin
    select value_text::date into v_start
      from public.accounting_settings
      where key = 'eod_reminders_start_date';
  exception when invalid_datetime_format or datetime_field_overflow then
    v_start := null;
  end;
  if v_start is null or p_shift_id is null then
    return;
  end if;

  v_from := greatest(coalesce(p_from, v_start), v_start);
  v_to   := least(
    coalesce(p_to, (now() at time zone 'Asia/Manila')::date - 1),
    (now() at time zone 'Asia/Manila')::date - 1
  );
  -- One cash_drawer_state call per day: bound the walk to a year back from
  -- the end, which is far past any range a screen asks for.
  v_from := greatest(v_from, v_to - 366);

  for v_day in select g::date from generate_series(v_from, v_to, interval '1 day') g loop
    v_state := public.cash_drawer_state(v_day, p_shift_id);
    if jsonb_typeof(v_state -> 'closed') is distinct from 'object'
       and (
         coalesce((v_state ->> 'cash_payments_php')::numeric, 0)   <> 0
         or coalesce((v_state ->> 'gift_code_sales_php')::numeric, 0) <> 0
         or coalesce((v_state ->> 'cash_payouts_php')::numeric, 0)    <> 0
         or coalesce((v_state ->> 'float_topups_php')::numeric, 0)    <> 0
         or coalesce((v_state ->> 'float_pullouts_php')::numeric, 0)  <> 0
       )
    then
      return next v_day;
    end if;
  end loop;
end;
$$;

comment on function public.eod_unclosed_days(date, date, uuid) is
  'Days since the End of Day reminders start date (accounting_settings) that moved cash and were never closed. Empty while the start date is blank.';

-- Same ACL as cash_drawer_state (0149): it reads every payment for a day, and
-- every caller is a server page on the service-role client.
revoke execute on function public.eod_unclosed_days(date, date, uuid) from public, anon, authenticated;
grant  execute on function public.eod_unclosed_days(date, date, uuid) to service_role;

-- ---- post-conditions ----------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from public.accounting_settings where key = 'eod_reminders_start_date'
  ) then
    raise exception '0185: the eod_reminders_start_date setting row is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'accounting_settings_key_check'
      and conrelid = 'public.accounting_settings'::regclass
      and pg_get_constraintdef(oid) like '%eod_reminders_start_date%'
      and pg_get_constraintdef(oid) like '%default_change_fund_php%'
      and pg_get_constraintdef(oid) like '%staff_advance_settlement_max_pct%'
  ) then
    raise exception '0185: accounting_settings_key_check does not admit the new key alongside the old ones';
  end if;

  if has_function_privilege('anon', 'public.eod_unclosed_days(date, date, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.eod_unclosed_days(date, date, uuid)', 'execute')
  then
    raise exception '0185: eod_unclosed_days must not be executable by anon or authenticated';
  end if;
end;
$$;

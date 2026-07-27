-- 0127 — Manila calendar-day defaults for date columns
--
-- The database runs in UTC, so `current_date` is the UTC calendar day, not the
-- Manila one. Between 00:00 and 08:00 Manila (16:00–24:00 UTC the day before)
-- those disagree, and a row stamped `current_date` gets YESTERDAY's date.
--
-- For `visits.visit_date` that is load-bearing: the Reception Queue selects
-- `visit_date = <today in Manila>`, so a visit created before 8am would be
-- stamped with yesterday and never appear in today's queue. The clinic opens at
-- 08:00 (payroll's `scheduled_start_hour`), which is exactly why this has never
-- fired — a check on production found 0 of 14,266 visits where `visit_date`
-- disagrees with the Manila date of `created_at`. It would start firing the
-- moment the clinic opens earlier, runs a dawn home-service visit, or backfills
-- overnight.
--
-- The rest of the schema already does this correctly — see the
-- `(now() at time zone 'Asia/Manila')::date` expressions throughout 0043, 0048,
-- 0049, 0093, 0095, 0097 and 0102. These two columns were the stragglers.
--
-- Defaults only: no data is rewritten, and any explicit INSERT value still wins.

alter table public.visits
  alter column visit_date set default (now() at time zone 'Asia/Manila')::date;

-- Same class of skew, far lower stakes: a schedule created before 8am would be
-- marked valid from the previous day. Fixed for consistency.
alter table public.physician_schedules
  alter column valid_from set default (now() at time zone 'Asia/Manila')::date;

comment on column public.visits.visit_date is
  'Manila calendar day the visit was created. Defaults to the Manila date, NOT '
  'current_date — the DB runs in UTC and the two disagree before 8am Manila. '
  'The Reception Queue filters on this column.';

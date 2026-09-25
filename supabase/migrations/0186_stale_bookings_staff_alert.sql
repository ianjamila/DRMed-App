-- =============================================================================
-- 0186 — Email Alerts: "Bookings not acted on"
-- =============================================================================
-- A sixth staff alert for Admin Tools › Email Alerts (0155): a morning email to
-- reception + admin (the default; editable on that page) listing bookings with
-- no set time (diagnostic packages, untimed lab requests — mostly booked
-- online) that nobody has marked arrived, no-show or cancelled for 3 days or
-- more. Sent by the daily /api/cron/stale-bookings job, and only on days when
-- there is at least one such booking. Nothing is ever closed automatically —
-- reception clears the list by hand (owner decision, 2026-09-25).
--
-- The email carries no contact details and no test names (RA 10173): the
-- patient's first name, how long ago they booked, and whether the booking is
-- now a likely no-show (7+ days). Staff sign in to see the rest.
--
-- Only the key list changes. The CHECK is re-created with the new key and the
-- settings row is seeded; STAFF_ALERT_KEYS in src/lib/notifications/
-- staff-alerts.ts is pinned to the latest definition by staff-alerts.test.ts.
-- =============================================================================

alter table public.staff_alert_settings
  drop constraint if exists staff_alert_settings_key_check;

alter table public.staff_alert_settings
  add constraint staff_alert_settings_key_check
    check (alert_key in ('website_message', 'template_health', 'dedup_digest', 'online_booking', 'released_payment_removed', 'stale_bookings'));

insert into public.staff_alert_settings (alert_key)
values ('stale_bookings')
on conflict (alert_key) do nothing;

do $$
begin
  if not exists (select 1 from public.staff_alert_settings where alert_key = 'stale_bookings') then
    raise exception '0186 post-check: the stale_bookings alert row is missing';
  end if;
end;
$$;

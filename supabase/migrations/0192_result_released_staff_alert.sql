-- 0192 — Email Alerts: "Results released" (lab-release-on-queue, Task 20).
-- Reception can be emailed when the lab releases results, so the counter can
-- print them for a waiting patient. Content is name + visit # + a count only
-- (owner decision 2026-09-30, RA 10173) — see release-staff-alert-content.ts.
-- Additive: widens the key CHECK and seeds the settings row (enabled by
-- default, like every alert). Recipients default to reception in the app
-- registry (STAFF_ALERTS) until an admin changes them in Email Alerts.

alter table public.staff_alert_settings
  drop constraint if exists staff_alert_settings_key_check;

alter table public.staff_alert_settings
  add constraint staff_alert_settings_key_check
    check (alert_key in ('website_message', 'template_health', 'dedup_digest', 'online_booking', 'released_payment_removed', 'stale_bookings', 'result_released'));

insert into public.staff_alert_settings (alert_key)
values ('result_released')
on conflict (alert_key) do nothing;

do $$
begin
  if not exists (select 1 from public.staff_alert_settings where alert_key = 'result_released') then
    raise exception '0192 post-check: the result_released alert row is missing';
  end if;
end;
$$;

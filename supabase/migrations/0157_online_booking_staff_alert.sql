-- =============================================================================
-- 0157 — Email Alerts: "New online booking"
-- =============================================================================
-- A fourth staff alert for Admin Tools › Email Alerts (0155): an email to
-- reception + admin (the default; editable on that page) whenever a patient
-- books through the public /schedule page or the patient portal. Staff-made
-- bookings never alert — staff already know about them. Nothing is sent while
-- online booking is paused (0153), because no online booking can be made.
--
-- The email carries no contact details and no test names (RA 10173): the
-- patient's first name, the booking type, the requested time or that they need
-- a call back, and how many services — staff sign in to see the rest.
--
-- Only the key list changes. The CHECK is re-created with the new key and the
-- settings row is seeded; STAFF_ALERT_KEYS in src/lib/notifications/
-- staff-alerts.ts is pinned to the latest definition by staff-alerts.test.ts.
-- =============================================================================

alter table public.staff_alert_settings
  drop constraint if exists staff_alert_settings_key_check;

alter table public.staff_alert_settings
  add constraint staff_alert_settings_key_check
    check (alert_key in ('website_message', 'template_health', 'dedup_digest', 'online_booking'));

insert into public.staff_alert_settings (alert_key)
values ('online_booking')
on conflict (alert_key) do nothing;

do $$
begin
  if not exists (select 1 from public.staff_alert_settings where alert_key = 'online_booking') then
    raise exception '0157 post-check: the online_booking alert row is missing';
  end if;
end;
$$;

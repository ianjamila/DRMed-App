-- =============================================================================
-- 0178 — Email Alerts: "Payment removed after results went out"
-- =============================================================================
-- A fifth staff alert for Admin Tools › Email Alerts (0155): an email to admin
-- (the default; editable on that page) when reception Deletes or Moves a
-- payment and the visit it leaves then OWES money although results on it were
-- already released. Released results stay released (owner rule) — this only
-- makes sure someone follows up the balance. HMO visits never alert: they
-- release before the HMO pays (0133), so they are never "unsettled".
--
-- The email carries no patient name and no test names (RA 10173): the visit
-- number, the payment's amount and method, what happened and the reason
-- picked, who did it, how many results went out, and what the visit now owes.
-- Staff sign in to see the rest.
--
-- Only the key list changes. The CHECK is re-created with the new key and the
-- settings row is seeded; STAFF_ALERT_KEYS in src/lib/notifications/
-- staff-alerts.ts is pinned to the latest definition by staff-alerts.test.ts.
-- =============================================================================

alter table public.staff_alert_settings
  drop constraint if exists staff_alert_settings_key_check;

alter table public.staff_alert_settings
  add constraint staff_alert_settings_key_check
    check (alert_key in ('website_message', 'template_health', 'dedup_digest', 'online_booking', 'released_payment_removed'));

insert into public.staff_alert_settings (alert_key)
values ('released_payment_removed')
on conflict (alert_key) do nothing;

do $$
begin
  if not exists (select 1 from public.staff_alert_settings where alert_key = 'released_payment_removed') then
    raise exception '0178 post-check: the released_payment_removed alert row is missing';
  end if;
end;
$$;

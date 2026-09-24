-- =============================================================================
-- 0155 — Email Alerts: who receives each staff alert email
-- =============================================================================
-- DRMed sends three alert emails to STAFF (patient emails are out of scope):
--   website_message  — a new message arrived through the /contact form (0154)
--   template_health  — the daily/weekly result-template drift check found issues
--   dedup_digest     — the daily possible-duplicate-patients digest
-- Until now each sender hard-coded its audience (reception + admin, or every
-- active admin) and the only override was an env var. Admin Tools › Email
-- Alerts (/staff/admin/settings/alerts) now manages it in the app, modelled
-- on eaglewatch's notification settings: an on/off switch per alert, a switch
-- per staff member, and extra addresses such as a shared clinic inbox.
--
-- staff_alert_settings    one row per alert: enabled (off = nobody is emailed).
-- staff_alert_recipients  EITHER a per-staff override (staff_id + subscribed)
--                         OR an extra address (email + subscribed). A staff
--                         member with no row gets the alert's default, which
--                         is role-based and lives in src/lib/notifications/
--                         staff-alerts.ts — so a newly hired admin receives
--                         admin alerts without anyone remembering to add them.
--
-- Admin-only through RLS; the senders read with the service-role client.
-- The key list is pinned to STAFF_ALERT_KEYS by staff-alerts.test.ts.
-- =============================================================================

create table if not exists public.staff_alert_settings (
  alert_key  text primary key,
  enabled    boolean not null default true,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint staff_alert_settings_key_check
    check (alert_key in ('website_message', 'template_health', 'dedup_digest'))
);

insert into public.staff_alert_settings (alert_key)
values ('website_message'), ('template_health'), ('dedup_digest')
on conflict (alert_key) do nothing;

create table if not exists public.staff_alert_recipients (
  id          uuid primary key default gen_random_uuid(),
  alert_key   text not null references public.staff_alert_settings(alert_key) on delete cascade,
  staff_id    uuid references public.staff_profiles(id) on delete cascade,
  email       text,
  subscribed  boolean not null default true,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint staff_alert_recipients_one_target
    check ((staff_id is null) <> (email is null)),
  constraint staff_alert_recipients_email_shape
    check (
      email is null
      or (char_length(email) between 6 and 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    )
);

create unique index if not exists uq_staff_alert_recipients_staff
  on public.staff_alert_recipients (alert_key, staff_id)
  where staff_id is not null;
create unique index if not exists uq_staff_alert_recipients_email
  on public.staff_alert_recipients (alert_key, lower(email))
  where email is not null;
create index if not exists idx_staff_alert_recipients_staff
  on public.staff_alert_recipients (staff_id)
  where staff_id is not null;

drop trigger if exists trg_staff_alert_settings_updated_at on public.staff_alert_settings;
create trigger trg_staff_alert_settings_updated_at
  before update on public.staff_alert_settings
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_staff_alert_recipients_updated_at on public.staff_alert_recipients;
create trigger trg_staff_alert_recipients_updated_at
  before update on public.staff_alert_recipients
  for each row execute function public.touch_updated_at();

alter table public.staff_alert_settings enable row level security;
alter table public.staff_alert_recipients enable row level security;

revoke all on public.staff_alert_settings from anon;
revoke all on public.staff_alert_settings from authenticated;
grant select, update on public.staff_alert_settings to authenticated;

revoke all on public.staff_alert_recipients from anon;
revoke all on public.staff_alert_recipients from authenticated;
grant select, insert, update, delete on public.staff_alert_recipients to authenticated;

create policy "staff_alert_settings: admin read"
  on public.staff_alert_settings
  for select
  to authenticated
  using ((select public.has_role(array['admin'])));

create policy "staff_alert_settings: admin update"
  on public.staff_alert_settings
  for update
  to authenticated
  using ((select public.has_role(array['admin'])))
  with check ((select public.has_role(array['admin'])));

create policy "staff_alert_recipients: admin manage"
  on public.staff_alert_recipients
  for all
  to authenticated
  using ((select public.has_role(array['admin'])))
  with check ((select public.has_role(array['admin'])));

-- Post-conditions
do $$
begin
  if (select count(*) from public.staff_alert_settings) < 3 then
    raise exception '0155 post-check: staff_alert_settings is missing seeded alerts';
  end if;
  if has_table_privilege('anon', 'public.staff_alert_settings', 'select')
     or has_table_privilege('anon', 'public.staff_alert_recipients', 'select')
     or has_table_privilege('authenticated', 'public.staff_alert_settings', 'insert')
     or has_table_privilege('authenticated', 'public.staff_alert_settings', 'delete') then
    raise exception '0155 post-check: staff alert tables are wider than intended';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public'
       and tablename in ('staff_alert_settings', 'staff_alert_recipients')) <> 3 then
    raise exception '0155 post-check: expected exactly 3 policies on the staff alert tables';
  end if;
end;
$$;

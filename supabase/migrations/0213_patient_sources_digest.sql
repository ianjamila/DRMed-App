-- =============================================================================
-- 0213 — Patient Sources owner emails: two alert keys, the send-claim table, its
--       claim function, and a service_role read of ad_spend_daily
-- =============================================================================
-- Two staff alerts for Admin Tools > Email Alerts (0155): a weekly digest (Monday
-- 07:00 Manila) and a monthly digest (the 1st, 08:00 Manila) of Patient Sources
-- numbers, sent by /api/cron/patient-sources-weekly and -monthly.
--
-- DELIVERY RULE: at most once, automatically. A duplicate owner digest is a
-- nuisance; a missed one is visible on the cron watchdog. So when delivery is
-- uncertain nothing re-sends by itself — the row is flagged 'unknown' for an
-- operator. public.patient_sources_digest_sends holds one row per
-- (alert, period start, recipient); public._ps_digest_claim() is the atomic claim
-- (a single INSERT ... ON CONFLICT DO UPDATE ... WHERE, so two overlapping cron
-- invocations cannot both win — proven by scripts/ps-digest-claim-concurrency-proof.ts).
--
-- Statuses: sending (claimed) | sent (Resend 2xx with an id) | failed (definite:
-- Resend answered non-2xx, or sending was skipped) | unknown (the request may have
-- reached Resend, or a 'sending' row went stale — 15 minutes).
--
-- The table is service_role-only server state: RLS on, NO policy, nothing for
-- anon/authenticated (supabase/seed.sql re-revokes it after a local reset, and
-- supabase/tests/0151_rls_initplan_smoke.sql allow-lists it).
--
-- The cron reads ad_spend_daily DIRECTLY with the service key. Prod has
-- service_role SELECT on it through Supabase default privileges; a fresh replay
-- only gets it from seed.sql, so grant it here and local proofs match prod. It
-- must NEVER call ad_spend_daily_totals / ad_spend_coverage / ad_spend_rows /
-- patient_sources_revenue|overlaps|referrers|people with the service key: those
-- are admin-only inside the body, so a service-key call is a REFUSED function
-- call, and on prod image 17.6.1.111 a refused call crashes Postgres.
-- =============================================================================

-- (1) The two alert keys. The CHECK is re-created with the FULL literal list;
-- STAFF_ALERT_KEYS in src/lib/notifications/staff-alerts.ts is pinned to the
-- latest definition by staff-alerts.test.ts.
alter table public.staff_alert_settings
  drop constraint if exists staff_alert_settings_key_check;

alter table public.staff_alert_settings
  add constraint staff_alert_settings_key_check
    check (alert_key in (
      'website_message', 'template_health', 'dedup_digest', 'online_booking',
      'released_payment_removed', 'stale_bookings', 'result_released',
      'patient_sources_weekly', 'patient_sources_monthly'
    ));

insert into public.staff_alert_settings (alert_key)
values ('patient_sources_weekly'), ('patient_sources_monthly')
on conflict (alert_key) do nothing;

-- (2) One row per (alert, period start, recipient).
create table if not exists public.patient_sources_digest_sends (
  alert_key   text        not null
              check (alert_key in ('patient_sources_weekly', 'patient_sources_monthly')),
  period_from date        not null,
  period_to   date        not null check (period_to >= period_from),
  recipient   text        not null check (recipient <> '' and recipient = lower(recipient)),
  status      text        not null check (status in ('sending', 'sent', 'failed', 'unknown')),
  attempts    int         not null default 1 check (attempts >= 1),
  provider_id text,
  last_error  text,
  updated_at  timestamptz not null default now(),
  primary key (alert_key, period_from, recipient)
);

alter table public.patient_sources_digest_sends enable row level security;
-- No policy on purpose: server code (service_role) only.
-- Literal revokes (not format() in a do block): seed-grant-parity.test.ts regex-scans for them.
revoke all on public.patient_sources_digest_sends from public, anon, authenticated;
-- Supabase default privileges hand service_role ALL on a new table; the cron only
-- ever reads, inserts and updates claims, so take the rest back (never DELETE).
revoke all on public.patient_sources_digest_sends from service_role;
grant select, insert, update on public.patient_sources_digest_sends to service_role;

-- (3) The atomic claim. Returns the new attempt number, or NULL when this call
-- did not claim: the row is already sent, in flight, or unknown (and the caller
-- did not ask for unknowns). A 'sending' row older than 15 minutes is first
-- flipped to 'unknown' and NOT claimed — the run that owned it died between the
-- claim and recording the outcome, so the email may or may not have gone.
-- SECURITY INVOKER: service_role holds the table privileges it needs.
create or replace function public._ps_digest_claim(
  p_key             text,
  p_from            date,
  p_to              date,
  p_recipient       text,
  p_include_unknown boolean default false
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_recipient text := lower(btrim(p_recipient));
  v_attempts  integer;
begin
  if p_key is null or p_from is null or p_to is null or v_recipient is null or v_recipient = '' then
    raise exception '_ps_digest_claim: key, period and recipient are required' using errcode = '22023';
  end if;

  update public.patient_sources_digest_sends s
     set status = 'unknown',
         last_error = coalesce(s.last_error, 'the send started but its outcome was never recorded'),
         updated_at = now()
   where s.alert_key = p_key
     and s.period_from = p_from
     and s.recipient = v_recipient
     and s.status = 'sending'
     and s.updated_at < now() - interval '15 minutes';

  insert into public.patient_sources_digest_sends as ds
    (alert_key, period_from, period_to, recipient, status, attempts, updated_at)
  values (p_key, p_from, p_to, v_recipient, 'sending', 1, now())
  on conflict (alert_key, period_from, recipient) do update
    set status = 'sending',
        attempts = ds.attempts + 1,
        provider_id = null,
        last_error = null,
        updated_at = now()
  where ds.status = 'failed' or (p_include_unknown and ds.status = 'unknown')
  returning ds.attempts into v_attempts;

  return v_attempts;
end;
$$;

-- New functions default to postgres + service_role (0119); restate it, and name
-- anon/authenticated too (hosted Supabase grants them EXECUTE directly).
revoke all on function public._ps_digest_claim(text, date, date, text, boolean) from public, anon, authenticated;
grant execute on function public._ps_digest_claim(text, date, date, text, boolean) to service_role;

-- (4) The cron reads ad spend with the service key.
grant select on public.ad_spend_daily to service_role;

-- (5) Post-checks, 0206 style: a replay that does not land every piece fails loudly.
do $$
declare
  v_def text;
  k     text;
  r     text;
  rel   regclass := 'public.patient_sources_digest_sends'::regclass;
  fn    text := 'public._ps_digest_claim(text,date,date,text,boolean)';
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.staff_alert_settings'::regclass
     and c.conname = 'staff_alert_settings_key_check';
  foreach k in array array[
    'website_message', 'template_health', 'dedup_digest', 'online_booking',
    'released_payment_removed', 'stale_bookings', 'result_released',
    'patient_sources_weekly', 'patient_sources_monthly'
  ] loop
    if v_def is null or position('''' || k || '''' in v_def) = 0 then
      raise exception 'post-check: staff_alert_settings_key_check is missing %', k;
    end if;
  end loop;

  if (select count(*) from public.staff_alert_settings
       where alert_key in ('patient_sources_weekly', 'patient_sources_monthly')) <> 2 then
    raise exception 'post-check: a Patient Sources alert settings row is missing';
  end if;

  if not (select c.relrowsecurity from pg_class c where c.oid = rel) then
    raise exception 'post-check: RLS is off on patient_sources_digest_sends';
  end if;
  if exists (select 1 from pg_policy p where p.polrelid = rel) then
    raise exception 'post-check: patient_sources_digest_sends must have no policy (service_role only)';
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, rel, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(r, rel, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'post-check: % holds a privilege on patient_sources_digest_sends', r;
    end if;
    if has_function_privilege(r, fn, 'execute') then
      raise exception 'post-check: % can execute _ps_digest_claim', r;
    end if;
  end loop;

  if not has_table_privilege('service_role', rel, 'SELECT,INSERT,UPDATE') then
    raise exception 'post-check: service_role cannot read/insert/update patient_sources_digest_sends';
  end if;
  if has_table_privilege('service_role', rel, 'DELETE') then
    raise exception 'post-check: service_role must not DELETE from patient_sources_digest_sends';
  end if;
  if not has_function_privilege('service_role', fn, 'execute') then
    raise exception 'post-check: service_role cannot execute _ps_digest_claim';
  end if;
  if not has_table_privilege('service_role', 'public.ad_spend_daily'::regclass, 'SELECT') then
    raise exception 'post-check: service_role cannot read ad_spend_daily';
  end if;
end;
$$;

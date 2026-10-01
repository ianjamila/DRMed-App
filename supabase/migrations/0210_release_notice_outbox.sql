-- 0210_release_notice_outbox.sql
-- =============================================================================
-- Durable outbox for the "your result is ready" notice — PR 1 of 3, INERT.
-- Spec: docs/superpowers/specs/2026-10-01-release-notice-outbox-design.md
--
-- Nothing calls these objects yet: no release path enqueues a row, the app does
-- not claim or finish one, and the enabled flag is seeded OFF. PR 2 adds the
-- sender and the sweeper route, PR 3 re-creates release_visit_results /
-- undo_visit_release to enqueue and cancel.
--
-- release_notice_settings   one-row switch. `enabled` is read STRICTLY by SQL:
--                           a missing row, a NULL, or any error reading it all
--                           mean OFF (release_notices_enabled()). Seeded OFF and
--                           never re-seeded: rollback = flip it off, never
--                           delete the row.
-- release_notices           one row per release call per visit. Ids and states
--                           only — no phone, email or message body (RA 10173);
--                           last_error is redacted of anything address-shaped.
-- claim_release_notice      leases due rows (FOR UPDATE SKIP LOCKED).
-- finish_release_notice     lease-fenced result write; computes the backoff.
-- retry_release_notice      admin manual retry of an abandoned / waiting row.
--
-- Access. Every object is service_role-only: RLS on with NO policy, anon /
-- authenticated revoked by name (supabase/seed.sql mirrors the table revokes —
-- seed-grant-parity.test.ts — and the 0151 smoke pins both tables on its
-- no-policy list). The functions are SECURITY INVOKER: the Server Action /
-- cron route calls them through the service-role client, which already holds
-- the table grants below, so they need no extra authority. Admin authority for
-- the manual retry is checked in TypeScript before the call, like every other
-- service-role-only action. EXECUTE is revoked from public/anon/authenticated
-- by name, so 0201/0207's api_request_guard (which refuses an /rpc call the
-- request role cannot execute, before Postgres does — prod's image segfaults on
-- that refusal) answers a refused call itself. The guard keeps no allow/deny
-- list, it reads has_function_privilege, so nothing is registered there; none
-- of these takes a table row as its first argument, so none is a computed
-- field. The post-condition at the foot of this file pins all of it.
--
-- Visits are soft-deleted (deleted_at), so the FK is ON DELETE CASCADE: a
-- notice is meaningless without its visit and must never block a hard delete
-- (test sweeps, patient purge). A soft-deleted visit keeps its notice; the TS
-- re-check (PR 2) cancels it at send time.
--
-- No P-codes: nothing here raises except a caller bug (22023 invalid parameter)
-- and the post-condition below.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The strict switch
-- ---------------------------------------------------------------------------
create table if not exists public.release_notice_settings (
  id         boolean primary key default true,          -- single-row guard
  enabled    boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint release_notice_settings_singleton check (id = true)
);

insert into public.release_notice_settings (id, enabled)
values (true, false)
on conflict (id) do nothing;      -- never flips an existing row

drop trigger if exists trg_release_notice_settings_updated_at on public.release_notice_settings;
create trigger trg_release_notice_settings_updated_at
  before update on public.release_notice_settings
  for each row execute function public.touch_updated_at();

alter table public.release_notice_settings enable row level security;

revoke all on public.release_notice_settings from public, anon, authenticated, service_role;
grant select, update on public.release_notice_settings to service_role;

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------
create table if not exists public.release_notices (
  id                uuid primary key default gen_random_uuid(),
  visit_id          uuid not null references public.visits (id) on delete cascade,
  -- The release RPC's now(): ties the notice to exactly the lines that release
  -- stamped, so a re-release (new released_at) is a new notice.
  released_at       timestamptz not null,
  test_request_ids  uuid[] not null,
  release_medium    text,
  bulk_batch_id     text,       -- carried onto result.notified so batch Undo's changedSince guard still works
  status            text not null default 'pending',
  email_state       text not null default 'todo',
  sms_state         text not null default 'todo',
  email_provider_id text,
  sms_provider_id   text,
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  lease_token       uuid,
  lease_expires_at  timestamptz,
  last_error        text,       -- sanitised, never an address
  skip_reason       text,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  resolved_at       timestamptz,
  -- Stamped (mark_release_notice_audited) once the terminal audit row is written, so a
  -- crash between finish and the audit write, or a claim that abandoned an exhausted
  -- lease, is found again by the sweeper and audited exactly once.
  audited_at        timestamptz,

  constraint release_notices_visit_released_key unique (visit_id, released_at),
  constraint release_notices_status_check check (
    status in ('pending', 'sending', 'retry', 'sent', 'skipped', 'suppressed', 'cancelled', 'abandoned')),
  constraint release_notices_email_state_check check (email_state in ('todo', 'sent', 'skipped', 'failed', 'unknown')),
  constraint release_notices_sms_state_check   check (sms_state   in ('todo', 'sent', 'skipped', 'failed', 'unknown')),
  constraint release_notices_tests_nonempty check (cardinality(test_request_ids) >= 1),
  constraint release_notices_attempts_check check (attempts >= 0),
  -- A terminal status is exactly a resolved row; `sent` is exactly a row with sent_at.
  constraint release_notices_resolved_check check (
    (status in ('sent', 'skipped', 'suppressed', 'cancelled', 'abandoned')) = (resolved_at is not null)),
  constraint release_notices_sent_at_check check ((status = 'sent') = (sent_at is not null)),
  -- Only a resolved row can have been audited.
  constraint release_notices_audited_check check (audited_at is null or resolved_at is not null),
  -- A lease exists exactly while the row is `sending`, and a leased row has had an attempt.
  constraint release_notices_lease_check check (
    (status = 'sending') = (lease_token is not null)
    and (lease_token is null) = (lease_expires_at is null)
    and (status <> 'sending' or attempts >= 1)),
  constraint release_notices_text_len_check check (
    char_length(coalesce(last_error, '')) <= 500
    and char_length(coalesce(skip_reason, '')) <= 200
    and char_length(coalesce(email_provider_id, '')) <= 200
    and char_length(coalesce(sms_provider_id, '')) <= 200
    and char_length(coalesce(release_medium, '')) <= 100
    and char_length(coalesce(bulk_batch_id, '')) <= 100)
);

-- The sweeper's due query: pending / retry rows by next_attempt_at, id.
create index if not exists idx_release_notices_due
  on public.release_notices (next_attempt_at, id)
  where status in ('pending', 'retry');
-- ...and the expired-lease reclaim.
create index if not exists idx_release_notices_lease
  on public.release_notices (lease_expires_at)
  where status = 'sending';

-- Terminal rows still waiting for their audit row.
create index if not exists idx_release_notices_unaudited
  on public.release_notices (resolved_at, id)
  where resolved_at is not null and audited_at is null;

alter table public.release_notices enable row level security;

revoke all on public.release_notices from public, anon, authenticated, service_role;
grant select, insert, update on public.release_notices to service_role;

-- ---------------------------------------------------------------------------
-- release_notices_enabled(): the strict read
-- ---------------------------------------------------------------------------
create or replace function public.release_notices_enabled()
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- Missing row, NULL, or any error reading the table = OFF.
  return coalesce((select s.enabled from public.release_notice_settings s where s.id is true), false);
exception when others then
  return false;
end;
$$;

comment on function public.release_notices_enabled() is
  '0210: the strict release-notice outbox flag. A missing row, a NULL or any read error is OFF. Seeded OFF; roll back by flipping release_notice_settings.enabled, never by deleting the row.';

-- ---------------------------------------------------------------------------
-- claim_release_notice(p_id, p_limit)
-- ---------------------------------------------------------------------------
-- Leases rows to the caller and returns them (lease_token included). Returns
-- nothing while the flag is OFF.
--
--   p_id given    the inline fast path: that ONE row, if it is pending, due for
--                 retry, or `sending` with an expired lease. No age limit.
--   p_id null     the sweeper: up to p_limit due rows (pending / retry with
--                 next_attempt_at passed, or `sending` with an expired lease)
--                 that are older than 2 minutes — younger rows belong to the
--                 inline send that just created them.
--
-- FOR UPDATE SKIP LOCKED over `order by next_attempt_at, id` makes concurrent
-- claimers disjoint (the loser skips, never waits and never double-claims). A
-- claim sets status `sending`, a fresh lease_token, lease_expires_at = +3 min
-- and attempts + 1. It never touches the channel states: a row whose sms_state
-- is 'unknown' (an SMS was in flight when the sender died) is handed back with
-- 'unknown' intact, so the sender can see it and never resend the SMS
-- (at-most-once); the email half still retries.
--
-- An expired lease on a row that is out of attempts (6 = the first send plus
-- the five backoffs) or past 24 h from creation (the Resend idempotency window)
-- is closed `abandoned` here instead of being leased again, so a sender that
-- keeps dying cannot leave a row in `sending` for ever.
create or replace function public.claim_release_notice(
  p_id    uuid    default null,
  p_limit integer default 20
)
returns setof public.release_notices
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_limit integer     := least(greatest(coalesce(p_limit, 20), 1), 200);
begin
  if not public.release_notices_enabled() then
    return;
  end if;

  -- Rows whose lease expired with nothing left to try: close them.
  with exhausted as materialized (
    select n.id
      from public.release_notices n
     where n.status = 'sending'
       and n.lease_expires_at <= v_now
       and (n.attempts >= 6 or v_now > n.created_at + interval '24 hours')
       and (p_id is null or n.id = p_id)
     order by n.id
       for update skip locked
  )
  update public.release_notices n
     set status           = 'abandoned',
         resolved_at      = v_now,
         lease_token      = null,
         lease_expires_at = null,
         last_error       = coalesce(n.last_error, 'lease expired after the final attempt')
    from exhausted e
   where n.id = e.id;

  return query
  with due as materialized (
    select n.id
      from public.release_notices n
     where (p_id is null or n.id = p_id)
       and (p_id is not null or n.created_at <= v_now - interval '2 minutes')
       and (   n.status = 'pending'
            or (n.status = 'retry'   and n.next_attempt_at <= v_now)
            or (n.status = 'sending' and n.lease_expires_at <= v_now))
       -- the sweeper only takes a pending row once it is due; the inline path
       -- (p_id) owns a just-created pending row whatever its next_attempt_at
       and (p_id is not null or n.status <> 'pending' or n.next_attempt_at <= v_now)
     order by n.next_attempt_at, n.id
     limit v_limit
       for update skip locked
  )
  update public.release_notices n
     set status           = 'sending',
         lease_token      = gen_random_uuid(),
         lease_expires_at = v_now + interval '3 minutes',
         attempts         = n.attempts + 1
    from due d
   where n.id = d.id
  returning n.*;
end;
$$;

comment on function public.claim_release_notice(uuid, integer) is
  '0210: lease due release notices (FOR UPDATE SKIP LOCKED, 3 min lease, attempts + 1). p_id = the inline fast path for one row; null = the sweeper (rows older than 2 min, up to p_limit). Never alters channel states, so sms_state=unknown reaches the sender. Returns nothing while the flag is off.';

-- ---------------------------------------------------------------------------
-- finish_release_notice(...)
-- ---------------------------------------------------------------------------
-- Records the outcome of ONE leased attempt. Fenced on the lease: p_lease_token
-- must be the row's current token while it is `sending`; otherwise nothing
-- changes and NO row comes back (the caller lost the lease to a newer attempt
-- and must write nothing). On success it returns the row as it now stands, so
-- the caller can see the status it ended in (sent / retry / abandoned ...)
-- without a second, racy read — that is why this returns the row, not a bool.
--
-- p_final_status is the caller's verdict:
--   sent | skipped | suppressed | cancelled   terminal, as given.
--   retry                                     the attempt failed: the row waits
--      attempts 1..5 -> 5 min, 15 min, 1 h, 4 h, 12 h; it becomes `abandoned`
--      instead once the sixth attempt (the first send + five backoffs) has
--      failed, or when the next try would fall more than 24 h after created_at
--      (the Resend idempotency window).
-- Channel states / provider ids are optional (null = keep). A channel already
-- 'sent' never changes (at-most-once). last_error is truncated to 500 chars and
-- anything address-shaped is redacted. The lease is always cleared.
create or replace function public.finish_release_notice(
  p_id                uuid,
  p_lease_token       uuid,
  p_final_status      text,
  p_email_state       text default null,
  p_sms_state         text default null,
  p_email_provider_id text default null,
  p_sms_provider_id   text default null,
  p_error             text default null,
  p_skip_reason       text default null
)
returns setof public.release_notices
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now    timestamptz := clock_timestamp();
  v_n      public.release_notices%rowtype;
  v_status text;
  v_delay  interval;
  v_error  text;
  v_reason text;
begin
  if p_final_status is null
     or p_final_status not in ('sent', 'skipped', 'suppressed', 'cancelled', 'retry') then
    raise exception 'finish_release_notice: invalid final status %', coalesce(p_final_status, '<null>')
      using errcode = '22023';
  end if;
  if p_email_state is not null and p_email_state not in ('todo', 'sent', 'skipped', 'failed', 'unknown') then
    raise exception 'finish_release_notice: invalid email state %', p_email_state using errcode = '22023';
  end if;
  if p_sms_state is not null and p_sms_state not in ('todo', 'sent', 'skipped', 'failed', 'unknown') then
    raise exception 'finish_release_notice: invalid sms state %', p_sms_state using errcode = '22023';
  end if;

  select * into v_n
    from public.release_notices n
   where n.id = p_id
     and n.status = 'sending'
     and n.lease_token = p_lease_token
     for update;
  if not found then
    return;     -- stale or foreign token: changed nothing
  end if;

  if p_final_status = 'retry' then
    v_delay := (array['5 minutes', '15 minutes', '1 hour', '4 hours', '12 hours']::interval[])[v_n.attempts];
    if v_delay is null or v_now + v_delay > v_n.created_at + interval '24 hours' then
      v_status := 'abandoned';
    else
      v_status := 'retry';
    end if;
  else
    v_status := p_final_status;
  end if;

  -- Redact address-shaped text, then phone-shaped digit runs (7+ digits, optional
  -- + and space / - / () separators), then cut. Applied to the error and the skip reason.
  v_error := nullif(left(regexp_replace(regexp_replace(coalesce(p_error, ''),
      '[^[:space:]@<>"'']+@[^[:space:]<>"'']+', '[redacted]', 'g'),
      '\+?[0-9][0-9 ()-]{6,}[0-9]', '[redacted]', 'g'), 500), '');
  v_reason := nullif(left(regexp_replace(regexp_replace(coalesce(p_skip_reason, ''),
      '[^[:space:]@<>"'']+@[^[:space:]<>"'']+', '[redacted]', 'g'),
      '\+?[0-9][0-9 ()-]{6,}[0-9]', '[redacted]', 'g'), 200), '');

  return query
  update public.release_notices n
     set status            = v_status,
         email_state       = case when n.email_state = 'sent' then 'sent'
                                  else coalesce(p_email_state, n.email_state) end,
         sms_state         = case when n.sms_state = 'sent' then 'sent'
                                  else coalesce(p_sms_state, n.sms_state) end,
         email_provider_id = coalesce(left(p_email_provider_id, 200), n.email_provider_id),
         sms_provider_id   = coalesce(left(p_sms_provider_id, 200), n.sms_provider_id),
         -- a success clears the stale error of an earlier failed attempt
         last_error        = case when v_status = 'sent' then null else coalesce(v_error, n.last_error) end,
         skip_reason       = coalesce(v_reason, n.skip_reason),
         next_attempt_at   = case when v_status = 'retry' then v_now + v_delay else n.next_attempt_at end,
         sent_at           = case when v_status = 'sent' then v_now else n.sent_at end,
         resolved_at       = case when v_status = 'retry' then null else v_now end,
         lease_token       = null,
         lease_expires_at  = null
   where n.id = p_id
  returning n.*;
end;
$$;

comment on function public.finish_release_notice(uuid, uuid, text, text, text, text, text, text, text) is
  '0210: lease-fenced result of one release-notice attempt. A stale lease_token changes nothing and returns no row. retry backs off 5m/15m/1h/4h/12h and becomes abandoned after the sixth attempt or past 24h from created_at. A channel already sent is never overwritten. last_error is truncated and redacted of address-shaped text.';

-- ---------------------------------------------------------------------------
-- retry_release_notice(p_id): the admin's manual Retry
-- ---------------------------------------------------------------------------
-- Puts an `abandoned` row (or a `retry` row still waiting out its backoff) back
-- in the queue as due now with attempts 0. It touches ONLY those two statuses
-- and never a row with a live lease, so it cannot reset an attempt that is in
-- flight (a `sending` row is left to finish or to have its lease expire).
-- Channel states are untouched: a channel already sent stays sent, an 'unknown'
-- SMS is still never resent. Returns whether a row was reset. The caller (a
-- service-role Server Action) checks the user is an admin first.
--
-- A row older than 24 h is retried on purpose, but the 24 h cap in
-- finish_release_notice still applies to what follows: the next failure
-- abandons it again, so a manual Retry past the window is exactly one more try.
create or replace function public.retry_release_notice(p_id uuid)
returns boolean
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.release_notices n
     set status           = 'retry',
         attempts         = 0,
         next_attempt_at  = clock_timestamp(),
         resolved_at      = null,
         audited_at       = null,   -- it will resolve (and be audited) again
         lease_token      = null,
         lease_expires_at = null
   where n.id = p_id
     and n.status in ('abandoned', 'retry')
     and (n.lease_expires_at is null or n.lease_expires_at <= clock_timestamp())
  returning n.id into v_id;
  return v_id is not null;
end;
$$;

comment on function public.retry_release_notice(uuid) is
  '0210: admin manual retry — resets attempts and next_attempt_at on an abandoned or waiting (retry) notice. Never touches a sending row or a live lease. Channel states are kept. Admin authority is checked in TypeScript.';

-- ---------------------------------------------------------------------------
-- mark_release_notice_audited(p_id)
-- ---------------------------------------------------------------------------
-- Stamps audited_at on a TERMINAL row that has not been stamped yet and returns
-- whether it did. The sender (and the sweeper, which also picks up terminal rows
-- with audited_at null: a crash between finish and the audit write, or a claim
-- that closed an exhausted lease as abandoned) writes the audit row and then
-- calls this; the fenced stamp makes a second caller get false, so the audit is
-- written once. Admin / actor checks are in TypeScript.
create or replace function public.mark_release_notice_audited(p_id uuid)
returns boolean
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.release_notices n
     set audited_at = clock_timestamp()
   where n.id = p_id
     and n.resolved_at is not null
     and n.audited_at is null
  returning n.id into v_id;
  return v_id is not null;
end;
$$;

comment on function public.mark_release_notice_audited(uuid) is
  '0210: fenced stamp of release_notices.audited_at on a terminal, not-yet-audited row; returns whether it stamped. A second caller gets false, so the terminal audit row is written once.';

-- ---------------------------------------------------------------------------
-- ACLs, stated by name
-- ---------------------------------------------------------------------------
revoke all on function public.release_notices_enabled()                 from public, anon, authenticated;
revoke all on function public.claim_release_notice(uuid, integer)       from public, anon, authenticated;
revoke all on function public.finish_release_notice(uuid, uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.retry_release_notice(uuid)                from public, anon, authenticated;
revoke all on function public.mark_release_notice_audited(uuid)         from public, anon, authenticated;
grant execute on function public.release_notices_enabled()              to service_role;
grant execute on function public.claim_release_notice(uuid, integer)    to service_role;
grant execute on function public.finish_release_notice(uuid, uuid, text, text, text, text, text, text, text)
  to service_role;
grant execute on function public.retry_release_notice(uuid)             to service_role;
grant execute on function public.mark_release_notice_audited(uuid)      to service_role;

-- ---------------------------------------------------------------------------
-- Post-condition
-- ---------------------------------------------------------------------------
do $$
declare
  t    text;
  f    text;
  priv text;
begin
  foreach t in array array['release_notices', 'release_notice_settings'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = format('public.%I', t)::regclass) then
      raise exception '0210: RLS is not enabled on %', t;
    end if;
    if exists (select 1 from pg_policy p where p.polrelid = format('public.%I', t)::regclass) then
      raise exception '0210: % must have no policy (service_role-only)', t;
    end if;
    foreach priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if has_table_privilege('anon', format('public.%I', t), priv)
         or has_table_privilege('authenticated', format('public.%I', t), priv) then
        raise exception '0210: anon/authenticated still hold % on %', priv, t;
      end if;
    end loop;
    if has_any_column_privilege('anon', format('public.%I', t), 'SELECT,INSERT,UPDATE,REFERENCES')
       or has_any_column_privilege('authenticated', format('public.%I', t), 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception '0210: anon/authenticated hold a column privilege on %', t;
    end if;
  end loop;

  foreach priv in array array['SELECT','INSERT','UPDATE'] loop
    if not has_table_privilege('service_role', 'public.release_notices', priv) then
      raise exception '0210: service_role lacks % on release_notices', priv;
    end if;
  end loop;
  foreach priv in array array['SELECT','UPDATE'] loop
    if not has_table_privilege('service_role', 'public.release_notice_settings', priv) then
      raise exception '0210: service_role lacks % on release_notice_settings', priv;
    end if;
  end loop;

  foreach f in array array[
    'public.release_notices_enabled()',
    'public.claim_release_notice(uuid,integer)',
    'public.finish_release_notice(uuid,uuid,text,text,text,text,text,text,text)',
    'public.retry_release_notice(uuid)',
    'public.mark_release_notice_audited(uuid)'] loop
    if has_function_privilege('anon', f, 'EXECUTE')
       or has_function_privilege('authenticated', f, 'EXECUTE')
       or not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '0210: % must be EXECUTE service_role only', f;
    end if;
    if exists (select 1 from pg_proc where oid = f::regprocedure
                and (prosecdef or not coalesce(proconfig @> array['search_path=pg_catalog, public, pg_temp'], false))) then
      raise exception '0210: % must be SECURITY INVOKER with a pinned search_path', f;
    end if;
  end loop;

  if (select count(*) from public.release_notice_settings) <> 1 then
    raise exception '0210: the release-notice flag row must exist';
  end if;
end;
$$;

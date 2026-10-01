-- 0213 smoke: the claim function's states one after another, and the ACLs after a
-- full replay (migrations + seed.sql). Sequential only — a transaction never waits
-- on itself, so the RACE is proven by scripts/ps-digest-claim-concurrency-proof.ts.
-- Run: psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/0213_patient_sources_digest_smoke.sql
begin;

do $$
declare
  k  constant text := 'patient_sources_weekly';
  f  constant date := date '2090-01-05';
  t  constant date := date '2090-01-11';
  r  constant text := 'owner@example.com';
  a  integer;
  s  text;
  e  text;
begin
  -- a fresh claim lower-cases + trims the recipient and returns attempt 1
  a := public._ps_digest_claim(k, f, t, '  Owner@Example.com ');
  if a is distinct from 1 then raise exception 'smoke: first claim should return 1, got %', a; end if;
  select status into s from public.patient_sources_digest_sends where alert_key = k and period_from = f and recipient = r;
  if s is distinct from 'sending' then raise exception 'smoke: claimed row should be sending, got %', s; end if;

  -- an in-flight row cannot be claimed again
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: a sending row was claimed twice'; end if;

  -- a definite failure is re-claimed, attempts + 1, error cleared
  update public.patient_sources_digest_sends set status = 'failed', last_error = 'Resend 422', provider_id = 'x'
   where alert_key = k and period_from = f and recipient = r;
  a := public._ps_digest_claim(k, f, t, r);
  if a is distinct from 2 then raise exception 'smoke: re-claim of a failed row should return 2, got %', a; end if;
  select status, last_error into s, e from public.patient_sources_digest_sends where alert_key = k and period_from = f and recipient = r;
  if s <> 'sending' or e is not null then raise exception 'smoke: re-claim must reset to sending with no error (% / %)', s, e; end if;

  -- a sent row is never claimed, even when unknowns are allowed
  update public.patient_sources_digest_sends set status = 'sent', provider_id = 'em_1'
   where alert_key = k and period_from = f and recipient = r;
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: a sent row was claimed'; end if;
  if public._ps_digest_claim(k, f, t, r, true) is not null then raise exception 'smoke: a sent row was claimed with include_unknown'; end if;

  -- an unknown row is claimed only when the operator asks for unknowns
  update public.patient_sources_digest_sends set status = 'unknown', last_error = 'socket hang up'
   where alert_key = k and period_from = f and recipient = r;
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: an unknown row was claimed automatically'; end if;
  a := public._ps_digest_claim(k, f, t, r, true);
  if a is distinct from 3 then raise exception 'smoke: include_unknown re-claim should return 3, got %', a; end if;

  -- a STALE sending row (older than 15 minutes) becomes unknown and is NOT claimed
  update public.patient_sources_digest_sends set status = 'sending', last_error = null, updated_at = now() - interval '16 minutes'
   where alert_key = k and period_from = f and recipient = r;
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: a stale sending row was claimed'; end if;
  select status, last_error into s, e from public.patient_sources_digest_sends where alert_key = k and period_from = f and recipient = r;
  if s <> 'unknown' or e is null then raise exception 'smoke: a stale sending row must flip to unknown with a note (% / %)', s, e; end if;

  -- a 14-minute-old sending row is still in flight: untouched
  update public.patient_sources_digest_sends set status = 'sending', last_error = null, updated_at = now() - interval '14 minutes'
   where alert_key = k and period_from = f and recipient = r;
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: a fresh sending row was claimed'; end if;
  select status into s from public.patient_sources_digest_sends where alert_key = k and period_from = f and recipient = r;
  if s <> 'sending' then raise exception 'smoke: a 14-minute-old sending row must stay sending, got %', s; end if;

  -- a different period or recipient is its own claim
  if public._ps_digest_claim(k, f + 7, t + 7, r) is distinct from 1 then raise exception 'smoke: next period must claim fresh'; end if;
  if public._ps_digest_claim(k, f, t, 'ops@example.com') is distinct from 1 then raise exception 'smoke: another recipient must claim fresh'; end if;

  -- constraints
  begin
    insert into public.patient_sources_digest_sends (alert_key, period_from, period_to, recipient, status)
    values (k, f, t, 'x@example.com', 'bogus');
    raise exception 'smoke: a bogus status was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.patient_sources_digest_sends (alert_key, period_from, period_to, recipient, status)
    values ('stale_bookings', f, t, 'x@example.com', 'sent');
    raise exception 'smoke: a foreign alert key was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.patient_sources_digest_sends (alert_key, period_from, period_to, recipient, status)
    values (k, f, t, 'MixedCase@example.com', 'sent');
    raise exception 'smoke: a non-lower-case recipient was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public._ps_digest_claim(k, f, t, '   ');
    raise exception 'smoke: a blank recipient was accepted';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

-- ACLs and shape AFTER a full replay (migrations + seed.sql).
do $$
declare
  rel regclass := 'public.patient_sources_digest_sends'::regclass;
  fn  text := 'public._ps_digest_claim(text,date,date,text,boolean)';
  r   text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, rel, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(r, rel, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'smoke: % holds a privilege on the claim table after the seed (seed.sql re-revoke missing?)', r;
    end if;
    if has_function_privilege(r, fn, 'execute') then raise exception 'smoke: % can execute _ps_digest_claim', r; end if;
  end loop;
  if has_table_privilege('service_role', rel, 'DELETE,TRUNCATE') then raise exception 'smoke: service_role can delete claim rows (seed.sql service_role re-revoke missing?)'; end if;
  if not has_table_privilege('service_role', rel, 'SELECT,INSERT,UPDATE') then raise exception 'smoke: service_role lost select/insert/update on the claim table'; end if;
  if not has_function_privilege('service_role', fn, 'execute') then raise exception 'smoke: service_role cannot execute the claim'; end if;
  if not has_table_privilege('service_role', 'public.ad_spend_daily'::regclass, 'SELECT') then raise exception 'smoke: service_role cannot read ad_spend_daily'; end if;
  if not (select relrowsecurity from pg_class where oid = rel) then raise exception 'smoke: RLS is off'; end if;
  if exists (select 1 from pg_policy where polrelid = rel) then raise exception 'smoke: the claim table must have no policy'; end if;
  if (select count(*) from public.staff_alert_settings where alert_key in ('patient_sources_weekly', 'patient_sources_monthly')) <> 2 then
    raise exception 'smoke: a Patient Sources alert row is missing';
  end if;
  if (select prosecdef from pg_proc where oid = fn::regprocedure) then raise exception 'smoke: _ps_digest_claim must be SECURITY INVOKER'; end if;
  raise notice '0213 smoke: claim states, constraints and ACLs OK.';
end;
$$;

rollback;

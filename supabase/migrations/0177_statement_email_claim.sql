-- 0177 — one emailed statement per visit + recipient per window, atomically.
--
-- "Email to patient" on a visit's statement of account (PR #212) must not
-- send the same statement twice when two tabs, two receptionists or a
-- double-click race each other. The app's insert-then-count rate limiter
-- (src/lib/rate-limit/check.ts) cannot guarantee that: two contenders can
-- both insert before either counts (both refused, nothing sent), and a
-- failed send releasing "its" row cannot tell its row from a rival's.
--
-- claim_statement_email serialises contenders on a transaction-scoped
-- advisory lock keyed on the statement, admits exactly one per window, and
-- returns THAT claim's rate_limit_attempts id (null = refused; a refused
-- caller writes nothing). The caller releases a claim whose send did not go
-- out by deleting that one id — never another request's.
--
-- Invoker rights: only the service role calls it (the Server Action, via
-- the admin client), and rate_limit_attempts is service-role-only (0018).
-- EXECUTE is restated service_role-only (0119 default, stated by name).
-- Raises nothing, so no P-code.

create or replace function public.claim_statement_email(
  p_visit_id uuid,
  p_recipient text,
  p_window_seconds integer default 120
)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  v_key text := p_visit_id::text || ':' || lower(btrim(p_recipient));
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('statement_email:' || v_key, 0));

  if exists (
    select 1
      from public.rate_limit_attempts
     where bucket = 'statement_email'
       and identifier = v_key
       and attempted_at > now() - make_interval(secs => p_window_seconds)
  ) then
    return null;
  end if;

  insert into public.rate_limit_attempts (bucket, identifier)
  values ('statement_email', v_key)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.claim_statement_email(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_statement_email(uuid, text, integer) to service_role;

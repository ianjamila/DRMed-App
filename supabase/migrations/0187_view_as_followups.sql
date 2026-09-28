-- =============================================================================
-- 0187_view_as_followups.sql
-- =============================================================================
-- Admin "View as role" follow-ups — spec:
--   docs/superpowers/specs/2026-09-28-view-as-followups-design.md
--
-- 1. view_as_transition(): start / switch / exit in ONE row-locked
--    transaction that also writes the staff.view_as.* audit rows. Before this,
--    the app updated the row and then audited from a request-time snapshot,
--    so two tabs could double-log one "ended" and lose another (Codex P2).
-- 2. view_as_expire(): the lazy "ended / reason expired" row, written by the
--    first request that finds an expired override still stored. Idempotent
--    under concurrency: the second caller re-checks the locked row and finds
--    nothing to do.
-- 3. audit_log_stamp_view_as: every staff audit row written while the actor
--    is simulating gets metadata.acting_as = <simulated role>. A trigger, not
--    src/lib/audit/log.ts, because SQL functions insert audit rows directly
--    (0167, 0173, 0179) and a TS-only stamp would miss them.
--
-- All three are service-role only; the app calls the two functions through
-- the service-role client (while simulating, has_role(array['admin']) is
-- false, so RLS would refuse the admin's own row — see 0182).

create or replace function public.view_as_transition(
  p_actor uuid,
  p_role  text default null,
  p_ip    inet default null,
  p_ua    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_role  text;
  v_old_until timestamptz;
  v_until     timestamptz;
begin
  select view_as_role, view_as_until
    into v_old_role, v_old_until
    from public.staff_profiles
   where id = p_actor
     and role = 'admin'
     and is_active = true
     and deleted_at is null
   for update;
  if not found then
    raise exception 'Only an admin can view the app as another role.'
      using errcode = 'P0074';
  end if;

  if p_role is not null
     and p_role not in ('reception', 'medtech', 'xray_technician', 'pathologist') then
    raise exception 'Unknown role.' using errcode = '22023';
  end if;

  -- Close whatever the row carried: an active override ended by this call,
  -- or one that had already run out and was never cleaned up.
  if v_old_role is not null then
    insert into public.audit_log (actor_id, actor_type, action, metadata, ip_address, user_agent)
    values (
      p_actor, 'staff', 'staff.view_as.ended',
      case
        when v_old_until > now() then
          jsonb_build_object('role', v_old_role,
                             'reason', case when p_role is null then 'manual' else 'switched' end)
        else
          jsonb_build_object('role', v_old_role, 'reason', 'expired', 'expired_at', v_old_until)
      end,
      p_ip, p_ua
    );
  end if;

  if p_role is null then
    update public.staff_profiles
       set view_as_role = null, view_as_until = null
     where id = p_actor;
    return jsonb_build_object('role', null, 'until', null);
  end if;

  v_until := now() + interval '4 hours';
  update public.staff_profiles
     set view_as_role = p_role, view_as_until = v_until
   where id = p_actor;
  insert into public.audit_log (actor_id, actor_type, action, metadata, ip_address, user_agent)
  values (p_actor, 'staff', 'staff.view_as.started',
          jsonb_build_object('role', p_role, 'until', v_until), p_ip, p_ua);
  return jsonb_build_object('role', p_role, 'until', v_until);
end;
$$;

comment on function public.view_as_transition(uuid, text, inet, text) is
  'Admin View-as start/switch (p_role) or exit (null). Locks the admin row, writes the override and the staff.view_as.* audit rows atomically. Service role only.';

create or replace function public.view_as_expire(
  p_actor uuid,
  p_ip    inet default null,
  p_ua    text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  text;
  v_until timestamptz;
begin
  -- FOR UPDATE re-checks the WHERE after waiting on a concurrent caller's
  -- lock, so only the first of two racing requests finds the stale row.
  select view_as_role, view_as_until
    into v_role, v_until
    from public.staff_profiles
   where id = p_actor
     and role = 'admin'
     and view_as_role is not null
     and view_as_until <= now()
   for update;
  if not found then
    return false;
  end if;

  update public.staff_profiles
     set view_as_role = null, view_as_until = null
   where id = p_actor;
  insert into public.audit_log (actor_id, actor_type, action, metadata, ip_address, user_agent)
  values (p_actor, 'staff', 'staff.view_as.ended',
          jsonb_build_object('role', v_role, 'reason', 'expired', 'expired_at', v_until),
          p_ip, p_ua);
  return true;
end;
$$;

comment on function public.view_as_expire(uuid, inet, text) is
  'Clears an admin''s EXPIRED View-as override and writes staff.view_as.ended reason=expired, once. No-op otherwise. Service role only.';

create or replace function public.audit_log_stamp_view_as()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if new.actor_type is distinct from 'staff'
     or new.actor_id is null
     or starts_with(new.action, 'staff.view_as.') then
    return new;
  end if;
  -- Merging into a non-object (array/scalar) would change its shape; none
  -- exist today, so leave such a row alone rather than rewrite it.
  if new.metadata is not null and jsonb_typeof(new.metadata) <> 'object' then
    return new;
  end if;
  -- Same effective-override condition as staff_role()/has_role() (0182).
  select view_as_role into v_role
    from public.staff_profiles
   where id = new.actor_id
     and role = 'admin'
     and view_as_until > now();
  if v_role is not null then
    new.metadata := coalesce(new.metadata, '{}'::jsonb)
                    || jsonb_build_object('acting_as', v_role);
  end if;
  return new;
end;
$$;

comment on function public.audit_log_stamp_view_as() is
  'BEFORE INSERT on audit_log: stamps metadata.acting_as on staff rows written while the actor is viewing the app as another role.';

drop trigger if exists audit_log_stamp_view_as on public.audit_log;
create trigger audit_log_stamp_view_as
  before insert on public.audit_log
  for each row execute function public.audit_log_stamp_view_as();

revoke all on function public.view_as_transition(uuid, text, inet, text) from public, anon, authenticated;
grant execute on function public.view_as_transition(uuid, text, inet, text) to service_role;
revoke all on function public.view_as_expire(uuid, inet, text) from public, anon, authenticated;
grant execute on function public.view_as_expire(uuid, inet, text) to service_role;
revoke all on function public.audit_log_stamp_view_as() from public, anon, authenticated;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.view_as_transition(uuid, text, inet, text)',
    'public.view_as_expire(uuid, inet, text)',
    'public.audit_log_stamp_view_as()'
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '0187: % must not be executable by anon/authenticated', v_fn;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.view_as_transition(uuid, text, inet, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.view_as_expire(uuid, inet, text)', 'EXECUTE') then
    raise exception '0187: service_role lost EXECUTE on a View-as function';
  end if;
end $$;

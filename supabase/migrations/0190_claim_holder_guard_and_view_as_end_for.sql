-- =============================================================================
-- 0190_claim_holder_guard_and_view_as_end_for.sql
-- =============================================================================
-- Addendum A1 + A3 — spec:
--   docs/superpowers/specs/2026-09-28-view-as-followups-design.md
--
-- A1. Claim rule enforced in the database (P0075)
-- ------------------------------------------------
-- RLS lets every active staff role UPDATE test_requests (0151's
-- "reception/admin write" FOR ALL policy plus the lab-role update policy) —
-- who may actually HOLD a line (claim it into their own name) is today
-- decided only in TypeScript: canClaimSection() in
-- src/lib/auth/role-sections.ts, which combines the role's section scope
-- (SECTIONS_BY_ROLE — [] denies, null is unrestricted) with the single-owner
-- map CLAIM_OWNER_BY_SECTION (currently only imaging_xray -> xray_technician).
-- Every holder write goes through three app paths (claim, bulk claim,
-- consolidated-panel claim) and one hand-over (reassign) — four places that
-- could each independently drift from the TS rule, or be bypassed entirely by
-- a direct RPC/SQL write. This migration moves the rule into the database so
-- it applies to EVERY caller of every path, service_role included: a
-- BEFORE INSERT OR UPDATE OF assigned_to trigger on test_requests that raises
-- P0075 unless the incoming holder is active, works this line's section (or
-- is unrestricted), and — for a single-owner section — is that owner. It
-- mirrors, rather than replaces, the TS check: canClaimSection() still gates
-- the UI so the app shows a clean refusal instead of a raw exception, but the
-- trigger is what makes the rule actually hold everywhere.
--
-- The holder's role is its EFFECTIVE role — the same
-- `case when role = 'admin' and view_as_until > now() then view_as_role
--  else role end` CASE 0182 put on staff_role()/has_role() — so an admin who
-- is simulating xray_technician can claim an x-ray line (they see, and are
-- meant to test, exactly what an xray_technician can do), while a genuine
-- admin (no active override) still cannot: the owner rule is not lifted by
-- being unrestricted. Only assigned_to is watched: unclaiming (-> null) and
-- every other column change are untouched, and a row is only re-judged the
-- moment its holder actually changes, never retroactively.
--
-- A3. "End now" on Active role views (P0076)
-- --------------------------------------------
-- view_as_end_for(): lets one admin end ANOTHER admin's active View-as
-- override from the /staff/users panel (the target cannot end their own —
-- they cannot even load that page while simulating, since has_role(['admin'])
-- is false for them; the button is hidden on their own line regardless). The
-- caller must be a genuine admin (real role, not effective) who is not
-- themselves mid-simulation, or the call is refused with P0076 — the same
-- shape as 0187's view_as_transition()/view_as_expire(), service-role only,
-- called from the app through the service-role client because RLS would
-- otherwise refuse a simulating admin's own row (0182) and there is no
-- "another admin's row" policy to lean on for a plain UPDATE either.

-- ---- A1: the claim-holder guard --------------------------------------------

create or replace function public.test_requests_claim_holder_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_section  text;
  v_role     text;
  v_active   boolean;
  v_sections text[];
  v_owner    text;
begin
  -- Unclaiming is always allowed, and a holder that did not change (not an
  -- INSERT, and UPDATE ... SET assigned_to = <same value>) is not re-judged.
  if new.assigned_to is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then
    return new;
  end if;

  select s.section into v_section
    from public.services s
   where s.id = new.service_id;

  select
    case when sp.role = 'admin' and sp.view_as_until > now() then sp.view_as_role else sp.role end,
    sp.is_active
    into v_role, v_active
    from public.staff_profiles sp
   where sp.id = new.assigned_to
     and sp.deleted_at is null;

  if not found or v_active is not true then
    raise exception 'This staff member doesn''t work this test''s section, so they can''t hold it.'
      using errcode = 'P0075';
  end if;

  -- Section scope: null = unrestricted (admin, pathologist); otherwise the
  -- line's section must be one this role works, and a section-less line
  -- (should not happen, but the column is nullable) only passes for an
  -- unrestricted role.
  v_sections := public.lab_sections_for_role(v_role);
  if v_sections is not null
     and (v_section is null or not (v_section = any(v_sections))) then
    raise exception 'This staff member doesn''t work this test''s section, so they can''t hold it.'
      using errcode = 'P0075';
  end if;

  -- Single-owner sections: a SQL mirror of CLAIM_OWNER_BY_SECTION
  -- (src/lib/auth/role-sections.ts). This narrows CLAIMING only, and applies
  -- even to a role the section scope above would otherwise let through
  -- (an unrestricted admin/pathologist still cannot hold an x-ray line). The
  -- message names the actual reason (single-owner role), not the generic
  -- section-scope refusal above.
  v_owner := case v_section
    when 'imaging_xray' then 'xray_technician'
    else null
  end;
  if v_owner is not null and v_owner is distinct from v_role then
    raise exception 'Only an % can hold this test.',
      case v_owner
        when 'xray_technician' then 'X-ray Technician'
        else initcap(replace(v_owner, '_', ' '))
      end
      using errcode = 'P0075';
  end if;

  return new;
end;
$$;

comment on function public.test_requests_claim_holder_guard() is
  'BEFORE INSERT OR UPDATE OF assigned_to on test_requests: raises P0075 unless the incoming holder is an active, non-deleted staff member whose EFFECTIVE role (0182) works the line''s section (lab_sections_for_role) and, for a single-owner section (imaging_xray), is that owner. Mirrors canClaimSection()/CLAIM_OWNER_BY_SECTION in src/lib/auth/role-sections.ts so the rule holds for every caller, service_role included — see the file header for why this lives in the database as well as in TypeScript.';

drop trigger if exists test_requests_claim_holder_guard on public.test_requests;
create trigger test_requests_claim_holder_guard
  before insert or update of assigned_to on public.test_requests
  for each row execute function public.test_requests_claim_holder_guard();

-- ---- A3: view_as_end_for ----------------------------------------------------

create or replace function public.view_as_end_for(
  p_actor  uuid,
  p_target uuid,
  p_ip     inet default null,
  p_ua     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role         text;
  v_actor_active       boolean;
  v_actor_view_until   timestamptz;
  v_target_role        text;
  v_target_view_role   text;
  v_target_view_until  timestamptz;
begin
  -- The actor must be a genuine (real-role), active, non-deleted admin who is
  -- NOT currently simulating another role themselves.
  select role, is_active, view_as_until
    into v_actor_role, v_actor_active, v_actor_view_until
    from public.staff_profiles
   where id = p_actor
     and deleted_at is null;

  if not found
     or v_actor_active is not true
     or v_actor_role is distinct from 'admin'
     or v_actor_view_until > now() then
    raise exception 'Only an admin who isn''t viewing the app as another role can end someone''s role view.'
      using errcode = 'P0076';
  end if;

  -- Lock the target row before deciding whether there is anything to end.
  select role, view_as_role, view_as_until
    into v_target_role, v_target_view_role, v_target_view_until
    from public.staff_profiles
   where id = p_target
   for update;

  if not found
     or v_target_role is distinct from 'admin'
     or v_target_view_role is null
     or v_target_view_until is null
     or v_target_view_until <= now() then
    return false;
  end if;

  update public.staff_profiles
     set view_as_role = null, view_as_until = null
   where id = p_target;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent)
  values (
    p_actor, 'staff', 'staff.view_as.ended', 'staff_profile', p_target,
    jsonb_build_object('role', v_target_view_role, 'reason', 'ended_by_admin', 'target_id', p_target),
    p_ip, p_ua
  );
  return true;
end;
$$;

comment on function public.view_as_end_for(uuid, uuid, inet, text) is
  'Admin B ends admin A''s active View-as override (the "End now" button on /staff/users). Refuses P0076 unless p_actor is an active, non-deleted admin NOT itself simulating. Locks the target row; returns false (writes nothing) if the target has no active admin override to end. Service role only.';

-- ---- ACLs -------------------------------------------------------------------
revoke execute on function public.test_requests_claim_holder_guard() from public, anon, authenticated;
revoke execute on function public.view_as_end_for(uuid, uuid, inet, text) from public, anon, authenticated;
grant  execute on function public.test_requests_claim_holder_guard() to service_role;
grant  execute on function public.view_as_end_for(uuid, uuid, inet, text) to service_role;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.test_requests_claim_holder_guard()',
    'public.view_as_end_for(uuid, uuid, inet, text)'
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '0190: % must not be executable by anon/authenticated', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '0190: service_role lost EXECUTE on %', v_fn;
    end if;
  end loop;
end $$;

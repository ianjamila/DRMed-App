-- 0123_employee_leave_balance_authz.sql
--
-- Add an authorization check to public.employee_leave_balance().
--
-- THE DEFECT (pre-existing, dates to 0044_payroll.sql:621)
-- --------------------------------------------------------
-- employee_leave_balance() is SECURITY DEFINER and does no role check, and
-- `authenticated` holds EXECUTE. PostgREST exposes it as an RPC, so any
-- signed-in staff member — reception, medtech, anyone — could call
--
--     supabase.rpc('employee_leave_balance', { p_employee_id: '<any uuid>',
--                                              p_kind: 'VL' })
--
-- and read any other employee's leave balance, bypassing the admin-only UI
-- gate on /staff/admin/payroll/leaves. The RLS on employee_leave_records is
-- admin-only for writes and self-only for reads; the function walked straight
-- past it because SECURITY DEFINER runs as the owner.
--
-- Reported during the PR 10 review (#116) as an out-of-scope finding. 0118
-- deliberately did NOT touch the grant — see below.
--
-- WHY NOT JUST REVOKE `authenticated` EXECUTE
-- -------------------------------------------
-- 0118 classified this function into "bucket B" and kept the grant on purpose.
-- employee_leave_records_no_overdraw() is a SECURITY INVOKER trigger on
-- employee_leave_records that nest-calls this function, and a SECURITY INVOKER
-- function nest-calling a SECURITY DEFINER helper fails with "permission
-- denied" when the CALLING role lacks EXECUTE (verified empirically on a bare
-- pg17 container during PR 10 — FACT 2). Revoking would break leave-record
-- writes. The fix therefore has to live in the function body.
--
-- WHY NOT JUST `has_role(array['admin'])`
-- ---------------------------------------
-- That is the obvious one-liner and it would break production. All four
-- application call sites go through the service-role admin client, each behind
-- its own requireAdminStaff() gate:
--
--     src/lib/payroll/payslip-pdf.ts:355,360
--     src/app/(staff)/staff/(dashboard)/admin/payroll/leaves/page.tsx:77,84
--     src/app/(staff)/staff/(dashboard)/admin/payroll/leaves/actions.ts:420
--     src/app/(staff)/staff/(dashboard)/admin/payroll/employees/[id]/page.tsx:66,67
--
-- Under service_role auth.uid() is NULL, so has_role() returns false and every
-- one of those — including payslip PDF generation — would start failing.
--
-- THE CHECK
-- ---------
-- Three callers are legitimate, keyed off the JWT role claim (a GUC, so it
-- reflects the ORIGINAL requester even inside SECURITY DEFINER):
--
--   1. service_role            — trusted server code; the four call sites above.
--   2. no JWT claim at all     — a direct Postgres connection: psql, migrations,
--                                apply_leave_entitlements() run by an operator.
--                                Reaching this already requires DB credentials.
--   3. authenticated, and either an admin (which covers the trigger path, since
--      "employee_leave_records: admin all" is the only INSERT policy on that
--      table) or an employee reading their OWN balance — which the existing
--      "employee_leave_records: self read" policy already exposes row by row,
--      so this grants nothing new.
--
-- Everything else raises insufficient_privilege (42501).

create or replace function public.employee_leave_balance(
  p_employee_id uuid,
  p_kind        text,
  p_as_of_date  date default current_date
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- auth.role() reads the request.jwt.claims GUC. NULL on a direct
  -- (non-PostgREST) connection; 'service_role' / 'authenticated' / 'anon'
  -- through PostgREST.
  v_jwt_role text := auth.role();
begin
  if coalesce(v_jwt_role, '') not in ('', 'service_role')
     and not public.has_role(array['admin'])
     and not exists (
       select 1
       from public.employees
       where id = p_employee_id
         and staff_profile_id = auth.uid()
     )
  then
    raise exception 'Not authorized to read this employee''s leave balance.'
      using errcode = '42501';
  end if;

  return (
    select coalesce(sum(days_delta), 0)::numeric(5,2)
    from public.employee_leave_records
    where employee_id = p_employee_id
      and kind = p_kind
      and effective_date <= p_as_of_date
      and (expiry_date is null or expiry_date > p_as_of_date)
  );
end;
$$;

-- CREATE OR REPLACE preserves the existing ACL, but re-assert it so this
-- migration is self-contained on a fresh replay and so the intent is explicit:
-- authenticated keeps EXECUTE (the trigger path — FACT 2), anon and PUBLIC do
-- not (0118), service_role does (the admin client).
revoke execute on function public.employee_leave_balance(uuid, text, date) from public, anon;
grant  execute on function public.employee_leave_balance(uuid, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Self-verification — fails the migration in BOTH directions, in the style of
-- 0118. A silent no-op here would leave the hole open.
-- ---------------------------------------------------------------------------
do $verify$
declare
  v_secdef  boolean;
  v_lang    text;
  v_src     text;
begin
  select p.prosecdef, l.lanname, p.prosrc
    into v_secdef, v_lang, v_src
  from pg_proc p
  join pg_language l on l.oid = p.prolang
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'employee_leave_balance'
    and pg_get_function_identity_arguments(p.oid) = 'p_employee_id uuid, p_kind text, p_as_of_date date';

  -- (1) still SECURITY DEFINER — it has to be, the caller cannot read the table
  if v_secdef is not true then
    raise exception '0123: employee_leave_balance is no longer SECURITY DEFINER';
  end if;

  -- (2) the body actually carries the check
  if v_lang <> 'plpgsql' or v_src not like '%42501%' then
    raise exception '0123: employee_leave_balance body has no authorization check (lang=%, src missing 42501)', v_lang;
  end if;

  -- (3) authenticated MUST keep EXECUTE or the no-overdraw trigger breaks (FACT 2)
  if not has_function_privilege('authenticated', 'public.employee_leave_balance(uuid, text, date)', 'EXECUTE') then
    raise exception '0123: employee_leave_balance lost authenticated EXECUTE — staff leave-record writes would fail';
  end if;

  -- (4) service_role MUST keep EXECUTE or payslip PDFs and the admin payroll
  --     pages break
  if not has_function_privilege('service_role', 'public.employee_leave_balance(uuid, text, date)', 'EXECUTE') then
    raise exception '0123: employee_leave_balance lost service_role EXECUTE — the admin client would fail';
  end if;

  -- (5) anon must NOT have it (0118 state preserved)
  if has_function_privilege('anon', 'public.employee_leave_balance(uuid, text, date)', 'EXECUTE') then
    raise exception '0123: employee_leave_balance is anon-executable — 0118 state was lost';
  end if;
end
$verify$;

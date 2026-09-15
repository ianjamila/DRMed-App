-- 0148_ops_daily_view_grants.sql
-- Make the `v_ops_daily_*` grants match what 0093 said they were.
--
-- 0093's header states, of the operational daily views: "security_invoker = on
-- + NO grant to anon/authenticated: only the service-role admin client reads
-- these (they expose clinic-wide financials past patient RLS)." The first half
-- is true. The second half never was — not because 0093 granted anything, but
-- because it did not have to: this database carries
--
--   alter default privileges ... in schema public grant all on tables to
--     anon, authenticated, service_role
--
-- from both `postgres` and `supabase_admin` (Supabase's own bootstrap), and
-- those apply to VIEWS as well as tables. Every view created in `public` since
-- has been handed all privileges to anon and authenticated on creation. Prod
-- measured 2026-09-15: all nine `v_ops_daily_*` views hold
-- DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE for both roles.
--
-- THIS IS NOT A LIVE EXPOSURE, and the migration is not an incident fix. Every
-- one of these views is `security_invoker = on`, so a grant only ever gets the
-- caller as far as the base tables, where RLS applies to them as anon or
-- authenticated and returns nothing. This closes the gap between the stated
-- intent and the actual ACL, which is worth closing on its own: the next
-- person to read 0093's header and reason from it would be reasoning from
-- something untrue, and the defence stops being defence-in-depth when only one
-- of the two layers is actually there.
--
-- Safe to revoke: verified 2026-09-15 that all thirteen reads of these views —
-- the four /admin/operations pages, the admin dashboard's net-income tiles and
-- the four operations CSV routes — go through `createAdminClient()`
-- (service_role), which is untouched below. No route reads them with the
-- RLS-scoped server client or the browser client.
--
-- Same shape as 0134/0135/0136, which revoked the other views' grants for the
-- same reason. As those did, this needs a matching re-revoke at the tail of
-- `supabase/seed.sql`: `db push` ignores seed.sql, so without it a fresh local
-- database re-grants these through the same default privileges and silently
-- stops matching prod on exactly the ACL this migration exists to set.

revoke all on public.v_ops_daily_channel          from anon, authenticated;
revoke all on public.v_ops_daily_collections      from anon, authenticated;
revoke all on public.v_ops_daily_doctor           from anon, authenticated;
revoke all on public.v_ops_daily_expense_accounts from anon, authenticated;
revoke all on public.v_ops_daily_expenses         from anon, authenticated;
revoke all on public.v_ops_daily_hmo_provider_ar  from anon, authenticated;
revoke all on public.v_ops_daily_hmo_received     from anon, authenticated;
revoke all on public.v_ops_daily_pnl              from anon, authenticated;
revoke all on public.v_ops_daily_totals           from anon, authenticated;

do $$
declare
  v_leftover int;
begin
  select count(*) into v_leftover
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name like 'v\_ops\_daily\_%'
     and grantee in ('anon', 'authenticated');

  if v_leftover <> 0 then
    raise exception
      '0148: % grant(s) on v_ops_daily_* still held by anon/authenticated', v_leftover;
  end if;

  raise notice
    '0148: revoked anon/authenticated from all nine v_ops_daily_* views (service_role untouched).';
end $$;

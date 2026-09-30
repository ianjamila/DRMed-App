-- 0151 smoke: every RLS policy evaluates its STABLE helpers once per query.
--
-- has_role(), is_staff(), staff_role() and current_patient_id() are STABLE, but a
-- bare call in a policy USING clause is still evaluated PER ROW — STABLE only
-- promises the answer will not change within the statement, it does not tell the
-- planner to call the function once. Wrapping as (select fn(...)) makes it an
-- InitPlan. 0151 rewrote 149 of 160 policies; this fails if one comes back.
--
-- Two-step on purpose. A single regex cannot tell `has_role(` from
-- `(select has_role(` without a lookbehind: the character before the name is a
-- space, which satisfies [^.[:alnum:]_], so the naive pattern matches the WRAPPED
-- form too and fails on exactly the databases it is meant to pass. So: blank out
-- every correctly-wrapped call first, then anything still matching is a real
-- per-row call.
--
-- Note Postgres re-renders the wrapper with an inferred column alias —
-- `(select has_role(x))` reads back as `(SELECT has_role(x) AS has_role)` — which
-- is why the strip pattern anchors on the opening `(select fn` and not the close.
do $$
declare
  bad_count int;
  bad_list  text;
begin
  with scanned as (
    select tablename, policyname,
           regexp_replace(
             coalesce(qual, '') || ' ' || coalesce(with_check, ''),
             '\(\s*select\s+(has_role|is_staff|staff_role|current_patient_id)',
             '(WRAPPED',
             'gi'
           ) as stripped
    from pg_policies
    where schemaname = 'public'
  )
  select count(*), string_agg(tablename || '.' || policyname, ', ' order by tablename)
    into bad_count, bad_list
  from scanned
  where stripped ~ '(^|[^.[:alnum:]_])(has_role|is_staff|staff_role|current_patient_id)[[:space:]]*\(';

  if bad_count > 0 then
    raise exception
      '0151 smoke: % policies still call a STABLE helper per row: %',
      bad_count, bad_list;
  end if;

  raise notice '0151 smoke: all policies evaluate their helpers once per query.';
end $$;

-- Second assertion: the rewrite must not have quietly dropped anyone's access.
--
-- "RLS enabled with no policy" denies everything to anon and authenticated. Eight
-- tables are deliberately in that state — counters, import bookkeeping, merge
-- history and the Sheet Sync staging buffer that only service_role touches, auto-protected by 0124's ensure_rls event
-- trigger. So the assertion cannot be "no such table exists"; a first draft said
-- that and failed on a perfectly correct database, which is the same mistake as a
-- regex that matches the form it is meant to allow.
--
-- Pin the known set instead, and fail if it GROWS. That still catches a policy
-- dropped by accident — the failure mode this migration could actually cause —
-- without flagging eight deliberate denials. If you add a table to this list, say
-- in the commit why it is service_role-only.
do $$
declare
  newly_unprotected text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into newly_unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    and c.relname not in (
      'bill_payment_year_counters',
      'bill_year_counters',
      'je_year_counters',
      'legacy_import_runs',
      'patient_consents',
      'patient_merges',
      'pf_disbursement_year_counters',
      -- 0170: raw sheet rows parked between sheet_mirror_stage() and the
      -- apply step. Only the service-role sync RPCs read or write it (0170
      -- revokes anon/authenticated: "Staging: no policy"), and no admin page
      -- shows it, so any policy here would only widen access.
      'sheet_mirror_staging'
    );

  if newly_unprotected is not null then
    raise exception
      '0151 smoke: RLS enabled but NO policy on: % — these tables now deny everything',
      newly_unprotected;
  end if;

  raise notice '0151 smoke: no table lost its last policy.';
end $$;

-- Third assertion (0202): a table on the list above is service_role-only, so
-- anon and authenticated must hold NO privilege on it. "RLS on, no policy"
-- denies every row today, but a table-level grant left behind turns the first
-- policy anyone adds — for any purpose — into a read or write path. Supabase's
-- default privileges hand both roles ALL on every new table, so a table newly
-- added to the list will fail here until its migration revokes them.
do $$
declare
  granted text;
begin
  select string_agg(distinct c.relname || ' (' || r.rolname || ')', ', ')
    into granted
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as r(rolname)
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    and has_table_privilege(r.rolname, c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');

  if granted is not null then
    raise exception
      '0151 smoke: RLS-on/no-policy tables still grant privileges to: %', granted;
  end if;

  raise notice '0151 smoke: no-policy tables grant nothing to anon/authenticated.';
end $$;

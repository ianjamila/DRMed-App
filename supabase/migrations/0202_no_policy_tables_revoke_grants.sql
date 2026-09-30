-- 0202: the eight RLS-on / no-policy tables — nobody but service_role holds any
-- privilege on them.
--
-- The 0151 smoke pins eight public tables that deliberately have RLS enabled and
-- NO policy: the year counters behind bill / bill-payment / JE / PF-disbursement
-- numbering, legacy import bookkeeping, patient consents, the merge ledger, and
-- (since 0170) the Sheet Sync staging buffer. Every reader and writer is the
-- service-role client or a SECURITY DEFINER function — no route reads them
-- through the RLS-scoped or patient client, and no view or SECURITY INVOKER
-- function references them (both checked 2026-09-30).
--
-- RLS already denies anon and authenticated every row, but the schema's default
-- privileges had handed BOTH roles ALL table privileges on seven of them (prod,
-- checked 2026-09-30; 0170 already revoked the staging buffer's). That is the
-- same ACL 0171 closed on v_patients_directory: harmless only until someone
-- adds a policy for a different purpose, at which point it becomes a read — or
-- a write — path to consent records and the merge history. Revoke by name so
-- the deny no longer rests on the absence of a policy.
--
-- service_role and postgres are untouched; SECURITY DEFINER functions run as
-- their owner, so the counters and ledgers they maintain keep working.
-- supabase/seed.sql mirrors these revokes (seed-grant-parity.test.ts), and the
-- 0151 smoke now fails if any table on its no-policy list regains a privilege.
-- No P-codes; raises only in the post-condition below.

revoke all on public.bill_payment_year_counters    from public, anon, authenticated;
revoke all on public.bill_year_counters            from public, anon, authenticated;
revoke all on public.je_year_counters              from public, anon, authenticated;
revoke all on public.legacy_import_runs            from public, anon, authenticated;
revoke all on public.patient_consents              from public, anon, authenticated;
revoke all on public.patient_merges                from public, anon, authenticated;
revoke all on public.pf_disbursement_year_counters from public, anon, authenticated;
revoke all on public.sheet_mirror_staging          from public, anon, authenticated;

-- Post-condition: no table-level privilege of any kind left for anon/authenticated,
-- and service_role still has full access.
do $$
declare
  t    text;
  priv text;
begin
  foreach t in array array[
    'bill_payment_year_counters', 'bill_year_counters', 'je_year_counters',
    'legacy_import_runs', 'patient_consents', 'patient_merges',
    'pf_disbursement_year_counters', 'sheet_mirror_staging'] loop
    foreach priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', format('public.%I', t), priv)
         or has_table_privilege('authenticated', format('public.%I', t), priv) then
        raise exception '0202: anon/authenticated still hold % on %', priv, t;
      end if;
    end loop;
    if not has_table_privilege('service_role', format('public.%I', t), 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception '0202: service_role lost access to %', t;
    end if;
  end loop;
end $$;

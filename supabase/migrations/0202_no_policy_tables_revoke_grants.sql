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
-- The two identity sequences behind patient_consents.seq and
-- sheet_mirror_staging.seq carried the same anon/authenticated USAGE/SELECT/
-- UPDATE grants; they are revoked too. postgres is untouched; SECURITY DEFINER
-- functions run as their owner, so the counters and ledgers they maintain keep
-- working. service_role's DML is granted EXPLICITLY: prod already has it
-- (arwdDxtm), but a fresh local replay only reaches full service_role grants
-- when seed.sql runs after every migration, so without the grant the
-- post-condition below would abort `db reset`.
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

revoke all on sequence public.patient_consents_seq_seq     from public, anon, authenticated;
revoke all on sequence public.sheet_mirror_staging_seq_seq from public, anon, authenticated;

grant select, insert, update, delete on
  public.bill_payment_year_counters, public.bill_year_counters, public.je_year_counters,
  public.legacy_import_runs, public.patient_consents, public.patient_merges,
  public.pf_disbursement_year_counters, public.sheet_mirror_staging
  to service_role;
grant usage, select, update on sequence
  public.patient_consents_seq_seq, public.sheet_mirror_staging_seq_seq
  to service_role;

-- Post-condition: no privilege of any kind (table, column or owned sequence)
-- left for anon/authenticated, and service_role holds EACH DML privilege —
-- checked one at a time, since a comma-separated has_table_privilege list is
-- satisfied by ANY one of them.
do $$
declare
  t    text;
  priv text;
begin
  foreach t in array array[
    'bill_payment_year_counters', 'bill_year_counters', 'je_year_counters',
    'legacy_import_runs', 'patient_consents', 'patient_merges',
    'pf_disbursement_year_counters', 'sheet_mirror_staging'] loop
    foreach priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if has_table_privilege('anon', format('public.%I', t), priv)
         or has_table_privilege('authenticated', format('public.%I', t), priv) then
        raise exception '0202: anon/authenticated still hold % on %', priv, t;
      end if;
    end loop;
    if has_any_column_privilege('anon', format('public.%I', t), 'SELECT,INSERT,UPDATE,REFERENCES')
       or has_any_column_privilege('authenticated', format('public.%I', t), 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception '0202: anon/authenticated still hold a column privilege on %', t;
    end if;
    foreach priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', t), priv) then
        raise exception '0202: service_role lacks % on %', priv, t;
      end if;
    end loop;
  end loop;
  foreach t in array array['patient_consents_seq_seq', 'sheet_mirror_staging_seq_seq'] loop
    if has_sequence_privilege('anon', format('public.%I', t), 'USAGE,SELECT,UPDATE')
       or has_sequence_privilege('authenticated', format('public.%I', t), 'USAGE,SELECT,UPDATE') then
      raise exception '0202: anon/authenticated still hold a privilege on sequence %', t;
    end if;
  end loop;
end $$;

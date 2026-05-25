-- scripts/smoke-0054-0055.sql
-- Verify migrations 0054 (legacy_intake_and_birthdate_confirm) and 0055
-- (referral_sources_lookup) applied correctly.
--
-- Run: docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/smoke-0054-0055.sql

\echo '== 0054+0055 smoke starting =='
set search_path = public, pg_temp;

-- ==========================================================================
-- A1: patients.birthdate is now nullable.
-- ==========================================================================

do $$ begin
  assert (
    select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'patients' and column_name = 'birthdate'
  ) = 'YES',
    'A1 FAIL: patients.birthdate is still NOT NULL';
end $$;

\echo '== A1 passed (birthdate nullable) =='

-- ==========================================================================
-- A2: three new columns exist on patients with correct names.
-- ==========================================================================

do $$ begin
  assert (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'patients'
      and column_name in ('birthdate_confirmed', 'legacy_intake', 'legacy_import_run_id')
  ) = 3,
    'A2 FAIL: expected 3 new patients columns (birthdate_confirmed, legacy_intake, legacy_import_run_id)';
end $$;

\echo '== A2 passed (new patients columns exist) =='

-- ==========================================================================
-- A3: pg_trgm extension is installed.
-- ==========================================================================

do $$ begin
  assert exists (select 1 from pg_extension where extname = 'pg_trgm'),
    'A3 FAIL: pg_trgm extension not installed';
end $$;

\echo '== A3 passed (pg_trgm installed) =='

-- ==========================================================================
-- A4: referral_sources seeded with exactly 12 active rows.
-- ==========================================================================

do $$ begin
  assert (select count(*) from public.referral_sources where is_active) = 12,
    'A4 FAIL: expected 12 active referral_sources rows';
end $$;

\echo '== A4 passed (referral_sources 12 active rows) =='

-- ==========================================================================
-- A5: legacy_import_runs round-trip and rollback-by-batch delete works.
-- Runs inside its own sub-transaction so cleanup is always attempted.
-- ==========================================================================

do $$
declare
  v_run_id    uuid;
  v_patient_id uuid;
begin
  insert into public.legacy_import_runs (source, dry_run, rows_in)
    values ('smoke_test', false, 1)
    returning id into v_run_id;

  insert into public.patients (first_name, last_name, legacy_import_run_id, legacy_intake)
    values ('Smoke', 'Test', v_run_id, '{"source":"smoke"}'::jsonb)
    returning id into v_patient_id;

  -- Rollback-by-batch: delete patients first (RESTRICT FK), then the run row.
  delete from public.patients where legacy_import_run_id = v_run_id;

  assert not exists (select 1 from public.patients where id = v_patient_id),
    'A5 FAIL: rollback-by-batch delete left orphan patients row';

  -- Run row should still exist (no CASCADE); delete it cleanly.
  delete from public.legacy_import_runs where id = v_run_id;

  assert not exists (select 1 from public.legacy_import_runs where id = v_run_id),
    'A5 FAIL: legacy_import_runs row not deleted';
end $$;

\echo '== A5 passed (legacy_import_runs round-trip + rollback-by-batch) =='

-- ==========================================================================
-- A6: existing rows that have a non-null birthdate were retroactively
-- confirmed (birthdate_confirmed = true). On a freshly-reset DB with no
-- patients this passes trivially (0 unconfirmed-with-DOB rows).
-- ==========================================================================

do $$ begin
  assert (
    select count(*) from public.patients
    where birthdate is not null and birthdate_confirmed = false
      and legacy_import_run_id is null  -- exclude any legacy rows intentionally unconfirmed
  ) = 0,
    'A6 FAIL: pre-existing rows with DOB were not auto-confirmed by migration backfill';
end $$;

\echo '== A6 passed (birthdate_confirmed backfill) =='

\echo '== SMOKE 0054+0055: all assertions passed =='

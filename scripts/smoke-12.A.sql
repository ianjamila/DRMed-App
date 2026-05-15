-- =============================================================================
-- smoke-12.A.sql
-- =============================================================================
-- Dispatch-5 full smoke for 12.A HMO history import. Loads ~6 synthetic staging
-- rows directly (skipping the XLSX parsing layer — that path is exercised by
-- the browser smoke). Exercises commit_hmo_history_run end-to-end and asserts
-- 10 properties of the resulting op-rows + opening JEs.
--
-- Run via:
--   supabase db reset
--   psql "$(supabase status --output json | jq -r .DB_URL)" -f scripts/smoke-12.A.sql
--
-- The entire smoke runs inside a single transaction that ROLLBACKs at the end,
-- so it leaves no residue. The commit function uses pg_advisory_xact_lock and
-- transaction-scoped set_config — both compatible with rollback. The smoke
-- bootstraps its own admin staff_profile + services + run + staging rows
-- (auth.users insert + staff_profiles insert + services inserts), so it does
-- NOT require pre-seeded test fixtures and is safe against a freshly-reset DB.
--
-- Expected final NOTICE: "all 10 smoke assertions PASS".
--
-- Plan-text bug fixes applied (see D5 hand-off prompt):
--   1. audit_log uses resource_id, not entity_id.
--   2. staff_profiles.id IS auth.users.id (no .user_id column).
--   3. journal_entries uses description, not narrative.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_run_id            uuid := gen_random_uuid();
  v_admin_auth        uuid := gen_random_uuid();
  v_maxicare          uuid;
  v_valucare          uuid;
  v_cbc_service       uuid;
  v_routine_service   uuid;
  v_jes_balanced      int;
  v_summary           jsonb;
  v_n_patients        int;
  v_n_visits          int;
  v_n_test_requests   int;
  v_n_items           int;
  v_n_batches         int;
  v_n_payments        int;
  v_n_opening_jes     int;
begin
  -- ---- Bootstrap: admin staff_profile (rolls back with the tx) -----------
  --
  -- staff_profiles.id IS the auth.users.id (FK). We need both an auth.users row
  -- and a staff_profiles row so the run.uploaded_by FK + the commit function's
  -- staff_profile existence check both pass. The whole insertion is rolled back
  -- at the end so the local DB is left untouched.
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (v_admin_auth, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'smoke-12a-admin@drmed.test', now(), now());

  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_admin_auth, 'Smoke 12.A Admin', 'admin', true);

  -- ---- Resolve providers (seeded by migration 0011_accounting_capture) ---
  select id into v_maxicare from public.hmo_providers where name = 'Maxicare';
  select id into v_valucare from public.hmo_providers where name = 'Valucare';
  if v_maxicare is null or v_valucare is null then
    raise exception 'fixture FAIL: Maxicare/Valucare provider rows missing — re-run supabase db reset';
  end if;

  -- ---- Create the two services the smoke needs --------------------------
  insert into public.services (code, name, kind, price_php, is_active)
  values ('SMK-CBC-12A', 'CBC + PC (smoke 12.A)', 'lab_test', 320, true)
  returning id into v_cbc_service;

  insert into public.services (code, name, kind, price_php, is_active)
  values ('SMK-ROUT-12A', 'ROUTINE PACKAGE (smoke 12.A)', 'lab_package', 1970, true)
  returning id into v_routine_service;

  -- ---- Create the run ----------------------------------------------------
  insert into public.hmo_import_runs (id, run_kind, file_hash, file_name,
                                       cutover_date, uploaded_by)
  values (v_run_id, 'commit', 'smoke-12a-hash', 'smoke-12.A.sql',
          current_date, v_admin_auth);

  -- ---- Insert 4 synthetic staging rows (status='validated') --------------
  --
  -- Row 1+2: grouped visit (same Maxicare patient, same date) → 1 visit, 2 TRs.
  --          Both have OR# PNB-CHK-5000 + payment_received_date → fully paid.
  --          Items contribute 0 to opening AR. The OR# spans both rows → 1
  --          payment row, 2 allocations.
  -- Row 3:   Maxicare UNPAID claim → contributes 320 to Maxicare opening AR.
  -- Row 4:   Valucare UNBILLED claim (reference_no NULL) → synthetic 'draft'
  --          batch, contributes 1970 to Valucare opening AR.
  insert into public.hmo_history_staging (
    run_id, source_tab, source_row_no, source_date,
    patient_name_raw, normalized_patient_name, last_name_raw, first_name_raw,
    provider_name_raw, provider_id_resolved,
    service_name_raw, service_id_resolved,
    billed_amount, paid_amount, reference_no, submission_date,
    or_number, payment_received_date, content_hash, status
  ) values
    -- Row 1: paid Maxicare CBC
    (v_run_id, 'LAB SERVICE', 100, current_date - interval '90 days',
     'ALAVA, TERESITA', 'ALAVA, TERESITA', 'Alava', 'Teresita',
     'Maxicare', v_maxicare,
     'CBC + PC (smoke 12.A)', v_cbc_service,
     320, 320, 'MAX-2026-001', (current_date - interval '85 days')::date,
     'PNB-CHK-5000', (current_date - interval '60 days')::date,
     'smk12a-hash-001', 'validated'),
    -- Row 2: paid Maxicare ROUTINE (same visit as row 1)
    (v_run_id, 'LAB SERVICE', 101, current_date - interval '90 days',
     'ALAVA, TERESITA', 'ALAVA, TERESITA', 'Alava', 'Teresita',
     'Maxicare', v_maxicare,
     'ROUTINE PACKAGE (smoke 12.A)', v_routine_service,
     1970, 1970, 'MAX-2026-001', (current_date - interval '85 days')::date,
     'PNB-CHK-5000', (current_date - interval '60 days')::date,
     'smk12a-hash-002', 'validated'),
    -- Row 3: unpaid Maxicare → 320 opening AR
    (v_run_id, 'LAB SERVICE', 102, current_date - interval '40 days',
     'CRUZ, MARIA', 'CRUZ, MARIA', 'Cruz', 'Maria',
     'Maxicare', v_maxicare,
     'CBC + PC (smoke 12.A)', v_cbc_service,
     320, 0, 'MAX-2026-002', (current_date - interval '35 days')::date,
     null, null, 'smk12a-hash-003', 'validated'),
    -- Row 4: unbilled Valucare → synthetic 'draft' batch, 1970 opening AR
    (v_run_id, 'LAB SERVICE', 103, current_date - interval '20 days',
     'TAN, JOSE', 'TAN, JOSE', 'Tan', 'Jose',
     'Valucare', v_valucare,
     'ROUTINE PACKAGE (smoke 12.A)', v_routine_service,
     1970, 0, null, null, null, null,
     'smk12a-hash-004', 'validated');

  -- ---- Run commit --------------------------------------------------------
  v_summary := public.commit_hmo_history_run(v_run_id);
  raise notice 'commit summary: %', v_summary::text;

  -- ---- Assertions --------------------------------------------------------

  -- A1: 3 patients created (Alava, Cruz, Tan).
  v_n_patients := (v_summary->>'patients')::int;
  if v_n_patients <> 3 then
    raise exception 'A1 FAIL: expected 3 patients, got %', v_n_patients;
  end if;
  raise notice 'A1 PASS: 3 patients created';

  -- A2: 3 visits (Alava+Maxicare grouped, Cruz+Maxicare, Tan+Valucare).
  v_n_visits := (v_summary->>'visits')::int;
  if v_n_visits <> 3 then
    raise exception 'A2 FAIL: expected 3 visits, got %', v_n_visits;
  end if;
  raise notice 'A2 PASS: 3 visits created';

  -- A3: 4 test_requests (one per staging row).
  v_n_test_requests := (v_summary->>'test_requests')::int;
  if v_n_test_requests <> 4 then
    raise exception 'A3 FAIL: expected 4 test_requests, got %', v_n_test_requests;
  end if;
  raise notice 'A3 PASS: 4 test_requests created';

  -- A4: 4 hmo_claim_items.
  v_n_items := (v_summary->>'items')::int;
  if v_n_items <> 4 then
    raise exception 'A4 FAIL: expected 4 items, got %', v_n_items;
  end if;
  raise notice 'A4 PASS: 4 hmo_claim_items created';

  -- A5: 3 batches:
  --     - 1 real Maxicare batch (rows 1+2 grouped by MAX-2026-001)
  --     - 1 real Maxicare batch (row 3 MAX-2026-002, single)
  --     - 1 synthetic draft batch for Valucare (row 4, unbilled)
  v_n_batches := (v_summary->>'batches')::int;
  if v_n_batches <> 3 then
    raise exception 'A5 FAIL: expected 3 batches, got %', v_n_batches;
  end if;
  raise notice 'A5 PASS: 3 batches created (2 real + 1 synthetic draft)';

  -- A6: 1 payment (one OR# under one provider: Maxicare PNB-CHK-5000).
  --     Total = 320 + 1970 = 2290.
  v_n_payments := (v_summary->>'payments')::int;
  if v_n_payments <> 1 then
    raise exception 'A6 FAIL: expected 1 payment, got %', v_n_payments;
  end if;
  raise notice 'A6 PASS: 1 synthetic hmo payment created';

  -- A7: 2 opening JEs (Maxicare 320 unpaid + Valucare 1970 unpaid).
  --     The Alava rows are fully paid → Maxicare opening AR = 320, not 320+0.
  v_n_opening_jes := (v_summary->>'opening_jes')::int;
  if v_n_opening_jes <> 2 then
    raise exception 'A7 FAIL: expected exactly 2 opening JEs, got %', v_n_opening_jes;
  end if;
  raise notice 'A7 PASS: 2 opening JEs posted';

  -- A8: every opening JE balances.
  select count(*) into v_jes_balanced
    from public.journal_entries je
   where je.source_kind = 'hmo_history_opening' and je.source_id = v_run_id
     and (select coalesce(sum(debit_php), 0) from public.journal_lines where entry_id = je.id)
       = (select coalesce(sum(credit_php), 0) from public.journal_lines where entry_id = je.id);
  if v_jes_balanced <> 2 then
    raise exception 'A8 FAIL: expected 2 balanced opening JEs, got %', v_jes_balanced;
  end if;
  raise notice 'A8 PASS: 2/2 opening JEs balance (debits = credits)';

  -- A9: every opening JE has posting_date = run.cutover_date.
  if exists (
    select 1
      from public.journal_entries je
      join public.hmo_import_runs r on r.id = v_run_id
     where je.source_kind = 'hmo_history_opening'
       and je.source_id = v_run_id
       and je.posting_date <> r.cutover_date
  ) then
    raise exception 'A9 FAIL: at least one opening JE has posting_date <> run.cutover_date';
  end if;
  raise notice 'A9 PASS: every opening JE posting_date = run.cutover_date';

  -- A10: audit_log row for the commit (action='hmo_history_import.committed',
  --      resource_id=run_id). Plan-text said entity_id; actual column is
  --      resource_id (see 0001_init.sql:198, 0036 commit function).
  if not exists (
    select 1 from public.audit_log
     where action = 'hmo_history_import.committed'
       and resource_id = v_run_id
  ) then
    raise exception 'A10 FAIL: no audit_log entry for committed run (action=hmo_history_import.committed, resource_id=%)', v_run_id;
  end if;
  raise notice 'A10 PASS: audit_log row found for committed run';

  raise notice 'all 10 smoke assertions PASS';
end$$;

rollback;

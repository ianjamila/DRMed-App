-- =============================================================================
-- scripts/smoke-12.5.sql
-- =============================================================================
-- 12.5 COGS + Doctor PF Subledger smoke test.
--
-- Run against local Supabase via:
--   npx supabase db query --local --file scripts/smoke-12.5.sql
--
-- Or via psql:
--   psql "postgresql://postgres:postgres@localhost:54322/postgres" \
--        -f scripts/smoke-12.5.sql
--
-- The script:
--   1. Inserts a self-contained fixture (auth user, staff profile, physicians,
--      services, vendor, HMO provider, patient, visits, test_requests, etc.)
--      — all tagged SMOKE-12.5 for targeted cleanup.
--   2. Runs 16 assertions in do $$ ... $$ blocks. Each raises a NOTICE on PASS
--      and an EXCEPTION on FAIL (which aborts the run cleanly inside the outer
--      BEGIN/ROLLBACK so no smoke residue leaks into the DB).
--   3. Cleans up explicitly using the draft-flip pattern from
--      feedback_je_cleanup_pattern.md before the final ROLLBACK.
--
-- NOTE: The script wraps everything in a transaction that is ROLLED BACK at the
-- end. This is safe for local Docker Supabase (psql / db query --local). Do NOT
-- run via Supabase MCP execute_sql — that tool auto-commits each statement.
-- =============================================================================

begin;

-- ============================================================================
-- FIXTURE SETUP
-- ============================================================================
-- All names / codes are prefixed SMOKE-12.5 to allow manual cleanup if the
-- ROLLBACK is bypassed for any reason.

do $$
declare
  -- auth + staff
  v_auth_user_id      uuid;
  v_staff_id          uuid;

  -- physicians
  v_phys_pf_split     uuid;   -- A: pf_split doctor (cash visits)
  v_phys_shareholder  uuid;   -- B: shareholder doctor (clinic_fee=0)

  -- services
  v_svc_consult       uuid;   -- doctor_consultation, clinic_fee+doctor_pf
  v_svc_consult2      uuid;   -- second consult service for assertion 7 (writeoff)
  v_svc_consult3      uuid;   -- third consult for HMO settlement (A6)
  v_svc_shareholder   uuid;   -- doctor_consultation for shareholder
  v_svc_sendout_cost  uuid;   -- is_send_out=true, unit_cost=500
  v_svc_sendout_null  uuid;   -- is_send_out=true, unit_cost=null
  v_svc_consult_p0034 uuid;   -- consult with no physician (for A13)

  -- vendor
  v_vendor_id         uuid;

  -- HMO provider
  v_hmo_id            uuid;

  -- patient
  v_patient_id        uuid;

  -- visits
  v_visit_cash_id     uuid;   -- cash visit (payment_status=paid)
  v_visit_hmo_id      uuid;   -- HMO visit (for A2, A6)
  v_visit_hmo2_id     uuid;   -- second HMO visit (for A7 writeoff)
  v_visit_hmo3_id     uuid;   -- third HMO visit (for A6)

  -- payments
  v_payment_cash_id   uuid;
  v_payment_hmo_id    uuid;
  v_payment_hmo2_id   uuid;
  v_payment_hmo3_id   uuid;

begin
  raise notice '=== SMOKE-12.5: Building fixture... ===';

  -- ---- Synthetic auth.users row (required by test_requests.requested_by FK)
  v_auth_user_id := gen_random_uuid();
  insert into auth.users (
    id, email, encrypted_password, email_confirmed_at,
    created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
    is_super_admin, aud, role
  ) values (
    v_auth_user_id,
    'smoke-12.5@drmed.internal',
    crypt('smoke-password', gen_salt('bf')),
    now(), now(), now(),
    '{}', '{}',
    false, 'authenticated', 'authenticated'
  );

  -- ---- Synthetic staff_profiles row (required by doctor_pf_disbursements.recorded_by)
  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_auth_user_id, 'SMOKE-12.5 Staff', 'admin', true)
  returning id into v_staff_id;

  -- ---- Physicians
  insert into public.physicians (full_name, slug, specialty, is_active, compensation_arrangement)
  values ('SMOKE-12.5 Dr PfSplit', 'smoke-125-dr-pfsplit', 'General Medicine', true, 'pf_split')
  returning id into v_phys_pf_split;

  insert into public.physicians (full_name, slug, specialty, is_active, compensation_arrangement)
  values ('SMOKE-12.5 Dr Shareholder', 'smoke-125-dr-shareholder', 'General Medicine', true, 'shareholder')
  returning id into v_phys_shareholder;

  -- ---- Vendor (for send-out services)
  insert into public.vendors (name) values ('SMOKE-12.5 Hi Precision')
  returning id into v_vendor_id;

  -- ---- Services
  -- Cash consult: final_price = clinic_fee + doctor_pf = 1000 (600+400)
  insert into public.services (code, name, kind, price_php, is_active, is_send_out)
  values ('SMOKE125-CON1', 'SMOKE-12.5 Consult (cash)', 'doctor_consultation', 1000, true, false)
  returning id into v_svc_consult;

  -- Second consult for A7 HMO writeoff scenario
  insert into public.services (code, name, kind, price_php, is_active, is_send_out)
  values ('SMOKE125-CON2', 'SMOKE-12.5 Consult (hmo writeoff)', 'doctor_consultation', 800, true, false)
  returning id into v_svc_consult2;

  -- Third consult for A6 HMO settlement
  insert into public.services (code, name, kind, price_php, is_active, is_send_out)
  values ('SMOKE125-CON3', 'SMOKE-12.5 Consult (hmo settle)', 'doctor_consultation', 900, true, false)
  returning id into v_svc_consult3;

  -- Shareholder consult: full amount goes to doctor (clinic_fee=0, pf=full)
  insert into public.services (code, name, kind, price_php, is_active, is_send_out)
  values ('SMOKE125-SHARE', 'SMOKE-12.5 Consult (shareholder)', 'doctor_consultation', 700, true, false)
  returning id into v_svc_shareholder;

  -- Send-out with cost configured
  insert into public.services (code, name, kind, price_php, is_active, is_send_out,
                               send_out_unit_cost_php, send_out_vendor_id)
  values ('SMOKE125-SO1', 'SMOKE-12.5 Sendout (cost=500)', 'lab_test', 1200, true, true,
          500.00, v_vendor_id)
  returning id into v_svc_sendout_cost;

  -- Send-out with NULL cost (D10 path)
  insert into public.services (code, name, kind, price_php, is_active, is_send_out)
  values ('SMOKE125-SO2', 'SMOKE-12.5 Sendout (no cost)', 'lab_test', 800, true, true)
  returning id into v_svc_sendout_null;

  -- Consult with NO physician for P0034 test (assertion 13)
  insert into public.services (code, name, kind, price_php, is_active, is_send_out)
  values ('SMOKE125-P0034', 'SMOKE-12.5 Consult (no phys)', 'doctor_consultation', 500, true, false)
  returning id into v_svc_consult_p0034;

  -- ---- HMO provider
  select id into v_hmo_id from public.hmo_providers where name = 'Maxicare' limit 1;
  if v_hmo_id is null then
    insert into public.hmo_providers (name, is_active)
    values ('SMOKE-12.5 HMO Provider', true)
    returning id into v_hmo_id;
  end if;

  -- ---- Patient
  insert into public.patients (first_name, last_name, birthdate, sex)
  values ('SMOKE125', 'Patient', date '1990-01-01', 'male')
  returning id into v_patient_id;

  -- ---- Cash visit (payment_status='paid' so release gate passes)
  insert into public.visits (patient_id, payment_status, total_php, notes)
  values (v_patient_id, 'paid', 3000, 'SMOKE-12.5 cash visit')
  returning id into v_visit_cash_id;

  -- Cash payment to back the paid status (for void test A8/A9)
  insert into public.payments (visit_id, amount_php, method, received_by, notes)
  values (v_visit_cash_id, 3000, 'cash', v_auth_user_id, 'SMOKE-12.5 cash payment')
  returning id into v_payment_cash_id;

  -- ---- HMO visit #1 (for A2 release + A6 settlement)
  insert into public.visits (patient_id, payment_status, total_php, hmo_provider_id,
                              hmo_approval_date, hmo_authorization_no, notes)
  values (v_patient_id, 'paid', 1800, v_hmo_id, current_date, 'SMOKE-125-HMO1',
          'SMOKE-12.5 HMO visit 1')
  returning id into v_visit_hmo_id;

  insert into public.payments (visit_id, amount_php, method, received_by, notes)
  values (v_visit_hmo_id, 1800, 'hmo', v_auth_user_id, 'SMOKE-12.5 HMO payment 1')
  returning id into v_payment_hmo_id;

  -- ---- HMO visit #2 (for A7 writeoff)
  insert into public.visits (patient_id, payment_status, total_php, hmo_provider_id,
                              hmo_approval_date, hmo_authorization_no, notes)
  values (v_patient_id, 'paid', 800, v_hmo_id, current_date, 'SMOKE-125-HMO2',
          'SMOKE-12.5 HMO visit 2 (writeoff)')
  returning id into v_visit_hmo2_id;

  insert into public.payments (visit_id, amount_php, method, received_by, notes)
  values (v_visit_hmo2_id, 800, 'hmo', v_auth_user_id, 'SMOKE-12.5 HMO payment 2')
  returning id into v_payment_hmo2_id;

  -- ---- HMO visit #3 (for A6 HMO settlement, separate from A2 which tests release)
  insert into public.visits (patient_id, payment_status, total_php, hmo_provider_id,
                              hmo_approval_date, hmo_authorization_no, notes)
  values (v_patient_id, 'paid', 900, v_hmo_id, current_date, 'SMOKE-125-HMO3',
          'SMOKE-12.5 HMO visit 3 (settlement)')
  returning id into v_visit_hmo3_id;

  insert into public.payments (visit_id, amount_php, method, received_by, notes)
  values (v_visit_hmo3_id, 900, 'hmo', v_auth_user_id, 'SMOKE-12.5 HMO payment 3')
  returning id into v_payment_hmo3_id;

  raise notice '=== SMOKE-12.5: Fixture complete. ===';

  -- Store all fixture IDs in a temp table for use across separate do-blocks.
  create temp table smoke_125_ids (key text primary key, val uuid) on commit drop;
  insert into smoke_125_ids values
    ('auth_user_id',     v_auth_user_id),
    ('staff_id',         v_staff_id),
    ('phys_pf_split',    v_phys_pf_split),
    ('phys_shareholder', v_phys_shareholder),
    ('vendor_id',        v_vendor_id),
    ('hmo_id',           v_hmo_id),
    ('patient_id',       v_patient_id),
    ('svc_consult',      v_svc_consult),
    ('svc_consult2',     v_svc_consult2),
    ('svc_consult3',     v_svc_consult3),
    ('svc_shareholder',  v_svc_shareholder),
    ('svc_sendout_cost', v_svc_sendout_cost),
    ('svc_sendout_null', v_svc_sendout_null),
    ('svc_consult_p0034',v_svc_consult_p0034),
    ('visit_cash_id',    v_visit_cash_id),
    ('visit_hmo_id',     v_visit_hmo_id),
    ('visit_hmo2_id',    v_visit_hmo2_id),
    ('visit_hmo3_id',    v_visit_hmo3_id),
    ('payment_cash_id',  v_payment_cash_id),
    ('payment_hmo_id',   v_payment_hmo_id),
    ('payment_hmo2_id',  v_payment_hmo2_id),
    ('payment_hmo3_id',  v_payment_hmo3_id);
end $$;


-- ============================================================================
-- ASSERTION 1
-- Cash consult release → balanced JE + doctor_pf_entries row with
-- recognition_basis='cash_at_release', recognized_at non-null.
-- ============================================================================
do $$
declare
  v_tr_id         uuid;
  v_je_id         uuid;
  v_pfe_id        uuid;
  v_debit         numeric(12,2);
  v_credit        numeric(12,2);
  v_basis         text;
  v_recog         timestamptz;
  v_visit_id      uuid;
  v_svc_id        uuid;
  v_phys_id       uuid;
  v_staff_id      uuid;
  v_auth_id       uuid;
begin
  -- Retrieve fixture IDs
  select val into v_visit_id from smoke_125_ids where key='visit_cash_id';
  select val into v_svc_id   from smoke_125_ids where key='svc_consult';
  select val into v_phys_id  from smoke_125_ids where key='phys_pf_split';
  select val into v_staff_id from smoke_125_ids where key='staff_id';
  select val into v_auth_id  from smoke_125_ids where key='auth_user_id';

  -- Insert test_request in 'requested' status, set attending_physician_id on visit
  update public.visits set attending_physician_id = v_phys_id where id = v_visit_id;

  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    clinic_fee_php, doctor_pf_php, final_price_php, base_price_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    600.00, 400.00, 1000.00, 1000.00
  ) returning id into v_tr_id;

  -- Release → triggers bridge_test_request_released
  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  -- Find the JE
  select id into v_je_id from public.journal_entries
    where source_kind = 'test_request' and source_id = v_tr_id and status = 'posted';

  assert v_je_id is not null, 'A1: no posted JE for cash consult release';

  -- Check JE balance
  select sum(debit_php), sum(credit_php) into v_debit, v_credit
    from public.journal_lines where entry_id = v_je_id;
  assert v_debit = v_credit and v_debit > 0,
    format('A1: JE not balanced (debit=%s credit=%s)', v_debit, v_credit);

  -- Check doctor_pf_entries row
  select id, recognition_basis, recognized_at
    into v_pfe_id, v_basis, v_recog
    from public.doctor_pf_entries
    where test_request_id = v_tr_id and voided_at is null
    limit 1;

  assert v_pfe_id is not null, 'A1: doctor_pf_entries row not found';
  assert v_basis = 'cash_at_release',
    format('A1: expected recognition_basis=cash_at_release, got %s', v_basis);
  assert v_recog is not null, 'A1: recognized_at is null for cash_at_release entry';

  -- Store tr_id for later assertions (A8, A9, A10)
  insert into smoke_125_ids values ('tr_cash_consult', v_tr_id);

  raise notice 'ASSERTION 1 PASS: Cash consult release → balanced JE + pf_entries (cash_at_release)';
end $$;


-- ============================================================================
-- ASSERTION 2
-- HMO consult release → JE credits 2160 (not 2110); pf entry has
-- recognition_basis='hmo_at_settlement', recognized_at null.
-- ============================================================================
do $$
declare
  v_tr_id        uuid;
  v_je_id        uuid;
  v_pfe_id       uuid;
  v_basis        text;
  v_recog        timestamptz;
  v_acct_2160    uuid;
  v_acct_2110    uuid;
  v_cr_2160      numeric(12,2);
  v_cr_2110      numeric(12,2);
  v_visit_id     uuid;
  v_svc_id       uuid;
  v_phys_id      uuid;
  v_auth_id      uuid;
begin
  select val into v_visit_id from smoke_125_ids where key='visit_hmo_id';
  select val into v_svc_id   from smoke_125_ids where key='svc_consult';
  select val into v_phys_id  from smoke_125_ids where key='phys_pf_split';
  select val into v_auth_id  from smoke_125_ids where key='auth_user_id';

  update public.visits set attending_physician_id = v_phys_id where id = v_visit_id;

  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    clinic_fee_php, doctor_pf_php, final_price_php, base_price_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    500.00, 400.00, 900.00, 900.00
  ) returning id into v_tr_id;

  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  select id into v_je_id from public.journal_entries
    where source_kind = 'test_request' and source_id = v_tr_id and status = 'posted';

  assert v_je_id is not null, 'A2: no posted JE for HMO consult release';

  -- Expect CR on 2160, NOT 2110
  select id into v_acct_2160 from public.chart_of_accounts where code='2160';
  select id into v_acct_2110 from public.chart_of_accounts where code='2110';

  select credit_php into v_cr_2160 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_2160;
  select credit_php into v_cr_2110 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_2110;

  assert coalesce(v_cr_2160, 0) > 0,
    format('A2: expected CR on 2160, got %s', coalesce(v_cr_2160, 0));
  assert coalesce(v_cr_2110, 0) = 0,
    format('A2: unexpected CR on 2110 (should be 0 for HMO), got %s', coalesce(v_cr_2110, 0));

  -- Check PF entry: hmo_at_settlement, recognized_at null
  select id, recognition_basis, recognized_at
    into v_pfe_id, v_basis, v_recog
    from public.doctor_pf_entries
    where test_request_id = v_tr_id and voided_at is null;

  assert v_pfe_id is not null, 'A2: doctor_pf_entries row not found for HMO consult';
  assert v_basis = 'hmo_at_settlement',
    format('A2: expected hmo_at_settlement, got %s', v_basis);
  assert v_recog is null,
    'A2: recognized_at should be null for hmo_at_settlement before settlement';

  -- Store for A6 HMO settlement test
  insert into smoke_125_ids values ('tr_hmo_consult', v_tr_id);

  raise notice 'ASSERTION 2 PASS: HMO consult release → CR on 2160, pf_entries (hmo_at_settlement, unrecognized)';
end $$;


-- ============================================================================
-- ASSERTION 3
-- Shareholder consult (clinic_fee=0, doctor_pf=full amount): JE has no 4200
-- line (zero-amount skipped), is balanced, posts cleanly.
-- ============================================================================
do $$
declare
  v_tr_id      uuid;
  v_je_id      uuid;
  v_debit      numeric(12,2);
  v_credit     numeric(12,2);
  v_acct_4200  uuid;
  v_line_4200  int;
  v_visit_id   uuid;
  v_svc_id     uuid;
  v_phys_id    uuid;
  v_auth_id    uuid;
begin
  select val into v_visit_id from smoke_125_ids where key='visit_cash_id';
  select val into v_svc_id   from smoke_125_ids where key='svc_shareholder';
  select val into v_phys_id  from smoke_125_ids where key='phys_shareholder';
  select val into v_auth_id  from smoke_125_ids where key='auth_user_id';

  -- Use per-line attending_physician_id override
  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    attending_physician_id,
    clinic_fee_php, doctor_pf_php, final_price_php, base_price_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    v_phys_id,
    0.00, 700.00, 700.00, 700.00
  ) returning id into v_tr_id;

  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  select id into v_je_id from public.journal_entries
    where source_kind = 'test_request' and source_id = v_tr_id and status = 'posted';

  assert v_je_id is not null, 'A3: no posted JE for shareholder consult release';

  -- JE must balance
  select sum(debit_php), sum(credit_php) into v_debit, v_credit
    from public.journal_lines where entry_id = v_je_id;
  assert v_debit = v_credit and v_debit > 0,
    format('A3: JE not balanced for shareholder consult (debit=%s credit=%s)', v_debit, v_credit);

  -- No 4200 line (clinic_fee=0 → line skipped)
  select id into v_acct_4200 from public.chart_of_accounts where code='4200';
  select count(*) into v_line_4200 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_4200;
  assert v_line_4200 = 0,
    format('A3: expected 0 lines for 4200, got %s (shareholder clinic_fee=0 should skip)', v_line_4200);

  raise notice 'ASSERTION 3 PASS: Shareholder consult → balanced JE, no 4200 line';
end $$;


-- ============================================================================
-- ASSERTION 4
-- Send-out test with unit_cost=500 → release JE has DR 6420 500 / CR 2150 500;
-- cogs_send_out_entries row exists with unit_cost_php=500, journal_entry_id set.
-- ============================================================================
do $$
declare
  v_tr_id      uuid;
  v_je_id      uuid;
  v_acct_6420  uuid;
  v_acct_2150  uuid;
  v_dr_6420    numeric(12,2);
  v_cr_2150    numeric(12,2);
  v_cogs_id    uuid;
  v_cogs_cost  numeric(10,2);
  v_cogs_je    uuid;
  v_visit_id   uuid;
  v_svc_id     uuid;
  v_auth_id    uuid;
begin
  select val into v_visit_id from smoke_125_ids where key='visit_cash_id';
  select val into v_svc_id   from smoke_125_ids where key='svc_sendout_cost';
  select val into v_auth_id  from smoke_125_ids where key='auth_user_id';

  -- Send-out tests don't need a physician
  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    final_price_php, base_price_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    1200.00, 1200.00
  ) returning id into v_tr_id;

  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  select id into v_je_id from public.journal_entries
    where source_kind = 'test_request' and source_id = v_tr_id and status = 'posted';

  assert v_je_id is not null, 'A4: no posted JE for send-out release';

  -- Check DR 6420 = 500, CR 2150 = 500
  select id into v_acct_6420 from public.chart_of_accounts where code='6420';
  select id into v_acct_2150 from public.chart_of_accounts where code='2150';

  select debit_php into v_dr_6420 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_6420;
  select credit_php into v_cr_2150 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_2150;

  assert coalesce(v_dr_6420, 0) = 500.00,
    format('A4: expected DR 6420=500, got %s', coalesce(v_dr_6420, 0));
  assert coalesce(v_cr_2150, 0) = 500.00,
    format('A4: expected CR 2150=500, got %s', coalesce(v_cr_2150, 0));

  -- Check cogs_send_out_entries
  select id, unit_cost_php, journal_entry_id
    into v_cogs_id, v_cogs_cost, v_cogs_je
    from public.cogs_send_out_entries
    where test_request_id = v_tr_id and voided_at is null;

  assert v_cogs_id is not null, 'A4: cogs_send_out_entries row not found';
  assert v_cogs_cost = 500.00,
    format('A4: expected unit_cost_php=500, got %s', v_cogs_cost);
  assert v_cogs_je is not null,
    'A4: journal_entry_id is null on cogs_send_out_entries (should be set for cost>0)';

  -- Store for assertions 11+12
  insert into smoke_125_ids values ('tr_sendout_cost', v_tr_id);

  raise notice 'ASSERTION 4 PASS: Send-out (cost=500) → DR 6420/CR 2150=500, cogs_entries row set';
end $$;


-- ============================================================================
-- ASSERTION 5
-- Send-out with NULL unit_cost → release JE has NO COGS lines;
-- cogs_send_out_entries row with unit_cost_php=0, journal_entry_id=null;
-- audit_log has send_out.unit_cost_missing row.
-- ============================================================================
do $$
declare
  v_tr_id      uuid;
  v_je_id      uuid;
  v_acct_6420  uuid;
  v_line_count int;
  v_cogs_cost  numeric(10,2);
  v_cogs_je    uuid;
  v_audit_cnt  int;
  v_visit_id   uuid;
  v_svc_id     uuid;
  v_auth_id    uuid;
begin
  select val into v_visit_id from smoke_125_ids where key='visit_cash_id';
  select val into v_svc_id   from smoke_125_ids where key='svc_sendout_null';
  select val into v_auth_id  from smoke_125_ids where key='auth_user_id';

  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    final_price_php, base_price_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    800.00, 800.00
  ) returning id into v_tr_id;

  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  select id into v_je_id from public.journal_entries
    where source_kind = 'test_request' and source_id = v_tr_id and status = 'posted';

  -- JE should still exist (revenue lines still fire)
  assert v_je_id is not null, 'A5: no posted JE for send-out (null cost) release';

  -- No 6420 lines on the JE
  select id into v_acct_6420 from public.chart_of_accounts where code='6420';
  select count(*) into v_line_count from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_6420;
  assert v_line_count = 0,
    format('A5: expected 0 lines for 6420 (no cost), got %s', v_line_count);

  -- cogs_send_out_entries: unit_cost_php=0, journal_entry_id null
  select unit_cost_php, journal_entry_id
    into v_cogs_cost, v_cogs_je
    from public.cogs_send_out_entries
    where test_request_id = v_tr_id and voided_at is null;

  assert v_cogs_cost = 0,
    format('A5: expected unit_cost_php=0 for null-cost send-out, got %s', v_cogs_cost);
  assert v_cogs_je is null,
    'A5: journal_entry_id should be null for unit_cost=0 (D10 path)';

  -- audit_log row
  select count(*) into v_audit_cnt
    from public.audit_log
    where action = 'send_out.unit_cost_missing' and resource_id = v_tr_id;
  assert v_audit_cnt >= 1,
    format('A5: expected audit_log send_out.unit_cost_missing, got %s rows', v_audit_cnt);

  -- Store tr for trueup assertions 11+12
  insert into smoke_125_ids values ('tr_sendout_null', v_tr_id);

  raise notice 'ASSERTION 5 PASS: Send-out (null cost) → no COGS JE lines, cogs_entries unit_cost=0, audit written';
end $$;


-- ============================================================================
-- ASSERTION 6
-- INSERT hmo_payment_allocations → PF settlement JE fires (DR 2160 / CR 2110
-- proportional); doctor_pf_entries.recognized_at updated, pf_php snapshotted.
-- ============================================================================
do $$
declare
  v_tr_id        uuid;
  v_pfe_id       uuid;
  v_recog_before timestamptz;
  v_recog_after  timestamptz;
  v_pf_after     numeric(10,2);
  v_je_settle_id uuid;
  v_acct_2160    uuid;
  v_acct_2110    uuid;
  v_dr_2160      numeric(12,2);
  v_cr_2110      numeric(12,2);
  v_item_id      uuid;
  v_batch_id     uuid;
  v_payment_id   uuid;
  v_visit_id     uuid;
  v_svc_id       uuid;
  v_phys_id      uuid;
  v_auth_id      uuid;
  v_hmo_id       uuid;
  v_staff_id     uuid;
begin
  -- We use HMO visit 3 for this assertion (separate from A2 which already consumed hmo visit 1)
  select val into v_visit_id  from smoke_125_ids where key='visit_hmo3_id';
  select val into v_svc_id    from smoke_125_ids where key='svc_consult3';
  select val into v_phys_id   from smoke_125_ids where key='phys_pf_split';
  select val into v_auth_id   from smoke_125_ids where key='auth_user_id';
  select val into v_hmo_id    from smoke_125_ids where key='hmo_id';
  select val into v_staff_id  from smoke_125_ids where key='staff_id';
  select val into v_payment_id from smoke_125_ids where key='payment_hmo3_id';

  update public.visits set attending_physician_id = v_phys_id where id = v_visit_id;

  -- Release a consult on HMO visit 3 (clinic_fee=500, pf=400, total=900)
  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    clinic_fee_php, doctor_pf_php, final_price_php, base_price_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    500.00, 400.00, 900.00, 900.00
  ) returning id into v_tr_id;

  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  -- Verify PF entry is deferred (recognized_at null)
  select id, recognized_at into v_pfe_id, v_recog_before
    from public.doctor_pf_entries
    where test_request_id = v_tr_id
      and recognition_basis = 'hmo_at_settlement'
      and voided_at is null;

  assert v_pfe_id is not null, 'A6: PF entry not created on HMO release';
  assert v_recog_before is null, 'A6: expected recognized_at=null before settlement';

  -- Create HMO claim batch + item + payment allocation
  insert into public.hmo_claim_batches (provider_id, status)
  values (v_hmo_id, 'submitted')
  returning id into v_batch_id;

  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
  values (v_batch_id, v_tr_id, 900.00)
  returning id into v_item_id;

  -- INSERT allocation → triggers trg_bridge_pf_at_hmo_allocation
  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php)
  values (v_payment_id, v_item_id, 900.00);

  -- Verify PF entry now recognized
  select recognized_at, pf_php, journal_entry_id
    into v_recog_after, v_pf_after, v_je_settle_id
    from public.doctor_pf_entries where id = v_pfe_id;

  assert v_recog_after is not null,
    'A6: recognized_at still null after HMO payment allocation';
  assert v_pf_after = 400.00,
    format('A6: expected pf_php=400, got %s', v_pf_after);
  assert v_je_settle_id is not null,
    'A6: journal_entry_id not populated on PF entry after settlement';

  -- Verify settlement JE: DR 2160 / CR 2110
  select id into v_acct_2160 from public.chart_of_accounts where code='2160';
  select id into v_acct_2110 from public.chart_of_accounts where code='2110';

  select debit_php into v_dr_2160 from public.journal_lines
    where entry_id = v_je_settle_id and account_id = v_acct_2160;
  select credit_php into v_cr_2110 from public.journal_lines
    where entry_id = v_je_settle_id and account_id = v_acct_2110;

  assert coalesce(v_dr_2160, 0) = 400.00,
    format('A6: expected DR 2160=400 on settlement JE, got %s', coalesce(v_dr_2160, 0));
  assert coalesce(v_cr_2110, 0) = 400.00,
    format('A6: expected CR 2110=400 on settlement JE, got %s', coalesce(v_cr_2110, 0));

  insert into smoke_125_ids values ('tr_hmo3_consult', v_tr_id);
  insert into smoke_125_ids values ('hmo_batch3_id',   v_batch_id);

  raise notice 'ASSERTION 6 PASS: HMO allocation → settlement JE DR2160/CR2110, pf_entries.recognized_at updated';
end $$;


-- ============================================================================
-- ASSERTION 7
-- INSERT hmo_claim_resolutions (destination='write_off') for HMO consult with
-- pending PF → writeoff JE fires (DR 2160 / CR 6920); pf entry soft-voided.
-- ============================================================================
do $$
declare
  v_tr_id      uuid;
  v_pfe_id     uuid;
  v_je_id      uuid;
  v_acct_2160  uuid;
  v_acct_6920  uuid;
  v_dr_2160    numeric(12,2);
  v_cr_6920    numeric(12,2);
  v_voided     timestamptz;
  v_item_id    uuid;
  v_batch_id   uuid;
  v_visit_id   uuid;
  v_svc_id     uuid;
  v_phys_id    uuid;
  v_auth_id    uuid;
  v_hmo_id     uuid;
  v_staff_id   uuid;
begin
  select val into v_visit_id  from smoke_125_ids where key='visit_hmo2_id';
  select val into v_svc_id    from smoke_125_ids where key='svc_consult2';
  select val into v_phys_id   from smoke_125_ids where key='phys_pf_split';
  select val into v_auth_id   from smoke_125_ids where key='auth_user_id';
  select val into v_hmo_id    from smoke_125_ids where key='hmo_id';
  select val into v_staff_id  from smoke_125_ids where key='staff_id';

  update public.visits set attending_physician_id = v_phys_id where id = v_visit_id;

  -- Release HMO consult (clinic_fee=400, pf=400, total=800)
  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    clinic_fee_php, doctor_pf_php, final_price_php, base_price_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    400.00, 400.00, 800.00, 800.00
  ) returning id into v_tr_id;

  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  -- Find the pending PF entry
  select id into v_pfe_id from public.doctor_pf_entries
    where test_request_id = v_tr_id
      and recognition_basis = 'hmo_at_settlement'
      and recognized_at is null
      and voided_at is null;

  assert v_pfe_id is not null, 'A7: pending HMO PF entry not found after release';

  -- Create HMO claim item + writeoff resolution
  insert into public.hmo_claim_batches (provider_id, status)
  values (v_hmo_id, 'submitted')
  returning id into v_batch_id;

  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
  values (v_batch_id, v_tr_id, 800.00)
  returning id into v_item_id;

  -- INSERT write_off resolution → triggers trg_bridge_pf_at_hmo_writeoff
  insert into public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by)
  values (v_item_id, 'write_off', 800.00, v_staff_id);

  -- PF entry should be soft-voided
  select voided_at, journal_entry_id
    into v_voided, v_je_id
    from public.doctor_pf_entries where id = v_pfe_id;

  assert v_voided is not null,
    'A7: doctor_pf_entries not soft-voided after HMO writeoff';
  assert v_je_id is not null,
    'A7: journal_entry_id not set on voided PF entry after writeoff';

  -- Verify writeoff JE: DR 2160 / CR 6920
  select id into v_acct_2160 from public.chart_of_accounts where code='2160';
  select id into v_acct_6920 from public.chart_of_accounts where code='6920';

  select debit_php into v_dr_2160 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_2160;
  select credit_php into v_cr_6920 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_6920;

  assert coalesce(v_dr_2160, 0) = 400.00,
    format('A7: expected DR 2160=400 on writeoff JE, got %s', coalesce(v_dr_2160, 0));
  assert coalesce(v_cr_6920, 0) = 400.00,
    format('A7: expected CR 6920=400 on writeoff JE, got %s', coalesce(v_cr_6920, 0));

  insert into smoke_125_ids values ('tr_hmo2_consult', v_tr_id);
  insert into smoke_125_ids values ('hmo_batch2_id',   v_batch_id);

  raise notice 'ASSERTION 7 PASS: HMO writeoff resolution → DR2160/CR6920 JE, pf_entries soft-voided';
end $$;


-- ============================================================================
-- ASSERTION 8
-- Cancel a released cash consult → reversal JE balances, pf_entries soft-voided.
-- ============================================================================
do $$
declare
  v_tr_id          uuid;
  v_orig_je_id     uuid;
  v_rev_je_id      uuid;
  v_orig_debit     numeric(12,2);
  v_orig_credit    numeric(12,2);
  v_rev_debit      numeric(12,2);
  v_rev_credit     numeric(12,2);
  v_orig_status    text;
  v_pfe_voided     timestamptz;
  v_visit_id       uuid;
  v_svc_id         uuid;
  v_phys_id        uuid;
  v_auth_id        uuid;
begin
  -- Create a fresh cash consult on a separate test_request so A1 isn't disturbed
  select val into v_visit_id from smoke_125_ids where key='visit_cash_id';
  select val into v_svc_id   from smoke_125_ids where key='svc_consult';
  select val into v_phys_id  from smoke_125_ids where key='phys_pf_split';
  select val into v_auth_id  from smoke_125_ids where key='auth_user_id';

  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    attending_physician_id,
    clinic_fee_php, doctor_pf_php, final_price_php, base_price_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    v_phys_id,
    600.00, 400.00, 1000.00, 1000.00
  ) returning id into v_tr_id;

  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  -- Grab original JE
  select id into v_orig_je_id from public.journal_entries
    where source_kind = 'test_request' and source_id = v_tr_id and status = 'posted';

  -- Cancel → triggers bridge_test_request_cancelled
  update public.test_requests
    set status = 'cancelled', cancelled_reason = 'SMOKE-12.5 A8 cancel test'
    where id = v_tr_id;

  -- Original JE should now be 'reversed'
  select status into v_orig_status from public.journal_entries where id = v_orig_je_id;
  assert v_orig_status = 'reversed',
    format('A8: expected original JE status=reversed, got %s', v_orig_status);

  -- Reversal JE: must exist, must balance
  select id into v_rev_je_id from public.journal_entries
    where source_kind = 'reversal' and reverses = v_orig_je_id and status = 'posted';

  assert v_rev_je_id is not null, 'A8: no posted reversal JE found';

  select sum(debit_php), sum(credit_php) into v_rev_debit, v_rev_credit
    from public.journal_lines where entry_id = v_rev_je_id;
  assert v_rev_debit = v_rev_credit and v_rev_debit > 0,
    format('A8: reversal JE not balanced (debit=%s credit=%s)', v_rev_debit, v_rev_credit);

  -- Original JE also balances (sanity)
  select sum(debit_php), sum(credit_php) into v_orig_debit, v_orig_credit
    from public.journal_lines where entry_id = v_orig_je_id;
  assert v_orig_debit = v_orig_credit,
    format('A8: original JE not balanced (debit=%s credit=%s)', v_orig_debit, v_orig_credit);

  -- PF entry soft-voided
  select voided_at into v_pfe_voided
    from public.doctor_pf_entries
    where test_request_id = v_tr_id and void_reason = 'test_request_cancelled';
  assert v_pfe_voided is not null,
    'A8: doctor_pf_entries not soft-voided after cancellation';

  -- Store for cleanup
  insert into smoke_125_ids values ('tr_cancel_consult', v_tr_id);
  insert into smoke_125_ids values ('je_cancel_reversal', v_rev_je_id);
  insert into smoke_125_ids values ('je_cancel_original', v_orig_je_id);

  raise notice 'ASSERTION 8 PASS: Cancellation → reversal JE balanced, pf_entries soft-voided';
end $$;


-- ============================================================================
-- ASSERTION 9
-- Void cash payment with PF already disbursed → clawback row inserted with
-- negative pf_php and recognition_basis='clawback'; audit row pf_clawback.alert.
-- ============================================================================
do $$
declare
  v_tr_id         uuid;
  v_pfe_id        uuid;
  v_disb_id       uuid;
  v_clawback_cnt  int;
  v_clawback_pf   numeric(10,2);
  v_audit_cnt     int;
  v_payment_id    uuid;
  v_visit_id      uuid;
  v_svc_id        uuid;
  v_phys_id       uuid;
  v_auth_id       uuid;
  v_staff_id      uuid;
  v_year          smallint;
begin
  -- Create a fresh cash visit + test_request
  select val into v_auth_id  from smoke_125_ids where key='auth_user_id';
  select val into v_staff_id from smoke_125_ids where key='staff_id';
  select val into v_svc_id   from smoke_125_ids where key='svc_consult';
  select val into v_phys_id  from smoke_125_ids where key='phys_pf_split';

  -- Create a new visit for this test (separate from visit_cash_id to avoid side effects)
  declare v_new_visit_id uuid;
  declare v_new_pay_id   uuid;
  declare v_patient_id   uuid;
  begin
    select val into v_patient_id from smoke_125_ids where key='patient_id';

    insert into public.visits (patient_id, payment_status, total_php, notes)
    values (v_patient_id, 'paid', 1000, 'SMOKE-12.5 A9 clawback visit')
    returning id into v_new_visit_id;

    insert into public.payments (visit_id, amount_php, method, received_by, notes)
    values (v_new_visit_id, 1000, 'cash', v_auth_id, 'SMOKE-12.5 A9 payment')
    returning id into v_new_pay_id;

    update public.visits set attending_physician_id = v_phys_id where id = v_new_visit_id;

    insert into public.test_requests (
      visit_id, service_id, status, requested_by,
      attending_physician_id,
      clinic_fee_php, doctor_pf_php, final_price_php, base_price_php
    ) values (
      v_new_visit_id, v_svc_id, 'requested', v_auth_id,
      v_phys_id,
      600.00, 400.00, 1000.00, 1000.00
    ) returning id into v_tr_id;

    update public.test_requests
      set status = 'released', released_at = now(), released_by = v_auth_id
      where id = v_tr_id;

    -- Find the PF entry
    select id into v_pfe_id from public.doctor_pf_entries
      where test_request_id = v_tr_id
        and recognition_basis = 'cash_at_release'
        and voided_at is null;

    assert v_pfe_id is not null, 'A9: PF entry not found after cash release';

    -- Create a disbursement (marks PF as disbursed so void triggers clawback)
    v_year := extract(year from current_date)::smallint;
    insert into public.doctor_pf_disbursements (
      batch_number, physician_id, posted_date, method, total_php, recorded_by
    ) values (
      public.next_pf_disbursement_batch_number(v_year),
      v_phys_id, current_date, 'cash', 400.00, v_staff_id
    ) returning id into v_disb_id;

    -- Link PF entry to disbursement (simulating the UI workflow)
    update public.doctor_pf_entries
      set disbursement_id = v_disb_id
      where id = v_pfe_id;

    -- Void the payment → triggers trg_bridge_payment_void_pf_cascade
    -- visit payment_status must flip to 'unpaid' first (simulate void cascading)
    -- Step 1: update visit to unpaid (so trigger fires the clawback path)
    update public.visits set payment_status = 'unpaid' where id = v_new_visit_id;
    -- Step 2: set voided_at on the payment
    update public.payments
      set voided_at = now(), voided_by = v_staff_id, void_reason = 'SMOKE-12.5 A9 void'
      where id = v_new_pay_id;

    -- Clawback row should exist with negative pf_php
    select count(*), sum(pf_php) into v_clawback_cnt, v_clawback_pf
      from public.doctor_pf_entries
      where test_request_id = v_tr_id
        and recognition_basis = 'clawback';

    assert v_clawback_cnt >= 1,
      'A9: no clawback row inserted after payment void with disbursed PF';
    assert v_clawback_pf < 0,
      format('A9: clawback pf_php should be negative, got %s', v_clawback_pf);

    -- Audit row pf_clawback.alert
    select count(*) into v_audit_cnt
      from public.audit_log
      where action = 'pf_clawback.alert' and resource_id = v_pfe_id;
    assert v_audit_cnt >= 1,
      'A9: no pf_clawback.alert audit row found';

    -- Store for cleanup
    insert into smoke_125_ids values ('tr_clawback_consult', v_tr_id);
    insert into smoke_125_ids values ('disb_a9_id',          v_disb_id);
    insert into smoke_125_ids values ('visit_a9_id',         v_new_visit_id);
    insert into smoke_125_ids values ('payment_a9_id',       v_new_pay_id);
  end;

  raise notice 'ASSERTION 9 PASS: Payment void with disbursed PF → clawback row inserted, pf_clawback.alert written';
end $$;


-- ============================================================================
-- ASSERTION 10
-- INSERT doctor_pf_disbursements → JE DR 2110 / CR 1010 posts;
-- journal_entry_id populated.
-- ============================================================================
do $$
declare
  v_disb_id    uuid;
  v_je_id      uuid;
  v_acct_2110  uuid;
  v_acct_1010  uuid;
  v_dr_2110    numeric(12,2);
  v_cr_1010    numeric(12,2);
  v_phys_id    uuid;
  v_staff_id   uuid;
  v_year       smallint;
begin
  select val into v_phys_id  from smoke_125_ids where key='phys_pf_split';
  select val into v_staff_id from smoke_125_ids where key='staff_id';

  v_year := extract(year from current_date)::smallint;

  insert into public.doctor_pf_disbursements (
    batch_number, physician_id, posted_date, method, total_php, recorded_by, notes
  ) values (
    public.next_pf_disbursement_batch_number(v_year),
    v_phys_id, current_date, 'cash', 800.00, v_staff_id, 'SMOKE-12.5 A10'
  ) returning id into v_disb_id;

  -- After INSERT trigger populates journal_entry_id
  select journal_entry_id into v_je_id
    from public.doctor_pf_disbursements where id = v_disb_id;

  assert v_je_id is not null,
    'A10: journal_entry_id not populated on doctor_pf_disbursements after INSERT';

  -- Verify JE: DR 2110, CR 1010 = 800
  select id into v_acct_2110 from public.chart_of_accounts where code='2110';
  select id into v_acct_1010 from public.chart_of_accounts where code='1010';

  select debit_php into v_dr_2110 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_2110;
  select credit_php into v_cr_1010 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_1010;

  assert coalesce(v_dr_2110, 0) = 800.00,
    format('A10: expected DR 2110=800, got %s', coalesce(v_dr_2110, 0));
  assert coalesce(v_cr_1010, 0) = 800.00,
    format('A10: expected CR 1010=800, got %s', coalesce(v_cr_1010, 0));

  insert into smoke_125_ids values ('disb_a10_id', v_disb_id);

  raise notice 'ASSERTION 10 PASS: Disbursement INSERT → DR2110/CR1010=800, journal_entry_id set';
end $$;


-- ============================================================================
-- ASSERTION 11
-- INSERT cogs_send_out_trueups with billed=600, accrued=500 → variance JE fires
-- DR 6420 100 / CR 2150 100; entries' trueup_id populated.
-- ============================================================================
do $$
declare
  v_trueup_id  uuid;
  v_je_id      uuid;
  v_acct_6420  uuid;
  v_acct_2150  uuid;
  v_dr_6420    numeric(12,2);
  v_cr_2150    numeric(12,2);
  v_trued_cnt  int;
  v_vendor_id  uuid;
  v_staff_id   uuid;
  v_tr_id      uuid;
begin
  select val into v_vendor_id from smoke_125_ids where key='vendor_id';
  select val into v_staff_id  from smoke_125_ids where key='staff_id';
  select val into v_tr_id     from smoke_125_ids where key='tr_sendout_cost';

  -- Insert trueup: billed=600, accrued=500 → variance = +100 (under-accrued)
  insert into public.cogs_send_out_trueups (
    vendor_id, period_start_date, period_end_date,
    accrued_total_php, billed_total_php, variance_php,
    matched_by
  ) values (
    v_vendor_id, current_date - 30, current_date,
    500.00, 600.00, 100.00,
    v_staff_id
  ) returning id into v_trueup_id;

  -- journal_entry_id should be set
  select journal_entry_id into v_je_id
    from public.cogs_send_out_trueups where id = v_trueup_id;

  assert v_je_id is not null,
    'A11: journal_entry_id not set on cogs_send_out_trueups after INSERT';

  -- Verify variance JE: DR 6420 100 / CR 2150 100
  select id into v_acct_6420 from public.chart_of_accounts where code='6420';
  select id into v_acct_2150 from public.chart_of_accounts where code='2150';

  select debit_php into v_dr_6420 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_6420;
  select credit_php into v_cr_2150 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_2150;

  assert coalesce(v_dr_6420, 0) = 100.00,
    format('A11: expected DR 6420=100, got %s', coalesce(v_dr_6420, 0));
  assert coalesce(v_cr_2150, 0) = 100.00,
    format('A11: expected CR 2150=100, got %s', coalesce(v_cr_2150, 0));

  -- cogs_send_out_entries trueup_id populated for matching entries
  select count(*) into v_trued_cnt
    from public.cogs_send_out_entries
    where trueup_id = v_trueup_id and voided_at is null;
  assert v_trued_cnt >= 1,
    format('A11: expected >=1 cogs_send_out_entries with trueup_id set, got %s', v_trued_cnt);

  insert into smoke_125_ids values ('trueup_a11_id', v_trueup_id);

  raise notice 'ASSERTION 11 PASS: Trueup (billed=600,accrued=500) → DR6420/CR2150=100, entries.trueup_id set';
end $$;


-- ============================================================================
-- ASSERTION 12
-- INSERT cogs_send_out_trueups with billed=500, accrued=0 → variance JE fires
-- DR 6420 500 / CR 2150 500.
-- ============================================================================
do $$
declare
  v_trueup_id  uuid;
  v_je_id      uuid;
  v_acct_6420  uuid;
  v_acct_2150  uuid;
  v_dr_6420    numeric(12,2);
  v_cr_2150    numeric(12,2);
  v_vendor_id  uuid;
  v_staff_id   uuid;
  v_tr_id      uuid;
begin
  select val into v_vendor_id from smoke_125_ids where key='vendor_id';
  select val into v_staff_id  from smoke_125_ids where key='staff_id';
  select val into v_tr_id     from smoke_125_ids where key='tr_sendout_null';

  -- Insert trueup: billed=500, accrued=0 → variance=+500 (all billed, none accrued)
  -- We extend the date range slightly so no collision with A11's trueup entries
  insert into public.cogs_send_out_trueups (
    vendor_id, period_start_date, period_end_date,
    accrued_total_php, billed_total_php, variance_php,
    matched_by
  ) values (
    v_vendor_id, current_date - 60, current_date - 31,
    0.00, 500.00, 500.00,
    v_staff_id
  ) returning id into v_trueup_id;

  select journal_entry_id into v_je_id
    from public.cogs_send_out_trueups where id = v_trueup_id;

  assert v_je_id is not null,
    'A12: journal_entry_id not set for billed=500/accrued=0 trueup';

  select id into v_acct_6420 from public.chart_of_accounts where code='6420';
  select id into v_acct_2150 from public.chart_of_accounts where code='2150';

  select debit_php into v_dr_6420 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_6420;
  select credit_php into v_cr_2150 from public.journal_lines
    where entry_id = v_je_id and account_id = v_acct_2150;

  assert coalesce(v_dr_6420, 0) = 500.00,
    format('A12: expected DR 6420=500, got %s', coalesce(v_dr_6420, 0));
  assert coalesce(v_cr_2150, 0) = 500.00,
    format('A12: expected CR 2150=500, got %s', coalesce(v_cr_2150, 0));

  insert into smoke_125_ids values ('trueup_a12_id', v_trueup_id);

  raise notice 'ASSERTION 12 PASS: Trueup (billed=500,accrued=0) → DR6420/CR2150=500';
end $$;


-- ============================================================================
-- ASSERTION 13
-- Attempt release of consult without attending_physician_id (visit or line) →
-- raises P0034.
-- ============================================================================
do $$
declare
  v_tr_id     uuid;
  v_sqlstate  text;
  v_visit_id  uuid;
  v_svc_id    uuid;
  v_auth_id   uuid;
  v_patient_id uuid;
  v_no_phys_visit uuid;
begin
  select val into v_auth_id   from smoke_125_ids where key='auth_user_id';
  select val into v_svc_id    from smoke_125_ids where key='svc_consult_p0034';
  select val into v_patient_id from smoke_125_ids where key='patient_id';

  -- Create a visit with NO attending_physician_id
  insert into public.visits (patient_id, payment_status, total_php, notes)
  values (v_patient_id, 'paid', 500, 'SMOKE-12.5 A13 no-phys visit')
  returning id into v_no_phys_visit;

  insert into public.payments (visit_id, amount_php, method, received_by)
  values (v_no_phys_visit, 500, 'cash', v_auth_id);

  -- Insert test_request with no attending_physician_id on the line
  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    final_price_php, base_price_php, clinic_fee_php, doctor_pf_php
  ) values (
    v_no_phys_visit, v_svc_id, 'requested', v_auth_id,
    500.00, 500.00, 300.00, 200.00
  ) returning id into v_tr_id;

  -- Attempt release — should raise P0034
  begin
    update public.test_requests
      set status = 'released', released_at = now(), released_by = v_auth_id
      where id = v_tr_id;
    -- If we reach here, the guard didn't fire
    assert false, 'A13: P0034 guard did not raise; release should fail without physician';
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    assert v_sqlstate = 'P0034',
      format('A13: expected P0034, got %s', v_sqlstate);
  end;

  insert into smoke_125_ids values ('tr_no_phys',       v_tr_id);
  insert into smoke_125_ids values ('visit_no_phys_id', v_no_phys_visit);

  raise notice 'ASSERTION 13 PASS: Release without attending_physician_id → P0034 raised';
end $$;


-- ============================================================================
-- ASSERTION 14
-- Idempotency: re-fire bridge_test_request_released on the same test_request
-- (by re-UPDATEing to released status when it's already released) → no duplicate
-- JE (partial unique index journal_entries_one_posted_per_source blocks).
-- ============================================================================
do $$
declare
  v_tr_id     uuid;
  v_je_count  int;
  v_auth_id   uuid;
begin
  -- Use the cash consult tr_id from A1
  select val into v_tr_id   from smoke_125_ids where key='tr_cash_consult';
  select val into v_auth_id from smoke_125_ids where key='auth_user_id';

  -- tr is already 'released'; fire another update (status stays same)
  -- The trigger fires when old.status IS DISTINCT FROM new.status AND new.status='released'.
  -- So first set it to 'in_progress' then back to 'released' to re-trigger.
  -- Actually: set to something else first, then released — but that's risky since
  -- the bridge checks for existing posted JE and returns early (idempotency guard).
  -- Instead: test via a direct INSERT that would collide with the partial unique index.
  begin
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id
    ) values (
      current_date, 'SMOKE-12.5 A14 duplicate JE test', 'posted',
      'test_request', v_tr_id
    );
    assert false, 'A14: should not be able to insert second posted JE for same source_id';
  exception when unique_violation then
    null;  -- expected: partial unique index blocked the duplicate
  end;

  -- Confirm only 1 posted JE exists for this test_request
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'test_request' and source_id = v_tr_id and status = 'posted';

  assert v_je_count = 1,
    format('A14: expected exactly 1 posted JE, found %s', v_je_count);

  raise notice 'ASSERTION 14 PASS: Idempotency — partial unique index blocks duplicate posted JE for same source';
end $$;


-- ============================================================================
-- ASSERTION 15
-- Discounted consult release → JE is balanced with correct contra-revenue model.
-- Policy (12.5.1c): discount is absorbed by clinic share, not by doctor PF.
--   DR cash (1100)        800   (final_price_php)
--   DR 4920 (contra-rev)  200   (discount_amount_php)
--   CR 4200 (revenue)     300   (clinic_fee_php + discount_amount_php = 100+200)
--   CR 2110 (AP-Doctors)  700   (doctor_pf_php — full, unaffected by discount)
-- Sum DR = 1000, Sum CR = 1000 ✓
-- ============================================================================
do $$
declare
  v_visit_id      uuid;
  v_tr_id         uuid;
  v_je_id         uuid;
  v_patient_id    uuid;
  v_phys_id       uuid;
  v_auth_id       uuid;
  v_svc_id        uuid;
  v_debit         numeric(12,2);
  v_credit        numeric(12,2);
  v_acct_1100     uuid;
  v_acct_4200     uuid;
  v_acct_4920     uuid;
  v_acct_2110     uuid;
  v_dr_cash       numeric(12,2);
  v_dr_contra     numeric(12,2);
  v_cr_revenue    numeric(12,2);
  v_cr_pf         numeric(12,2);
begin
  select val into v_patient_id from smoke_125_ids where key='patient_id';
  select val into v_phys_id    from smoke_125_ids where key='phys_pf_split';
  select val into v_auth_id    from smoke_125_ids where key='auth_user_id';
  select val into v_svc_id     from smoke_125_ids where key='svc_consult';

  -- Create a new cash visit for this assertion (paid, attending_physician set).
  insert into public.visits (patient_id, payment_status, total_php, attending_physician_id, notes)
  values (v_patient_id, 'paid', 800, v_phys_id, 'SMOKE-12.5 A15 discounted consult')
  returning id into v_visit_id;

  insert into public.payments (visit_id, amount_php, method, received_by, notes)
  values (v_visit_id, 800, 'cash', v_auth_id, 'SMOKE-12.5 A15 payment');

  -- test_request: base=1000, discount=200 (senior/PWD), final=800.
  -- clinic_fee=100, doctor_pf=700 (clinic_fee + doctor_pf = final_price = 800 ✓).
  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    base_price_php, discount_kind, discount_amount_php, final_price_php,
    clinic_fee_php, doctor_pf_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    1000.00, 'senior_pwd_20', 200.00, 800.00,
    100.00, 700.00
  ) returning id into v_tr_id;

  -- Release → bridge_test_request_released fires.
  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  -- Find the posted JE.
  select id into v_je_id from public.journal_entries
    where source_kind = 'test_request' and source_id = v_tr_id and status = 'posted';

  assert v_je_id is not null, 'A15: no posted JE for discounted consult release';

  -- JE must be balanced.
  select sum(debit_php), sum(credit_php) into v_debit, v_credit
    from public.journal_lines where entry_id = v_je_id;

  assert v_debit = v_credit and v_debit > 0,
    format('A15: JE not balanced (debit=%s credit=%s)', v_debit, v_credit);

  -- Check individual line amounts.
  select id into v_acct_1100 from public.chart_of_accounts where code = '1100';
  select id into v_acct_4200 from public.chart_of_accounts where code = '4200';
  select id into v_acct_4920 from public.chart_of_accounts where code = '4920';
  select id into v_acct_2110 from public.chart_of_accounts where code = '2110';

  select sum(debit_php)  into v_dr_cash    from public.journal_lines where entry_id = v_je_id and account_id = v_acct_1100;
  select sum(debit_php)  into v_dr_contra  from public.journal_lines where entry_id = v_je_id and account_id = v_acct_4920;
  select sum(credit_php) into v_cr_revenue from public.journal_lines where entry_id = v_je_id and account_id = v_acct_4200;
  select sum(credit_php) into v_cr_pf      from public.journal_lines where entry_id = v_je_id and account_id = v_acct_2110;

  assert coalesce(v_dr_cash,   0) = 800.00,
    format('A15: expected DR 1100=800, got %s', coalesce(v_dr_cash, 0));
  assert coalesce(v_dr_contra, 0) = 200.00,
    format('A15: expected DR 4920=200, got %s', coalesce(v_dr_contra, 0));
  assert coalesce(v_cr_revenue,0) = 300.00,
    format('A15: expected CR 4200=300 (clinic_fee+discount=100+200), got %s', coalesce(v_cr_revenue, 0));
  assert coalesce(v_cr_pf,     0) = 700.00,
    format('A15: expected CR 2110=700 (full PF, unaffected by discount), got %s', coalesce(v_cr_pf, 0));

  -- Store for cleanup.
  insert into smoke_125_ids values ('visit_a15_id', v_visit_id);
  insert into smoke_125_ids values ('tr_a15_discount', v_tr_id);

  raise notice 'ASSERTION 15 PASS: Discounted consult release → JE balanced (DR1100=800, DR4920=200, CR4200=300, CR2110=700)';
end $$;


-- ============================================================================
-- ASSERTION 16
-- HMO payment void cascade uses HMO-correct accounts (2160 and 1110),
-- not the cash-path defaults (2110 and 1100).
--
-- Setup: HMO visit + consult release (PF → 2160). Then void the payment
-- (visit becomes un-paid). bridge_payment_void_pf_cascade should emit:
--   DR 2160  (reverse the HMO PF holding credit)
--   CR 1110  (reverse the HMO AR debit)
-- NOT DR 2110 / CR 1100 (which would be wrong).
-- ============================================================================
do $$
declare
  v_visit_id      uuid;
  v_tr_id         uuid;
  v_pfe_id        uuid;
  v_payment_id    uuid;
  v_cascade_je_id uuid;
  v_patient_id    uuid;
  v_phys_id       uuid;
  v_auth_id       uuid;
  v_hmo_id        uuid;
  v_svc_id        uuid;
  v_acct_2160     uuid;
  v_acct_1110     uuid;
  v_acct_2110     uuid;
  v_acct_1100     uuid;
  v_dr_2160       numeric(12,2);
  v_cr_1110       numeric(12,2);
  v_dr_2110       numeric(12,2);
  v_cr_1100       numeric(12,2);
begin
  select val into v_patient_id from smoke_125_ids where key='patient_id';
  select val into v_phys_id    from smoke_125_ids where key='phys_pf_split';
  select val into v_auth_id    from smoke_125_ids where key='auth_user_id';
  select val into v_hmo_id     from smoke_125_ids where key='hmo_id';
  select val into v_svc_id     from smoke_125_ids where key='svc_consult';

  -- Create an HMO visit with a single payment (so voiding it makes visit un-paid).
  insert into public.visits (
    patient_id, payment_status, total_php, hmo_provider_id,
    hmo_approval_date, hmo_authorization_no, attending_physician_id, notes
  ) values (
    v_patient_id, 'unpaid', 1000, v_hmo_id,
    current_date, 'SMOKE-125-A16-HMO', v_phys_id,
    'SMOKE-12.5 A16 HMO cascade visit'
  ) returning id into v_visit_id;

  -- Insert a test_request in 'requested' status (not yet released).
  insert into public.test_requests (
    visit_id, service_id, status, requested_by,
    base_price_php, final_price_php, clinic_fee_php, doctor_pf_php, discount_amount_php
  ) values (
    v_visit_id, v_svc_id, 'requested', v_auth_id,
    1000.00, 1000.00, 300.00, 700.00, 0.00
  ) returning id into v_tr_id;

  -- Mark visit as paid before releasing (payment_status gate).
  update public.visits set payment_status = 'paid' where id = v_visit_id;

  -- Insert payment (this backs the paid status for the void test).
  insert into public.payments (visit_id, amount_php, method, received_by, notes)
  values (v_visit_id, 1000, 'hmo', v_auth_id, 'SMOKE-12.5 A16 HMO payment')
  returning id into v_payment_id;

  -- Release → PF goes to 2160 (HMO holding), AR to 1110.
  update public.test_requests
    set status = 'released', released_at = now(), released_by = v_auth_id
    where id = v_tr_id;

  -- Confirm PF entry has recognition_basis='hmo_at_settlement' (not yet recognized).
  select id into v_pfe_id from public.doctor_pf_entries
    where test_request_id = v_tr_id
      and recognition_basis = 'hmo_at_settlement'
      and voided_at is null;

  assert v_pfe_id is not null, 'A16: expected hmo_at_settlement PF entry after HMO consult release';

  -- Void the payment → cascade fires.
  -- Note: recalc_visit_payment only fires on INSERT, not UPDATE (void). So the visit's
  -- payment_status doesn't auto-flip to 'unpaid' when a payment is voided. The cascade
  -- guard checks v_visit.payment_status, so we must set it manually first (same pattern
  -- as A9). In production this would be set by the calling Server Action.
  update public.visits set payment_status = 'unpaid' where id = v_visit_id;
  update public.payments
    set voided_at = now(), voided_by = v_auth_id, void_reason = 'A16 smoke test'
    where id = v_payment_id;

  -- After void, visit payment_status should be 'unpaid'.
  -- The cascade bridge emits a partial-reversal JE for the HMO pending PF entry.
  -- For hmo_at_settlement entries, the original PF entry's journal_entry_id is NULL
  -- (PF was deferred to settlement), so the cascade JE has reverses=NULL.
  -- The trigger runs SECURITY DEFINER, so auth.uid() is NULL → created_by=NULL.
  -- Search by: source_kind='reversal', status='posted', has a DR 2160 line, and
  -- description matches the HMO pending reversal pattern (the trigger embeds that text).
  select id into v_cascade_je_id from public.journal_entries je
    where je.source_kind = 'reversal'
      and je.status = 'posted'
      and je.description like 'PF pending reversal:%'
      and exists (
        select 1 from public.journal_lines jl
        join public.chart_of_accounts c on c.id = jl.account_id
        where jl.entry_id = je.id and c.code = '2160' and jl.debit_php > 0
      )
    order by je.created_at desc
    limit 1;

  assert v_cascade_je_id is not null, 'A16: no cascade reversal JE with DR 2160 after HMO payment void';

  -- The cascade JE should use 2160 (HMO PF holding) and 1110 (AR HMO).
  select id into v_acct_2160 from public.chart_of_accounts where code = '2160';
  select id into v_acct_1110 from public.chart_of_accounts where code = '1110';
  select id into v_acct_2110 from public.chart_of_accounts where code = '2110';
  select id into v_acct_1100 from public.chart_of_accounts where code = '1100';

  select sum(debit_php)  into v_dr_2160 from public.journal_lines where entry_id = v_cascade_je_id and account_id = v_acct_2160;
  select sum(credit_php) into v_cr_1110 from public.journal_lines where entry_id = v_cascade_je_id and account_id = v_acct_1110;
  select sum(debit_php)  into v_dr_2110 from public.journal_lines where entry_id = v_cascade_je_id and account_id = v_acct_2110;
  select sum(credit_php) into v_cr_1100 from public.journal_lines where entry_id = v_cascade_je_id and account_id = v_acct_1100;

  assert coalesce(v_dr_2160, 0) = 700.00,
    format('A16: expected DR 2160=700 (HMO PF account), got %s', coalesce(v_dr_2160, 0));
  assert coalesce(v_cr_1110, 0) = 700.00,
    format('A16: expected CR 1110=700 (HMO AR account), got %s', coalesce(v_cr_1110, 0));
  assert coalesce(v_dr_2110, 0) = 0.00,
    format('A16: cascade should NOT touch 2110 (cash PF account), but DR 2110=%s', coalesce(v_dr_2110, 0));
  assert coalesce(v_cr_1100, 0) = 0.00,
    format('A16: cascade should NOT touch 1100 (cash AR account), but CR 1100=%s', coalesce(v_cr_1100, 0));

  -- Store for cleanup.
  insert into smoke_125_ids values ('visit_a16_id', v_visit_id);
  insert into smoke_125_ids values ('tr_a16_hmo_void', v_tr_id);

  raise notice 'ASSERTION 16 PASS: HMO payment void cascade uses 2160/1110 (not 2110/1100)';
end $$;


-- ============================================================================
-- CLEANUP
-- ============================================================================
-- Using draft-flip pattern (feedback_je_cleanup_pattern.md):
-- posted/reversed JEs need status='draft' before lines can be deleted.
-- Also null out reversed_by self-FKs before deleting referenced JEs.
-- ============================================================================

do $$
declare
  v_je_ids uuid[];
begin
  raise notice '=== SMOKE-12.5: Starting cleanup... ===';

  -- Collect ALL JE IDs created by the smoke staff user.
  -- This is the broadest possible net — catches every JE the triggers created
  -- during this transaction, including ones whose source IDs aren't in the named-key list.
  select array_agg(je.id) into v_je_ids
  from public.journal_entries je
  where je.created_by = (select val from smoke_125_ids where key = 'staff_id');

  if v_je_ids is null then
    v_je_ids := '{}';
  end if;

  -- Step 1: null out reversed_by FK on all JEs that reference other smoke JEs
  update public.journal_entries set reversed_by = null
    where id = any(v_je_ids) and reversed_by = any(v_je_ids);

  -- Step 2: flip all to draft (allows line deletion)
  update public.journal_entries set status = 'draft'
    where id = any(v_je_ids);

  -- Step 3: null out journal_entry_id FKs on subledger rows that reference these JEs
  -- (must happen before JE deletion to avoid FK violations)
  update public.doctor_pf_entries set journal_entry_id = null
    where journal_entry_id = any(v_je_ids);
  update public.doctor_pf_disbursements set journal_entry_id = null
    where journal_entry_id = any(v_je_ids);
  update public.cogs_send_out_entries set journal_entry_id = null
    where journal_entry_id = any(v_je_ids);
  update public.cogs_send_out_trueups set journal_entry_id = null
    where journal_entry_id = any(v_je_ids);

  -- Step 4: delete lines
  delete from public.journal_lines where entry_id = any(v_je_ids);

  -- Step 5: delete JEs (reversal JEs first since they reference others via reverses FK)
  -- Delete reversals first (they reference originals via reverses), then originals.
  delete from public.journal_entries
    where id = any(v_je_ids) and source_kind = 'reversal';
  delete from public.journal_entries where id = any(v_je_ids);

  raise notice 'JEs cleaned up.';
end $$;

do $$
begin
  -- Subledger tables: doctor_pf_entries, cogs_send_out_entries, cogs_send_out_trueups
  -- Entries reference trueups (FK), so clear trueup_id references first.
  update public.cogs_send_out_entries set trueup_id = null, trued_up_at = null
    where test_request_id in (
      select val from smoke_125_ids
      where key in ('tr_sendout_cost','tr_sendout_null'));

  delete from public.cogs_send_out_trueups
    where id in (select val from smoke_125_ids where key in ('trueup_a11_id','trueup_a12_id'));

  delete from public.cogs_send_out_entries
    where test_request_id in (
      select val from smoke_125_ids
      where key in ('tr_sendout_cost','tr_sendout_null'));

  -- doctor_pf_entries: clear disbursement_id FK before deleting disbursements
  update public.doctor_pf_entries set disbursement_id = null
    where disbursement_id in (
      select val from smoke_125_ids where key in ('disb_a9_id','disb_a10_id'));

  delete from public.doctor_pf_disbursements
    where id in (select val from smoke_125_ids where key in ('disb_a9_id','disb_a10_id'));

  -- Delete all PF entries for any test_request on smoke visits (catches clawback rows
  -- and A9 entries that aren't in the named-key list)
  delete from public.doctor_pf_entries
    where test_request_id in (
      select id from public.test_requests
      where visit_id in (
        select val from smoke_125_ids
        where key in ('visit_cash_id','visit_hmo_id','visit_hmo2_id','visit_hmo3_id',
                      'visit_a9_id','visit_no_phys_id','visit_a15_id','visit_a16_id')))
    or test_request_id in (
      select val from smoke_125_ids
      where key in ('tr_cash_consult','tr_hmo_consult','tr_sendout_cost','tr_sendout_null',
                    'tr_cancel_consult','tr_clawback_consult','tr_hmo3_consult',
                    'tr_hmo2_consult','tr_a15_discount','tr_a16_hmo_void'));

  raise notice 'Subledger rows cleaned up.';
end $$;

do $$
begin
  -- HMO data cleanup.
  -- hmo_claim_resolutions has a P0009 guard trigger that blocks DELETE.
  -- Since this entire script is wrapped in a BEGIN/ROLLBACK transaction,
  -- temporarily disabling the guard trigger is safe — the trigger state
  -- reverts with the ROLLBACK. (In production the trigger protects audit trail.)
  alter table public.hmo_claim_resolutions disable trigger tg_hmo_resolution_p0009_guard;

  delete from public.hmo_claim_resolutions
    where item_id in (
      select id from public.hmo_claim_items
        where batch_id in (select val from smoke_125_ids where key in ('hmo_batch2_id','hmo_batch3_id')));

  alter table public.hmo_claim_resolutions enable trigger tg_hmo_resolution_p0009_guard;

  delete from public.hmo_payment_allocations
    where item_id in (
      select id from public.hmo_claim_items
        where batch_id in (select val from smoke_125_ids where key in ('hmo_batch2_id','hmo_batch3_id')));

  delete from public.hmo_claim_items
    where batch_id in (select val from smoke_125_ids where key in ('hmo_batch2_id','hmo_batch3_id'));

  delete from public.hmo_claim_batches
    where id in (select val from smoke_125_ids where key in ('hmo_batch2_id','hmo_batch3_id'));

  raise notice 'HMO data cleaned up.';
end $$;

do $$
begin
  -- Payments: delete all payments on smoke visits (catches A13 no-phys visit payment
  -- and any other dynamically created payments not in the named-key list).
  -- The void-guard trigger blocks edits to already-voided payments but not DELETE from
  -- superuser context. Note: payment JEs are already cleaned up above.
  delete from public.payments
    where visit_id in (
      select val from smoke_125_ids
      where key in ('visit_cash_id','visit_hmo_id','visit_hmo2_id','visit_hmo3_id',
                    'visit_a9_id','visit_no_phys_id','visit_a15_id','visit_a16_id'))
       or notes like 'SMOKE-12.5%';

  -- test_requests
  delete from public.test_requests
    where id in (
      select val from smoke_125_ids
      where key in ('tr_cash_consult','tr_hmo_consult','tr_sendout_cost','tr_sendout_null',
                    'tr_cancel_consult','tr_clawback_consult','tr_hmo3_consult',
                    'tr_hmo2_consult','tr_no_phys','tr_a15_discount','tr_a16_hmo_void'));

  -- A9 / no-phys test_requests (may not be in the list above if they failed)
  delete from public.test_requests
    where visit_id in (
      select val from smoke_125_ids where key in ('visit_a9_id','visit_no_phys_id'));

  -- Catch-all: delete any remaining test_requests on ALL smoke visits
  -- (in case dynamic IDs weren't captured in smoke_125_ids)
  delete from public.test_requests
    where visit_id in (
      select val from smoke_125_ids
      where key in ('visit_cash_id','visit_hmo_id','visit_hmo2_id','visit_hmo3_id',
                    'visit_a9_id','visit_no_phys_id','visit_a15_id','visit_a16_id'));

  raise notice 'test_requests + payments cleaned up.';
end $$;

do $$
begin
  -- Visits
  delete from public.visits
    where id in (
      select val from smoke_125_ids
      where key in ('visit_cash_id','visit_hmo_id','visit_hmo2_id','visit_hmo3_id',
                    'visit_a9_id','visit_no_phys_id','visit_a15_id','visit_a16_id'))
      or notes like 'SMOKE-12.5%';

  -- Patient
  delete from public.patients where first_name = 'SMOKE125' and last_name = 'Patient';

  -- Services
  delete from public.services where code like 'SMOKE125%';

  -- Physicians
  delete from public.physicians where slug like 'smoke-125%';

  -- Vendor
  delete from public.vendors where name = 'SMOKE-12.5 Hi Precision';

  -- HMO provider (only if we created a synthetic one — don't delete Maxicare)
  delete from public.hmo_providers where name = 'SMOKE-12.5 HMO Provider';

  -- Staff profile + auth user
  delete from public.staff_profiles where full_name = 'SMOKE-12.5 Staff';
  delete from auth.users where email = 'smoke-12.5@drmed.internal';

  raise notice 'Fixture records cleaned up.';
end $$;

-- Final ROLLBACK ensures zero net DB change.
rollback;


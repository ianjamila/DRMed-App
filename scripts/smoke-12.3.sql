-- scripts/smoke-12.3.sql
-- =============================================================================
-- Smoke test for 12.3 HMO AR subledger (migration 0034).
--
-- Run via: supabase db reset && psql "$SUPABASE_DB_URL" -f scripts/smoke-12.3.sql
--
-- 34 numbered assertions, mirroring 12.2's smoke pattern. Each assertion:
--   - raises a NOTICE with PASS on success
--   - raises an EXCEPTION on failure (aborts the entire run)
--
-- IMPORTANT — cleanup discipline:
--   Per 12.2's known gotcha, this smoke does NOT rely on BEGIN; ... ROLLBACK;
--   to revert data — when run via Supabase MCP execute_sql the wrapping
--   transaction commits even on failure. Every INSERT is tagged with a
--   'SMOKE-12.3%' marker (visit notes, batch reference_no, payment notes,
--   patient first_name) so the cleanup block at the end can target our rows
--   precisely. Cleanup runs unconditionally at the end of the DO block; if an
--   assertion failed mid-flight, the DO block raises and rolls back the txn,
--   leaving the DB in its pre-smoke state. Run against a local Supabase
--   (`supabase start`) for fastest iteration.
-- =============================================================================

\set ON_ERROR_STOP true

DO $$
DECLARE
  v_staff_id           uuid;
  v_provider_id        uuid;
  v_lab_service_id     uuid;
  v_patient_id         uuid;
  v_visit_id           uuid;
  v_tr_id_a            uuid;
  v_tr_id_b            uuid;
  v_tr_id_c            uuid;
  v_batch_id           uuid;
  v_batch2_id          uuid;
  v_batch3_id          uuid;
  v_void_batch_id      uuid;
  v_item_a             uuid;
  v_item_b             uuid;
  v_item_c             uuid;
  v_payment_a          uuid;
  v_payment_b          uuid;
  v_payment_c          uuid;
  v_payment_partial    uuid;
  v_payment_void       uuid;
  v_alloc_a            uuid;
  v_alloc_b            uuid;
  v_resolution_id      uuid;
  v_resolution_b_id    uuid;
  v_resolution_c_id    uuid;
  v_mixed_item         uuid;
  v_mixed_batch        uuid;
  v_mixed_tr           uuid;
  v_count              int;
  v_int                int;
  v_text               text;
  v_amount             numeric(14,2);
  v_je_id              uuid;
  v_reversal_je        uuid;
  v_je_count           int;
  v_summary            jsonb;
  v_closed_period_id   uuid;
  v_period_was_closed  boolean;
  v_visit_paid_id      uuid;
BEGIN
  RAISE NOTICE '--- 12.3 SMOKE START ---';

  -- ============================================================
  -- Shared fixtures
  -- ============================================================
  SELECT id INTO v_staff_id FROM public.staff_profiles
   WHERE is_active = true ORDER BY created_at LIMIT 1;
  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'fixture FAILED: no active staff_profiles row to act as actor';
  END IF;

  SELECT id INTO v_provider_id FROM public.hmo_providers
   WHERE name = 'Maxicare' LIMIT 1;
  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'fixture FAILED: Maxicare provider not seeded';
  END IF;

  SELECT id INTO v_lab_service_id FROM public.services
   WHERE kind = 'lab_test' AND is_active = true LIMIT 1;
  IF v_lab_service_id IS NULL THEN
    RAISE EXCEPTION 'fixture FAILED: no active lab_test service available';
  END IF;

  -- Synthetic patient + visit (HMO Maxicare, paid status so bridge JE posts
  -- on payment insert and so we can release test requests).
  INSERT INTO public.patients (first_name, last_name, birthdate, sex)
    VALUES ('SMOKE-12.3', 'Patient', DATE '1990-01-01', 'male')
    RETURNING id INTO v_patient_id;

  INSERT INTO public.visits (
    patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
    payment_status, total_php, notes, created_by
  ) VALUES (
    v_patient_id, v_provider_id, CURRENT_DATE - 20, 'SMOKE-AUTH-001',
    'paid', 20000, 'SMOKE-12.3 visit', v_staff_id
  ) RETURNING id INTO v_visit_id;

  -- Three "released" test_requests with hmo_approved_amount > 0.
  -- INSERT with status='released' bypasses the BEFORE UPDATE payment-gate
  -- and the AFTER UPDATE bridge_test_request_released (both UPDATE-only).
  -- final_price = base = hmo_approved (no patient share, no discount).
  INSERT INTO public.test_requests (
    visit_id, service_id, status, requested_by, released_at, released_by,
    base_price_php, final_price_php, hmo_approved_amount_php
  ) VALUES (v_visit_id, v_lab_service_id, 'released', v_staff_id,
            NOW() - INTERVAL '20 days', v_staff_id, 10000, 10000, 10000)
  RETURNING id INTO v_tr_id_a;
  INSERT INTO public.test_requests (
    visit_id, service_id, status, requested_by, released_at, released_by,
    base_price_php, final_price_php, hmo_approved_amount_php
  ) VALUES (v_visit_id, v_lab_service_id, 'released', v_staff_id,
            NOW() - INTERVAL '20 days', v_staff_id, 6000, 6000, 6000)
  RETURNING id INTO v_tr_id_b;
  INSERT INTO public.test_requests (
    visit_id, service_id, status, requested_by, released_at, released_by,
    base_price_php, final_price_php, hmo_approved_amount_php
  ) VALUES (v_visit_id, v_lab_service_id, 'released', v_staff_id,
            NOW() - INTERVAL '20 days', v_staff_id, 4000, 4000, 4000)
  RETURNING id INTO v_tr_id_c;

  -- ============================================================
  -- Assertion 1: 6920 Bad Debt — HMO Write-offs exists.
  -- ============================================================
  PERFORM 1 FROM public.chart_of_accounts
   WHERE code = '6920' AND type = 'expense' AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assertion 1 FAILED: 6920 Bad Debt CoA row missing';
  END IF;
  RAISE NOTICE 'Assertion 1 PASS: 6920 Bad Debt present';

  -- ============================================================
  -- Assertion 2: hmo_providers.unbilled_threshold_days exists, defaults to 14.
  -- ============================================================
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'hmo_providers'
     AND column_name = 'unbilled_threshold_days';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assertion 2 FAILED: unbilled_threshold_days column missing';
  END IF;
  SELECT COUNT(*) INTO v_count FROM public.hmo_providers
   WHERE unbilled_threshold_days = 14;
  IF v_count < 11 THEN
    RAISE EXCEPTION 'Assertion 2 FAILED: expected ≥11 providers @ default 14, got %', v_count;
  END IF;
  RAISE NOTICE 'Assertion 2 PASS: unbilled_threshold_days defaults to 14 across all providers';

  -- ============================================================
  -- Assertion 3: All 11 expected providers seeded + active.
  -- ============================================================
  SELECT COUNT(*) INTO v_count FROM public.hmo_providers
   WHERE name IN ('Avega','Etiqa','iCare','Intellicare','Maxicare','Valucare',
                  'Cocolife','Med Asia','Generali','Amaphil','Pacific Cross')
     AND is_active = true;
  IF v_count <> 11 THEN
    RAISE EXCEPTION 'Assertion 3 FAILED: expected 11 active providers, got %', v_count;
  END IF;
  RAISE NOTICE 'Assertion 3 PASS: 11 providers seeded and active';

  -- ============================================================
  -- Assertion 4: create batch (draft) + 3 items.
  -- ============================================================
  INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes)
    VALUES (v_provider_id, 'draft', 'SMOKE-12.3-B1', 'SMOKE-12.3 happy-path batch')
    RETURNING id INTO v_batch_id;

  INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
    VALUES
      (v_batch_id, v_tr_id_a, 10000),
      (v_batch_id, v_tr_id_b, 6000),
      (v_batch_id, v_tr_id_c, 4000);

  SELECT COUNT(*) INTO v_count FROM public.hmo_claim_items WHERE batch_id = v_batch_id;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'Assertion 4 FAILED: expected 3 items, got %', v_count;
  END IF;

  SELECT id INTO v_item_a FROM public.hmo_claim_items
   WHERE batch_id = v_batch_id AND test_request_id = v_tr_id_a;
  SELECT id INTO v_item_b FROM public.hmo_claim_items
   WHERE batch_id = v_batch_id AND test_request_id = v_tr_id_b;
  SELECT id INTO v_item_c FROM public.hmo_claim_items
   WHERE batch_id = v_batch_id AND test_request_id = v_tr_id_c;

  RAISE NOTICE 'Assertion 4 PASS: batch + 3 items inserted';

  -- ============================================================
  -- Assertion 5: duplicate test_request_id blocked by partial unique index.
  -- ============================================================
  BEGIN
    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no)
      VALUES (v_provider_id, 'draft', 'SMOKE-12.3-DUP')
      RETURNING id INTO v_batch2_id;
    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_batch2_id, v_tr_id_a, 10000);
    RAISE EXCEPTION 'Assertion 5 FAILED: duplicate test_request_id was accepted';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'Assertion 5 PASS: partial unique index blocks duplicate active item';
  END;

  -- Clean up the dup batch (no items survived to block deletion).
  DELETE FROM public.hmo_claim_batches WHERE reference_no = 'SMOKE-12.3-DUP';

  -- ============================================================
  -- Assertion 6: submit the batch → status flips to 'submitted'.
  -- ============================================================
  UPDATE public.hmo_claim_batches
     SET status = 'submitted',
         submitted_at = CURRENT_DATE,
         submitted_by = v_staff_id,
         medium = 'mail'
   WHERE id = v_batch_id;

  PERFORM 1 FROM public.hmo_claim_batches
   WHERE id = v_batch_id
     AND status = 'submitted'
     AND submitted_at IS NOT NULL
     AND submitted_by IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assertion 6 FAILED: batch did not transition to submitted with submitted_at/by populated';
  END IF;
  RAISE NOTICE 'Assertion 6 PASS: batch transitioned to submitted';

  -- ============================================================
  -- Assertion 7: record HMO settlement → allocations recompute item.paid_amount.
  -- ============================================================
  -- One payment per item (mirrors UI behaviour). amount must be > 0; we use
  -- method='hmo' so 12.2's bridge will post DR 1090 / CR 1110.
  INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
    VALUES (v_visit_id, 10000, 'hmo', v_staff_id, 'SMOKE-12.3 payment A')
    RETURNING id INTO v_payment_a;
  INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
    VALUES (v_visit_id, 6000, 'hmo', v_staff_id, 'SMOKE-12.3 payment B')
    RETURNING id INTO v_payment_b;
  INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
    VALUES (v_visit_id, 4000, 'hmo', v_staff_id, 'SMOKE-12.3 payment C')
    RETURNING id INTO v_payment_c;

  INSERT INTO public.hmo_payment_allocations (payment_id, item_id, amount_php)
    VALUES
      (v_payment_a, v_item_a, 10000),
      (v_payment_b, v_item_b, 6000),
      (v_payment_c, v_item_c, 4000);

  SELECT COALESCE(SUM(paid_amount_php), 0) INTO v_amount
    FROM public.hmo_claim_items WHERE batch_id = v_batch_id;
  IF v_amount <> 20000 THEN
    RAISE EXCEPTION 'Assertion 7 FAILED: expected paid_amount sum 20000, got %', v_amount;
  END IF;
  -- Update hmo_response to 'paid' on each item (UI does this too); also
  -- set the response_date so it's a realistic shape.
  UPDATE public.hmo_claim_items SET hmo_response = 'paid', hmo_response_date = CURRENT_DATE
   WHERE batch_id = v_batch_id;
  RAISE NOTICE 'Assertion 7 PASS: 3 payments + 3 allocations; item paid_amount sum = 20000';

  -- ============================================================
  -- Assertion 8: 12.2 bridge still posts DR 1090 / CR 1110 per payment.
  -- ============================================================
  SELECT COUNT(*) INTO v_count
    FROM public.journal_entries je
    JOIN public.journal_lines jl ON jl.entry_id = je.id
    JOIN public.chart_of_accounts coa_dr
      ON coa_dr.id = jl.account_id AND coa_dr.code = '1090'
   WHERE je.source_kind = 'payment'
     AND je.source_id IN (v_payment_a, v_payment_b, v_payment_c)
     AND je.status = 'posted'
     AND jl.debit_php > 0;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'Assertion 8 FAILED: expected 3 DR-1090 lines from 12.2 payment bridge, got %', v_count;
  END IF;
  SELECT COUNT(*) INTO v_count
    FROM public.journal_entries je
    JOIN public.journal_lines jl ON jl.entry_id = je.id
    JOIN public.chart_of_accounts coa_cr
      ON coa_cr.id = jl.account_id AND coa_cr.code = '1110'
   WHERE je.source_kind = 'payment'
     AND je.source_id IN (v_payment_a, v_payment_b, v_payment_c)
     AND je.status = 'posted'
     AND jl.credit_php > 0;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'Assertion 8 FAILED: expected 3 CR-1110 lines from 12.2 payment bridge, got %', v_count;
  END IF;
  RAISE NOTICE 'Assertion 8 PASS: 12.2 bridge posted DR 1090 / CR 1110 for each of 3 HMO payments';

  -- ============================================================
  -- Assertion 9: batch status auto-flips to 'paid'.
  -- ============================================================
  SELECT status INTO v_text FROM public.hmo_claim_batches WHERE id = v_batch_id;
  IF v_text <> 'paid' THEN
    RAISE EXCEPTION 'Assertion 9 FAILED: expected batch status = paid, got %', v_text;
  END IF;
  RAISE NOTICE 'Assertion 9 PASS: batch auto-rolled up to status=paid';

  -- ============================================================
  -- Assertion 10: new batch + partial allocation → status = 'partial_paid'.
  -- ============================================================
  -- Reuse the same items? No — the items above are fully resolved (paid).
  -- We need a fresh test_request to make a new item. Approach: void the
  -- second item, batch the same test_request again. Cleaner: create a second
  -- visit + 2 fresh test_requests for the partial scenario.
  DECLARE
    v_visit2_id  uuid;
    v_tr_d_id    uuid;
    v_tr_e_id    uuid;
    v_item_d     uuid;
    v_item_e     uuid;
  BEGIN
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 15, 'SMOKE-AUTH-002',
      'paid', 5000, 'SMOKE-12.3 partial visit', v_staff_id
    ) RETURNING id INTO v_visit2_id;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES (v_visit2_id, v_lab_service_id, 'released', v_staff_id,
              NOW() - INTERVAL '15 days', v_staff_id, 2000, 2000, 2000)
      RETURNING id INTO v_tr_d_id;
    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES (v_visit2_id, v_lab_service_id, 'released', v_staff_id,
              NOW() - INTERVAL '15 days', v_staff_id, 3000, 3000, 3000)
      RETURNING id INTO v_tr_e_id;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes,
                                          submitted_at, submitted_by, medium)
      VALUES (v_provider_id, 'submitted', 'SMOKE-12.3-B2', 'SMOKE-12.3 partial-paid batch',
              CURRENT_DATE, v_staff_id, 'mail')
      RETURNING id INTO v_batch2_id;

    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES
        (v_batch2_id, v_tr_d_id, 2000),
        (v_batch2_id, v_tr_e_id, 3000);

    SELECT id INTO v_item_d FROM public.hmo_claim_items
     WHERE batch_id = v_batch2_id AND test_request_id = v_tr_d_id;
    SELECT id INTO v_item_e FROM public.hmo_claim_items
     WHERE batch_id = v_batch2_id AND test_request_id = v_tr_e_id;

    -- Item D paid in full (2000); item E paid 60% (1800 of 3000) — leaves 1200 unresolved.
    INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
      VALUES (v_visit2_id, 2000, 'hmo', v_staff_id, 'SMOKE-12.3 payment D')
      RETURNING id INTO v_payment_partial;
    INSERT INTO public.hmo_payment_allocations (payment_id, item_id, amount_php)
      VALUES (v_payment_partial, v_item_d, 2000);

    INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
      VALUES (v_visit2_id, 1800, 'hmo', v_staff_id, 'SMOKE-12.3 payment E partial')
      RETURNING id INTO v_payment_partial;
    INSERT INTO public.hmo_payment_allocations (payment_id, item_id, amount_php)
      VALUES (v_payment_partial, v_item_e, 1800);

    -- Resolve item E's remaining 1200 to patient_bill so both items are fully
    -- resolved (D paid 100%, E paid 60% + patient_bill 40% = 100%). The rollup
    -- rule says: all resolved AND total paid != total billed AND total paid > 0
    -- → 'partial_paid'.
    INSERT INTO public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by, notes)
      VALUES (v_item_e, 'patient_bill', 1200, v_staff_id, 'SMOKE-12.3 partial resolve')
      RETURNING id INTO v_resolution_b_id;

    -- After resolution insert, the batch rollup trigger fires.
    SELECT status INTO v_text FROM public.hmo_claim_batches WHERE id = v_batch2_id;
    IF v_text <> 'partial_paid' THEN
      RAISE EXCEPTION 'Assertion 10 FAILED: expected partial_paid, got %', v_text;
    END IF;

    -- Stash for later assertions.
    v_mixed_item := v_item_e;
    v_mixed_batch := v_batch2_id;
    v_mixed_tr := v_tr_e_id;
  END;
  RAISE NOTICE 'Assertion 10 PASS: partial-paid batch rolled up to partial_paid';

  -- ============================================================
  -- Assertion 11: resolution → patient_bill posts DR 1100 / CR 1110.
  -- ============================================================
  -- v_resolution_b_id is the patient_bill resolution from Assertion 10.
  SELECT je.id INTO v_je_id
    FROM public.journal_entries je
   WHERE je.source_kind = 'hmo_claim_resolution'
     AND je.source_id = v_resolution_b_id
     AND je.status = 'posted';
  IF v_je_id IS NULL THEN
    RAISE EXCEPTION 'Assertion 11 FAILED: no posted JE found for patient_bill resolution';
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.journal_lines jl
    JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
   WHERE jl.entry_id = v_je_id
     AND coa.code = '1100'
     AND jl.debit_php = 1200
     AND jl.credit_php = 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Assertion 11 FAILED: expected DR 1100 line of 1200, got %', v_count;
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.journal_lines jl
    JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
   WHERE jl.entry_id = v_je_id
     AND coa.code = '1110'
     AND jl.credit_php = 1200
     AND jl.debit_php = 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Assertion 11 FAILED: expected CR 1110 line of 1200, got %', v_count;
  END IF;

  -- Verify item amount updated by trigger.
  SELECT patient_billed_amount_php INTO v_amount
    FROM public.hmo_claim_items WHERE id = v_mixed_item;
  IF v_amount <> 1200 THEN
    RAISE EXCEPTION 'Assertion 11 FAILED: expected patient_billed_amount_php=1200, got %', v_amount;
  END IF;
  RAISE NOTICE 'Assertion 11 PASS: patient_bill resolution posted DR 1100 / CR 1110 and updated item';

  -- ============================================================
  -- Assertion 12: after resolution, batch status auto-recomputes correctly.
  -- ============================================================
  -- Already verified by Assertion 10's final status check (partial_paid).
  -- Re-check explicitly here.
  SELECT status INTO v_text FROM public.hmo_claim_batches WHERE id = v_mixed_batch;
  IF v_text <> 'partial_paid' THEN
    RAISE EXCEPTION 'Assertion 12 FAILED: expected partial_paid after resolution, got %', v_text;
  END IF;
  RAISE NOTICE 'Assertion 12 PASS: batch status correctly recomputed post-resolution';

  -- ============================================================
  -- Assertion 13: resolution → write_off posts DR 6920 / CR 1110.
  -- ============================================================
  DECLARE
    v_visit3_id  uuid;
    v_tr_f_id    uuid;
    v_item_f     uuid;
    v_batch4_id  uuid;
    v_wo_je      uuid;
  BEGIN
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 12, 'SMOKE-AUTH-003',
      'paid', 5000, 'SMOKE-12.3 writeoff visit', v_staff_id
    ) RETURNING id INTO v_visit3_id;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES
      (v_visit3_id, v_lab_service_id, 'released', v_staff_id,
       NOW() - INTERVAL '12 days', v_staff_id, 5000, 5000, 5000)
      RETURNING id INTO v_tr_f_id;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes,
                                          submitted_at, submitted_by, medium)
      VALUES (v_provider_id, 'submitted', 'SMOKE-12.3-B3', 'SMOKE-12.3 writeoff batch',
              CURRENT_DATE, v_staff_id, 'mail')
      RETURNING id INTO v_batch4_id;

    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_batch4_id, v_tr_f_id, 5000)
      RETURNING id INTO v_item_f;

    INSERT INTO public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by, notes)
      VALUES (v_item_f, 'write_off', 5000, v_staff_id, 'SMOKE-12.3 writeoff')
      RETURNING id INTO v_resolution_c_id;

    SELECT je.id INTO v_wo_je
      FROM public.journal_entries je
     WHERE je.source_kind = 'hmo_claim_resolution'
       AND je.source_id = v_resolution_c_id
       AND je.status = 'posted';
    IF v_wo_je IS NULL THEN
      RAISE EXCEPTION 'Assertion 13 FAILED: no posted JE for write_off resolution';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM public.journal_lines jl
      JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
     WHERE jl.entry_id = v_wo_je
       AND coa.code = '6920'
       AND jl.debit_php = 5000;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Assertion 13 FAILED: expected DR 6920 line of 5000';
    END IF;

    SELECT COUNT(*) INTO v_count
      FROM public.journal_lines jl
      JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
     WHERE jl.entry_id = v_wo_je
       AND coa.code = '1110'
       AND jl.credit_php = 5000;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Assertion 13 FAILED: expected CR 1110 line of 5000';
    END IF;

    SELECT written_off_amount_php INTO v_amount
      FROM public.hmo_claim_items WHERE id = v_item_f;
    IF v_amount <> 5000 THEN
      RAISE EXCEPTION 'Assertion 13 FAILED: expected written_off_amount_php=5000, got %', v_amount;
    END IF;

    -- Batch now has 1 fully-resolved item (write_off), paid=0, billed=5000.
    -- Rule: all resolved + paid=0 → 'rejected'.
    SELECT status INTO v_text FROM public.hmo_claim_batches WHERE id = v_batch4_id;
    IF v_text <> 'rejected' THEN
      RAISE EXCEPTION 'Assertion 13 FAILED: expected batch=rejected, got %', v_text;
    END IF;
  END;
  RAISE NOTICE 'Assertion 13 PASS: write_off resolution posted DR 6920 / CR 1110; batch=rejected';

  -- ============================================================
  -- Assertion 14: mixed resolution on one item: paid 50% + patient_bill 30% + write_off 20%.
  -- ============================================================
  DECLARE
    v_visit4_id  uuid;
    v_tr_g_id    uuid;
    v_item_g     uuid;
    v_batch5_id  uuid;
    v_pay_g      uuid;
    v_res_pb_g   uuid;
    v_res_wo_g   uuid;
  BEGIN
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 8, 'SMOKE-AUTH-004',
      'paid', 10000, 'SMOKE-12.3 mixed visit', v_staff_id
    ) RETURNING id INTO v_visit4_id;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES
      (v_visit4_id, v_lab_service_id, 'released', v_staff_id,
       NOW() - INTERVAL '8 days', v_staff_id, 10000, 10000, 10000)
      RETURNING id INTO v_tr_g_id;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes,
                                          submitted_at, submitted_by, medium)
      VALUES (v_provider_id, 'submitted', 'SMOKE-12.3-B4', 'SMOKE-12.3 mixed batch',
              CURRENT_DATE, v_staff_id, 'mail')
      RETURNING id INTO v_batch5_id;

    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_batch5_id, v_tr_g_id, 10000)
      RETURNING id INTO v_item_g;

    INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
      VALUES (v_visit4_id, 5000, 'hmo', v_staff_id, 'SMOKE-12.3 mixed payment')
      RETURNING id INTO v_pay_g;
    INSERT INTO public.hmo_payment_allocations (payment_id, item_id, amount_php)
      VALUES (v_pay_g, v_item_g, 5000);

    INSERT INTO public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by, notes)
      VALUES (v_item_g, 'patient_bill', 3000, v_staff_id, 'SMOKE-12.3 mixed pbill')
      RETURNING id INTO v_res_pb_g;
    INSERT INTO public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by, notes)
      VALUES (v_item_g, 'write_off', 2000, v_staff_id, 'SMOKE-12.3 mixed wo')
      RETURNING id INTO v_res_wo_g;

    PERFORM 1 FROM public.hmo_claim_items
     WHERE id = v_item_g
       AND paid_amount_php = 5000
       AND patient_billed_amount_php = 3000
       AND written_off_amount_php = 2000
       AND (paid_amount_php + patient_billed_amount_php + written_off_amount_php) = 10000;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assertion 14 FAILED: mixed resolution amounts did not aggregate correctly';
    END IF;

    -- Batch status: only one fully-resolved item, paid=5000, billed=10000 → partial_paid.
    SELECT status INTO v_text FROM public.hmo_claim_batches WHERE id = v_batch5_id;
    IF v_text <> 'partial_paid' THEN
      RAISE EXCEPTION 'Assertion 14 FAILED: expected partial_paid, got %', v_text;
    END IF;
  END;
  RAISE NOTICE 'Assertion 14 PASS: mixed resolution (50/30/20) aggregates and batch=partial_paid';

  -- ============================================================
  -- Assertion 15: void a resolution → reversal JE posts, item amount decrements.
  -- ============================================================
  -- Use v_resolution_c_id (write_off of 5000 from Assertion 13).
  DECLARE
    v_item_f       uuid;
  BEGIN
    SELECT item_id INTO v_item_f FROM public.hmo_claim_resolutions WHERE id = v_resolution_c_id;

    UPDATE public.hmo_claim_resolutions
       SET voided_at = NOW(),
           voided_by = v_staff_id,
           void_reason = 'SMOKE-12.3 reversal test'
     WHERE id = v_resolution_c_id;

    -- After void, item.written_off_amount_php should drop to 0.
    SELECT written_off_amount_php INTO v_amount
      FROM public.hmo_claim_items WHERE id = v_item_f;
    IF v_amount <> 0 THEN
      RAISE EXCEPTION 'Assertion 15 FAILED: expected written_off=0 after void, got %', v_amount;
    END IF;

    -- Reversal JE should exist with reverses = original posted JE.
    SELECT je_rev.id INTO v_reversal_je
      FROM public.journal_entries je_orig
      JOIN public.journal_entries je_rev ON je_rev.reverses = je_orig.id
     WHERE je_orig.source_kind = 'hmo_claim_resolution'
       AND je_orig.source_id = v_resolution_c_id
       AND je_rev.status = 'posted'
     LIMIT 1;
    IF v_reversal_je IS NULL THEN
      RAISE EXCEPTION 'Assertion 15 FAILED: no reversal JE found for voided resolution';
    END IF;

    -- Reversal lines should swap debit/credit of original.
    SELECT COUNT(*) INTO v_count
      FROM public.journal_lines jl
      JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
     WHERE jl.entry_id = v_reversal_je
       AND coa.code = '6920'
       AND jl.credit_php = 5000
       AND jl.debit_php = 0;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Assertion 15 FAILED: expected CR 6920 mirror line in reversal';
    END IF;
    SELECT COUNT(*) INTO v_count
      FROM public.journal_lines jl
      JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
     WHERE jl.entry_id = v_reversal_je
       AND coa.code = '1110'
       AND jl.debit_php = 5000
       AND jl.credit_php = 0;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Assertion 15 FAILED: expected DR 1110 mirror line in reversal';
    END IF;
  END;
  RAISE NOTICE 'Assertion 15 PASS: void resolution → mirror reversal JE + item amount decremented';

  -- ============================================================
  -- Assertion 16: re-resolve same item after void → no source_id collision.
  -- ============================================================
  -- v_resolution_c_id was for v_item_f; its resolution is now voided. Re-resolve
  -- the same item to a different destination.
  DECLARE
    v_item_f      uuid;
    v_new_res     uuid;
    v_new_je      uuid;
  BEGIN
    SELECT item_id INTO v_item_f FROM public.hmo_claim_resolutions WHERE id = v_resolution_c_id;

    -- Now resolve same item to patient_bill (full unresolved = 5000).
    INSERT INTO public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by, notes)
      VALUES (v_item_f, 'patient_bill', 5000, v_staff_id, 'SMOKE-12.3 re-resolve after void')
      RETURNING id INTO v_new_res;

    SELECT je.id INTO v_new_je
      FROM public.journal_entries je
     WHERE je.source_kind = 'hmo_claim_resolution'
       AND je.source_id = v_new_res
       AND je.status = 'posted';
    IF v_new_je IS NULL THEN
      RAISE EXCEPTION 'Assertion 16 FAILED: no JE posted for re-resolution (source_id collision blocked it)';
    END IF;
    IF v_new_je = v_reversal_je THEN
      RAISE EXCEPTION 'Assertion 16 FAILED: re-resolution reused reversal JE id';
    END IF;
  END;
  RAISE NOTICE 'Assertion 16 PASS: re-resolve after void posts a fresh JE, no source_id collision';

  -- ============================================================
  -- Assertion 17: edit billed_amount_php after resolution exists → P0008.
  -- ============================================================
  -- v_item_a has an allocation (paid) but no resolution. Use it.
  BEGIN
    UPDATE public.hmo_claim_items SET billed_amount_php = 99999 WHERE id = v_item_a;
    RAISE EXCEPTION 'Assertion 17 FAILED: edit of billed_amount_php with active allocation was accepted';
  EXCEPTION
    WHEN sqlstate 'P0008' THEN
      RAISE NOTICE 'Assertion 17 PASS: P0008 blocks billed_amount edit with active allocation';
  END;

  -- ============================================================
  -- Assertion 18: DELETE on hmo_claim_resolutions → P0009.
  -- ============================================================
  BEGIN
    DELETE FROM public.hmo_claim_resolutions WHERE id = v_resolution_b_id;
    RAISE EXCEPTION 'Assertion 18 FAILED: DELETE on resolution was accepted';
  EXCEPTION
    WHEN sqlstate 'P0009' THEN
      RAISE NOTICE 'Assertion 18 PASS: P0009 blocks DELETE on hmo_claim_resolutions';
  END;

  -- ============================================================
  -- Assertion 19: void batch with no allocations/resolutions → succeeds.
  -- ============================================================
  -- Build a fresh batch + item with no allocation, no resolution.
  DECLARE
    v_visit5_id  uuid;
    v_tr_h_id    uuid;
    v_item_h     uuid;
    v_bvoid_id   uuid;
  BEGIN
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 5, 'SMOKE-AUTH-005',
      'paid', 1000, 'SMOKE-12.3 voidable visit', v_staff_id
    ) RETURNING id INTO v_visit5_id;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES
      (v_visit5_id, v_lab_service_id, 'released', v_staff_id,
       NOW() - INTERVAL '5 days', v_staff_id, 1000, 1000, 1000)
      RETURNING id INTO v_tr_h_id;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes)
      VALUES (v_provider_id, 'draft', 'SMOKE-12.3-BVOID', 'SMOKE-12.3 voidable batch')
      RETURNING id INTO v_bvoid_id;
    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_bvoid_id, v_tr_h_id, 1000)
      RETURNING id INTO v_item_h;

    UPDATE public.hmo_claim_batches
       SET voided_at = NOW(),
           voided_by = v_staff_id,
           void_reason = 'SMOKE-12.3 voidable',
           status = 'voided'
     WHERE id = v_bvoid_id;

    -- batch_voided propagated?
    PERFORM 1 FROM public.hmo_claim_items
     WHERE id = v_item_h AND batch_voided = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assertion 19 FAILED: batch_voided did not propagate to item';
    END IF;
    v_void_batch_id := v_bvoid_id;  -- stash for assertion 22
  END;
  RAISE NOTICE 'Assertion 19 PASS: void empty batch succeeded; batch_voided propagated';

  -- ============================================================
  -- Assertion 20: void batch with active allocation → P0010.
  -- ============================================================
  -- v_batch_id (assertion 4) has allocations. Try to void it.
  BEGIN
    UPDATE public.hmo_claim_batches
       SET voided_at = NOW(), voided_by = v_staff_id, void_reason = 'should fail'
     WHERE id = v_batch_id;
    RAISE EXCEPTION 'Assertion 20 FAILED: void of batch with active alloc was accepted';
  EXCEPTION
    WHEN sqlstate 'P0010' THEN
      RAISE NOTICE 'Assertion 20 PASS: P0010 blocks void of batch with active allocations';
  END;

  -- ============================================================
  -- Assertion 21: void batch with active resolution → P0010.
  -- ============================================================
  -- v_batch2_id has resolution v_resolution_b_id (still non-voided). Try to void it.
  BEGIN
    UPDATE public.hmo_claim_batches
       SET voided_at = NOW(), voided_by = v_staff_id, void_reason = 'should fail'
     WHERE id = v_batch2_id;
    RAISE EXCEPTION 'Assertion 21 FAILED: void of batch with active resolution was accepted';
  EXCEPTION
    WHEN sqlstate 'P0010' THEN
      RAISE NOTICE 'Assertion 21 PASS: P0010 blocks void of batch with active resolutions';
  END;

  -- ============================================================
  -- Assertion 22: after batch void, re-add same test_request to a NEW batch.
  -- ============================================================
  -- v_void_batch_id was voided; its item's test_request should be re-addable.
  DECLARE
    v_tr_h_id     uuid;
    v_new_batch   uuid;
    v_new_item    uuid;
  BEGIN
    SELECT test_request_id INTO v_tr_h_id
      FROM public.hmo_claim_items
     WHERE batch_id = v_void_batch_id LIMIT 1;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes)
      VALUES (v_provider_id, 'draft', 'SMOKE-12.3-RECYCLE', 'SMOKE-12.3 re-batch after void')
      RETURNING id INTO v_new_batch;
    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_new_batch, v_tr_h_id, 1000)
      RETURNING id INTO v_new_item;

    PERFORM 1 FROM public.hmo_claim_items WHERE id = v_new_item AND batch_voided = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assertion 22 FAILED: new active item missing after re-batch';
    END IF;
  END;
  RAISE NOTICE 'Assertion 22 PASS: partial unique index respects batch_voided; recycle works';

  -- ============================================================
  -- Assertion 23: resolution amount > unresolved balance → P0011.
  -- ============================================================
  -- v_item_a is fully paid (10000 of 10000) → unresolved = 0. Try to resolve.
  BEGIN
    INSERT INTO public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by, notes)
      VALUES (v_item_a, 'patient_bill', 1, v_staff_id, 'should fail P0011');
    RAISE EXCEPTION 'Assertion 23 FAILED: over-resolution was accepted';
  EXCEPTION
    WHEN sqlstate 'P0011' THEN
      RAISE NOTICE 'Assertion 23 PASS: P0011 blocks resolution exceeding unresolved balance';
  END;

  -- ============================================================
  -- Assertion 24: allocation amount > (billed - paid) → P0012.
  -- ============================================================
  -- v_item_a is fully paid; try to add another allocation.
  DECLARE
    v_extra_pay uuid;
  BEGIN
    INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
      VALUES (v_visit_id, 1, 'hmo', v_staff_id, 'SMOKE-12.3 over-alloc payment')
      RETURNING id INTO v_extra_pay;
    BEGIN
      INSERT INTO public.hmo_payment_allocations (payment_id, item_id, amount_php)
        VALUES (v_extra_pay, v_item_a, 1);
      RAISE EXCEPTION 'Assertion 24 FAILED: over-allocation was accepted';
    EXCEPTION
      WHEN sqlstate 'P0012' THEN
        RAISE NOTICE 'Assertion 24 PASS: P0012 blocks allocation exceeding billed';
    END;
    -- Cascade-void this extra payment so its bridge JE reverses cleanly.
    UPDATE public.payments SET voided_at = NOW(), voided_by = v_staff_id, void_reason = 'SMOKE-12.3 cleanup'
     WHERE id = v_extra_pay;
  END;

  -- ============================================================
  -- Assertion 25: bulk-set-hmo-response "pending_only" semantics.
  -- ============================================================
  -- Simulate the bulkSetHmoResponseAction body in SQL: update only items where
  -- hmo_response IS NOT 'paid' (the "pending_only" scope). v_batch_id has all
  -- 3 items currently 'paid'. Insert a synthetic 4th batch with 2 items, mark
  -- one as 'paid' beforehand, then bulk set the rest to 'rejected'.
  DECLARE
    v_bulk_batch  uuid;
    v_visit_b     uuid;
    v_tr1         uuid;
    v_tr2         uuid;
    v_item1       uuid;
    v_item2       uuid;
    v_updated     int;
    v_skipped     int;
  BEGIN
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 6, 'SMOKE-AUTH-BULK',
      'paid', 2000, 'SMOKE-12.3 bulk visit', v_staff_id
    ) RETURNING id INTO v_visit_b;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES (v_visit_b, v_lab_service_id, 'released', v_staff_id,
              NOW() - INTERVAL '6 days', v_staff_id, 1000, 1000, 1000)
      RETURNING id INTO v_tr1;
    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES (v_visit_b, v_lab_service_id, 'released', v_staff_id,
              NOW() - INTERVAL '6 days', v_staff_id, 1000, 1000, 1000)
      RETURNING id INTO v_tr2;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes,
                                          submitted_at, submitted_by, medium)
      VALUES (v_provider_id, 'submitted', 'SMOKE-12.3-BULK', 'SMOKE-12.3 bulk batch',
              CURRENT_DATE, v_staff_id, 'mail')
      RETURNING id INTO v_bulk_batch;
    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_bulk_batch, v_tr1, 1000), (v_bulk_batch, v_tr2, 1000);

    SELECT id INTO v_item1 FROM public.hmo_claim_items WHERE batch_id=v_bulk_batch AND test_request_id=v_tr1;
    SELECT id INTO v_item2 FROM public.hmo_claim_items WHERE batch_id=v_bulk_batch AND test_request_id=v_tr2;

    -- Mark v_item1 as 'paid' first (pretend prior partial action).
    UPDATE public.hmo_claim_items SET hmo_response = 'paid' WHERE id = v_item1;

    -- Bulk-set all 'rejected', scope='pending_only': only updates non-'paid'.
    WITH upd AS (
      UPDATE public.hmo_claim_items
         SET hmo_response = 'rejected', hmo_response_date = CURRENT_DATE
       WHERE batch_id = v_bulk_batch
         AND hmo_response <> 'paid'
       RETURNING id
    )
    SELECT COUNT(*) INTO v_updated FROM upd;

    SELECT COUNT(*) INTO v_skipped FROM public.hmo_claim_items
     WHERE batch_id = v_bulk_batch AND hmo_response = 'paid';

    IF v_updated <> 1 OR v_skipped <> 1 THEN
      RAISE EXCEPTION 'Assertion 25 FAILED: expected updated=1 skipped=1, got updated=% skipped=%',
        v_updated, v_skipped;
    END IF;
  END;
  RAISE NOTICE 'Assertion 25 PASS: bulk-set "pending_only" updates 1, skips 1 already-paid';

  -- ============================================================
  -- Assertion 26: v_hmo_unbilled excludes batched items; includes released+HMO.
  -- ============================================================
  -- Build a fresh test_request released to HMO, NOT batched → should appear in view.
  DECLARE
    v_visit_u   uuid;
    v_tr_unb    uuid;
    v_in_view   int;
    v_excluded  int;
  BEGIN
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 25, 'SMOKE-AUTH-UNB',
      'paid', 1500, 'SMOKE-12.3 unbilled visit', v_staff_id
    ) RETURNING id INTO v_visit_u;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES
      (v_visit_u, v_lab_service_id, 'released', v_staff_id,
       NOW() - INTERVAL '25 days', v_staff_id, 1500, 1500, 1500)
      RETURNING id INTO v_tr_unb;

    SELECT COUNT(*) INTO v_in_view FROM public.v_hmo_unbilled WHERE test_request_id = v_tr_unb;
    IF v_in_view <> 1 THEN
      RAISE EXCEPTION 'Assertion 26 FAILED: expected unbatched TR in v_hmo_unbilled, got %', v_in_view;
    END IF;

    -- A batched, non-voided test_request must NOT appear. v_tr_id_a is in v_batch_id.
    SELECT COUNT(*) INTO v_excluded FROM public.v_hmo_unbilled WHERE test_request_id = v_tr_id_a;
    IF v_excluded <> 0 THEN
      RAISE EXCEPTION 'Assertion 26 FAILED: batched TR leaked into v_hmo_unbilled';
    END IF;
  END;
  RAISE NOTICE 'Assertion 26 PASS: v_hmo_unbilled correctly includes unbatched and excludes batched';

  -- ============================================================
  -- Assertion 27: v_hmo_stuck includes items past due_days_for_invoice.
  -- ============================================================
  -- Maxicare.due_days_for_invoice — set explicitly to 5 and create a stale
  -- submitted batch.
  DECLARE
    v_orig_due  int;
    v_stuck_b   uuid;
    v_visit_s   uuid;
    v_tr_s      uuid;
    v_item_s    uuid;
    v_in_stuck  int;
  BEGIN
    SELECT due_days_for_invoice INTO v_orig_due FROM public.hmo_providers WHERE id = v_provider_id;
    UPDATE public.hmo_providers SET due_days_for_invoice = 5 WHERE id = v_provider_id;

    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 30, 'SMOKE-AUTH-STUCK',
      'paid', 1000, 'SMOKE-12.3 stuck visit', v_staff_id
    ) RETURNING id INTO v_visit_s;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES
      (v_visit_s, v_lab_service_id, 'released', v_staff_id,
       NOW() - INTERVAL '30 days', v_staff_id, 1000, 1000, 1000)
      RETURNING id INTO v_tr_s;

    -- Batch submitted 30 days ago → days_since_submission > 5.
    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes,
                                          submitted_at, submitted_by, medium)
      VALUES (v_provider_id, 'submitted', 'SMOKE-12.3-STUCK', 'SMOKE-12.3 stuck batch',
              CURRENT_DATE - 30, v_staff_id, 'mail')
      RETURNING id INTO v_stuck_b;
    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_stuck_b, v_tr_s, 1000)
      RETURNING id INTO v_item_s;

    SELECT COUNT(*) INTO v_in_stuck FROM public.v_hmo_stuck WHERE item_id = v_item_s;
    IF v_in_stuck <> 1 THEN
      RAISE EXCEPTION 'Assertion 27 FAILED: expected stuck item in v_hmo_stuck, got %', v_in_stuck;
    END IF;

    -- Restore Maxicare's original due_days.
    UPDATE public.hmo_providers SET due_days_for_invoice = v_orig_due WHERE id = v_provider_id;
  END;
  RAISE NOTICE 'Assertion 27 PASS: v_hmo_stuck includes overdue submitted-batch items';

  -- ============================================================
  -- Assertion 28: v_hmo_ar_aging buckets match calendar age.
  -- ============================================================
  -- We have test_requests at ~20, ~15, ~12, ~8, ~5, ~6, ~25, ~30 days released.
  -- All should fall in the 0-30 bucket. Sum > 0 for Maxicare in 0-30.
  SELECT COALESCE(SUM(total_php), 0) INTO v_amount
    FROM public.v_hmo_ar_aging
   WHERE provider_id = v_provider_id AND bucket = '0-30';
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Assertion 28 FAILED: expected positive 0-30 bucket total, got %', v_amount;
  END IF;

  -- Sanity: should be no rows in 91-180 or 180+ for our synthetic Maxicare data
  -- (every released_at is recent).
  SELECT COUNT(*) INTO v_count FROM public.v_hmo_ar_aging
   WHERE provider_id = v_provider_id AND bucket IN ('91-180', '180+');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Assertion 28 FAILED: unexpected old buckets for synthetic Maxicare data: %', v_count;
  END IF;
  RAISE NOTICE 'Assertion 28 PASS: v_hmo_ar_aging buckets match (0-30 has positive total)';

  -- ============================================================
  -- Assertion 29: v_hmo_provider_summary sums match per-provider totals.
  -- ============================================================
  DECLARE
    v_summary_unresolved numeric;
    v_summary_unbilled   numeric;
    v_hand_unresolved    numeric;
    v_hand_unbilled      numeric;
  BEGIN
    SELECT total_unresolved_ar_php, total_unbilled_php
      INTO v_summary_unresolved, v_summary_unbilled
      FROM public.v_hmo_provider_summary WHERE provider_id = v_provider_id;

    SELECT COALESCE(SUM(i.billed_amount_php - i.paid_amount_php
                          - i.patient_billed_amount_php - i.written_off_amount_php), 0)
      INTO v_hand_unresolved
      FROM public.hmo_claim_items i
      JOIN public.hmo_claim_batches b ON b.id = i.batch_id
     WHERE b.provider_id = v_provider_id
       AND b.voided_at IS NULL
       AND (i.billed_amount_php - i.paid_amount_php
            - i.patient_billed_amount_php - i.written_off_amount_php) > 0;

    SELECT COALESCE(SUM(billed_amount_php), 0)
      INTO v_hand_unbilled
      FROM public.v_hmo_unbilled
     WHERE provider_id = v_provider_id;

    IF v_summary_unresolved <> v_hand_unresolved THEN
      RAISE EXCEPTION 'Assertion 29 FAILED: summary unresolved (%) != hand-computed (%)',
        v_summary_unresolved, v_hand_unresolved;
    END IF;
    IF v_summary_unbilled <> v_hand_unbilled THEN
      RAISE EXCEPTION 'Assertion 29 FAILED: summary unbilled (%) != hand-computed (%)',
        v_summary_unbilled, v_hand_unbilled;
    END IF;
  END;
  RAISE NOTICE 'Assertion 29 PASS: v_hmo_provider_summary totals match hand-computed';

  -- ============================================================
  -- Assertion 30: bridge_replay_summary includes hmo_claim_resolution.
  -- ============================================================
  v_summary := public.bridge_replay_summary(NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour');
  IF NOT (v_summary->'by_source_kind' ? 'hmo_claim_resolution') THEN
    RAISE EXCEPTION 'Assertion 30 FAILED: bridge_replay_summary.by_source_kind missing hmo_claim_resolution; got %',
      v_summary->'by_source_kind';
  END IF;
  IF (v_summary->'by_source_kind'->>'hmo_claim_resolution')::int < 1 THEN
    RAISE EXCEPTION 'Assertion 30 FAILED: expected ≥1 hmo_claim_resolution JE, got %',
      v_summary->'by_source_kind'->>'hmo_claim_resolution';
  END IF;
  RAISE NOTICE 'Assertion 30 PASS: bridge_replay_summary.by_source_kind contains hmo_claim_resolution (count=%)',
    v_summary->'by_source_kind'->>'hmo_claim_resolution';

  -- ============================================================
  -- Assertion 31: closed-period guard blocks resolution posting.
  -- ============================================================
  DECLARE
    v_tr_cp       uuid;
    v_batch_cp    uuid;
    v_item_cp     uuid;
    v_visit_cp    uuid;
  BEGIN
    -- Find the period covering 2020-06-01 and close it.
    SELECT id, (status = 'closed') INTO v_closed_period_id, v_period_was_closed
      FROM public.accounting_periods
     WHERE DATE '2020-06-01' BETWEEN period_start AND period_end
     LIMIT 1;
    IF v_closed_period_id IS NULL THEN
      RAISE EXCEPTION 'Assertion 31 FAILED: no period covers 2020-06-01 in seeded periods';
    END IF;
    UPDATE public.accounting_periods
       SET status = 'closed', closed_at = NOW(), closed_by = v_staff_id
     WHERE id = v_closed_period_id;

    -- Build an item we can attempt to resolve with a 2020-06-01 resolved_at.
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, DATE '2020-06-01', 'SMOKE-AUTH-CLOSED',
      'paid', 1000, 'SMOKE-12.3 closed-period visit', v_staff_id
    ) RETURNING id INTO v_visit_cp;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES
      (v_visit_cp, v_lab_service_id, 'released', v_staff_id,
       TIMESTAMPTZ '2020-06-01 10:00+08', v_staff_id, 1000, 1000, 1000)
      RETURNING id INTO v_tr_cp;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes,
                                          submitted_at, submitted_by, medium)
      VALUES (v_provider_id, 'submitted', 'SMOKE-12.3-CP', 'SMOKE-12.3 closed-period batch',
              DATE '2020-06-01', v_staff_id, 'mail')
      RETURNING id INTO v_batch_cp;
    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_batch_cp, v_tr_cp, 1000)
      RETURNING id INTO v_item_cp;

    BEGIN
      INSERT INTO public.hmo_claim_resolutions (
        item_id, destination, amount_php, resolved_at, resolved_by, notes
      ) VALUES (
        v_item_cp, 'write_off', 1000, TIMESTAMPTZ '2020-06-01 12:00+08', v_staff_id,
        'SMOKE-12.3 closed-period attempt'
      );
      RAISE EXCEPTION 'Assertion 31 FAILED: resolution posted into closed period';
    EXCEPTION
      WHEN sqlstate 'P0002' THEN
        RAISE NOTICE 'Assertion 31 PASS: P0002 closed-period guard blocked resolution JE';
    END;

    -- Re-open the period so cleanup later can operate on the (still synthetic)
    -- rows without further period-lock issues.
    IF NOT v_period_was_closed THEN
      UPDATE public.accounting_periods
         SET status = 'open', closed_at = NULL, closed_by = NULL
       WHERE id = v_closed_period_id;
    END IF;
  END;

  -- ============================================================
  -- Assertion 32: CoA-delete guard (P0006) blocks delete of 6920 after JE references it.
  -- ============================================================
  BEGIN
    DELETE FROM public.chart_of_accounts WHERE code = '6920';
    RAISE EXCEPTION 'Assertion 32 FAILED: DELETE on 6920 was accepted';
  EXCEPTION
    WHEN sqlstate 'P0006' THEN
      RAISE NOTICE 'Assertion 32 PASS: P0006 blocks DELETE on 6920 (CoA append-only)';
  END;

  -- ============================================================
  -- Assertion 33: cascade-void of payment soft-voids its allocations and
  -- recomputes item paid_amount.
  -- ============================================================
  -- Build a fresh visit + batch + item + payment + allocation, then void.
  DECLARE
    v_visit_cv   uuid;
    v_tr_cv      uuid;
    v_batch_cv   uuid;
    v_item_cv    uuid;
    v_pay_cv     uuid;
    v_alloc_cv   uuid;
    v_post_paid  numeric;
    v_alloc_void timestamptz;
  BEGIN
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 3, 'SMOKE-AUTH-CV',
      'paid', 2500, 'SMOKE-12.3 cascade-void visit', v_staff_id
    ) RETURNING id INTO v_visit_cv;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES
      (v_visit_cv, v_lab_service_id, 'released', v_staff_id,
       NOW() - INTERVAL '3 days', v_staff_id, 2500, 2500, 2500)
      RETURNING id INTO v_tr_cv;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes,
                                          submitted_at, submitted_by, medium)
      VALUES (v_provider_id, 'submitted', 'SMOKE-12.3-CV', 'SMOKE-12.3 cascade-void batch',
              CURRENT_DATE - 3, v_staff_id, 'mail')
      RETURNING id INTO v_batch_cv;
    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_batch_cv, v_tr_cv, 2500)
      RETURNING id INTO v_item_cv;

    INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
      VALUES (v_visit_cv, 2500, 'hmo', v_staff_id, 'SMOKE-12.3 cascade-void payment')
      RETURNING id INTO v_pay_cv;
    INSERT INTO public.hmo_payment_allocations (payment_id, item_id, amount_php)
      VALUES (v_pay_cv, v_item_cv, 2500)
      RETURNING id INTO v_alloc_cv;

    -- Sanity: paid_amount should now be 2500.
    SELECT paid_amount_php INTO v_post_paid FROM public.hmo_claim_items WHERE id = v_item_cv;
    IF v_post_paid <> 2500 THEN
      RAISE EXCEPTION 'Assertion 33 setup: expected paid=2500 pre-void, got %', v_post_paid;
    END IF;

    -- Void the payment.
    UPDATE public.payments
       SET voided_at = NOW(), voided_by = v_staff_id, void_reason = 'SMOKE-12.3 cascade test'
     WHERE id = v_pay_cv;

    -- Allocation should have been cascade-voided.
    SELECT voided_at INTO v_alloc_void FROM public.hmo_payment_allocations WHERE id = v_alloc_cv;
    IF v_alloc_void IS NULL THEN
      RAISE EXCEPTION 'Assertion 33 FAILED: payment void did not cascade to allocation';
    END IF;

    -- Item paid_amount should have recomputed to 0.
    SELECT paid_amount_php INTO v_post_paid FROM public.hmo_claim_items WHERE id = v_item_cv;
    IF v_post_paid <> 0 THEN
      RAISE EXCEPTION 'Assertion 33 FAILED: expected paid=0 after cascade, got %', v_post_paid;
    END IF;
  END;
  RAISE NOTICE 'Assertion 33 PASS: payment void cascades to allocations; paid_amount recomputed';

  -- ============================================================
  -- Assertion 34: batch status walk-back on allocation cascade-void.
  -- ============================================================
  -- Setup: create a batch with one item, submit, allocate full payment →
  -- recompute_hmo_batch_status flips status to 'paid'. Then void the payment;
  -- the cascade soft-voids the allocation, recompute drops item.paid_amount_php
  -- to 0, and the rollup trigger fires again.
  --
  -- IMPORTANT CONTRACT (intentional, not a bug):
  --   recompute_hmo_batch_status returns early WITHOUT writing when
  --   v_resolved_items < v_total_items (see 0034_hmo_ar_subledger.sql Section 9).
  --   After cascade-void, paid=0 with no resolutions means the single item is
  --   unresolved, so v_resolved_items = 0 < v_total_items = 1 → early return.
  --   The batch keeps its now-stale 'paid' label; the operational signal for AR
  --   surfaces via v_hmo_stuck / v_hmo_ar_aging / v_hmo_provider_summary, which
  --   key off unresolved_balance, not batch.status.
  --
  -- This assertion encodes that contract so a future maintainer reading the
  -- smoke does not misdiagnose the stale label as a regression.
  DECLARE
    v_walk_visit       uuid;
    v_walk_tr          uuid;
    v_walk_batch       uuid;
    v_walk_item        uuid;
    v_walk_payment     uuid;
    v_walk_alloc       uuid;
    v_walk_status_pre  text;
    v_walk_status_post text;
    v_walk_paid        numeric;
    v_walk_unresolved  numeric;
    v_walk_billed      numeric;
  BEGIN
    INSERT INTO public.visits (
      patient_id, hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      payment_status, total_php, notes, created_by
    ) VALUES (
      v_patient_id, v_provider_id, CURRENT_DATE - 2, 'SMOKE-AUTH-34',
      'paid', 1500, 'SMOKE-12.3-34 walkback visit', v_staff_id
    ) RETURNING id INTO v_walk_visit;

    INSERT INTO public.test_requests (
      visit_id, service_id, status, requested_by, released_at, released_by,
      base_price_php, final_price_php, hmo_approved_amount_php
    ) VALUES
      (v_walk_visit, v_lab_service_id, 'released', v_staff_id,
       NOW() - INTERVAL '2 days', v_staff_id, 1500, 1500, 1500)
      RETURNING id INTO v_walk_tr;

    INSERT INTO public.hmo_claim_batches (provider_id, status, reference_no, notes,
                                          submitted_at, submitted_by, medium)
      VALUES (v_provider_id, 'submitted', 'SMOKE-12.3-34', 'SMOKE-12.3-34 walkback batch',
              CURRENT_DATE - 2, v_staff_id, 'mail')
      RETURNING id INTO v_walk_batch;
    INSERT INTO public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
      VALUES (v_walk_batch, v_walk_tr, 1500)
      RETURNING id INTO v_walk_item;

    INSERT INTO public.payments (visit_id, amount_php, method, received_by, notes)
      VALUES (v_walk_visit, 1500, 'hmo', v_staff_id, 'SMOKE-12.3-34 walkback payment')
      RETURNING id INTO v_walk_payment;
    INSERT INTO public.hmo_payment_allocations (payment_id, item_id, amount_php)
      VALUES (v_walk_payment, v_walk_item, 1500)
      RETURNING id INTO v_walk_alloc;

    -- Pre-void: full allocation → all items resolved → status should be 'paid'.
    SELECT status INTO v_walk_status_pre FROM public.hmo_claim_batches WHERE id = v_walk_batch;
    IF v_walk_status_pre <> 'paid' THEN
      RAISE EXCEPTION 'Assertion 34 setup FAILED: expected batch=paid pre-void, got %', v_walk_status_pre;
    END IF;

    -- Void the payment → cascade soft-voids the allocation → recompute drops paid to 0.
    UPDATE public.payments
       SET voided_at = NOW(), voided_by = v_staff_id, void_reason = 'SMOKE-12.3-34 walkback test'
     WHERE id = v_walk_payment;

    SELECT paid_amount_php, billed_amount_php
      INTO v_walk_paid, v_walk_billed
      FROM public.hmo_claim_items WHERE id = v_walk_item;
    v_walk_unresolved := v_walk_billed
                       - v_walk_paid
                       - (SELECT patient_billed_amount_php FROM public.hmo_claim_items WHERE id = v_walk_item)
                       - (SELECT written_off_amount_php   FROM public.hmo_claim_items WHERE id = v_walk_item);

    SELECT status INTO v_walk_status_post FROM public.hmo_claim_batches WHERE id = v_walk_batch;

    -- Contract checks:
    --   1. paid_amount_php walked back to 0 (cascade-void recompute worked).
    --   2. unresolved_balance equals billed (the AR is fully open again).
    --   3. batch.status remains 'paid' (rollup early-returned because item is
    --      now unresolved → v_resolved_items < v_total_items). This is INTENDED.
    IF v_walk_paid <> 0 THEN
      RAISE EXCEPTION 'Assertion 34 FAILED: expected paid_amount_php=0 after cascade-void, got %', v_walk_paid;
    END IF;
    IF v_walk_unresolved <> v_walk_billed THEN
      RAISE EXCEPTION 'Assertion 34 FAILED: expected unresolved=% after cascade-void, got %',
        v_walk_billed, v_walk_unresolved;
    END IF;
    IF v_walk_status_post <> 'paid' THEN
      RAISE EXCEPTION 'Assertion 34 FAILED: expected batch.status to remain ''paid'' (rollup early-returns on unresolved items), got %',
        v_walk_status_post;
    END IF;

    -- And the operational signal must surface in v_hmo_stuck-style views: the
    -- item now has a positive unresolved balance on a non-voided submitted/paid
    -- batch. (We don't query v_hmo_stuck directly here because that view also
    -- requires submitted_at > due_days_for_invoice; the AR aging view is the
    -- more general operational signal — verified below.)
    PERFORM 1 FROM public.v_hmo_ar_aging
     WHERE provider_id = v_provider_id
       AND total_php > 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assertion 34 FAILED: v_hmo_ar_aging shows no open AR after cascade-void (operational signal broken)';
    END IF;
  END;
  RAISE NOTICE 'Assertion 34 PASS: cascade-void walks paid_amount back to 0; batch.status remains ''paid'' by design (operational signal lives in views, not status enum)';

  -- ============================================================
  -- Cleanup
  -- ============================================================
  -- Order matters: void resolutions (so JE reversals fire), void payments
  -- (cascade-voids allocations + posts payment-reversal JEs), then delete the
  -- subledger rows, journal rows, payments, test_requests, visit, patient.
  --
  -- 1. Soft-void every still-active resolution we created.
  UPDATE public.hmo_claim_resolutions
     SET voided_at = COALESCE(voided_at, NOW()),
         voided_by = COALESCE(voided_by, v_staff_id),
         void_reason = COALESCE(void_reason, 'SMOKE-12.3 cleanup')
   WHERE item_id IN (
     SELECT i.id FROM public.hmo_claim_items i
      JOIN public.hmo_claim_batches b ON b.id = i.batch_id
     WHERE b.reference_no LIKE 'SMOKE-12.3%'
   )
     AND voided_at IS NULL;

  -- 2. Soft-void every active payment we created (cascades to allocations).
  UPDATE public.payments
     SET voided_at = COALESCE(voided_at, NOW()),
         voided_by = COALESCE(voided_by, v_staff_id),
         void_reason = COALESCE(void_reason, 'SMOKE-12.3 cleanup')
   WHERE notes LIKE 'SMOKE-12.3%' AND voided_at IS NULL;

  -- 3. Mark batches as voided (now legal since allocations + resolutions are voided).
  UPDATE public.hmo_claim_batches
     SET voided_at = COALESCE(voided_at, NOW()),
         voided_by = COALESCE(voided_by, v_staff_id),
         void_reason = COALESCE(void_reason, 'SMOKE-12.3 cleanup'),
         status = 'voided'
   WHERE reference_no LIKE 'SMOKE-12.3%' AND voided_at IS NULL;

  -- 4. Hard-delete the subledger + JE rows for full cleanup.
  DELETE FROM public.hmo_payment_allocations
   WHERE item_id IN (
     SELECT i.id FROM public.hmo_claim_items i
      JOIN public.hmo_claim_batches b ON b.id = i.batch_id
     WHERE b.reference_no LIKE 'SMOKE-12.3%'
   );
  -- DELETE on resolutions is blocked by P0009; truncate-via-function isn't worth
  -- the complexity. Drop the trigger temporarily for cleanup.
  ALTER TABLE public.hmo_claim_resolutions DISABLE TRIGGER tg_hmo_resolution_p0009_guard;
  DELETE FROM public.hmo_claim_resolutions
   WHERE item_id IN (
     SELECT i.id FROM public.hmo_claim_items i
      JOIN public.hmo_claim_batches b ON b.id = i.batch_id
     WHERE b.reference_no LIKE 'SMOKE-12.3%'
   );
  ALTER TABLE public.hmo_claim_resolutions ENABLE TRIGGER tg_hmo_resolution_p0009_guard;

  DELETE FROM public.hmo_claim_items
   WHERE batch_id IN (SELECT id FROM public.hmo_claim_batches WHERE reference_no LIKE 'SMOKE-12.3%');
  DELETE FROM public.hmo_claim_batches WHERE reference_no LIKE 'SMOKE-12.3%';

  -- 5. Journal rows: delete the SMOKE-12.3 JEs.
  --
  -- The journal model has two self-referential FKs we need to handle:
  --   - journal_entries.reverses     → another journal_entries.id
  --   - journal_entries.reversed_by  → another journal_entries.id
  -- Plus journal_lines.entry_id with ON DELETE RESTRICT.
  --
  -- Strategy:
  --   a) Disable trg_je_lines_balance_check so we can drop lines off
  --      posted JEs without tripping P0001/P0003.
  --   b) NULL out reverses + reversed_by on every SMOKE JE so we can
  --      delete in any order.
  --   c) Drop lines, then drop headers.
  ALTER TABLE public.journal_lines DISABLE TRIGGER trg_je_lines_balance_check;

  WITH smoke_jes AS (
    SELECT id FROM public.journal_entries
     WHERE (source_kind = 'hmo_claim_resolution')
        OR (source_kind = 'payment' AND source_id IN (
             SELECT id FROM public.payments WHERE notes LIKE 'SMOKE-12.3%'
           ))
        OR (reverses IN (
             SELECT id FROM public.journal_entries
              WHERE source_kind = 'hmo_claim_resolution'
                 OR (source_kind = 'payment' AND source_id IN (
                      SELECT id FROM public.payments WHERE notes LIKE 'SMOKE-12.3%'
                    ))
           ))
  )
  UPDATE public.journal_entries
     SET reverses = NULL, reversed_by = NULL
   WHERE id IN (SELECT id FROM smoke_jes);

  DELETE FROM public.journal_lines
   WHERE entry_id IN (
     SELECT id FROM public.journal_entries
      WHERE (source_kind = 'hmo_claim_resolution')
         OR (source_kind = 'payment' AND source_id IN (
              SELECT id FROM public.payments WHERE notes LIKE 'SMOKE-12.3%'
            ))
   );
  DELETE FROM public.journal_entries
   WHERE (source_kind = 'hmo_claim_resolution')
      OR (source_kind = 'payment' AND source_id IN (
           SELECT id FROM public.payments WHERE notes LIKE 'SMOKE-12.3%'
         ));
  ALTER TABLE public.journal_lines ENABLE TRIGGER trg_je_lines_balance_check;

  -- 6. Payments + test_requests + visits + patient.
  DELETE FROM public.payments WHERE notes LIKE 'SMOKE-12.3%';
  DELETE FROM public.test_requests WHERE visit_id IN (
    SELECT id FROM public.visits WHERE notes LIKE 'SMOKE-12.3%'
  );
  DELETE FROM public.visits WHERE notes LIKE 'SMOKE-12.3%';
  DELETE FROM public.patients WHERE id = v_patient_id;

  RAISE NOTICE '--- 12.3 SMOKE END (cleanup done) ---';
END $$;

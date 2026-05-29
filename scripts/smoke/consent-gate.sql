-- scripts/smoke/consent-gate.sql
-- Self-seeding, self-cleaning smoke test for patient consent gate + sync trigger.
-- Everything is wrapped in BEGIN/ROLLBACK — leaves NO residue in the DB.
--
-- Steps proved:
--   A. Gate OFF (default):  gate_required=false + no consent → release SUCCEEDS
--   B. Gate ON + no consent: gate_required=true → release RAISES "consent" error
--   C. Grant → sync:        patient_consents INSERT flips consent_current to true
--   D. Gate ON + consent:   release SUCCEEDS
--   E. Withdraw → re-block: patient_consents withdraw flips consent_current=false,
--                           sets consent_withdrawn_at
--   F. (documented, not executed) Backfill bypass: INSERTing a row with
--      status='released' does NOT fire the BEFORE UPDATE consent gate (INSERT ≠
--      UPDATE). This is intentional — historical backfill must be able to land
--      already-released rows without triggering the gate.
--
-- Run:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=0 < scripts/smoke/consent-gate.sql
-- OR (from host with psql available):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=0 -f scripts/smoke/consent-gate.sql

\echo ''
\echo '== consent-gate smoke: START =='
\echo ''

BEGIN;

SET search_path = public, pg_temp;

-- ============================================================
-- SEED: create throwaway patient, visit, test_request
-- ============================================================

-- Grab a real service_id and auth user id (both required as FKs / NOT NULL).
-- These rows are read-only; we do NOT insert into services or auth.users.
DO $$
DECLARE
  v_service_id uuid;
  v_user_id    uuid;
BEGIN
  SELECT id INTO v_service_id
  FROM public.services
  WHERE kind = 'lab_test' AND is_send_out = false
  LIMIT 1;

  SELECT id INTO v_user_id FROM auth.users LIMIT 1;

  IF v_service_id IS NULL THEN
    RAISE EXCEPTION 'SEED: no lab_test non-send-out service found — seed the DB before running this smoke';
  END IF;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'SEED: no rows in auth.users — seed the DB before running this smoke';
  END IF;
END $$;

-- ============================================================
-- MAIN TEST BLOCK
-- (single DO block so temp variables survive across all steps)
-- ============================================================
DO $$
DECLARE
  v_patient_id  uuid;
  v_visit_id    uuid;
  v_tr_id       uuid;
  v_service_id  uuid;
  v_user_id     uuid;
  v_consent_now boolean;
  v_withdrawn   timestamptz;
  v_raised      boolean;
BEGIN

  -- ------------------------------------------------------------------
  -- Grab seed references
  -- Pick a lab_test + non-send-out service so the accounting bridge trigger
  -- (trg_bridge_test_request_released) generates a simple DR 1100 / CR 4100
  -- JE (no doctor PF logic, no COGS) which posts cleanly with our fixed price.
  -- ------------------------------------------------------------------
  SELECT id INTO v_service_id
  FROM public.services
  WHERE kind = 'lab_test' AND is_send_out = false
  LIMIT 1;

  SELECT id INTO v_user_id FROM auth.users LIMIT 1;

  -- ------------------------------------------------------------------
  -- Insert throwaway patient (consent_current stays false by default)
  -- ------------------------------------------------------------------
  INSERT INTO public.patients (first_name, last_name, birthdate)
  VALUES ('_Smoke', '_ConsentGate', '1990-01-01')
  RETURNING id INTO v_patient_id;

  -- ------------------------------------------------------------------
  -- Insert a PAID visit for that patient
  -- ------------------------------------------------------------------
  INSERT INTO public.visits (patient_id, payment_status)
  VALUES (v_patient_id, 'paid')
  RETURNING id INTO v_visit_id;

  -- ------------------------------------------------------------------
  -- Insert a test_request in ready_for_release state.
  -- We must supply final_price_php = base_price_php (and no discount) so
  -- the accounting bridge trigger (trg_bridge_test_request_released) can
  -- create a balanced JE (DR 1100 / CR 4100) when we release in steps A
  -- and D.  Without pricing, the JE gets no lines and je_status_balance_check
  -- raises "has no lines after this operation", which would mask the
  -- consent-gate result.
  -- (bypass default 'requested' by direct INSERT with explicit status)
  -- ------------------------------------------------------------------
  INSERT INTO public.test_requests (
    visit_id, service_id, requested_by, status,
    base_price_php, final_price_php
  )
  VALUES (v_visit_id, v_service_id, v_user_id, 'ready_for_release', 250.00, 250.00)
  RETURNING id INTO v_tr_id;

  RAISE NOTICE 'SEED: patient=% visit=% tr=%', v_patient_id, v_visit_id, v_tr_id;

  -- ==================================================================
  -- A: Gate OFF (gate_required=false, default) — release MUST succeed
  -- ==================================================================
  UPDATE public.consent_settings SET gate_required = false WHERE id = true;

  BEGIN
    UPDATE public.test_requests SET status = 'released' WHERE id = v_tr_id;
    RAISE NOTICE 'A PASS: release succeeded with gate_required=false and no consent';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'A FAIL: unexpected error — %', SQLERRM;
  END;

  -- Reset status back for subsequent steps
  UPDATE public.test_requests SET status = 'ready_for_release' WHERE id = v_tr_id;

  -- ==================================================================
  -- B: Gate ON + no consent — release MUST raise a "consent" error
  -- ==================================================================
  UPDATE public.consent_settings SET gate_required = true WHERE id = true;

  v_raised := false;
  BEGIN
    UPDATE public.test_requests SET status = 'released' WHERE id = v_tr_id;
    -- If we reach here, the gate did NOT fire — that is a failure.
    RAISE NOTICE 'B FAIL: release succeeded but should have been blocked (consent gate did not fire)';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM ILIKE '%consent%' THEN
      RAISE NOTICE 'B PASS: caught check_violation with "consent" in message — "%"', SQLERRM;
      v_raised := true;
    ELSE
      RAISE NOTICE 'B FAIL: check_violation raised but message did not contain "consent" — "%"', SQLERRM;
    END IF;
  WHEN OTHERS THEN
    RAISE NOTICE 'B FAIL: wrong exception class (%) — %', SQLSTATE, SQLERRM;
  END;

  IF NOT v_raised THEN
    RAISE NOTICE 'B FAIL: no exception was raised';
  END IF;

  -- status should still be ready_for_release (blocked update never committed inside txn)
  -- confirm no status drift:
  PERFORM 1 FROM public.test_requests WHERE id = v_tr_id AND status = 'ready_for_release';
  IF NOT FOUND THEN
    RAISE NOTICE 'B WARN: test_request status unexpectedly changed after blocked update';
  END IF;

  -- ==================================================================
  -- C: Grant → sync — INSERT granted row → consent_current must be true
  --
  -- Explicit created_at anchors this event in time so the subsequent
  -- withdraw (step E) can use now() + interval '1 second' without ambiguity.
  -- ==================================================================
  INSERT INTO public.patient_consents (
    patient_id, event_type, method, notice_version, signatory, actor_kind, created_at
  ) VALUES (
    v_patient_id, 'granted', 'paper_wet_signature', 'v1', 'self', 'staff',
    now() - interval '1 second'
  );

  SELECT consent_current INTO v_consent_now
  FROM public.patients WHERE id = v_patient_id;

  IF v_consent_now = true THEN
    RAISE NOTICE 'C PASS: consent_current=true after granted insert (sync trigger fired correctly)';
  ELSE
    RAISE NOTICE 'C FAIL: consent_current=% (expected true)', v_consent_now;
  END IF;

  -- ==================================================================
  -- D: Gate ON + consent present — release MUST succeed
  -- ==================================================================
  BEGIN
    UPDATE public.test_requests SET status = 'released' WHERE id = v_tr_id;
    RAISE NOTICE 'D PASS: release succeeded with gate_required=true and consent_current=true';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'D FAIL: unexpected error — %', SQLERRM;
  END;

  -- Reset for step E
  UPDATE public.test_requests SET status = 'ready_for_release' WHERE id = v_tr_id;

  -- ==================================================================
  -- E: Withdraw → re-block
  --    INSERT withdrawn row → consent_current=false, consent_withdrawn_at set
  --    Then confirm release is blocked again
  --
  -- NOTE on created_at ordering: the sync trigger resolves the "latest" event
  -- by (created_at DESC, id DESC).  Within a single transaction, now() returns
  -- the same timestamp for every statement, so two rapid INSERTs (grant, then
  -- withdraw) would tie on created_at and the UUID tiebreak is random.
  -- We avoid this by supplying an explicit created_at for the withdraw that is
  -- strictly after the grant (+ 1 second).  The real application always calls
  -- these from separate HTTP requests, so timestamps naturally differ.
  -- ==================================================================
  INSERT INTO public.patient_consents (
    patient_id, event_type, actor_kind, reason, created_at
  ) VALUES (
    v_patient_id, 'withdrawn', 'patient', 'patient requested withdrawal',
    now() + interval '1 second'
  );

  SELECT consent_current, consent_withdrawn_at
  INTO v_consent_now, v_withdrawn
  FROM public.patients WHERE id = v_patient_id;

  IF v_consent_now = false THEN
    RAISE NOTICE 'E PASS (consent_current): consent_current=false after withdrawal';
  ELSE
    RAISE NOTICE 'E FAIL (consent_current): consent_current=% (expected false)', v_consent_now;
  END IF;

  IF v_withdrawn IS NOT NULL THEN
    RAISE NOTICE 'E PASS (consent_withdrawn_at): consent_withdrawn_at=% (not null)', v_withdrawn;
  ELSE
    RAISE NOTICE 'E FAIL (consent_withdrawn_at): consent_withdrawn_at is NULL (expected timestamp)';
  END IF;

  -- Confirm the gate blocks release again after withdrawal
  v_raised := false;
  BEGIN
    UPDATE public.test_requests SET status = 'released' WHERE id = v_tr_id;
    RAISE NOTICE 'E FAIL (re-block): release succeeded but should have been blocked after withdrawal';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM ILIKE '%consent%' THEN
      RAISE NOTICE 'E PASS (re-block): gate correctly re-blocked after withdrawal — "%"', SQLERRM;
      v_raised := true;
    ELSE
      RAISE NOTICE 'E FAIL (re-block): check_violation but wrong message — "%"', SQLERRM;
    END IF;
  WHEN OTHERS THEN
    RAISE NOTICE 'E FAIL (re-block): wrong exception (%) — %', SQLSTATE, SQLERRM;
  END;

  -- ==================================================================
  -- Restore consent_settings to default (gate_required=false)
  -- (the ROLLBACK below will undo this anyway, but be explicit)
  -- ==================================================================
  UPDATE public.consent_settings SET gate_required = false WHERE id = true;

  RAISE NOTICE '';
  RAISE NOTICE '== All steps executed — see PASS/FAIL lines above ==';

END $$;

-- ============================================================
-- ROLLBACK — leaves NO residue
-- ============================================================
ROLLBACK;

\echo ''
\echo '== consent-gate smoke: END (transaction rolled back — no residue) =='
\echo ''

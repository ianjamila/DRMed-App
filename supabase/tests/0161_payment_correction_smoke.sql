-- =============================================================================
-- 0161_payment_correction_smoke.sql
-- =============================================================================
-- Proves correct_payment (0161) — Edit and Move a payment as ONE
-- re-create-then-void — and every refusal it owns:
--
--   A  amount edit        → new row (same received_at/by, corrects_payment_id),
--                           original voided 'Edited: …', its JE reversed, the
--                           visit's paid total follows
--   B  reference-only     → edited in place, same id, no new row, no void
--   C  nothing changed    → P0054
--   D  edit a voided row  → P0054 (the original of A)
--   E  method change      → cash → gcash re-creates as gcash
--   F  MOVE a legacy bpi  → succeeds and STAYS bpi (the method is only checked
--      method payment       when it changes); original voided 'Moved: …'; both
--                           visits' paid totals follow
--   G  change TO bpi      → P0054 (the counter no longer offers it)
--   H  null method        → P0054
--   I  move to a deleted visit → P0054; to a missing visit → P0054
--   J  HMO payment        → P0054;  K  legacy-import payment → P0054
--   L  no reason / no actor → P0054
--   M  ACL                → service_role only
--
-- Run it against the LOCAL stack, not prod:
--   supabase db reset && psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -f supabase/tests/0161_payment_correction_smoke.sql
--
-- It runs inside BEGIN/ROLLBACK, so nothing survives. Self-seeding: it needs
-- only the chart of accounts from the migrations.
-- =============================================================================

begin;

do $$
declare
  v_actor    uuid;
  v_patient  uuid;
  v_visit1   uuid;
  v_visit2   uuid;
  v_visit3   uuid;
  v_hmo_visit uuid;
  v_hmo      uuid;
  v_run      uuid;
  v_p1       uuid;
  v_p1b      uuid;
  v_p2       uuid;
  v_p2b      uuid;
  v_bpi      uuid;
  v_bpi2     uuid;
  v_hmo_pay  uuid;
  v_legacy   uuid;
  v_id       uuid;
  v_row      public.payments%rowtype;
  v_orig     public.payments%rowtype;
  v_je       uuid;
  v_n        int;
  v_paid     numeric;
  v_at       timestamptz := now() - interval '1 hour';

begin
  -- ---- setup -------------------------------------------------------------
  v_actor := gen_random_uuid();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values (v_actor, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'smoke-0161@example.test', '', now(), now(), now());
  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_actor, 'SMOKE 0161 Reception', 'admin', true);

  insert into public.patients (drm_id, first_name, last_name, birthdate)
  values ('SMOKE-0161', 'Smoke', 'Patient', '1990-01-01')
  returning id into v_patient;

  insert into public.visits (patient_id, total_php, payment_status)
  values (v_patient, 1000, 'unpaid') returning id into v_visit1;
  insert into public.visits (patient_id, total_php, payment_status)
  values (v_patient, 1000, 'unpaid') returning id into v_visit2;
  insert into public.visits (patient_id, total_php, payment_status)
  values (v_patient, 1000, 'unpaid') returning id into v_visit3;

  insert into public.hmo_providers (name) values ('SMOKE 0161 HMO') returning id into v_hmo;
  insert into public.visits (patient_id, total_php, payment_status, hmo_provider_id)
  values (v_patient, 800, 'unpaid', v_hmo) returning id into v_hmo_visit;

  insert into public.payments (visit_id, amount_php, method, reference_number,
                               received_by, received_at)
  values (v_visit1, 500, 'cash', null, v_actor, v_at) returning id into v_p1;

  -- ---- A: amount edit ------------------------------------------------------
  v_p1b := public.correct_payment(v_p1, 450, 'cash', null, null, 'keyed 500', v_actor);
  if v_p1b = v_p1 then raise exception 'A FAIL: amount edit did not re-create'; end if;

  select * into v_row  from public.payments where id = v_p1b;
  select * into v_orig from public.payments where id = v_p1;
  if v_row.amount_php <> 450 or v_row.method <> 'cash' or v_row.visit_id <> v_visit1 then
    raise exception 'A FAIL: corrected row is % % on %', v_row.amount_php, v_row.method, v_row.visit_id;
  end if;
  if v_row.corrects_payment_id is distinct from v_p1 then
    raise exception 'A FAIL: corrects_payment_id not set';
  end if;
  if v_row.received_at <> v_at or v_row.received_by <> v_actor then
    raise exception 'A FAIL: corrected row did not keep received_at/received_by';
  end if;
  if v_orig.voided_at is null or v_orig.voided_by <> v_actor
     or v_orig.void_reason <> 'Edited: keyed 500' then
    raise exception 'A FAIL: original not voided as Edited (reason %)', v_orig.void_reason;
  end if;

  select id into v_je from public.journal_entries
   where source_kind = 'payment' and source_id = v_p1;
  if v_je is null then raise exception 'A FAIL: original has no JE'; end if;
  -- The void flips the original JE to reversed (0030) ...
  if (select status from public.journal_entries where id = v_je) <> 'reversed' then
    raise exception 'A FAIL: original JE is not reversed';
  end if;
  -- ... and posts a reversal carrying source_id NULL and reverses = the original JE.
  select count(*) into v_n from public.journal_entries where reverses = v_je;
  if v_n <> 1 then raise exception 'A FAIL: % reversal JEs for the original, expected 1', v_n; end if;
  select count(*) into v_n from public.journal_entries
   where source_kind = 'payment' and source_id = v_p1b and status = 'posted';
  if v_n <> 1 then raise exception 'A FAIL: corrected row has % posted JEs', v_n; end if;

  select paid_php into v_paid from public.visits where id = v_visit1;
  if v_paid <> 450 then raise exception 'A FAIL: visit paid_php is %, expected 450', v_paid; end if;
  raise notice 'PASS A: amount edit re-creates, voids, reverses, recalcs';

  -- ---- B: reference-only edit is in place -------------------------------
  v_id := public.correct_payment(v_p1b, 450, 'cash', ' OR-123 ', 'note', 'add OR', v_actor);
  if v_id <> v_p1b then raise exception 'B FAIL: reference edit re-created the row'; end if;
  select * into v_row from public.payments where id = v_p1b;
  if v_row.reference_number <> 'OR-123' or v_row.notes <> 'note' or v_row.voided_at is not null then
    raise exception 'B FAIL: in-place edit wrote % / % (voided %)',
      v_row.reference_number, v_row.notes, v_row.voided_at;
  end if;
  select count(*) into v_n from public.payments where visit_id = v_visit1;
  if v_n <> 2 then raise exception 'B FAIL: % payments on visit 1, expected 2', v_n; end if;
  raise notice 'PASS B: reference/notes edit is in place';

  -- ---- C: nothing changed ------------------------------------------------
  begin
    perform public.correct_payment(v_p1b, 450, 'cash', 'OR-123', 'note', 'again', v_actor);
    raise exception 'C FAIL: expected P0054, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS C: nothing changed → P0054';
  end;

  -- ---- D: editing the voided original ------------------------------------
  begin
    perform public.correct_payment(v_p1, 400, 'cash', null, null, 'again', v_actor);
    raise exception 'D FAIL: expected P0054, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS D: voided original → P0054';
  end;

  -- ---- E: method change ---------------------------------------------------
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
  values (v_visit3, 200, 'cash', v_actor, v_at) returning id into v_p2;
  v_p2b := public.correct_payment(v_p2, 200, 'gcash', 'GC-1', null, 'was GCash', v_actor);
  select * into v_row from public.payments where id = v_p2b;
  if v_p2b = v_p2 or v_row.method <> 'gcash' then
    raise exception 'E FAIL: method change gave % (same id %)', v_row.method, v_p2b = v_p2;
  end if;
  raise notice 'PASS E: cash → gcash re-creates';

  -- ---- F: Move a bpi payment, method stays bpi ----------------------------
  insert into public.payments (visit_id, amount_php, method, reference_number,
                               received_by, received_at)
  values (v_visit1, 300, 'bpi', 'BPI-9', v_actor, v_at) returning id into v_bpi;
  v_bpi2 := public.correct_payment(v_bpi, 300, 'bpi', 'BPI-9', null, 'wrong visit',
                                   v_actor, v_visit2);
  select * into v_row  from public.payments where id = v_bpi2;
  select * into v_orig from public.payments where id = v_bpi;
  if v_bpi2 = v_bpi or v_row.visit_id <> v_visit2 or v_row.method <> 'bpi'
     or v_row.amount_php <> 300 or v_row.reference_number <> 'BPI-9' then
    raise exception 'F FAIL: moved row is % % on %', v_row.amount_php, v_row.method, v_row.visit_id;
  end if;
  if v_orig.void_reason <> 'Moved: wrong visit' then
    raise exception 'F FAIL: original void_reason is %', v_orig.void_reason;
  end if;
  select paid_php into v_paid from public.visits where id = v_visit1;
  if v_paid <> 450 then raise exception 'F FAIL: source visit paid_php is %, expected 450', v_paid; end if;
  select paid_php into v_paid from public.visits where id = v_visit2;
  if v_paid <> 300 then raise exception 'F FAIL: target visit paid_php is %, expected 300', v_paid; end if;
  raise notice 'PASS F: bpi payment moved, stays bpi, both visits recalc';

  -- ---- G: changing TO a retired method ------------------------------------
  begin
    perform public.correct_payment(v_p2b, 200, 'bpi', 'GC-1', null, 'x', v_actor);
    raise exception 'G FAIL: expected P0054, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS G: change to bpi → P0054';
  end;

  -- ---- H: null method -------------------------------------------------------
  begin
    perform public.correct_payment(v_p2b, 150, null, null, null, 'x', v_actor);
    raise exception 'H FAIL: expected P0054, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS H: null method → P0054';
  end;

  -- ---- I: move to a deleted / missing visit ------------------------------
  insert into public.visits (patient_id, total_php, payment_status, deleted_at, deleted_by, delete_reason)
  values (v_patient, 100, 'unpaid', now(), v_actor, 'smoke') returning id into v_id;
  begin
    perform public.correct_payment(v_p2b, 200, 'gcash', 'GC-1', null, 'x', v_actor, v_id);
    raise exception 'I FAIL: expected P0054 for a deleted visit, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS I: move to deleted visit → P0054';
  end;
  begin
    perform public.correct_payment(v_p2b, 200, 'gcash', 'GC-1', null, 'x', v_actor, gen_random_uuid());
    raise exception 'I FAIL: expected P0054 for a missing visit, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS I: move to missing visit → P0054';
  end;

  -- ---- J: HMO payment ------------------------------------------------------
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
  values (v_hmo_visit, 800, 'hmo', v_actor, v_at) returning id into v_hmo_pay;
  begin
    perform public.correct_payment(v_hmo_pay, 700, 'hmo', null, null, 'x', v_actor);
    raise exception 'J FAIL: expected P0054, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS J: HMO payment → P0054';
  end;

  -- ---- K: legacy-import payment ------------------------------------------
  insert into public.legacy_import_runs (source, dry_run) values ('smoke-0161', false)
  returning id into v_run;
  insert into public.payments (visit_id, amount_php, method, received_by, received_at,
                               legacy_import_run_id)
  values (v_visit2, 100, 'bpi', v_actor, v_at, v_run) returning id into v_legacy;
  begin
    perform public.correct_payment(v_legacy, 100, 'bpi', null, null, 'x', v_actor, v_visit1);
    raise exception 'K FAIL: expected P0054, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS K: legacy import → P0054';
  end;

  -- ---- L: reason and actor are required ----------------------------------
  begin
    perform public.correct_payment(v_p2b, 150, 'gcash', null, null, '  ', v_actor);
    raise exception 'L FAIL: expected P0054 for a blank reason, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS L: blank reason → P0054';
  end;
  begin
    perform public.correct_payment(v_p2b, 150, 'gcash', null, null, 'x', null);
    raise exception 'L FAIL: expected P0054 for no actor, got success';
  exception when sqlstate 'P0054' then raise notice 'PASS L: no actor → P0054';
  end;

  -- ---- M: ACL (looked up by name: 0174 replaced the 8-argument signature)
  if has_function_privilege('anon',
       (select oid from pg_proc where proname = 'correct_payment'), 'execute')
     or has_function_privilege('authenticated',
       (select oid from pg_proc where proname = 'correct_payment'), 'execute')
     or not has_function_privilege('service_role',
       (select oid from pg_proc where proname = 'correct_payment'), 'execute') then
    raise exception 'M FAIL: correct_payment EXECUTE is not service_role-only';
  end if;
  raise notice 'PASS M: service_role only';

  raise notice 'ALL PASS: 0161 payment correction';
end;
$$;

rollback;

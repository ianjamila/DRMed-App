-- =============================================================================
-- 0174_correct_payment_stale_guard_smoke.sql
-- =============================================================================
-- Proves what 0174 adds to correct_payment (the 0161 behaviour is covered by
-- 0161_payment_correction_smoke.sql, which still passes against 0174):
--
--   A  the old 8-argument call (no p_expected) still works — the running app
--      between db push and deploy
--   B  a snapshot that matches the locked row → the edit goes through
--   C  each snapshot key that no longer matches → P0054, nothing written:
--      amount, method, visit, reference, notes
--   D  the Move race from the #213 review: a reference fix lands between the
--      Move's read and its call → the Move is refused instead of copying the
--      old reference back; retried with a fresh snapshot it keeps the fix
--   E  a payment a gift code was redeemed against → P0054 even when its
--      method is a counter method (pre-0139 redemptions)
--   F  an amount past numeric(10,2) → P0054, not a raw 22003
--   G  ACL: only the 9-argument function exists, service_role only
--
-- Run it against the LOCAL stack, not prod:
--   supabase db reset && psql "$(supabase status -o json | jq -r .DB_URL)" \
--     -f supabase/tests/0174_correct_payment_stale_guard_smoke.sql
--
-- Runs inside BEGIN/ROLLBACK and seeds itself; nothing survives.
-- =============================================================================

begin;

do $$
declare
  v_actor   uuid := gen_random_uuid();
  v_patient uuid;
  v_visit1  uuid;
  v_visit2  uuid;
  v_p       uuid;
  v_id      uuid;
  v_gc      uuid;
  v_row     public.payments%rowtype;
  v_n       int;
  v_at      timestamptz := now() - interval '1 hour';
  v_key     text;
  v_bad     jsonb;
  v_snap    jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values (v_actor, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'smoke-0174@example.test', '', now(), now(), now());
  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_actor, 'SMOKE 0174 Reception', 'admin', true);
  insert into public.patients (drm_id, first_name, last_name, birthdate)
  values ('SMOKE-0174', 'Smoke', 'Patient', '1990-01-01') returning id into v_patient;
  insert into public.visits (patient_id, total_php, payment_status)
  values (v_patient, 1000, 'unpaid') returning id into v_visit1;
  insert into public.visits (patient_id, total_php, payment_status)
  values (v_patient, 1000, 'unpaid') returning id into v_visit2;

  -- ---- A: the old call shape ------------------------------------------------
  insert into public.payments (visit_id, amount_php, method, reference_number, received_by, received_at)
  values (v_visit1, 100, 'cash', 'R-1', v_actor, v_at) returning id into v_p;
  v_id := public.correct_payment(v_p, 100, 'cash', 'R-2', null, 'old call', v_actor, null);
  if v_id <> v_p then raise exception 'A FAIL: 8-argument in-place edit re-created the row'; end if;
  raise notice 'PASS A: the 8-argument call still works';

  -- ---- B: a matching snapshot ------------------------------------------------
  v_snap := jsonb_build_object('amount_php', 100, 'method', 'cash', 'visit_id', v_visit1,
                               'reference_number', 'R-2', 'notes', null);
  v_id := public.correct_payment(v_p, 100, 'gcash', 'R-2', null, 'was gcash', v_actor, null, v_snap);
  if v_id = v_p then raise exception 'B FAIL: matching snapshot did not re-create'; end if;
  v_p := v_id;
  raise notice 'PASS B: a matching snapshot goes through';

  -- ---- C: each key that no longer matches -----------------------------------
  v_snap := jsonb_build_object('amount_php', 100, 'method', 'gcash', 'visit_id', v_visit1,
                               'reference_number', 'R-2', 'notes', null);
  foreach v_key in array array['amount_php', 'method', 'visit_id', 'reference_number', 'notes'] loop
    v_bad := v_snap || jsonb_build_object(v_key, case v_key
                                                   when 'amount_php' then to_jsonb(99)
                                                   when 'method' then to_jsonb('cash'::text)
                                                   when 'visit_id' then to_jsonb(v_visit2)
                                                   when 'reference_number' then to_jsonb('R-OLD'::text)
                                                   else to_jsonb('stale note'::text) end);
    begin
      perform public.correct_payment(v_p, 100, 'gcash', 'R-3', null, 'stale', v_actor, null, v_bad);
      raise exception 'C FAIL: stale % was not refused', v_key;
    exception when sqlstate 'P0054' then
      null;
    end;
  end loop;
  select * into v_row from public.payments where id = v_p;
  if v_row.reference_number <> 'R-2' or v_row.voided_at is not null then
    raise exception 'C FAIL: a refused edit still wrote (ref %, voided %)', v_row.reference_number, v_row.voided_at;
  end if;
  -- Blank reference in the snapshot compares as NULL, like the column.
  v_id := public.correct_payment(v_p, 100, 'gcash', 'R-2', 'note', 'notes only', v_actor, null,
                                 v_snap || '{"notes": "  "}'::jsonb);
  raise notice 'PASS C: every stale key is refused and nothing is written';

  -- ---- D: the Move race ------------------------------------------------------
  -- The Move read the payment (reference R-2, notes 'note') …
  v_snap := jsonb_build_object('amount_php', 100, 'method', 'gcash', 'visit_id', v_visit1,
                               'reference_number', 'R-2', 'notes', 'note');
  -- … someone fixes the reference in place before the Move's call …
  perform public.correct_payment(v_p, 100, 'gcash', 'R-FIXED', 'note', 'typo', v_actor);
  -- … so the Move, which would copy R-2 back, is refused.
  begin
    perform public.correct_payment(v_p, 100, 'gcash', 'R-2', 'note', 'wrong visit', v_actor, v_visit2, v_snap);
    raise exception 'D FAIL: stale Move was not refused';
  exception when sqlstate 'P0054' then null;
  end;
  v_id := public.correct_payment(v_p, 100, 'gcash', 'R-FIXED', 'note', 'wrong visit', v_actor, v_visit2,
                                 v_snap || '{"reference_number": "R-FIXED"}'::jsonb);
  select * into v_row from public.payments where id = v_id;
  if v_row.visit_id <> v_visit2 or v_row.reference_number <> 'R-FIXED' then
    raise exception 'D FAIL: retried Move landed on % with %', v_row.visit_id, v_row.reference_number;
  end if;
  raise notice 'PASS D: a Move never copies a stale reference back';

  -- ---- E: gift-code link ------------------------------------------------------
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
  values (v_visit1, 200, 'cash', v_actor, v_at) returning id into v_p;
  insert into public.gift_codes (code, face_value_php, status, redeemed_payment_id)
  values ('GC-SMK1-0174-TEST', 200, 'generated', v_p) returning id into v_gc;
  begin
    perform public.correct_payment(v_p, 200, 'gcash', null, null, 'x', v_actor);
    raise exception 'E FAIL: a redeemed payment keyed as cash was editable';
  exception when sqlstate 'P0054' then raise notice 'PASS E: gift-code-linked payment → P0054';
  end;

  -- ---- F: amount ceiling --------------------------------------------------------
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
  values (v_visit1, 300, 'cash', v_actor, v_at) returning id into v_p;
  begin
    perform public.correct_payment(v_p, 100000000, 'cash', null, null, 'x', v_actor);
    raise exception 'F FAIL: overflow amount was not refused';
  exception when sqlstate 'P0054' then raise notice 'PASS F: amount past numeric(10,2) → P0054';
  end;

  -- ---- G: ACL / signature ---------------------------------------------------------
  select count(*) into v_n from pg_proc where proname = 'correct_payment';
  if v_n <> 1 then raise exception 'G FAIL: % correct_payment overloads', v_n; end if;
  if has_function_privilege('anon',
       'public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated',
       'public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)', 'execute')
     or not has_function_privilege('service_role',
       'public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)', 'execute') then
    raise exception 'G FAIL: correct_payment EXECUTE is not service_role-only';
  end if;
  raise notice 'PASS G: one 9-argument function, service_role only';

  raise notice 'ALL PASS: 0174 correct_payment stale guard';
end;
$$;

rollback;

-- =============================================================================
-- 0030_op_gl_bridge_smoke.sql
-- =============================================================================
-- Bridge layer smoke test. Inside BEGIN/ROLLBACK, exercises every event kind,
-- the fallback chain, all four guard triggers (P0004-P0007), idempotency,
-- HMO partial-approval algebra, re-release after cancel, and
-- bridge_replay_summary structure.
-- Run with:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0030_op_gl_bridge_smoke.sql
-- or via Supabase MCP execute_sql (note: MCP doesn't honor BEGIN/ROLLBACK;
-- in that case, run the cleanup query at the bottom afterwards).
--
-- NOTE: Schema adaptations vs. plan spec:
--   * patients.birthdate (not date_of_birth)
--   * services.price_php (not cash_price_php)
--   * services.kind values: 'lab_test', 'doctor_consultation' (not 'lab', 'doctor_consult')
--   * payments.received_by NOT NULL → uses an existing auth.users id
--   * test_requests.requested_by NOT NULL → same auth.users id
-- =============================================================================

begin;

do $$
declare
  v_patient_id      uuid;
  v_visit_id        uuid;
  v_visit_hmo_id    uuid;
  v_hmo_provider_id uuid;
  v_service_lab_id  uuid;
  v_service_doc_id  uuid;
  v_test_req_id     uuid;
  v_test_req_hmo_id uuid;
  v_test_req_doc_id uuid;
  v_payment_id      uuid;
  v_payment_hmo_id  uuid;
  v_je_id           uuid;
  v_je_count        int;
  v_total_debit     numeric(14,2);
  v_total_credit    numeric(14,2);
  v_entry_number    text;
  v_smoke_start     timestamptz := now();
  v_actor_id        uuid;
begin
  -- Grab an existing auth.users id — required for NOT NULL FKs on received_by / requested_by.
  select id into v_actor_id from auth.users limit 1;
  if v_actor_id is null then
    raise exception 'SMOKE SETUP FAIL: no auth.users row found; cannot satisfy received_by / requested_by NOT NULL';
  end if;

  -- Set up: insert minimal supporting rows.
  insert into public.patients (drm_id, first_name, last_name, birthdate, sex)
    values ('SMOKE-001', 'Smoke', 'Patient', '1990-01-01', 'female')
    returning id into v_patient_id;

  insert into public.hmo_providers (name)
    values ('SMOKE_HMO')
    returning id into v_hmo_provider_id;

  insert into public.services (code, name, kind, price_php)
    values ('SMOKE_LAB', 'Smoke Lab Test', 'lab_test', 500)
    returning id into v_service_lab_id;

  insert into public.services (code, name, kind, price_php)
    values ('SMOKE_DOC', 'Smoke Doctor Consult', 'doctor_consultation', 700)
    returning id into v_service_doc_id;

  insert into public.visits (patient_id, total_php, payment_status)
    values (v_patient_id, 500, 'unpaid')
    returning id into v_visit_id;

  insert into public.visits (patient_id, total_php, payment_status, hmo_provider_id)
    values (v_patient_id, 1000, 'unpaid', v_hmo_provider_id)
    returning id into v_visit_hmo_id;

  -- 1. Insert non-HMO payment → JE posted: DR Cash on Hand / CR AR-Patients.
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
    values (v_visit_id, 500.00, 'cash', v_actor_id, now())
    returning id into v_payment_id;
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'payment' and source_id = v_payment_id and status = 'posted';
  if v_je_count <> 1 then
    raise exception 'FAIL test 1: expected 1 JE for payment, got %', v_je_count;
  end if;
  raise notice 'PASS 1: non-HMO payment posted 1 JE';

  -- 2. Insert HMO-visit payment with method='hmo' → DR 1090 / CR AR-HMO.
  insert into public.test_requests (visit_id, service_id, base_price_php, final_price_php, status, requested_by, requested_at)
    values (v_visit_hmo_id, v_service_lab_id, 1000, 1000, 'ready_for_release', v_actor_id, now())
    returning id into v_test_req_hmo_id;
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
    values (v_visit_hmo_id, 1000.00, 'hmo', v_actor_id, now())
    returning id into v_payment_hmo_id;
  perform 1 from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where je.source_kind = 'payment' and je.source_id = v_payment_hmo_id
      and coa.code = '1090' and jl.debit_php = 1000;
  if not found then
    raise exception 'FAIL test 2: expected DR 1090 line for HMO payment';
  end if;
  raise notice 'PASS 2: HMO payment routed to 1090 clearing account';

  -- 3. Release lab test (non-HMO, no discount) → 2-line JE.
  insert into public.test_requests (visit_id, service_id, base_price_php, final_price_php, status, requested_by, requested_at)
    values (v_visit_id, v_service_lab_id, 500, 500, 'ready_for_release', v_actor_id, now())
    returning id into v_test_req_id;
  update public.test_requests set status = 'released', released_at = now() where id = v_test_req_id;
  select count(*) into v_je_count
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where je.source_kind = 'test_request' and je.source_id = v_test_req_id;
  if v_je_count <> 2 then
    raise exception 'FAIL test 3: expected 2 lines for simple release, got %', v_je_count;
  end if;
  raise notice 'PASS 3: simple release produced 2-line JE';

  -- 4. HMO partial-approval + discount → 4-line balanced JE.
  insert into public.test_requests (
    visit_id, service_id, base_price_php, discount_amount_php, final_price_php,
    hmo_approved_amount_php, status, requested_by, requested_at
  )
  values (v_visit_hmo_id, v_service_lab_id, 1000, 200, 800, 500, 'ready_for_release', v_actor_id, now())
  returning id into v_test_req_id;
  update public.test_requests set status = 'released', released_at = now() where id = v_test_req_id;
  select sum(debit_php), sum(credit_php) into v_total_debit, v_total_credit
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where je.source_kind = 'test_request' and je.source_id = v_test_req_id;
  if v_total_debit <> 1000 or v_total_credit <> 1000 then
    raise exception 'FAIL test 4: HMO+discount JE imbalanced (D=%, C=%)', v_total_debit, v_total_credit;
  end if;
  select count(*) into v_je_count
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where je.source_kind = 'test_request' and je.source_id = v_test_req_id;
  if v_je_count <> 4 then
    raise exception 'FAIL test 4: expected 4 lines, got %', v_je_count;
  end if;
  raise notice 'PASS 4: HMO partial-approval + discount = 4-line balanced JE';

  -- 5. Release doctor consultation → JE against 4200 + 4920.
  insert into public.test_requests (visit_id, service_id, base_price_php, final_price_php, status, requested_by, requested_at)
    values (v_visit_id, v_service_doc_id, 700, 700, 'ready_for_release', v_actor_id, now())
    returning id into v_test_req_doc_id;
  update public.test_requests set status = 'released', released_at = now() where id = v_test_req_doc_id;
  perform 1 from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where je.source_kind = 'test_request' and je.source_id = v_test_req_doc_id
      and coa.code = '4200' and jl.credit_php = 700;
  if not found then
    raise exception 'FAIL test 5: doctor release did not credit 4200';
  end if;
  raise notice 'PASS 5: doctor consult release routed to 4200 revenue';

  -- 6. Void a payment → reversal JE created, original flipped to 'reversed'.
  update public.payments
    set voided_at = now(), voided_by = null, void_reason = 'smoke void test'
    where id = v_payment_id;
  select status into v_entry_number  -- reusing v_entry_number for status check
    from public.journal_entries
    where source_kind = 'payment' and source_id = v_payment_id;
  if v_entry_number <> 'reversed' then
    raise exception 'FAIL test 6: original payment JE not flipped to reversed (status=%)', v_entry_number;
  end if;
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'reversal' and reverses in (
      select id from public.journal_entries where source_kind = 'payment' and source_id = v_payment_id
    );
  if v_je_count <> 1 then
    raise exception 'FAIL test 6: expected 1 reversal JE, got %', v_je_count;
  end if;
  raise notice 'PASS 6: payment void created reversal JE and flipped original';

  -- 7. Cancel a released test → reversal JE created.
  update public.test_requests set status = 'cancelled' where id = v_test_req_doc_id;
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'reversal' and reverses in (
      select id from public.journal_entries where source_kind = 'test_request' and source_id = v_test_req_doc_id
    );
  if v_je_count <> 1 then
    raise exception 'FAIL test 7: expected 1 reversal JE for cancel, got %', v_je_count;
  end if;
  raise notice 'PASS 7: test_request cancel created reversal JE';

  -- 8. Re-release after cancel → new JE posts cleanly.
  update public.test_requests set status = 'ready_for_release' where id = v_test_req_doc_id;
  update public.test_requests set status = 'released', released_at = now() where id = v_test_req_doc_id;
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'test_request' and source_id = v_test_req_doc_id and status = 'posted';
  if v_je_count <> 1 then
    raise exception 'FAIL test 8: expected 1 posted JE after re-release, got %', v_je_count;
  end if;
  raise notice 'PASS 8: re-release after cancel produced fresh posted JE';

  -- 9. Missing payment_method mapping → posts to Suspense + audit log.
  delete from public.payment_method_account_map where payment_method = 'card';
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
    values (v_visit_id, 50, 'card', v_actor_id, now())
    returning id into v_payment_id;
  perform 1 from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where je.source_kind = 'payment' and je.source_id = v_payment_id
      and coa.code = '9999';
  if not found then
    raise exception 'FAIL test 9: missing mapping did not fall back to Suspense';
  end if;
  perform 1 from public.audit_log
    where action = 'coa.suspense_post'
      and metadata->>'source_id' = v_payment_id::text;
  if not found then
    raise exception 'FAIL test 9: no audit_log row for Suspense post';
  end if;
  raise notice 'PASS 9: missing mapping fell back to Suspense + audit row written';

  -- 10. P0005: posting to inactive account.
  update public.chart_of_accounts set is_active = false where code = '1010';
  begin
    insert into public.payments (visit_id, amount_php, method, received_by, received_at)
      values (v_visit_id, 25, 'cash', v_actor_id, now());
    raise exception 'FAIL test 10: expected P0005, got success';
  exception when sqlstate 'P0005' then
    raise notice 'PASS 10: P0005 blocked insert against inactive account';
  end;
  update public.chart_of_accounts set is_active = true where code = '1010';

  -- 11. P0006: cannot DELETE from chart_of_accounts.
  begin
    delete from public.chart_of_accounts where code = '4500';
    raise exception 'FAIL test 11: expected P0006, got success';
  exception when sqlstate 'P0006' then
    raise notice 'PASS 11: P0006 blocked CoA delete';
  end;

  -- 12. P0007: cannot un-void a payment.
  begin
    -- First void v_payment_hmo_id, then try to un-void to trip P0007.
    update public.payments
      set voided_at = now(), void_reason = 'temp', voided_by = null
      where id = v_payment_hmo_id;
    update public.payments set voided_at = null where id = v_payment_hmo_id;
    raise exception 'FAIL test 12: expected P0007 on un-void';
  exception when sqlstate 'P0007' then
    raise notice 'PASS 12: P0007 blocked un-void attempt';
  end;

  -- 13. P0004: cannot edit payment after JE has posted.
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
    values (v_visit_id, 75, 'cash', v_actor_id, now())
    returning id into v_payment_id;
  begin
    update public.payments set amount_php = 100 where id = v_payment_id;
    raise exception 'FAIL test 13: expected P0004 on amount edit';
  exception when sqlstate 'P0004' then
    raise notice 'PASS 13: P0004 blocked edit of amount_php after JE posted';
  end;

  -- 14. Idempotency: simulate trigger fired twice — manual call to function
  -- should be a no-op because of the partial unique index + idempotency check.
  -- (We can't easily simulate the trigger firing twice in SQL; instead we
  -- verify the partial unique index by attempting a duplicate posted JE.)
  begin
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, created_by
    )
    values (current_date, 'duplicate', 'posted', 'payment', v_payment_id, null);
    raise exception 'FAIL test 14: expected unique violation';
  exception when sqlstate '23505' then
    raise notice 'PASS 14: partial unique index blocks duplicate posted JE';
  end;

  -- 15. BEFORE DELETE on payments → reversal JE before delete.
  insert into public.payments (visit_id, amount_php, method, received_by, received_at)
    values (v_visit_id, 33, 'cash', v_actor_id, now())
    returning id into v_payment_id;
  delete from public.payments where id = v_payment_id;
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'reversal' and reverses in (
      select id from public.journal_entries where source_kind = 'payment' and source_id = v_payment_id
    );
  if v_je_count <> 1 then
    raise exception 'FAIL test 15: expected 1 reversal JE from BEFORE DELETE, got %', v_je_count;
  end if;
  raise notice 'PASS 15: BEFORE DELETE on payment created reversal JE';

  -- 16. bridge_replay_summary structure check.
  declare v_summary jsonb;
  begin
    v_summary := public.bridge_replay_summary(v_smoke_start, now());
    if v_summary->'window' is null
       or v_summary->'je_count' is null
       or v_summary->'suspense_postings' is null
       or v_summary->'totals_by_account' is null
       or v_summary->'unbalanced_count' is null then
      raise exception 'FAIL test 16: replay summary missing required keys: %', v_summary;
    end if;
    if (v_summary->>'unbalanced_count')::int <> 0 then
      raise exception 'FAIL test 16: unbalanced JEs detected: %', v_summary->'unbalanced_count';
    end if;
    raise notice 'PASS 16: bridge_replay_summary structure correct, no unbalanced JEs';
  end;

  -- 17. Resolver helpers behave with unknown inputs (Suspense fallback).
  if public.resolve_cash_account('not_a_method') is null then
    raise exception 'FAIL test 17: resolve_cash_account returned null for unknown';
  end if;
  if public.resolve_revenue_account('totally_made_up_kind') is null then
    raise exception 'FAIL test 17: resolve_revenue_account returned null for unknown';
  end if;
  raise notice 'PASS 17: resolvers fall back to Suspense, never null';

  -- 18. Re-confirming partial unique index by status transition.
  -- After flipping the original release JE to 'reversed' in test 7, the
  -- partial index should allow a new posted JE for the same source.
  -- Test 8 already exercised this; verify the count of posted vs reversed:
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'test_request' and source_id = v_test_req_doc_id and status = 'posted';
  if v_je_count <> 1 then
    raise exception 'FAIL test 18: expected exactly 1 posted JE for re-released test, got %', v_je_count;
  end if;
  select count(*) into v_je_count
    from public.journal_entries
    where source_kind = 'test_request' and source_id = v_test_req_doc_id and status = 'reversed';
  if v_je_count <> 1 then
    raise exception 'FAIL test 18: expected exactly 1 reversed JE for re-released test, got %', v_je_count;
  end if;
  raise notice 'PASS 18: partial unique index correctly allows re-release';

  raise notice 'ALL SMOKE TESTS PASSED';
end;
$$;

rollback;

-- =============================================================================
-- Post-smoke cleanup (run if executed via MCP, which doesn't honor ROLLBACK)
-- =============================================================================
-- delete from public.journal_lines
--   where entry_id in (
--     select id from public.journal_entries
--     where created_at > now() - interval '1 hour'
--       and description like '%mok%'
--   );
-- delete from public.journal_entries
--   where created_at > now() - interval '1 hour'
--     and description like '%mok%';
-- select fiscal_year, next_n from public.je_year_counters where fiscal_year = 2026;
-- delete from public.payments where amount_php in (25, 33, 50, 75, 500, 1000) and notes is null;
-- delete from public.test_requests where base_price_php in (500, 700, 1000) and status in ('released', 'cancelled', 'ready_for_release');
-- delete from public.visits where total_php in (500, 1000) and patient_id in (
--   select id from public.patients where drm_id = 'SMOKE-001'
-- );
-- delete from public.patients where drm_id = 'SMOKE-001';
-- delete from public.hmo_providers where name = 'SMOKE_HMO';
-- delete from public.services where code in ('SMOKE_LAB', 'SMOKE_DOC');
-- select 'patients' as t, count(*)::int n from public.patients where drm_id = 'SMOKE-001'
-- union all select 'smoke_jes', count(*)::int from public.journal_entries where description like '%mok%';

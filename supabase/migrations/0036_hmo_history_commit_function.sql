-- =============================================================================
-- 0036_hmo_history_commit_function.sql
-- =============================================================================
-- 12.A.4: commit_hmo_history_run() runs the entire historical import in a single
-- transaction with an advisory lock and a session-scoped bridge bypass. Called
-- by commitRunAction Server Action via supabase.rpc().
--
-- Flow:
--   0. pg_advisory_xact_lock to serialize concurrent commits.
--   1. Load run row (cutover_date + uploaded_by); refuse if not found (P0013).
--      Verify uploaded_by has a matching staff_profiles row (P0013).
--   2. Refuse if any error-severity rows remain (P0014).
--   3. SET LOCAL app.skip_bridge_historical = 'true' (bridge no-ops).
--   4. Insert patients (deduped by last_name + first_name when is_historical).
--   5. Insert visits (one per visit_group_key, with hmo_provider_id set,
--      payment_status='paid' so test_requests can be inserted as released).
--   6. Insert test_requests directly with status='released' (the released
--      bridge is UPDATE-only, so direct INSERT skips it cleanly).
--   7. Insert hmo_claim_batches:
--        - real batches grouped by (provider, reference_no, submission_date)
--        - synthetic 'draft' batches grouped by (provider, YYYY-MM) for
--          rows with no reference_no.
--   8. Insert hmo_claim_items, matching each staging row to its batch.
--   9. Insert synthetic 'hmo' method payments (one per provider × OR#).
--      Bridge bypass active, so no JE posts.
--  10. Insert hmo_payment_allocations (the recompute trigger flips item
--      paid_amount_php).
--  11. Unset the bypass.
--  12. Compute per-provider opening AR (sum greatest(0, billed - paid -
--      patient_billed - written_off) across this run's items). For each
--      provider with non-zero opening AR, post one JE:
--          DR 1110 AR-HMO       opening_amount
--          CR 3200 Retained-Earnings  opening_amount
--      Two-step pattern: insert as draft, insert lines, update to posted
--      (so je_lines_balance_check doesn't fire mid-insert).
--  13. Stamp committed_at + finished_at + summary on the run.
--  14. Flip staging rows status to 'committed'.
--  15. Insert audit_log row.
--
-- Key adaptations from the plan's pseudocode:
--   - staff_profiles.id IS the auth.users.id (FK to auth.users(id)). The plan's
--     `select user_id from staff_profiles where id = ...` would fail (no such
--     column); we `select id` to validate row existence.
--   - journal_entries column is `description`, not `narrative`.
--   - journal_lines columns are (entry_id, account_id, debit_php, credit_php,
--     line_order); description is optional but line_order is NOT NULL.
--   - audit_log columns are (actor_id, actor_type, action, resource_type,
--     resource_id, metadata), not (action, actor_id, entity, entity_id, metadata).
--   - We use the two-step draft → insert lines → posted pattern because
--     je_status_balance_check fires on the UPDATE to 'posted' and requires
--     balanced lines.
-- =============================================================================

create or replace function public.commit_hmo_history_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutover         date;
  v_uploaded_by_id  uuid;     -- staff_profiles.id (= auth.users.id)
  v_uploaded_auth   uuid;     -- alias for clarity; same UUID as v_uploaded_by_id
  v_advisory_key    bigint := hashtext('hmo_history_import');
  v_n_patients      int := 0;
  v_n_visits        int := 0;
  v_n_test_requests int := 0;
  v_n_batches       int := 0;
  v_n_items         int := 0;
  v_n_payments      int := 0;
  v_n_allocations   int := 0;
  v_n_jes           int := 0;
  v_summary         jsonb;
  r_provider        record;
  v_je_id           uuid;
  v_ar_account_id   uuid := public.coa_uuid_for_code('1110');
  v_retained_id     uuid := public.coa_uuid_for_code('3200');
  v_opening_amount  numeric(12,2);
begin
  perform pg_advisory_xact_lock(v_advisory_key);

  -- Load run.
  select cutover_date, uploaded_by into v_cutover, v_uploaded_by_id
    from public.hmo_import_runs
   where id = p_run_id
   for update;
  if v_cutover is null then
    raise exception 'no such import run %', p_run_id using errcode = 'P0013';
  end if;

  -- Verify uploaded_by maps to an actual staff_profiles row. staff_profiles.id
  -- IS the auth.users.id (1:1 FK), so the two are interchangeable in this codebase.
  select id into v_uploaded_auth from public.staff_profiles where id = v_uploaded_by_id;
  if v_uploaded_auth is null then
    raise exception 'staff_profile % not found', v_uploaded_by_id using errcode = 'P0013';
  end if;

  -- Refuse to commit if any error-severity validations remain.
  if exists (
    select 1 from public.hmo_history_staging
     where run_id = p_run_id and status = 'validated'
       and jsonb_path_exists(validation_errors, '$[*] ? (@.severity == "error")')
  ) then
    raise exception 'commit blocked: error-severity rows remain' using errcode = 'P0014';
  end if;

  -- Enable bypass for the JE-posting bridges inside this transaction.
  perform set_config('app.skip_bridge_historical', 'true', true);

  -- ---- 1. Patients --------------------------------------------------------
  with new_patients as (
    insert into public.patients (first_name, last_name, middle_name, birthdate,
                                  is_historical, created_at)
    select distinct on (s.last_name_raw, s.first_name_raw)
      s.first_name_raw, s.last_name_raw, null::text, null::date, true, now()
    from public.hmo_history_staging s
    where s.run_id = p_run_id and s.status = 'validated'
    on conflict (last_name, first_name) where is_historical = true do nothing
    returning 1
  )
  select count(*) into v_n_patients from new_patients;

  -- ---- 2. Visits ----------------------------------------------------------
  -- One visit per (source_date, last_name, first_name, provider_id_resolved).
  -- payment_status='paid' so test_requests below can be inserted as 'released'
  -- without tripping enforce_payment_before_release (which is UPDATE-only
  -- anyway; defense in depth).
  with grouped as (
    select distinct
      s.source_date, s.last_name_raw, s.first_name_raw, s.provider_id_resolved
    from public.hmo_history_staging s
    where s.run_id = p_run_id and s.status = 'validated'
  ), with_patient as (
    select g.*, p.id as patient_id
    from grouped g
    join public.patients p
      on p.is_historical = true
     and p.last_name = g.last_name_raw
     and p.first_name = g.first_name_raw
  ), new_visits as (
    insert into public.visits (patient_id, visit_date, payment_status,
                               hmo_provider_id, is_historical, created_at, created_by)
    select wp.patient_id, wp.source_date, 'paid', wp.provider_id_resolved,
           true, now(), v_uploaded_auth
    from with_patient wp
    returning id
  )
  select count(*) into v_n_visits from new_visits;

  -- ---- 3. Test requests ---------------------------------------------------
  -- One test_request per staging row. status='released' is set directly at
  -- INSERT; the bridge_test_request_released trigger is AFTER UPDATE only,
  -- so no JE posts here. is_historical=true marks them for the partial indexes.
  with staging_with_visit as (
    select s.*, v.id as visit_id
    from public.hmo_history_staging s
    join public.patients p
      on p.is_historical = true
     and p.last_name = s.last_name_raw
     and p.first_name = s.first_name_raw
    join public.visits v
      on v.is_historical = true
     and v.patient_id = p.id
     and v.visit_date = s.source_date
     and v.hmo_provider_id = s.provider_id_resolved
    where s.run_id = p_run_id and s.status = 'validated'
  ), new_trs as (
    insert into public.test_requests (
      visit_id, service_id, status, requested_by, requested_at,
      released_at, released_by, hmo_provider_id, hmo_approval_date,
      hmo_authorization_no, hmo_approved_amount_php, base_price_php,
      final_price_php, is_historical, created_at
    )
    select sv.visit_id, sv.service_id_resolved, 'released',
           v_uploaded_auth, sv.source_date::timestamptz,
           sv.source_date::timestamptz + interval '12 hours', v_uploaded_auth,
           sv.provider_id_resolved, sv.hmo_approval_date,
           sv.reference_no, sv.billed_amount, sv.billed_amount,
           sv.billed_amount, true, now()
    from staging_with_visit sv
    returning id
  )
  select count(*) into v_n_test_requests from new_trs;

  -- ---- 4. HMO claim batches -----------------------------------------------
  -- Real batches: rows with a reference_no, grouped by (provider, reference_no,
  -- submission_date). Status is 'paid' if any row in the group has a payment
  -- received, else 'submitted'.
  insert into public.hmo_claim_batches (
    provider_id, status, reference_no, submitted_at, submitted_by,
    medium, import_run_id, historical_source, created_at
  )
  select rg.provider_id,
         case when rg.any_paid then 'paid' else 'submitted' end,
         rg.reference_no, rg.submission_date, v_uploaded_by_id,
         'mail', p_run_id, 'mastersheet:historical', now()
  from (
    select
      s.provider_id_resolved as provider_id,
      s.reference_no,
      s.submission_date,
      bool_or(s.payment_received_date is not null) as any_paid
    from public.hmo_history_staging s
    where s.run_id = p_run_id and s.status = 'validated' and s.reference_no is not null
    group by s.provider_id_resolved, s.reference_no, s.submission_date
  ) rg;

  -- Synthetic 'draft' batches: rows with NULL reference_no, grouped by
  -- (provider, year-month of source_date). Carries a sentinel reference_no
  -- so the items step can match staging rows back to their synthetic batch.
  insert into public.hmo_claim_batches (
    provider_id, status, reference_no, submitted_at, import_run_id,
    historical_source, created_at, notes
  )
  select sg.provider_id, 'draft',
         '[unbilled-historical:' || sg.ym || ']',
         null, p_run_id, 'mastersheet:historical-unbilled', now(),
         'Synthetic batch for un-submitted historical claims from ' || sg.ym
  from (
    select distinct
      s.provider_id_resolved as provider_id,
      to_char(s.source_date, 'YYYY-MM') as ym
    from public.hmo_history_staging s
    where s.run_id = p_run_id and s.status = 'validated' and s.reference_no is null
  ) sg;

  v_n_batches := (select count(*)::int from public.hmo_claim_batches where import_run_id = p_run_id);

  -- ---- 5. HMO claim items -------------------------------------------------
  -- Match each staging row to its batch (real by ref+date, synthetic by ym).
  with staging_with_batch as (
    select s.*,
           (select b.id from public.hmo_claim_batches b
             where b.import_run_id = p_run_id
               and b.provider_id = s.provider_id_resolved
               and (
                 (s.reference_no is not null
                  and b.reference_no = s.reference_no
                  and b.submitted_at is not distinct from s.submission_date)
                 or (s.reference_no is null
                     and b.reference_no = '[unbilled-historical:' || to_char(s.source_date, 'YYYY-MM') || ']')
               )
             limit 1) as batch_id,
           (select tr.id from public.test_requests tr
             join public.visits v on v.id = tr.visit_id
             join public.patients p on p.id = v.patient_id
            where p.is_historical = true
              and p.last_name = s.last_name_raw
              and p.first_name = s.first_name_raw
              and v.visit_date = s.source_date
              and v.hmo_provider_id = s.provider_id_resolved
              and tr.service_id = s.service_id_resolved
              and tr.is_historical = true
              and tr.hmo_approved_amount_php = s.billed_amount
            order by tr.created_at asc limit 1) as test_request_id
    from public.hmo_history_staging s
    where s.run_id = p_run_id and s.status = 'validated'
  ), new_items as (
    insert into public.hmo_claim_items (
      batch_id, test_request_id, billed_amount_php, hmo_response,
      hmo_response_date, hmo_approval_date, created_at
    )
    select swb.batch_id, swb.test_request_id, swb.billed_amount,
           case when swb.payment_received_date is not null then 'paid'
                else 'pending' end,
           swb.payment_received_date,
           swb.hmo_approval_date,
           now()
    from staging_with_batch swb
    where swb.batch_id is not null and swb.test_request_id is not null
    returning 1
  )
  select count(*) into v_n_items from new_items;

  -- ---- 6. Payments --------------------------------------------------------
  -- One synthetic 'hmo' payment per (provider, or_number). Amount = sum of
  -- paid_amount across staging rows sharing that OR#. Bridge bypass is active
  -- so no JE posts. notes prefix is the natural key the allocations step uses
  -- to find the payment.
  with or_groups as (
    select s.provider_id_resolved as provider_id,
           s.or_number,
           min(s.payment_received_date) as payment_date,
           sum(s.paid_amount) as total_paid,
           min(s.last_name_raw)  as any_last_name,
           min(s.first_name_raw) as any_first_name,
           min(s.source_date)    as any_source_date
    from public.hmo_history_staging s
    where s.run_id = p_run_id and s.status = 'validated'
      and s.or_number is not null
      and s.payment_received_date is not null
    group by s.provider_id_resolved, s.or_number
  ), or_with_visit as (
    select og.*,
           (select v.id from public.visits v
             join public.patients p on p.id = v.patient_id
            where p.is_historical = true
              and v.is_historical = true
              and v.hmo_provider_id = og.provider_id
              and p.last_name  = og.any_last_name
              and p.first_name = og.any_first_name
              and v.visit_date = og.any_source_date
            limit 1) as visit_id
    from or_groups og
  ), new_payments as (
    insert into public.payments (
      visit_id, amount_php, method, reference_number,
      received_by, received_at, notes
    )
    select owv.visit_id, owv.total_paid, 'hmo', owv.or_number,
           v_uploaded_auth, owv.payment_date::timestamptz + interval '12 hours',
           '[historical-import:' || p_run_id::text || ']'
    from or_with_visit owv
    where owv.visit_id is not null and owv.total_paid > 0
    returning id
  )
  select count(*) into v_n_payments from new_payments;

  -- ---- 7. Allocations -----------------------------------------------------
  -- For each staging row with paid_amount > 0 and an OR#, link the row's item
  -- to the payment for that (provider, OR#). The recompute trigger on
  -- hmo_payment_allocations will fold paid_amount into hmo_claim_items.paid_amount_php.
  with alloc_rows as (
    select s.id as staging_id,
           hci.id as item_id,
           p.id as payment_id,
           s.paid_amount
    from public.hmo_history_staging s
    join public.test_requests tr
      on tr.is_historical = true
     and tr.service_id = s.service_id_resolved
     and tr.hmo_approved_amount_php = s.billed_amount
    join public.visits v on v.id = tr.visit_id
    join public.patients pt on pt.id = v.patient_id
    join public.hmo_claim_items hci on hci.test_request_id = tr.id
    join public.payments p
      on p.reference_number = s.or_number
     and p.method = 'hmo'
     and p.notes = '[historical-import:' || p_run_id::text || ']'
    where s.run_id = p_run_id and s.status = 'validated'
      and s.or_number is not null
      and s.paid_amount > 0
      and pt.is_historical = true
      and pt.last_name = s.last_name_raw
      and pt.first_name = s.first_name_raw
      and v.visit_date = s.source_date
      and v.hmo_provider_id = s.provider_id_resolved
  ), new_allocs as (
    insert into public.hmo_payment_allocations (payment_id, item_id, amount_php, created_at)
    select payment_id, item_id, paid_amount, now() from alloc_rows
    returning 1
  )
  select count(*) into v_n_allocations from new_allocs;

  -- ---- 8. Unset bypass ----------------------------------------------------
  perform set_config('app.skip_bridge_historical', '', true);

  -- ---- 9. Opening JEs per provider ----------------------------------------
  -- Compute the net opening AR per provider across this run's items. Note:
  -- the alloc trigger above has already updated paid_amount_php on items, so
  -- the formula below reflects post-allocation balances. Skip providers with
  -- net zero (all items fully paid).
  for r_provider in
    select hp.id as provider_id, hp.name as provider_name,
           coalesce(sum(
             greatest(0, hci.billed_amount_php
                      - hci.paid_amount_php
                      - hci.patient_billed_amount_php
                      - hci.written_off_amount_php)
           ), 0) as opening_ar
      from public.hmo_providers hp
      join public.hmo_claim_batches hcb on hcb.provider_id = hp.id and hcb.import_run_id = p_run_id
      join public.hmo_claim_items hci on hci.batch_id = hcb.id
     group by hp.id, hp.name
    having coalesce(sum(
             greatest(0, hci.billed_amount_php
                      - hci.paid_amount_php
                      - hci.patient_billed_amount_php
                      - hci.written_off_amount_php)
           ), 0) > 0
  loop
    v_opening_amount := r_provider.opening_ar;

    -- Two-step pattern: insert header as draft, insert lines, flip to posted.
    -- je_status_balance_check fires on the draft→posted transition and
    -- requires balanced lines at that moment.
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, created_by
    ) values (
      v_cutover,
      'Opening HMO AR for ' || r_provider.provider_name || ' (12.A historical import)',
      'draft',
      'hmo_history_opening',
      p_run_id,
      v_uploaded_auth
    ) returning id into v_je_id;

    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, description, line_order)
    values
      (v_je_id, v_ar_account_id,  v_opening_amount, 0,
       'Opening AR: ' || r_provider.provider_name, 1),
      (v_je_id, v_retained_id,    0, v_opening_amount,
       'Opening RE offset: ' || r_provider.provider_name, 2);

    update public.journal_entries set status = 'posted' where id = v_je_id;

    v_n_jes := v_n_jes + 1;
  end loop;

  -- ---- 10. Stamp run + flip staging + audit -------------------------------
  v_summary := jsonb_build_object(
    'patients',      v_n_patients,
    'visits',        v_n_visits,
    'test_requests', v_n_test_requests,
    'batches',       v_n_batches,
    'items',         v_n_items,
    'payments',      v_n_payments,
    'allocations',   v_n_allocations,
    'opening_jes',   v_n_jes
  );

  update public.hmo_import_runs
     set committed_at = now(),
         finished_at  = now(),
         summary      = coalesce(summary, '{}'::jsonb) || v_summary
   where id = p_run_id;

  update public.hmo_history_staging set status = 'committed'
   where run_id = p_run_id and status = 'validated';

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (v_uploaded_by_id, 'staff', 'hmo_history_import.committed',
          'hmo_import_runs', p_run_id, v_summary);

  return v_summary;
end;
$$;

revoke all on function public.commit_hmo_history_run(uuid) from public;
grant execute on function public.commit_hmo_history_run(uuid) to service_role;

comment on function public.commit_hmo_history_run(uuid) is
  '12.A.4: Commits a validated hmo_import_runs row by inserting patients, '
  'visits, test_requests, HMO batches+items, synthetic payments, allocations, '
  'and per-provider opening JEs in a single transaction. Bracketed by '
  'pg_advisory_xact_lock + SET LOCAL app.skip_bridge_historical=''true''. '
  'service_role only.';

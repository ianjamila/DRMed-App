-- =============================================================================
-- 0140_manila_posting_dates.sql
-- =============================================================================
-- N16 (medium) — payments and releases post to the WRONG DAY before 8am Manila.
--
-- bridge_payment_insert() (current body: 0091, ~line 90) built the payment JE's
-- posting_date from `NEW.received_at::date` and bridge_test_request_released()
-- (current body: 0131, ~line 141) from `coalesce(new.released_at::date,
-- current_date)`. Both cast a `timestamptz` straight to `date`, which reads
-- the UTC calendar date, not the clinic's Asia/Manila (UTC+8) one — CLAUDE.md's
-- "Dates" rule (`(now() at time zone 'Asia/Manila')::date`, never a naive
-- cast) applies to a *stored* timestamp exactly the same way it applies to
-- `now()`. Any payment or release recorded before 08:00 Manila posts to the
-- PREVIOUS calendar day, and at a month/year boundary to the previous
-- month/year (e.g. a payment at 2026-01-01 03:00 Manila is 2025-12-31 19:00
-- UTC — `::date` reads 2025-12-31, a different YEAR). The same pattern
-- (`(<col> at time zone 'Asia/Manila')::date`) is already used elsewhere in
-- these same migrations for exactly this reason — 0043/0091's own
-- payments_block_after_close() and 0043's v_daily_revenue_by_service view —
-- this migration just applies it to the JE posting_date too.
--
-- Both functions are re-created byte-identical to their latest bodies (0091
-- for bridge_payment_insert, 0131 for bridge_test_request_released) except for
-- the posting_date line. CREATE OR REPLACE on an existing function keeps its
-- current ACL (0118 revoked public/anon/authenticated from both; restated
-- explicitly below for a self-describing replay — see 0118/0119 and the
-- drmed-migrations skill).
--
-- go-live review follow-ups (findings 7, 10, 12) folded into this same
-- migration rather than stacked, since 0140 has not reached prod yet:
--
-- Finding 12 — forward postings only. bridge_payment_void() (0030, ~line 305)
-- and fn_undo_release_bridge() (0110, ~line 35) still built their reversal
-- JE's posting_date from a bare UTC cast/`current_date`. Left alone, a
-- forward posting now lands on the correct Manila day while voiding or
-- undoing it minutes later could still land on the PREVIOUS Manila day (a
-- closed period), so a reversal that should trivially succeed would fail.
-- Both are re-created below, byte-identical to their current bodies except
-- the posting_date line, same pattern as the two functions above. A repo-wide
-- grep for other `::date` casts on a timestamptz column in an accounting
-- posting path turned up more (bridge_hmo_claim_resolution_insert/void,
-- bridge_test_request_cancelled, bridge_pf_at_hmo_allocation/writeoff,
-- bridge_cogs_send_out_trueup, bridge_cash_adjustment_void) — out of scope
-- for this migration (not named in the review, and each is its own blast
-- radius), reported to the operator rather than silently left or silently
-- fixed.
--
-- Finding 7 — the backfill's closed-period strategy. Both backfill UPDATEs
-- below can touch an already-`status = 'posted'` journal_entries row, which
-- re-fires trg_je_period_lock_check (0029_gl_foundation_fixes.sql ~line 47):
-- if the CORRECTED date falls in a CLOSED accounting_periods row, that
-- BEFORE trigger raises P0002 and aborts the whole migration partway
-- through. An empty-database replay can never exercise this (no populated
-- periods to collide with) — the original version of this comment claimed
-- the backfill "never raises"; that was true only on an empty DB and false
-- on real data, and is corrected here. Chosen strategy: SKIP any row whose
-- corrected date is closed and write an audit_log row for manual handling,
-- rather than (a) reopening/closing the period around the correction —
-- reopening a closed accounting period from inside an unattended migration
-- is a much bigger event than a one-day posting-date drift and has its own
-- blast radius (every other posted JE in that period becomes editable again
-- for the duration) — or (b) restricting the backfill to open periods only
-- at the query level with no record of what was skipped, which silently
-- leaves the ledger wrong with no trail for the bookkeeper to follow up on.
-- Skipping-and-reporting is safe on a populated prod DB (never raises, never
-- half-applies) and is a no-op on an empty replay (no closed periods with
-- rows in them to skip).
--
-- Finding 10 — the release backfill's timestamp. tr.released_at is
-- OVERWRITTEN on every (re-)release; fn_undo_release_bridge() (0110) does
-- not restore a prior timestamp when a test is undone and re-released, so
-- tr.released_at only ever describes the event that produced the JE
-- CURRENTLY in status = 'posted' for that test_request — the partial unique
-- index journal_entries_one_posted_per_source (0030) guarantees at most one
-- such row. A journal_entries row left at source_kind = 'test_request' and
-- status = 'reversed' (an undone release) predates that overwrite; its true
-- original posting timestamp can no longer be reconstructed from
-- test_requests, and correcting it with the CURRENT released_at would
-- relocate a real historical entry to the wrong month while leaving the
-- 'reversal' JE that reverses it (source_kind = 'reversal', untouched by
-- this backfill) on its original date — an inconsistent pair. The release
-- backfill below is therefore restricted to `status = 'posted'` rows only;
-- reversed rows are left untouched and reported via audit_log instead of
-- guessed at. Correcting fewer rows correctly beats corrupting history.
--
-- Backfill scope today: prod has 5 payment journal entries and 0
-- test_request-release journal entries known to be affected (per the
-- go-live audit), and 0 reversed test_request-release journal entries exist
-- at all yet — so every clause below is a no-op on prod today. All four
-- (payment UPDATE, release UPDATE, and their two audit_log reports) are
-- guarded to never raise on a missing/empty table, required for a clean
-- replay on an empty DB. Known limitation, stated rather than silently
-- worked around: `entry_number` embeds the fiscal year it was assigned
-- under (je_next_number) and is a printed/exported business document
-- number — this backfill does NOT renumber it, so a JE whose corrected
-- posting_date crosses a year boundary would carry an entry_number from the
-- "wrong" year. Given zero affected rows today, this is accepted rather
-- than solved; an operator hitting this later should renumber by hand via
-- the normal correction flow, not this migration.
-- =============================================================================

create or replace function public.bridge_payment_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_hmo         boolean;
  v_cash_id        uuid;
  v_ar_id          uuid;
  v_je_id          uuid;
  v_existing_je    uuid;
  v_suspense_id    uuid;
  v_used_suspense  boolean := false;
begin
  -- Legacy backfill rows are GL-silent (the books already hold this money).
  if NEW.legacy_import_run_id is not null then
    return NEW;
  end if;

  select id into v_existing_je
    from public.journal_entries
    where source_kind = 'payment'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  select (v.hmo_provider_id is not null) into v_is_hmo
    from public.visits v
    where v.id = NEW.visit_id;

  v_cash_id := public.resolve_cash_account(NEW.method);
  v_ar_id   := public.resolve_ar_account(coalesce(v_is_hmo, false));

  v_suspense_id := public.coa_uuid_for_code('9999');
  v_used_suspense := (v_cash_id = v_suspense_id);

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    -- 0140: Manila-local date of the payment, not the UTC date `::date` reads.
    (NEW.received_at at time zone 'Asia/Manila')::date,
    'Payment received via ' || NEW.method,
    'draft',
    'payment',
    NEW.id,
    NEW.received_by
  )
  returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values
    (v_je_id, v_cash_id, NEW.amount_php, 0, 1),
    (v_je_id, v_ar_id,   0, NEW.amount_php, 2);

  update public.journal_entries set status = 'posted' where id = v_je_id;

  if v_used_suspense then
    insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
    values (
      NEW.received_by,
      'staff',
      'coa.suspense_post',
      'journal_entries',
      v_je_id,
      jsonb_build_object(
        'source_kind', 'payment',
        'source_id', NEW.id,
        'reason', 'no payment_method_account_map row',
        'attempted_lookup', NEW.method
      )
    );
  end if;

  return NEW;
end;
$function$;

revoke execute on function public.bridge_payment_insert() from public, anon, authenticated;
grant  execute on function public.bridge_payment_insert() to service_role;

create or replace function public.bridge_test_request_released()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_visit            record;
  v_service          record;
  v_physician_id     uuid;
  v_actor            uuid;
  v_je_id            uuid;
  v_je_number        text;
  v_posting_date     date;
  v_cash_account     text;
  v_revenue_account  text;
  v_discount_account text;
  v_line_order       int := 1;
begin
  -- Legacy backfill rows are GL-silent (the books already hold this money).
  if NEW.legacy_import_run_id is not null then
    return NEW;
  end if;

  -- Package components are ₱0 lines; the header books the package revenue (0041).
  if NEW.parent_id is not null then
    return NEW;
  end if;

  -- Trigger fires on every UPDATE; only proceed on status→released transition.
  if not (old.status is distinct from new.status and new.status = 'released') then
    return new;
  end if;

  -- Idempotency: if a posted JE already exists for this test_request, skip.
  -- The partial unique index journal_entries_one_posted_per_source (0030) also
  -- enforces this, but an early exit is cleaner and avoids wasted work.
  if exists (
    select 1 from public.journal_entries
    where source_kind = 'test_request'
      and source_id = new.id
      and status = 'posted'
  ) then
    return new;
  end if;

  -- auth.uid() may be null when called from a SECURITY DEFINER Server Action
  -- via the service-role client. The journal_entries.created_by column is a
  -- nullable FK to staff_profiles(id), so null is acceptable.
  v_actor := auth.uid();

  select * into v_visit   from public.visits   where id = new.visit_id;
  select * into v_service from public.services where id = new.service_id;

  -- ---- P0034 guard ---------------------------------------------------------
  -- attending_physician_id is required at release only for doctor lines that
  -- actually accrue PF (0131). Intake admits physician-less procedures whose
  -- doctor PF is ₱0; release must not dead-end them. The doctor_pf_entries
  -- insert below only runs when coalesce(new.doctor_pf_php, 0) > 0, so a null
  -- physician is never consumed when the exemption applies.
  -- COALESCE reads the per-line override first, then the visit-level default.
  if v_service.kind in ('doctor_consultation', 'doctor_procedure') then
    v_physician_id := coalesce(new.attending_physician_id, v_visit.attending_physician_id);
    if v_physician_id is null and coalesce(new.doctor_pf_php, 0) > 0 then
      raise exception
        'attending_physician_id required for consult/procedure release on test_request %',
        new.id
        using errcode = 'P0034';
    end if;
  end if;

  -- ---- Account resolution --------------------------------------------------
  -- Revenue account: per kind. Unknown kinds fall through to Suspense + audit.
  v_revenue_account := case v_service.kind
    when 'lab_test'            then '4100'
    when 'lab_package'         then '4100'
    when 'vaccine'             then '4100'
    when 'home_service'        then '4100'
    when 'doctor_consultation' then '4200'
    when 'doctor_procedure'    then '4500'
    else null
  end;

  if v_revenue_account is null then
    -- Unknown kind: route to Suspense and write audit row for operator follow-up.
    -- Matches the Suspense audit pattern in 0033 for RA 10173 traceability.
    v_revenue_account := '9999';
    insert into public.audit_log (
      actor_id, actor_type, action, resource_type, resource_id, metadata
    ) values (
      v_actor,
      'system',
      'coa.suspense_post',
      'test_request',
      new.id,
      jsonb_build_object(
        'reason',       'no mapping for service.kind in bridge_test_request_released',
        'service_kind', v_service.kind,
        'service_id',   v_service.id
      )
    );
  end if;

  -- Discount account: 4920 for doctor kinds, 4910 for all others (lab/vaccine/etc).
  -- Spec §4.1 correctness check #6: 4920 for doctor lines, 4910 for lab lines.
  v_discount_account := case v_service.kind
    when 'doctor_consultation' then '4920'
    when 'doctor_procedure'    then '4920'
    else '4910'
  end;

  -- AR/cash-side account for the DR side of the release JE.
  -- Spec §4.1 correctness check #4: 1100 = AR Patients (NOT 1010 Cash on Hand).
  -- Cash physically moves to 1010 only at payment INSERT via bridge_payment_insert.
  -- Spec §4.1 correctness check #5: 1110 = AR HMO for HMO visits.
  if v_visit.hmo_provider_id is not null then
    v_cash_account := '1110';   -- AR HMO
  else
    v_cash_account := '1100';   -- AR Patients
  end if;

  -- 0140: Manila-local date of the release, not the UTC date `::date` reads.
  -- `now()` itself is UTC in Postgres, so the fallback needs the same
  -- conversion CLAUDE.md requires for a DB date default — never bare `current_date`.
  v_posting_date := coalesce(
    (new.released_at at time zone 'Asia/Manila')::date,
    (now() at time zone 'Asia/Manila')::date
  );

  -- ---- JE header (draft) -----------------------------------------------------
  -- Insert as 'draft' first so je_lines_balance_check (P0001) doesn't fire
  -- while lines are being inserted one by one. Flip to 'posted' after all lines
  -- are in. entry_number assigned explicitly via je_next_number (matches §6.3-6.7
  -- and 12.4 pattern — more explicit; avoids auto-trigger races on bulk operations).
  v_je_number := public.je_next_number(extract(year from v_posting_date)::int);
  insert into public.journal_entries (
    entry_number, posting_date, description, status, source_kind, source_id, created_by
  ) values (
    v_je_number,
    v_posting_date,
    'Test request released: ' || coalesce(v_service.kind, 'unknown'),
    'draft',
    'test_request',
    new.id,
    v_actor
  ) returning id into v_je_id;

  -- ---- Revenue-side lines --------------------------------------------------

  if v_service.kind in ('doctor_consultation', 'doctor_procedure') then
    -- DR: receivable for the full final_price_php (what patient/HMO owes).
    if coalesce(new.final_price_php, 0) > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code(v_cash_account),
        new.final_price_php, 0,
        v_line_order,
        'Release receivable'
      );
      v_line_order := v_line_order + 1;
    end if;

    -- CR: clinic fee + discount → revenue account (4200 or 4500).
    if coalesce(new.clinic_fee_php, 0) + coalesce(new.discount_amount_php, 0) > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code(v_revenue_account),
        0, coalesce(new.clinic_fee_php, 0) + coalesce(new.discount_amount_php, 0),
        v_line_order,
        'Clinic fee (incl. discount absorbed by clinic)'
      );
      v_line_order := v_line_order + 1;
    end if;

    -- CR: doctor PF to 2110 (cash path) or 2160 (HMO holding path).
    if coalesce(new.doctor_pf_php, 0) > 0 then
      if v_visit.hmo_provider_id is null then
        insert into public.journal_lines (
          entry_id, account_id, debit_php, credit_php, line_order, description
        ) values (
          v_je_id,
          public.coa_uuid_for_code('2110'),
          0, new.doctor_pf_php,
          v_line_order,
          'Doctor PF accrual (cash)'
        );
        v_line_order := v_line_order + 1;

        insert into public.doctor_pf_entries (
          test_request_id, physician_id, pf_php,
          recognition_basis, recognized_at, journal_entry_id
        ) values (
          new.id, v_physician_id, new.doctor_pf_php,
          'cash_at_release', now(), v_je_id
        );

      else
        insert into public.journal_lines (
          entry_id, account_id, debit_php, credit_php, line_order, description
        ) values (
          v_je_id,
          public.coa_uuid_for_code('2160'),
          0, new.doctor_pf_php,
          v_line_order,
          'Doctor PF pending HMO settlement'
        );
        v_line_order := v_line_order + 1;

        insert into public.doctor_pf_entries (
          test_request_id, physician_id, pf_php,
          recognition_basis, recognized_at, journal_entry_id
        ) values (
          new.id, v_physician_id, new.doctor_pf_php,
          'hmo_at_settlement',
          null,
          null
        );
      end if;
    end if;

  else
    -- DR: receivable for the final_price_php (what patient owes after discount).
    if coalesce(new.final_price_php, 0) > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code(v_cash_account),
        new.final_price_php, 0,
        v_line_order,
        'Release receivable'
      );
      v_line_order := v_line_order + 1;
    end if;

    -- CR: revenue for the base_price_php (pre-discount amount).
    if coalesce(new.base_price_php, new.final_price_php, 0) > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code(v_revenue_account),
        0, coalesce(new.base_price_php, new.final_price_php),
        v_line_order,
        'Release revenue (base price)'
      );
      v_line_order := v_line_order + 1;
    end if;

  end if;

  -- ---- Discount line (DR contra-revenue) ------------------------------------
  if coalesce(new.discount_amount_php, 0) > 0 then
    insert into public.journal_lines (
      entry_id, account_id, debit_php, credit_php, line_order, description
    ) values (
      v_je_id,
      public.coa_uuid_for_code(v_discount_account),
      new.discount_amount_php, 0,
      v_line_order,
      'Discount'
    );
    v_line_order := v_line_order + 1;
  end if;

  -- ---- Send-out COGS accrual -----------------------------------------------
  if v_service.is_send_out then
    if v_service.send_out_unit_cost_php is not null
       and v_service.send_out_unit_cost_php > 0 then

      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code('6420'),
        v_service.send_out_unit_cost_php, 0,
        v_line_order,
        'Send-out COGS'
      );
      v_line_order := v_line_order + 1;

      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code('2150'),
        0, v_service.send_out_unit_cost_php,
        v_line_order,
        'Accrued send-out'
      );
      v_line_order := v_line_order + 1;

      insert into public.cogs_send_out_entries (
        test_request_id, service_id, vendor_id, unit_cost_php, journal_entry_id
      ) values (
        new.id, v_service.id, v_service.send_out_vendor_id,
        v_service.send_out_unit_cost_php, v_je_id
      );

    else
      insert into public.cogs_send_out_entries (
        test_request_id, service_id, vendor_id, unit_cost_php, journal_entry_id
      ) values (
        new.id, v_service.id, null, 0, null
      );

      insert into public.audit_log (
        actor_id, actor_type, action, resource_type, resource_id, metadata
      ) values (
        null,
        'system',
        'send_out.unit_cost_missing',
        'test_request',
        new.id,
        jsonb_build_object(
          'service_id',   v_service.id,
          'service_code', v_service.code
        )
      );
    end if;
  end if;

  -- ---- Flip to posted -------------------------------------------------------
  update public.journal_entries
    set status = 'posted'
    where id = v_je_id;

  return new;
end;
$function$;

revoke execute on function public.bridge_test_request_released() from public, anon, authenticated;
grant  execute on function public.bridge_test_request_released() to service_role;

-- =============================================================================
-- Finding 12: the corresponding reversal paths, re-created byte-identical to
-- their current bodies (0030 for bridge_payment_void, 0110 for
-- fn_undo_release_bridge) except the posting_date line, so a void or an
-- undo-release posts to the same Manila day its forward posting now does.
-- =============================================================================

create or replace function public.bridge_payment_void()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
begin
  -- Find the original posted payment JE.
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'payment'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_original_je is null then
    -- Defensive: payment was voided but no JE exists. Skip; nothing to reverse.
    return NEW;
  end if;

  -- Insert the reversal header as draft first.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  )
  values (
    -- 0140: Manila-local date of the void, not the UTC date `::date` reads.
    (NEW.voided_at at time zone 'Asia/Manila')::date,
    'Reversal of ' || v_orig_number || ': ' || coalesce(NEW.void_reason, '(no reason)'),
    'draft',
    'reversal',
    null,
    v_original_je,
    NEW.voided_by
  )
  returning id into v_reversal_je;

  -- Mirror original lines with swapped debit/credit.
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  select v_reversal_je, account_id, credit_php, debit_php, line_order
    from public.journal_lines
    where entry_id = v_original_je
    order by line_order;

  update public.journal_entries set status = 'posted' where id = v_reversal_je;
  update public.journal_entries
     set status = 'reversed', reversed_by = v_reversal_je
   where id = v_original_je;

  return NEW;
end;
$$;

revoke execute on function public.bridge_payment_void() from public, anon, authenticated;
grant  execute on function public.bridge_payment_void() to service_role;

create or replace function public.fn_undo_release_bridge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid;
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
  v_header       record;
begin
  v_actor := auth.uid();

  -- ---- 1. Accounting reversal (pattern: 0064 bridge_test_request_cancelled) --
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'test_request' and source_id = new.id and status = 'posted'
    for update;

  if v_original_je is not null then
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, reverses, created_by
    ) values (
      -- 0140: Manila-local date of the undo, not the UTC date `current_date` reads.
      (now() at time zone 'Asia/Manila')::date,
      'Reversal of ' || v_orig_number || ': release undone',
      'draft', 'reversal', null, v_original_je, v_actor
    ) returning id into v_reversal_je;

    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    select v_reversal_je, account_id, credit_php, debit_php, line_order
      from public.journal_lines where entry_id = v_original_je order by line_order;

    update public.journal_entries set status = 'posted' where id = v_reversal_je;
    update public.journal_entries
       set status = 'reversed', reversed_by = v_reversal_je
     where id = v_original_je;
  end if;

  update public.doctor_pf_entries
     set voided_at = now(), voided_by = v_actor, void_reason = 'release_undone'
   where test_request_id = new.id and voided_at is null;

  update public.cogs_send_out_entries
     set voided_at = now(), voided_by = v_actor, void_reason = 'release_undone'
   where test_request_id = new.id and voided_at is null;

  -- ---- 2. Package cascade ---------------------------------------------------
  if new.parent_id is not null then
    select id, status into v_header
      from public.test_requests where id = new.parent_id for update;

    -- Clear the completion stamp; fn_set_package_completed_at's IS NULL guard
    -- re-stamps correctly on re-completion.
    update public.test_requests
       set package_completed_at = null
     where id = new.parent_id and package_completed_at is not null;

    if v_header.status = 'released' then
      -- Re-fires this trigger for the header's own JE reversal.
      update public.test_requests
         set status = 'ready_for_release',
             released_at = null, released_by = null, release_medium = null
       where id = new.parent_id;

      -- Traceability: the human reason lives on the component's audit row
      -- (written by the server action); this system row marks the cascade.
      insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
      values (
        v_actor, 'system', 'test_request.release_undone', 'test_request', new.parent_id,
        jsonb_build_object('cascaded_from', new.id, 'visit_id', new.visit_id)
      );
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_undo_release_bridge() from public, anon, authenticated;
grant  execute on function public.fn_undo_release_bridge() to service_role;

-- ---- Backfill: correct posting_date on any JE booked with the pre-fix bug -
-- See the header comment (findings 7 and 10) for why each piece below exists.
-- Every clause is guarded to affect 0 rows and never raise on an empty or
-- missing table, required for a clean replay on an empty DB.

-- Payments: received_at never changes after insert — a void creates a new
-- 'reversal' JE rather than mutating the original 'payment' JE's stored
-- event time — so every payments-sourced JE's true event timestamp is still
-- exactly p.received_at, regardless of the payment's current void state.
-- Rows whose corrected date would land in a CLOSED period are left alone
-- (Finding 7) and reported instead of applied.
with payment_candidates as (
  select je.id, je.posting_date as old_date,
         (p.received_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries je
  join public.payments p on p.id = je.source_id
  where je.source_kind = 'payment'
    and je.posting_date is distinct from (p.received_at at time zone 'Asia/Manila')::date
),
payment_skipped as (
  select * from payment_candidates
  where public.period_status_for(new_date) = 'closed'
),
payment_applied as (
  update public.journal_entries je
  set posting_date = c.new_date
  from payment_candidates c
  where je.id = c.id
    and public.period_status_for(c.new_date) is distinct from 'closed'
  returning je.id
)
insert into public.audit_log (
  actor_id, actor_type, action, resource_type, resource_id, metadata
)
select
  null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'payment',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from payment_skipped s;

-- Test-request releases: tr.released_at is OVERWRITTEN on every (re-)release,
-- so it only reliably describes the event behind the JE CURRENTLY in
-- status = 'posted' for that test_request (journal_entries_one_posted_
-- per_source, 0030, guarantees at most one such row). A row left in
-- status = 'reversed' predates an undo-and-re-release; its true original
-- event time can no longer be established from test_requests, so it is left
-- untouched and reported rather than corrected with the wrong timestamp
-- (Finding 10). Among the 'posted' rows, one whose corrected date would
-- land in a CLOSED period is also left alone and reported (Finding 7).
with release_candidates as (
  select je.id, je.posting_date as old_date,
         (tr.released_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries je
  join public.test_requests tr on tr.id = je.source_id
  where je.source_kind = 'test_request'
    and je.status = 'posted'
    and tr.released_at is not null
    and je.posting_date is distinct from (tr.released_at at time zone 'Asia/Manila')::date
),
release_skipped as (
  select * from release_candidates
  where public.period_status_for(new_date) = 'closed'
),
release_applied as (
  update public.journal_entries je
  set posting_date = c.new_date
  from release_candidates c
  where je.id = c.id
    and public.period_status_for(c.new_date) is distinct from 'closed'
  returning je.id
),
release_unresolvable as (
  select je.id, je.posting_date as old_date, tr.id as test_request_id
  from public.journal_entries je
  join public.test_requests tr on tr.id = je.source_id
  where je.source_kind = 'test_request'
    and je.status = 'reversed'
)
insert into public.audit_log (
  actor_id, actor_type, action, resource_type, resource_id, metadata
)
select
  null::uuid, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'test_request',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from release_skipped s
union all
select
  null::uuid, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', u.id,
  jsonb_build_object(
    'reason', 'original_event_timestamp_unknown_after_undo_release',
    'source_kind', 'test_request',
    'test_request_id', u.test_request_id,
    'stored_posting_date', u.old_date
  )
from release_unresolvable u;

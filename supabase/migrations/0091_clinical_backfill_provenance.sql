-- 0091_clinical_backfill_provenance.sql
-- Historical clinical backfill provenance + GL-silence.
--
-- Adds legacy_import_run_id / legacy_source_ref to the three operational
-- tables written by the backfill, and short-circuits the three insert-path
-- trigger functions so legacy rows DO NOT post journal entries or get blocked
-- by EOD locks. recalc_visit_payment + maintain_repeat_patient_flag stay live.
--
-- IMPORTANT: the two GL-bridge function bodies below were re-created from the
-- CURRENT prod source (pg_get_functiondef on qhptbmafrosgibooelpp, 2026-06-03),
-- NOT from 0030 — bridge_test_request_released has evolved substantially since
-- 0030 (P0034 physician guard, je_next_number, consult split, doctor PF
-- subledger, send-out COGS). Only the legacy short-circuit at the very top is
-- new; everything else is byte-equivalent to prod. Re-diff against prod if this
-- migration is ever revisited.
--
-- See docs/superpowers/specs/2026-06-03-historical-clinical-backfill-design.md

-- ---- provenance columns ----------------------------------------------------
alter table public.visits
  add column legacy_import_run_id uuid references public.legacy_import_runs(id),
  add column legacy_source_ref text;
alter table public.test_requests
  add column legacy_import_run_id uuid references public.legacy_import_runs(id),
  add column legacy_source_ref text;
alter table public.payments
  add column legacy_import_run_id uuid references public.legacy_import_runs(id),
  add column legacy_source_ref text;

create unique index visits_legacy_source_ref_key
  on public.visits (legacy_source_ref) where legacy_source_ref is not null;
create unique index test_requests_legacy_source_ref_key
  on public.test_requests (legacy_source_ref) where legacy_source_ref is not null;
create unique index payments_legacy_source_ref_key
  on public.payments (legacy_source_ref) where legacy_source_ref is not null;

create index idx_visits_legacy_run on public.visits (legacy_import_run_id)
  where legacy_import_run_id is not null;
create index idx_test_requests_legacy_run on public.test_requests (legacy_import_run_id)
  where legacy_import_run_id is not null;
create index idx_payments_legacy_run on public.payments (legacy_import_run_id)
  where legacy_import_run_id is not null;

-- ---- guard: payment GL bridge ----------------------------------------------
-- Re-created from current prod source with a legacy short-circuit at the top.
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
    NEW.received_at::date,
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

-- ---- guard: EOD lock check -------------------------------------------------
-- Re-created from current prod source. Trigger is BEFORE INSERT OR UPDATE (no
-- DELETE), so NEW is always present; the legacy guard reads NEW directly.
create or replace function public.payments_block_after_close()
returns trigger
language plpgsql
as $function$
declare
  v_date date;
  v_shift_id uuid;
begin
  -- Legacy backfill rows bypass EOD locks (backdated provenance data).
  if NEW.legacy_import_run_id is not null then
    return NEW;
  end if;

  v_date := (coalesce(NEW.received_at, OLD.received_at) at time zone 'Asia/Manila')::date;
  select id into v_shift_id
    from public.cash_shifts
    where is_active = true
    order by sort_order, code
    limit 1;
  if v_shift_id is null then
    return coalesce(NEW, OLD);
  end if;
  perform public.eod_lock_check(v_date, v_shift_id);
  return coalesce(NEW, OLD);
end;
$function$;

-- ---- guard: test_request release bridge (defensive) ------------------------
-- INSERT-as-released never fires this (it is an AFTER UPDATE trigger with a
-- WHEN(old.status<>'released' AND new.status='released') clause), but guard so
-- a future UPDATE that re-releases a legacy row stays GL-silent too.
-- Body re-created from CURRENT prod source (12.5 / PF-COGS era) — only the
-- legacy short-circuit at the very top is new.
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
  -- attending_physician_id is required for consult/procedure at release.
  -- COALESCE reads the per-line override first, then the visit-level default.
  if v_service.kind in ('doctor_consultation', 'doctor_procedure') then
    v_physician_id := coalesce(new.attending_physician_id, v_visit.attending_physician_id);
    if v_physician_id is null then
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

  v_posting_date := coalesce(new.released_at::date, current_date);

  -- ---- JE header (draft) ---------------------------------------------------
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
    -- Split JE for consult/procedure:
    --   DR cash_account                          final_price_php    (receivable)
    --   CR revenue account (4200/4500)           clinic_fee_php + discount_amount_php
    --   CR 2110 or 2160                          doctor_pf_php       (cash: AP-Doctors / HMO: holding)
    --   DR discount account (4920)               discount_amount_php (if > 0; contra-revenue)
    --
    -- Balance check (12.5.1c policy: discount absorbed by clinic share, not PF):
    --   DR = final_price_php + discount_amount_php
    --   CR = (clinic_fee_php + discount_amount_php) + doctor_pf_php
    --      = clinic_fee_php + doctor_pf_php + discount_amount_php
    --      = final_price_php + discount_amount_php  ✓  (because clinic_fee + pf = final)
    --
    -- Zero-amount lines are skipped (shareholder doctors have clinic_fee=0;
    -- edge cases may have doctor_pf=0).

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
    -- Clinic absorbs the full discount (doctor PF is always at full amount).
    -- Skipped for shareholder doctors where clinic_fee_php = 0 AND discount = 0.
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
    -- Also insert the doctor_pf_entries subledger row.
    if coalesce(new.doctor_pf_php, 0) > 0 then
      if v_visit.hmo_provider_id is null then
        -- Cash visit: accrue directly to 2110 AP — Doctors (recognized immediately).
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
        -- HMO visit: park PF in 2160 Doctor PF Pending HMO Settlement.
        -- Recognition + 2160→2110 reclassification fires later via
        -- trg_bridge_pf_at_hmo_allocation (Section 6.3, T12).
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
          null,  -- recognized_at fires at hmo_payment_allocations INSERT
          null   -- journal_entry_id populated at that time too
        );
      end if;
    end if;

  else
    -- All other kinds (lab_test, lab_package, vaccine, home_service, etc.):
    -- Standard contra-revenue pattern:
    --   DR cash_account       final_price_php    (receivable = what patient/HMO owes)
    --   CR revenue_account    base_price_php     (= final + discount; pre-discount revenue)
    --   DR discount_account   discount_amount_php (if > 0; contra-revenue 4910)
    -- Balance: DR = final + discount = base = CR ✓
    -- Uses base_price_php (not final_price_php) to correctly credit revenue at the
    -- pre-discount amount, matching the 0030 pattern.

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
    -- base_price_php = final_price_php + discount_amount_php.
    -- When no discount, base = final. Falls back to final_price_php if base is null
    -- (should not happen for well-formed data, but defensive).
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
  -- Standard contra-revenue debit. Guards against zero-amount line.
  -- For consults: discount absorbed by clinic share (CR revenue already includes
  -- discount in the clinic_fee + discount line above). For non-consults: revenue
  -- was credited at base_price_php so this DR restores the net to final.
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
  -- Appended to the same JE for ALL service kinds where is_send_out=true.
  -- D10: if unit_cost is NULL or 0, do NOT emit COGS JE lines. Still insert
  -- a cogs_send_out_entries row (unit_cost_php=0, journal_entry_id=null) for
  -- admin visibility and the missing-cost banner/badge count.
  if v_service.is_send_out then
    if v_service.send_out_unit_cost_php is not null
       and v_service.send_out_unit_cost_php > 0 then

      -- DR 6420 Send Out / CR 2150 Accrued Send-Out
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
      -- D10 fallback: unit_cost is NULL or 0. Record subledger row for visibility;
      -- emit no JE lines (avoids blocking the release at the counter). Admin
      -- resolves via /staff/admin/accounting/cogs/send-outs/unconfigured.
      insert into public.cogs_send_out_entries (
        test_request_id, service_id, vendor_id, unit_cost_php, journal_entry_id
      ) values (
        new.id, v_service.id, null, 0, null
      );

      -- Audit for RA 10173 traceability + admin banner count.
      -- actor_id=null is intentional: auth.uid() may be null in SECURITY DEFINER
      -- context called by the service-role client; audit_log.actor_id is nullable.
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
  -- je_status_balance_check fires on this UPDATE and validates that
  -- sum(debit_php) = sum(credit_php) across all lines. If the JE is unbalanced
  -- (e.g., clinic_fee + doctor_pf_php != final_price_php due to bad data), it
  -- will raise P0001 here and the trigger will roll back cleanly.
  update public.journal_entries
    set status = 'posted'
    where id = v_je_id;

  return new;
end;
$function$;

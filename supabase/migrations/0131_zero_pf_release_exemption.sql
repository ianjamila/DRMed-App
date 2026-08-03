-- =============================================================================
-- 0131 — Exempt zero-PF doctor lines from the P0034 physician requirement
-- =============================================================================
-- Intake (PR E, locked decision) deliberately admits a procedure line with no
-- attending physician when its doctor PF is ₱0 — the fee is fully absorbed by
-- the clinic, so there is nobody to accrue PF to. The release-side P0034 guard
-- (0064, carried through 0091/0109) contradicted that: it demanded a physician
-- for EVERY consult/procedure line, dead-ending release of visits intake had
-- legitimately accepted. This migration aligns release with intake: P0034 now
-- fires only when the line actually accrues PF (coalesce(doctor_pf_php,0) > 0).
--
-- Safe because the only consumer of v_physician_id is the doctor_pf_entries
-- insert, which is already gated on coalesce(new.doctor_pf_php, 0) > 0 — a
-- null physician is never written anywhere when the exemption applies.
--
-- Full function body below is 0109's text with only the P0034 guard changed.
-- CREATE OR REPLACE retains the existing ACL (0118's revoke from public/anon/
-- authenticated stays in force).

CREATE OR REPLACE FUNCTION public.bridge_test_request_released()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

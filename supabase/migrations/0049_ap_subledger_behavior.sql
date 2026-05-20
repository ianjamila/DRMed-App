-- 0049_ap_subledger_behavior.sql
-- Phase 12.4 — AP Subledger — Behavior layer.
-- Functions, triggers, and bridge wiring. Schema lives in 0048.
-- Design spec: docs/superpowers/specs/2026-05-20-12.4-ap-subledger-design.md

-- ==========================================================================
-- Section 1 — Helper trigger functions.
-- ==========================================================================

-- Shared updated_at trigger function (reused across vendors, bills,
-- bill_payments, recurring_bill_templates — wired up in Section 8).
create or replace function public.ap_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Atomic counter increment for BL-YYYY-NNNN bill numbering.
-- ON CONFLICT path increments-then-returns; the first INSERT (no conflict)
-- returns 1. So v_next is always the bill number to format.
create or replace function public.ap_next_bill_number()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year int := extract(year from (now() at time zone 'Asia/Manila'))::int;
  v_next int;
begin
  insert into public.bill_year_counters (year, next_n)
  values (v_year, 1)
  on conflict (year) do update set next_n = bill_year_counters.next_n + 1
  returning next_n into v_next;

  return format('BL-%s-%s', v_year::text, lpad(v_next::text, 4, '0'));
end;
$$;

-- Atomic counter increment for BP-YYYY-NNNN bill_payment numbering.
create or replace function public.ap_next_payment_number()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year int := extract(year from (now() at time zone 'Asia/Manila'))::int;
  v_next int;
begin
  insert into public.bill_payment_year_counters (year, next_n)
  values (v_year, 1)
  on conflict (year) do update set next_n = bill_payment_year_counters.next_n + 1
  returning next_n into v_next;

  return format('BP-%s-%s', v_year::text, lpad(v_next::text, 4, '0'));
end;
$$;

-- BEFORE INSERT on bills: assign bill_number if null/empty.
create or replace function public.ap_assign_bill_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.bill_number is null or new.bill_number = '' then
    new.bill_number := public.ap_next_bill_number();
  end if;
  return new;
end;
$$;

-- BEFORE INSERT on bill_payments: assign payment_number if null/empty.
create or replace function public.ap_assign_payment_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_number is null or new.payment_number = '' then
    new.payment_number := public.ap_next_payment_number();
  end if;
  return new;
end;
$$;

-- ==========================================================================
-- Section 2 — Recompute triggers.
-- ==========================================================================

-- Recompute bills.gross_amount from sum of its bill_lines.
-- Fires AFTER INSERT/UPDATE/DELETE on bill_lines. NEW.bill_id on insert/update,
-- OLD.bill_id on delete.
create or replace function public.ap_recompute_bill_gross()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_id uuid := coalesce(new.bill_id, old.bill_id);
begin
  update public.bills
  set gross_amount = coalesce((
    select sum(amount_php) from public.bill_lines where bill_id = v_bill_id
  ), 0)
  where id = v_bill_id;

  return null;
end;
$$;

-- Recompute bills.paid_amount + bidirectionally flip status
-- (posted ↔ partially_paid ↔ paid). Only counts non-voided allocations.
-- Draft and voided bills are skipped (their status is managed by the
-- bill lifecycle, not by allocation activity).
create or replace function public.ap_recompute_bill_paid_and_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_id        uuid := coalesce(new.bill_id, old.bill_id);
  v_paid           numeric(12,2);
  v_net_payable    numeric(12,2);
  v_current_status text;
  v_new_status     text;
begin
  -- Sum non-voided allocations for this bill; fetch bill's net_payable + status.
  select
    coalesce((
      select sum(allocated_amount)
      from public.bill_payment_allocations
      where bill_id = v_bill_id and voided_at is null
    ), 0),
    b.net_payable,
    b.status
  into v_paid, v_net_payable, v_current_status
  from public.bills b
  where b.id = v_bill_id;

  -- Skip status update for draft/voided bills; just update paid_amount.
  if v_current_status in ('draft', 'voided') then
    update public.bills set paid_amount = v_paid where id = v_bill_id;
    return null;
  end if;

  -- Determine new status (bidirectional flip).
  if v_paid >= v_net_payable and v_net_payable > 0 then
    v_new_status := 'paid';
  elsif v_paid > 0 then
    v_new_status := 'partially_paid';
  else
    v_new_status := 'posted';
  end if;

  update public.bills
  set paid_amount = v_paid, status = v_new_status
  where id = v_bill_id;

  return null;
end;
$$;

-- ==========================================================================
-- Section 3 — Cascade triggers.
-- ==========================================================================

-- When a bill_payment is marked voided, soft-mark its allocations as voided.
-- The recompute trigger on allocations then re-evaluates affected bills,
-- bidirectionally flipping their status (paid → partially_paid → posted).
-- Fires AFTER UPDATE OF voided_at ON bill_payments (wired in T15).
create or replace function public.ap_bill_payment_void_cascade()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.voided_at is null and new.voided_at is not null then
    update public.bill_payment_allocations
    set voided_at = new.voided_at
    where payment_id = new.id and voided_at is null;
  end if;
  return new;
end;
$$;

-- ==========================================================================
-- Section 4 — Constraint trigger for allocation invariants
-- (deferred to transaction commit; wired in T15 with
--  DEFERRABLE INITIALLY DEFERRED).
-- ==========================================================================

-- Validates four invariants for bill_payment_allocations rows.
-- P0014: sum of non-voided allocations per payment must equal payment.amount_php
-- P0015: sum of non-voided allocations per bill must not exceed bill.net_payable
-- P0016: allocation.bill.vendor_id must equal allocation.payment.vendor_id
-- P0017: allocation's bill.status must be in ('posted', 'partially_paid', 'paid')
--        (allow 'paid' because recompute may have flipped status mid-transaction)
create or replace function public.ap_validate_bill_payment_allocations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id      uuid := coalesce(new.payment_id, old.payment_id);
  v_bill_id         uuid := coalesce(new.bill_id, old.bill_id);
  v_alloc_sum_pay   numeric(12,2);
  v_alloc_sum_bill  numeric(12,2);
  v_payment_amount  numeric(12,2);
  v_payment_vendor  uuid;
  v_bill_net        numeric(12,2);
  v_bill_status     text;
  v_bill_vendor     uuid;
begin
  -- If the payment row no longer exists (cascade-delete via payment_id FK
  -- on bill_payment_allocations), nothing to validate.
  select amount_php, vendor_id
    into v_payment_amount, v_payment_vendor
  from public.bill_payments
  where id = v_payment_id;

  if v_payment_amount is null then
    return null;
  end if;

  -- P0014: sum per payment (active allocations only) = payment.amount_php
  select coalesce(sum(allocated_amount), 0)
    into v_alloc_sum_pay
  from public.bill_payment_allocations
  where payment_id = v_payment_id and voided_at is null;

  if v_alloc_sum_pay <> v_payment_amount then
    raise exception 'Allocation total (%) does not match payment amount (%).',
      v_alloc_sum_pay, v_payment_amount
      using errcode = 'P0014';
  end if;

  -- The remaining three checks only apply when a bill is involved.
  -- DELETE operations may not have a bill_id (if the parent bill was also
  -- deleted in the same transaction), so we tolerate that here too.
  if v_bill_id is not null then
    select coalesce(sum(allocated_amount), 0)
      into v_alloc_sum_bill
    from public.bill_payment_allocations
    where bill_id = v_bill_id and voided_at is null;

    select net_payable, status, vendor_id
      into v_bill_net, v_bill_status, v_bill_vendor
    from public.bills
    where id = v_bill_id;

    -- If the bill row vanished, skip (cascade scenario).
    if v_bill_status is null then
      return null;
    end if;

    -- P0015: sum per bill <= bill.net_payable
    if v_alloc_sum_bill > v_bill_net then
      raise exception 'Allocation total (%) exceeds bill net payable (%).',
        v_alloc_sum_bill, v_bill_net
        using errcode = 'P0015';
    end if;

    -- P0016: vendor match
    if v_payment_vendor <> v_bill_vendor then
      raise exception 'Allocation bill vendor (%) does not match payment vendor (%).',
        v_bill_vendor, v_payment_vendor
        using errcode = 'P0016';
    end if;

    -- P0017: bill status must be a live state.
    -- (Include 'paid' because the recompute trigger may have flipped the
    -- status mid-transaction; the deferred validation fires at commit.)
    if v_bill_status not in ('posted', 'partially_paid', 'paid') then
      raise exception 'Cannot allocate to bill in status %.', v_bill_status
        using errcode = 'P0017';
    end if;
  end if;

  return null;
end;
$$;

-- ==========================================================================
-- Section 5 — Guard trigger (P0013).
-- Wired in T15 as BEFORE UPDATE ON bills
--   WHEN (old.status is distinct from 'voided' and new.status = 'voided').
-- ==========================================================================

-- P0013: a bill being voided must have no active (non-voided) payments
-- allocated to it. Forces admin to void payments first, preserving the
-- audit trail. Active = allocation.voided_at IS NULL AND parent
-- bill_payment.voided_at IS NULL.
create or replace function public.ap_bill_void_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active_count int;
begin
  select count(*)
    into v_active_count
  from public.bill_payment_allocations a
  join public.bill_payments p on p.id = a.payment_id
  where a.bill_id = new.id
    and a.voided_at is null
    and p.voided_at is null;

  if v_active_count > 0 then
    raise exception 'Bill % has % active payment(s); void payments first.',
      new.bill_number, v_active_count
      using errcode = 'P0013';
  end if;

  return new;
end;
$$;

-- ==========================================================================
-- Section 6 — Bridge trigger functions
-- (post balanced JEs to journal_entries / journal_lines).
-- ==========================================================================

-- Posts the bill_post JE when bills.status transitions draft → posted.
-- One DR per bill_line, one CR on 2340 (if wt > 0), one CR on 2100 for net.
create or replace function public.ap_bill_post_bridge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_je_id        uuid;
  v_vendor_name  text;
  v_ap_acct      uuid;
  v_wt_acct      uuid;
  v_line_order   int := 1;
  v_line         record;
begin
  -- Resolve vendor name + the two fixed CoA accounts.
  select name into v_vendor_name from public.vendors where id = new.vendor_id;
  select public.coa_uuid_for_code('2100') into v_ap_acct;
  if new.wt_amount > 0 then
    select public.coa_uuid_for_code('2340') into v_wt_acct;
  end if;

  -- Insert JE header as draft. entry_number auto-assigned by trigger.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  ) values (
    new.bill_date,
    format('Bill %s — %s — %s', new.bill_number, v_vendor_name, coalesce(new.description, '')),
    'draft',
    'bill_post',
    new.id,
    new.posted_by
  ) returning id into v_je_id;

  -- DR lines (one per bill_line, in line_no order).
  for v_line in
    select line_no, amount_php, account_id, description
      from public.bill_lines
      where bill_id = new.id
      order by line_no
  loop
    insert into public.journal_lines (
      entry_id, line_order, account_id, debit_php, credit_php, description
    ) values (
      v_je_id, v_line_order, v_line.account_id, v_line.amount_php, 0,
      coalesce(v_line.description, format('Bill line %s', v_line.line_no))
    );
    v_line_order := v_line_order + 1;
  end loop;

  -- CR 2340 for WT (if applicable).
  if new.wt_amount > 0 then
    insert into public.journal_lines (
      entry_id, line_order, account_id, debit_php, credit_php, description
    ) values (
      v_je_id, v_line_order, v_wt_acct, 0, new.wt_amount,
      format('WT %s (%s)', new.wt_rate, coalesce(new.wt_classification, ''))
    );
    v_line_order := v_line_order + 1;
  end if;

  -- CR 2100 for net_payable.
  insert into public.journal_lines (
    entry_id, line_order, account_id, debit_php, credit_php, description
  ) values (
    v_je_id, v_line_order, v_ap_acct, 0, new.net_payable, 'AP — Trade'
  );

  -- Flip JE to posted (triggers balance check + closed-period check).
  update public.journal_entries set status = 'posted' where id = v_je_id;

  return new;
end;
$$;

-- Posts the bill_payment JE when a bill_payment is inserted.
-- DR 2100 AP — Trade, CR cash_account_id.
create or replace function public.ap_bill_payment_bridge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_je_id        uuid;
  v_vendor_name  text;
  v_ap_acct      uuid;
  v_method_ref   text;
begin
  select name into v_vendor_name from public.vendors where id = new.vendor_id;
  select public.coa_uuid_for_code('2100') into v_ap_acct;

  v_method_ref := case
    when new.method = 'cheque' then format('Cheque #%s', new.cheque_number)
    when new.reference is not null and new.reference <> ''
      then format('%s #%s', new.method, new.reference)
    else new.method
  end;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  ) values (
    new.payment_date,
    format('Payment %s — %s — %s', new.payment_number, v_vendor_name, v_method_ref),
    'draft',
    'bill_payment',
    new.id,
    new.created_by
  ) returning id into v_je_id;

  insert into public.journal_lines (
    entry_id, line_order, account_id, debit_php, credit_php, description
  ) values
    (v_je_id, 1, v_ap_acct, new.amount_php, 0, 'AP — Trade'),
    (v_je_id, 2, new.cash_account_id, 0, new.amount_php, v_method_ref);

  update public.journal_entries set status = 'posted' where id = v_je_id;

  return new;
end;
$$;

-- Helper: post a reversal JE for an existing posted bridge JE.
-- Called from the void PG functions in T12-T14 (ap_void_bill_with_guard,
-- ap_void_bill_payment_cascade). Returns the reversal JE id.
create or replace function public.ap_reverse_je_for_source(
  p_source_kind text,
  p_source_id   uuid,
  p_actor_id    uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orig_je_id   uuid;
  v_orig_number  text;
  v_orig_desc    text;
  v_rev_je_id    uuid;
begin
  -- Find the original posted JE for this source.
  select id, entry_number, description
    into v_orig_je_id, v_orig_number, v_orig_desc
  from public.journal_entries
  where source_kind = p_source_kind::public.je_source_kind
    and source_id = p_source_id
    and status = 'posted'
  for update;

  if v_orig_je_id is null then
    raise exception 'No posted JE found for source % (%)',
      p_source_kind, p_source_id;
  end if;

  -- Insert reversal header as draft. source_id is null on reversals;
  -- linkage is via the reverses column.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  ) values (
    (now() at time zone 'Asia/Manila')::date,
    format('Reversal of %s: %s', v_orig_number, v_orig_desc),
    'draft',
    'reversal',
    null,
    v_orig_je_id,
    p_actor_id
  ) returning id into v_rev_je_id;

  -- Mirror original lines with debit/credit swapped.
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order, description)
  select v_rev_je_id, account_id, credit_php, debit_php, line_order,
         format('REV: %s', coalesce(description, ''))
    from public.journal_lines
    where entry_id = v_orig_je_id
    order by line_order;

  -- Flip reversal to posted (validates balance).
  update public.journal_entries set status = 'posted' where id = v_rev_je_id;

  -- Flip original to reversed, link reversal back.
  update public.journal_entries
    set status = 'reversed', reversed_by = v_rev_je_id
    where id = v_orig_je_id;

  return v_rev_je_id;
end;
$$;

-- ==========================================================================
-- Section 7 — Atomic-op PG functions for bill lifecycle.
-- All take p_actor_id (staff_profiles.id) for audit context. All return jsonb.
-- ==========================================================================

-- Insert a draft bill + its lines atomically.
-- p_input shape:
--   { vendor_id, vendor_invoice_number, bill_date, due_date, description,
--     wt_classification, wt_rate, wt_exempt,
--     lines: [{ line_no, description, amount_php, account_id }, ...] }
create or replace function public.ap_create_bill_draft(
  p_input    jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_id uuid;
  v_line    jsonb;
begin
  insert into public.bills (
    vendor_id, vendor_invoice_number, bill_date, due_date, description,
    wt_classification, wt_rate, wt_exempt,
    created_by, updated_by
  ) values (
    (p_input->>'vendor_id')::uuid,
    p_input->>'vendor_invoice_number',
    (p_input->>'bill_date')::date,
    (p_input->>'due_date')::date,
    p_input->>'description',
    p_input->>'wt_classification',
    nullif(p_input->>'wt_rate', '')::numeric(5,4),
    coalesce((p_input->>'wt_exempt')::boolean, false),
    p_actor_id, p_actor_id
  ) returning id into v_bill_id;

  for v_line in select * from jsonb_array_elements(p_input->'lines')
  loop
    insert into public.bill_lines (
      bill_id, line_no, description, amount_php, account_id
    ) values (
      v_bill_id,
      (v_line->>'line_no')::int,
      v_line->>'description',
      (v_line->>'amount_php')::numeric(12,2),
      (v_line->>'account_id')::uuid
    );
  end loop;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill.created', 'bill', v_bill_id,
          jsonb_build_object('status', 'draft'));

  return jsonb_build_object('bill_id', v_bill_id);
end;
$$;

-- Create + post in one transaction.
-- After the draft INSERT, the recompute trigger has set bills.gross_amount.
-- We compute wt_amount = ROUND(gross * rate, 2), write it, and flip to posted
-- (which fires the bill_post_bridge trigger).
create or replace function public.ap_create_bill_and_post(
  p_input    jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_id   uuid;
  v_result    jsonb;
  v_gross     numeric(12,2);
  v_rate      numeric(5,4);
  v_exempt    boolean;
  v_wt        numeric(12,2) := 0;
begin
  -- Step 1-2: draft + lines via the dedicated function.
  v_result := public.ap_create_bill_draft(p_input, p_actor_id);
  v_bill_id := (v_result->>'bill_id')::uuid;

  -- Step 3: read denormed gross_amount + WT params; compute wt_amount.
  select gross_amount, wt_rate, wt_exempt
    into v_gross, v_rate, v_exempt
    from public.bills where id = v_bill_id;

  if v_gross <= 0 then
    raise exception 'Cannot post bill with non-positive gross_amount (got %)', v_gross
      using errcode = 'P0002';
  end if;

  if not v_exempt and v_rate is not null and v_rate > 0 then
    v_wt := round(v_gross * v_rate, 2);
  end if;

  update public.bills
    set wt_amount = v_wt
    where id = v_bill_id;

  -- Step 4: flip to posted (fires ap_bill_post_bridge trigger).
  update public.bills
    set status = 'posted', posted_at = now(), posted_by = p_actor_id
    where id = v_bill_id;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill.posted', 'bill', v_bill_id,
          jsonb_build_object('wt_amount', v_wt, 'gross_amount', v_gross));

  return jsonb_build_object('bill_id', v_bill_id);
end;
$$;

-- Update a draft bill: replace header + lines. Status must be 'draft'.
-- Posted bills cannot be edited (P0004 from 12.2 trigger blocks; we raise
-- an earlier, clearer error here).
create or replace function public.ap_update_bill_draft(
  p_bill_id  uuid,
  p_input    jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_line   jsonb;
begin
  select status into v_status from public.bills where id = p_bill_id for update;

  if v_status is null then
    raise exception 'Bill % not found', p_bill_id using errcode = 'P0002';
  end if;
  if v_status <> 'draft' then
    raise exception 'Cannot edit bill in status %; use void+rebill', v_status
      using errcode = 'P0004';
  end if;

  update public.bills set
    vendor_id              = (p_input->>'vendor_id')::uuid,
    vendor_invoice_number  = p_input->>'vendor_invoice_number',
    bill_date              = (p_input->>'bill_date')::date,
    due_date               = (p_input->>'due_date')::date,
    description            = p_input->>'description',
    wt_classification      = p_input->>'wt_classification',
    wt_rate                = nullif(p_input->>'wt_rate', '')::numeric(5,4),
    wt_exempt              = coalesce((p_input->>'wt_exempt')::boolean, false),
    updated_by             = p_actor_id,
    updated_at             = now()
    where id = p_bill_id;

  -- Replace lines (delete then re-insert; recompute trigger handles gross).
  delete from public.bill_lines where bill_id = p_bill_id;

  for v_line in select * from jsonb_array_elements(p_input->'lines')
  loop
    insert into public.bill_lines (
      bill_id, line_no, description, amount_php, account_id
    ) values (
      p_bill_id,
      (v_line->>'line_no')::int,
      v_line->>'description',
      (v_line->>'amount_php')::numeric(12,2),
      (v_line->>'account_id')::uuid
    );
  end loop;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill.updated', 'bill', p_bill_id, p_input);

  return jsonb_build_object('bill_id', p_bill_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Section 7 (cont.) — payment-flow atomic ops
-- ---------------------------------------------------------------------------

-- Create + post + pay-in-full + single allocation, all atomic.
-- p_input shape: bill fields (vendor_id, vendor_invoice_number, bill_date, due_date,
--                description, wt_classification, wt_rate, wt_exempt, lines)
--              + payment fields (vendor_id [redundant; pull from bill], payment_date,
--                method, cash_account_id, reference, cheque_number, cheque_date)
create or replace function public.ap_create_bill_paid_on_entry(
  p_input    jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_id      uuid;
  v_payment_id   uuid;
  v_request_id   uuid := gen_random_uuid();
  v_net_payable  numeric(12,2);
begin
  -- Step 1-4: bill draft + lines + wt_amount compute + status='posted'.
  v_bill_id := (public.ap_create_bill_and_post(p_input, p_actor_id)->>'bill_id')::uuid;

  -- Read the now-frozen net_payable.
  select net_payable into v_net_payable from public.bills where id = v_bill_id;

  -- Step 5: create payment (fires ap_bill_payment_bridge when T15 lands).
  insert into public.bill_payments (
    vendor_id, payment_date, method, cash_account_id, amount_php,
    reference, cheque_number, cheque_date, created_by, updated_by
  ) values (
    (p_input->>'vendor_id')::uuid,
    (p_input->>'payment_date')::date,
    p_input->>'method',
    (p_input->>'cash_account_id')::uuid,
    v_net_payable,
    p_input->>'reference',
    p_input->>'cheque_number',
    nullif(p_input->>'cheque_date', '')::date,
    p_actor_id, p_actor_id
  ) returning id into v_payment_id;

  -- Step 6: single allocation for full net_payable.
  -- Recompute trigger fires; status flips to 'paid'.
  -- Deferred constraint trigger validates sum invariants at transaction commit.
  insert into public.bill_payment_allocations (payment_id, bill_id, allocated_amount)
  values (v_payment_id, v_bill_id, v_net_payable);

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill_payment.created', 'bill_payment', v_payment_id,
    jsonb_build_object(
      'request_id', v_request_id,
      'paid_on_entry', true,
      'allocations', jsonb_build_array(jsonb_build_object('bill_id', v_bill_id, 'amount', v_net_payable))
    ));

  return jsonb_build_object('bill_id', v_bill_id, 'payment_id', v_payment_id);
end;
$$;

-- Create a payment + allocations atomically. The deferred constraint
-- trigger ap_validate_bill_payment_allocations enforces P0014-P0017
-- at transaction commit.
-- p_input shape:
--   { vendor_id, payment_date, method, cash_account_id, amount_php,
--     reference, cheque_number, cheque_date,
--     allocations: [{ bill_id, allocated_amount }, ...] }
create or replace function public.ap_create_bill_payment_with_allocations(
  p_input    jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id uuid;
  v_alloc      jsonb;
begin
  insert into public.bill_payments (
    vendor_id, payment_date, method, cash_account_id, amount_php,
    reference, cheque_number, cheque_date, created_by, updated_by
  ) values (
    (p_input->>'vendor_id')::uuid,
    (p_input->>'payment_date')::date,
    p_input->>'method',
    (p_input->>'cash_account_id')::uuid,
    (p_input->>'amount_php')::numeric(12,2),
    p_input->>'reference',
    p_input->>'cheque_number',
    nullif(p_input->>'cheque_date', '')::date,
    p_actor_id, p_actor_id
  ) returning id into v_payment_id;

  for v_alloc in select * from jsonb_array_elements(p_input->'allocations')
  loop
    insert into public.bill_payment_allocations (
      payment_id, bill_id, allocated_amount
    ) values (
      v_payment_id,
      (v_alloc->>'bill_id')::uuid,
      (v_alloc->>'allocated_amount')::numeric(12,2)
    );
  end loop;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill_payment.created', 'bill_payment', v_payment_id,
          jsonb_build_object('allocations', p_input->'allocations'));

  return jsonb_build_object('payment_id', v_payment_id);
end;
$$;

-- Reallocate a non-voided payment's allocations.
-- Atomic delete-then-insert; deferred trigger validates sum invariants
-- at commit. Bills' status flips bidirectionally via the recompute
-- trigger as allocations come and go.
create or replace function public.ap_reallocate_bill_payment(
  p_payment_id  uuid,
  p_allocations jsonb,
  p_actor_id    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_voided_at  timestamptz;
  v_old        jsonb;
  v_alloc      jsonb;
begin
  select voided_at into v_voided_at
    from public.bill_payments
    where id = p_payment_id
    for update;

  if not found then
    raise exception 'Payment % not found', p_payment_id using errcode = 'P0002';
  end if;
  if v_voided_at is not null then
    raise exception 'Cannot reallocate a voided payment' using errcode = 'P0004';
  end if;

  -- Snapshot old allocations for audit metadata.
  select jsonb_agg(jsonb_build_object('bill_id', bill_id, 'allocated_amount', allocated_amount))
    into v_old
    from public.bill_payment_allocations
    where payment_id = p_payment_id and voided_at is null;

  -- DELETE existing active allocations (recompute trigger fires per row).
  delete from public.bill_payment_allocations
    where payment_id = p_payment_id and voided_at is null;

  -- INSERT new allocations (recompute trigger fires per row again).
  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    insert into public.bill_payment_allocations (
      payment_id, bill_id, allocated_amount
    ) values (
      p_payment_id,
      (v_alloc->>'bill_id')::uuid,
      (v_alloc->>'allocated_amount')::numeric(12,2)
    );
  end loop;

  -- At transaction commit, deferred trigger validates P0014-P0017.

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill_payment.reallocated', 'bill_payment', p_payment_id,
          jsonb_build_object('before', v_old, 'after', p_allocations));

  return jsonb_build_object('payment_id', p_payment_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Section 7 (final): void + cron atomic-op functions
-- ---------------------------------------------------------------------------

-- Void a payment: post reversal JE + mark voided_at on payment.
-- The T8 cascade trigger then soft-marks allocations as voided.
-- The recompute trigger then bidirectionally flips affected bills' status.
-- Idempotent on already-voided payments.
create or replace function public.ap_void_bill_payment_cascade(
  p_payment_id uuid,
  p_reason     text,
  p_actor_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_already_voided timestamptz;
  v_reversal_je    uuid;
begin
  -- Idempotency: lock + check.
  select voided_at into v_already_voided
    from public.bill_payments
    where id = p_payment_id
    for update;

  if not found then
    raise exception 'Payment % not found', p_payment_id using errcode = 'P0002';
  end if;

  if v_already_voided is not null then
    return jsonb_build_object('payment_id', p_payment_id, 'already_voided', true);
  end if;

  -- Post the reversal JE for the bill_payment source.
  v_reversal_je := public.ap_reverse_je_for_source('bill_payment', p_payment_id, p_actor_id);

  -- Mark payment voided. The T8 trigger cascades to allocations;
  -- the recompute trigger then re-evaluates affected bills' status.
  update public.bill_payments
    set voided_at = now(), voided_by = p_actor_id, void_reason = p_reason
    where id = p_payment_id and voided_at is null;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill_payment.voided', 'bill_payment', p_payment_id,
          jsonb_build_object('reason', p_reason, 'reversal_je_id', v_reversal_je));

  return jsonb_build_object('payment_id', p_payment_id, 'reversal_je_id', v_reversal_je);
end;
$$;

-- Void a posted bill. Raises P0013 (via the bills BEFORE-UPDATE guard
-- trigger from T10) if active payments exist; admin must void payments
-- first. Idempotent.
create or replace function public.ap_void_bill_with_guard(
  p_bill_id  uuid,
  p_reason   text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status      text;
  v_reversal_je uuid;
begin
  select status into v_status
    from public.bills
    where id = p_bill_id
    for update;

  if not found then
    raise exception 'Bill % not found', p_bill_id using errcode = 'P0002';
  end if;

  if v_status = 'voided' then
    return jsonb_build_object('bill_id', p_bill_id, 'already_voided', true);
  end if;

  if v_status = 'draft' then
    raise exception 'Cannot void a draft bill; delete it instead'
      using errcode = 'P0002';
  end if;

  -- Post the reversal JE for the bill_post source.
  v_reversal_je := public.ap_reverse_je_for_source('bill_post', p_bill_id, p_actor_id);

  -- Flip status. The T10 P0013 guard fires here if active payments exist
  -- (this raises before this update commits, abort the whole transaction
  -- and rolling back the reversal JE inserted above).
  update public.bills
    set status = 'voided', voided_at = now(), voided_by = p_actor_id, void_reason = p_reason
    where id = p_bill_id;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill.voided', 'bill', p_bill_id,
          jsonb_build_object('reason', p_reason, 'reversal_je_id', v_reversal_je));

  return jsonb_build_object('bill_id', p_bill_id, 'reversal_je_id', v_reversal_je);
end;
$$;

-- Cron-invoked: create a draft bill from a template if it's due.
-- Atomic: bill + line + audit + next_run_date advance all in one tx.
-- Returns {skipped: true} if not yet due (cron should exit its loop on this).
create or replace function public.ap_post_recurring_template(
  p_template_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template  record;
  v_bill_id   uuid;
  v_bill_date date;
  v_today     date := (now() at time zone 'Asia/Manila')::date;
begin
  select * into v_template
    from public.recurring_bill_templates
    where id = p_template_id and is_active = true
    for update;

  if not found then
    raise exception 'Template % not found or inactive', p_template_id
      using errcode = 'P0002';
  end if;

  if v_template.next_run_date > v_today then
    return jsonb_build_object('skipped', true, 'reason', 'not yet due');
  end if;

  v_bill_date := v_template.next_run_date + v_template.bill_date_offset_days;

  -- Create draft bill (vendor + dates + WT defaults from template).
  insert into public.bills (
    vendor_id, bill_date, due_date, description,
    wt_classification, wt_rate, wt_exempt, template_id,
    created_by, updated_by
  ) values (
    v_template.vendor_id,
    v_bill_date,
    v_template.next_run_date,
    v_template.description,
    v_template.default_wt_classification,
    v_template.default_wt_rate,
    v_template.default_wt_exempt,
    v_template.id,
    null, null    -- system-created via cron; no staff actor
  ) returning id into v_bill_id;

  -- Single line (templates are single-line in v1).
  insert into public.bill_lines (bill_id, line_no, description, amount_php, account_id)
  values (
    v_bill_id, 1, v_template.description,
    coalesce(v_template.amount_php, 0),    -- 0 if variable; admin fills in later
    v_template.default_account_id
  );

  -- Advance next_run_date by one month.
  update public.recurring_bill_templates
    set next_run_date = (next_run_date + interval '1 month')::date,
        updated_at = now()
    where id = p_template_id;

  -- System-actor audit row (no staff actor_id; actor_type = 'system').
  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (null, 'system', 'recurring_template.fired', 'recurring_bill_template', p_template_id,
          jsonb_build_object('bill_id', v_bill_id, 'run_date', v_today));

  return jsonb_build_object(
    'bill_id', v_bill_id,
    'next_run_date', (v_template.next_run_date + interval '1 month')::date
  );
end;
$$;

-- ==========================================================================
-- Section 8 — Trigger wiring.
-- Triggers are listed in dependency order. Constraint trigger is
-- DEFERRABLE INITIALLY DEFERRED so it fires at transaction commit.
-- ==========================================================================

-- updated_at maintenance on the 4 tables with that column.
create trigger trg_vendors_updated_at
  before update on public.vendors
  for each row execute function public.ap_set_updated_at();

create trigger trg_bills_updated_at
  before update on public.bills
  for each row execute function public.ap_set_updated_at();

create trigger trg_bill_payments_updated_at
  before update on public.bill_payments
  for each row execute function public.ap_set_updated_at();

create trigger trg_recurring_bill_templates_updated_at
  before update on public.recurring_bill_templates
  for each row execute function public.ap_set_updated_at();

-- BL-YYYY-NNNN / BP-YYYY-NNNN counter assignment.
create trigger trg_bills_assign_number
  before insert on public.bills
  for each row execute function public.ap_assign_bill_number();

create trigger trg_bill_payments_assign_number
  before insert on public.bill_payments
  for each row execute function public.ap_assign_payment_number();

-- Gross recompute (gated to fire only when relevant columns change).
create trigger trg_bill_lines_recompute_gross_ins
  after insert on public.bill_lines
  for each row execute function public.ap_recompute_bill_gross();

create trigger trg_bill_lines_recompute_gross_upd
  after update on public.bill_lines
  for each row
  when (old.amount_php is distinct from new.amount_php
        or old.bill_id is distinct from new.bill_id
        or old.account_id is distinct from new.account_id)
  execute function public.ap_recompute_bill_gross();

create trigger trg_bill_lines_recompute_gross_del
  after delete on public.bill_lines
  for each row execute function public.ap_recompute_bill_gross();

-- Paid_amount + bidirectional status recompute (per-row).
create trigger trg_allocations_recompute_paid
  after insert or update or delete on public.bill_payment_allocations
  for each row execute function public.ap_recompute_bill_paid_and_status();

-- Void cascade from payment to allocations.
create trigger trg_bill_payment_void_cascade
  after update of voided_at on public.bill_payments
  for each row execute function public.ap_bill_payment_void_cascade();

-- Constraint trigger (deferred to commit) for allocation invariants P0014-P0017.
create constraint trigger trg_validate_bill_payment_allocations
  after insert or update or delete on public.bill_payment_allocations
  deferrable initially deferred
  for each row execute function public.ap_validate_bill_payment_allocations();

-- P0013 guard: cannot void bill with active payments.
create trigger trg_bills_void_guard
  before update on public.bills
  for each row
  when (old.status is distinct from 'voided' and new.status = 'voided')
  execute function public.ap_bill_void_guard();

-- Bridge: bill_post fires on the draft → posted transition.
create trigger trg_bill_post_bridge
  after update on public.bills
  for each row
  when (old.status = 'draft' and new.status = 'posted')
  execute function public.ap_bill_post_bridge();

-- Bridge: bill_payment fires on INSERT.
create trigger trg_bill_payment_bridge
  after insert on public.bill_payments
  for each row execute function public.ap_bill_payment_bridge();

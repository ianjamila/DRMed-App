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

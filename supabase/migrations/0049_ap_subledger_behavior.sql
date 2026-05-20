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

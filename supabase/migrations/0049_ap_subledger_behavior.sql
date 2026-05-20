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

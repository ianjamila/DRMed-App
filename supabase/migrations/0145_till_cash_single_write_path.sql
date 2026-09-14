-- =============================================================================
-- 0145_till_cash_single_write_path.sql
-- =============================================================================
-- M1 (SectionTabs audit, 2026-09-14): cash could leave the till without the
-- drawer knowing, through two doors.
--
-- `/staff/payments/petty-cash` posted a journal entry directly
-- (source_kind='petty_cash') and wrote NO `eod_cash_adjustments` row. Admin
-- "Quick expense" did the same whenever the payment source was "Clinic Cash"
-- (source_kind='manual', CR 1010). But `cash_drawer_state.expected_cash_php`
-- (0139) derives the day's payouts SOLELY from `eod_cash_adjustments` — it
-- never reads `journal_entries`, and the bridge trigger runs one way only
-- (adjustment → JE, never the reverse).
--
-- So a till expense logged through either door reduced the books but not that
-- day's expected cash. Reception counted short, and on close the EOD trigger
-- (0043 `bridge_eod_close`) posted ANOTHER credit to cash against 6900 Cash
-- Short/Over — while the expense JE had already credited cash. One ₱100
-- outflow, cash credited twice, ₱100 parked in short/over. Both doors also
-- walked straight past the day-close lock (P0015), which only guards
-- `eod_cash_adjustments` and `payments`.
--
-- The app fix (same PR) routes BOTH doors through `postTillCashExpense()`,
-- which inserts an `eod_cash_adjustments` row (kind='petty_cash') and lets the
-- existing bridge trigger post the journal entry. No schema change is needed
-- for that: `kind='petty_cash'` is already in the CHECK constraint, the
-- `cash_adjustment_account_map` already defaults it to 6400 with
-- requires_user_choice, and the insert/void bridges and the close lock already
-- fire on that table.
--
-- What this migration does is make the old shape unreachable:
--
--   1. A guard trigger so `source_kind='petty_cash'` journal entries can never
--      be written again (P0049). That enum value is retired — every till
--      expense now reaches the GL as source_kind='cash_adjustment' via the
--      bridge. The app-side refusal in post-expense.ts covers the
--      'manual' + Clinic Cash door; this covers the 'petty_cash' one at the
--      only level that can't be bypassed.
--
--   2. Drops `reverse_petty_cash_entry` (0102), now dead. It could only
--      reverse source_kind='petty_cash' entries — a shape nothing produces
--      any more. Voiding a till expense is now a plain `voided_at` update on
--      `eod_cash_adjustments`, handled by `trg_bridge_cash_adjustment_void`.
--
-- HISTORIC EXPOSURE: none. Verified on prod 2026-09-14 before writing this —
-- `journal_entries` has ZERO rows with source_kind='petty_cash', both
-- source_kind='manual' rows are bank recs against 1020 BPI (not the till),
-- `eod_cash_adjustments` is empty, and `eod_close_records` is empty (no EOD
-- close has ever been run). No day carries a posted shortage from this defect,
-- so there is nothing to backfill and no reconciliation to write.
-- =============================================================================

-- ---- Guard P0049: the till has one write path -------------------------------
-- Fires on INSERT as well as UPDATE so the draft never lands — post-expense.ts
-- inserts a draft JE first, then its lines, then flips to 'posted', and
-- refusing only at the posted transition would leave orphan drafts behind.
create or replace function public.journal_entries_block_petty_cash_source()
returns trigger
language plpgsql
as $$
begin
  if NEW.source_kind = 'petty_cash' then
    raise exception
      'Cash paid from the till must be recorded through the cash drawer (eod_cash_adjustments), not as a journal entry.'
      using errcode = 'P0049';
  end if;
  return NEW;
end;
$$;

create trigger trg_journal_entries_block_petty_cash_source
  before insert or update on public.journal_entries
  for each row execute function public.journal_entries_block_petty_cash_source();

-- ---- Retire the petty-cash reversal RPC -------------------------------------
-- Superseded by the `eod_cash_adjustments` void bridge. Nothing calls it after
-- this PR, and guard (1) means nothing can produce a row it would accept.
drop function if exists public.reverse_petty_cash_entry(uuid, text, uuid);

-- ---- ACLs -------------------------------------------------------------------
-- Trigger functions are invoked by the trigger, not called directly, so this
-- one needs no EXECUTE grant. 0119 made public functions service_role-only by
-- default; state the revoke explicitly rather than relying on that default
-- (the 0118/0119 checklist in the drmed-migrations skill).
revoke all on function public.journal_entries_block_petty_cash_source() from public, anon, authenticated;

-- ---- Post-conditions --------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_journal_entries_block_petty_cash_source'
      and tgrelid = 'public.journal_entries'::regclass
  ) then
    raise exception '0145: petty_cash source guard trigger is missing';
  end if;

  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reverse_petty_cash_entry'
  ) then
    raise exception '0145: reverse_petty_cash_entry should have been dropped';
  end if;

  -- The replacement path must be intact for the app fix to be correct.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_bridge_cash_adjustment_insert'
      and tgrelid = 'public.eod_cash_adjustments'::regclass
  ) then
    raise exception '0145: cash adjustment insert bridge is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_bridge_cash_adjustment_void'
      and tgrelid = 'public.eod_cash_adjustments'::regclass
  ) then
    raise exception '0145: cash adjustment void bridge is missing';
  end if;

  if not exists (
    select 1 from public.cash_adjustment_account_map where kind = 'petty_cash'
  ) then
    raise exception '0145: cash_adjustment_account_map has no petty_cash row';
  end if;
end;
$$;

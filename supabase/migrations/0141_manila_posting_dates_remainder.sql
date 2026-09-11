-- =============================================================================
-- 0141_manila_posting_dates_remainder.sql
-- =============================================================================
-- Follow-up to 0140_manila_posting_dates.sql. 0140 fixed the two forward
-- posting paths named in the go-live review (bridge_payment_insert,
-- bridge_test_request_released) plus their two reversal paths
-- (bridge_payment_void, fn_undo_release_bridge) that it found while fixing
-- the forward ones. Its own header comment flagged a further repo-wide grep
-- hit list as out of scope for that migration and asked for it to be
-- reported rather than silently left or silently fixed. This migration does
-- that fix.
--
-- Every function below was independently reconfirmed against its CURRENT
-- pg_get_functiondef() body on the local stack (not the migration files —
-- a later migration can re-create a function) before being touched:
--
--   bridge_hmo_claim_resolution_insert  -- coalesce(NEW.resolved_at::date, current_date)
--   bridge_hmo_claim_resolution_void    -- coalesce(NEW.voided_at::date, current_date)
--   bridge_test_request_cancelled       -- bare current_date, no stored column at all
--   bridge_pf_at_hmo_allocation         -- coalesce(v_payment.received_at::date, current_date)
--   bridge_pf_at_hmo_writeoff           -- coalesce(new.resolved_at::date, current_date)
--   bridge_cogs_send_out_trueup         -- new.matched_at::date (+ v_year from the same bare extract)
--   bridge_cash_adjustment_void         -- NEW.voided_at::date (no coalesce, but still a UTC cast)
--   bridge_payment_delete               -- bare current_date, no stored column reachable (BEFORE DELETE)
--
-- All eight were confirmed still bugged; none had been superseded by a later
-- migration. Every one is re-created byte-identical to its current body
-- except the date expression(s), same discipline as 0140. bridge_cogs_send_
-- out_trueup gets two matching changes (the inline posting_date AND the
-- v_year initializer it feeds public.je_next_number with) — both derive from
-- the same new.matched_at column and must agree with each other, mirroring
-- how 0140's bridge_test_request_released already derives v_je_number's year
-- from the corrected v_posting_date rather than from the raw timestamptz.
-- bridge_payment_insert, bridge_test_request_released, bridge_payment_void
-- and fn_undo_release_bridge (0140's own four) are NOT touched here.
--
-- ---- Function ACLs -----------------------------------------------------
-- All eight were confirmed on the local stack to already sit at
-- postgres + service_role only (0118's classify-then-revoke pass covered
-- them; 0119 defaults new functions there too, and nothing since has
-- widened any of the eight). `create or replace function` keeps a function's
-- current ACL, but the grants are restated explicitly below anyway, exactly
-- as 0140 did, so the migration is self-describing on replay and matches
-- the drmed-migrations skill's "restate the post-0118 ACL explicitly"
-- checklist item.
--
-- ---- The ageing-arithmetic views: deliberately left alone --------------
-- The go-live review also flagged v_hmo_unbilled, v_hmo_stuck and
-- v_hmo_ar_aging (0034, 0079-0082) for `CURRENT_DATE - tr.released_at::date`
-- / `CURRENT_DATE - b.submitted_at` style day-count arithmetic, calling it
-- lower severity and a different shape than a posting date — ageing
-- arithmetic that "self-cancels except at the day boundary" rather than a
-- value written once into an immutable posted ledger row. That framing
-- holds up: CURRENT_DATE and the two columns it's subtracted from are BOTH
-- read in the same (UTC) session clock, so the day-count is wrong only in
-- the italicised sense that it can land a row one bucket early/late right at
-- the boundary (e.g. 30 vs 31 days, mid-window on any given day) — it can
-- never relocate money into a different posting_date, a different month, or
-- a closed accounting period the way the eight functions above could.
-- Left unfixed here, deliberately, for two reasons:
--   1. Blast radius mismatch. This migration exists to stop the ledger
--      itself recording the wrong day. A live-recomputed display aggregate
--      that's occasionally one bucket off is a real but much smaller bug,
--      and bundling an unrelated view fix into a ledger-correctness
--      migration works against the "diff shows only the date change"
--      discipline this migration (and 0140) is held to.
--   2. File ownership. All three are in hardened-views.test.ts's HARDENED
--      map (security_invoker pinned since 0135); touching any of them
--      correctly means restating `with (security_invoker = on)` in the same
--      `create or replace view`, which this migration can do — but the
--      views are application-adjacent surfaces this task was not scoped to
--      touch, and the fix belongs with whoever owns the HMO AR aging report
--      as its own small, easily-reviewed migration.
-- Reported to the operator rather than silently fixed or silently dropped.
--
-- ---- Backfill ------------------------------------------------------------
-- Every UPDATE below is guarded exactly like 0140's: it only touches rows
-- whose CORRECTED posting_date it can establish from a stored, stable event
-- timestamp, it skips (and audit-logs, action 'gl.posting_date_backfill_
-- skipped') any row whose corrected date falls in a CLOSED accounting
-- period rather than aborting the migration, and every clause is a no-op on
-- an empty replay (nothing to join against). Per function:
--
--   bridge_hmo_claim_resolution_insert — hmo_claim_resolutions.resolved_at
--     is set once at insert (default now()) and never updated by any app
--     code path (grepped) or trigger — unlike test_requests.released_at
--     (0140 Finding 10), a resolution row is never reused for a second
--     event, so its resolved_at reliably describes the JE that still cites
--     it as source_id regardless of whether that JE is currently 'posted'
--     or has since been 'reversed' by a void. Backfill corrects BOTH
--     statuses; only 'posted' rows are subject to the closed-period guard
--     (je_period_lock_check only fires `if new.status = 'posted'`), so
--     'reversed' rows are corrected unconditionally.
--
--   bridge_hmo_claim_resolution_void — hmo_claim_resolutions.voided_at is
--     set exactly once (`.is("voided_at", null)` guard in the Server
--     Action; no unvoid path exists). The reversal JE is found via
--     `reverses` back to the original 'hmo_claim_resolution'-sourced JE,
--     which uniquely ties it to one resolution row's voided_at. Backfill
--     corrects the reversal JE's posting_date; guarded against a closed
--     corrected period like every other 'posted'-status correction here.
--
--   bridge_test_request_cancelled — the function references no stored
--     column at all (bare current_date); test_requests carries no
--     cancelled_at. There is therefore no domain timestamp to reconstruct
--     from — the same "original event timestamp unknown" situation 0140's
--     Finding 10 hit for an undone release, just for a different reason
--     (never captured, not overwritten). The reversal JE's own
--     journal_entries.created_at is used instead: that column defaults to
--     now() and is written in the very same INSERT statement that computed
--     the buggy posting_date, in the very same trigger invocation, so it is
--     a precise recovery of the true event instant, not a guess. To avoid
--     misattributing an fn_undo_release_bridge reversal (0140, not this
--     migration's function — also reverses a 'test_request'-sourced JE) to
--     this backfill, candidates are restricted to the reversal whose
--     original is the MOST RECENT 'test_request'-sourced 'reversed' JE for
--     that test_request (a test_request can cycle release → undo →
--     re-release more than once before finally being cancelled; only the
--     last such JE was reversed by the cancellation) AND whose
--     test_request is currently in the terminal 'cancelled' status.
--
--   bridge_pf_at_hmo_allocation — doctor_pf_entries.hmo_allocation_id is
--     set exactly once, by this function alone, pointing at the specific
--     hmo_payment_allocations row whose payments.received_at drove the
--     computation (payments.received_at itself never changes after insert,
--     per 0140's own reasoning). The join source_id → doctor_pf_entries →
--     hmo_allocation_id → hmo_payment_allocations → payments is therefore
--     exact, not a fuzzy match; `hmo_allocation_id is not null` also
--     excludes the writeoff-produced rows sharing the same source_kind.
--
--   bridge_pf_at_hmo_writeoff — also source_kind = 'doctor_pf_accrual',
--     disambiguated from the allocation rows via
--     `doctor_pf_entries.void_reason = 'hmo_writeoff'` (set only by this
--     function). Unlike the allocation case there is no clean 1:1 join back
--     to the specific hmo_claim_resolutions row that caused it — a
--     test_request's write-off history is reachable only via
--     items/resolutions, and nothing on doctor_pf_entries records which
--     specific resolution triggered a given write-off, so tracing it can
--     fan out across more than one resolution row for the same
--     test_request. Rather than guess among candidates (the exact
--     corruption 0140's Finding 10 refused to risk), this backfill uses
--     journal_entries.created_at — same reasoning as bridge_test_request_
--     cancelled above: it is that specific JE's own recorded creation
--     instant, written in the same trigger invocation as the bug.
--
--   bridge_cogs_send_out_trueup — cogs_send_out_trueups.matched_at is set
--     once at insert (default now()); each row's JE is found via
--     source_kind = 'cogs_send_out_trueup' and source_id = the trueup's own
--     id, a direct FK, no ambiguity.
--
--   bridge_cash_adjustment_void — eod_cash_adjustments.voided_at is set
--     exactly once (no unvoid path). The reversal JE is found via
--     `reverses` back to the original 'cash_adjustment'-sourced JE, which
--     ties it 1:1 to one adjustment row's voided_at — no other function
--     produces a reversal of a 'cash_adjustment'-sourced JE.
--
--   bridge_payment_delete — fires BEFORE DELETE; by the time any backfill
--     could run, the payment row no longer exists to read a timestamp from
--     (hard delete, not the void's soft `voided_at`). journal_entries.
--     created_at is used, same reasoning as the two cases above. To avoid
--     misattributing a bridge_payment_void reversal (0140, not this
--     migration's function — also reverses a 'payment'-sourced JE),
--     candidates are restricted to reversals whose original JE's source_id
--     no longer resolves to any row in payments at all — the one signal
--     that can only be true of a hard-deleted payment, never a voided one
--     (bridge_payment_delete itself only fires a reversal when the payment
--     was never voided in the first place: a voided payment's JE is already
--     'reversed', not 'posted', so the guard `where status = 'posted'` in
--     bridge_payment_delete finds nothing and no new JE is produced).
--
-- Every UPDATE above is scoped to rows currently 'posted' except the first
-- clause of bridge_hmo_claim_resolution_insert's backfill, which also
-- corrects 'reversed' originals for the reason given there. No new
-- `raise exception` is added by this migration — the eight functions above
-- already only ever raise indirectly, via the same je_status_balance_check /
-- je_period_lock_check triggers 0140 already relies on — so no new P00NN
-- code is claimed here.
-- =============================================================================

create or replace function public.bridge_hmo_claim_resolution_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item            public.hmo_claim_items%rowtype;
  v_batch           public.hmo_claim_batches%rowtype;
  v_dr_account      uuid;
  v_cr_account      uuid;
  v_dr_code         text;
  v_cr_code         text := '1110';
  v_desc            text;
  v_je_id           uuid;
  v_existing_je     uuid;
begin
  -- Idempotency guard (mirrors 12.2).
  select id into v_existing_je
    from public.journal_entries
   where source_kind = 'hmo_claim_resolution'
     and source_id = NEW.id
     and status = 'posted'
   for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  select * into v_item  from public.hmo_claim_items   where id = NEW.item_id;
  select * into v_batch from public.hmo_claim_batches where id = v_item.batch_id;

  if NEW.destination = 'patient_bill' then
    v_dr_code := '1100';
  else
    v_dr_code := '6920';
  end if;

  v_dr_account := public.coa_uuid_for_code(v_dr_code);
  v_cr_account := public.coa_uuid_for_code(v_cr_code);

  v_desc := format(
    'HMO claim resolved → %s — batch %s item %s',
    case NEW.destination when 'patient_bill' then 'patient bill' else 'write-off' end,
    coalesce(v_batch.reference_no, v_batch.id::text),
    NEW.item_id::text
  );

  -- Insert as draft first to defer balance-check until all lines exist.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    -- 0141: Manila-local date of the resolution, not the UTC date `::date` reads.
    coalesce((NEW.resolved_at at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date),
    v_desc,
    'draft',
    'hmo_claim_resolution',
    NEW.id,
    NEW.resolved_by
  )
  returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values
    (v_je_id, v_dr_account, NEW.amount_php, 0, 1),
    (v_je_id, v_cr_account, 0, NEW.amount_php, 2);

  update public.journal_entries set status = 'posted' where id = v_je_id;

  return NEW;
end;
$function$;

revoke execute on function public.bridge_hmo_claim_resolution_insert() from public, anon, authenticated;
grant  execute on function public.bridge_hmo_claim_resolution_insert() to service_role;

create or replace function public.bridge_hmo_claim_resolution_void()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_original_je   uuid;
  v_orig_number   text;
  v_reversal_je   uuid;
begin
  if not (OLD.voided_at is null and NEW.voided_at is not null) then
    return NEW;
  end if;

  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
   where source_kind = 'hmo_claim_resolution'
     and source_id = NEW.id
     and status = 'posted'
   for update;
  if v_original_je is null then
    return NEW;
  end if;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  )
  values (
    -- 0141: Manila-local date of the void, not the UTC date `::date` reads.
    coalesce((NEW.voided_at at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date),
    'Reversal of ' || v_orig_number || ': ' || coalesce(NEW.void_reason, 'resolution voided'),
    'draft',
    'reversal',
    null,
    v_original_je,
    NEW.voided_by
  )
  returning id into v_reversal_je;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  select v_reversal_je, account_id, credit_php, debit_php, line_order
    from public.journal_lines
   where entry_id = v_original_je
   order by line_order;

  update public.journal_entries set status = 'posted' where id = v_reversal_je;

  update public.journal_entries
     set status = 'reversed',
         reversed_by = v_reversal_je
   where id = v_original_je;

  return NEW;
end;
$function$;

revoke execute on function public.bridge_hmo_claim_resolution_void() from public, anon, authenticated;
grant  execute on function public.bridge_hmo_claim_resolution_void() to service_role;

create or replace function public.bridge_test_request_cancelled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor        uuid;
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
begin
  -- Package components have no JE to reverse (see released-bridge guard).
  if NEW.parent_id is not null then
    return NEW;
  end if;

  -- Only proceed on released→cancelled transition. The trigger definition in
  -- 0030 already constrains: WHEN (OLD.status = 'released' AND NEW.status = 'cancelled')
  -- but the guard below makes the function self-consistent if called directly.
  if not (old.status = 'released' and new.status = 'cancelled') then
    return new;
  end if;

  v_actor := auth.uid();

  -- Find the original posted release JE for this test_request.
  -- FOR UPDATE locks the row to prevent a concurrent void from racing.
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'test_request'
      and source_id = new.id
      and status = 'posted'
    for update;

  if v_original_je is null then
    -- Test request was released but has no posted JE (defensive edge case).
    -- Still soft-void subledger rows in case they were inserted before the JE.
    update public.doctor_pf_entries
      set voided_at   = now(),
          voided_by   = v_actor,
          void_reason = 'test_request_cancelled'
      where test_request_id = new.id
        and voided_at is null;

    update public.cogs_send_out_entries
      set voided_at   = now(),
          voided_by   = v_actor,
          void_reason = 'test_request_cancelled'
      where test_request_id = new.id
        and voided_at is null;

    return new;
  end if;

  -- ---- Insert reversal JE header (draft) ------------------------------------
  -- source_kind = 'reversal', source_id = null, reverses = original JE id.
  -- This mirrors the pattern in bridge_payment_void (0030). The partial unique
  -- index journal_entries_one_posted_per_source excludes source_kind='reversal'
  -- rows, so no collision with the idempotency guard on release.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  ) values (
    -- 0141: Manila-local date of the cancellation, not the UTC date `current_date` reads.
    (now() at time zone 'Asia/Manila')::date,
    'Reversal of ' || v_orig_number || ': test request cancelled',
    'draft',
    'reversal',
    null,
    v_original_je,
    v_actor
  ) returning id into v_reversal_je;

  -- ---- Mirror lines with swapped debit/credit --------------------------------
  -- Works correctly for the new split-JE shape from 6.1: each line is
  -- reversed 1:1 regardless of which account it touches.
  insert into public.journal_lines (
    entry_id, account_id, debit_php, credit_php, line_order
  )
  select
    v_reversal_je,
    account_id,
    credit_php,   -- swap: original credit becomes reversal debit
    debit_php,    -- swap: original debit becomes reversal credit
    line_order
  from public.journal_lines
  where entry_id = v_original_je
  order by line_order;

  -- ---- Flip reversal to posted; mark original as reversed -------------------
  update public.journal_entries
    set status = 'posted'
    where id = v_reversal_je;

  update public.journal_entries
    set status      = 'reversed',
        reversed_by = v_reversal_je
    where id = v_original_je;

  -- ---- 12.5 addition: soft-void subledger rows ------------------------------
  -- Void any open doctor_pf_entries for this test_request. This handles both
  -- 'cash_at_release' (PF now reversed by the JE above) and 'hmo_at_settlement'
  -- (PF was deferred; cancellation withdraws the pending claim entirely).
  update public.doctor_pf_entries
    set voided_at   = now(),
        voided_by   = v_actor,
        void_reason = 'test_request_cancelled'
    where test_request_id = new.id
      and voided_at is null;

  -- Void any open cogs_send_out_entries for this test_request.
  update public.cogs_send_out_entries
    set voided_at   = now(),
        voided_by   = v_actor,
        void_reason = 'test_request_cancelled'
    where test_request_id = new.id
      and voided_at is null;

  return new;
end;
$function$;

revoke execute on function public.bridge_test_request_cancelled() from public, anon, authenticated;
grant  execute on function public.bridge_test_request_cancelled() to service_role;

create or replace function public.bridge_pf_at_hmo_allocation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor          uuid := auth.uid();
  v_item           record;
  v_tr             record;
  v_pfe            record;
  v_payment        record;
  v_settlement_ratio numeric(10,6);
  v_pf_to_accrue   numeric(10,2);
  v_je_id          uuid;
  v_je_number      text;
  v_year           smallint;
  v_posting_date   date;
begin
  -- Look up the item and its test_request.
  select * into v_item from public.hmo_claim_items where id = new.item_id;
  if v_item.test_request_id is null then return new; end if;

  select * into v_tr from public.test_requests where id = v_item.test_request_id;

  -- Find a pending HMO PF entry for this test_request.
  select * into v_pfe from public.doctor_pf_entries
  where test_request_id = v_tr.id
    and recognition_basis = 'hmo_at_settlement'
    and recognized_at is null
    and voided_at is null
  limit 1;

  if v_pfe.id is null then return new; end if;  -- no pending PF; nothing to do

  -- Compute proportional accrual. In practice the ratio is 1.0 or 0.0 (per
  -- spec D7); the formula handles partials gracefully.
  if v_item.billed_amount_php = 0 then return new; end if;
  v_settlement_ratio := new.amount_php / v_item.billed_amount_php;
  v_pf_to_accrue := round(coalesce(v_tr.doctor_pf_php, 0) * v_settlement_ratio, 2);

  if v_pf_to_accrue <= 0 then return new; end if;

  -- Derive posting_date from parent payment.
  -- payments.received_at is the recording timestamp; cast to date for the JE.
  -- (payments has no posting_date column; received_at::date is the equivalent.)
  select * into v_payment from public.payments where id = new.payment_id;
  -- 0141: Manila-local date of the payment, not the UTC date `::date` reads.
  v_posting_date := coalesce((v_payment.received_at at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date);
  v_year := extract(year from v_posting_date)::smallint;

  -- Draft + post JE: DR 2160 / CR 2110.
  v_je_number := public.je_next_number(v_year::int);
  insert into public.journal_entries(
    entry_number, posting_date, status, source_kind, source_id,
    description, created_by
  ) values (
    v_je_number, v_posting_date, 'draft', 'doctor_pf_accrual', v_pfe.id,
    'HMO PF settlement: 2160 → 2110', v_actor
  ) returning id into v_je_id;

  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 1, public.coa_uuid_for_code('2160'),
          v_pf_to_accrue, 0, 'Reclass from PF pending');
  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 2, public.coa_uuid_for_code('2110'),
          0, v_pf_to_accrue, 'Doctor PF accrued at HMO settlement');

  update public.journal_entries set status = 'posted' where id = v_je_id;

  -- Update the PF entry with settlement details + snapshot the actual accrued amount.
  update public.doctor_pf_entries
    set recognized_at    = now(),
        journal_entry_id = v_je_id,
        hmo_allocation_id = new.id,
        pf_php           = v_pf_to_accrue
    where id = v_pfe.id;

  return new;
end;
$function$;

revoke execute on function public.bridge_pf_at_hmo_allocation() from public, anon, authenticated;
grant  execute on function public.bridge_pf_at_hmo_allocation() to service_role;

create or replace function public.bridge_pf_at_hmo_writeoff()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor          uuid := auth.uid();
  v_item           record;
  v_tr             record;
  v_pfe            record;
  v_writeoff_ratio numeric(10,6);
  v_pf_to_clear    numeric(10,2);
  v_je_id          uuid;
  v_je_number      text;
  v_year           smallint;
  v_posting_date   date;
begin
  -- Only fire for write_off resolutions (also enforced by WHEN clause on trigger).
  if new.destination != 'write_off' then return new; end if;

  select * into v_item from public.hmo_claim_items where id = new.item_id;
  if v_item.test_request_id is null then return new; end if;

  select * into v_tr from public.test_requests where id = v_item.test_request_id;

  select * into v_pfe from public.doctor_pf_entries
  where test_request_id = v_tr.id
    and recognition_basis = 'hmo_at_settlement'
    and recognized_at is null
    and voided_at is null
  limit 1;

  if v_pfe.id is null then return new; end if;

  if v_item.billed_amount_php = 0 then return new; end if;
  v_writeoff_ratio := new.amount_php / v_item.billed_amount_php;
  v_pf_to_clear := round(coalesce(v_tr.doctor_pf_php, 0) * v_writeoff_ratio, 2);

  if v_pf_to_clear <= 0 then return new; end if;

  -- 0141: Manila-local date of the resolution, not the UTC date `::date` reads.
  v_posting_date := coalesce((new.resolved_at at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date);
  v_year := extract(year from v_posting_date)::smallint;

  -- DR 2160 / CR 6920 — clear the holding into bad debt.
  v_je_number := public.je_next_number(v_year::int);
  insert into public.journal_entries(
    entry_number, posting_date, status, source_kind, source_id,
    description, created_by
  ) values (
    v_je_number, v_posting_date, 'draft', 'doctor_pf_accrual', v_pfe.id,
    'HMO PF writeoff: 2160 → 6920', v_actor
  ) returning id into v_je_id;

  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 1, public.coa_uuid_for_code('2160'),
          v_pf_to_clear, 0, 'Clear PF pending (writeoff)');
  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 2, public.coa_uuid_for_code('6920'),
          0, v_pf_to_clear, 'Bad debt (HMO denied)');

  update public.journal_entries set status = 'posted' where id = v_je_id;

  -- Soft-void the PF entry (records the actual cleared amount).
  update public.doctor_pf_entries
    set voided_at        = now(),
        voided_by        = v_actor,
        void_reason      = 'hmo_writeoff',
        pf_php           = v_pf_to_clear,
        journal_entry_id = v_je_id
    where id = v_pfe.id;

  return new;
end;
$function$;

revoke execute on function public.bridge_pf_at_hmo_writeoff() from public, anon, authenticated;
grant  execute on function public.bridge_pf_at_hmo_writeoff() to service_role;

create or replace function public.bridge_cogs_send_out_trueup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor       uuid := auth.uid();
  v_variance    numeric(12,2);
  v_je_id       uuid;
  v_je_number   text;
  -- 0141: both derived from the Manila-local date of the match, not the UTC
  -- date `::date`/plain extract would read (the fiscal year must agree with
  -- the corrected posting_date below, matching 0140's v_posting_date pattern).
  v_year        smallint := extract(year from (new.matched_at at time zone 'Asia/Manila'))::smallint;
begin
  -- Mark matching entries trued-up regardless of variance direction.
  update public.cogs_send_out_entries
    set trueup_id    = new.id,
        trued_up_at  = now()
    where vendor_id           = new.vendor_id
      and accrued_at::date between new.period_start_date and new.period_end_date
      and trueup_id is null
      and voided_at is null;

  v_variance := new.variance_php;  -- signed: billed − accrued

  if v_variance = 0 then return new; end if;  -- exact match; no JE needed

  v_je_number := public.je_next_number(v_year::int);
  insert into public.journal_entries(
    entry_number, posting_date, status, source_kind, source_id,
    description, created_by
  ) values (
    v_je_number, (new.matched_at at time zone 'Asia/Manila')::date, 'draft', 'cogs_send_out_trueup', new.id,
    'Send-out variance true-up (vendor ' || new.vendor_id || ')', v_actor
  ) returning id into v_je_id;

  if v_variance > 0 then
    -- Under-accrued: billed > accrued → book additional COGS.
    insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
    values (v_je_id, 1, public.coa_uuid_for_code('6420'),
            v_variance, 0, 'COGS under-accrual catchup');
    insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
    values (v_je_id, 2, public.coa_uuid_for_code('2150'),
            0, v_variance, 'Top up accrued send-out');
  else
    -- Over-accrued: accrued > billed → reverse excess COGS.
    insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
    values (v_je_id, 1, public.coa_uuid_for_code('2150'),
            abs(v_variance), 0, 'Reverse over-accrual');
    insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
    values (v_je_id, 2, public.coa_uuid_for_code('6420'),
            0, abs(v_variance), 'Reverse COGS');
  end if;

  update public.journal_entries set status = 'posted' where id = v_je_id;
  update public.cogs_send_out_trueups set journal_entry_id = v_je_id where id = new.id;

  return new;
end;
$function$;

revoke execute on function public.bridge_cogs_send_out_trueup() from public, anon, authenticated;
grant  execute on function public.bridge_cogs_send_out_trueup() to service_role;

create or replace function public.bridge_cash_adjustment_void()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
begin
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'cash_adjustment'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_original_je is null then
    return NEW;
  end if;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  )
  values (
    -- 0141: Manila-local date of the void, not the UTC date `::date` reads.
    (NEW.voided_at at time zone 'Asia/Manila')::date,
    'Reversal of ' || v_orig_number || ': ' || coalesce(NEW.void_reason, '(no reason)'),
    'draft',
    'reversal',
    null,
    v_original_je,
    NEW.voided_by
  )
  returning id into v_reversal_je;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  select v_reversal_je, account_id, credit_php, debit_php, line_order
    from public.journal_lines
    where entry_id = v_original_je
    order by line_order;

  update public.journal_entries set status = 'posted' where id = v_reversal_je;

  update public.journal_entries
    set status = 'reversed',
        reversed_by = v_reversal_je
    where id = v_original_je;

  return NEW;
end;
$function$;

revoke execute on function public.bridge_cash_adjustment_void() from public, anon, authenticated;
grant  execute on function public.bridge_cash_adjustment_void() to service_role;

create or replace function public.bridge_payment_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
begin
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'payment'
      and source_id = OLD.id
      and status = 'posted'
    for update;
  if v_original_je is null then
    return OLD;
  end if;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  )
  values (
    -- 0141: Manila-local date of the delete, not the UTC date `current_date` reads.
    (now() at time zone 'Asia/Manila')::date,
    'Reversal of ' || v_orig_number || ': payment row deleted',
    'draft',
    'reversal',
    null,
    v_original_je,
    null
  )
  returning id into v_reversal_je;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  select v_reversal_je, account_id, credit_php, debit_php, line_order
    from public.journal_lines
    where entry_id = v_original_je
    order by line_order;

  -- Flip reversal to posted (validates balance).
  update public.journal_entries set status = 'posted' where id = v_reversal_je;

  update public.journal_entries
    set status = 'reversed',
        reversed_by = v_reversal_je
    where id = v_original_je;

  return OLD;
end;
$function$;

revoke execute on function public.bridge_payment_delete() from public, anon, authenticated;
grant  execute on function public.bridge_payment_delete() to service_role;

-- ---- Backfill: correct posting_date on any JE booked with the pre-fix bug -
-- See the header comment for the per-function reasoning. Every clause below
-- is guarded to affect 0 rows and never raise on an empty or missing table.

-- bridge_hmo_claim_resolution_insert
with resolution_candidates as (
  select je.id, je.posting_date as old_date, je.status,
         (hcr.resolved_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries je
  join public.hmo_claim_resolutions hcr on hcr.id = je.source_id
  where je.source_kind = 'hmo_claim_resolution'
    and je.status in ('posted', 'reversed')
    and je.posting_date is distinct from (hcr.resolved_at at time zone 'Asia/Manila')::date
),
resolution_skipped as (
  select * from resolution_candidates
  where status = 'posted' and public.period_status_for(new_date) = 'closed'
),
resolution_applied as (
  update public.journal_entries je
  set posting_date = c.new_date
  from resolution_candidates c
  where je.id = c.id
    and not (c.status = 'posted' and public.period_status_for(c.new_date) = 'closed')
  returning je.id
)
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'hmo_claim_resolution',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from resolution_skipped s;

-- bridge_hmo_claim_resolution_void
with hcr_void_candidates as (
  select r.id, r.posting_date as old_date,
         (hcr.voided_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries r
  join public.journal_entries orig on orig.id = r.reverses
  join public.hmo_claim_resolutions hcr on hcr.id = orig.source_id
  where r.source_kind = 'reversal'
    and r.status = 'posted'
    and orig.source_kind = 'hmo_claim_resolution'
    and hcr.voided_at is not null
    and r.posting_date is distinct from (hcr.voided_at at time zone 'Asia/Manila')::date
),
hcr_void_skipped as (
  select * from hcr_void_candidates where public.period_status_for(new_date) = 'closed'
),
hcr_void_applied as (
  update public.journal_entries r
  set posting_date = c.new_date
  from hcr_void_candidates c
  where r.id = c.id and public.period_status_for(c.new_date) is distinct from 'closed'
  returning r.id
)
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'hmo_claim_resolution_void',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from hcr_void_skipped s;

-- bridge_test_request_cancelled
with tr_last_reversed as (
  select o.id, o.source_id,
         row_number() over (partition by o.source_id order by o.created_at desc) as rn
  from public.journal_entries o
  where o.source_kind = 'test_request' and o.status = 'reversed'
),
cancel_candidates as (
  select r.id, r.posting_date as old_date,
         (r.created_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries r
  join tr_last_reversed lr on lr.id = r.reverses and lr.rn = 1
  join public.test_requests tr on tr.id = lr.source_id
  where r.source_kind = 'reversal'
    and r.status = 'posted'
    and tr.status = 'cancelled'
    and r.posting_date is distinct from (r.created_at at time zone 'Asia/Manila')::date
),
cancel_skipped as (
  select * from cancel_candidates where public.period_status_for(new_date) = 'closed'
),
cancel_applied as (
  update public.journal_entries r set posting_date = c.new_date
  from cancel_candidates c
  where r.id = c.id and public.period_status_for(c.new_date) is distinct from 'closed'
  returning r.id
)
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'test_request_cancelled',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from cancel_skipped s;

-- bridge_pf_at_hmo_allocation
with alloc_candidates as (
  select je.id, je.posting_date as old_date,
         (p.received_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries je
  join public.doctor_pf_entries pfe on pfe.id = je.source_id
  join public.hmo_payment_allocations hpa on hpa.id = pfe.hmo_allocation_id
  join public.payments p on p.id = hpa.payment_id
  where je.source_kind = 'doctor_pf_accrual'
    and je.status = 'posted'
    and pfe.hmo_allocation_id is not null
    and je.posting_date is distinct from (p.received_at at time zone 'Asia/Manila')::date
),
alloc_skipped as (
  select * from alloc_candidates where public.period_status_for(new_date) = 'closed'
),
alloc_applied as (
  update public.journal_entries je set posting_date = c.new_date
  from alloc_candidates c
  where je.id = c.id and public.period_status_for(c.new_date) is distinct from 'closed'
  returning je.id
)
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'pf_at_hmo_allocation',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from alloc_skipped s;

-- bridge_pf_at_hmo_writeoff
with writeoff_candidates as (
  select je.id, je.posting_date as old_date,
         (je.created_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries je
  join public.doctor_pf_entries pfe on pfe.id = je.source_id
  where je.source_kind = 'doctor_pf_accrual'
    and je.status = 'posted'
    and pfe.void_reason = 'hmo_writeoff'
    and je.posting_date is distinct from (je.created_at at time zone 'Asia/Manila')::date
),
writeoff_skipped as (
  select * from writeoff_candidates where public.period_status_for(new_date) = 'closed'
),
writeoff_applied as (
  update public.journal_entries je set posting_date = c.new_date
  from writeoff_candidates c
  where je.id = c.id and public.period_status_for(c.new_date) is distinct from 'closed'
  returning je.id
)
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'pf_at_hmo_writeoff',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from writeoff_skipped s;

-- bridge_cogs_send_out_trueup
with trueup_candidates as (
  select je.id, je.posting_date as old_date,
         (t.matched_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries je
  join public.cogs_send_out_trueups t on t.id = je.source_id
  where je.source_kind = 'cogs_send_out_trueup'
    and je.status = 'posted'
    and je.posting_date is distinct from (t.matched_at at time zone 'Asia/Manila')::date
),
trueup_skipped as (
  select * from trueup_candidates where public.period_status_for(new_date) = 'closed'
),
trueup_applied as (
  update public.journal_entries je set posting_date = c.new_date
  from trueup_candidates c
  where je.id = c.id and public.period_status_for(c.new_date) is distinct from 'closed'
  returning je.id
)
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'cogs_send_out_trueup',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from trueup_skipped s;

-- bridge_cash_adjustment_void
with cash_adj_candidates as (
  select r.id, r.posting_date as old_date,
         (eca.voided_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries r
  join public.journal_entries orig on orig.id = r.reverses
  join public.eod_cash_adjustments eca on eca.id = orig.source_id
  where r.source_kind = 'reversal'
    and r.status = 'posted'
    and orig.source_kind = 'cash_adjustment'
    and eca.voided_at is not null
    and r.posting_date is distinct from (eca.voided_at at time zone 'Asia/Manila')::date
),
cash_adj_skipped as (
  select * from cash_adj_candidates where public.period_status_for(new_date) = 'closed'
),
cash_adj_applied as (
  update public.journal_entries r set posting_date = c.new_date
  from cash_adj_candidates c
  where r.id = c.id and public.period_status_for(c.new_date) is distinct from 'closed'
  returning r.id
)
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'cash_adjustment_void',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from cash_adj_skipped s;

-- bridge_payment_delete
with payment_delete_candidates as (
  select r.id, r.posting_date as old_date,
         (r.created_at at time zone 'Asia/Manila')::date as new_date
  from public.journal_entries r
  join public.journal_entries orig on orig.id = r.reverses
  where r.source_kind = 'reversal'
    and r.status = 'posted'
    and orig.source_kind = 'payment'
    and not exists (select 1 from public.payments p where p.id = orig.source_id)
    and r.posting_date is distinct from (r.created_at at time zone 'Asia/Manila')::date
),
payment_delete_skipped as (
  select * from payment_delete_candidates where public.period_status_for(new_date) = 'closed'
),
payment_delete_applied as (
  update public.journal_entries r set posting_date = c.new_date
  from payment_delete_candidates c
  where r.id = c.id and public.period_status_for(c.new_date) is distinct from 'closed'
  returning r.id
)
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select null, 'system', 'gl.posting_date_backfill_skipped', 'journal_entries', s.id,
  jsonb_build_object(
    'reason', 'corrected_date_in_closed_period',
    'source_kind', 'payment_delete',
    'stored_posting_date', s.old_date,
    'would_be_posting_date', s.new_date
  )
from payment_delete_skipped s;

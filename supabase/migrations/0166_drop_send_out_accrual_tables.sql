-- 0166_drop_send_out_accrual_tables
--
-- Tidy-up after 0159 (release stopped accruing send-out cost) and 0164 (Send
-- Out expenses carry their partner lab). Owner decision 2026-09-24: send-out
-- cost is the "Send Out" expense — the accrual subledger is not coming back.
-- On prod at the time: cogs_send_out_entries = 1 row (₱0, no journal entry,
-- from a May 2026 test release), cogs_send_out_trueups = 0 rows, 0 journal
-- lines on 2150 "Accrued send-out". Nothing of value is lost.
--
-- Order matters: the two bridges below still UPDATE cogs_send_out_entries when
-- a test is cancelled or a release is undone, so they are re-created WITHOUT
-- that statement first (bodies otherwise identical to 0141 / 0140; prosrc md5
-- 4852c888… / bd572a52… verified against prod before editing), then the
-- true-up trigger and both tables go, then the per-service unit-cost column.
--
-- Deliberately kept:
--   * je_source_kind values 'cogs_send_out_accrual' / 'cogs_send_out_trueup' —
--     removing an enum value means recreating the type under journal_entries;
--     unused values are harmless.
--   * services.send_out_vendor_id — now the service's partner lab (0164).
--   * audit_log rows that mention send-out cost — history.
--
-- DEPLOY ORDER: push this right before PR #211 merges. The app still on main
-- reads services.send_out_unit_cost_php (service edit form) and both tables
-- (Outside-Lab pages), so those break between push and merge.

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
  -- (The send-out subledger void that followed was removed by 0166.)
  update public.doctor_pf_entries
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

  -- (The send-out subledger void that followed was removed by 0166.)
  update public.doctor_pf_entries
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

drop trigger if exists trg_bridge_cogs_send_out_trueup on public.cogs_send_out_trueups;
drop function if exists public.bridge_cogs_send_out_trueup();

-- cogs_send_out_entries.trueup_id references cogs_send_out_trueups, so it goes first.
drop table if exists public.cogs_send_out_entries;
drop table if exists public.cogs_send_out_trueups;

alter table public.services drop column if exists send_out_unit_cost_php;

-- 2150 "Accrued send-out" only ever existed for the accrual. Retire it (not
-- delete — chart rows can be referenced by history) when nothing uses it.
update public.chart_of_accounts coa
   set is_active = false
 where coa.code = '2150'
   and coa.is_active
   and not exists (select 1 from public.journal_lines               x where x.account_id = coa.id)
   and not exists (select 1 from public.bill_lines                  x where x.account_id = coa.id)
   and not exists (select 1 from public.payment_method_account_map  x where x.account_id = coa.id)
   and not exists (select 1 from public.cash_adjustment_account_map x where x.account_id = coa.id)
   and not exists (select 1 from public.vendors                     x where x.default_account_id = coa.id);

-- Post-conditions.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.prosrc ilike '%cogs_send_out_entries%' or p.prosrc ilike '%cogs_send_out_trueups%'
            or p.prosrc ilike '%send_out_unit_cost%')
  ) then
    raise exception '0166: a public function still references the dropped send-out objects';
  end if;
  if to_regclass('public.cogs_send_out_entries') is not null
     or to_regclass('public.cogs_send_out_trueups') is not null then
    raise exception '0166: send-out accrual tables still exist';
  end if;
end;
$$;

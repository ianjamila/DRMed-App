-- 0224_pf_payout_atomic.sql
-- =============================================================================
-- Paying a doctor becomes ONE atomic SQL function, and a cancelled or un-released
-- line can no longer be pulled out from under a payout that already went out.
--
-- THE BUGS (reproduced by scripts/gl-bridge-concurrency-proof.ts as KNOWN K1a / K1b
-- until this migration):
--
--  1. createPfDisbursement and the bulk EOD payout (createBulkPfPayoutCash) read the
--     open PF entries, validated them in TypeScript, allocated a batch number, INSERTED
--     the doctor_pf_disbursements header (its trigger bridge_pf_disbursement_post posts
--     Dr 2110 / Cr cash for the total) and only then ran
--         update doctor_pf_entries set disbursement_id = <new> where id in (...)
--     - four separate statements in four transactions, no row lock, and the link had no
--     `voided_at is null` / `disbursement_id is null` filter. A failed link left a posted
--     payout JE with no entries behind it (the bulk path did not even look at the error);
--     a concurrent cancel / undo of the line voided the entry in between, so the entry
--     ended VOIDED and DISBURSED - the doctor paid for a line that no longer counts and
--     2110 debited twice; two payouts of overlapping entries both succeeded and paid the
--     same fee twice (the second link simply re-pointed the entries); the batch counter
--     burned a number per failed attempt.
--
--  2. bridge_test_request_cancelled (0183) and fn_undo_release_bridge (0183) voided the
--     line's live doctor_pf_entries rows WITHOUT looking at disbursement_id. Even with no
--     race at all, cancelling or un-releasing a line whose fee was already paid out voided
--     the paid-out entry: the doctor keeps the money for a line that no longer counts, the
--     release JE (and its Cr 2110 accrual) is reversed, and 2110 nets wrong. The reverse
--     order of (1) is the same defect under a race (K1b).
--
-- THE FIX
--
--  A. pf_disburse_entries(p_physician_id, p_entry_ids, p_posted_date, p_method,
--     p_total_php, p_recorded_by, p_notes) -> jsonb {disbursement_id, batch_number}
--     (SECURITY DEFINER, pinned search_path, EXECUTE service_role only) does the whole
--     payout in one transaction:
--       1. lock the entries  ORDER BY id  FOR UPDATE  (ascending, so two overlapping
--          payouts queue behind each other instead of closing a cycle);
--       2. require every requested id found, all of one physician (p_physician_id),
--          voided_at is null, disbursement_id is null, recognized_at is not null - read
--          AFTER the lock, so a cancel / undo / payout that committed while we waited is
--          seen (READ COMMITTED re-reads a locked row's newest version);
--       3. recompute the total on the server: |sum(pf_php) - p_total_php| <= 0.005, the
--          tolerance the app used;
--       4. allocate the batch number (next_pf_disbursement_batch_number, same year rule),
--          insert the header (the trigger posts the JE) and link the entries - the link
--          UPDATE touches ONLY disbursement_id (0184's a_lifecycle_guard exempts exactly
--          that, so a payout takes no patient lifecycle lock and never waits on a
--          merge / delete of a patient whose work is already done) and re-asserts the
--          filters and the row count, so a link that matched fewer rows than it locked
--          rolls the whole payout back, header and JE included.
--     Every refusal is SQLSTATE P0085 with the staff-readable text the TypeScript used
--     to return ("One or more PF entries not found", "PF entries must all belong to the
--     same physician", "One or more PF entries are not open for disbursement",
--     "Total mismatch: expected X, got Y"); the whole call rolls back, so a refusal leaves
--     no header, no JE, no link and no burned batch number. Both server actions call it;
--     the audit rows stay in the actions exactly as before.
--
--  B. A line whose PF entry is DISBURSED can no longer be cancelled or un-released.
--     bridge_test_request_cancelled and fn_undo_release_bridge lock the line's live PF
--     entries  ORDER BY id  FOR UPDATE  as their FIRST statement (after the function's own
--     "does this row concern me" guards, before the waiver / journal / PF writes) and
--     raise P0084 - "This doctor's fee was already paid out — void the
--     payout first." - when any of them carries a disbursement_id. The raise is inside the
--     AFTER-UPDATE trigger, so the whole statement (the cancel, or the undo RPC's UPDATE
--     and everything it did) rolls back. Voiding the payout (voidPfDisbursementAndUnlink)
--     unlinks the entries; the undo / cancel then works. The lock is what makes the check
--     race-proof in both orders: a payout holding the entries makes the bridge WAIT and
--     then see the link (K1b); a cancel that voided the entries first makes the payout
--     WAIT and then refuse them (K1a).
--     The two bodies are 0183's VERBATIM except the lines marked `-- 0224`.
--
--  C. THE OTHER WRITERS THAT VOID / TOUCH PF ENTRIES (checked; decision per writer):
--       bridge_pf_at_hmo_writeoff     voids only entries with recognized_at IS NULL (a
--                                     pending HMO fee, nothing accrued) - a payout
--                                     requires recognized_at, so it can never be disbursed
--                                     -> the refusal does not apply.
--       bridge_pf_at_hmo_allocation   recognises a PENDING (recognized_at IS NULL) entry
--                                     and re-prices it; never touches a disbursed one
--                                     -> does not apply. (A payout racing it waits on the
--                                     entry lock and sees the recognised row.)
--       bridge_payment_void_pf_cascade  dropped by 0174 (nothing voids PF on a payment void).
--       bridge_test_request_released  INSERTS a new entry; the partial unique index
--                                     uq_doctor_pf_entries_one_per_test_request makes a
--                                     second live entry per line impossible -> does not apply.
--       voidPfDisbursementAndUnlink   the payout void itself: sets disbursement_id NULL on
--                                     the entries of one disbursement - the intended way
--                                     out of the refusal. It is a multi-step TypeScript
--                                     path (JE reversal, soft-void, unlink); making it
--                                     atomic is a separate piece of work.
--       lifecycle_patients_of_row / enforce_patient_activity   read-only references.
--     So the cancel bridge and the undo bridge are the only voiders of a RECOGNISED entry
--     and both are fixed here. (Deleting a line is refused once it is released - P0043 -
--     and the delete path never voids PF entries.)
--
-- LOCK ORDER. The bridges now take  PF entries (id order)  ->  journal entry  for the line
-- they were called for, AFTER the line (and, for the undo RPC, the patient lock and visit)
-- the caller already holds. The old UPDATE of the same entries sat later in the same
-- transaction, so no new edge exists: a line is never locked while a PF entry is held.
-- The payout takes entries (id order) -> pf_disbursement_year_counters; it never touches a
-- line, a visit or a patient lock (the link is guard-exempt), so it cannot close a cycle
-- with release / undo / cancel / merge. Proof: npm run gl-bridge:concurrency-proof -- --control
--
-- ACLs: pf_disburse_entries is service_role only (revoke public / anon / authenticated
-- stated explicitly, 0118 / 0119). The two re-created trigger functions keep exactly the
-- ACL 0183 gave them (revoke from public / anon / authenticated, EXECUTE service_role only -
-- never callable by a signed-in role; CREATE OR REPLACE would keep it, restated as 0118 does).
--
-- DEPLOY: additive for the app (the old app path keeps working until the app change
-- deploys). Push this migration BEFORE the PR that makes the actions call the RPC merges.
-- NOT on prod until its PR merges.
-- =============================================================================

create or replace function public.pf_disburse_entries(
  p_physician_id uuid,
  p_entry_ids    uuid[],
  p_posted_date  date,
  p_method       text,
  p_total_php    numeric,
  p_recorded_by  uuid,
  p_notes        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_e        record;
  v_found    integer := 0;
  v_total    numeric := 0;
  v_reason   text;
  v_batch    bigint;
  v_disb     uuid;
  v_linked   integer;
begin
  if p_entry_ids is null or cardinality(p_entry_ids) = 0 then
    raise exception 'Must select at least one open PF entry' using errcode = 'P0085';
  end if;

  -- 1. Lock every requested entry, ascending, and judge them AFTER the lock: the row a
  --    loop iteration sees is the newest committed version, so a cancel / undo / payout
  --    that finished while we waited is already reflected. The FIRST failing entry (in id
  --    order, as the TypeScript walked them) names the refusal.
  for v_e in
    select e.id, e.pf_php, e.physician_id, e.disbursement_id, e.voided_at, e.recognized_at
      from public.doctor_pf_entries e
     where e.id = any (p_entry_ids)
     order by e.id
       for update
  loop
    v_found := v_found + 1;
    v_total := v_total + v_e.pf_php;
    if v_reason is null then
      if v_e.physician_id is distinct from p_physician_id then
        v_reason := 'PF entries must all belong to the same physician';
      elsif v_e.disbursement_id is not null or v_e.voided_at is not null or v_e.recognized_at is null then
        v_reason := 'One or more PF entries are not open for disbursement';
      end if;
    end if;
  end loop;

  -- A duplicated id in the request finds fewer rows than ids, as it did in the app.
  if v_found <> cardinality(p_entry_ids) then
    raise exception 'One or more PF entries not found' using errcode = 'P0085';
  end if;
  if v_reason is not null then
    raise exception '%', v_reason using errcode = 'P0085';
  end if;

  -- 2. The server's total is the truth; the client's is a hint (centavo tolerance, as before).
  if p_total_php is null or abs(v_total - p_total_php) > 0.005 then
    raise exception 'Total mismatch: expected %, got %',
      trim_scale(v_total)::text, coalesce(trim_scale(p_total_php)::text, 'nothing')
      using errcode = 'P0085';
  end if;

  -- 3. Batch number, header (its trigger posts the JE) and the link: one transaction.
  v_batch := public.next_pf_disbursement_batch_number(extract(year from p_posted_date)::smallint);

  insert into public.doctor_pf_disbursements (
    batch_number, physician_id, posted_date, method, total_php, recorded_by, notes
  ) values (
    v_batch, p_physician_id, p_posted_date, p_method, p_total_php, p_recorded_by, p_notes
  ) returning id into v_disb;

  -- The link touches ONLY disbursement_id (a_lifecycle_guard exempts exactly that) and
  -- re-asserts what step 1 proved, so it can never re-point a voided or already-paid entry.
  update public.doctor_pf_entries
     set disbursement_id = v_disb
   where id = any (p_entry_ids)
     and voided_at is null
     and disbursement_id is null
     and recognized_at is not null;
  get diagnostics v_linked = row_count;
  if v_linked <> cardinality(p_entry_ids) then
    -- Unreachable while step 1 holds the locks; the whole payout (header, JE, batch
    -- number) rolls back if it ever is.
    raise exception 'One or more PF entries are not open for disbursement' using errcode = 'P0085';
  end if;

  return jsonb_build_object('disbursement_id', v_disb, 'batch_number', v_batch);
end;
$$;

revoke all     on function public.pf_disburse_entries(uuid, uuid[], date, text, numeric, uuid, text) from public;
revoke execute on function public.pf_disburse_entries(uuid, uuid[], date, text, numeric, uuid, text) from anon, authenticated;
grant  execute on function public.pf_disburse_entries(uuid, uuid[], date, text, numeric, uuid, text) to service_role;

comment on function public.pf_disburse_entries(uuid, uuid[], date, text, numeric, uuid, text) is
  '0224: pays a doctor in ONE transaction - locks the requested PF entries (id order), requires every one found, of p_physician_id, live, undisbursed and recognised, recomputes the total (0.005 tolerance), allocates the batch number, inserts the header (bridge_pf_disbursement_post posts the JE) and links the entries (disbursement_id only). Returns {disbursement_id, batch_number}. Raises P0085 (message passes through; nothing is changed).';

-- ---- Undo-release: refuse a line whose fee was already paid out ---------------
-- fn_undo_release_bridge() from 0183 (line 956), VERBATIM except the lines marked -- 0224.
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
  v_pf           record;  -- 0224
begin
  v_actor := auth.uid();

  -- 0224: a line whose doctor's fee was ALREADY PAID OUT cannot be un-released: voiding the paid entry
  -- would leave the doctor paid for a line that no longer counts and 2110 netting wrong. Lock the
  -- line's live PF entries (id order) FIRST - a payout holding them makes us wait and then see its
  -- link, a payout we beat makes IT refuse - and refuse before any write, so the whole statement
  -- rolls back. Void the payout first (it unlinks the entries).
  for v_pf in
    select e.id, e.disbursement_id
      from public.doctor_pf_entries e
     where e.test_request_id = new.id
       and e.voided_at is null
     order by e.id
       for update
  loop
    if v_pf.disbursement_id is not null then
      raise exception 'This doctor''s fee was already paid out — void the payout first.'
        using errcode = 'P0084';
    end if;
  end loop;

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

  -- 0183: a standalone waiver JE for this line is reversed too; a folded share went with the JE above.
  perform public.waiver_unrecognise_line(new.id, v_actor, 'release undone');

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

-- ---- Cancel: same refusal ------------------------------------------------------
-- bridge_test_request_cancelled() from 0183 (line 1044), VERBATIM except the lines marked -- 0224.
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
  v_pf           record;  -- 0224
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

  -- 0224: a line whose doctor's fee was ALREADY PAID OUT cannot be cancelled: voiding the paid entry
  -- would leave the doctor paid for a line that no longer counts and 2110 netting wrong. Lock the
  -- line's live PF entries (id order) FIRST - a payout holding them makes us wait and then see its
  -- link, a payout we beat makes IT refuse - and refuse before any write, so the whole statement
  -- rolls back. Void the payout first (it unlinks the entries).
  for v_pf in
    select e.id, e.disbursement_id
      from public.doctor_pf_entries e
     where e.test_request_id = new.id
       and e.voided_at is null
     order by e.id
       for update
  loop
    if v_pf.disbursement_id is not null then
      raise exception 'This doctor''s fee was already paid out — void the payout first.'
        using errcode = 'P0084';
    end if;
  end loop;

  perform public.waiver_unrecognise_line(new.id, v_actor, 'test request cancelled');

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

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
--  B2. The bridge lock alone is NOT enough for a multi-line Undo. undo_visit_release writes ONE multi-row
--     UPDATE of test_requests; the bridge fires per row, and a firing that reverses a release JE holds the
--     journal-entry number counter (je_next_number) until commit. For [lab line L1 with a release JE, doctor
--     line L2] the L1 firing holds the counter, then the L2 firing asks for its PF entry E - which a payout
--     already holds while it waits for the same counter (bridge_pf_disbursement_post): a 40P01 the one-line
--     scenarios cannot show. So undo_visit_release (0214 body VERBATIM + one hunk marked `-- 0224`) first
--     locks the PF entries of EVERY candidate line (and of the package header a component's undo cascades
--     to) ORDER BY id, before the line UPDATE and after the line locks release_report_locks already took -
--     the payout's own id order, so the two can only queue behind each other. ACL restated as 0198 / 0205 /
--     0214 left it: EXECUTE authenticated + service_role. release_visit_results needs nothing (its bridge only
--     INSERTS a PF entry). The cancel bridge has no app writer (only an operator's UPDATE and the package
--     cascade, whose components return before the PF code and whose header is one row): a multi-row operator
--     cancel of several doctor lines is the same shape and is NOT pre-locked - there is no statement to hook a
--     pre-lock into short of a statement-level trigger, and the app never issues one.
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
-- LOCK ORDER. The bridges take  PF entries (id order)  ->  journal entry  for the line they were
-- called for, AFTER the line (and, for the undo RPC, the patient lock and visit) the caller already
-- holds; undo_visit_release takes ALL its candidates' PF entries up front (B2), so the per-row bridge
-- firings never meet a PF entry they have not locked yet while holding the JE counter. A line is never
-- locked while a PF entry is held.
--
-- KNOWN, RARE, HARMLESS: voidPfDisbursementAndUnlink unlinks with one `update ... where disbursement_id = X`
-- (scan order, not id order; the Supabase client cannot lock first). Against a STALE payout of entries
-- that are still linked, the two can close a 40P01 between the unlink and the payout's id-ordered entry
-- locks. One side is aborted and retries; nothing is corrupted - and the payout refuses a still-linked
-- entry after its lock anyway (P0085).
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

-- ---- Undo-release RPC: pre-lock the PF entries of every candidate line -------------
-- undo_visit_release() from 0214 (line 279), VERBATIM except the hunk marked -- 0224.
create or replace function public.undo_visit_release(
  p_visit_id             uuid,
  p_test_request_ids     uuid[],
  p_actor                uuid  default null,
  -- The 10-minute batch Undo (undoReleaseBatchAction): {test_request_id:
  -- released_at} of the EXACT release that batch made. When given, a line is
  -- undone only while it still carries that release, and a combined report
  -- only when EVERY member does — otherwise it is skipped (changed_since),
  -- never undone in part and never raised. Every value must be a timestamp
  -- string (0205). Null for every other caller.
  p_expected_released_at jsonb default null,
  -- Why the release is undone — required, written on every audit row (0205).
  p_reason               text  default null,
  -- {metadata: {...caller extras}, ip, user_agent} for the audit rows (0205).
  p_audit                jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor    uuid;
  v_role     text;
  v_sections text[];
  v_ids      uuid[];
  v_reports  uuid[];
  v_expanded uuid[];
  v_ok       uuid[] := '{}';
  v_cands    uuid[];
  v_undone   jsonb;
  v_count    int;
  v_batch    boolean := p_expected_released_at is not null
                         and jsonb_typeof(p_expected_released_at) <> 'null';
  v_refused  uuid[]  := '{}';  -- members of reports a batch Undo must leave alone
  v_skipped  jsonb;
  v_why      text    := btrim(p_reason);
  v_extras   jsonb;
  v_ip       inet;
  v_ua       text;
  r          record;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from public.release_actor(p_actor) a;
  v_sections := public.lab_sections_for_role(v_role);
  -- via / undo_of_batch mark the 10-minute batch Undo: accepted only with its map.
  select c.extras, c.ip, c.user_agent into v_extras, v_ip, v_ua
    from public.release_audit_context(p_audit,
           array['bulk', 'bulk_batch_id', 'sample_visit_delete']
           || case when v_batch then array['via', 'undo_of_batch'] else '{}'::text[] end) c;

  if v_why is null or v_why = '' then
    raise exception 'Give a reason for undoing the release.' using errcode = 'P0081';
  end if;
  if length(v_why) > 2000 then
    raise exception 'The reason is too long — keep it under 2,000 characters.' using errcode = 'P0081';
  end if;

  if v_batch then
    begin
      if jsonb_typeof(p_expected_released_at) <> 'object' then
        raise exception using errcode = '22023';
      end if;
      -- 0205: every value a timestamp STRING — a JSON null (or number, …)
      -- would make the report check below unknown rather than false.
      if exists (select 1 from jsonb_each(p_expected_released_at) e
                  where jsonb_typeof(e.value) <> 'string') then
        raise exception using errcode = '22023';
      end if;
      perform (e.key)::uuid, (e.value)::timestamptz from jsonb_each_text(p_expected_released_at) e;
    exception when others then
      raise exception 'Couldn''t read which release to undo — try again.' using errcode = 'P0081';
    end;
  end if;

  v_ids := array(
    select distinct x from unnest(coalesce(p_test_request_ids, '{}'::uuid[])) x
     where x is not null order by x);
  if cardinality(v_ids) = 0 then
    raise exception 'No tests selected.' using errcode = 'P0081';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'Too many tests selected — select fewer.' using errcode = 'P0081';
  end if;

  v_reports := public.release_report_locks(
    p_visit_id, v_ids, 'This visit was deleted from the queue. Restore it before undoing a release.');

  -- Whole-report expansion (0172, expandUndoReleaseScope): every member of a
  -- touched combined report is undone with it, whatever its own status; the
  -- WHOLE request is refused when any member (deleted ones included) is
  -- outside the caller's sections, a package header, or on another visit.
  v_expanded := v_ids;
  for r in
    select rtr.result_id,
           array_agg(tr.id) as member_ids,
           bool_or(v_sections is not null
                   and (s.section is null or not (s.section = any (v_sections)))) as outside,
           bool_or(tr.is_package_header) as has_header,
           bool_or(tr.visit_id <> p_visit_id) as other_visit
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      left join public.services s on s.id = tr.service_id
     where rtr.result_id = any (v_reports)
     group by rtr.result_id
    having count(*) > 1
     order by rtr.result_id
  loop
    if r.outside then
      raise exception 'This report has tests outside the sections you can act on, so it can''t be undone from here — ask an admin.'
        using errcode = 'P0081';
    elsif r.has_header then
      raise exception 'This report includes a package header, which shouldn''t happen — ask an admin to check it.'
        using errcode = 'P0081';
    elsif r.other_visit then
      raise exception 'This report spans more than one visit, which shouldn''t happen — ask an admin to check it.'
        using errcode = 'P0081';
    end if;
    -- Batch Undo: the report comes back only if every member (deleted ones
    -- included) is still exactly the release this batch made. `is not true`
    -- (0205): an unknown answer — a released member with no released_at —
    -- counts as changed, so the report is skipped whole, never split.
    if v_batch and exists (
         select 1
           from unnest(r.member_ids) m
           join public.test_requests tr on tr.id = m
          where (p_expected_released_at ? m::text
                 and tr.status = 'released'
                 and tr.deleted_at is null
                 and tr.released_at = (p_expected_released_at ->> m::text)::timestamptz) is not true) then
      v_refused := v_refused || r.member_ids;
      continue;
    end if;
    v_ok := v_ok || r.result_id;
    v_expanded := v_expanded || r.member_ids;
  end loop;

  -- The released, live, non-header lines among them this role may act on.
  -- Headers only ever flip through the 0110 cascade (fn_undo_release_bridge),
  -- never directly: a header back at ready with its components released
  -- would re-release (with a fresh journal entry) on the next payment change.
  v_cands := array(
    select tr.id
      from public.test_requests tr
      left join public.services s on s.id = tr.service_id
     where tr.id = any (v_expanded)
       and tr.visit_id = p_visit_id
       and tr.status = 'released'
       and not tr.is_package_header
       and tr.deleted_at is null
       and (v_sections is null or s.section = any (v_sections))
       and not (tr.id = any (v_refused))
       and (not v_batch
            or (p_expected_released_at ? tr.id::text
                and tr.released_at = (p_expected_released_at ->> tr.id::text)::timestamptz))
     order by tr.id);
  if cardinality(v_cands) = 0 and not v_batch then
    raise exception 'None of the selected tests can be unreleased.' using errcode = 'P0081';
  end if;

  -- 0224: pre-lock the doctor PF entries of EVERY line this call is about to undo (and of the header a
  -- package component's undo cascades to), ORDER BY id, BEFORE the line UPDATE. The UPDATE below is ONE
  -- multi-row statement: fn_undo_release_bridge fires per row, and each firing that reverses a release
  -- JE holds the journal-entry number counter (je_next_number) until commit. Without this, the firing
  -- for a later doctor line would only then ask for its PF entry - while a payout (pf_disburse_entries)
  -- already holds that entry and waits for the same counter in bridge_pf_disbursement_post: a 40P01.
  -- Taken after the lines (release_report_locks) and in the payout's own id order, so the payout and this
  -- call can only queue behind each other. The bridge's own lock then finds the rows already held.
  perform 1
     from public.doctor_pf_entries e
    where e.voided_at is null
      and (e.test_request_id = any (v_cands)
           or e.test_request_id in (select t.parent_id from public.test_requests t
                                     where t.id = any (v_cands) and t.parent_id is not null))
    order by e.id
      for update;

  -- The prior release medium/time and the patient's view count are read under
  -- the row lock, so the audit rows (0205: written here, in this transaction)
  -- describe the release actually undone.
  with prior as (
    select tr.id, tr.release_medium, tr.released_at, coalesce(vc.viewed_count, 0) as viewed_count
      from public.test_requests tr
      left join public.result_view_counts(v_cands) vc on vc.test_request_id = tr.id
     where tr.id = any (v_cands)
  ),
  upd as (
    update public.test_requests t
       set status         = 'ready_for_release',
           released_at    = null,
           released_by    = null,
           release_medium = null
     where t.id = any (v_cands)
       and t.status = 'released'
    returning t.id
  ),
  done as (
    select upd.id, prior.release_medium, prior.released_at, prior.viewed_count, rtr.result_id as report_id
      from upd
      join prior on prior.id = upd.id
      left join public.result_test_requests rtr
        on rtr.test_request_id = upd.id and rtr.result_id = any (v_ok)
  ),
  aud as (
    insert into public.audit_log
      (actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent, created_at)
    select v_actor, 'staff', 'test_request.release_undone', 'test_request', done.id,
           v_extras
             || jsonb_build_object(
                  'visit_id', p_visit_id,
                  'reason', v_why,
                  'prior_release_medium', done.release_medium,
                  'prior_released_at', done.released_at,
                  -- RA 10173: undoing does not un-see a result the patient opened.
                  'viewed_count', done.viewed_count,
                  -- Set only when reverted as part of a whole-report undo (0172).
                  'report_result_id', done.report_id),
           v_ip, v_ua, clock_timestamp()
      from done
    returning 1
  )
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', done.id,
           'prior_release_medium', done.release_medium,
           'prior_released_at', done.released_at,
           'report_id', done.report_id) order by done.id), '[]'::jsonb)
    into v_count, v_undone
    from done;
  if v_count <> cardinality(v_cands) then
    raise exception 'These tests changed while undoing — nothing was changed. Try again.'
      using errcode = '40001';
  end if;

  -- 0214: cancel this visit's release notices that have nothing left to announce.
  -- A notice is spent when NONE of its tests is still released with the release
  -- that stamped it (undone in this call, or earlier). A partly undone notice is
  -- left alone: the sender's re-check trims it to what is still released. Only
  -- pending / retry rows: a 'sending' row has a live lease and belongs to its
  -- sender (which re-checks), and terminal rows are history. Runs whatever the
  -- flag says: a stale pending row must not outlive its release because the flag
  -- was flipped off. Locked after every line, so no new lock-order edge; a claimer
  -- holding the row makes this wait for the claim (SKIP LOCKED never waits on us),
  -- and the WHERE is re-checked on the row it left, so a row just leased ('sending')
  -- is skipped, never cancelled. audited_at is stamped: this undo already wrote its
  -- own release_undone audit rows, and a later result.notice_cancelled row carrying
  -- the old bulk_batch_id would read as an unrelated change to a re-release's Undo.
  update public.release_notices n
     set status           = 'cancelled',
         resolved_at      = clock_timestamp(),
         audited_at       = clock_timestamp(),
         lease_token      = null,
         lease_expires_at = null,
         skip_reason      = 'release undone'
   where n.visit_id = p_visit_id
     and n.status in ('pending', 'retry')
     and not exists (
           select 1
             from unnest(n.test_request_ids) m(id)
             join public.test_requests tr on tr.id = m.id
            where tr.status = 'released'
              and tr.released_at = n.released_at);

  -- Selected lines not undone: no longer released (or, for a batch Undo, no
  -- longer this batch's release, or on a report that is not).
  v_skipped := coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x, 'code', case when v_batch then 'changed_since' else 'not_released' end) order by x)
      from unnest(v_ids) x
     where not (x = any (v_cands))), '[]'::jsonb);

  return jsonb_build_object('undone', v_undone, 'skipped', v_skipped);
end;
$$;

comment on function public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb) is
  'Undoes the release of the selected tests of one visit (0198), expanded to every member of each touched combined report (0172), under the same locks as release_visit_results, with one test_request.release_undone audit row per undone row in the same transaction (0205; p_reason required, p_audit = {metadata, ip, user_agent}). In the same transaction (0214) it cancels this visit''s pending / retry release notices none of whose tests is still released with that release (partly undone and sending rows are left alone). 0224: before the line UPDATE it locks the doctor PF entries of every candidate line ORDER BY id (a payout in flight makes it wait, then the bridge refuses a paid-out line with P0084). Returns {undone: [{id, prior_release_medium, prior_released_at, report_id}], skipped: [{id, code: not_released|changed_since}]}. p_expected_released_at (batch Undo; every value a timestamp string) limits it to lines — and whole reports — still carrying that exact release, and then never raises for nothing-to-undo. Raises P0081 (whole request refused, message passes through), P0084 (a line whose doctor fee was already paid out — nothing changes), 40001/P0072 (retry), P0058 (patient inactive), 42501.';

revoke all on function public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb) to authenticated, service_role;

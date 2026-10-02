-- 0222_ap_bill_lock_order.sql
-- =============================================================================
-- Expenses (AP): one global lock order for every writer that moves money onto or
-- off a bill, and a bill-row lock BEFORE the paid-amount recompute sums.
--
--   payment row(s) -> every affected bill ORDER BY id FOR NO KEY UPDATE
--     -> journal (JE row, then the entry counter) -> writes
--
-- THE BUGS (reproduced as KNOWN by scripts/ap-subledger-concurrency-proof.ts,
-- scenarios K2, K3 and D1, plus the free race F4; all four are now asserted):
--
--  K2 / K3  LOST UPDATE of bills.paid_amount / status. The per-row allocation
--     trigger ap_recompute_bill_paid_and_status SUMS the bill's active
--     allocations in one statement and only then UPDATEs the bill. Under READ
--     COMMITTED the sum is a snapshot: a second writer that sums while the first
--     is still uncommitted sees only its own allocation, then waits on the bill
--     row the first one updated, and finally writes its stale figure over the
--     first writer's committed one. Two payments reallocated onto one bill with
--     room for both (K2), or a payment voided while another is reallocated onto
--     the same bill (K3), ended with 100 allocated and paid_amount 50 /
--     'partially_paid' (or the reverse, paid_amount 0 over a live 50). The void /
--     create paths hid it only because each posts a journal entry and is
--     serialised globally on the entry counter; a reallocation posts none.
--  D1       DEADLOCK (40P01), a lock-order cycle. ap_void_bill_with_guard takes
--     the BILL row, then the journal entry and its counter (ap_reverse_je_for_source
--     -> je_next_number); ap_void_bill_payment_cascade took the PAYMENT row, the
--     same counter, and only then the BILL row (its allocation UPDATE fires the
--     recompute trigger, which UPDATEs the bill). Opposite order, so a bill void
--     parked on the bill_post entry and a payment void of that bill's payment
--     closed a cycle. ap_create_bill_payment_with_allocations had the same shape
--     (payment insert -> bridge -> counter, THEN the bill through the allocation
--     insert) against a bill void or a draft post (bill -> counter): proven as D2.
--  F4 / O1  two reallocations over the same two bills in OPPOSITE order (the
--     array order was the lock order, because each allocation insert's recompute
--     UPDATEs its bill): a cycle ended one side in 40P01. F4 saw it only by luck;
--     O1 forces it.
--
-- THE FIX
--  1. ap_recompute_bill_paid_and_status locks the bill row (FOR NO KEY UPDATE -
--     the mode its own UPDATE already takes, so no new conflict with the
--     KEY SHARE an allocation insert's foreign-key check holds: FOR UPDATE would
--     deadlock two concurrent inserts onto one bill) BEFORE it sums. The sum is
--     then a NEW statement, which under READ COMMITTED takes a fresh snapshot
--     after the lock wait, so it sees everything the first writer committed.
--  2. Every AP writer that touches a bill through allocations takes the bills it
--     will touch up front, in id order, right after its payment row and before
--     any journal work:
--       ap_void_bill_payment_cascade          the payment's ACTIVE allocation bills
--       ap_reallocate_bill_payment            old allocation bills U new bills
--       ap_create_bill_payment_with_allocations  the target bills (before the
--                                             payment insert posts its entry)
--     Two writers contending for bills now queue on the lowest shared bill
--     instead of crossing, and none holds the entry counter while waiting for a
--     bill. The pre-lock is also what makes the recompute lock redundant for
--     these callers (stated honestly in the proof header): the recompute lock is
--     the defence for any writer that does not pre-lock (a direct allocation
--     write), and the pre-locks are the ordering the cycles need.
--  Left alone, deliberately:
--   * ap_void_bill_with_guard (0049): already bill FOR UPDATE -> JE -> counter,
--     the global order. ap_reverse_je_for_source: JE row -> counter, last.
--   * ap_bill_post_bridge (a direct post, postBillAction): bill -> counter, the
--     global order. ap_update_bill_draft / ap_post_recurring_template: no
--     journal, no allocation; they lock the bill / template only.
--   * ap_create_bill_and_post / ap_create_bill_draft / ap_create_bill_paid_on_entry:
--     they create the bill in the SAME transaction, so no other session can see,
--     let alone lock, that row; the entry counter followed by the new bill's
--     recompute lock cannot form a cycle.
--   * ap_bill_payment_drawer_link / _void_mirror (0149) and the cash-adjustment
--     bridge: run after the entry counter and never lock a bill.
--
-- Every function below is its 0049 body VERBATIM plus the marked `-- 0222`
-- blocks (the proof's control mutants strip exactly those blocks); same
-- signature, SECURITY DEFINER, search_path; ACLs restated per 0118.
-- Proof: npm run ap-subledger:concurrency-proof -- --control
--   K2 K3 K4 D1 D2 O1 F4 F5 asserted; control mutants MK / MKK / MD / MCP / MRO.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The recompute trigger: lock the bill, THEN sum.
-- ---------------------------------------------------------------------------
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
  -- 0222 lock begin
  -- Take the row the UPDATE below locks anyway BEFORE summing, and sum in the
  -- NEXT statement: a statement started after the lock wait takes a fresh
  -- READ COMMITTED snapshot, so it sees every allocation the previous holder
  -- committed (the lost update of K2 / K3). NO KEY UPDATE = the UPDATE's own
  -- mode: no new conflict with the KEY SHARE an allocation insert holds.
  perform 1 from public.bills where id = v_bill_id for no key update;
  -- 0222 lock end

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

  -- Defense-in-depth: bill must exist (FK + on-update-restrict already enforce this).
  if v_current_status is null then
    raise warning 'ap_recompute_bill_paid_and_status: bill % no longer exists; skipping recompute', v_bill_id;
    return null;
  end if;

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

-- Trigger function: no runtime role calls it directly (0118).
revoke execute on function public.ap_recompute_bill_paid_and_status() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Create a payment + allocations: lock the target bills before the payment
--    insert posts its journal entry.
-- ---------------------------------------------------------------------------
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
  -- 0222 lock begin
  -- Global order: bills (id order) BEFORE the journal. The payment insert below
  -- posts its entry (the counter) and only the allocation inserts reach the bills;
  -- against a bill void or a draft post (bill -> counter) that was a cycle (D2).
  perform 1 from public.bills
    where id in (select (t.v->>'bill_id')::uuid from jsonb_array_elements(p_input->'allocations') as t(v))
    order by id
      for no key update;
  -- 0222 lock end

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

revoke execute on function public.ap_create_bill_payment_with_allocations(p_input jsonb, p_actor_id uuid) from public, anon, authenticated;
grant  execute on function public.ap_create_bill_payment_with_allocations(p_input jsonb, p_actor_id uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Reallocate: lock old U new bills (id order) right after the payment row.
-- ---------------------------------------------------------------------------
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

  -- 0222 lock begin
  -- Global order: payment row (above) -> every bill the delete / inserts below
  -- will UPDATE through the recompute trigger, in id order. The array order used
  -- to be the lock order, so two reallocations over the same two bills in opposite
  -- order closed a cycle (F4 / O1). The payment row is held, so the active
  -- allocations read here cannot change under us.
  perform 1 from public.bills
    where id in (
      select bill_id from public.bill_payment_allocations
        where payment_id = p_payment_id and voided_at is null
      union
      select (t.v->>'bill_id')::uuid from jsonb_array_elements(p_allocations) as t(v)
    )
    order by id
      for no key update;
  -- 0222 lock end

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

  -- At transaction commit, deferred trigger validates P0030-P0033.

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (p_actor_id, 'staff', 'bill_payment.reallocated', 'bill_payment', p_payment_id,
          jsonb_build_object('before', v_old, 'after', p_allocations));

  return jsonb_build_object('payment_id', p_payment_id);
end;
$$;

revoke execute on function public.ap_reallocate_bill_payment(p_payment_id uuid, p_allocations jsonb, p_actor_id uuid) from public, anon, authenticated;
grant  execute on function public.ap_reallocate_bill_payment(p_payment_id uuid, p_allocations jsonb, p_actor_id uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Void a payment: lock its allocated bills (id order) right after the
--    payment row, BEFORE the reversal posts to the journal.
-- ---------------------------------------------------------------------------
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

  -- 0222 lock begin
  -- Global order: payment row (above) -> the bills the allocation cascade below
  -- will UPDATE (through the recompute trigger), in id order -> only THEN the
  -- journal. Taking the bill after the reversal's entry counter was the other
  -- half of D1: ap_void_bill_with_guard holds the bill and queues for the counter.
  perform 1 from public.bills
    where id in (
      select bill_id from public.bill_payment_allocations
        where payment_id = p_payment_id and voided_at is null
    )
    order by id
      for no key update;
  -- 0222 lock end

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

revoke execute on function public.ap_void_bill_payment_cascade(p_payment_id uuid, p_reason text, p_actor_id uuid) from public, anon, authenticated;
grant  execute on function public.ap_void_bill_payment_cascade(p_payment_id uuid, p_reason text, p_actor_id uuid) to service_role;

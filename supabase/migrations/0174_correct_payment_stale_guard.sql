-- =============================================================================
-- 0174_correct_payment_stale_guard.sql
-- =============================================================================
-- Follow-ups to 0161 (Edit / Move payment) from the post-merge reviews of #213.
-- correct_payment keeps every 0161 rule; three things change there, and the
-- PF clawback on a payment void is removed (4).
--
-- 1. STALE-STATE GUARD (p_expected). The Edit dialog sends the whole payment
--    as it was when the dialog opened; Move re-sends the reference and notes
--    it read a moment before the call. Neither was checked against the row
--    the function locks, so a second person's change in between was silently
--    overwritten — an in-place reference fix reverted by a Move, or an Edit
--    saved over someone else's reference correction. The caller now passes
--    what it saw; under the FOR UPDATE lock any difference is refused (P0054,
--    "changed by someone else") instead of applied. Every key is optional and
--    the parameter defaults to NULL, so a caller that sends nothing behaves
--    exactly as under 0161 — which is also what keeps the running app working
--    between this push and its deploy (PostgREST resolves the old 8 named
--    arguments to this 9-argument function through the defaults).
--
-- 2. GIFT-CODE LINK. 0161 refused method = 'gift_code'. A redemption is the
--    row gift_codes.redeemed_payment_id points at, whatever its method (rows
--    from before 0139 were recorded under the counter method). Re-creating
--    one would leave the code pointing at a voided payment. Refused by the
--    link itself now. (Prod had no such row when this was written.)
--
-- 3. AMOUNT CEILING. payments.amount_php is numeric(10,2); anything past
--    99,999,999.99 raised a raw 22003 "numeric field overflow" at the INSERT.
--    Refused up front with a readable P0054.
--
-- 4. NO PF CLAWBACK ON A PAYMENT VOID (owner decision, 2026-09-25). A doctor's
--    fee is recorded at release, and release needs the visit's money settled;
--    deleting, editing or moving a payment afterwards must never take the fee
--    back. 0064's trg_bridge_payment_void_pf_cascade did exactly that whenever
--    the voided payment's visit did not read 'paid' — which on a CASH visit it
--    never saw (AFTER triggers fire alphabetically, so it ran before
--    trg_payments_recalc_on_void), but on an HMO visit it always did: 0133
--    releases HMO visits unpaid, so voiding (or Editing, which voids) a co-pay
--    voided the doctor's pending HMO fee for good (reproduced locally). The
--    trigger and its function are dropped. It was the only writer of
--    recognition_basis = 'clawback' rows; doctor_pf_entries was empty on prod.
--    Releasing a result and taking it back (undo release / cancel) keep their
--    own PF handling — this only removes the payment-void path.
-- =============================================================================

drop function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid);

create function public.correct_payment(
  p_payment_id       uuid,
  p_amount_php       numeric,
  p_method           text,
  p_reference_number text,
  p_notes            text,
  p_reason           text,
  p_actor_id         uuid,
  p_visit_id         uuid default null,
  p_expected         jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old    public.payments%rowtype;
  v_new_id uuid;
  v_target uuid;
  v_moving boolean;
  v_ref    text := nullif(btrim(coalesce(p_reference_number, '')), '');
  v_notes  text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if p_actor_id is null then
    raise exception 'Edit payment needs the staff member making the change.'
      using errcode = 'P0054';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to edit a payment.'
      using errcode = 'P0054';
  end if;

  select * into v_old
    from public.payments
   where id = p_payment_id
   for update;

  if not found then
    raise exception 'Payment not found.' using errcode = 'P0054';
  end if;
  if v_old.voided_at is not null then
    raise exception 'This payment was already deleted or edited. Refresh the visit and try again.'
      using errcode = 'P0054';
  end if;

  -- What the caller saw must still be what is there. Text fields compare the
  -- way they are stored (trimmed, '' = NULL); a key the caller left out is
  -- not checked.
  if p_expected is not null and (
       (p_expected ? 'amount_php'
          and v_old.amount_php is distinct from (p_expected->>'amount_php')::numeric)
    or (p_expected ? 'method'
          and v_old.method is distinct from (p_expected->>'method'))
    or (p_expected ? 'visit_id'
          and v_old.visit_id is distinct from (p_expected->>'visit_id')::uuid)
    or (p_expected ? 'reference_number'
          and v_old.reference_number is distinct from
              nullif(btrim(coalesce(p_expected->>'reference_number', '')), ''))
    or (p_expected ? 'notes'
          and v_old.notes is distinct from
              nullif(btrim(coalesce(p_expected->>'notes', '')), ''))
  ) then
    raise exception 'Someone else changed this payment since you opened it. Refresh the visit and try again.'
      using errcode = 'P0054';
  end if;

  if v_old.method in ('gift_code', 'hmo')
     or exists (select 1 from public.gift_codes where redeemed_payment_id = v_old.id) then
    raise exception 'Gift code and HMO payments cannot be edited. Delete it and record it again.'
      using errcode = 'P0054';
  end if;
  if v_old.legacy_import_run_id is not null then
    raise exception 'Payments from the imported history cannot be edited. Delete it and record it again.'
      using errcode = 'P0054';
  end if;
  -- The method is only checked when it CHANGES: a Move (or a reference fix)
  -- re-sends the payment's own method, and a legacy bpi / maybank receipt
  -- must stay what it was rather than be refused for a method the counter no
  -- longer offers. A new method must be one the counter records today.
  if p_method is null
     or (p_method is distinct from v_old.method
         and p_method not in ('cash', 'gcash', 'maya', 'card', 'bank_transfer')) then
    raise exception 'Choose Cash, GCash, Maya, Card or Bank transfer.'
      using errcode = 'P0054';
  end if;
  if p_amount_php is null or p_amount_php <= 0 then
    raise exception 'Amount must be greater than zero.' using errcode = 'P0054';
  end if;
  if round(p_amount_php, 2) <> p_amount_php then
    raise exception 'Amount can have at most two decimal places.' using errcode = 'P0054';
  end if;
  if p_amount_php > 99999999.99 then
    raise exception 'Amount is too large.' using errcode = 'P0054';
  end if;

  v_target := coalesce(p_visit_id, v_old.visit_id);
  v_moving := v_target <> v_old.visit_id;
  if v_moving then
    if not exists (select 1 from public.visits where id = v_target) then
      raise exception 'Visit not found.' using errcode = 'P0054';
    end if;
    if exists (select 1 from public.visits where id = v_target and deleted_at is not null) then
      raise exception 'That visit was deleted from the queue. Restore it before moving a payment onto it.'
        using errcode = 'P0054';
    end if;
  end if;

  -- Reference / notes only: not a money change, edit in place.
  if not v_moving and p_amount_php = v_old.amount_php and p_method = v_old.method then
    if v_ref is not distinct from v_old.reference_number
       and v_notes is not distinct from v_old.notes then
      raise exception 'Nothing changed.' using errcode = 'P0054';
    end if;
    update public.payments
       set reference_number = v_ref,
           notes            = v_notes
     where id = p_payment_id;
    return p_payment_id;
  end if;

  -- Money change or move: re-create, then void. See 0161's header for the order.
  insert into public.payments (
    visit_id, amount_php, method, reference_number, notes,
    received_by, received_at, corrects_payment_id
  ) values (
    v_target, p_amount_php, p_method, v_ref, v_notes,
    v_old.received_by, v_old.received_at, v_old.id
  )
  returning id into v_new_id;

  update public.payments
     set voided_at   = now(),
         voided_by   = p_actor_id,
         void_reason = case when v_moving then 'Moved: ' else 'Edited: ' end || btrim(p_reason)
   where id = p_payment_id;

  return v_new_id;
end;
$$;

drop trigger trg_bridge_payment_void_pf_cascade on public.payments;
drop function public.bridge_payment_void_pf_cascade();

comment on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb) is
  'Edit / Move a payment (0161, stale guard 0174): re-create then void in one transaction; reference/notes-only edits in place. p_expected = the payment as the caller saw it; any difference is refused (P0054).';

revoke execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  to service_role;

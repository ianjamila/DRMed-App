-- =============================================================================
-- 0161_payment_correction.sql
-- =============================================================================
-- "Edit payment" and "Move payment" on the visit page. Reception records a
-- payment with the wrong method (GCash keyed as Cash), the wrong amount, or on
-- the wrong visit, and until now the only fix
-- was Void + Record payment again — two steps, two chances to stop halfway and
-- leave the visit reading "Unpaid", and nothing linking the two rows.
--
-- A payment's money fields cannot be edited in place: 0030's P0004 guard
-- refuses amount/method/visit/received_at changes once its journal entry has
-- posted ("Void and re-create instead"), and the cash drawer, the GL bridge and
-- the HMO/PF cascades all key off the insert and the void. So an edit IS a
-- void and a re-create — done here in ONE transaction:
--
--   1. INSERT the corrected payment first (same visit, same received_at, same
--      received_by — the correction describes the money that came in then, not
--      a new receipt), with corrects_payment_id pointing at the original.
--      Inserting first keeps the visit's paid total from ever dipping, so the
--      void below never sees a transient "unpaid" visit.
--   2. VOID the original (voided_by = the editor, void_reason 'Edited: …').
--      trg_bridge_payment_void posts the reversal JE; recalc fires; the drawer
--      stops counting it.
--
-- Either both land or neither does: the closed-day lock (P0015), the
-- deleted-visit guard (P0045) or a stale row all abort the whole edit.
--
-- MOVE (p_visit_id set to another visit) is the same re-create-then-void with
-- the corrected row on the target visit: the money arrived when it arrived, it
-- was only filed against the wrong visit. The original's void_reason starts
-- 'Moved: ' instead of 'Edited: '. The target must exist and be live — P0045
-- would refuse a deleted one on insert, but with a raw message.
--
-- A change to reference/notes ONLY is not a money change (P0004 does not guard
-- those columns) and is updated in place — no reversal churn in the books.
--
-- Not editable (P0054): gift-code redemptions (the code's redeemed_payment_id,
-- breakage JE and whole-use rules belong to the original row), HMO settlements
-- (they carry hmo_payment_allocations that a void cascades away), and payments
-- from the legacy history import (their money is already in the GL through the
-- imported journal, and a new app payment would post it a second time). All
-- three can still be voided (Delete) exactly as before.
--
-- service_role only: called from the server action through the admin client,
-- which passes p_actor_id from requireActiveStaff() (reception/admin gate).
-- =============================================================================

alter table public.payments
  add column corrects_payment_id uuid references public.payments(id);

comment on column public.payments.corrects_payment_id is
  'Set on a payment created by "Edit payment" (correct_payment, 0161): the voided original it replaces.';

-- One correction per original: a second concurrent edit of the same payment
-- fails here even if it slipped past the row lock's voided_at re-check.
create unique index payments_corrects_payment_id_key
  on public.payments (corrects_payment_id)
  where corrects_payment_id is not null;

create or replace function public.correct_payment(
  p_payment_id       uuid,
  p_amount_php       numeric,
  p_method           text,
  p_reference_number text,
  p_notes            text,
  p_reason           text,
  p_actor_id         uuid,
  p_visit_id         uuid default null
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
  if v_old.method in ('gift_code', 'hmo') then
    raise exception 'Gift code and HMO payments cannot be edited. Delete it and record it again.'
      using errcode = 'P0054';
  end if;
  if v_old.legacy_import_run_id is not null then
    raise exception 'Payments from the imported history cannot be edited. Delete it and record it again.'
      using errcode = 'P0054';
  end if;
  if p_method is null or p_method not in ('cash', 'gcash', 'maya', 'card', 'bank_transfer') then
    raise exception 'Choose Cash, GCash, Maya, Card or Bank transfer.'
      using errcode = 'P0054';
  end if;
  if p_amount_php is null or p_amount_php <= 0 then
    raise exception 'Amount must be greater than zero.' using errcode = 'P0054';
  end if;
  if round(p_amount_php, 2) <> p_amount_php then
    raise exception 'Amount can have at most two decimal places.' using errcode = 'P0054';
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

  -- Money change or move: re-create, then void. See the header for the order.
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

revoke execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid)
  to service_role;

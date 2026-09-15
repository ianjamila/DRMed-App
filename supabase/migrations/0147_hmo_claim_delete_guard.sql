-- 0147_hmo_claim_delete_guard.sql
-- P0050 — refuse to soft-delete a visit, or a bill line, that still carries a
-- non-voided HMO claim item.
--
-- WHY. 0146 taught the HMO read layer to skip deleted rows, which is right for
-- every view except three: `v_hmo_stuck`, `v_hmo_ar_aging`'s claim-item leg and
-- `v_ops_daily_hmo_provider_ar` describe a receivable ALREADY SUBMITTED to an
-- HMO. Filtering those means a visit deleted after submission silently drops
-- out of AR and nobody chases money the clinic really billed. That was a
-- deliberate choice, because the actual defect is one level up: such a visit
-- should never have been deletable. This is that fix.
--
-- REACHABILITY — this is not theoretical, and it is the same trap 0125 fell
-- into ("it can't reach that status" is not a filter). A claim item is only
-- ever created for a released line (`v_hmo_unbilled` feeds the picklist off
-- `status = 'released'`), which looks like P0043 already covers it. It does
-- not, because a release can be UNDONE:
--
--   1. HMO visit, line released, line claimed in a batch sent to the HMO.
--   2. Staff undo the release (0110). Status goes back to ready_for_release;
--      0110 reverses the JE and voids the PF/COGS subledger rows but does NOT
--      touch hmo_claim_items — the claim is still out with the HMO.
--   3. Now nothing blocks the delete. P0043 needs a `released` row and there
--      is none; P0042 needs the visit to be anything but unpaid, and 0133
--      keeps an HMO visit unpaid forever precisely so releasing can book the
--      receivable. The visit deletes, with live claim items attached.
--
-- Measured on prod 2026-09-15 before writing this: 0 non-voided claim items
-- exist at all, so nothing is blocked retroactively and no backfill is needed.
-- The guard is preventive.
--
-- Both delete paths need it, not one. Deleting a VISIT does not cascade to its
-- `test_requests` (0125's only cascade is package header → components), so the
-- visit guard has to reach the claim items through its own join rather than
-- relying on the line guard firing.
--
-- The way out is not to force-delete: void the claim batch (which sets
-- `batch_voided`), and then the entry is deletable like any other.

-- ---------------------------------------------------------------------------
-- Visit delete guard — 0125's function, with the claim check appended
-- ---------------------------------------------------------------------------
create or replace function public.enforce_deletable_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only guard the delete transition; restore (not null → null) is always
  -- allowed — it cannot create money problems on a still-unpaid visit.
  if not (old.deleted_at is null and new.deleted_at is not null) then
    return new;
  end if;

  if new.payment_status <> 'unpaid' then
    raise exception 'visit is not unpaid (payment_status=%)', new.payment_status
      using errcode = 'P0042';
  end if;

  -- Belt-and-suspenders: payment_status is denormalized; check the rows.
  if exists (
    select 1 from public.payments
    where visit_id = new.id and voided_at is null
  ) then
    raise exception 'visit has recorded payments' using errcode = 'P0042';
  end if;

  if exists (
    select 1 from public.test_requests
    where visit_id = new.id and status = 'released'
  ) then
    raise exception 'visit has a released result' using errcode = 'P0043';
  end if;

  -- 0147: money already billed to an HMO. Reached through test_requests
  -- because a visit delete does not cascade to its lines. Deliberately NOT
  -- filtered on tr.deleted_at — a line deleted earlier whose claim is still
  -- open is exactly the receivable this guard exists to protect.
  if exists (
    select 1
      from public.hmo_claim_items ci
      join public.test_requests tr on tr.id = ci.test_request_id
     where tr.visit_id = new.id
       and not ci.batch_voided
  ) then
    raise exception 'visit has an open HMO claim — void the claim batch first'
      using errcode = 'P0050';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_deletable_visit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Line delete guard — 0125's function, with the claim check appended
-- ---------------------------------------------------------------------------
create or replace function public.enforce_deletable_test_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_status text;
begin
  if not (old.deleted_at is null and new.deleted_at is not null) then
    return new;
  end if;

  if old.status = 'released' then
    raise exception 'test has a released result' using errcode = 'P0043';
  end if;

  -- Components are deleted by the header cascade (fn_queue_delete_cascade,
  -- depth 2) — a direct component delete would silently break the package's
  -- component set while the header keeps billing the full package price.
  if old.parent_id is not null and pg_trigger_depth() <= 1 then
    raise exception 'package component — delete the whole package instead'
      using errcode = 'P0044';
  end if;

  -- 0147: this line's own money is already billed to an HMO. Placed before
  -- the payment_status check so the specific reason wins over the generic one
  -- — though for an HMO visit that check never fires anyway (0133 keeps it
  -- unpaid). This also covers the package cascade: a component carrying an
  -- open claim raises here at depth 2 and aborts the whole header delete,
  -- which is what should happen.
  if exists (
    select 1 from public.hmo_claim_items ci
     where ci.test_request_id = old.id
       and not ci.batch_voided
  ) then
    raise exception 'test has an open HMO claim — void the claim batch first'
      using errcode = 'P0050';
  end if;

  select payment_status into v_payment_status
    from public.visits where id = new.visit_id;

  if v_payment_status <> 'unpaid' then
    raise exception 'visit is not unpaid (payment_status=%)', v_payment_status
      using errcode = 'P0042';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_deletable_test_request() from public, anon, authenticated;

-- Both triggers (trg_visits_deletable_guard, trg_test_requests_deletable_guard)
-- are unchanged and still point at these functions — `create or replace` keeps
-- them bound, so they are deliberately not re-created here.

do $$
begin
  raise notice
    '0147: P0050 now blocks soft-deleting a visit or bill line that carries a non-voided hmo_claim_item.';
end $$;

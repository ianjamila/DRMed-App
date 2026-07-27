-- =============================================================================
-- 0125 — Queue entry soft-delete (partner revisions item 22, locked decision 6)
-- =============================================================================
-- Reception + admin may delete UNPAID queue entries (whole visits, standalone
-- tests, or whole packages) with a required reason, and restore them later.
-- Entries with recorded payments must go through admin payment-void first —
-- voiding recalcs payment_status back to 'unpaid' (0111), which re-opens the
-- delete path. Deleted rows stay in the table (audit trail, history report)
-- and are excluded from operational queries via deleted_at IS NULL.
--
-- The triggers below are the source of truth for the "unpaid only" rule —
-- same philosophy as enforce_payment_before_release (0001). UI checks are UX.
--
-- Financial safety: an unpaid visit can never have released tests (release is
-- payment-gated to paid/waived), so no journal entries, doctor_pf_entries,
-- cogs_send_out_entries, or hmo_claim_items exist for anything this allows
-- deleting — there is nothing in the GL to reverse. The guards enforce that
-- invariant rather than assume it.
--
-- Error codes (translated in src/lib/accounting/pg-errors.ts):
--   P0042 — entry is not unpaid (has payments / waived / already paid)
--   P0043 — entry has a released result
--   P0044 — package component deleted directly (delete the whole package)
--   P0045 — payment recorded against a deleted visit

-- ---------------------------------------------------------------------------
-- Columns (pattern: 0050 staff_profiles soft delete, plus required reason)
-- ---------------------------------------------------------------------------
alter table public.visits
  add column deleted_at    timestamptz,
  add column deleted_by    uuid references auth.users(id) on delete set null,
  add column delete_reason text,
  add constraint visits_delete_reason_check check (
    deleted_at is null
    or (delete_reason is not null and length(trim(delete_reason)) > 0)
  );

comment on column public.visits.deleted_at is
  'When the visit was soft-deleted from the queue. NULL = active. Only unpaid visits may be deleted.';

alter table public.test_requests
  add column deleted_at    timestamptz,
  add column deleted_by    uuid references auth.users(id) on delete set null,
  add column delete_reason text,
  add constraint test_requests_delete_reason_check check (
    deleted_at is null
    or (delete_reason is not null and length(trim(delete_reason)) > 0)
  );

comment on column public.test_requests.deleted_at is
  'When the line was soft-deleted from the queue. NULL = active. A test is operationally active only when BOTH its own and its parent visit''s deleted_at are NULL.';

-- History report scans deleted rows; operational queries filter IS NULL and
-- ride the existing visit_date / status indexes.
create index visits_deleted_idx
  on public.visits (deleted_at) where deleted_at is not null;
create index test_requests_deleted_idx
  on public.test_requests (deleted_at) where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- Guard: visits — only unpaid, never with a released result
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

  return new;
end;
$$;

revoke all on function public.enforce_deletable_visit() from public, anon, authenticated;

create trigger trg_visits_deletable_guard
  before update of deleted_at on public.visits
  for each row
  execute function public.enforce_deletable_visit();

-- ---------------------------------------------------------------------------
-- Guard: test_requests — only on unpaid visits, never released, components
-- only via their header's cascade (trigger depth > 1)
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

create trigger trg_test_requests_deletable_guard
  before update of deleted_at on public.test_requests
  for each row
  execute function public.enforce_deletable_test_request();

-- ---------------------------------------------------------------------------
-- Cascade + billing recalc (after the guards pass)
--
-- 1) Package cascade: deleting/restoring a header stamps/clears its
--    components with the same values (0040's cancel-cascade pattern).
--    Components carry final_price_php = 0, so the cascade never double-
--    counts in the total recalc below.
-- 2) Billing: subtract/re-add the line's snapshotted final_price_php so an
--    unpaid visit's balance reflects what is actually still ordered.
--    Delta arithmetic (not a re-sum) so legacy pre-0011 lines with NULL
--    final_price_php leave the stored total untouched rather than zeroing it.
-- ---------------------------------------------------------------------------
create or replace function public.fn_queue_delete_cascade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    if new.is_package_header then
      update public.test_requests
         set deleted_at    = new.deleted_at,
             deleted_by    = new.deleted_by,
             delete_reason = new.delete_reason
       where parent_id = new.id and deleted_at is null;
    end if;

    if coalesce(new.final_price_php, 0) <> 0 then
      update public.visits
         set total_php = greatest(0, total_php - new.final_price_php)
       where id = new.visit_id;
    end if;

  elsif old.deleted_at is not null and new.deleted_at is null then
    if new.is_package_header then
      -- Direct component deletes are impossible (P0044), so every deleted
      -- component of this header was stamped by our own cascade — restore
      -- them all.
      update public.test_requests
         set deleted_at = null, deleted_by = null, delete_reason = null
       where parent_id = new.id and deleted_at is not null;
    end if;

    if coalesce(new.final_price_php, 0) <> 0 then
      update public.visits
         set total_php = total_php + new.final_price_php
       where id = new.visit_id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.fn_queue_delete_cascade() from public, anon, authenticated;

create trigger trg_queue_delete_cascade
  after update of deleted_at on public.test_requests
  for each row
  execute function public.fn_queue_delete_cascade();

-- ---------------------------------------------------------------------------
-- No money against deleted visits
-- ---------------------------------------------------------------------------
create or replace function public.enforce_no_payment_on_deleted_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.visit_id is not null and exists (
    select 1 from public.visits
    where id = new.visit_id and deleted_at is not null
  ) then
    raise exception 'visit is deleted — restore it before recording a payment'
      using errcode = 'P0045';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_no_payment_on_deleted_visit() from public, anon, authenticated;

create trigger trg_payments_deleted_visit_guard
  before insert on public.payments
  for each row
  execute function public.enforce_no_payment_on_deleted_visit();

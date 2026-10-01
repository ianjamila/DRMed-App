-- 0200_panel_undo_all_or_nothing.sql
-- =============================================================================
-- The lab queue's 10-minute bulk Undo, for a consolidated chemistry panel, in
-- ONE statement each (P0082).
--
-- 0191 made CLAIMING and HANDING BACK a panel all-or-nothing. Undo of a bulk
-- Unclaim (put every member back under its old holder) and Undo of a bulk
-- Delete (restore every member) still wrote member by member from the app,
-- and when one member had changed in between they tried to take the others
-- back with a second write — a separate transaction that can itself fail, and
-- whose predicates cannot tell this Undo apart from a newer change. These two
-- functions do the whole panel in one UPDATE with a row-count check: when
-- fewer rows match than were asked for, they raise P0082 and the whole Undo
-- rolls back. A concurrent writer blocks on the row locks and re-evaluates
-- after the first commits, so exactly one wins.
--
-- reclaim_panel_members(ids, holders, started_at): invoker rights, called
-- from the staff JWT like 0191's pair. Each member goes back to ITS OWN
-- holder (an admin's hand-back of a split panel recorded one per member) and
-- to the exact started_at it had (null → now()). Only while every member is
-- still requested, unassigned, live, on a live visit. A non-admin may only
-- put back claims in their own name; an admin (effective role) may put back
-- anyone's, as the admin Unclaim that made them could hand back anyone's.
-- 0190's test_requests_claim_holder_guard still judges every holder (P0075
-- rolls the whole Undo back).
--
-- restore_panel_members(visit, ids, deleted_at): service_role only — the
-- queue restore already runs on the admin client (queue-restore-core.ts),
-- with the role, reason and active-patient checks in the app. Every member
-- must still be deleted at EXACTLY the deleted_at the bulk delete stamped (a
-- restore-and-re-delete by someone else since carries a different one), on
-- that visit, top-level (components ride their header's cascade, 0125), and
-- the visit itself live.
--
-- LOCK ORDER: both functions first lock their members' rows FOR NO KEY UPDATE
-- in id order (restore locks its visit first, FOR NO KEY UPDATE) — the order
-- 0198's release_visit_results / undo_visit_release take a visit's locks
-- (visit, then its test_requests ORDER BY id, FOR UPDATE, which this still
-- conflicts with) — so a panel Undo racing a release on the same visit queues
-- behind it, removing the row-order deadlock with 0198. NO KEY UPDATE keeps
-- FK child inserts (a new result link) unblocked. The UPDATE's own predicates,
-- re-evaluated after the locks, still decide all-or-nothing. Two cycles
-- remain by design, each ending ONE side as 40P01 with nothing half-done,
-- and restorePanelMembers / reclaimPanelMembers retry it once
-- (withLifecycleRetry):
--   * a queued EXCLUSIVE patient lifecycle lock (0184, patient
--     delete/restore) — the class 0184 accepts;
--   * a manual queue Restore on the same visit: its UPDATE locks the line
--     first and 0183's waived-visit guard then takes the visit FOR UPDATE,
--     the reverse of restore_panel_members' visit-then-lines (which matches
--     0198). The same reverse order already meets 0198's release; matching
--     0198 keeps the release path cycle-free. Proven (S7 / F2) by
--     scripts/panel-undo-concurrency-proof.ts.
-- =============================================================================

create or replace function public.reclaim_panel_members(
  p_test_request_ids uuid[],
  p_holders uuid[],
  p_started_at timestamptz[]
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_wanted    integer;
  v_reclaimed integer;
begin
  if v_uid is null then
    raise exception 'Sign in to undo.' using errcode = '42501';
  end if;
  if p_test_request_ids is null or p_holders is null or p_started_at is null
     or cardinality(p_test_request_ids) <> cardinality(p_holders)
     or cardinality(p_test_request_ids) <> cardinality(p_started_at) then
    raise exception 'Could not read this report — refresh the queue.' using errcode = 'P0082';
  end if;

  select count(*) into v_wanted
    from unnest(p_test_request_ids, p_holders) as x(id, holder);
  if v_wanted = 0 or v_wanted > 200
     or exists (select 1 from unnest(p_test_request_ids, p_holders) as x(id, holder)
                 where x.id is null or x.holder is null)
     or (select count(distinct x.id) from unnest(p_test_request_ids) as x(id)) <> v_wanted
     or exists (select 1 from unnest(p_started_at) as s(v) where s.v > now()) then
    raise exception 'Nothing to put back in this report.' using errcode = 'P0082';
  end if;

  if not public.has_role(array['admin'])
     and exists (select 1 from unnest(p_holders) as h(holder) where h.holder <> v_uid) then
    raise exception 'You can only put back a claim in your own name.' using errcode = 'P0082';
  end if;

  -- Lock the members in id order first, like 0198's release/undo lock a
  -- visit's test_requests (ORDER BY id): matching it removes the row-order
  -- deadlock with 0198. NO KEY UPDATE still conflicts with 0198's FOR UPDATE
  -- but does not block FK child inserts. The UPDATE's own predicates below
  -- still decide all-or-nothing.
  perform 1 from public.test_requests t
   where t.id = any (p_test_request_ids)
   order by t.id
     for no key update;

  update public.test_requests t
     set status      = 'in_progress',
         assigned_to = x.holder,
         started_at  = coalesce(x.started_at, now())
    from unnest(p_test_request_ids, p_holders, p_started_at) as x(id, holder, started_at)
   where t.id = x.id
     and t.status = 'requested'
     and t.assigned_to is null
     and t.deleted_at is null
     and exists (select 1 from public.visits v where v.id = t.visit_id and v.deleted_at is null);
  get diagnostics v_reclaimed = row_count;

  if v_reclaimed <> v_wanted then
    -- Rolls back the members the UPDATE above did put back: all or nothing.
    raise exception 'Someone claimed or changed part of this report since — nothing was put back.'
      using errcode = 'P0082';
  end if;

  return v_reclaimed;
end;
$$;

comment on function public.reclaim_panel_members(uuid[], uuid[], timestamptz[]) is
  'Undo of a bulk hand-back: all-or-nothing re-claim of a consolidated report''s members, each under its own previous holder (p_holders) at its previous started_at (p_started_at, null = now()). Non-admins may only put back their own. Raises P0082 and changes nothing otherwise. Invoker rights: RLS and test_requests_claim_holder_guard (0190) apply.';

revoke execute on function public.reclaim_panel_members(uuid[], uuid[], timestamptz[]) from public, anon;
grant  execute on function public.reclaim_panel_members(uuid[], uuid[], timestamptz[]) to authenticated, service_role;

create or replace function public.restore_panel_members(
  p_visit_id uuid,
  p_test_request_ids uuid[],
  p_deleted_at timestamptz[]
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_wanted   integer;
  v_restored integer;
begin
  if p_visit_id is null or p_test_request_ids is null or p_deleted_at is null
     or cardinality(p_test_request_ids) <> cardinality(p_deleted_at) then
    raise exception 'Could not read this report — refresh the queue.' using errcode = 'P0082';
  end if;

  select count(*) into v_wanted
    from unnest(p_test_request_ids, p_deleted_at) as x(id, deleted_at);
  if v_wanted = 0 or v_wanted > 200
     or exists (select 1 from unnest(p_test_request_ids, p_deleted_at) as x(id, deleted_at)
                 where x.id is null or x.deleted_at is null)
     or (select count(distinct x.id) from unnest(p_test_request_ids) as x(id)) <> v_wanted then
    raise exception 'Nothing to restore in this report.' using errcode = 'P0082';
  end if;

  -- Lock the visit, then the members in id order, like 0198's release/undo
  -- (visit first, then the visit's test_requests ORDER BY id; the restore
  -- cascade touches the visit too): removes the row-order deadlock with 0198.
  -- NO KEY UPDATE still conflicts with 0198's locks but does not block FK
  -- child inserts. The UPDATE's own predicates below still decide
  -- all-or-nothing.
  perform 1 from public.visits v where v.id = p_visit_id for no key update;

  -- Checked AFTER the visit lock, so the answer cannot change under us.
  if exists (select 1 from public.visits v where v.id = p_visit_id and v.deleted_at is not null) then
    raise exception 'The visit itself is deleted — restore the visit first.' using errcode = 'P0082';
  end if;

  perform 1 from public.test_requests t
   where t.id = any (p_test_request_ids)
     and t.visit_id = p_visit_id
   order by t.id
     for no key update;

  update public.test_requests t
     set deleted_at    = null,
         deleted_by    = null,
         delete_reason = null
    from unnest(p_test_request_ids, p_deleted_at) as x(id, deleted_at)
   where t.id = x.id
     and t.visit_id = p_visit_id
     and t.deleted_at = x.deleted_at
     and t.parent_id is null;
  get diagnostics v_restored = row_count;

  if v_restored <> v_wanted then
    -- Rolls back the members the UPDATE above did restore: all or nothing.
    raise exception 'Part of this report was already restored or changed — nothing was restored.'
      using errcode = 'P0082';
  end if;

  return v_restored;
end;
$$;

comment on function public.restore_panel_members(uuid, uuid[], timestamptz[]) is
  'Undo of a bulk queue delete: all-or-nothing restore of a consolidated report''s top-level members on one live visit, each still deleted at exactly p_deleted_at. Raises P0082 and restores nothing otherwise. service_role only (the app checks role, reason and active patient first).';

revoke execute on function public.restore_panel_members(uuid, uuid[], timestamptz[]) from public, anon, authenticated;
grant  execute on function public.restore_panel_members(uuid, uuid[], timestamptz[]) to service_role;

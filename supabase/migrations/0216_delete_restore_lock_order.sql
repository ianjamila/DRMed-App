-- 0216_delete_restore_lock_order.sql
-- =============================================================================
-- Test-line delete and restore move into SECURITY DEFINER functions that take
-- the global lock order: patient lifecycle lock (shared) -> visit row FOR UPDATE
-- -> every line they will touch FOR UPDATE ORDER BY id -> the write.
--
-- THE BUGS (reproduced by scripts/plan-order-lockers-proof.ts, scenarios Q1,
-- Q2, Q3, Q5, Q6, Q8; PR 3a = 0215 fixed recompute):
--
--  The app soft-deleted lines with ONE bare UPDATE
--  (bulk-delete-core.ts deleteTestRequestsForVisit) and restored them with
--  another (queue-restore-core.ts). A package header's UPDATE fires
--  fn_queue_delete_cascade, which then UPDATEs the components in PLAN (heap)
--  order and finally the VISIT (total_php); a restore fires the 0183 waived
--  guard, which takes the visit FOR UPDATE after the line. Everyone else locks
--  visit first, lines in id order:
--    release / undo (0198)      visit FOR SHARE  -> lines ORDER BY id
--    claim / unclaim (0211)     lines ORDER BY id (no visit lock)
--    recompute (0215)           visits FOR UPDATE -> lines ORDER BY id
--  so a delete / restore closed a cycle with each of them:
--   * header delete vs claim / unclaim of its components: the cascade locks the
--     components in heap order (x2 before x1) and queues on x1 behind a claim
--     that then wants x2 (Q1, Q2);
--   * bulk delete of plain lines vs claim, same shape (Q5);
--   * header delete vs release of a component: release holds x1 and wants the
--     header, the delete holds the header (the UPDATE target) and wants x1 -
--     the cycle once filed as "accepted" (Q3). An id-ordered pre-lock inside the
--     trigger cannot help, because the header is locked BEFORE the trigger runs
--     (the what-if Q3b in an earlier run of the proof showed it);
--   * delete of a line vs undo of a sibling on the same report: the delete
--     holds its line and wants the visit (total_php), undo holds the visit
--     share and wants the line (Q8);
--   * restore vs release: the restore holds the line and wants the visit
--     FOR UPDATE through the waived guard (Q6).
--
-- THE FIX: the writes cannot be reordered from a trigger, so they happen in a
-- function that takes the locks itself, first:
--   delete_test_request_lines(visit, ids, actor, reason, deleted_at) -> uuid[]
--     0. lifecycle_lock_and_assert(the visit's patient, shared) - P0058 when the
--        patient is deleted / merged, as the guard raised before; the visit is
--        re-read under it and a moved visit raises P0072 (retry);
--     1. visits WHERE id = visit FOR UPDATE   (the mode the cascade's visit
--        UPDATE and the 0183 guard take, so no lock upgrade later);
--     2. the lock set = the requested lines + the live components of any
--        package header among them, ORDER BY id FOR UPDATE;
--     3. the SAME UPDATE the app issued (deleted_at / deleted_by / delete_reason
--        WHERE id = any(ids) AND visit_id AND deleted_at IS NULL), returning the
--        deleted ids. The 0125 guards still raise P0042 / P0043 / P0044 / P0050 /
--        P0067 for the whole statement, so it stays atomic, exactly as before;
--        the cascade trigger now finds its components already locked.
--   restore_test_request_lines(visit, ids, deleted_at default null) -> uuid[]
--     the same three locks (the lock set includes a header's deleted components),
--     then the app's UPDATE: with p_deleted_at the EXACT-instant predicate a
--     bulk Undo uses (deleted_at = p_deleted_at), without it the manual
--     Restore's "deleted_at IS NOT NULL".
-- The visit FOR UPDATE is compatible with nothing the others hold in the
-- opposite order: release/undo share the visit and so wait for us (or we wait
-- for them) BEFORE either of us holds a line; claim/unclaim never touch the
-- visit and take lines ascending like us.
--
-- restore_panel_members (0200) is NOT changed: it already takes the visit
-- (FOR NO KEY UPDATE, which conflicts with release/undo's FOR SHARE) before its
-- id-ordered line pre-lock; scenario Q7 proves it against release.
--
-- Both functions are SECURITY DEFINER, service_role only (the app calls them
-- through the admin client after its own role / reason / active-patient checks;
-- the tables' RLS never applied to that client), with search_path pinned as in
-- 0184. No new error code: refusals are the existing guards' P-codes.
--
-- DEPLOY: additive. The old app path (bare UPDATEs) keeps working until the app
-- change deploys; push this migration before merging.
-- Proof: npm run plan-order-lockers:proof -- --control
-- =============================================================================

create or replace function public.delete_test_request_lines(
  p_visit_id         uuid,
  p_test_request_ids uuid[],
  p_actor            uuid,
  p_reason           text,
  p_deleted_at       timestamptz
)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ids     uuid[];
  v_patient uuid;
  v_now     uuid;
begin
  if p_visit_id is null or p_test_request_ids is null
     or cardinality(p_test_request_ids) = 0 or p_deleted_at is null then
    return '{}'::uuid[];
  end if;

  -- 0. the patient lifecycle lock (shared, 0184) BEFORE any row lock: the order release /
  --    undo / recompute use, and the one merge / undo-merge (0196) need - they take it
  --    EXCLUSIVE and then UPDATE visits, so a delete holding the visit that only later asked
  --    for it (a_lifecycle_guard on the UPDATE) would close a cycle with a merge. P0058 when
  --    the patient is deleted or merged (what the guard raised before).
  select v.patient_id into v_patient from public.visits v where v.id = p_visit_id;
  if not found then
    return '{}'::uuid[];
  end if;
  perform public.lifecycle_lock_and_assert(array[v_patient], false);

  -- 1. the visit, FOR UPDATE (what the cascade's visit UPDATE needs anyway), re-read under the patient lock: a merge that moved it
  --    meanwhile means we hold the wrong patient's lock (P0072: callers retry once).
  select v.patient_id into v_now from public.visits v where v.id = p_visit_id for update;
  if v_now is distinct from v_patient then
    raise exception 'the patient on this visit changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  -- 2. every line this delete can touch, ascending: the requested lines and the
  --    live components of a package header among them.
  perform 1 from public.test_requests t
   where t.visit_id = p_visit_id
     and t.deleted_at is null
     and (t.id = any (p_test_request_ids) or t.parent_id = any (p_test_request_ids))
   order by t.id
     for update;

  -- 3. the app's UPDATE, unchanged.
  with d as (
    update public.test_requests
       set deleted_at    = p_deleted_at,
           deleted_by    = p_actor,
           delete_reason = p_reason
     where id = any (p_test_request_ids)
       and visit_id = p_visit_id
       and deleted_at is null
    returning id
  )
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_ids from d;

  return v_ids;
end;
$$;

comment on function public.delete_test_request_lines(uuid, uuid[], uuid, text, timestamptz) is
  'Soft delete of test_requests on one visit in the global lock order (patient lifecycle lock shared, visit FOR UPDATE, then the lines and a package header''s live components ORDER BY id FOR UPDATE), then the same UPDATE the app used to issue. The 0125 guards still raise P0042-P0044/P0050/P0067 for the whole statement. service_role only (the app checks role, reason and active patient first). Proof: scripts/plan-order-lockers-proof.ts.';

revoke all on function public.delete_test_request_lines(uuid, uuid[], uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.delete_test_request_lines(uuid, uuid[], uuid, text, timestamptz) to service_role;

create or replace function public.restore_test_request_lines(
  p_visit_id         uuid,
  p_test_request_ids uuid[],
  p_deleted_at       timestamptz default null
)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ids     uuid[];
  v_patient uuid;
  v_now     uuid;
begin
  if p_visit_id is null or p_test_request_ids is null
     or cardinality(p_test_request_ids) = 0 then
    return '{}'::uuid[];
  end if;

  -- 0. the patient lifecycle lock (shared, 0184) BEFORE any row lock: the order release /
  --    undo / recompute use, and the one merge / undo-merge (0196) need - they take it
  --    EXCLUSIVE and then UPDATE visits, so a delete holding the visit that only later asked
  --    for it (a_lifecycle_guard on the UPDATE) would close a cycle with a merge. P0058 when
  --    the patient is deleted or merged (what the guard raised before).
  select v.patient_id into v_patient from public.visits v where v.id = p_visit_id;
  if not found then
    return '{}'::uuid[];
  end if;
  perform public.lifecycle_lock_and_assert(array[v_patient], false);

  -- 1. the visit, FOR UPDATE, re-read under the patient lock: a merge that moved it
  --    meanwhile means we hold the wrong patient's lock (P0072: callers retry once).
  select v.patient_id into v_now from public.visits v where v.id = p_visit_id for update;
  if v_now is distinct from v_patient then
    raise exception 'the patient on this visit changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  -- deleted rows are the point here: the lock set is the requested lines and
  -- any header's components, whatever their deleted state.
  perform 1 from public.test_requests t
   where t.visit_id = p_visit_id
     and (t.id = any (p_test_request_ids) or t.parent_id = any (p_test_request_ids))
   order by t.id
     for update;

  with r as (
    update public.test_requests
       set deleted_at = null, deleted_by = null, delete_reason = null
     where id = any (p_test_request_ids)
       and visit_id = p_visit_id
       and ((p_deleted_at is null and deleted_at is not null) or deleted_at = p_deleted_at)
    returning id
  )
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_ids from r;

  return v_ids;
end;
$$;

comment on function public.restore_test_request_lines(uuid, uuid[], timestamptz) is
  'Restore of soft-deleted test_requests on one visit in the global lock order (patient lifecycle lock shared, visit FOR UPDATE, then the lines and a package header''s components ORDER BY id FOR UPDATE), then the same UPDATE the app used to issue: with p_deleted_at only rows deleted at exactly that instant (a bulk Undo), without it any deleted row (manual Restore). service_role only. Proof: scripts/plan-order-lockers-proof.ts.';

revoke all on function public.restore_test_request_lines(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.restore_test_request_lines(uuid, uuid[], timestamptz) to service_role;

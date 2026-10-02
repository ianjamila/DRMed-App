-- 0221_delete_restore_visit_deleted_recheck.sql
-- =============================================================================
-- delete_test_request_lines / restore_test_request_lines (0216) re-check the
-- visit's deleted_at UNDER the visit lock they take, and refuse (P0083) when the
-- visit is deleted. Nothing else changes: the bodies below are 0216's verbatim
-- plus the two marked additions.
--
-- THE BUG (reproduced by scripts/plan-order-lockers-proof.ts, scenarios Q12 and
-- Q13): the app checks the visit's deleted_at BEFORE it calls the RPC and without
-- a lock (bulk-delete-core.ts deleteTestRequestsForVisit - "Visit is already
-- deleted."; queue-restore-core.ts restoreTestRequestsForVisit - "The visit
-- itself is deleted - restore the visit first."). A visit soft-deleted between
-- that read and the RPC (deleteVisitAction: a bare UPDATE of the visit row, which
-- does not touch its lines) is invisible to the RPC, which never looked at
-- deleted_at: it queues on the visit's FOR UPDATE behind the visit delete, then
-- carries on against the now-deleted visit -
--   * restore_test_request_lines puts LIVE lines back under a deleted visit (Q12:
--     2 of 2 lines restored, the deleted visit's total_php 0 -> 200);
--   * delete_test_request_lines deletes lines of a deleted visit, and the 0125
--     cascade rewrites that visit's total_php (Q13: 200 -> 0).
-- Live lines under a deleted visit show up on no surface that filters the visit
-- and on every one that does not; the visit's total no longer matches its lines
-- when it is restored. restore_panel_members (0216, below in that file) already
-- did this right: it reads v.deleted_at in the same FOR UPDATE select and raises
-- after the lock, "so the answer cannot change under us". Same pattern here.
--
-- THE FIX: in both functions the visit's FOR UPDATE select also reads
-- v.deleted_at into a new v_deleted, and right after the P0072 re-check
--   if v_deleted is not null then raise exception ... using errcode = 'P0083';
-- Nothing has been written at that point, so the refusal changes nothing. The
-- messages are the app's pre-check messages word for word ("Visit is already
-- deleted." for the delete, "The visit itself is deleted - restore the visit
-- first." for the restore). The two cores also map P0083 to those messages
-- explicitly (they do not depend on the wording). The check also holds when the
-- visit is deleted BEFORE the call and the app's pre-check is skipped: the RPC
-- is now self-sufficient.
--
-- P0083 (new, claimed with npm run claim -- pcode): "the visit the lines belong to
-- is deleted". Not P0082 (restore_panel_members): that code means "a panel Undo
-- put nothing back" and the translator's wording is about reports; not P0045 /
-- P0046: those are the payment guards' words ("before recording a payment").
-- It is NOT retried by withLifecycleRetry (a retry would read the same answer).
--
-- DELIBERATELY NOT CHANGED (the PR 3b review's other leftover): the delete takes
-- the visit FOR UPDATE although a delete needs only FOR NO KEY UPDATE (the
-- cascade's total_php UPDATE). The only gain would be that FK KEY SHARE inserts
-- referencing the visit (a payment's FK check) would not wait a few ms behind a
-- delete, and it would perturb the proven order: both functions share one lock
-- mode on the visit on purpose (Q-scenarios, M8, M10).
--
-- Proof: scripts/plan-order-lockers-proof.ts Q12 + Q13 (fail on mutant M12 =
-- these bodies without the refusal; B0 passes them). The other scenarios
-- (Q1-Q11, R1-R8, P1-P3) are unchanged. restore_panel_members is untouched.
--
-- DEPLOY: additive; the old app path (no P0083 mapping) just shows the translated
-- text. Push this migration before merging the app change.
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
  v_deleted timestamptz;
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
  select v.patient_id, v.deleted_at into v_now, v_deleted
    from public.visits v where v.id = p_visit_id for update;
  if v_now is distinct from v_patient then
    raise exception 'the patient on this visit changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  -- Checked AFTER the visit lock, so the answer cannot change under us: the app's own check of the
  -- visit's deleted_at is made before this call, without a lock, and a visit soft-deleted since then
  -- is only visible here (what restore_panel_members below has always done).
  if v_deleted is not null then
    raise exception 'Visit is already deleted.' using errcode = 'P0083';
  end if;

  -- 2. every line this delete can touch, ascending: the requested lines and the
  --    live components of a package header among them.
  perform 1 from public.test_requests t
   where t.visit_id = p_visit_id
     and t.deleted_at is null
     and (t.id = any (p_test_request_ids) or t.parent_id = any (p_test_request_ids))
   order by t.id
     for no key update;

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
  'Soft delete of test_requests on one LIVE visit (P0083 when the visit is deleted - re-checked under the visit lock) in the global lock order (patient lifecycle lock shared, visit FOR UPDATE, then the lines and a package header''s live components ORDER BY id FOR NO KEY UPDATE), then the same UPDATE the app used to issue. The 0125 guards still raise P0042-P0044/P0050/P0067 for the whole statement. service_role only (the app checks role, reason and active patient first). Proof: scripts/plan-order-lockers-proof.ts.';

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
  v_deleted timestamptz;
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
  select v.patient_id, v.deleted_at into v_now, v_deleted
    from public.visits v where v.id = p_visit_id for update;
  if v_now is distinct from v_patient then
    raise exception 'the patient on this visit changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  -- Checked AFTER the visit lock, so the answer cannot change under us: the app's own check of the
  -- visit's deleted_at is made before this call, without a lock, and a visit soft-deleted since then
  -- is only visible here (what restore_panel_members below has always done).
  if v_deleted is not null then
    raise exception 'The visit itself is deleted — restore the visit first.' using errcode = 'P0083';
  end if;

  -- deleted rows are the point here: the lock set is the requested lines and
  -- any header's components, whatever their deleted state.
  perform 1 from public.test_requests t
   where t.visit_id = p_visit_id
     and (t.id = any (p_test_request_ids) or t.parent_id = any (p_test_request_ids))
   order by t.id
     for no key update;

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
  'Restore of soft-deleted test_requests on one LIVE visit (P0083 when the visit is deleted - re-checked under the visit lock) in the global lock order (patient lifecycle lock shared, visit FOR UPDATE, then the lines and a package header''s components ORDER BY id FOR NO KEY UPDATE), then the same UPDATE the app used to issue: with p_deleted_at only rows deleted at exactly that instant (a bulk Undo), without it any deleted row (manual Restore). service_role only. Proof: scripts/plan-order-lockers-proof.ts.';

revoke all on function public.restore_test_request_lines(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.restore_test_request_lines(uuid, uuid[], timestamptz) to service_role;

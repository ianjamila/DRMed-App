-- 0211_claim_unclaim_lock_order.sql
-- =============================================================================
-- claim_panel_members / unclaim_panel_members take their rows in id order.
--
-- THE BUG (reproduced by scripts/report-release-concurrency-proof.ts, scenarios
-- L2x / L3x): both functions are ONE multi-row UPDATE with no ORDER BY, so they
-- lock each matching row (FOR NO KEY UPDATE) in PLAN order - physical heap order
-- for a seq / bitmap heap scan or an index scan on idx_test_requests_assigned_to
-- / _status, id order only for a pkey index scan. release_visit_results and
-- undo_visit_release (0198/0205) lock every line they touch ORDER BY id. Two
-- lines L < H stored H-then-L: the release holds L and wants H while the claim
-- holds H and wants L: 40P01 (one side is rolled back; the app retries once
-- via withLifecycleRetry, so it was a nuisance, never a split).
--
-- THE FIX: immediately before each UPDATE, lock the rows that UPDATE will touch
-- in id order (same predicate, ORDER BY id, FOR NO KEY UPDATE). Every writer of
-- these lines then takes them ascending (release/undo: FOR UPDATE ORDER BY id;
-- claim/unclaim: FOR NO KEY UPDATE ORDER BY id), and resources taken in one
-- global order cannot form a cycle.
--
-- WHY THE PRE-LOCK CARRIES THE UPDATE'S OWN ROW FILTER
--  * The functions are SECURITY INVOKER (unchanged, as 0191, not definer), so the
--    pre-lock runs under the caller's RLS exactly like the UPDATE: a row the
--    caller may not update is not returned, hence not locked.
--  * With the same predicate (status / holder / not deleted) it locks EXACTLY
--    the rows the UPDATE would lock, only in a fixed order. Ready, released and
--    deleted lines in the id list are NOT locked, so claim/unclaim never wait on
--    a line they would have ignored: a claim that finds the panel held still
--    answers P0077 at once (scenarios B1/B2 of panel-claim-concurrency-proof),
--    and no new wait edge is created against release/undo, which lock those
--    lines.
--  * Lock order against release/undo: they take membership (shared) -> patient
--    (shared) -> visit row (FOR SHARE) -> lines ascending. Claim/unclaim take NO
--    visit and NO membership lock - only the patient lock SHARED, in the
--    a_lifecycle_guard trigger, after their lines (as always) - and shared never
--    conflicts with shared. So the only contended resources are lines, now
--    taken ascending by everyone: no cycle.
--  * FOR NO KEY UPDATE is what the UPDATE itself takes (no key column changes),
--    so the pre-lock blocks and is blocked by exactly the same transactions and
--    the UPDATE needs no upgrade. Under READ COMMITTED the UPDATE re-reads the
--    committed rows afterwards (fresh statement snapshot), so the P0077
--    all-or-nothing counts behave as before.
--  * Residual window, accepted: a row that BECOMES matching between the pre-lock
--    and the UPDATE (someone commits an unclaim of it) is locked by the UPDATE
--    out of order. That needs a state flip landing inside one function call and
--    the callers retry once on 40P01.
--
-- PATIENT LIFECYCLE LOCK. Unchanged: the per-row trigger (0184) takes the patient
-- lock SHARED after the row locks, the order an ordinary UPDATE always has. An
-- EXCLUSIVE holder could wait on a line this call holds while the call waits for
-- the lock: delete_patient / restore_patient take only the patients row, never a
-- child line, so they cannot; merge_patients_guarded / undo_patient_merge_guarded
-- (0196) hold it exclusive and then move rows, so that cycle exists, but it
-- existed before this migration for every matching line (0184 documents it:
-- callers retry once on 40P01/P0072). The pre-lock holds the same set of lines
-- the UPDATE did, so it is not widened and not a new cycle.
--
-- Same bodies, comments and ACLs as 0191 (invoker rights, search_path = public;
-- EXECUTE for authenticated and service_role only; anon and PUBLIC revoked by
-- name), plus the pre-lock. P0077 behaviour is unchanged.
-- =============================================================================

create or replace function public.claim_panel_members(p_test_request_ids uuid[])
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_wanted  integer;
  v_claimed integer;
begin
  if v_uid is null then
    raise exception 'Sign in to claim tests.' using errcode = '42501';
  end if;

  select count(distinct t.id) into v_wanted
    from unnest(coalesce(p_test_request_ids, '{}'::uuid[])) as t(id)
   where t.id is not null;
  if v_wanted = 0 or v_wanted > 200 then
    raise exception 'Nothing to claim in this report.' using errcode = 'P0077';
  end if;

  -- Lock the rows this UPDATE will touch in id order first (0211): the order
  -- release/undo use.
  perform 1 from public.test_requests t0
   where t0.id = any (p_test_request_ids)
     and t0.status      = 'requested'
     and t0.assigned_to is null
     and t0.deleted_at  is null
   order by t0.id
     for no key update;

  update public.test_requests
     set status      = 'in_progress',
         assigned_to = v_uid,
         started_at  = now()
   where id = any (p_test_request_ids)
     and status = 'requested'
     and assigned_to is null
     and deleted_at is null;
  get diagnostics v_claimed = row_count;

  if v_claimed <> v_wanted then
    -- Rolls back the rows the UPDATE above did claim: all or nothing.
    raise exception 'Some tests in this report were already claimed or changed status.'
      using errcode = 'P0077';
  end if;

  return v_claimed;
end;
$$;

comment on function public.claim_panel_members(uuid[]) is
  'All-or-nothing claim of a consolidated report''s members into the caller''s name (auth.uid()). Raises P0077 and claims nothing when any member is no longer requested/unassigned/live. Invoker rights: RLS and test_requests_claim_holder_guard (0190) apply.';

revoke execute on function public.claim_panel_members(uuid[]) from public, anon;
grant  execute on function public.claim_panel_members(uuid[]) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The same all-or-nothing rule for handing a panel BACK (P0077).
--
-- performUnclaim / the queue list's bulk Unclaim hand a panel back with a
-- filtered multi-row UPDATE too, so a member that changed in between (a result
-- uploaded, someone else's unclaim) left the panel half returned.
-- unclaim_panel_members() takes each member's EXPECTED holder — what the
-- operator saw, member by member — and only lands when every member is still
-- in progress under exactly that holder; otherwise it raises P0077 and changes
-- nothing. Per-member holders keep an admin able to recover a panel whose
-- members ended up held by different people (the old admin Unclaim could).
-- A non-admin may only hand back members they hold themselves; an admin
-- (effective role, so not while viewing the app as another role) may hand
-- back anyone's, as the row's Unclaim already allows.
-- -----------------------------------------------------------------------------

create or replace function public.unclaim_panel_members(
  p_test_request_ids uuid[],
  p_holders uuid[]
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_wanted    integer;
  v_unclaimed integer;
begin
  if v_uid is null then
    raise exception 'Sign in to unclaim tests.' using errcode = '42501';
  end if;
  if p_test_request_ids is null or p_holders is null
     or cardinality(p_test_request_ids) <> cardinality(p_holders) then
    raise exception 'Could not read this report — refresh the queue.' using errcode = 'P0077';
  end if;

  -- One expected holder per member: no nulls, no repeated member.
  select count(*) into v_wanted
    from unnest(p_test_request_ids, p_holders) as x(id, holder);
  if v_wanted = 0 or v_wanted > 200
     or exists (select 1 from unnest(p_test_request_ids, p_holders) as x(id, holder)
                 where x.id is null or x.holder is null)
     or (select count(distinct x.id) from unnest(p_test_request_ids) as x(id)) <> v_wanted then
    raise exception 'Nothing to unclaim in this report.' using errcode = 'P0077';
  end if;

  if not public.has_role(array['admin'])
     and exists (select 1 from unnest(p_holders) as h(holder) where h.holder <> v_uid) then
    raise exception 'You can only unclaim a report you currently hold.'
      using errcode = 'P0077';
  end if;

  -- Lock the rows this UPDATE will touch in id order first (0211): the order
  -- release/undo use.
  perform 1 from public.test_requests t0
    join unnest(p_test_request_ids, p_holders) as x(id, holder) on x.id = t0.id
   where t0.status      = 'in_progress'
     and t0.assigned_to = x.holder
     and t0.deleted_at  is null
   order by t0.id
     for no key update of t0;

  update public.test_requests t
     set status      = 'requested',
         assigned_to = null,
         started_at  = null
    from unnest(p_test_request_ids, p_holders) as x(id, holder)
   where t.id = x.id
     and t.status = 'in_progress'
     and t.assigned_to = x.holder
     and t.deleted_at is null;
  get diagnostics v_unclaimed = row_count;

  if v_unclaimed <> v_wanted then
    -- Rolls back the rows the UPDATE above did hand back: all or nothing.
    raise exception 'Some tests in this report changed while unclaiming — refresh and check the queue.'
      using errcode = 'P0077';
  end if;

  return v_unclaimed;
end;
$$;

comment on function public.unclaim_panel_members(uuid[], uuid[]) is
  'All-or-nothing hand-back of a consolidated report''s members, each still held by its expected holder (p_holders, parallel to p_test_request_ids). Non-admins may only hand back their own. Raises P0077 and changes nothing otherwise. Invoker rights: RLS applies.';

revoke execute on function public.unclaim_panel_members(uuid[], uuid[]) from public, anon;
grant  execute on function public.unclaim_panel_members(uuid[], uuid[]) to authenticated, service_role;

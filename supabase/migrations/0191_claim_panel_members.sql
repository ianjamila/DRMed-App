-- 0191_claim_panel_members.sql
-- =============================================================================
-- Claim a consolidated chemistry panel in ONE statement (P0077).
--
-- A consolidated report (e.g. "Chemistry (10 tests)") is one claim spread over
-- several test_requests. The app claimed it with a PostgREST UPDATE filtered on
-- status = 'requested', then compared the affected-row count with the member
-- count. If another request claimed one member between the app's pre-read and
-- that UPDATE, the UPDATE still committed for the rest: the panel ended up
-- split between two holders while the caller was told "refused". A second,
-- compensating UPDATE cannot fix that safely — it is a separate transaction
-- that can fail, and its predicates cannot tell this attempt apart from a
-- newer claim by the same person.
--
-- claim_panel_members() runs the UPDATE and the count check in one
-- transaction: when fewer rows match than were asked for, it raises P0077 and
-- the whole claim rolls back. A concurrent claimer blocks on the row locks and
-- re-evaluates the predicate after the first commits, so exactly one wins and
-- the other claims nothing.
--
-- Invoker rights: RLS on test_requests applies as for the app's own UPDATE (a
-- row the caller may not update simply does not match, so the claim is
-- refused), and 0190's test_requests_claim_holder_guard still judges the new
-- holder per row (P0075 rolls the whole claim back too). The holder is always
-- the caller — auth.uid() — never a parameter, so nobody can claim a panel
-- into someone else's name. The app keeps its friendly pre-checks (deleted
-- lines/visits, payment gate, sections); this function is what makes the
-- all-or-nothing rule hold.
--
-- Called from the staff JWT (the RLS-scoped server client), so EXECUTE goes to
-- authenticated; anon and PUBLIC are revoked by name (0118/0119).
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
-- unclaim_panel_members() only lands when EVERY member is still in progress
-- under p_holder — the holder the operator saw — and otherwise raises P0077
-- and changes nothing. A non-admin may only hand back their own claim; an
-- admin (effective role, so not while viewing the app as another role) may
-- hand back anyone's, as the row's Unclaim already allows.
-- -----------------------------------------------------------------------------

create or replace function public.unclaim_panel_members(
  p_test_request_ids uuid[],
  p_holder uuid
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
  if p_holder is null then
    raise exception 'Nobody holds this report.' using errcode = 'P0077';
  end if;
  if p_holder <> v_uid and not public.has_role(array['admin']) then
    raise exception 'You can only unclaim a report you currently hold.'
      using errcode = 'P0077';
  end if;

  select count(distinct t.id) into v_wanted
    from unnest(coalesce(p_test_request_ids, '{}'::uuid[])) as t(id)
   where t.id is not null;
  if v_wanted = 0 or v_wanted > 200 then
    raise exception 'Nothing to unclaim in this report.' using errcode = 'P0077';
  end if;

  update public.test_requests
     set status      = 'requested',
         assigned_to = null,
         started_at  = null
   where id = any (p_test_request_ids)
     and status = 'in_progress'
     and assigned_to = p_holder
     and deleted_at is null;
  get diagnostics v_unclaimed = row_count;

  if v_unclaimed <> v_wanted then
    -- Rolls back the rows the UPDATE above did hand back: all or nothing.
    raise exception 'Some tests in this report changed while unclaiming — refresh and check the queue.'
      using errcode = 'P0077';
  end if;

  return v_unclaimed;
end;
$$;

comment on function public.unclaim_panel_members(uuid[], uuid) is
  'All-or-nothing hand-back of a consolidated report''s members held by p_holder. Non-admins may only pass themselves. Raises P0077 and changes nothing when any member is no longer in progress under p_holder. Invoker rights: RLS applies.';

revoke execute on function public.unclaim_panel_members(uuid[], uuid) from public, anon;
grant  execute on function public.unclaim_panel_members(uuid[], uuid) to authenticated, service_role;

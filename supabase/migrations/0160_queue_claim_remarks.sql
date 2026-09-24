-- =============================================================================
-- 0160_queue_claim_remarks.sql
-- =============================================================================
-- The lab queue's Remarks column: who claimed a test, who unclaimed it (and
-- why), who reassigned it. That history lives only in audit_log, whose single
-- SELECT policy is admin-only (a lab worker must not read the whole log) — but
-- the people who need to see "Melvin claimed this, then handed it back: wrong
-- patient" are the technicians picking the next test.
--
-- So: one narrow SECURITY DEFINER reader. It returns ONLY the three claim
-- actions, ONLY for the test ids asked for (max 200 — one queue page), and
-- ONLY to a lab role. It returns staff names instead of ids and the free-text
-- reason; no ip, no user agent, no other metadata.
--
-- Two audit shapes are read:
--   * single tests  — resource_id = the test (claimTestAction, the unclaims,
--                     reassignTestAction)
--   * chemistry groups — resource_id NULL, metadata.test_request_ids = [...]
--                     (claimConsolidated; `test_request.claim` is its early
--                     spelling, 3 rows on prod)
--
-- Read-only; raises nothing, so no P-code.
-- =============================================================================

-- The group shape cannot use an index (it is a jsonb array), but both shapes
-- are pinned to a handful of actions, so a partial index on the per-test shape
-- keeps the common read off a full scan as the log grows.
create index if not exists idx_audit_log_test_request_claims
  on public.audit_log (resource_id)
  where resource_type = 'test_request'
    and action in ('test_request.claimed', 'test_request.unclaimed', 'test_request.reassigned');

create or replace function public.queue_claim_remarks(p_test_request_ids uuid[])
returns table (
  test_request_id uuid,
  action text,
  created_at timestamptz,
  actor_name text,
  previous_holder_name text,
  new_holder_name text,
  reason text
)
language sql
stable
security definer
set search_path = public
as $$
  with ids as (
    select distinct u.id
      from unnest(p_test_request_ids[1:200]) as u(id)
     -- The gate: reception and anyone else get an empty set, not an error.
     where (select public.has_role(array['medtech', 'xray_technician', 'pathologist', 'admin']))
  ),
  events as (
    select a.resource_id as test_request_id, a.action, a.created_at, a.actor_id, a.metadata
      from public.audit_log a
      join ids on ids.id = a.resource_id
     where a.resource_type = 'test_request'
       and a.action in ('test_request.claimed', 'test_request.unclaimed', 'test_request.reassigned')
    union all
    select ids.id, 'test_request.claimed', a.created_at, a.actor_id, a.metadata
      from public.audit_log a
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(a.metadata -> 'test_request_ids') = 'array'
             then a.metadata -> 'test_request_ids' else '[]'::jsonb end
      ) as g(id)
      join ids on ids.id::text = g.id
     where a.resource_id is null
       and a.action in ('test_request.claimed', 'test_request.claim')
  )
  select e.test_request_id,
         e.action,
         e.created_at,
         actor.full_name,
         prev.full_name,
         nxt.full_name,
         nullif(btrim(e.metadata ->> 'reason'), '')
    from events e
    left join public.staff_profiles actor on actor.id = e.actor_id
    -- unclaim writes previous_assignee; reassign writes from/to.
    left join public.staff_profiles prev
      on prev.id::text = coalesce(e.metadata ->> 'previous_assignee', e.metadata ->> 'from')
    left join public.staff_profiles nxt
      on e.action = 'test_request.reassigned' and nxt.id::text = e.metadata ->> 'to'
   order by e.test_request_id, e.created_at;
$$;

-- 0119: public functions are service_role-only by default. The queue page
-- calls this under the signed-in staff JWT, so authenticated needs EXECUTE;
-- anon never does. Revoke by name first — on hosted Supabase `from public`
-- alone leaves the direct anon grant.
revoke all on function public.queue_claim_remarks(uuid[]) from public;
revoke execute on function public.queue_claim_remarks(uuid[]) from anon;
grant execute on function public.queue_claim_remarks(uuid[]) to authenticated, service_role;

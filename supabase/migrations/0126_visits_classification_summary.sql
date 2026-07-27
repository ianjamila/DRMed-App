-- =============================================================================
-- 0126 — Per-classification summary for the Visits archive (partner revisions
--        item 4, follow-up)
-- =============================================================================
-- The Visits page shows a revenue strip broken down by the three reception-facing
-- classes (Lab Tests / Doctor Consults / Doctor Procedures). That needs COUNT and
-- SUM across the whole filtered set — up to 14k visits — which the client cannot
-- compute: PostgREST aggregate functions are disabled on this project (PGRST123)
-- and a bare select is capped at 1000 rows, so "fetch and add up in JS" is both
-- wrong and unbounded. Hence one read-only function.
--
-- Read-only and additive: no table, column, policy, trigger or grant on existing
-- objects changes. Nothing here can affect payment gating or release.
--
-- WHY security invoker
-- --------------------
-- The page calls this from a Server Component on the cookie-scoped client, i.e.
-- as `authenticated`. SECURITY INVOKER keeps RLS in force for the caller, so the
-- function can never widen what a signed-in staff member could already read by
-- querying the same tables directly. Do NOT convert this to SECURITY DEFINER —
-- it would hand every authenticated session an unfiltered read of the whole
-- visit ledger (see 0118 for what that costs to clean up).
--
-- WHY parent_id is null
-- ---------------------
-- Package decomposition (0040) writes a priced HEADER row plus zero-priced
-- COMPONENT rows. Summing every line would be correct today only by accident —
-- components happen to carry 0.00. Restricting to top-level lines is the billed
-- set by construction, so the figure stays right if a component is ever priced.
-- The same rule drives the "Tests" column on the page.
--
-- WHY the classes are derived here and not read from a lookup
-- ----------------------------------------------------------
-- This CASE must stay in step with `classifyKind()` in
-- src/lib/visits/classification.ts: only the two doctor kinds are enumerated and
-- everything else falls through to 'lab'. Written as an allow-list instead, a
-- newly-seeded services.kind would silently vanish from the strip while the badge
-- on the row still called it Lab Tests.

create or replace function public.visits_classification_summary(
  p_start   date default null,
  p_end     date default null,
  p_deleted text default 'active'   -- 'active' | 'deleted' | 'all'
)
returns table (
  class       text,
  visits      bigint,
  lines       bigint,
  revenue_php numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    case s.kind
      when 'doctor_consultation' then 'consult'
      when 'doctor_procedure'    then 'procedure'
      else 'lab'
    end                                              as class,
    count(distinct v.id)                             as visits,
    count(*)                                         as lines,
    coalesce(
      sum(coalesce(tr.final_price_php, tr.base_price_php, s.price_php, 0)),
      0
    )::numeric(14, 2)                                as revenue_php
  from public.test_requests tr
  join public.visits   v on v.id = tr.visit_id
  join public.services s on s.id = tr.service_id
  where tr.deleted_at is null
    and tr.parent_id  is null
    and (p_start is null or v.visit_date >= p_start)
    and (p_end   is null or v.visit_date <= p_end)
    and case p_deleted
          when 'deleted' then v.deleted_at is not null
          when 'all'     then true
          else                v.deleted_at is null
        end
  group by 1;
$$;

comment on function public.visits_classification_summary(date, date, text) is
  'Visits archive revenue strip: count of visits, billed lines and revenue per '
  'reception classification (lab / consult / procedure) over a visit_date range. '
  'Read-only, SECURITY INVOKER — RLS applies to the caller.';

-- Per 0119 a new function in `public` is reachable by postgres + service_role
-- only. This one is called by a signed-in staff session, so say so explicitly.
revoke execute on function public.visits_classification_summary(date, date, text)
  from public, anon;
grant execute on function public.visits_classification_summary(date, date, text)
  to authenticated, service_role;

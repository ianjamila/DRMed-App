-- 0194_lab_search.sql — server-side free-text search for the lab queue and the
-- results archive.
--
-- Both worklists page `test_requests` rows with count: "exact" + .range(), but
-- their "Patient / test search" box filtered the page AFTER the fetch, so a
-- match on another page never showed (CLAUDE.md: a filter applied after the
-- fetch breaks server-side paging). This gives PostgREST something to filter
-- ON: each test row's searchable text, reached from `test_requests` as the
-- computed relationship `lab_search`. The pages add `lab_search!inner ( )`
-- and one `lab_search.search_text=ilike.%word%` per word
-- (src/lib/queue/lab-search.ts), so every existing gate stays in their query.
--
-- Why a view + a set-returning function, not a scalar computed field: a SQL
-- function with a FROM clause is never inlined as a scalar, and calling it per
-- row cost 1.2 s over prod's 25k rows; a set-returning SQL function IS inlined,
-- so the planner joins the view once — 0.2 s, measured 2026-09-30.
--
-- No P-codes; raises nothing.

create view public.lab_search_rows
with (security_invoker = on) as
select
  tr.id as test_request_id,
  concat_ws(' ',
    p.last_name, p.first_name, p.drm_id,
    v.visit_number,
    s.code, s.name,
    rg.code, rg.name,
    -- The other live members of the same chemistry panel on the same tab, so
    -- one member's code finds the whole panel card (the queue folds a panel
    -- into one card; before this, the search ran after that fold).
    case when s.report_group_id is not null then (
      select string_agg(concat_ws(' ', s2.code, s2.name), ' ')
      from public.test_requests t2
      join public.services s2 on s2.id = t2.service_id
      where t2.visit_id = tr.visit_id
        and s2.report_group_id = s.report_group_id
        and t2.id <> tr.id
        and t2.deleted_at is null
        and (case when t2.status in ('requested', 'in_progress') then 'bench' else t2.status end)
          = (case when tr.status in ('requested', 'in_progress') then 'bench' else tr.status end)
    ) end
  ) as search_text
from public.test_requests tr
join public.visits v on v.id = tr.visit_id
join public.patients p on p.id = v.patient_id
join public.services s on s.id = tr.service_id
left join public.report_groups rg on rg.id = s.report_group_id
-- Live rows only (0125/0146): deleting a visit does not cascade to its lines.
where tr.deleted_at is null
  and v.deleted_at is null;

comment on view public.lab_search_rows is
  'Searchable text per live test row (patient name, DRM-ID, visit #, test, report group, panel siblings). Read through the lab_search computed relationship by /staff/queue and /staff/results (0194).';

revoke all on public.lab_search_rows from anon, authenticated;
grant select on public.lab_search_rows to authenticated, service_role;

-- PostgREST computed relationship: test_requests -> lab_search_rows (to-one).
-- Deliberately NO `set search_path`: any SET clause stops Postgres inlining
-- the function, which is what makes the search fast. Every name is
-- schema-qualified instead, and it runs with invoker rights.
create function public.lab_search(public.test_requests)
returns setof public.lab_search_rows
rows 1
language sql
stable
as $$
  select r.* from public.lab_search_rows r where r.test_request_id = $1.id
$$;

comment on function public.lab_search(public.test_requests) is
  'Computed relationship for PostgREST: embed lab_search!inner ( ) and filter lab_search.search_text (0194).';

revoke execute on function public.lab_search(public.test_requests) from public, anon;
grant execute on function public.lab_search(public.test_requests) to authenticated, service_role;

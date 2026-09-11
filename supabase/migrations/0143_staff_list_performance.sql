-- 0143 — Staff list performance: statistics, indexes, and the patients directory view.
--
-- WHY (measured on prod 2026-09-11, not inferred):
--
--   The Visits archive was slow because `visits` was last ANALYZEd on 2026-06-05,
--   BEFORE migration 0125 added `deleted_at`. Postgres therefore had NO statistics
--   row for that column at all (`pg_stats` returned nothing for visits.deleted_at)
--   and fell back to a default selectivity guess: it estimated 71 rows where
--   14,259 are real — a 200x underestimate.
--
--   That one bad estimate picked nested loops everywhere. The classification
--   summary RPC ran 14,259 index lookups into test_requests and then 25,574
--   separate lookups into services:
--
--     before : 155 ms, 123,919 shared buffers   (nested loop)
--     after  :  81 ms,   1,307 shared buffers   (hash join, proven by forcing
--                                                enable_nestloop = off)
--
--   i.e. ~95x less I/O from statistics alone, with no code change. The exact
--   count on the same page had the same cause (28 ms / 29,472 buffers).
--
--   NOTE: because the estimate is currently 71, PostgREST `count: "planned"`
--   would report 71 visits. Do not switch the page to a planned count until
--   this migration has run.

-- 1) Refresh the statistics that never got taken. -----------------------------
analyze public.visits;
analyze public.test_requests;
analyze public.patients;

-- 2) Stop them rotting again. -------------------------------------------------
-- Default autoanalyze fires at 10% of the table changing. `visits` grows by a
-- few dozen rows a day against 14k existing, so it would take ~a month to trip
-- — which is exactly how a column added in 0125 still had no stats in September.
alter table public.visits            set (autovacuum_analyze_scale_factor = 0.02);
alter table public.test_requests     set (autovacuum_analyze_scale_factor = 0.02);
alter table public.patients          set (autovacuum_analyze_scale_factor = 0.02);

-- 3) Index the COMMON case, not the rare one. ---------------------------------
-- `visits_deleted_idx` is partial on `deleted_at IS NOT NULL` — it indexes the
-- 8 deleted visits and is useless for the 14,259-row default view. Keep it (the
-- "deleted" tab uses it) and add its mirror, with the archive's exact sort key
-- so the ORDER BY is satisfied by the index instead of an incremental sort.
create index if not exists idx_visits_active_archive
  on public.visits (visit_date desc, created_at desc, id)
  where deleted_at is null;

-- Serves both the classification RPC and the per-page billed-lines top-up,
-- which share the `deleted_at is null and parent_id is null` predicate.
create index if not exists idx_test_requests_billed_by_visit
  on public.test_requests (visit_id)
  where deleted_at is null and parent_id is null;

-- Serves "date of last visit" on the patients directory (below).
create index if not exists idx_visits_patient_last_visit
  on public.visits (patient_id, visit_date desc)
  where deleted_at is null;

-- 4) Patients directory view — "source" and "date of last visit". ------------
--
-- Both columns the Patients list needs are DERIVED, and both have to be
-- sortable across all 7,057 patients. Sorting them in JS is not an option: a
-- bare PostgREST select caps at 1000 rows, so client-side sorting would order
-- an arbitrary first page and silently present it as the whole table.
--
-- "Source" is `patients.referral_source` -> `referral_sources.label` (Walk-in,
-- Customer referral, Facebook, Google, Doctor referral...). It is NOT the
-- record's origin: 7,015 of 7,057 patients are legacy imports, so an origin
-- column would read "Imported" for 99% of the table and tell nobody anything.
--
-- SECURITY: `security_invoker = true` is load-bearing, not boilerplate.
-- `patients`, `visits` and `referral_sources` all enable RLS and all grant
-- table-level SELECT to anon and authenticated — the POLICIES are what
-- actually protect them. A view without security_invoker executes as its
-- owner, which is RLS-exempt, and would re-expose every patient row to any
-- caller that can reach the view. That is the same defect class the
-- 2026-09-10 security audit closed on the v_hmo_* views. It is also why the
-- grant below names `authenticated` only and never `anon`.
drop view if exists public.v_patients_directory;

create view public.v_patients_directory
with (security_invoker = true) as
  select
    p.id,
    p.drm_id,
    p.first_name,
    p.middle_name,
    p.last_name,
    p.phone,
    p.email,
    p.pre_registered,
    p.created_at,
    p.referral_source,
    rs.label                       as referral_source_label,
    lv.last_visit_date
  from public.patients p
  left join public.referral_sources rs
    on rs.id = p.referral_source
  left join lateral (
    select max(v.visit_date) as last_visit_date
    from public.visits v
    where v.patient_id = p.id
      and v.deleted_at is null      -- soft delete: never count a deleted visit
  ) lv on true;

comment on view public.v_patients_directory is
  'Patients list backing view: adds referral-source label and last visit date so both can be sorted and paged in the query. security_invoker — RLS on patients/visits still applies.';

-- Staff read this through the RLS-scoped server client (an `authenticated`
-- JWT). Patients never touch it: the portal reads through the patient-scoped
-- client and has no reason to see a directory of other patients.
grant select on public.v_patients_directory to authenticated;

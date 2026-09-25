-- 0181: visits.is_sample — a sample / training visit (owner request 2026-09-25).
--
-- A flag, nothing more. It does NOT change what a visit counts toward: a
-- sample visit is billed, released and booked like any other until someone
-- deletes it, and deleted visits already drop out of every report and view
-- (0125 / 0146). What the flag buys:
--   * a "Sample" badge on the visit page, both queues and Visit Records, plus
--     a Sample filter there, so these visits are easy to find and clean up;
--   * the app never contacts the patient about a sample visit (result-ready
--     email/SMS, statement email) — enforced in the senders, not here;
--   * the staff "payment removed after results went out" alert skips them.
--
-- Who may flip it (reception + admin) is an app rule with an audit row
-- (src/lib/visits/sample.ts): "visits: staff full" (0151) already lets every
-- staff role update visits, and a column this low-risk does not justify a
-- per-column guard trigger.

alter table public.visits
  add column if not exists is_sample boolean not null default false;

comment on column public.visits.is_sample is
  'Sample / training visit: badged in the staff UI, never contacts the patient. Counts like any visit until deleted.';

-- The Visit Records "Sample" filter reads a handful of rows out of thousands.
create index if not exists visits_is_sample_idx
  on public.visits (visit_date desc)
  where is_sample;

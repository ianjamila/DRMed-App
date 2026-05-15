-- =============================================================================
-- 0037_hmo_history_opening_je_uniqueness_fix.sql
-- =============================================================================
-- 12.A.5 (D5): Fix a latent bug discovered by the full smoke (smoke-12.A.sql).
--
-- The unique index `journal_entries_one_posted_per_source` (created in
-- 0030_op_gl_bridge.sql:81-85) was designed under the invariant "one
-- operational source row → exactly one posted JE". That invariant held for
-- every source_kind that existed at the time of 0030: 'test_request_released',
-- 'payment', 'hmo_claim_resolution' — each of those is a single op-table row
-- that maps to a single JE.
--
-- 12.A introduced `source_kind = 'hmo_history_opening'`, where the source row
-- is an `hmo_import_runs` row and a SINGLE run produces ONE JE PER PROVIDER
-- with non-zero opening AR (i.e. 1..N JEs share the same source_id). The D4
-- commit function (0036_hmo_history_commit_function.sql:396-414) inserts these
-- N JEs with source_id = p_run_id; when N > 1, the unique index trips on the
-- second insert with errcode 23505 (constraint violation):
--
--     duplicate key value violates unique constraint
--     "journal_entries_one_posted_per_source"
--     DETAIL:  Key (source_kind, source_id)=(hmo_history_opening, <run-uuid>)
--             already exists.
--
-- Drilling back from the post-commit page requires source_id to remain set to
-- the run UUID (page.tsx filters on `source_kind='hmo_history_opening' AND
-- source_id=runId` to enumerate opening JEs), so the fix is to exclude
-- `hmo_history_opening` from the unique-index predicate rather than to null
-- out source_id.
--
-- This migration does not touch 0036's function body — the function is correct
-- as written; only the index predicate needed to evolve as a new source_kind
-- with one-to-many semantics was introduced.
-- =============================================================================

drop index if exists public.journal_entries_one_posted_per_source;

create unique index journal_entries_one_posted_per_source
  on public.journal_entries (source_kind, source_id)
  where status = 'posted'
    and source_kind != 'reversal'
    and source_kind != 'hmo_history_opening'
    and source_id is not null;

comment on index public.journal_entries_one_posted_per_source is
  '12.A.5: Excludes hmo_history_opening because a single import run produces '
  'one opening JE per provider (1..N JEs share source_id = run_id). Reversal '
  'and null-source JEs were already excluded by 0030.';

# Patient merge / undo-merge as atomic database functions (PR 3b)

Parent spec: `2026-09-24-patient-delete-design.md` — sections "One locking protocol…",
"PR 3 revision" (lock modes, admission, re-resolution) and "3b — merge / undo-merge RPCs".
This document is the detailed design for 3b and supersedes the 3b bullet list there where
they differ. Migrations **0196** (functions + callers, this PR) and **0197** (merge-marker
enforcement, follow-up PR after the 3b deploy is verified). Error codes **P0078–P0080**.

## Why

Merge and undo-merge are still multi-statement app code: `mergePatientsAction`
(`admin/patient-merge/actions.ts`) runs six FK moves, a fill, a tombstone and a ledger
insert as separate PostgREST calls, with a hand-built snapshot + rollback runner
(`merge-steps.ts`) to claw back partial work. The runner documents its own residual race: a
row attached to the source after the snapshot whose own move loses its HTTP response is moved
but never rolled back. `scripts/patient-dedup/engine.ts` has a second, divergent copy (fills
`birthdate` too, collapses tombstone chains, writes no ledger, audits with a NULL actor).
Undo (`undoMergeAction`) is also step-by-step and can stop half-way ("Undo stopped
part-way… run Undo again").

Measured on prod 2026-09-30: 177 merged tombstones (176 from the June CLI run + 1 admin merge
today, 14:40 Manila — the first `patient_merges` ledger row ever), 0 tombstone chains, 0
tombstones pointing at a deleted record, consent cache consistent for all 7,068 patients.

## Gaps found while designing (fixed by this PR)

1. **Consent cache is not re-synced on a merge or undo.** `trg_patient_consents_sync` is
   `AFTER INSERT` only (0086); moving `patient_consents` by `UPDATE … patient_id` leaves both
   patients' cached `consent_current / consent_signed_at / consent_withdrawn_at /
   consent_method / consent_notice_version` stale. Prod happens to be consistent today (the
   merged sources had no consent events). Codex P1-7 in the parent spec.
2. **Undo can clobber later edits.** Undo nulls every `filled_from_source` field whatever its
   current value (Codex P2-8).
3. **Tombstone chains are never flattened by the admin path**, and never restored by undo
   (Codex P2-9). The CLI flattens but records nothing.
4. **CLI merges have no actor and no ledger** (Codex P2-10): not undoable, not attributable.
5. **Nothing stops a direct service-role UPDATE of `merged_into_id` / `merged_at`** — 0167's
   patients guard covers only the deletion columns (Codex P1-6; fixed by 0197).
6. **Recent merges list** computes `keep_deleted_at` "for an InactivePatientBadge" but the
   candidates page never renders the badge, and `undoable` is hard-coded `true`.

## Design

### Private role `patient_merge_writer` (0196)

Same pattern as `patient_lifecycle_writer` (0167; `drmed-migrations` → "Private-role write
pattern"): `create role … nologin noinherit nobypassrls` restated every migration; revoked
from `anon, authenticated, service_role, authenticator`; `grant … to postgres with inherit
true, set true`; function ownership transferred inside a transient `grant create on schema
public` / `revoke`. Non-assumability proven with `pg_has_role` + a real `authenticator` login.

It is NOBYPASSRLS, so it gets exactly the table privileges and role-scoped RLS policies the two
functions (and every SECURITY INVOKER trigger they fire) need — enumerated in the plan from
`pg_trigger` on the touched tables, not guessed:

| Table | Privilege | Why |
|---|---|---|
| `patients` | SELECT, UPDATE (fill fields, consent cache columns, `merged_into_id`, `merged_at`, `updated_at`, `row_version`) | lock/read, fill, consent re-sync, tombstone, chain re-parent |
| `visits`, `appointments`, `audit_log`, `critical_alerts`, `patient_consents`, `appointment_attachments` | SELECT, UPDATE (`patient_id`) | the six moves |
| `test_requests` | SELECT | the critical-alert move-back predicate |
| `staff_profiles` | SELECT | actor validation |
| `patient_merges` | SELECT, INSERT, UPDATE | ledger (RLS on, no policies today) |
| `audit_log` | INSERT (+ `audit_log_id_seq` USAGE), check `action in ('patient.merged','patient.merge.undone')` | in-transaction audit |

It cannot change deletion metadata (0167's guard requires `patient_lifecycle_writer`), and
`patient_lifecycle_writer` cannot change merge markers (0197).

### `merge_patients_guarded(p_keep uuid, p_source uuid, p_actor uuid, p_context jsonb default null) returns jsonb`

SECURITY DEFINER, owner `patient_merge_writer`, `search_path = pg_catalog, public, pg_temp`,
EXECUTE `service_role` only. One transaction:

1. **Validate.** `p_actor` is an active admin (`staff_profiles.id = p_actor and role = 'admin'
   and is_active and deleted_at is null`, same predicate as `delete_patient`) else **P0078**.
   Keep ≠ source, both non-null, else **P0079** ("pick two different patients"). `p_context`
   keys allow-listed (`ip_address`, `user_agent`, `source` ∈ {`admin`, `candidates`,
   `dedup-cli`}, `tier`) else P0079.
2. **Lock** (parent spec "Lock modes": exclusive, sorted, taken directly). Plain read of the
   chain set `C = {p.id : p.merged_into_id = p_source}`. `lifecycle_lock(array[keep, source]
   ∪ C, true)` (no assert — chain members are inactive by definition). Then `select … for no
   key update` on those patient rows in UUID order. **Re-resolve** `C` with a fresh statement;
   if it differs, raise **P0072** (caller retries once in a fresh transaction —
   `withLifecycleRetry`).
3. **Assert active.** Keep and source exist, `deleted_at is null and merged_into_id is null`,
   else **P0058** with a specific message (missing / deleted — restore first / already merged).
4. **Move** the six tables in the fixed order `visits, appointments, audit_log,
   critical_alerts, patient_consents, appointment_attachments` (visits before critical_alerts:
   0184's (a2') alert-matches-its-test check) with `update … set patient_id = p_keep where
   patient_id = p_source returning id`, collecting exact id arrays in SQL (no PostgREST cap).
   Each statement fires `a_lifecycle_guard`, whose exclusive locks on old ∪ new are already
   held (re-entrant).
5. **Consent re-sync** for keep and source via a new `public.recompute_patient_consent_cache(
   p_patient_id uuid)` holding 0162's "latest event by `seq`" rule, plus the no-events case
   (all five columns cleared). `sync_patient_consent_state()` is re-created to call it, so there
   is one copy of the rule. Source first, before it is tombstoned (see 0197).
6. **Fill.** One field set for both callers: `middle_name, sex, phone, email, address,
   birthdate` — a keep field that is NULL or blank takes the source's non-blank value; never
   overwrite. Snapshot `{field: {before, after}}` (before = keep's value, after = the copied
   value). `phone_normalized` follows via its trigger. **Owner-visible change:** the admin
   merge now also fills a missing birthdate, as the CLI always has.
7. **Flatten the chain.** `update patients set merged_into_id = p_keep where merged_into_id =
   p_source returning id` → `rechained` ids (their previous target is always `p_source`).
8. **Tombstone** the source: `merged_into_id = p_keep, merged_at = now()`.
9. **Ledger.** Insert `patient_merges` with `snapshot_version = 2`, `merged_by = p_actor`,
   `moved` (exact ids per table), `filled_from_source` (names, kept for legacy readers),
   `fill_snapshot`, `rechained`, `context`.
10. **Audit** `patient.merged` (actor, `actor_type 'staff'`, keep's patient_id, ip/ua from
    context, metadata: kept/merged DRM-IDs, merge_id, moved counts, filled fields, rechained
    count, source/tier).
11. Return `{merge_id, keep_id, source_id, kept_drm_id, merged_drm_id, moved:{6 counts},
    filled:[…], rechained: n}`.

Any error rolls back everything — there is no partial merge and no app-side rollback.

### `undo_patient_merge_guarded(p_merge_id uuid, p_actor uuid, p_context jsonb default null) returns jsonb`

Same ownership/ACL. One transaction:

1. Validate actor (**P0078**) and context keys.
2. Plain read of the ledger row; missing → **P0079** "merge record not found".
3. **Lock** keep, source and the ledger's `rechained` ids, exclusive, sorted; then the ledger
   row `for update`; then the patient rows `for no key update`.
4. **Refuse** (all **P0079**, specific messages) unless: not already undone; `merged_at` within
   30 days (the window moves from TS into SQL — one source of truth; the page still hides
   older rows); source's `merged_into_id = keep` (still this merge's tombstone) and
   `deleted_at is null`; keep active (not merged into a third record — "undo that merge first";
   not deleted — "restore it first").
5. **Clear the source's marker first** (source becomes active, so 0184's guards accept the
   move-back without any bypass flag).
6. **Move back**, same table order, only ids recorded in `moved` **and still owned by keep**:
   `update t set patient_id = source where id = any(moved.t) and patient_id = keep`.
   critical_alerts additionally require that the alert's test's visit now belongs to source
   (otherwise it stays, reported) — never a 23514 abort.
7. **Revert the fill.** Version 2: set a field back to its `before` value only while keep's
   current value still equals the recorded `after`; otherwise leave it and report it as
   "kept (edited since merge)". **Legacy rows** (no `snapshot_version`: today's one prod row
   and any merge made before the 3b deploy): clear a `filled_from_source` field only while
   keep's current value equals the source's current value (the fill copied it; the source
   kept its own), else keep + report.
8. **Restore the chain**: `update patients set merged_into_id = source where id =
   any(rechained) and merged_into_id = keep`.
9. **Consent re-sync** for both.
10. Ledger: `undone_at`, `undone_by`, `undo_report` = `{moved_back:{counts}, left_on_keep:{ids},
    kept_fields:[…], rechained_back: n}`.
11. Audit `patient.merge.undone` with the same report. Return the report.

### Ledger changes (`patient_merges`, 0196)

Add `snapshot_version smallint`, `fill_snapshot jsonb`, `rechained uuid[] not null default
'{}'`, `context jsonb`, `undo_report jsonb`. Partial unique index `(source_id) where
undone_at is null` (a source has at most one live merge). RLS stays on; policies only for
`patient_merge_writer`; service_role keeps reading it for the Recent merges list.

### App

- `mergePatientsAction`: `requireAdminStaff()`, zod parse, `withLifecycleRetry(() =>
  admin.rpc("merge_patients_guarded", …))` (safe to retry: the transaction rolled back),
  `translatePgError` on failure. Then — unchanged in spirit — the "records combined" email
  after a fresh `checkPatientRecipient`, and a second audit row
  `patient.merge.notified` (`{merge_id, recipient, email}`) since the merge's own audit row
  is written in SQL before the email exists.
- `undoMergeAction`: RPC + `translatePgError`; `UndoResult` gains the report so the page can
  say which fields were kept and how many rows stayed on the kept record.
- `mergeCandidateAction` unchanged (delegates). `loadRecentMerges` computes a real
  `undoable` + reason (keep merged/deleted, source no longer this tombstone) and the list
  renders `InactivePatientBadge` next to a deleted kept record.
- **Delete** `merge-steps.ts`, `undo-merge-steps.ts`, their tests, `actions.rollback.test.ts`,
  `rollbackMergeMoveStep`, `revertFillFields`, `snapshotSourceIds`, `reportMergeStopped`.
- **Dedup CLI**: `mergeOne` becomes one RPC call with `context {source:'dedup-cli', tier}`.
  `--commit` now requires `--actor <admin staff uuid>` (uuid-validated before any client is
  built; validated as an active admin by the RPC). The dry-run prints the flag in its commit
  hint. CLI merges now get a ledger row, so they are undoable from Admin Tools for 30 days.
- **Tests (vitest):** replace `actions.tables.test.ts` with an FK-inventory test: every
  `references public.patients` column across `supabase/migrations/` is either moved by 0196
  (the six) or listed as deliberately not moved with a reason (`patient_merges.keep_id/
  source_id`, `patients.merged_into_id`, and the Sheet Sync / Patient Sources tables
  `sheet_patient_links`, `patient_acquisition_facts`, `sheet_customer_rows`,
  `sheet_encounter_lines` — their readers follow `merged_into_id` chains, `_ps_survivors()`
  0189, and the sync treats a merged target as stale, 0193; re-pointing them would bypass the
  sync's identity matching). Action/CLI tests assert the RPC arguments and error mapping.
  `write-guards.test.ts` loses its three merge exemptions; `query-surfaces.test.ts`
  comments updated.
- `pg-errors.ts`: P0078 "Only an active admin can merge or undo a merge." P0079 → the
  function's own message (specific refusals). P0080 (0197) → "Patient records can only be
  merged or un-merged from Admin Tools › Merge Duplicate Patients."

### 0197 — merge-marker enforcement (follow-up PR, after 3b's deploy is verified)

New SECURITY INVOKER trigger `trg_patients_merge_marker_guard` (before insert or update on
`patients`), raising **P0080** unless `current_user = 'patient_merge_writer'` when:
an INSERT carries `merged_into_id`/`merged_at`; an UPDATE changes either column. Even for the
writer, only two transitions are legal: `(null, null) → (X, t)` on a row with `deleted_at is
null`, and `(X, t) → (null, null)`; plus chain re-parenting `X → Y` (merged_at unchanged).
Additionally, a row that is merged (before and after) refuses any other column change
(P0058, like 0167's rule for deleted rows) except bookkeeping (`updated_at`, `row_version`)
and the consent-cache columns when written by the writer. Fixtures that set
`merged_into_id` directly (`supabase/tests/0167_*_smoke.sql`, `0184_*_smoke.sql`,
`scripts/patient-sources-db-proof.ts`) switch in **this PR (3b)** to a
`set local role patient_merge_writer` helper, so they already pass under 0197.
Rollback: drop the trigger (app unaffected).

## Proofs

- `supabase/tests/0196_patient_merge_smoke.sql` (single connection, `begin … rollback`,
  prod-size guard like 0184's): every move; exact ledger ids; fill before/after incl. blank
  strings and birthdate; consent re-sync with opposing states on each side and events recorded
  between merge and undo; chain flatten + restore; undo keeps an edited field (v2 and legacy
  fixture rows); rows moved off keep after the merge stay put; alert predicate; 30-day
  window; double undo; undo after keep merged/deleted; actor refusals (non-admin, inactive,
  deleted, null); ACLs (anon/authenticated no EXECUTE); role non-assumable; a forced failure
  in a late step leaves both patients exactly as before.
- **Two-session concurrency proof** (`scripts/merge-concurrency-proof.ts`, pattern of
  `panel-claim-concurrency-proof.ts`, with a `--control` mutant that drops the lock): merge vs
  `create_visit_encounter` on the source (either the new visit is moved, or creation gets
  P0058 — never a visit stranded on a tombstone); merge vs `delete_patient` on keep; two
  merges of the same source into different keeps (one wins, the other P0058); A→B racing B→C
  (no chain onto a tombstone, no lost rows); merge vs a payment on a moving visit; double
  undo; undo vs an edit of a filled field.
- `supabase/tests/0197_merge_marker_smoke.sql`: direct service_role marker writes refused;
  both functions still work; lifecycle writer cannot set markers; merged-row edits refused.
- Fresh replay of the full history on the isolated replay stack; Playwright browser smoke of
  merge + undo (manual and candidates) on local dev.

## Deploy order

1. PR 3b: user runs `supabase db push` for 0196 right before merge (Claude's push is blocked by
   the classifier); verify by object (functions, owner, ACLs, role memberships, new columns,
   index); owner OK; merge; confirm the Vercel Production deploy is Ready. 0196 is additive —
   the old app keeps working against it during the deploy window.
2. PR 3b-follow-up: 0197 push → verify → merge. Rollback: revert 0197 first, then app code.

## Out of scope — suggestions for the owner

- "Merge history" panel on a patient's profile (ledger rows where they were keep or source).
- Deep link from the Possible-duplicates panel / profile to the merge page with the pair
  pre-selected.
- Audit page: readable rendering of `patient.merged` / `patient.merge.undone` metadata and a
  one-click "Merges" preset.
- Offer an explicit keep/source swap on the candidates page (keep is always the older record).

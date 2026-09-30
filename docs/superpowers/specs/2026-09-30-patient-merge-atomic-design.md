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
| `critical_alerts` | UPDATE (`patient_drm_id`) | re-stamp the copied DRM-ID (merge and undo) |
| `test_requests` | SELECT | the critical-alert move-back predicate |
| `staff_profiles` | SELECT | actor validation |
| `patient_merges` | SELECT, INSERT, UPDATE | ledger (RLS on, no policies today) |
| `audit_log` | INSERT (+ `audit_log_id_seq` USAGE), check `action in ('patient.merged','patient.merge.undone')` | in-transaction audit |
| `result_test_requests`, `results` | SELECT | affected-result set + split check |

**Function privileges too (Codex R3).** 0184 revokes EXECUTE on its helpers from every role,
and a role granted *to* postgres does not inherit postgres's rights. The writer is granted
EXECUTE on exactly the helpers the two functions call directly — `lifecycle_lock(uuid[],
boolean)`, `lifecycle_lock_results(uuid[], boolean)` and the new
`recompute_patient_consent_cache(uuid)` — with the runtime-role revocations restated.
(Trigger functions need no EXECUTE grant: the privilege is checked at `CREATE TRIGGER`, not at
firing; the SECURITY DEFINER guards then run as their owner.) The plan enumerates every
direct and nested call from the final function bodies, and both functions are proven by
calling them **as `service_role`**, not as postgres.

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
2. **Lock**, in 0184's global order — result membership → patient → row (Codex R5). Plain
   reads of: the chain set `C = {p.id : p.merged_into_id = p_source}`, and the affected
   result set `R` = results linked (`result_test_requests`) to any test on a visit of source,
   ∪ `critical_alerts.result_id` of source's alerts. Then
   `lifecycle_lock_results(R, false)` (shared: blocks link/unlink, which take it exclusive,
   without serialising ordinary result writers), then `lifecycle_lock(array[keep, source] ∪
   C, true)` (exclusive, sorted, no assert — chain members are inactive by definition), then
   `select … for no key update` on those patient rows in UUID order. **Re-resolve** `C` and
   `R` with fresh statements; if either differs, raise **P0072**. Every caller — admin
   merge, candidates merge, undo, and the CLI — wraps the call in `withLifecycleRetry`
   (P0072 / 40P01 / 40001, once, whole transaction). The alert move's trigger then re-takes
   the membership lock re-entrantly, so no membership-after-patient inversion remains.
3. **Assert active.** Keep and source exist, `deleted_at is null and merged_into_id is null`,
   else **P0058** with a specific message (missing / deleted — restore first / already merged).
4. **Move** the six tables in the fixed order `visits, appointments, audit_log,
   critical_alerts, patient_consents, appointment_attachments` (visits before critical_alerts:
   0184's (a2') alert-matches-its-test check) with `update … set patient_id = p_keep where
   patient_id = p_source returning id`, collecting exact id arrays in SQL (no PostgREST cap).
   Each statement fires `a_lifecycle_guard`, whose exclusive locks on old ∪ new are already
   held (re-entrant). Moved alerts also get `patient_drm_id = keep.drm_id`: the Critical
   Alerts page, lab dashboard and notification bell print that copied column, and an open
   alert must not send staff to a retired DRM-ID the active directory can no longer find.
5. **Consent re-sync** for keep and source via a new `public.recompute_patient_consent_cache(
   p_patient_id uuid)` (Codex R4): a **fold over the patient's events in `seq` order**
   applying 0162's three transitions exactly (full grant → all five from the event;
   booking-only grant → false + four NULLs; withdrawal → false, `consent_withdrawn_at` =
   event time, the other three carried from the fold state), starting from `consent_current
   = false` and four NULLs (so no events ⇒ false + NULLs; the boolean is NOT NULL). Because
   `seq` is insertion order, the fold equals what the incremental trigger produced — the plan
   verifies fold = cache for every prod patient (read-only) before push, and 0196 asserts it
   in a post-condition. `sync_patient_consent_state()` is re-created to call the helper, so
   there is one copy of the rule. All five columns are asserted after merge and undo. Source
   first, before it is tombstoned (see 0197).
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
3. **Lock**, same global order. The affected result set `R` covers the **complete undo
   scope**, whatever the current owner (recheck R1'): results linked to any test on **any**
   visit in `moved.visits` — on keep, or already back on source after an interrupted legacy
   undo — ∪ `result_id` of every alert (on keep or source) whose test is on one of those
   visits, i.e. every alert the dependent-row step may update. Plain read of `R`;
   `lifecycle_lock_results(R, false)`; then keep, source and the ledger's `rechained` ids
   exclusive, sorted; then the ledger row `for update`; then the patient rows `for no key
   update`; re-resolve `R` → P0072 if changed. The split-result check (step 4) evaluates
   every result in `R` against the **final** planned ownership, so a result an interrupted
   old undo already split is caught too.
4. **Refuse** (all **P0079**, specific messages) unless: not already undone; `now() -
   merged_at < interval '30 days'` (the window moves from TS into SQL — one source of truth;
   tested at 29d 23h 59m 59s allowed, exactly 30d and 30d + 1s refused); keep active (not
   merged into a third record — "undo that merge first"; not deleted — "restore it first");
   source `deleted_at is null` and **either** `merged_into_id = keep` (this merge's tombstone)
   **or** — legacy ledger rows only — `merged_into_id is null` with no other live ledger row
   for source: an **interrupted legacy undo** (the old action clears the marker first and
   could stop part-way, Codex R6), which this call completes; every later step is already
   "only if still on keep", so it is idempotent over whatever the old action finished.
   **Split-result refusal (Codex R1):** after the planned move-back, every result in `R` must
   still link tests of exactly one patient — a result created after the merge that combines a
   moved-back visit's test with one of keep's own tests refuses the whole undo ("result …
   now combines tests from both records — correct it first"), before anything changes.
5. **Clear the source's marker first** (source becomes active, so 0184's guards accept the
   move-back without any bypass flag).
6. **Move back**, same table order. Rows the merge moved: only ids recorded in `moved`
   **and still owned by keep** (`… where id = any(moved.t) and patient_id = keep`) — for
   `visits`, `appointments`, `audit_log`, `patient_consents`. **Dependent rows follow their
   parent, recorded or not (Codex R2):** after visits move, every `critical_alerts` row on
   keep whose test's visit now belongs to source moves to source with `patient_drm_id =
   source.drm_id` — including alerts created, acknowledged or withdrawn after the merge; a
   recorded alert whose test's visit stayed on keep stays (reported). So 0184's (a2')
   alert-matches-its-test rule holds by construction and never aborts with 23514.
   `appointment_attachments` (`booking_group_id` is deliberately not an FK, 0103, so a group
   can be empty — recheck R5'): the **evidence** for a group is its appointments with a
   non-NULL `patient_id`. An **unrecorded** attachment on keep moves only on positive
   evidence — at least one such appointment and all of them now on source. A **recorded**
   attachment still on keep moves when its group has no evidence (empty, or walk-in-only) or
   all evidence is on source; it stays (reported) when any evidence is on keep or a third
   patient. So keep's own orphan uploads are never taken.
7. **Revert the fill.** Version 2: set a field back to its `before` value only while keep's
   current value still equals the recorded `after`; otherwise leave it and report it as
   "kept (edited since merge)". **Legacy rows** (no `snapshot_version`: today's one prod row
   and any merge made before the 3b deploy) whose source is still this merge's tombstone:
   clear a `filled_from_source` field only while keep's current value equals the source's
   current value (the fill copied it; the tombstone kept its own), else keep + report. In the
   **interrupted-legacy-resume** branch the source has been active and editable since the old
   undo stopped, so its value is no longer evidence of what was copied (recheck R4'): every
   fill field is left as it is and reported as "not reverted — undo was interrupted, check by
   hand". Fixture: legacy merge copies a phone, undo interrupted, both records then corrected
   to the same new phone → recovery keeps it.
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

**Rollback safety in 0196 itself (Codex R7).** If the app were reverted after version-2 merges
exist, the old Undo would ignore `rechained`/`fill_snapshot`, skip the consent re-sync and
clear fields unconditionally. 0196 therefore ships one narrow guard now (the rest of marker
enforcement waits for 0197): a SECURITY INVOKER trigger on `patients` refuses (**P0080**) any
change of `merged_into_id` on a row that is the source of a live `snapshot_version = 2`
ledger row unless `current_user = 'patient_merge_writer'`. The old Undo's first step is
exactly that change, so it fails with nothing changed; the old merge (legacy rows) and old
undo of legacy rows keep working during the deploy window. Rollback rehearsal on local: v2
merge → old-app undo refused, nothing changed → roll forward → RPC undo succeeds.

### App

- `mergePatientsAction`: `requireAdminStaff()`, zod parse, `withLifecycleRetry(() =>
  admin.rpc("merge_patients_guarded", …))` (safe to retry: the transaction rolled back),
  `translatePgError` on failure. Then — unchanged in spirit — the "records combined" email
  after a fresh `checkPatientRecipient`, and a second audit row
  `patient.merge.notified` (`{merge_id, recipient, email}`) since the merge's own audit row
  is written in SQL before the email exists.
- `undoMergeAction`: RPC + `translatePgError`; `UndoResult` gains the report so the page can
  say which fields were kept and how many rows stayed on the kept record.
- `mergeCandidateAction` unchanged (delegates). `loadRecentMerges` lists **every** live
  merge inside the 30-day window, paged (`merged_at desc, id desc`, `count: "exact"`, Codex
  R8 — a CLI batch can exceed the old latest-50 cap), computes a real `undoable` + reason
  (keep merged/deleted, source no longer this tombstone — except the interrupted-legacy-resume
  state, which stays undoable and is labelled "undo was interrupted — finish it") and renders
  `InactivePatientBadge` next to a deleted kept record.
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
(P0058, like 0167's rule for deleted rows) except bookkeeping (`updated_at`, `row_version`) —
nothing needs a wider exception: merge re-syncs the source's consent cache BEFORE tombstoning
it, and undo clears the marker FIRST, so the consent-cache columns are never written on a row
that is (before and after) merged. Fixtures that set
`merged_into_id` directly (`supabase/tests/0167_*_smoke.sql`, `0184_*_smoke.sql`,
`scripts/patient-sources-db-proof.ts`) switch in **this PR (3b)** to a helper that runs
`set local role patient_merge_writer` and writes **both** `merged_into_id` and `merged_at`
(several fixtures set only `merged_into_id` today, which 0197's transition rule refuses), so
they already pass under 0197.
0197 SUPERSEDES this PR's rollback guard (section 5 of 0196): its migration also drops
`trg_patients_live_merge_guard`, `guard_live_merge_marker()` and `patient_has_live_v2_merge(uuid)`
— its own trigger covers every `merged_into_id`/`merged_at` change, writer or not, so the
narrower 0196 guard becomes redundant weight once 0197 is live.
Rollback: drop the trigger (app unaffected; reverting 0197 = re-run 0196 section 5 to
restore the narrower guard).

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
- Added after the Codex spec review: a shared-result fixture (undo refused, nothing changed);
  alerts created / acknowledged / withdrawn after the merge follow their visit on undo, with
  `patient_drm_id` restamped both ways; attachments follow their booking group; an
  **interrupted legacy undo** (old action stopped after clearing the marker and moving some
  rows) completed by the RPC; the 30-day boundary; all five consent columns asserted after
  merge and undo, including grant → withdrawal and booking-only histories; both functions
  called as `service_role`; the 0196 rollback guard (old-app undo of a v2 merge refused,
  nothing changed). Races added to the concurrency proof: result link (membership exclusive)
  vs merge and vs undo, and a row-first child update vs merge — each proves rollback and
  retry convergence.
- Added after the Codex recheck: `service_role` calls of both functions with alerts present
  (the `patient_drm_id` column grant); legacy recovery with a visit already back on source,
  an unmoved alert and a shared result; the legacy edit-after-interruption fixture; attachment
  groups that are empty, walk-in-only, split across owners; ordinary staff patient edits and
  delete/restore still work under 0196's new `patients` trigger; the all-five-column consent
  fold = cache comparison stays a real deployment gate (pre-push query + 0196 post-condition).
- `supabase/tests/0197_merge_marker_smoke.sql`: direct service_role marker writes refused;
  both functions still work; lifecycle writer cannot set markers; merged-row edits refused.
- Fresh replay of the full history on the isolated replay stack; Playwright browser smoke of
  merge + undo (manual and candidates) on local dev.

## Deploy order

0. **Cutover check** (read-only, prod) right before the push and again after the deploy is
   Ready: every live ledger row's source still has `merged_into_id = keep_id`, or is an
   interrupted legacy undo the new RPC completes (step 4). Anything else is reconciled by hand
   before proceeding. Also re-run the consent fold = cache check.
1. PR 3b: user runs `supabase db push` for 0196 right before merge (Claude's push is blocked by
   the classifier); verify by object (functions, owner, ACLs, role memberships, helper
   EXECUTE grants, new columns, index, both triggers); owner OK; merge; confirm the Vercel
   Production deploy is Ready. 0196 is additive — the old app keeps working against it during
   the deploy window, except that an old-app Undo of a version-2 merge is refused (none can
   exist until the new app runs).
2. PR 3b-follow-up: 0197 push → verify → merge. Rollback: revert 0197 first, then app code;
   with the app reverted, version-2 merges stay un-undoable (refused, nothing changed) until
   roll-forward.

**App rollback past 3b needs a merge freeze (recheck R3').** The old merge paths are
multi-statement and move rows before they touch any marker, so no database guard can refuse
them cleanly at step 1: e.g. after a v2 merge A→B, the old CLI merging B→C commits B's moves,
then its chain re-point of A is refused (A is a live v2 source) and it throws with no
rollback. Therefore: before any app rollback to a pre-3b build, freeze Merge, candidates
Merge, Undo and the dedup CLI (owner + Claude are the only operators; the CLI is run only by
hand) until roll-forward. The 0196 guard stays as a backstop for old-app Undo and is **not**
weakened. The rollback rehearsal documents the CLI scenario as the reason for the freeze.

## Out of scope — suggestions for the owner

- "Merge history" panel on a patient's profile (ledger rows where they were keep or source).
- Deep link from the Possible-duplicates panel / profile to the merge page with the pair
  pre-selected.
- Audit page: readable rendering of `patient.merged` / `patient.merge.undone` metadata and a
  one-click "Merges" preset.
- Offer an explicit keep/source swap on the candidates page (keep is always the older record).

## Revision after the Codex spec review (2026-09-30)

Codex xhigh (session `01a0f110-bf91-72a3-bf2d-51ba09444597`) found 3 P1, 4 P2, 1 P3; all
verified against the code and closed above.

| # | Finding | Where closed |
|---|---|---|
| R1 (P1) | Undo can split one result across two patients | Undo step 4 split-result refusal + membership lock (step 3) |
| R2 (P1) | Alerts created after the merge stay on keep after undo | Undo step 6: dependents follow their parent; attachments follow their booking group |
| R3 (P1) | Writer cannot EXECUTE 0184's revoked lock helpers | Role section: explicit helper EXECUTE grants; service_role-call proofs |
| R4 (P2) | 0162's withdrawal branch is incremental, not a full derivation | Merge step 5: fold over events in `seq` order; fold = cache verified on prod |
| R5 (P2) | Membership-after-patient lock inversion | Merge step 2 / undo step 3: membership → patient → row; retry on every caller |
| R6 (P2) | Interrupted legacy undo has no completion path | Undo step 4 legacy-resume branch + deploy cutover check |
| R7 (P2) | Reverting the app with v2 merges is unsafe | 0196 rollback guard on `merged_into_id` for live v2 sources; rehearsal |
| R8 (P3) | Recent merges capped at 50 | Paged list of all live merges in the window |
| — | Fixtures set `merged_into_id` without `merged_at`; 30-day boundary unspecified | Fixture helper writes both; boundary rule + tests |

Also added during revision: moved alerts' copied `patient_drm_id` is re-stamped (merge) and
restored (undo), since three staff surfaces print it.

### Codex recheck (same session, 2026-09-30) — closed without a further run

The one allowed recheck confirmed R3, R4 and R8 and partly resolved the rest, and raised five
new issues from the revisions, all verified and closed above: R1' legacy-resume result scope
(undo step 3), R2' `patient_drm_id` column grant (role table), R3' old CLI after an app
rollback (merge freeze in "Deploy order"), R4' legacy-resume fill evidence (undo step 7),
R5' empty attachment groups (undo step 6). The one-recheck limit is used; remaining assurance
comes from the smokes, the two-session proofs and the Opus review of the SQL.

## Opus SQL review (2026-09-30)

A follow-up SQL-focused review of 0196 (Opus 5.5, 1M context) found 3 Important issues (I1–I3)
and 10 Minor ones (M1–M10). Round 1 (this fix batch) closed I1–I3 and the four Minor findings
that were genuine, cheap-to-fix behavioural or hardening gaps (M1, M3, M5, M6); the rest are
noted below as either deferred with a reason, or out of scope for a round-1 fix.

| # | Finding | What was done |
|---|---|---|
| I1 | An interrupted legacy (pre-3b) undo could get stuck behind the 30-day window, and re-merging its now-active source hit a raw `23505` (`uq_patient_merges_live_source`) instead of a worded refusal | `undo_patient_merge_guarded`: `v_resume` is now decided BEFORE the 30-day check, and that check is skipped when resuming — an interrupted undo is completable at any age. `merge_patients_guarded`: refuses (P0079) if either side is the SOURCE of a live (`undone_at is null`) ledger row, pointing the admin at Recently merged first. `undoableState` (TS) mirrors the same reordering |
| I2 | A `critical_alerts` row's `patient_id` could in principle predate 0184's consistency check and drift from its own test's visit | Section 9 post-condition: fails the push if any alert names a patient other than its test's visit's patient (no function change — prod already has 0 alerts) |
| I3 | Nothing re-asserted, inside 0196 itself, that 0202's service_role-only invariant still holds for `patient_merges` / `patient_consents` once they carry writer-only policies | Section 9 post-condition: anon/authenticated hold no table/column/sequence privilege on either table, and every policy on both names only `patient_merge_writer`. `0151_rls_initplan_smoke.sql`'s third assertion now also scans these two tables even though they carry policies |
| M1 | `patient_has_live_v2_merge` needed EXECUTE granted to the writer role for an arm of the guard's `AND` it never actually needed to run, because Postgres checks EXECUTE when it initialises a plan node, not lazily as `AND` short-circuits | `guard_live_merge_marker` rewritten as a nested `IF` (the inner call is its own statement, only planned once reached) instead of one `AND`; the writer's EXECUTE grant is revoked instead of held |
| M2 | (not detailed in the controller's round-1 brief) | Not itemized for this round — no fix made; flag if it should be pulled into round 2 |
| M3 | The repeat flag a merge sets (`is_repeat_patient = true`) was never reverted by undo | Merge records `repeat_flag_set: true` in `patient_merges.context` (and so in the audit row) only when its `UPDATE` actually flips the flag. Undo reverts it (and reports `repeat_flag_reverted`) only when that context key is set AND the keep's own visit count (post move-back) is ≤ 1 |
| M4 | A legacy revert can write `NULL` into a field the keep held as `''` before the merge (the pre-3b app never distinguished blank from absent) | Deferred — pre-existing legacy-fill behaviour, not part of this round's approved change list |
| M5 | Undo's report never said which older chain members (`patient_merges.rechained`) could NOT be re-pointed back (e.g. edited elsewhere after the merge) | Report now includes `rechained_not_restored` (the ids in `m.rechained` not covered by the actual re-point); `undoReportLines` adds a singular/plural line naming the count |
| M6 | Undo's parsing of `patient_merges.moved` assumed every one of the six keys is always a JSON array; a hand-edited or otherwise malformed row would raise a raw `22023` instead of failing gracefully | Each of the six keys is now read through `case jsonb_typeof(...) when 'array' then … else '[]'::jsonb end` — anything that is not actually an array is treated as empty |
| M7 | A writer racing 0184/0198 for the same lock can surface P0058 (record inactive) rather than the more specific P0072 (record changed while waiting) | Deferred — pre-existing lock-order interaction between 0184/0198 and this migration, follow-up not scoped for round 1 |
| M8 | Sheet Sync's patient-row locking (no advisory lock) can `40P01` (deadlock) against a concurrent merge | Deferred — Sheet Sync already retries on `40P01`, and the sync ships PAUSED on prod, so this has no live blast radius today |
| M9 | (not detailed in the controller's round-1 brief) | Not itemized for this round — no fix made; flag if it should be pulled into round 2 |
| M10 | Merge takes one membership lock per RESULT of the source, not one lock for the whole merge, so a source with many results takes many locks | Deferred — fine at clinic scale (a merge's source rarely has more than a handful of live results); revisit only if a real merge is ever slow |

M2 and M9 are not itemized in the controller's approved round-1 change list (`fix1.md`) beyond
their numbers, so no fix was invented for either here — surfaced as a gap for the controller to
resolve in a follow-up round rather than guessed at.

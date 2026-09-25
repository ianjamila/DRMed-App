# Released chemistry reports: view, Results-page grouping, and editing

Date: 2026-09-24. Branch `fix/released-chemistry-view` (off `275558d`).
Reviewed by Fable and Codex Astra (high, two passes); findings folded in below.

## Symptoms (prod)

1. Queue → Released today → chemistry card → **Open** does nothing.
2. `/staff/results` shows each test "twice" (`TRIGLYCERIDES TRIGLYCERIDES`).
3. `/staff/results` shows 8 PDF links for a chemistry report that has one PDF.

## Root causes

- `queue/consolidated/[visitId]/[groupId]/page.tsx` loads only `requested | in_progress |
  result_uploaded` and redirects to `/staff/queue` when none match, and `queue/[id]/page.tsx`
  redirects every report-group service there. A finished chemistry report therefore has no page.
  Every link to one dead-ends: queue card, Critical Alerts, notification bell, lab dashboard, visit
  page, Lab TAT, Stuck tests. `ready_for_release` (finished but awaiting payment) is also invisible.
- Consolidated finalise writes ONE `results` row + ONE PDF linked to N `test_requests` through
  `result_test_requests`. The Results page renders one PDF link per `test_request`.
- The Tests column prints `{code} {name}`; for 265 of 273 active services these normalise equal.

## Owner decisions (2026-09-24)

| Question | Decision |
|---|---|
| Who may edit a finished result | Any medtech in the test's section, plus admin/pathologist (needs a read-policy change) |
| Patient-facing marker for an edited result | **None** — the PDF is replaced; staff see history |
| Signing medtech on an edited PDF | **The editor** (today's single-test behaviour), for both paths |
| Delivery | Two PRs |

## PR 1 — no migration

A. **Report cards on the consolidated route.** Load group members in every non-cancelled status,
   excluding package headers (`is_package_header`) and soft-deleted rows (both predicates). Partition:
   rows linked to a result with a stored PDF → one card per `result_id`; unlinked active rows → the
   existing entry form. Render cards above the form. Redirect only when both are empty. The template
   is required for the form only, not for cards. Section gate over the union of members (reception
   still 404s). Each card: group name, member tests with status badges (pending labels for
   `result_uploaded` / `ready_for_release`), finalised at/by, released at, "Edited <Manila date/time>
   — <reason>" when amended, and a **View PDF** link (`/staff/results/{memberId}/pdf`, already
   section-gated and audited). The stored PDF is the authoritative report — no inline values (the
   medtech read policy is owner-only until PR 2). Write a `result.report_viewed_staff` audit row for
   the page view (not in `generateMetadata`). After finalise the form refreshes in place instead of
   pushing to `/staff/queue`, so the medtech sees the card they produced.
B. **Results page.** Select `services.report_group_id` + `report_groups(name)` and the junction's
   `result_id`, `results.amended_at`, `amendment_count`. Within each visit row, fold grouped tests by
   `result_id` (unfinished grouped tests by group) into "Chemistry (8 tests)"; keep Map insertion
   order. PDF column: one link per distinct `result_id`. New **Edited** column: per result,
   "Edited <date/time> — <reason>" (latest committed amendment, ×N if more), one batched query, no
   N+1. Row actions: Open → the report (single test → `/staff/queue/{id}`; grouped → consolidated
   route with `#result-{id}`).
C. **Hide the duplicate code** when code and name normalise equal (case-insensitive, non-alphanumerics
   stripped). Pure helper.
D. **Guard the existing amend actions.** `amendResultAction` and `amendStructuredResultAction` refuse
   a result whose service has a `report_group_id` or whose junction has >1 member (today a direct
   call on a chemistry test would load the inactive per-service template and wipe the shared
   report's values).
E. Queue: the released grouped card also gets a direct "PDF →" link.
F. Tests (vitest, pure): consolidated partition, archive fold (order preserved, one link per
   result), code/name predicate, latest-amendment fold. Register new readers in
   `query-surfaces.test.ts`. Update `docs/drmed-user-guide.html` and the `drmed-result-templates`
   skill.

Known limit kept: the Results page paginates test rows before folding, so a report can straddle
two pages (existing behaviour for visits).


## PR 2 — editing finished results, whole-report undo, delete guard (migration 0172, P0065–P0067)

Branch `feat/released-chemistry-edit`, stacked on `fix/released-chemistry-view` (#218, open when PR 2
started — merge #218 WITHOUT `--delete-branch`, then rebase). Numbers (renumbered 2026-09-25): the first draft took 0167 / P0057–P0059, but the shared claims
registry (`npm run claim`) had already given those to patient-delete PR 2, so this PR claimed
**0172** and **P0065** (stale edit), **P0066** (result not editable), **P0067** (test is part of a
finished combined report — delete blocked). 0171 is on prod, so 0172 applies in order. Re-check both right before `db push`.

Codex Astra high plan review #1 (session `01a0d2c7-cd73-7b51-8347-c46e0e62f4fb`) findings are folded
in and marked [C1]…[C5]. Owner asked on 2026-09-24 to include undo-release and delete in this PR.

### 1. Migration 0172 `result_edit_commit`

a. **Read access to clinical values follows the section, for live values AND history** [C2].
   `public.lab_sections_for_role(text) returns text[]` (immutable SQL, mirrors `SECTIONS_BY_ROLE`,
   pinned by a vitest parity test; EXECUTE authenticated + service_role, anon revoked by name) and
   `public.staff_can_read_finished_result(uuid) returns boolean` (security definer, stable,
   `search_path = public`; EXECUTE authenticated + service_role): true for pathologist/admin; for
   medtech/xray_technician true only when the result has ≥1 linked test and NO linked test is
   outside `lab_sections_for_role(staff_role())` (NULL section counts as outside), unfinished
   (not `result_uploaded | ready_for_release | released`), soft-deleted, or on a soft-deleted
   visit; false for everyone else (reception).
   - `result_values`: new SELECT policy using the helper; the 0151 owner policy stays (bench drafts
     — it only ever matched the holder, and is the only other permissive SELECT).
   - `result_amendments`: the all-staff SELECT policy (reception included) is REPLACED by one using
     the helper — `prior_values_json` holds the same clinical values. Reception reads nothing here;
     no reception surface uses it (the visit page shows the Edited note only next to View PDF, which
     reception never gets).
b. **One write path for finished results** [C3]. Every app write to `results`, `result_values` and
   `result_amendments` already goes through the service-role client (grepped 2026-09-24: all
   `insert/update/upsert/delete` sites use `admin`). Drop the JWT write policies on all three tables
   (`results` FOR ALL write → replaced by nothing; `result_values` insert/update/admin-delete;
   `result_amendments` insert) so no signed-in client can bypass the version protocol. Pre-read the
   live policy list from the local DB so the drops are by exact name.
c. **`result_amendments.attempt_id uuid unique`** (nullable; legacy rows NULL) [C1].
d. **`public.result_edit_commit(...)`** — security definer, `search_path = public`, plpgsql, EXECUTE
   service_role only (revoke public/anon/authenticated by name). Arguments: `p_attempt_id,
   p_result_id, p_expected_amendment_count, p_editor, p_reason, p_anchor_test_request_id,
   p_new_storage_path, p_new_file_size_bytes, p_values jsonb (null = PDF-only), p_new_image jsonb
   (null = keep), p_alerts jsonb (null = leave alerts alone)`. One transaction:
   1. If a `result_amendments` row with `attempt_id = p_attempt_id` exists → return it (idempotent
      replay; nothing written).
   2. `select … from results where id = p_result_id for update`.
   3. P0066 unless: row exists; `storage_path` not null; structured ⇒ `finalised_at` not null; every
      linked LIVE test (test + visit `deleted_at is null`) is finished; at least one live linked
      test; the anchor is a live linked test; reason 5–2000 chars. Soft-deleted members are
      ignored rather than blocking (a deleted member must not lock the report forever); with P0067
      below a finished shared member can no longer be deleted, so this only covers legacy rows and
      single tests deleted while ready_for_release.
   4. P0065 when `amendment_count <> p_expected_amendment_count`.
   5. Insert `result_amendments` (seq = expected + 1, attempt_id) with prior PDF metadata, prior image
      columns, and `prior_values_json` built IN SQL (with parameter_name) under the lock.
   6. `p_values` not null → delete + insert the value set (flags computed in TS, per 0010).
   7. Update `results`: storage_path, file_size_bytes, uploaded_by = editor, uploaded_at, amended_at,
      amendment_count = expected + 1, image columns when `p_new_image`. `finalised_at` /
      `finalised_by_staff_id` untouched, so `advance_test_on_result_upload` cannot fire;
      `test_requests` is never written (status / released_at / released_by / release_medium
      unchanged by construction).
   8. Alerts when `p_alerts` not null (desired = crossings of the NEW values from TS
      `detectCritical`): identity (parameter_id, direction, observed_value_si). Lock this result's
      alerts `for update` first (serialises with an acknowledgement in flight). Insert desired
      crossings with no alert of the same identity; delete UNACKNOWLEDGED alerts whose identity is
      not desired; acknowledged alerts are never updated or deleted. A value corrected to a different
      critical value therefore re-pages.
   9. Return jsonb: amendment id/seq, prior path, alerts added (rows) / removed / kept-acknowledged.
e. **Delete guard** — `enforce_deletable_test_request` re-created from its latest body (0147) plus
   P0067: refuse soft-deleting a line linked to a result that has a stored PDF and more than one
   linked test (a finished combined report). Mirrored in `src/lib/visits/deletion.ts`
   (`shared_report` reason + hint) and pinned by `deletion.test.ts`. The visit-level delete is
   unaffected (a whole visit takes the whole report with it). ACL restated
   (`revoke all … from public, anon, authenticated`).

### 2. Commit protocol in TypeScript [C1]

`src/lib/actions/results/result-edit-core.ts` (server) `commitResultEdit()`:
1. New `attemptId = randomUUID()`; objects go to `<base>.v<N>.<attempt8>.pdf` (and the image to the
   `result-images` bucket likewise), `upsert: false`.
2. `rpc("result_edit_commit")`.
3. Outcome classification (pure helper `classifyCommitError`, tested): an error carrying a SQLSTATE
   (5-char code) or a `PGRST*` code is a DEFINITE rejection — the transaction did not commit, so
   remove exactly this attempt's objects and translate (P0065 → "someone saved an edit since you
   opened this — reload"). Anything else (fetch failure, timeout, no code) is UNKNOWN: re-query
   `result_amendments where attempt_id = attemptId` — found → treat as success; not found → KEEP the
   objects (an orphan is harmless; deleting a committed PDF is not) and tell the user the save could
   not be confirmed and to reload before retrying. Nothing is ever deleted after a confirmed commit.
4. Pure helpers in `src/lib/results/result-edit.ts`: `editVersionPath`, `classifyCommitError`,
   `countValueChanges`, `validateEditReason`, `EDITABLE_STATUSES`.

`loadResultDocumentInput(resultId, { finalisedAtOverride, valuesOverride, signerStaffId })`: the
edit PDF renders the NEW values before commit and signs as the editor (owner decision); control
number kept.

**Clinical reference date** [C5-uncertainty]: an edited PDF keeps the ORIGINAL report date
(`results.finalised_at`) as its printed date, and age / reference band / flag computation use that
same instant (`ResultDocumentInput.ageAsOf`, `calculateAgeMonths(birthdate, asOf)`), so a correction
made after a birthday can't move a patient into another age band. This changes single-test amends,
which printed the amend time. Raised with the owner alongside item 6.

### 3. Chemistry editing

- `amendConsolidatedReport({ resultId, expectedAmendmentCount, reason, values })`: gates as before
  (role has sections; every LIVE member finished, one visit, inside `sectionsForRole(role)`;
  reception `[]` denies); fast stale pre-check; allowed fields = params enabled by the live members'
  services ∪ params already holding a value on this result; ≥1 value; flags + crossings with
  `asOf = finalised_at`; each crossing mapped to the member whose service enables the param
  (fallback: anchor = first live member). Audit `result.amended` (+ `result.critical_value_detected`
  when alerts added, `result.critical_alert_withdrawn` when unacknowledged ones were removed).
- UI: "Edit results" on each card → `?edit=<resultId>#result-<id>`; values loaded through the
  signed-in client (the new policy); `ReportEditForm` = shared `ConsolidatedValuesTable` (extracted
  from the encoding form) pre-filled + required reason + hidden expected count; Save / Cancel; P0065
  shows a reload link.
- Edit-history panel per card, matching the single-test panel: v{seq+1} · when · who · reason, with
  "View replaced version (vN)" links and "Current version (vN)" [C-P3].

### 4. Single-test back-port [C3]

- `prepareStructured` (draft + finalise) refuses a result whose `finalised_at` is set — a finished
  structured result can only change through Edit. (Today the holder of a `result_uploaded` test can
  re-draft it outside any version check.) The single-test page shows Edit, not the entry form, for a
  finalised result.
- `amendStructuredResultAction` and `amendResultAction` go through `commitResultEdit`; the amend
  forms carry `expected_amendment_count`. The structured path keeps its inline document build, so
  the retained / replacement image is still embedded; both buckets' objects are this attempt's and
  are removed together on a definite rejection only. Structured path passes `p_alerts`; PDF-replace
  passes null. Template lookup gains `is_active`.
- History panel gains the version links.

### 5. Undo release and delete, for combined reports

- **Undo release is whole-report.** `undoReleaseSelectedAction` expands the selection to every
  released live member of any combined result it touches (result with >1 linked test), within the
  same visit, before the status-filtered UPDATE; each member gets its own `release_undone` audit row
  with `report_result_id`. The Undo dialog on a combined-report row says "This undoes the whole
  <group> report (N tests)". A partially released combined report (legacy) is undone as a whole.
- **Delete is blocked** for a member of a finished combined report (P0067 above); the visit page's
  delete affordance shows the hint "Part of a finished combined report (e.g. Chemistry) — it can’t
  be deleted on its own." via `testDeletability`.

### 6. Bundled items

1. Visit page: "Edited <date/time> — <reason>" under each result's View PDF (released) and on
   ready_for_release rows; one batched amendments query (signed-in client — reception gets none,
   which is correct). For a combined result the full note shows on its first member row; later
   members say "Edited — see <first test>".
2. Edit-history panel on chemistry cards (above).
3. Staff PDF route: comments corrected (serves any result with a stored PDF — staff review before
   release is intended). Adds `?version=N`: N ≤ amendment_count serves the amendment with seq N's
   `prior_storage_path`; gated by the same section check AND `staff_can_read_finished_result`
   semantics; audited with the version.
4. Results page pagination [C4]: trimming at page edges cannot be made correct (non-contiguous
   visits under non-default sorts, `q` post-filter), so the page DISCLOSES instead, precisely: the
   fold label uses each report's full membership ("Chemistry (8 tests)") from one batched junction
   count, and a report with members off this page says "— 3 more on another page"; a line above the
   pager says the page counts tests. Pure helper `reportMembershipOnPage` tested.
5. Local click-through on the chemistry page (view, edit, stale edit, undo, delete refusal) on the
   port-3017 recipe.
6. Owner questions (not built): patient "result updated" notice / "Amended" marker; the risk that a
   patient's downloaded PDF silently differs from the one on file; the printed-date rule in §2.

### 7. Validation

- vitest: pure helpers, pg-errors coverage (P0065–P0067), section-map parity, query-surfaces,
  deletion.test pin, rls-initplan.
- psql fixture on a freshly reset local stack: P0065 stale; two concurrent sessions (second blocks on
  the row lock, then P0065); attempt-id replay returns the first commit and writes nothing; P0066
  (unfinished member; no live member); deleted member ignored; status / released_at / released_by /
  release_medium unchanged; alerts (new crossing added; unacked withdrawn; acked kept; identical not
  duplicated; changed critical value re-pages); reads — non-owner in-section medtech sees values +
  history of a finished result, not of an in-progress one, not another section's (xray vs chemistry),
  reception sees neither; JWT writes to results / result_values / result_amendments refused; RPC not
  executable by anon/authenticated; P0067 on deleting a finished combined member; draft-vs-edit:
  `prepareStructured` refuses a finalised result.
- Smoke [C5]: `smoke:chemistry` queries columns that no longer exist (`unit_label`,
  `display_order`, `result_value_ranges`) and rebuilds its own document — repair it to render through
  `loadResultDocumentInput`, including the edit overrides (values, signer, control number, age date).
- Failure injection in the local click-through: forced RPC rejection (upload removed), forced
  "unknown" outcome after commit (object kept, page shows the committed edit on reload).
- Two reports in one visit: each card edits its own result.
- `npm test && npm run typecheck && npm run lint`; `npm run db:types` after the migration.

### 8. Deploy

Migration before app merge (Claude runs `db push --dry-run` then push from this worktree on current
main, verifies by object: policies, functions + ACLs, column, trigger body). Rollback: the migration
only adds a function/column/policies and narrows grants; reverting the app leaves committed PDFs and
history intact (old code reads `storage_path` + `result_amendments` the same way). If the JWT write
drops must be reverted, re-create the 0151 policies verbatim.

### 9. Recheck (Codex Astra high, same session) — revisions [R1]…[R6], supersede the text above

- [R1] `result_edit_commit` checks `attempt_id` AFTER taking the result row lock and BEFORE the stale
  check, and replay requires the same `result_id`. The TS core also re-queries `attempt_id` before
  removing anything on a "rejected" outcome, so a rejection of THIS call never deletes objects of an
  attempt that committed. Fixture: two overlapping calls with the same attempt id.
- [R2] Finalise is one atomic step too. New `result_finalise_commit(p_result_id, p_finaliser,
  p_values, p_storage_path, p_file_size_bytes, p_new_image, p_alerts)` (security definer,
  service_role only): locks the result, P0066 unless `finalised_at is null`, writes the values,
  `storage_path`, `file_size_bytes`, `finalised_at`, image columns and the initial alerts in one
  transaction (the status-flip trigger fires inside it). Both finalise paths render the PDF from the
  values they are about to write (no re-read), upload, then call it; the consolidated path releases
  afterwards as today. New `result_save_draft(p_result_id, p_values)`: locks the result, P0066 if
  finalised, upserts — `saveDraftAction` uses it. Drafts, finalise and edits therefore all serialise
  on the same row lock and a finished result's values can only change through
  `result_edit_commit`. Fixtures: draft after finalise → P0066; finalise twice → P0066; edit before
  finalise → P0066.
- [R3] One membership rule. Section check covers EVERY linked test, deleted ones included (a deleted
  test in another section still has values on the shared result); the finished-status check and
  "≥1 member" cover LIVE tests only. Same rule in `staff_can_read_finished_result`, in the edit
  action's gate, and in the PDF route's `?version`. The page asks
  `rpc("staff_can_read_finished_result")` through the signed-in client and shows no Edit button (and
  the action refuses) when it is false, so a form is never submitted over values the editor could not
  see. Fixture: non-owner medtech, live + deleted sibling.
- [R4] Whole-report undo: expand to ALL member ids of every combined result the selection touches,
  regardless of observed status; reject the whole request when any member is outside the caller's
  sections, is a package header, or sits on another visit; then the status-filtered UPDATE decides
  which are released. Fixtures: partial report, mixed-section report.
- [R5] Results page disclosure: "Chemistry (3 of 8 tests shown)" plus one line under the table:
  "A report's other tests may be on another page or outside this filter." No "another page" claim.
- [R6] The bulk bar and the row dialog both show the expanded scope (deduplicated) and the patient-
  view warning aggregated over every affected member; the server expansion stays authoritative.
- P0067 covered at every trigger depth (package cascade included); fixtures: package header delete
  whose component is on a finished combined report (whole delete rolls back), whole-visit delete and
  restore unaffected, P0042/P0043/P0044/P0050 unchanged. Rollback note: P0067 stays in the database
  if the app is reverted — old delete buttons would get the translated refusal.

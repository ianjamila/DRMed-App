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

## PR 2 — migration 0160+ (check the number against open PRs first; #211 holds 0159)

- **Read policy:** medtech/xray may SELECT `result_values` for results whose linked tests are all
  in an allowed section and past encoding (`result_uploaded | ready_for_release | released`).
- **Chemistry editing:** "Edit results" on each report card → consolidated form in amend mode,
  pre-filled, reason 5–2000 chars, carrying the `amendment_count` it loaded (stale-form check).
  Addressed by `result_id`; membership derived server-side; every member section-checked.
- **All-or-nothing save:** upload the new PDF to an immutable versioned path first, then one
  `security definer` Postgres function commits snapshot + values + `storage_path` + amendment
  metadata + alert changes, rejecting a stale version. On failure, delete only that attempt's
  uploaded file. Adopt the same core for single-test structured amends.
- **Critical alerts on amend:** insert new crossings, delete only unacknowledged alerts that no
  longer cross, never touch acknowledged ones. Back-port to single-test amend.
- **Status untouched:** an edit never changes any member's status, release time, releaser or medium.
- Signing medtech = the editor (owner decision), both paths.
- No patient-facing marker or notification (owner decision).
- Validation: stale editor, concurrent editors, failure at upload/commit, non-owner medtech prefill,
  mixed member statuses, critical transitions with acknowledged alerts, two reports in one visit.

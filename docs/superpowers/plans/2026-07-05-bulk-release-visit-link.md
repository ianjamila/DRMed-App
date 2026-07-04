# Bulk release/unrelease + queue visit link — Implementation Plan

> Spec: `docs/superpowers/specs/2026-07-05-bulk-release-visit-link-design.md`
> Branch: `feat/bulk-release-visit-link` (off main @ 1e8f137). Pause for user review
> after the PR and again before the 0110 prod push. Migration task ⚠ high effort.

Programme-plan conventions apply (§0.2 migration loop, §0.3 repo conventions of
`docs/superpowers/plans/2026-07-04-release-lifecycle-programme.md`). Remote history is
already repaired (0001..0109 clean); 0110 pushes via MCP `execute_sql` + manual
`schema_migrations` insert (`'0110'`).

### Task 1 ⚠: Migration `0110_undo_release.sql`

Exactly the programme plan's **Task 3.1** (function + trigger text verbatim; it was
written for PR 3 and is unchanged by being pulled forward). Local runbook steps 1–5
from Task 3.1 on a fresh `db reset`, plus: bulk-undo scenario — undo TWO components of
a released header in ONE statement ⇒ header flips back once, its JE reversed once,
second row's cascade is a no-op (idempotent), both component undos leave no JE debris.
`npm run db:types` (no-op expected), `npm test`, commit
`feat(db): undo-release trigger — JE reversal + package cascade (0110)`.

### Task 2: Queue Visit column

`src/app/(staff)/staff/(dashboard)/queue/page.tsx`: add `visitId` to
`QueueCardSingle`; new **Visit** `<th>`/`<td>` between Patient and Test on both row
kinds — `#<visitNumber>` → `/staff/visits/<visitId>` (patient-link classes); drop
`· Visit #NNNN` from the Patient sub-line. Typecheck/build. Commit
`feat(queue): visit column with quick link`.

### Task 3: Bulk server actions

`visits/[id]/actions.ts`, below `releaseAllReadyComponentsAction`, both mirroring its
hardening (section scoping via `sectionsForRole`, `.in("id")` + visit/status filters,
affected-row check, per-row audit, `translatePgError`, revalidate incl. error paths):

- `releaseSelectedAction(visitId, testRequestIds, medium)` — pre-SELECT candidate rows
  (`.in(id)`, same visit, `status='ready_for_release'`, `is_package_header=false`,
  `services!inner(section, name)` for scoping + names); UPDATE the scoped ids to
  released; audit per row (`test_request.released`, `bulk:true, selection:true`);
  notification: 1 row ⇒ `notifyResultReleased`, >1 ⇒ `notifyResultsReleasedBulk`;
  reportError on notify throw.
- `undoReleaseSelectedAction(visitId, testRequestIds, reason)` — reason
  required/trimmed; pre-SELECT (`status='released'`, non-header, section-scoped,
  capture `release_medium`, `released_at`); UPDATE to `ready_for_release` nulling
  released_* fields (0110 does the accounting + header cascade); audit per row
  (`test_request.release_undone`, metadata `{visit_id, reason, prior_release_medium,
  prior_released_at, bulk:true}`); NO notification.

Vitest for any extracted pure helpers only; typecheck. Commit
`feat(release): bulk-selection release + undo-release server actions`.

### Task 4: Bulk-select UI

- `visits/[id]/selection-context.tsx` (client): provider + `useRowSelection()`;
  provider wraps the Tests section in `page.tsx` (server children pass through).
- `visits/[id]/row-select-checkbox.tsx` (client): props `{ testRequestId,
  eligibility: "release" | "unrelease" }`; renders in a new leading cell on component
  rows and standalone rows (ready ⇒ release-eligible, released ⇒ unrelease-eligible,
  else no checkbox); never on headers; sr-only label per row.
- `visits/[id]/bulk-action-bar.tsx` (client): fixed bottom bar when ≥1 selected —
  `Release selected (N)` + medium select (gated disabled + title when `!paid` /
  consent-block, same semantics as `ReleaseAllButton`), `Unrelease selected (M)` +
  required reason input (inline error "Reason is required."), Clear selection.
  Calls the Task 3 actions; `alert(result.error)` on failure; clears selection and
  lets revalidation refresh rows on success.
- Table grammar: new narrow first column (checkbox) on the component table AND
  standalone table (+ sr-only `<th>`s); headers/consult rows render an empty cell.
  Reception continues to see no test rows (gate untouched).
- Typecheck/build. Commit `feat(visits): bulk select with release/unrelease toolbar`.

### Task 5: Smokes (local stack + Playwright)

Queue: Visit column links to the visit page (desktop + 390px, no body overflow).
Visit page: mixed selection counts; release-selected of 2 components + 1 standalone ⇒
one consolidated notification row, header auto-release when last component included;
unrelease-selected with shared reason ⇒ rows back to ready, header cascaded back,
JEs reversed (DB assert), audit rows carry the reason; re-release ⇒ fresh JE;
unpaid visit ⇒ release button disabled with title; reason blank ⇒ inline error.

### Task 6: Wrap-up

`npm test && npm run typecheck && npm run build`; push; PR
`feat: bulk release/unrelease + queue visit link`. **PAUSE — user review.**
After merge + explicit user OK: apply 0110 via MCP + `schema_migrations` insert
(`'0110'`), verify functiondef + trigger + history. **PAUSE before the push.**

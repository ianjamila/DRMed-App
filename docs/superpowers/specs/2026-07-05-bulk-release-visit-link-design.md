# Bulk release/unrelease + queue visit link — Design

**Date:** 2026-07-05 · **Approved by:** Ian (chat) · **Follows:** release-lifecycle PR 2 (#103, merged; 0109 live on prod)

## Goal

1. **Queue page** (`/staff/queue`, all filters): a dedicated **Visit** column linking each row to its visit page.
2. **Visit page**: **bulk select** across test rows with two actions — **Release selected** and **Unrelease selected** — which requires pulling migration **0110** (undo-release trigger) forward from PR 3.

## Decisions (user-approved)

- Pull **0110** forward now so unrelease works end-to-end; PR 3 later shrinks to the per-row undo dialog polish, viewed-count warning, and the admin undone-releases report.
- Bulk undo takes **one shared reason** applied to every selected row's audit entry.
- UI approach: thin client **selection context provider** wrapping the existing server-rendered Tests section (no restructure of the PR 2 layout); checkbox per row + floating action toolbar are the only client additions.

## Feature 1 — Queue Visit column

- New column between Patient and Test: `#<visit_number>` → `/staff/visits/<visit_id>`, patient-link styling.
- The `DRM-ID · Visit #NNNN` sub-line in the Patient cell drops the now-redundant `· Visit #NNNN`.
- `QueueCardSingle` gains `visitId` (grouped cards already carry it); no query changes.

## Feature 2 — Migration 0110 (verbatim from programme plan Task 3.1)

`fn_undo_release_bridge` + `tg_undo_release_bridge` on `released → ready_for_release`:
reverse the posted JE (0064 reversal pattern), soft-void open `doctor_pf_entries` /
`cogs_send_out_entries` with `void_reason='release_undone'`, and cascade a component
undo to its header (clear `package_completed_at`; if header released, flip it back —
which re-fires the trigger for the header's own JE reversal; system audit row marks
the cascade). Local runbook per plan Task 3.1 (5 scenarios incl. re-release ⇒ fresh JE,
`journal_entries_one_posted_per_source` intact). Prod push is a separate user-gated step.

## Feature 3 — Bulk select on the visit page

- **Selection provider** (client) wraps the Tests section; per-row `RowSelectCheckbox`
  (client) registers `{ id, kind: eligible-for-release | eligible-for-unrelease }`.
  Checkboxes render on component + standalone rows the role already sees; never on
  package headers.
- **Floating toolbar** when ≥1 selected: `Release selected (N)` (medium dropdown; same
  disabled/title gating as existing release buttons for unpaid/consent) and
  `Unrelease selected (M)` (required shared-reason input). Mixed selections fine —
  each button counts only its eligible subset.
- **Server actions** (both mirror `releaseAllReadyComponentsAction` hardening —
  visit/status-filtered UPDATE, `.in(id)`, `sectionsForRole` scoping, affected-row
  check, audit row per test, `translatePgError`, revalidate):
  - `releaseSelectedAction(visitId, testRequestIds, medium)`: only
    `ready_for_release` non-header rows; N>1 ⇒ ONE consolidated notification
    (`notifyResultsReleasedBulk`), N=1 ⇒ per-test `notifyResultReleased`.
  - `undoReleaseSelectedAction(visitId, testRequestIds, reason)`: trimmed reason
    required; only `released` non-header rows; pre-SELECT captures prior
    `release_medium`/`released_at` for audit metadata; action
    `test_request.release_undone` with shared reason; **no notification** (results
    are being withdrawn). 0110 handles JE reversal + header cascade.
- Headers follow automatically both directions (0109 Leg A up, 0110 cascade down).

## Out of scope (stays in slimmed PR 3)

Per-row undo dialog, viewed-count union + warning, download-metadata normalization,
admin undone-releases report.

## Verification

0110 runbook on fresh local reset; vitest/typecheck/build; Playwright smoke: queue
Visit link, mixed bulk select, release-selected (consolidated notification row),
unrelease-selected with reason (JE reversed, header cascade), re-release, 390px.

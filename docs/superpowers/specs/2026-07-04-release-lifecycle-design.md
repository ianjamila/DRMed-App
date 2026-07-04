# Release lifecycle — package release, queue visibility, undo release

**Date:** 2026-07-04
**Status:** Approved design, pending implementation
**Origin:** Sample Visit #0037 bug hunt (ROUTINE PACKAGE stuck at `ready_for_release`; released NA test invisible in reception Queue) + follow-up feature request (undo release).

## Context — verified findings

Visit #0037 (paid, ₱2,204/₱2,204) contains a ROUTINE PACKAGE header +
3 components (FBS/RBS, Urinalysis, CBC + PC), all stuck at
`ready_for_release`, plus a standalone NA (Sodium) test released by a
medtech. Root causes, confirmed against code and the live DB:

1. **Package release was never wired up.** Standalone tests get a
   `ReleaseButton` on the visit page; package components render as a
   read-only list, headers as a read-only card. No trigger auto-releases
   anything — the queue page's claim that "the header releases
   automatically" (`queue/[id]/page.tsx`) describes a trigger that does
   not exist. Migrations 0040/0042 only stamp `package_completed_at`.
2. **Reception Queue (`/staff/visits/queue`) shows only Outstanding
   tests** on Processing rows; already-released tests are invisible.
3. (Feature) **No way to undo a release.** Corrections to result
   *content* go through the existing Amendment flow; there is no path
   for "released by mistake / wrong medium / prematurely".

Key machinery that shapes the design (all pre-existing):

- `bridge_test_request_released` (0064) books a JE (revenue; PF accrual
  for consults; COGS for send-outs) on any transition **to**
  `released`. **Idempotency guard:** skips if a *posted* JE exists for
  the test_request.
- `bridge_test_request_cancelled` (0064) is the canonical "undo the
  accounting" pattern for released→cancelled: mirrored reversal JE,
  original marked `reversed`, PF/COGS subledger rows soft-voided with
  a reason. `journal_entries_one_posted_per_source` excludes
  `source_kind='reversal'` rows.
- Payment gate (0001) and consent gate (0086) fire only on transitions
  **to** `released` — they re-apply automatically on re-release.
- Patient portal RLS shows `status = 'released'` only → an undone
  result disappears from the portal instantly, no extra work.
- `test_requests` UPDATE RLS: medtech/pathologist (+ admin path).
  "Anyone who can release" == this existing gate; no new role logic.
- Patient access is audit-logged (`result.downloaded`, plus the signed
  URL access-intent action) → powers the "patient already saw this"
  warning.

## Feature 1 — Package release (per-component + auto header)

**UI** (`visits/[id]/page.tsx`): in each package card's component list,
render the existing `ReleaseButton` for any component at
`ready_for_release`. Reuses `releaseTestAction` unchanged (it releases
one test_request by id and already honors payment gate, consent gate,
and section visibility). No release button on the header itself — the
header follows the components.

**"Release all ready" bulk button** on the package card header row,
shown when ≥ 2 components are at `ready_for_release` (a single ready
component just shows its own button). One medium select shared by the
bulk action (defaulting to the patient's preferred medium, same as
`ReleaseButton`). New server action
`releaseAllReadyComponentsAction(headerId, visitId, medium)`:

- `requireActiveStaff`; verify the header row (`is_package_header`,
  belongs to `visitId`).
- Single user-scoped UPDATE: all rows `parent_id = headerId AND
  status = 'ready_for_release'` → `released` (+ released_at/by/medium).
  Per-row payment/consent triggers still enforce the gates —
  `translatePgError` on rejection.
- One `audit()` row per released component (matching the per-release
  convention) with `metadata.bulk: true`, plus `notifyResultReleased`
  per component (fire-and-forget, as in `releaseTestAction`).
- Disabled/blocked states mirror `ReleaseButton` (unpaid, consent gate).
- The header then auto-releases via the new trigger (all components
  terminal in one statement — Leg A must tolerate same-statement
  sibling updates; the count-pending check already does).

**Migration — header auto-release trigger** (two legs, mirroring the
0040/0042 two-leg precedent for unspecified AFTER-trigger ordering):

- Leg A (on component status change): when a component reaches a
  terminal status, if ALL siblings are terminal, **≥ 1 is `released`**,
  and the parent visit is paid/waived, flip the header
  `ready_for_release → released` (`release_medium = 'other'`,
  `released_by` null-safe via `auth.uid()`).
- Leg B (on visit payment_status change to paid/waived): same check for
  any headers on the visit whose components are already all-terminal.
- A fully-cancelled package (0 released components) must NOT release —
  the existing cascade-cancel trigger (0040) owns that path.
- Header release then flows through the existing stack: payment-gate
  trigger passes, `bridge_test_request_released` books the package
  revenue JE (headers carry the price; components are ₱0),
  0042 stamps `package_completed_at`.

## Feature 2 — Released column in reception Queue

`/staff/visits/queue`: add `releasedLabImagingNames()` to
`src/lib/visits/queue-stage.ts` (mirror of
`outstandingLabImagingNames`, filtering terminal `released` leaf
lab/imaging tests) with unit tests alongside the existing ones. Render
a **Released** summary in Processing rows (desktop table + mobile
cards), same up-to-3-names-then-"+N more" presentation as Outstanding.

## Feature 3 — Undo release (with reason) + re-release

### Decisions (user-confirmed)

- **Who:** anyone who can release — `requireActiveStaff` + existing
  `test_requests` UPDATE RLS. No new role gate.
- **Packages:** undoing a component after the header released
  **cascades** — header reverts to `ready_for_release` (with its own
  accounting reversal) and `package_completed_at` clears. Header
  auto-re-releases later via Feature 1 when the component re-releases.
- **Time limit:** none. The confirmation dialog warns loudly when the
  audit log shows the patient already viewed/downloaded the result.

### UI

On the visit page's Action column for `status === 'released'`, add an
**Undo** link next to "Released ✓" (and the same affordance for
released consultation lines — undo reverses their PF accrual too).
Clicking opens a confirmation dialog modeled on `VoidPaymentDialog`:

- States plainly: result will be pulled from the patient portal; the
  release accounting will be reversed; re-releasing later is allowed.
- **Required reason** textarea (submit disabled while blank), matching
  the void-payment pattern.
- If the audit log shows patient access for this test_request's result
  (`result.downloaded` / access-intent actions), show a prominent
  amber warning: "Patient has already viewed/downloaded this result
  N time(s) — undoing does not un-see it." The page (server component)
  fetches this count and passes it down; no client-side audit query.

### Server action

`undoReleaseAction(testRequestId, visitId, reason)` in
`visits/[id]/actions.ts`:

1. Validate reason non-empty (trimmed). `requireActiveStaff`.
2. Guard: target must currently be `released`; must not be a package
   header (headers follow components — undoing a header directly is
   not offered; undo the component(s) instead). Cancelled/other
   statuses → friendly error.
3. Update via the user-scoped client (RLS enforced):
   `status = 'ready_for_release'`, `released_at/released_by/
   release_medium = null`.
4. `audit()` row: `action: 'test_request.release_undone'`, metadata
   `{ visit_id, reason, prior_release_medium, prior_released_at }`.
5. `translatePgError` on failure; `revalidatePath` on success.
6. Return `{ ok } | { ok:false, error }` per convention.

After undo the row sits at `ready_for_release`, so the existing
`ReleaseButton` reappears automatically — **re-release needs zero new
code.** Re-release re-fires the payment/consent gates, books a fresh JE
(original is `reversed`, so the idempotency guard passes), and
re-notifies the patient via `notifyResultReleased`.

### Migration — undo-release trigger

New trigger on `test_requests` for the `released → ready_for_release`
transition (no other code path produces it today):

1. **Accounting reversal** — same body as
   `bridge_test_request_cancelled`: find the posted JE for this
   test_request (FOR UPDATE), insert a posted reversal JE
   (`source_kind='reversal'`, `reverses = original`), swap
   debit/credit lines 1:1, mark the original `reversed`; soft-void open
   `doctor_pf_entries` and `cogs_send_out_entries` with
   `void_reason = 'release_undone'`. Defensive no-JE case handled the
   same way (void subledger rows only). Extract the shared body into a
   common function if the diff stays readable; otherwise duplicate with
   a header comment cross-referencing 0064 — reviewer's choice at
   implementation time.
2. **Package cascade** — if the row has a `parent_id`:
   clear the header's `package_completed_at`; if the header is
   `released`, flip it to `ready_for_release` and null its
   `released_at/by/medium`. That header update re-fires this same
   trigger for the header's own JE reversal (recursion terminates:
   headers have no parent). The trigger inserts an
   `actor_type: 'system'` audit row for the cascaded header undo
   (matching the suspense-post audit precedent in 0064), so the human
   reason lives on the component's audit row and the cascade is still
   traceable.
3. `fn_set_package_completed_at` (0040) has an `IS NULL` re-stamp
   guard; since the cascade nulls the stamp, re-completion re-stamps
   correctly.

### Explicitly out of scope

- Undoing a package **header** directly (undo components instead).
- Notifying the patient that a result was withdrawn.
- Undo for cancelled tests (cancellation reversal already exists).

## Feature 4 — Harmonized visit-page layout (packages + singles)

**Decision (user-confirmed): harmonized two sections** — keep package
cards and the singles table as distinct surfaces, but make them read as
one system. Currently the package card is a loose sub-list while
singles get a full billing table; with both on a visit (e.g. #0037) the
page reads as two unrelated widgets.

Changes to `visits/[id]/page.tsx`:

- Explicit section headings under "Tests": **Packages** and
  **Individual tests** (each shown only when non-empty; the existing
  "No standalone tests on this visit." empty-state copy stays).
- Component rows inside the package card adopt the table's visual
  grammar: same row height/padding, columns aligned to the table's
  Service / Status / Action rhythm, status badge in the same position,
  and a right-aligned **Action** cell rendering the same `TestAction`
  component the table uses (Release / Awaiting claim / Awaiting
  sign-off / Released ✓ + Undo + PDF). Components show "—" where the
  table shows Base/Discount/Final (they are ₱0 lines; the package price
  lives on the header row, unchanged).
- The header row of the card gains the "Release all ready" control
  (Feature 1) on the right, mirroring where the table puts actions.
- Mobile: component rows stack the same way the table's responsive
  behavior does — no divergent mobile treatment for packages.
- Reuse `TestAction` rather than duplicating per-status rendering; if
  its props need a `compact` variant for card rows, add the variant
  rather than forking the component.

## Feature 5 — Admin report: undone releases

New admin-only page `staff/admin/reports/undone-releases` (sibling of
the existing `admin/reports/lab-tat`), for RA 10173-flavored oversight
of release withdrawals.

- Gate: `requireAdminStaff`. Reads `audit_log` via the admin client in
  a server component (audit rows are service-role-written; precedent:
  existing admin report pages).
- Source rows: `action = 'test_request.release_undone'` (staff undos,
  reason in metadata) and the `actor_type = 'system'` cascade rows for
  package headers.
- Columns: when (Manila), patient (name + DRM-ID), visit #, test
  (service name/code), undone by (staff name), reason, and **current
  outcome** — re-released (with date) / still unreleased / cancelled,
  resolved by joining the test_request's current status +
  `released_at`.
- Filter: date range, default last 90 days. No pagination gymnastics —
  cap at 500 rows with a "narrow the range" notice (matches the
  simple-report precedent).
- No migration needed; the audit trail already carries everything.

## Invariants preserved

- Payment gate and consent gate remain DB-enforced on every (re-)release.
- Books always match status: `released` ⇔ posted JE; undone ⇔ reversed
  JE + reversal; re-released ⇔ fresh posted JE. No path leaks a posted
  JE for an unreleased test (the flaw that ruled out status-only undo).
- Every state change audit-logged with actor + reason (RA 10173).
- Patient portal visibility derives purely from RLS on `status`.

## Testing

- Unit: `queue-stage` released-names helper (vitest, alongside
  existing tests).
- Migration tests against local Supabase (`supabase start` +
  `db:reset`), exercising: full package release flow (components →
  header auto-release → `package_completed_at`); bulk release (one
  statement releases all ready components, header follows, gates still
  reject when unpaid); undo standalone (JE reversed, PF/COGS voided);
  undo component under released header (cascade, both JEs reversed,
  stamp cleared); re-release (fresh JE, single posted JE per source);
  fully-cancelled package does not auto-release; undo blocked for
  non-released rows.
- Manual smoke on visit #0037's shape via seeded local data, including
  the harmonized layout with a package + released standalone together.

## Rollout order

1. Feature 2 (no migration, independently shippable).
2. Feature 1 + Feature 4 (one PR: migration for header auto-release,
   plus the harmonized layout + per-component and bulk release UI —
   they touch the same package card) — unblocks #0037.
3. Feature 3 (migration: undo trigger + undo UI) — depends on
   Feature 1 for the cascaded-header re-release story.
4. Feature 5 (admin undone-releases report) — depends on Feature 3's
   audit rows existing.

Schema-change workflow per CLAUDE.md: local diff → local test → PR →
staging → prod; `npm run db:types` after each migration.

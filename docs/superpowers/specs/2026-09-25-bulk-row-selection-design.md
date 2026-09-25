# Bulk row selection on staff lists — design

**Date:** 2026-09-25 · **Branch:** `feat/bulk-select` · **Migration:** none
**Revision 2** — after a Codex (Astra, high) plan review; §4–§8 rewritten where the review
found the first draft contradicted the code (queue delete is per-visit, the inbox action
has no source-status guard, chemistry cards fold after paging, search params do not
remount a provider, the delete audit read rows before deleting, unclaim is all-or-nothing).

## 1. Problem

Staff lists let you act on one row at a time. On `/staff/appointments` a receptionist
marking a morning's bookings arrived, or an admin clearing a week of stale test
bookings, clicks the same button on every row and confirms every dialog. The lab queue
and the Website Messages inbox have the same shape.

The app already has two multi-select implementations that work well and should not be
rebuilt: the visit page's Tests section (`visits/[id]/{selection-context,
row-select-checkbox, bulk-action-bar}.tsx`, cap in `src/lib/visits/bulk-selection.ts`)
and the three HMO-claims surfaces (`hmo-claims-client.tsx`,
`[providerId]/provider-detail-client.tsx`, `batches/new/new-batch-client.tsx`).

## 2. Survey — where multi-select pays off

| Rank | List | Today | Bulk value | Server work |
|---|---|---|---|---|
| 1 | **Appointments** `/staff/appointments` (reception + admin) | per-row Mark arrived / No-show / Cancel / Confirm / Revert / Delete | High — many bookings per day | Small: the five actions in `appointments/actions.ts` already take `ReadonlyArray<string>`; they gain a changed-ids result and a server cap |
| 2 | **Lab queue** `/staff/queue` (medtech, x-ray tech, pathologist, admin — reception only sees Released today there) | per-row Claim (single id), Unclaim (array, called with one), Delete (array, one visit) | High — a bench claims a batch of samples at once | New `claimTestsAction`, `unclaimTestsAction`, cross-visit `deleteTestRequestsManyAction` |
| 3 | **Website Messages** `/staff/messages` (reception + admin) | no row buttons; status changes only on the detail page | Medium — inbox triage ("close these five") | New `updateMessageStatusManyAction` with a source-status guard |
| — | Visit page tests, HMO claims | already bulk | — | — |
| later | Reception Queue `/staff/visits/queue` (visit-level delete), OT slips approve, payroll run "mark paid", critical alerts acknowledge, gift codes cancel | single-id actions | Periodic / lower volume | New array actions each; same kit |
| skip | Patients, staff users, services, inventory, physicians, HMO providers, AP lists, ledger/report lists | link-only rows | Edit-one-at-a-time is the natural workflow | — |

Closures already has a bulk reschedule scoped to "all bookings on the closure date";
PF payouts' "Bulk payout" acts on all active physicians. Neither needs checkboxes.

**Scope of this design:** a shared selection kit plus ranks 1–3, as three PRs in that
order. The "later" row is listed so the owner can pull any of them forward.

## 3. Approaches considered

1. **Generalise the visit-page kit into a shared component set, wire it page by page
   (recommended).** The visit page's pattern (client Context provider wrapping
   server-rendered `<tr>`s, a checkbox island per row, a sticky bar) is the right shape
   for RSC list pages and already survived review. Making it generic costs one file
   move; each list then adds a checkbox column and a page-specific bar.
2. Copy the visit-page files into each list. Fastest per page, but three near-identical
   contexts to keep in sync (the HMO pages already show the drift this causes).
3. Convert each list page to a client component with `useState<Set>` like HMO claims.
   Throws away server rendering and paging on the two busiest pages. Rejected.

## 4. Shared kit — `src/components/staff/row-selection/`

Generic version of the visit-page files. A selected **row** has an opaque string key, a
list of **kinds** (what the bar may do with it — a queue row can be both `unclaimable`
and `deletable`), and a **weight** (how many underlying records it expands to — a booking
with six services weighs 6; most rows weigh 1). The visit page keeps its own files in
PR 1 (it is the release path and needs no change); migrating it to the kit is a
follow-up.

```ts
// src/lib/ui/bulk-selection.ts (pure, unit-tested)
export const MAX_BULK_ROWS = 100;        // selected rows per action
export const MAX_BULK_RECORDS = 500;     // deduplicated underlying record ids per action
export type SelectionEntry = { rowKey: string; kinds: readonly string[]; weight: number };
export type SelectionState = Map<string, SelectionEntry>;
export function addEntries(state, entries, limits): { next: SelectionState; refused: string[] }
//   adds in order, stops before the first entry that would exceed EITHER limit — never
//   splits a row; returns the same Map reference when nothing changed
export function removeKeys(state, keys): SelectionState
export function keysByKind(state): Record<string, string[]>
export function selectAllState(entries, state): "none" | "some" | "all"
export function canAdd(state, entry, limits): boolean

// selection-context.tsx ("use client")
<SelectionProvider resetKey={string}>  — wraps the reducer above in Context; `resetKey` is
//   applied as the React key of the inner provider, so the page hands it a normalised
//   string of every list parameter that changes the row set or its order (view, type,
//   sort, dir, page, size, q, source…) and the selection drops when any of them changes.
//   Search-param navigation does NOT remount client components by itself (Next.js
//   template docs) — the key is the mechanism, not an assumption.
useRowSelection(): { isSelected, toggle(entry), setMany(entries, selected), clear,
//   clearKeys(keys), keysByKind, count, records /* summed weight */, canAdd(entry) }
// row-select-checkbox.tsx — <RowSelectCheckbox rowKey kinds weight label />: native input in a
//   44px <label>; disabled with title "You can select up to N rows at a time" when canAdd is
//   false; an effect keyed on (rowKey, kinds.join(), weight) prunes the key on unmount AND
//   when its kinds/weight change after a refresh (the reference checkbox's eligibility rule),
//   so a row that changed under the operator is never acted on under its old kinds.
// select-all-checkbox.tsx — <SelectAllCheckbox entries label />: header cell over the rows this
//   table renders on this page; checked at "all", `indeterminate` (ref) at "some"; clicking at
//   "all" removes them, otherwise adds via setMany, which stops at the caps (the bar then says
//   "Selected the first N — limit reached").
// bulk-bar.tsx — <BulkBar count onClear>{actions}</BulkBar>: the sticky bottom Panel
//   (visit-page/HMO styling), "N selected · Clear", returns null at count 0. Escape clears the
//   selection only while no dialog/sheet is open (`document.querySelector('[role="dialog"]')`
//   is null) and the event target is not a text field.
```

**Tests.** Vitest runs in Node with static rendering, so effects, refs and keyboard events
cannot be exercised there. The reducer and `selectAllState` are pure and fully unit-tested
(`bulk-selection.test.ts`: add/refuse at each cap, never splits a row, same-reference
bail-out, remove keeps the rest, mixed kinds). Component behaviour (unmount prune,
indeterminate, Escape, sticky bar, 390px) is verified per PR by a browser acceptance
checklist run against the local stack (§9).

## 5. PR 1 — Appointments

**Selection unit = one table row = one booking group** (`ApptGroup`: `key` =
`booking_group_id ?? id`, `rows` = the appointments). Entry: `rowKey = group.key`,
`kinds = [lead.status]`, `weight = rows.length`. Completed groups render no checkbox (an
empty cell) — nothing acts on `completed`.

**Page wiring** (`appointments/page.tsx`): one `SelectionProvider` wraps both the grouped
view (four `Section`s) and the flat view, `resetKey` = the normalised list params (`view`,
`type`, `sort`, `dir`, `page`, `size`, `q`, `source`, `date` — whatever the page reads).
Each table gets a leading column: `SelectAllCheckbox` in the header (entries = that
table's selectable groups) and `RowSelectCheckbox` as the first `<td>` of `GroupRow`
(label = patient/walk-in name + "n services"). Empty-state `colSpan` grows by one
(7 grouped, 9 flat).

The bar needs data the context does not hold, so the page passes a serialisable
`groupsByKey: Record<key, { ids: string[]; status: string; patientActive: boolean }>` to
`AppointmentsBulkBar` (client), rendered last inside the provider.

**Bar actions** — each button acts on the eligible subset of the selection and shows the
number of **bookings** it will touch; a button with count 0 is hidden. Eligibility
mirrors `ALLOWED_FROM` in `appointments/actions.ts` and the per-row `patientActive`
gate, computed by a pure helper:

```ts
// src/lib/appointments/bulk-eligibility.ts (unit-tested for every status × gate × role)
bulkActionPlan(groups: { key, status, patientActive }[], isAdmin) →
  Record<"arrive"|"noShow"|"cancel"|"confirm"|"revert"|"delete", { keys: string[]; skippedInactive: number }>
```

| Button | Eligible statuses | Extra gate | Confirm |
|---|---|---|---|
| Mark arrived (n) | confirmed | patientActive | none (same as row) |
| No-show (n) | confirmed | — | yes, with count |
| Cancel (n) | confirmed, arrived, pending_callback | — | yes, with count |
| Confirm (n) | pending_callback | patientActive | none |
| Revert to confirmed (n) | arrived, no_show, cancelled | patientActive | yes, with count |
| Delete (n) | confirmed, arrived, no_show, cancelled, pending_callback | admin only | yes, with count, red |

Groups whose patient record is deleted/merged are excluded from arrive/confirm/revert and
the bar shows "n skipped — patient record deleted", the reason the row hides those
buttons today. The server keeps `assertAppointmentsPatientsActive` as an all-or-nothing
check: if a patient goes inactive between selection and click, the whole batch is
refused with its existing message and nothing is written (browser check in §9).

**Server actions** (`appointments/actions.ts`, additive, `TransitionButtons` unchanged):

- `ApptResult` success becomes `{ ok: true; changedIds: string[] }` — the appointment ids
  the write actually returned. `transitionGroup` already selects them; the bar maps them
  back to bookings: a booking is *changed* when every id came back, *partly changed* when
  some did, *unchanged* otherwise. Message: "Marked 3 of 5 bookings arrived; 1 partly
  changed — open it to check; 1 had already changed". Partly-changed keys stay selected.
- `deleteAppointmentAction(ids, opts?: { allowedStatuses?: string[] })`: deletes with
  `.delete().in("id", ids).select("id, patient_id, status, scheduled_at")` and audits
  **only the returned rows** (today it audits a pre-read, so two admins deleting
  overlapping selections can audit rows they did not delete). The bulk bar passes
  `allowedStatuses` = the non-completed set, so a booking that completes between
  selection and click is not deleted; the single-row button passes nothing and keeps
  today's behaviour. Audit metadata keeps `group_appointment_ids` (the booking's actual
  siblings, from the page's group) separate from a new `bulk_batch_size` (ids in this call).
- Both reject `ids.length > MAX_BULK_RECORDS` (500) before any query; the client never
  builds such a batch because the kit bounds records, but the server does not trust it.
- Audit rows stay one per appointment. `metadata.bulk_batch_size` is added when > 1 row
  key was involved so a trail can tell a sweep from a click.

**After an action:** `clearKeys(fullyChangedKeys)` then `router.refresh()` (what
`TransitionButtons` does; the action's `revalidatePath` covers other tabs). Errors use
`alert()` like every sibling on this page.

**User guide:** §3 Appointments (the section holding the Row actions list) — new "Act on
several bookings at once" step after the Mark arrived step; Row actions `<dt>` gains
"tick boxes → bottom bar"; version bump.

## 6. PR 2 — Lab queue (`/staff/queue`)

**Who:** medtech, xray_technician, pathologist, admin. Reception is redirected to
"Released today" on this page and gets no checkboxes; its own worklist
(`/staff/visits/queue`) is a later item.

**Selection unit = a single-test card** (`kind: "single"` in the page's card model).
Grouped chemistry cards (`kind: "grouped"`, `cardKey` + `memberIds`) render **no
checkbox** in PR 2: paging happens before the fold, so a visible card can hold part of a
panel, and `claimConsolidated` audits one grouped row — neither fits a "visible rows
only, one audit row per record" contract. The card keeps its Open link; the bar's
subtitle says "Chemistry panels are claimed from their own page." Bulk over panels is a
follow-up with its own identity rule.

Entry: `rowKey = testRequestId`, `weight = 1`, `kinds` computed server-side by the page
from the same predicates that decide which buttons the card shows today:
`claimable` (Claim shown), `unclaimable` (Unclaim shown), `deletable` (delete control
shown). `rowsByKey: Record<id, { visitId; label }>` goes to the bar.

Bar: **Claim (n)** · **Unclaim (n)** (inline optional-reason field, matching
`QueueUnclaimSchema` where `reason` is optional) · **Delete (n)** (inline required-reason
field and a red confirm, the wording of `QueueDeleteDialog`). Each acts on its kind's keys.

**Server actions** — all return `{ ok: true; changedIds: string[]; skipped: { id: string;
reason: string }[] } | { ok: false; error }`, cap 100 ids (`MAX_BULK_SELECTION`), one
audit row per changed record, `revalidatePath("/staff/queue")` plus each touched
`/staff/queue/[id]` and (for delete) each touched visit page:

- `claimTestsAction(ids)` in `queue/actions.ts`. Extract the per-request gate of
  `claimTestAction` (deleted visit, package header, payment/HMO gate, section scope,
  x-ray gate, already claimed) into `evaluateClaim(row, session)`, used by both. Per id:
  evaluate → write with the same ownership predicate the single action uses
  (`assigned_to is null` / status guard) → a write that returns no row is skipped as
  "claimed by someone else just now". Atomicity: per row; one skip never blocks the rest.
- `unclaimTestsAction({ testRequestIds, reason })`. `performUnclaim` today refuses the
  whole batch if any id fails preflight and, after a partial race, audits the successes
  but returns only an error. Refactor it to evaluate per row (deleted, not yours unless
  admin, wrong status) and write per row with the ownership predicate, returning
  `changedIds` + `skipped`. The existing single-id and array callers keep their `ok |
  error` shape by wrapping the new result (error when nothing changed).
- `deleteTestRequestsManyAction({ testRequestIds, reason })` in
  `src/lib/actions/visits/queue-deletion.ts`: reads the candidates' `visit_id` with the
  admin client (no role trust — the per-visit path re-checks everything), groups by
  visit, calls the existing per-visit delete for each group, and aggregates. A refused
  group (0125 guard, HMO claim P0050, paid visit) is reported as skipped with the
  translated message; other groups still complete. Each visit gets its own revalidate.

Guide: §4.2 The queue — bulk claim/unclaim/delete paragraph; note that panels are claimed
from their page.

## 7. PR 3 — Website Messages inbox

Key = message id, `kinds = [status]`, `weight = 1`. The inbox table gets the checkbox
column; the bar offers exactly the transitions `message-actions.tsx` offers per source
status, each as "Mark <status> (n)" over the eligible subset:

| From | Allowed targets (per the detail page) |
|---|---|
| new | replied, closed |
| replied | closed, new |
| booked | closed |
| closed | new |

The implementer copies the matrix from `message-actions.tsx` into
`src/lib/contact-messages/status-transitions.ts` (pure, unit-tested) and the detail page
reads it too, so the two cannot drift.

New `updateMessageStatusManyAction(entries: { id, from }[], to)`: role check once; for
each `from` group one write `update({ status: to }).in("id", ids).eq("status", from)
.select("id")` — the `eq("status", from)` is the concurrency guard the single action
lacks (it reads then updates by id alone, so a message booked between selection and
click would be overwritten). Only returned ids are changed and audited (`from → to`);
the rest are skipped as "changed since you selected it". Cap 100. Revalidate the inbox,
each changed message page and the layout (sidebar "new" badge). Returns `changedIds` +
`skipped`.

Guide: §3.11 Website Messages — one paragraph.

## 8. Error handling and edge cases (all PRs)

- **Units.** The bar counts rows (bookings / tests / messages). Results are reported in
  the same unit; a partly changed multi-service booking is called out separately (§5).
- Selection outlives a row: revalidation removes or changes the row → checkbox unmounts
  or its kinds change → key pruned.
- Two staff act on the same rows: every bulk write carries a status/ownership predicate,
  so the second batch is partial and reported as such — never silent, never an overwrite.
- Caps: rows (100) and records (500) on the client; each server action enforces its own
  cap and rejects oversize batches before any query.
- Role gates stay server-side and unchanged; nothing in the kit grants anything.
- Mobile (390px): the checkbox cell is a 44px `<label>`; the bar wraps its buttons.
- Keyboard: native checkboxes; Escape clears (no open dialog, not in a text field).
- **Rollback.** Reverting the code does not undo mutations already applied; every bulk
  write is audited per record with `bulk_batch_size`, and the existing per-row revert
  paths (Revert to confirmed, Unclaim, Restore, Reopen) are the operator's undo.

## 9. Acceptance checks per PR

`npm test && npm run typecheck && npm run lint`, then a Playwright pass on the local
stack (dev server on port 3007, admin + the page's role) recorded in the PR:

1. Select-all → indeterminate → all; cap reached message; a row's checkbox disabled at cap.
2. Escape clears; Escape inside an open sheet/dialog does not.
3. Sorting / paging / filtering drops the selection (resetKey).
4. Two tabs: change a selected row in tab B, act in tab A → partial result reported,
   nothing overwritten, audit rows only for changed records (`audit_log` query).
5. Role check: the page's other roles get no checkboxes and the actions refuse them.
6. PR 1: inactive patient in a batch → whole batch refused, no writes. PR 2: x-ray row
   for a non-x-ray tech is skipped with its reason; paid/HMO/deleted gates skip. PR 3:
   a `booked` message is never moved except to `closed`.
7. 390px layout: bar visible, checkboxes tappable, no horizontal page scroll added.

## 10. Out of scope (surfaced for the owner)

- Shift-click range selection.
- Migrating the visit page's Tests section onto the shared kit (no behaviour change).
- Chemistry panels in the queue bulk bar (needs a panel-identity rule across pages).
- Reception Queue (`/staff/visits/queue`) visit-level bulk delete.
- OT slips approve / payroll "mark paid" / critical alerts acknowledge / gift codes
  cancel — each needs a new array action; same kit applies.
- A "select all matching filter, across pages" mode. Selection is per page on purpose:
  the count in the bar is always what the operator can see.

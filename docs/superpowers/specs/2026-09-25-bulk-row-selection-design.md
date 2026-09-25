# Bulk row selection on staff lists — design

**Date:** 2026-09-25 · **Branch:** `feat/bulk-select` · **Migration:** none

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
| 1 | **Appointments** `/staff/appointments` | per-row Mark arrived / No-show / Cancel / Confirm / Revert / Delete | High — many bookings per day, all reception | **None for the core**: all five actions in `appointments/actions.ts` already take `ReadonlyArray<string>` |
| 2 | **Reception/Lab Queue** `/staff/queue` | per-row Claim (single id), Unclaim (array, called with one), Delete/Restore (array, called with one) | High — lab techs claim a batch of samples at once | One new `claimTestsAction(ids)`; Unclaim + Delete already array-typed |
| 3 | **Website Messages** `/staff/messages` | no row buttons; status changes only on the detail page | Medium — inbox triage ("close these five") | New `updateMessageStatusManyAction(ids, status)`; row buttons don't exist yet |
| — | Visit page tests, HMO claims | already bulk | — | — |
| later | OT slips approve, payroll run "mark paid", critical alerts acknowledge, gift codes cancel | single-id actions | Periodic, low volume | New array actions each |
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

Generic version of the visit-page files. Keys are opaque strings; a **kind** tag per
selected key lets one bar drive several actions (the visit page's `release` vs
`unrelease`). The visit page keeps its own files in PR 1 (it is the release path and
needs no change); migrating it to the kit is a follow-up.

```ts
// selection-context.tsx ("use client")
export function SelectionProvider<Kind extends string>({ children, cap = MAX_BULK_SELECTION })
export function useRowSelection<Kind extends string>(): {
  isSelected(key): boolean;
  toggle(key, kind): void;              // no-op past the cap for that kind
  setMany(entries: {key, kind}[], selected: boolean): void; // header select-all; stops at the cap
  clear(): void;
  clearKeys(keys: string[]): void;      // prune after a successful action / on unmount
  keysByKind: Record<Kind, string[]>;
  count: number;
}
// row-select-checkbox.tsx — <RowSelectCheckbox key kind label />: disables itself at the
//   cap (title "You can select up to N at a time"), prunes itself on unmount, 44px label hit box.
// select-all-checkbox.tsx — <SelectAllCheckbox entries={[{key, kind}]} label />: header cell;
//   checked when every entry is selected, indeterminate (ref) when some, toggles the rest via setMany.
//   `entries` is the serialisable list of the rows this table renders (this page only).
// bulk-bar.tsx — <BulkBar count onClear>{actions}</BulkBar>: the sticky bottom Panel
//   (visit-page/HMO styling), "N selected · Clear", returns null at count 0.
// src/lib/ui/bulk-selection.ts — MAX_BULK_SELECTION = 100 (the visit constant re-exports it).
```

Rules the kit enforces so pages can't get them wrong:

- Selection lives in memory only. Navigating, paging, sorting, changing a filter or a
  tab drops it (the provider unmounts). No URL or storage persistence.
- Every checkbox prunes itself on unmount, so a revalidation that moves a row out of the
  list also removes it from the bar's count.
- Cap per kind = 100 keys, enforced in `toggle`, `setMany` and by the checkbox's
  `disabled`. Server actions enforce their own cap independently (§5–7).
- Escape clears the selection when focus is inside the provider and no dialog is open
  (matches the sibling modals' Escape-to-dismiss).

Tests: `selection-context.test.tsx` (toggle, cap, setMany stops at cap, clearKeys keeps
the rest, unmount prunes) and `select-all-checkbox.test.tsx` (checked / indeterminate /
mixed-kind entries).

## 5. PR 1 — Appointments

**Selection unit = one table row = one booking group** (`ApptGroup`, several
`appointments` rows for a multi-service booking). Key = `group.key`; kind = the lead
row's status (`confirmed | arrived | no_show | cancelled | pending_callback`).

**Page wiring** (`appointments/page.tsx`): one `SelectionProvider` wraps all four
sections in the grouped view and the single table in the flat view, so a selection can
span sections. Each table gets a leading checkbox column: `SelectAllCheckbox` in the
header (entries = that table's groups) and `RowSelectCheckbox` as the first `<td>` of
`GroupRow` (label = patient/walk-in name + service count). The empty-state `colSpan`
grows by one. Completed groups render the checkbox disabled with title "Completed
bookings have no bulk action" (nothing acts on `completed`).

The bar needs data the context does not hold, so the page passes a serialisable
`groupsByKey: Record<key, { ids: string[]; status; patientActive: boolean; label }>` to
`AppointmentsBulkBar`, rendered last inside the provider (sticky, in-flow, same as the
visit page).

**Bar actions** — each button acts on the eligible subset of the selection and shows
that count; a button with count 0 is hidden. Eligibility mirrors
`ALLOWED_FROM` in `appointments/actions.ts` and the per-row `patientActive` gate:

| Button | Eligible statuses | Extra gate | Confirm |
|---|---|---|---|
| Mark arrived (n) | confirmed | patientActive | none (same as row) |
| No-show (n) | confirmed | — | yes, with count |
| Cancel (n) | confirmed, arrived, pending_callback | — | yes, with count |
| Confirm (n) | pending_callback | patientActive | none |
| Revert to confirmed (n) | arrived, no_show, cancelled | patientActive | yes, with count |
| Delete (n) | any non-completed | admin only | yes, with count, red |

Groups whose patient record is deleted/merged are excluded from arrive/confirm/revert and
the bar says "n skipped — patient record deleted" beside the button, matching the reason
the row hides those buttons today. The server keeps its all-or-nothing
`assertAppointmentsPatientsActive` check as defence in depth.

**Server actions** (`appointments/actions.ts`, additive):

- `ApptResult` success gains `count: number` (rows actually transitioned / deleted).
  `TransitionButtons` ignores it; the bar reports "Marked 3 of 5 arrived — the rest had
  already changed" when `count < sent`, like the visit bar.
- `transitionGroup` and `deleteAppointmentAction` reject more than
  `MAX_BULK_APPOINTMENT_IDS = 500` ids (100 groups × up to five services) with a
  plain message, before any query.
- Audit rows are unchanged (one per appointment, `group_appointment_ids` in metadata).
  Bulk adds `metadata.bulk_selection_size` so a trail can tell a 40-row sweep from a
  single click.

**After an action:** `clearKeys(sentKeys)` then `router.refresh()` (what
`TransitionButtons` does). Rows in flight keep their checkmarks. Errors use `alert()` like
every sibling on this page.

**User guide:** guide §3 Appointments (the section holding the Row actions list) — new "Act on several bookings at once" step after the
Mark arrived step, the Row actions `<dt>` gains "tick boxes → bottom bar", version bump.

**Tests:** `src/lib/appointments/bulk-eligibility.ts` — pure
`bulkActionCounts(selected: {status, patientActive}[], isAdmin)` returning per-button
`{ eligibleKeys, skippedInactive }`; vitest covers every status × gate. Existing
`flat-view.test.ts` unchanged.

## 6. PR 2 — Reception/Lab Queue

Key = `test_request_id` (a consolidated chemistry card selects its group's requests as
one key, the way its Claim button acts today). Kinds:

- `claimable` — unclaimed, claimable by this role (the page already computes "show
  Claim" per card: section scope, x-ray gate, package headers excluded, deleted visits
  excluded).
- `unclaimable` — claimed by me, or by anyone for admin (the page's Unclaim rule).
- `deletable` — whatever the page shows the delete control for.

One row may carry more than one kind (a claimed row is unclaimable and deletable), so the
key is registered once with its **primary** kind and the bar receives
`rowsByKey: Record<key, { kinds: Kind[]; label }>` from the page and derives counts.

Bar: **Claim (n)** · **Unclaim (n)** (opens the existing reason prompt from
`queue-unclaim-button.tsx`, reason required, one call with all ids) · **Delete (n)**
(opens the shared `queue-delete-dialog.tsx` with the selected ids — it already accepts an
array and requires a reason).

New `claimTestsAction(ids)` in `queue/actions.ts`: same session/role check once, then the
exact per-request gates of `claimTestAction` (deleted visit, package header, payment/HMO
gate, section scope, x-ray gate) run per id; claims the passing ids, returns
`{ ok: true, claimed: n, skipped: { id, reason }[] }`. Cap 100 ids. The bar reports
skipped rows in one alert ("Claimed 7 of 9 — 2 skipped: already claimed by Ana"). Audit:
one row per claim as today. Refactor the single action to call the shared per-id gate
so the two cannot drift; `claimTestAction` keeps its signature.

Guide: §4.2 The queue (and §3.7 Reception Queue for reception's delete) — bulk claim/unclaim paragraph.

## 7. PR 3 — Website Messages inbox

Key = message id; kind = current status. The inbox table gets the checkbox column; the
bar offers the same transitions the detail page's `message-actions.tsx` allows
(`StatusSchema` targets), each as "Mark <status> (n)" over the eligible subset.

New `updateMessageStatusManyAction(ids, status)`: mirrors `updateMessageStatusAction`
(role check, per-row `from → to` audit, `revalidateMessageSurfaces` for each id plus the
layout revalidate that keeps the sidebar badge honest). Cap 100. Returns `count`.

Guide: §3.11 Website Messages — one paragraph.

## 8. Error handling and edge cases (all PRs)

- Selection outlives a row: revalidation removes the row → checkbox unmounts → pruned.
- Two staff act on the same rows: the server's status filter (`.in("status", allowed)`)
  makes the second batch partial; the bar reports `count < sent` rather than failing.
- Cap hit: checkbox disables with the title; select-all stops at the cap and the header
  checkbox shows indeterminate; server rejects oversize batches outright.
- Role gates are unchanged and stay server-side: reception/admin for appointments,
  section scope for the queue, admin-only delete everywhere it is today.
- Mobile (390px): the checkbox cell is a 44px `<label>`; the bar wraps its buttons.
- Keyboard: checkboxes are native inputs; Escape clears; the bar's buttons are `Button`s.

## 9. Out of scope (surfaced for the owner)

- Shift-click range selection.
- Migrating the visit page's Tests section onto the shared kit (no behaviour change).
- OT slips approve / payroll "mark paid" / critical alerts acknowledge / gift codes
  cancel — each needs a new array action; same kit applies.
- A "select all matching filter, across pages" mode. Selection is per page on purpose:
  the count in the bar is always what the operator can see.

# Dashboard fix batch — implementation plan (2026-09-15)

Source of truth: the owner decisions of 2026-09-15 on
`docs/superpowers/audits/2026-09-11-dashboard-review.md` (Codex gpt-6-astra, xhigh),
as adjudicated by Fable on 2026-09-14 and corrected by the Codex xhigh
counter-review of 2026-09-15.

Branch: `fix/dashboard-fixes` off `main` @ e96bd77.
**No migration.** `hmo_providers.unbilled_threshold_days` (0034) and
`v_hmo_unbilled.past_threshold` (0080/0082) already exist; every other change is
app-side. Prod ledger stays at 0145.

Already shipped by #160–#172 — do NOT redo: doctor-line exclusions on the tiles,
`deleted_at` filters on released-today tiles, reception "Services" quicklinks
removed, admin Coming-soon `PlannedCard` import dropped.

---

## Workstream A — Reception sees the bill, never the result (decision 1)

Reverses the go-live A4 gate on the visit page. `sectionsForRole("reception") === []`
is a DENY, so today reception sees **no** test rows at all on a visit.

### A1 · Split the one gate in two — `visits/[id]/page.tsx`

The page has exactly ONE gate (`isVisible`, L288–299) applied at three places
(L310 deleted rows, L315 visible parents, L319 `allRows`). Nothing downstream
re-checks role or section, so every control below inherits it.

Replace with two predicates:

```ts
// Who may SEE a bill line: reception (the counter enters and collects it),
// admin and pathologist see every line; lab roles see their own sections.
const canSeeLine = (r) => role === "reception" ? true : sectionGate(r);
// Who may ACT on a RESULT: unchanged — sectionsForRole, so reception is denied.
const canActOnResult = (r) => sectionGate(r);
```

`sectionGate` is the existing body of `isVisible`. Keep the A4 comment block but
rewrite it: the deleted-entries panel now filters on `canSeeLine`.

- L308–310 `deletedTestRows` → `canSeeLine`
- L315 `visibleParents` → `canSeeLine`
- L319 `allRows` → `canSeeLine`

### A2 · Gate the result-side controls on `canActOnResult` (NOT just the row predicate)

Per the counter-review these four call sites have no gate of their own and must
gain one:

| Control | Lines | Change |
|---|---|---|
| `ReleaseAllButton` (package) | 651–669 | wrap in `canActOnResult(h)` |
| `ReleasePackageHeaderButton` | 674–682 | already `isAdmin`-gated — leave |
| Row-select checkboxes | 736–751, 879–893 | render only when `canActOnResult(row)` |
| `BulkActionBar` | 1052–1069 | render only when the role can act at all |
| `TestAction` | 793–815, 986–1007 | new `canAct` prop |
| Bench link "Open in queue →" | 1409 (inside `TestAction`) | inside the `canAct` branch |

`TestAction` gains `canAct: boolean`. When `false` it renders a **read-only
status hint only** — the same words it already shows (`Awaiting claim`,
`Awaiting result`, `Awaiting sign-off`, `Released ✓`, `—`) with **no**
`MarkDoneButton`, `ReleaseButton`, `UndoReleaseDialog`, `View PDF →` link, or
`Open in queue →` link. Reception still reads progress off the status chip and
this hint; it gets no door into a result.

`QueueDeleteDialog` (L690–696, L1008–1023) keeps its existing `testDeletability`
gate — `QUEUE_DELETE_ROLES` is `{reception, admin}` and deleting an *unpaid bill
line* is a counter action, not result access. Unchanged.

### A3 · What reception now sees, and what stays hidden

Shown: service name, code, base price, discount, final price, status chip,
`visit.notes` (this is the "internal notes" the decision means — there is no
per-test note field), the deleted-entries panel, doctor lines **exactly as at
intake** (name, Doctor/Procedure badge, `Clinic fee … · PF …` line at L927–933 —
per the counter-review, reception already types both into
`visits/new/visit-form.tsx` ~L852, so pretending to hide the split here is
theatre).

Still hidden: result values, result PDFs, release / undo / mark-done / bulk
actions, the bench link, critical flags, and `PfStatusBadge` (L934–936,
admin-only — unchanged; a PF *payout status* is doctor-pay data per the
2026-09-10 audit).

Not in scope: the lab queue and the results archive stay closed to reception.
The notification bell needs **no** change — "booked <service>" is legitimate
under the new rule, and so is the Quick quote quicklink (the audit's finding 1
argued from the old rule).

### A4 · Docs + skill (same PR, per CLAUDE.md)

- `docs/drmed-user-guide.html` — rewrite the "Why the visit page shows no
  tests" note (L615), the reception/results FAQ row (L1051), and the doctor-line
  sentences at L631 and L1039.
- `.claude/skills/drmed-staff-ui/SKILL.md` — the Gotchas bullet "Reception sees
  no per-test rows on the visit page" is now wrong. Replace it with the
  see-vs-act split.

### A5 · Tests

New pure-logic unit test for the split predicate. Extract it into
`src/lib/visits/line-visibility.ts` (`canSeeLine` / `canActOnResult` taking
`role` + a section) so it is testable without RSC, and assert: reception sees
every section but acts on none; medtech sees/acts on its own sections only;
xray likewise; admin and pathologist both, everywhere.

---

## Workstream B — HMO visits leave "Waiting for payment" (decision 2)

`visitStage()` (`src/lib/visits/queue-stage.ts:60–67`) takes `paymentStatus` +
`tests` and has no HMO input, so an HMO visit — whose `payment_status`
legitimately stays `unpaid` until settlement months later — is parked in
Waiting forever.

Safe because the clinic is all-or-nothing: no partial, no HMO co-pay
(`staff-nav-config.ts:588`), split visits make a visit wholly HMO or wholly
cash, and HMO already clears both the lab gate and the release trigger at
creation (0133).

### B1 · `visitStage()` uses `moneySettled()`

Change the signature to take a visit-like object:

```ts
export function visitStage(
  visit: { payment_status: string; hmo_provider_id: string | null },
  tests: readonly QueueTestLike[],
): QueueStage {
  if (!moneySettled(visit)) return "waiting";
  return tests.some(isOutstandingLabImaging) ? "processing" : "completed";
}
```

Update the sole production caller (`visits/queue/page.tsx:202`) and the module
doc comment (L1–14).

### B2 · Correct the two comments that assert the opposite

- `src/lib/visits/money-settled.ts:22–25` — "NOT covered by this definition, on
  purpose: the reception queue's stage helper" is now false. Rewrite: the queue
  stage shares this predicate; what the counter still has to collect is the
  `waiting` bucket *after* HMO leaves it.
- `src/lib/visits/lab-gate.ts:14–15` — same sentence, same fix.

### B3 · The queue shows "HMO · <provider>", not a red Unpaid chip

`visits/queue/page.tsx` — desktop row L537–541, mobile card L592–596. When
`hmo_provider_id != null`, render an `HMO · <provider name>` chip (blue, the
`waived` style) instead of the payment-status badge. Add `hmo_providers ( name )`
to the queue select (the join pattern is `patient-ar/page.tsx:110` + the
`pluckProviderName` helper at L75–81).

### B4 · Reception's Unpaid card and strip exclude HMO

`_dashboards/reception-dashboard.tsx` — Unpaid balance (L190–197) and Today's
unpaid strip (L248–260): add `.is("hmo_provider_id", null)`. Both destinations
become `/staff/visits/queue?stage=waiting`, which after B1 holds exactly the
non-HMO unpaid visits — card and destination finally share one definition.
Strip rows link straight to `/staff/payments/new?visit_id=…`, oldest waiting
first (`.order("created_at", { ascending: true })`), and the total is paged.
Empty copy becomes "No payments waiting" (not "All today's visits are paid").

### B5 · "Record payment" on an HMO visit

- `visits/[id]/page.tsx:428–435` — the button is gated on `canSeePayments`
  only. Hide it for reception when `visit.hmo_provider_id != null`, with a hint
  ("Billed to <provider> — settled through HMO claims"). **Keep it for admin**,
  because of the known edge below.
- `payments/new/page.tsx` — do **not** redirect. Render a warning panel above
  the form when the visit is HMO-billed, and keep the form usable: an HMO claim
  resolved as **Bill patient** legitimately moves the amount to the patient,
  and blocking the page would strand that collection.

### B6 · Known edge — log it, don't fix it here

`createResolutionAction` (`hmo-claims/actions.ts:504–554`) records a
`patient_bill` resolution **without clearing `visits.hmo_provider_id`**. Those
visits are therefore invisible to the admin **Patient AR** card, which filters
`.is("hmo_provider_id", null)` (`admin-dashboard.tsx:186`). The patient-AR
*page* can still reach them through its `?scope=hmo` / `?scope=all` tabs. Out of
scope for this PR — record it in the PR description as a follow-up.

### B7 · Tests

`src/lib/visits/queue-stage.test.ts` — add HMO cases: an HMO visit at every
payment status leaves `waiting`, and lands in `processing`/`completed` by its
tests exactly like a paid visit. Keep the existing non-HMO waiting tests.

---

## Workstream C — Critical alerts (decision 3)

Table is `public.critical_alerts` (the migration filename says
`critical_value_alerts`; the table does not). RLS already grants SELECT to every
staff role (0027:52–54); the app gate is what is wrong.

### C1 · Medtech sees alerts for tests currently assigned to them

`_dashboards/lab-dashboard.tsx` — the "Recent critical alerts" strip (L247–257)
fetches with no ownership or section filter, and the card `lab.strip_recent_criticals`
already lists `medtech` among its roles.

For `medtech`, add `test_requests!inner(assigned_to)` to the select and
`.eq("test_requests.assigned_to", userId)`. `critical_alerts.test_request_id` is
a real FK, so the embed works; no query in the repo does this today, so verify
the emitted plan.

Per the counter-review, `assigned_to` is **current** ownership — an admin
reassignment (`queue/actions.ts:277–284`) moves the alert with the test. Do not
claim it is the handler: label the strip **"Critical values on tests assigned to
you"**. Acknowledging stays pathologist/admin (0027's update policy), so the
medtech strip is read-only and shows who acked and when.

### C2 · Pathologist strip: unacked, oldest first, with DRM-ID

Same strip for `pathologist`: drop the 24-hour `gte("created_at", dayAgoIso)`
cutoff (it hid old unresolved alerts while the count still included them),
filter `.is("acknowledged_at", null)`, order `created_at` **ascending**, and
select `patient_drm_id` so the row identifies the patient. The count card
(`lab.critical_alerts`, L182–188) already matches its destination — leave it.

No bell for medtech (it would need an ownership refetch, and they raise the
alert themselves). Send-out PDF uploads create no alerts — only the structured
paths do — so nothing to cover there.

### C3 · `/staff/critical-alerts` filters for medtech instead of refusing

`critical-alerts/page.tsx:45–60` refuses every role but pathologist/admin.
Allow `medtech` through, filtered to `test_requests.assigned_to = me`, read-only
(no acknowledge control). Keep refusing `xray_technician` — imaging has no
critical thresholds — and `reception`. Page the unacked list (L71–83 is unpaged)
or cap it honestly.

---

## Workstream D — Reception dashboard, the rest

### D1 · Orders by type — KEEP (partner request 3)

`reception-dashboard.tsx:273–282`. Add `.neq("status", "cancelled")` and retitle
the heading **"Today's orders by type (test lines)"** so it never reads as a
visit count. The paging concern was overstated (leaf lines for one day).

### D2 · Pending release — header + today scope

L198–215 counts **all-date** `ready_for_release` rows including package headers,
and links to today's Processing stage. Per the counter-review: keep the count
**all-date** (scoping to today would drop yesterday's ready-but-unreleased
work) and exclude **headers only** — add `.eq("is_package_header", false)`.
Retitle so it cannot be read as today's figure, and point it at
`/staff/visits/queue?stage=processing`.

### D3 · Arrivals awaiting registration (replaces Next appointments)

L236–247 includes only *future* `scheduled_at` rows, limits appointment **rows**
before grouping (one multi-service booking eats several slots), and shows a
clock time with no date.

- Group by `booking_group_id ?? id` **before** the limit.
- Per the counter-review, bound only **scheduled** rows to today; untimed open
  bookings deliberately carry over from yesterday (`appointments/page.tsx:217`).
- Keep elapsed scheduled arrivals visible (drop the `gte(scheduled_at, now)`).
- Show the date when a row is not today.
- Surface pending callbacks in the same action list.

### D4 · Walk-ins waiting — count people, not rows

L216–221 counts `appointments` rows with `status='arrived'`, including scheduled
patients. Group by `booking_group_id ?? id` and label it as arrivals awaiting
registration.

### D5 · Cards to fold or retire

- **Open inquiries** (L222–227) → fold the count into the inquiry strip heading;
  drop the standalone card.
- **Recent inquiries** strip (L261–269) → pending follow-ups, **oldest first**
  (`called_at` ascending), total in the heading.
- **Cash drawer** (L150–168) → add the shift label so afternoon staff know
  which drawer state they are reading.
- **Visits today** (L183–189) → keep, but carry today's `start`/`end` into the
  link and stop calling it "patients registered".

### D6 · Quicklinks

Trim per the audit, with the decision-1 correction: **Quick quote stays**
(reception may see names and prices). Remove the Personal group's
**My payslips** and **My profile** dashboard shortcuts (decision 5 — both stay
in the sidebar). Remove the duplicate archive link.

---

## Workstream E — Lab dashboard (decisions 6, 8)

### E1 · Sign-off is a placeholder — hide it, keep the route

`src/lib/dashboards/cards.ts`: set `defaultHidden: true` on
`lab.ready_for_signoff` and `lab.strip_pending_signoff`. Admin can re-enable
both from Dashboard settings when the gate ships; a stored pref always wins, so
no migration.

- Drop the `/staff/signoff` quicklink (`lab-dashboard.tsx:43`).
- Delete the lab "Coming soon" `SectionHeading` + `PlannedCard` (L484–497) —
  and with `showSignoff` gone the whole section is empty, so remove the
  container too, not just the child.
- Keep the `/staff/signoff` route and its admin-only Hidden-tabs sidebar entry.
- `scripts/smoke-dashboards.mjs:86–92` asserts `"Ready for sign-off"` for the
  pathologist — remove that marker (and `"Sign-off"`, the quicklink) from the
  expectations.

### E2 · Released today

- **Lab roles keep "(mine)"** — pathologists can claim (`LAB_CAPABLE_ROLES`), so
  keep it for them too. Per the counter-review the card must copy the queue's
  full predicate set: add `.eq("is_package_header", false)` and the section
  filter (L205–223 has neither).
- Destination gains `?filter=released_today&mine=1`. `queue/page.tsx` supports
  `filter=released_today` (L129) but has **no** `mine` param — "mine" is a
  separate filter value. Add an orthogonal `mine=1` that ANDs
  `assigned_to = user.id` onto the released-today tab.

### E3 · Claimed by me, Unclaimed, Send-out — mirror the queue predicates

The canonical set is `queue/page.tsx:132–225`: `deleted_at is null` on both
tables, `is_package_header = false`, `not services.kind in DOCTOR_KINDS_PG_LIST`,
`in services.section` (deny on `[]`), and `LAB_QUEUE_GATE_VISITS_OR` on the
worklist tabs.

- **Claimed by me** (L153–163): missing the section filter and the money gate.
  Add both (a payment void or a role change can otherwise leave a counted
  assignment absent from Mine).
- **Unclaimed** count + Oldest strip (L132–143, L228–245): missing
  `is_package_header = false` and the doctor-kind exclusion. Add both.
  Destination gains a matching unclaimed filter; strip rows link to
  `/staff/queue/{id}`; empty copy → "No unclaimed tests".
- **Send-out** (L192–203): rename to **"Open send-out tests"**, add the medtech
  section filter and `is_package_header = false`, and link to that subset.

---

## Workstream F — Admin dashboard

(Filled from the admin recon — see F-detail below.)

## Workstream G — Payslips (decision 5, REVERSED)

Hiding the nav entry does not fix the real problem: a **draft** payroll run
inserts zero-amount `payroll_employee_runs` rows, and the staff payslips list
has no run-status filter, so staff see ₱0 payslips for every draft.

- Keep **My profile** and **My payslips** in the sidebar's Personal section.
- Remove both from the reception and lab dashboard quicklinks (D6, E1).
- **Filter the staff payslips list to runs that are finalised or paid** (the
  owner's decision; the empty-state copy already promises "paid"). Both statuses
  count as visible.

(Exact status strings, RLS answer and query shape filled from the payslips
recon — see G-detail below.)

## Workstream H — Cross-cutting

- **`format.ts`** — `formatPeso` rounds every dashboard figure to whole pesos,
  so a ₱0.25 balance shows ₱0. Show two decimals for collection, drawer and
  payable amounts.
- **Error ≠ zero.** Reception and admin discard query errors; lab reports them
  but still falls back to `0` / `[]`. Preserve a per-widget error state and
  render "Couldn't load" instead of a zero or an all-clear.
- **`RealtimeRefresher`** — only supports `appointments` / `test_requests` /
  `visits` / `payments`. Reception and lab can subscribe as-is; **admin needs
  the union widened or an interval** (counter-review fix (e)).
- **Section headings** — gate at the **callers**: an empty grid is truthy
  children, so `SectionHeading` cannot detect emptiness itself.
- **`truncated`** — admin AP / patient-AR / advances / PF loaders page but
  discard `truncated` at 20 000 rows. Surface the incomplete-total state the way
  the HMO card already does.
- **Draft journal entries** → `defaultHidden: true` (decision 9; the owner never
  looks). **Re-review later** (do NOT hide now): Visits today, Queue, Staff
  advances, Active employees, Recent audit anomalies. The audit strip's 7-day
  recency cutoff goes in regardless.

---

## Verification

1. `npm test && npm run typecheck && npm run lint` (baseline: 1353 tests pass,
   typecheck clean, one pre-existing `booking.ts` lint warning).
2. `npm run smoke:dashboards` against the local stack, after updating its
   pathologist expectations.
3. Browser pass on the dev server as **Ian Jamila (admin)** plus a reception and
   a medtech test user — the HMO chip, the reception visit page, the critical
   strip.
4. Codex review of the diff, then a Fable review, before asking for merge.

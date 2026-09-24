# Staff page complexity audit — 2026-09-24

Read-only sweep of all 155 staff `page.tsx` routes for UI that could be simpler:
jargon for the audience, always-open forms, oversized dropdowns, no-op or
dangerous controls, overlap, unclear states, and page-shape drift. Five Sonnet
reviewers each took one batch (A front desk/billing, B lab/catalog, C accounting
part 1, D accounting part 2, E payroll/ops/settings); the flagship claims were
then spot-checked against the source by the orchestrator (DTR commit no-op,
inventory UTC timestamp, vendor badge key, "PF split" copy, holiday re-enable,
raw result status badges, HMO provider dead queries, import-patients dedup —
all confirmed).

Cash Routing + Payment Routing were redesigned in the same session (Money
Routing, see the PR that adds this file) and are excluded.

## Prod usage at audit time (row counts, 2026-09-24)

Used: `patients` 7,068 · `journal_entries` 22,432 · `services` 300 ·
`result_templates` 187 · `bills` 75 · `physicians` 20 · `payroll_holidays` 18 (seed).

Never used on prod (0 rows): `employees`, `payroll_runs`, `payroll_dtr_imports`,
`inventory_items`, `inventory_movements`, `accrual_templates`,
`recurring_bill_templates`, `bank_statements`, `gift_codes`, `hmo_claim_items`,
`staff_advances`, `eod_cash_adjustments`, `eod_close_records`.

Prioritise the used surfaces; findings on the unused ones are real but can wait
until the owner starts using those features.


## Batch A audit

### Top 5 in this batch (highest user-facing payoff first)
1. `/staff/payments/cash-drawer` — the "Pay out cash / Add cash / Remove cash" modal makes reception pick a raw chart-of-accounts entry (code + name) instead of the plain category picker the app already built for the identical job on Petty Cash → reuse `PETTY_CASH_CATEGORY_OPTIONS`/the same mapping approach in the modal. Effort M.
2. `/staff/visits/new` (New Visit) — the counter's busiest form tells reception a doctor line defaulted to ₱0 clinic fee because "this doctor is PF split", raw bookkeeper vocabulary printed straight on the page → reword in plain language (see per-page notes). Effort S.
3. Page-shape drift: several detail pages (`/staff/patients/[id]`, `/staff/audit`) hand-roll their own `<header>` instead of the shared `PageHeader` component → swap in `PageHeader`. Effort S.
4. Eight single-column pages put `mx-auto max-w-*` on the page ROOT rather than on the form inside the shell's container (gift-codes/refund, gift-codes/sell, payments/new, patients/new, patients/[id]/edit, users/[id]/edit, users/new, profile) → move the width constraint onto the form/panel, drop it from the page root. Effort S per page (mechanical, one class each), M as a batch.
5. `/staff/visits` (Visit Records) is a dense control surface — search box, 4 classification chips, a date-range form, an active/deleted view toggle, a "revenue by classification" card strip that doubles as a filter, a sortable table, and (admin) a CSV export — all justified by comments and used by more than just reception (all roles can open it), so no forced change, but if it keeps growing, the revenue-by-classification strip is the best first candidate to fold behind a "Show revenue breakdown" disclosure since it answers a different question ("how much did we make") than the rest of the page ("find this visit").

### Per page

### appointments — audience: reception — complexity: 3
- Fine overall. The page is large (four sections + a flat/sorted merge view) but every extra control (grouped vs. flat toggle, source filter, search) is justified in-code and only appears once a search/sort/filter is active — the default view stays simple. No changes recommended.

### audit — audience: admin — complexity: 2
- Issue: `src/app/(staff)/staff/(dashboard)/audit/page.tsx:182` hand-rolls a `<header>` instead of using the shared `PageHeader` component (drmed-staff-ui rule "one header component"). → Fix: swap to `<PageHeader title="Audit Log" subtitle="…" />`. Effort S.
- Otherwise fine — it's an admin/compliance page, so the JSON metadata column and IP column are appropriate for its audience.

### critical-alerts — audience: pathologist/admin (medtech read-only) — complexity: 2
- Fine. Plain language throughout, correct read-only scoping for medtech, exact totals shown instead of a silent 50-row cap.

### gift-codes/refund — audience: reception — complexity: 1
- Issue: `.../gift-codes/refund/page.tsx:58` puts `mx-auto max-w-xl` on the page root div rather than the form only (page-shape rule §1). → Fix: drop the width class from the root, keep the panel narrow. Effort S.
- Otherwise fine — plain language, clear eligibility messaging, obvious escape hatch to "Void that payment instead."

### gift-codes/sell — audience: reception — complexity: 1
- Issue: same page-shape miss, `.../gift-codes/sell/page.tsx:50`. Effort S.
- Otherwise fine — plain-language payment methods, good cross-link to the refund flow.

### login — audience: reception/all staff — complexity: 1
- Fine.

### messages — audience: reception — complexity: 2
- Fine. Status tabs, search, and a single "Corporate/HMO only" toggle — no excess controls; empty states are per-tab and specific.

### messages/[id] — audience: reception — complexity: 2
- Fine. Reply panel is well-scoped (destination is read-only, computed server-side — can't be spoofed), templates are a nice shortcut, not a complexity problem.

### mfa — audience: all staff — complexity: 1
- Fine.

### page.tsx (dashboard home) — audience: all — complexity: 1
- Fine — a 29-line role router with no UI of its own.

### patients — audience: reception — complexity: 2
- Fine. Search, one QR shortcut button, sortable table, ×50 default page size. No excess controls.

### patients/[id] — audience: reception — complexity: 2
- Issue: `.../patients/[id]/page.tsx:104` hand-rolls the header (title + actions) instead of `PageHeader`. → Fix: convert to `PageHeader` with the Edit/Reissue PIN/Start visit buttons in `actions`. Effort S.
- Read-first + Edit-button pattern is correct (edit lives at a separate `/edit` route) — no always-open-form issue.

### patients/[id]/consent/print — audience: reception — complexity: 1
- Fine — narrow print sheet is the correct shape for this route; exempt from the page-shape width rule by design.

### patients/[id]/edit — audience: reception — complexity: 2
- Issue: `.../patients/[id]/edit/page.tsx:53` — `mx-auto max-w-3xl` on the page root rather than the form/panel. Effort S.
- Otherwise fine; form fields aren't reviewed in depth here (form component is shared with `patients/new`).

### patients/consent/print — audience: reception — complexity: 1
- Fine — same narrow-print exemption as the bound version; good comment explaining why it exists separately (no double audit row on a blank form).

### patients/new — audience: reception — complexity: 2
- Issue: `.../patients/new/page.tsx:18` — same page-root width issue. Effort S.
- Otherwise fine.

### payments/cash-drawer — audience: reception — complexity: 3
- Issue: `.../payments/cash-drawer/cash-drawer-client.tsx:365-373` — the "Pay out cash" / "Add cash to drawer" / "Remove cash from drawer" modal's account picker shows the raw chart-of-accounts list (`{a.code} {a.name}`, e.g. "5010 Office Supplies") to reception for every kind except salary advance/courier. This is exactly the accounting-jargon-on-a-reception-screen pattern the house rules warn about, AND it duplicates work already done correctly one tab over: `.../payments/petty-cash/petty-cash-form.tsx:118-131` uses `PETTY_CASH_CATEGORY_OPTIONS` (a plain "What was it for?" picker with an optional hint) and `.../payments/petty-cash/page.tsx:60-64` maps the stored COA code back to that same plain category for display (`PETTY_CASH_COA_TO_CATEGORY`). → Fix: reuse the same category-option list (or a purpose-built subset for topup/pullout) inside `AdjustmentModal` instead of listing the full chart of accounts, and store/display through the same mapping. Effort M (touches the modal + likely a small extension of `expense-mappings.ts` for topup/pullout categories, which petty cash doesn't need).
- Otherwise excellent plain-language work: `KIND_LABEL` humanizes every raw code (`float_topup` → "Cash added to drawer"), and the two entries that can't use the generic Void button (`bill_payment`, `gift_code_sale`) correctly point reception to the right screen instead of offering a broken action.

### payments/eod — audience: reception — complexity: 2
- Fine — exemplary plain language ("Starting cash", "Cash you should have now", "Difference (over/short)"), correct blank-vs-zero handling on the denomination count, good closed/open state split.

### payments/eod/[closeId]/count-sheet — audience: reception (printed) — complexity: 1
- Fine.

### payments/new — audience: reception — complexity: 1
- Issue: `.../payments/new/page.tsx:56` — page-root `mx-auto max-w-xl`. Effort S.
- Otherwise fine — the HMO warning banner is a good example of "warn, don't block" for a real edge case.

### payments/petty-cash — audience: reception — complexity: 1
- Fine — this is the reference implementation the Cash Drawer modal (finding #1) should copy.

### payslips — audience: all staff — complexity: 2
- Fine. Privacy-mode blur toggle is a thoughtful touch for a shared-desk environment; year tabs and the admin employee picker are the only real controls.

### payslips/[id] — audience: all staff — complexity: 2
- Fine — dense but it's a payslip; every section (earnings/deductions/YTD/leave) is inherent to the document, not addable complexity.

### profile — audience: all staff — complexity: 1
- Issue: `.../profile/page.tsx:29` — page-root `mx-auto max-w-2xl`. Effort S.
- Otherwise fine.

### quote — audience: reception/medtech/admin — complexity: 2
- Fine — single workbench component, no extra chrome.

### registration — audience: reception — complexity: 1
- Fine — QR + copy link + two poster links, nothing to simplify.

### users — audience: admin — complexity: 3
- Fine for its audience. Filters (role/status/sign-in) are chips, not dropdowns; the Google-migration progress line is a nice touch; the deleted-users archive is deliberately unfiltered and explained. Appropriately admin-facing (chart-of-accounts style detail is absent here).

### users/[id]/edit — audience: admin — complexity: 3
- Issue: `.../users/[id]/edit/page.tsx:52` — page-root `mx-auto max-w-2xl`. Effort S.
- The page stacks 4 always-visible panels (profile form, sign-in email, reset password, danger zone/delete). This reads as complex but is appropriate for an admin "manage this account" screen — each panel is a distinct, infrequent admin action, not a form reception fills daily. No change recommended beyond the width fix.

### users/new — audience: admin — complexity: 1
- Issue: `src/app/(staff)/staff/(dashboard)/users/new/page.tsx:24` — "The new user will receive a **Supabase-backed** account they can sign in with at /staff/login." names the backend vendor/implementation detail to an admin who doesn't need it. → Fix: "The new user will get an account they can sign in with at /staff/login." Effort S.
- Issue: same page-root width miss as its sibling, `users/new/page.tsx:13` (`mx-auto max-w-2xl`). Effort S.

### visits (Visit Records archive) — audience: all staff, esp. reception/admin — complexity: 4
- Fine, but dense — see Top-5 item #5. Every control is individually justified (comments explain why the revenue strip ignores the classification chips, why CSV export mirrors the on-screen sort, etc.), and this is a genuinely multi-purpose page (find a visit, see revenue mix, export). No single obvious cut; flagging the revenue-by-classification strip as the best candidate to move behind a disclosure if the page keeps growing.
- Minor: `src/app/(staff)/staff/(dashboard)/visits/page.tsx` has no page-root width override (uses the shell correctly) — good example other pages should follow.

### visits/[id] (visit detail / bill) — audience: reception + lab/admin (see/act split) — complexity: 5
- Necessarily complex — a visit bill mixes packages, standalone tests, doctor lines, HMO, deletions and payments, and the see-vs-act role split is real regulatory/business logic, not accidental complexity. No simplification recommended for the core structure.
- Minor: `TestAction()` (lines ~1416–1589) is a long branching function for a single table cell, but every branch has a comment explaining a real historical bug it fixes (e.g. the "kind checked before status" comment at line ~1482 documents a real notification bug it prevents) — this is earned complexity, not gold-plating. No fix recommended.
- The status badges elsewhere on the page (package header status, standalone row status) render via `status.replace(/_/g, " ")` (e.g. line 706, 857, 1062) rather than a label map — this reads fine in practice ("ready for release", "in progress") so it is not flagged as jargon, just noted as a place a future non-obvious status code (e.g. a new enum value) would leak raw.

### visits/new (New Visit intake) — audience: reception — complexity: 4
- Issue: `src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx:39-50, 893-896` — when a doctor-consultation/procedure line defaults its clinic fee to ₱0, the page prints the raw phrase **"this doctor is PF split"** directly on the reception screen (not in a tooltip — plain page text). "PF split" is bookkeeper vocabulary (professional-fee compensation arrangement); reception is asked to read and act on it while building the bill. → Fix: reword to plain language, e.g. "this doctor's fee arrangement means the clinic keeps none of the consult fee" — matches the house rule's own worked example (Opening float → "Starting cash"). Effort S.
- Related, lower priority: the same block exposes two always-editable numeric inputs per doctor line, "Clinic fee" and "Doctor's fee (PF)" (lines 860-891) — a genuine accounting split (clinic's cut vs. the doctor's professional fee) that reception must set or accept on every walk-in doctor visit. The `(PF)` abbreviation on the label itself has no plain-language expansion (only a hover `title` explains it). This is arguably load-bearing (reception is the one who knows what was verbally agreed with the doctor that day) so no forced change, but worth a decision: either keep as-is with better labels ("Doctor's fee" instead of "Doctor's fee (PF)", hint stays in the tooltip), or move it behind a "customize the split" disclosure that only appears when reception clicks to change it, defaulting to just showing the total.
- Otherwise well designed: the patient picker (`PatientPicker`) is a clean read-first list with a working search and an honest "first 25 matches" cap notice; the consent nudge banner is non-blocking and correctly worded.

### visits/queue (Reception Queue) — audience: reception — complexity: 3
- Fine. Three plain-English stage tabs ("Waiting for payment", "Processing", "Completed"), day picker with Previous/Next/Back-to-today, live realtime refresh only on today. Good empty-state copy split for today vs. a past day. No excess controls.

### visits/[id]/receipt and visits/group/[groupId]/receipt (printed receipts) — audience: reception (printed artifact) — complexity: 1
- Fine — correctly narrow print-sheet shape, audit-logs the print/view, and `PortalAccessSlip` is a good example of "don't force an inapplicable form" (a consult-only visit with no bill gets a slip with no price lines instead of a receipt template rendering zeros).

### Merge / cross-page ideas
- Cash Drawer's payout/topup/pullout account picker and Petty Cash's category picker are two UIs for the same underlying "pick a plain expense category" problem — unify them (see Top-5 #1) so there's one component/mapping instead of two, one of which leaks accounting jargon.
- `/staff/registration`, the Appointments page header, and the Patients page header all offer the same self-registration QR/link via `RegistrationLinkButton` — this is a deliberate, already-good shortcut pattern (per the drmed-staff-ui skill notes), not overlap to fix.

## Batch B audit

### Top 5 in this batch (highest user-facing payoff first)

1. `admin/result-templates/[service_id]/edit` (template-editor.tsx) — every parameter row renders ~11 always-open fields (name, type, section, header flag, SI unit/range, gender, conv unit/range, factor) plus an age-band ranges block, for every parameter, with no collapse. A CBC/chemistry template with 15–25 params is an enormous always-expanded form. → Collapse each row to a one-line summary (name · type · range) with a Show/Edit disclosure, keep Add/Remove/Reorder on the summary row. Effort M.
2. `results/page.tsx:495-506` — the "mixed status" badges print the raw snake_case DB value (`ready_for_release`, `result_uploaded`) straight to lab staff, unlike every sibling status badge in the app (queue page, test detail) which humanize with `.replace(/_/g," ")` or a label map. → Reuse `RESULT_STATUS_LABEL` (already imported) or add a small label map for the badge text. Effort S.
3. `admin/prices` (prices-table.tsx) — every row of the full services list ships two always-editable inputs (DRMed ₱, HMO ₱) simultaneously, all rows, all the time — the "many inputs visible at once" pattern the audience rules flag. It is well-guarded (confirm modal, dirty highlighting, history disclosure), so this is lower risk than it looks, but for a catalog that can run to 100+ rows it's a lot of live inputs on screen at once. → Consider showing price as text with click-to-edit per cell (same confirm flow), or at minimum a "compact/edit mode" toggle. Effort M (design + rework of existing safeguards).
4. `admin/physicians` (recompute-clinic-fee-button.tsx) — a bulk "Recompute clinic-fee on unreleased tests" maintenance action sits in the header of the physicians roster list, next to "+ New physician", with a jargon-heavy tooltip ("Runs after you classify rent-paying / shareholder doctors. Touches only tests that haven't been released yet."). It's a one-off backfill tool, not a roster action, and nothing on the page explains when a non-technical admin should press it. → Move it under a physician's edit page (near compensation_arrangement, where the classification actually happens) or park it in Hidden Tabs with a description, matching the pattern already used for other rarely-used admin tools. Effort S.
5. `admin/inventory/[id]/page.tsx:245` — movement history timestamps are hand-built (`m.created_at.slice(0, 16).replace("T", " ")`) instead of `manilaDateTime`, which both violates the one-date-format rule and is a real bug: it prints the raw UTC instant unshifted, so every movement time shown to lab/admin staff is 8 hours off Manila time. → Swap in `manilaDateTime(m.created_at)`. Effort S.

### Per page

### queue — audience: lab (medtech/xray/pathologist/admin) — complexity: 1
Fine. Reference-quality list page: `PageHeader`, tab bar kept out of the header actions slot specifically to avoid layout jump (documented reasoning inline), server-side paging/sorting, plain-language subtitle, humanizes status (`card.status.replace(/_/g," ")`). No findings.

### queue/[id] — audience: lab — complexity: 2
- Issue: does not use `PageHeader` (hand-rolled `<h1>` + status pill header, `queue/[id]/page.tsx:357-373`) — page-shape standard miss, lowest priority. → Adopt `PageHeader` with the status pill in `actions`. Effort S.
- Otherwise well-organized: claim/upload/structured/amend surfaces are mutually exclusive and each only renders when applicable; package-header read-only summary is a good pattern for "no work here, go to components."

### queue/consolidated/[visitId]/[groupId] — audience: lab — complexity: 1
Fine. Thin server wrapper around `ConsolidatedForm`; gating logic is well-commented and mirrors the single-test page.

### results — audience: lab/admin — complexity: 3
- Issue: raw snake_case status codes leak to the UI in the "mixed status" badge path — `results/page.tsx:497` (`{statusSummary.status}`) and `:506` (`{e.status} × {e.count}`). Every other status render in this app-area humanizes. → Fix as in Top 5 #2. Effort S.
- Otherwise a strong reference page: honest "post-fetch filter" warning banner, doctor-lines exclusion well explained, folds by visit while preserving sort order.

### signoff — audience: pathologist/admin — complexity: 2
Stub page ("Pathologist sign-off lands here once it's built… UI to come"). Deliberately parked in the admin-only, collapsed "Hidden Tabs" section with a description explaining why (`staff-nav-config.ts:634-639`), so it isn't stumbled into by accident — not a top finding, but flagging because the page itself still leaks dev-project language ("Phase" style status, "queued for a later phase") to any pathologist/admin who does open it. → If pathologist role ever gets real day-to-day access before this ships, reword to a plain "not available yet" without implementation-timeline language. Effort S.

### services — audience: admin — complexity: 2
- Issue: hand-rolled `<header>` instead of `PageHeader` (`services/page.tsx:134-151`) — page-shape miss, lowest priority.
- Otherwise fine: read-first list + Edit link pattern, badges (Signoff/HMO/Send-out) are compact and legible.

### services/[id]/edit (service-form.tsx) — audience: admin — complexity: 2
- Issue: a disabled "Requires pathologist sign-off" checkbox is shown with two lines of explanation that the sign-off queue "isn't built yet" (`service-form.tsx:376-398`) — a dev-status leak on a catalog form, though honestly it's clearly explained rather than a silent no-op. → Low priority: hide the control entirely until the feature ships, rather than showing a locked checkbox. Effort S.
- Good pattern otherwise: price-change confirm modal mirrors the Prices page; send-out COGS fieldset only appears when the send-out checkbox is ticked (not always-open).

### admin/discounts, admin/discounts/[id]/edit, admin/discounts/new — audience: admin — complexity: 1
Fine. Read-first list (Active/Inactive sections) + Edit page; the discount-type-form correctly hides the Rate fieldset for statutory/custom built-ins rather than showing greyed-out fields.

### admin/hmo-providers, .../[id]/edit, .../new — audience: admin — complexity: 1
Fine. Same read-first + edit pattern; provider list row is a dense one-liner (terms · contract end · contact) which is appropriate density for admin catalog data, not clutter.

### admin/inventory — audience: admin/lab — complexity: 2
- Reception + pathologist role check at top (`page.tsx:78-81`) is dead code — an empty `if` block with a comment ("Strictly speaking pathologist could view too") that does nothing. → Either implement the intended redirect or delete the no-op block. Effort S.
- Otherwise a good list page: scope tabs (All/Low/Expiring) as real WHERE-clause counts, not post-fetch filters; section dropdown deliberately unfiltered so it doesn't collapse.

### admin/inventory/[id] — audience: admin/lab — complexity: 2
- Issue: hand-built timestamp, see Top 5 #5 (`page.tsx:245`).
- MovementForm (record movement) is a single always-visible form below the item summary, not a per-row edit form — appropriate for "log an event," not a complexity issue.

### admin/inventory/[id]/edit, admin/inventory/new (item-form.tsx) — audience: admin — complexity: 1
Fine, not separately reviewed beyond line count — same established form pattern as physicians/hmo-providers/discounts.

### admin/physicians — audience: admin — complexity: 3
- Issue: recompute-clinic-fee bulk action misplaced on the roster list header — see Top 5 #4.
- Otherwise clean: grouped-by-`group_label` sections, "by appointment only" vs schedule-count badge is a nice at-a-glance signal, read-first + Edit pattern.

### admin/physicians/[id]/edit, admin/physicians/new (physician-form.tsx) — audience: admin — complexity: 1
Fine. Compensation-arrangement select with a plain-language hint under it; slug pattern comment correctly documents the RegExp `v`-flag trap.

### admin/physicians/[id]/schedule — audience: admin — complexity: 1
Fine. Read-first list of recurring blocks / overrides, each with its own "Add a block / Add an override" form below (not inline-editable rows), delete buttons per row. Appropriately scoped page (`mx-auto max-w-3xl` — a deliberately narrow admin form page per the page-shape rule's exception).

### admin/prices — audience: admin — complexity: 3
- Issue: always-open per-row price inputs across the whole catalog — see Top 5 #3.
- Good mitigations already in place: confirm-before-save modal that diffs before/after price, dirty-row highlighting, collapsible per-row history panel (not always-open), search + section filter.

### admin/result-templates (index) — audience: admin — complexity: 2
Fairly technical language ("0 parameters — the encoding form is broken", `report_group_service_params`) but this is a lab-catalog debugging surface for the admin managing templates, and the audience rule allows load-bearing technical terms for admin/bookkeeper screens. The four-section layout (report groups / with template / eligible / send-out) is a reasonable index, not tab material (these aren't "views of the same thing," they're disjoint buckets) — no SectionTabs violation.
- Usage check wanted: whether `report_group_service_params` "no mappings" warning has ever actually fired in prod (would confirm the health-check UI earns its keep vs. being permanently green noise).

### admin/result-templates/[service_id]/edit — audience: admin — complexity: 5
See Top 5 #1. This is the single most complex page in the batch by a wide margin (830-line client component, ~11 always-visible fields per parameter row plus a nested ranges editor).

### admin/result-templates/group/[group_id]/edit — audience: admin — complexity: 4
Same `TemplateEditor` component as the service-level editor (830 lines, always-open param rows) plus a group-specific per-param service-mapping chip row and a separate `encoding-preview.tsx` / `superseded-templates.tsx`. Same fix as Top 5 #1 applies here too — fixing the shared `TemplateEditor` component fixes both routes at once.

### admin/result-templates/health — audience: admin — complexity: 1
Fine. Clear severity-grouped findings list, explicit staleness banner for the daily cron check, plain "no findings" empty state.

### Merge / cross-page ideas

- `template-editor.tsx` is shared by both `/staff/admin/result-templates/[service_id]/edit` and `/staff/admin/result-templates/group/[group_id]/edit` — the collapse-to-summary fix (Top 5 #1) only needs to happen once to benefit both routes.
- The "recompute clinic-fee" button (physicians list) and the "Requires pathologist sign-off" locked checkbox (service form) are both maintenance/future-feature controls stranded on otherwise-simple catalog pages. Consider a light convention already used elsewhere in this app (Hidden Tabs' `description` field) for surfacing "not a day-to-day control" context, rather than ad hoc tooltips/inline paragraphs on each page.
- `admin/prices` and `services/[id]/edit` both implement a near-identical "confirm price change with before/after diff" modal independently (`prices-table.tsx` `ConfirmModal` vs `service-form.tsx`'s inline dialog). Worth factoring into one shared component so the confirm UX (and any future audience-language tweaks) only needs to change once.

## Batch C audit — Accounting part 1 (hub, accrual templates, AP, bank-rec, chart of accounts)

Scope note: Cash Routing and Payment Routing were excluded per instructions (already being
redesigned) and not reviewed. `admin/accounting/cogs/*`, `hmo-claims/*`, `journal/*`,
`patient-ar`, `pf-payouts/*`, `pf-ytd-summary`, `periods`, `variance` are outside this batch
and were not reviewed either.

### Top 5 in this batch (highest user-facing payoff first)

1. **chart-of-accounts (new/edit)** — "Parent account" dropdown lists all ~64 active accounts
   flat, unfiltered by the Type already picked above it, with only a hint asking the user to
   self-check "must be the same type" → group the options with `<optgroup>` per type (same
   pattern already used in the accrual-template line editor) or filter client-side once Type
   changes. Effort M.
2. **AP bills/payments (list + detail + new-bill "paid on entry")** — raw snake_case values
   leak to bookkeepers in several spots: the bill-status filter renders `partially_paid`
   literally, and the payment-method select in the New Bill "paid on entry" section renders
   `bank_transfer` literally — even though a working `METHOD_LABEL` map already exists (just
   private to one file). → export/reuse `METHOD_LABEL` and add a `STATUS_LABEL` for bill
   status, apply everywhere. Effort S.
3. **AP vendors detail** — a second, hand-rolled `StatusBadge` is defined locally in
   `vendor-detail-client.tsx` instead of importing the shared one, and its palette keys off
   `"partial"` — a status value bills never actually have (the real value is
   `"partially_paid"`) — so every partially-paid bill on a vendor's page silently renders the
   default gray "unknown status" badge instead of the amber it should. Effort S.
4. **Accounting sync ("Rewind & re-sync")** — the form's own copy says this action **will**
   duplicate already-exported rows in the external Google Sheet (no upsert), yet the submit
   button has no confirmation step — inconsistent with the Void-bill flow a few clicks away,
   which requires a typed reason in a confirm dialog for a much less destructive action.
   Effort S.
5. **Recurring templates + several list/detail pages** — the page subtitle names the raw DB
   column `next_run_date` to a bookkeeper ("the cron handler picks up templates where
   `next_run_date` is on or before today"); the same page and several others (vendor detail,
   bank-rec list/detail) print dates as raw ISO (`2026-05-15`) instead of the house
   `manilaDate` format (`May 15, 2026`). Effort S.

### Per page

### admin/accounting (Accounting sync / "External Sync Status") — audience: admin — complexity: 2
- Fine as a page: correctly scoped (it's a Sheets-export status board, not a general
  "accounting hub" — the sidebar description in `staff-nav-config.ts:409-414` already frames
  it that way, so no complexity finding there).
- Issue: `admin/accounting/page.tsx:49` — page root has its own `mx-auto max-w-4xl` and a
  hand-rolled eyebrow/h1 instead of `PageHeader`, unlike its sibling AP/bank-rec pages. →
  Fix: adopt `PageHeader`, drop the page-owned width. Effort S.
- Issue: `accounting-actions.tsx` "Rewind & re-sync" has no confirm step despite self-warning
  of duplicate exports (see Top 5 #4). → Fix: reuse the `Dialog` + typed-reason pattern from
  `bill-detail-client.tsx`'s Void confirmation. Effort S.

### admin/accounting/accrual-templates — audience: bookkeeper — complexity: 2
- Fine: read-first list with Active/All toggle, clear "Apply" action, no always-open editing.
- Issue: `accrual-templates/page.tsx:53` — page owns its layout without `PageHeader`/shell
  width (low priority, page-shape only). Effort S.

### admin/accounting/accrual-templates/[id] (edit) — audience: bookkeeper — complexity: 2
- Fine: the line-editor groups accounts by type via `<optgroup>` (`template-form.tsx:280-290`)
  — this is the pattern chart-of-accounts' parent picker (Top 5 #1) should copy.
- Issue: `accrual-templates/[id]/page.tsx:59` — `mx-auto max-w-4xl` on the page root; should
  live on the form only per the "narrow form, not narrow page" rule. Effort S.

### admin/accounting/accrual-templates/new — audience: bookkeeper — complexity: 1
- Fine as-is; same minor page-shape note as `[id]`.

### admin/accounting/ap (dashboard) — audience: bookkeeper — complexity: 1
- Fine as-is — this is the model page in the batch: `PageHeader`, layout-owned tab bar, five
  clearly labelled KPI cards, each with a "view more" link to the right sub-page. No changes.

### admin/accounting/ap/bills (list) — audience: bookkeeper — complexity: 3
- Issue: `ap/bills/bills-index-client.tsx:258-264` — status filter `<option>` renders the raw
  value (`draft`, `partially_paid`, `voided`, …) with no label. → Fix: shared `STATUS_LABEL`
  map (Top 5 #2). Effort S.
- Issue: `ap/bills/bills-index-client.tsx:349` and `ap/bills/[id]/bill-detail-client.tsx:183`
  — `StatusBadge` (`src/lib/ui/status-badge.tsx`) prints the raw `status` string as badge text
  with no label, only a color. Same fix as above. Effort S.
- Otherwise fine: real server-side paging with an honest "showing first N" notice, sortable
  columns, filter Apply/Clear.

### admin/accounting/ap/bills/[id] (detail) — audience: bookkeeper — complexity: 2
- Fine: read-first with Edit/Post/Delete/Void gated by status, KPI grid, Void requires a typed
  reason in a confirm dialog (a good pattern — see Top 5 #4).
- Issue: `bill-detail-client.tsx:355` — payment method shown raw (`payment.method`) instead of
  humanized. Same root cause as Top 5 #2.

### admin/accounting/ap/bills/[id]/edit — audience: bookkeeper — complexity: 2
- Fine: reuses the New Bill form, blocked with a `redirect` if the bill is no longer a draft
  (`edit/page.tsx:21`) rather than silently allowing edits on posted bills. No new issues
  beyond what's already logged for `bills/new`.

### admin/accounting/ap/bills/new — audience: bookkeeper — complexity: 3
- Issue: `bill-form-client.tsx:623-627` — the "paid on entry" payment-method `<select>`
  renders raw values (`bank_transfer`, `cheque`) instead of the `METHOD_LABEL` already defined
  a few files away in `payments-index-client.tsx`. Fix: promote that map to
  `src/lib/accounting/labels.ts` (or similar) and import it here too. Effort S.
- Otherwise good: accounts dropdowns are pre-filtered server-side (debit-normal only /
  cash accounts only), the "paid on entry" section is progressively disclosed behind a
  checkbox rather than always shown, and it carries a closed-day warning for till payments.

### admin/accounting/ap/payments (list) — audience: bookkeeper — complexity: 1
- Fine — this is the correct reference implementation: `METHOD_LABEL`/`methodLabel()` used
  consistently in both the filter and the table, dates through `manilaDate`. Promote its label
  map for reuse elsewhere (see Top 5 #2) rather than changing this page.

### admin/accounting/ap/payments/[id] (detail) — audience: bookkeeper — complexity: 2
- Issue: `payment-detail-client.tsx:165` — subtitle shows raw `payment.method` instead of
  `methodLabel(payment.method)`. Effort S.

### admin/accounting/ap/payments/new — audience: bookkeeper — complexity: 2
- Fine: uses `PageHeader`, clear subtitle, closed-day warning reused from the bill form.
- Issue: `payments/new/page.tsx:29` — page-owned `mx-auto max-w-3xl` (low priority, page-shape
  only).

### admin/accounting/ap/quick-expense — audience: **owner/reception-adjacent** — complexity: 1
- Fine — the best-designed form in the batch: plain English throughout ("Paid from — Where did
  the money come from?"), human category labels, a friendly success message that also explains
  the cash-drawer side-effect ("Recorded as a cash-drawer payout — it also shows under Cash
  Drawer › Petty Cash"). No changes suggested.

### admin/accounting/ap/recurring — audience: bookkeeper — complexity: 2
- Fine shape: read-first table, Edit opens a Dialog (not an always-open row), Deactivate/
  Reactivate toggle instead of delete.
- Issue: `recurring/page.tsx:37` — subtitle names the raw DB column `next_run_date` in the
  page copy. → Fix: "the cron handler picks up templates whose next run date is on or before
  today" (drop the `<code>` column name). Effort S.
- Issue: `recurring-client.tsx:164` — `next_run_date` rendered as raw ISO (`2026-05-15`)
  instead of `manilaDate`. Effort S.

### admin/accounting/ap/vendors (list) — audience: bookkeeper — complexity: 1
- Fine as-is; clear append-only/deactivate framing in the subtitle.

### admin/accounting/ap/vendors/[id] (detail) — audience: bookkeeper — complexity: 3
- Issue: `vendor-detail-client.tsx:74-90` — local duplicate `StatusBadge` with a stale key
  (`"partial"` vs. the real `"partially_paid"`) — see Top 5 #3. Fix: delete the local
  component, import `@/lib/ui/status-badge`, and use the fixed `STATUS_LABEL` map from #2.
  Effort S.
- Issue: `vendor-detail-client.tsx:251-252` — bill dates rendered raw ISO instead of
  `manilaDate`. Effort S.

### admin/accounting/ap/vendors/[id]/edit — audience: bookkeeper — complexity: 1
- Fine — same well-scoped form as `vendors/new`.

### admin/accounting/ap/vendors/new — audience: bookkeeper — complexity: 1
- Fine — accounts dropdown pre-filtered to debit-normal accounts server-side.

### admin/accounting/bank-rec (list) — audience: bookkeeper — complexity: 2
- Fine shape: clear subtitle explaining auto-match, honest empty state, visual match-progress
  bar per statement.
- Issue: `bank-rec/page.tsx:47` — hand-rolled header instead of `PageHeader` (low priority).
- Issue: `bank-rec/page.tsx:95` — period shown as raw ISO strings (`period_start → period_end`)
  instead of `manilaDate`. Effort S.

### admin/accounting/bank-rec/[id] (detail/matching) — audience: bookkeeper — complexity: 3
- The matching UI itself is appropriately complex for what it does (candidate suggestions
  ranked by amount-then-date-proximity) — not flagged as over-complicated.
- Issue: `bank-rec/[id]/page.tsx:251-346` — transaction dates rendered raw ISO in three places
  (`{l.transaction_date}`, `{statement.period_start} → {statement.period_end}`) instead of
  `manilaDate`. Effort S.
- `match_method` (`auto`/`manual`, `bank-rec/[id]/page.tsx:375`) is plain English already —
  not a jargon issue.

### admin/accounting/bank-rec/upload — audience: bookkeeper — complexity: 1
- Fine — genuinely well-designed: plain step-by-step instructions, collapsible CSV field guide
  and example, explicit signed-amount convention explained in place. No changes suggested.

### admin/accounting/chart-of-accounts (list) — audience: bookkeeper — complexity: 2
- Fine shape: grouped by type, filter chips (All/Active/Inactive), search, sortable columns,
  read-first rows with Edit/Deactivate — a good reference implementation.
- Issue: `chart-of-accounts/page.tsx:50-55` — hand-rolled header repeats the identical string
  ("Chart of Accounts") as both eyebrow and `<h1>`, which is what `PageHeader`'s `eyebrow` prop
  is meant to avoid (an eyebrow that isn't the title). Low priority. Effort S.

### admin/accounting/chart-of-accounts/[id]/edit — audience: bookkeeper — complexity: 3
- Issue: `account-form.tsx:95-108` — "Parent account" dropdown lists all ~64 accounts flat
  regardless of the Type just selected, relying on a hint text ("Must be the same type") for
  the user to self-filter. This is the flagship example of the "too many controls" pattern
  called out in the audit brief. See Top 5 #1. Effort M.
- Otherwise fine: Code is read-only in edit mode with a clear reason, Active/Settlement
  destination checkboxes both carry explanatory hints.

### admin/accounting/chart-of-accounts/new — audience: bookkeeper — complexity: 2
- Same parent-account issue as `[id]/edit` (Top 5 #1).

### Merge / cross-page ideas

- **Promote the payment-method and bill-status label maps to a shared module**
  (e.g. `src/lib/accounting/labels.ts`), used today only inside
  `ap/payments/payments-index-client.tsx`. Every other place that shows a bill status or
  payment method (bills list filter, bill detail, bill form, payment detail, vendor detail)
  would pick it up for free and the vendor-detail bug (#3) disappears at the same time. This
  single change closes 3 of the Top 5 findings. Effort S–M for the whole sweep.
- **Chart-of-accounts optgroup-by-type** is already proven working code in
  `accrual-templates/template-form.tsx:280-290` (`accountsByType` + `<optgroup>`) — the same
  ~15 lines can be lifted into `account-form.tsx`'s parent-account select rather than inventing
  a new approach. Effort S once copied.
- No page-overlap / merge-candidate pairs were found in this batch — Quick expense vs. Vendor
  bills, and Accrual templates vs. Journal, are already clearly differentiated with in-page
  cross-links ("For invoices with a due date, use Vendor bills instead").
- **Usage check worth running before investing further here:** `accrual_templates` row count
  and `recurring_bill_templates` row count in prod — if either is near-zero, the optgroup /
  label-map fixes above are still worth doing (they're cheap and fix real bugs), but a bigger
  investment in either page would be premature.

## Batch D audit

### Top 5 in this batch (highest user-facing payoff first)
1. `admin/accounting/hmo-claims/[providerId]` — the page fetches billed/paid/written-off historic claims for this provider (3 separate DB queries) but the client component explicitly discards all three ("unused in this minimal restore") → wire the three tabs back in so a bookkeeper can see a provider's resolved historic claims without leaving the provider page, or delete the dead queries if genuinely not needed. Effort M (re-add tabs) / S (delete dead queries).
2. `admin/accounting/hmo-claims` (index) — "All unbilled" and "All aging" are ~250-line near-duplicate table implementations (search, sort, paginate, bulk-select, CSV export, resolve modals) copy-pasted with different field names → extract one generic table component the two configure. Effort L.
3. `admin/accounting/cogs/send-outs` and `admin/accounting/pf-payouts` — each hand-rolls an identical "count-badge underline tab bar" (`send-outs-client.tsx` and `pf-payouts-client.tsx` have byte-for-byte-similar markup/classes) instead of sharing one component → extract a small `CountTabs` client component. Effort S–M.
4. `admin/accounting/cogs/send-outs/send-outs-client.tsx:96` — `vendors` prop is fetched, threaded through, and explicitly marked "reserved for future vendor-picker extension" but never rendered → drop the prop and the page-level fetch until the feature exists, or build the picker. Effort S.
5. Page-shape: batch-wide — every page in this batch except `financial-statements/*` hand-rolls its `<header>` (eyebrow `<p>` + `<h1>` + subtitle `<p>`) instead of the shared `PageHeader` component that `financial-statements/*` already uses correctly with `eyebrow={SECTION_NAME[...]}`. Affects `cogs/send-outs*`, `hmo-claims*`, `journal*`, `patient-ar`, `periods`, `pf-payouts*`, `pf-ytd-summary`, `variance`. Mechanical, one file at a time. Effort S each.

### Per page
### admin/accounting/cogs/send-outs/send-outs-client.tsx — audience: bookkeeper — complexity: 2
- Fine overall: Accrued/True-ups view toggle is a plain client-state switch (not a URL tab, appropriately — there's no per-tab deep link need), zero-cost rows get a clear "missing" pill with a tooltip explaining why.
- Issue: `send-outs-client.tsx:93-107` — `vendors` prop accepted and threaded through but never used; comment says "reserved for future vendor-picker extension" → Fix: drop the fetch/prop pair in `page.tsx:48-52` until it's used. Effort S.
- Issue: hand-rolled `<header>` (`page.tsx:56-67`) instead of `PageHeader`. Effort S.

### admin/accounting/cogs/send-outs/unconfigured — audience: bookkeeper — complexity: 1
- Fine as-is. Simple filtered list + link to fix each row; good empty state.

### admin/accounting/cogs/send-outs/vendor-performance — audience: bookkeeper/admin — complexity: 3
- Fine for the audience — a 9-column TAT/SLA/variance table is genuinely what an admin needs to judge a lab vendor, and the footer note explains every derived figure (`page.tsx:434-439`).
- Usage check wanted: row count of `cogs_send_out_trueups` / `cogs_send_out_entries` on prod — if the clinic uses one outside lab almost exclusively, per-vendor breakdown may be more detail than needed most days.

### admin/accounting/financial-statements (+ balance-sheet, cash-flow) — audience: bookkeeper — complexity: 2
- Fine — the reference implementation in this batch: uses `PageHeader` with `eyebrow=SECTION_NAME`, `SectionTabs` via `StatementTabs`, `PeriodPresets`, and each page's "How this is computed" `<details>` explains the accounting mechanics in plain language. No changes needed.
- Minor, not worth a fix: each page shows both a "Quick periods" pill row and a manual start/end date `<form>` with its own "Recalculate" button — two controls for the same job, but the form is needed for a custom range so this is acceptable overlap, not complexity to remove.

### admin/accounting/hmo-claims (index) — audience: bookkeeper — complexity: 4
- Genuinely complex domain (per-provider AR, unbilled, aging, batches) and mostly earns it — the `KindToggle` (All/Lab/Doctor) + `ViewToggle` (4 views) + consolidated totals strip is a lot of concurrently visible chrome, but every control does distinct, needed work.
- Issue: `hmo-claims-client.tsx` `AllUnbilled` (≈826-1213) and `AllAging` (≈1215-1584) are near-identical — see Top 5 #2.
- Issue: hand-rolled `<header>` (`page.tsx:84-109`) instead of `PageHeader`; eyebrow and `<h1>` both read "HMO Claims" — harmless but redundant. Effort S.

### admin/accounting/hmo-claims/[providerId] — audience: bookkeeper — complexity: 3
- See Top 5 #1 — the Billed/Paid/Written-off tabs are fetched and thrown away (`provider-detail-client.tsx:59-63`); only Batches/Unbilled/Aging render.
- Otherwise fine: batches table has a "Show voided" checkbox (off by default) rather than always showing voided rows, and the Unbilled tab's live-vs-historic mixed-selection guard (`provider-detail-client.tsx:472-476`) gives a clear plain-language message instead of a silent no-op.

### admin/accounting/hmo-claims/[providerId]/historic/[claimId] — audience: bookkeeper — complexity: 2
- Fine. Read-first detail page with a single `SingleClaimActions` control cluster, an audit "Activity" log, and sibling-claims total — good shape, no always-open forms.

### admin/accounting/hmo-claims/aging-snapshots — audience: bookkeeper — complexity: 1
- Fine. Simple date-picker pill row + matrix table; good empty state when no snapshot exists yet.

### admin/accounting/hmo-claims/batches/new — audience: bookkeeper — complexity: 2
- Fine. Good "why nothing shows" explanation when a provider has no live unbilled items (`page.tsx:158-178`), and the item table visibly locks out cross-kind selection with a titled, disabled checkbox rather than allowing an invalid submission (`new-batch-client.tsx:196-217`).

### admin/accounting/hmo-claims/batches/[batchId] — audience: bookkeeper — complexity: 3
- Fine — `ActionsBar` shows only the buttons valid for the batch's current status (draft/submitted/acknowledged/paid/rejected), which keeps the control count proportional to what can actually be done; modals are used correctly (not always-open forms). No changes needed.

### admin/accounting/journal (list) — audience: bookkeeper — complexity: 3
- Fine. The 6-field filter form is filtering, not editing, and the Account `<select>` already groups by Expense vs Other rather than dumping all ~64 CoA rows flat (`page.tsx:415-436`) — the pattern the house rule warns against is avoided here.
- Issue: hand-rolled header (`page.tsx:292-317`) instead of `PageHeader`. Effort S.

### admin/accounting/journal/[id] — audience: bookkeeper — complexity: 1
- Fine. Read-first detail (lines table + cross-link panel), Post/Delete actions only shown for drafts.

### admin/accounting/journal/new — audience: bookkeeper — complexity: 2
- Fine. Debit/credit inputs on a line disable each other so a line can't have both (`manual-je-form.tsx:264,277`), live balance check with a plain-language "Off by ₱X" message, and a clear "Post immediately vs Save as draft" radio with an explanatory sentence underneath.

### admin/accounting/patient-ar — audience: bookkeeper — complexity: 2
- Fine. Aging buckets computed from an honest full-scope fetch (`fetchAllRows`, not a silent `.limit()`), zero-balance "unpaid" rows are filtered out of both the table and the bucket totals so the count on screen matches what's collectible.

### admin/accounting/periods — audience: bookkeeper — complexity: 2
- Fine. Close/Reopen use an inline confirm-with-reason sub-form rather than an always-open editor, and "Reopen" requires a non-empty reason before the button enables (`period-actions-client.tsx:37-41`) — a good example of the "dangerous control needs friction" rule.

### admin/accounting/pf-payouts (+ [id], slip, guide) — audience: **owner** (plain-language target) — complexity: 2
- Fine — this is the best plain-language page in the batch: "Ready to pay / Waiting on insurance / Already paid" tab labels, a numbered "How this works" box on the index, and a printable one-page guide with the exact click sequence. Confirms load-bearing wording ("Waiting on insurance" ≠ accounting jargon) matches the audience rule.
- Minor, already in Top 5 #3: duplicates the send-outs tab-bar markup instead of sharing a component.

### admin/accounting/pf-ytd-summary — audience: owner/bookkeeper — complexity: 2
- Fine. Column headers are plain language ("Earned", "Earned & confirmed", "Paid out", "Still owed") with a footer sentence defining "Still owed" and covering the one confusing case (negative balance from prior-year carryover).

### admin/accounting/variance — audience: bookkeeper — complexity: 2
- Fine. Budget is edited inline per row (click "Set budget"/"Edit" → small inline form → Save), not an always-open editable grid; favorable/unfavorable coloring is direction-aware per account type and explained in the footer note.

### Merge / cross-page ideas
- `SummaryTile` (label/value/hint/tone accent-bar card) is defined independently in at least four files in this batch (`cogs/send-outs/vendor-performance`, `financial-statements/cash-flow`, `pf-ytd-summary`, `variance`) with identical markup — worth promoting to `src/components/staff/` once a fifth copy appears elsewhere in the app.
- The "count-badge underline tab bar" pattern (send-outs, pf-payouts) and the "navy pill toggle" pattern (HMO claims' `KindToggle`/`ViewToggle`, provider detail's tab nav) are two more ad hoc chrome patterns repeated 2-4 times each across this batch; neither reuses `SectionTabs` or `section-tabs-style.ts` helpers because they're client-state-driven rather than URL-driven. If a future PR adds a client-state variant of `SectionTabs` (the way `client-table-controls.tsx` already does for sortable headers/pagination), all of these could consolidate onto it.
- HMO Claims index vs. `[providerId]` detail: the index's "All unbilled"/"All aging" tabs already let a bookkeeper filter to one provider via the search box, so once Top 5 #1 is fixed, consider whether the provider page's own Unbilled/Aging tabs are still pulling their weight or could link out to the index pre-filtered instead — not urgent, just worth a look during the fix.

## Batch E audit

Scope: 44 admin routes. Repo: `/Users/jamila/Claude/DRMed/.worktrees/money-routing`. All paths below are relative to
`src/app/(staff)/staff/(dashboard)/`. This was a read-only audit. The high-value claims were checked against the source:
DTR commit, holidays re-enable, run-status pill, settings Save buttons, the import having no duplicate check, the merge
confirm and undo, the gift-code sales fallback, daily-revenue `service_kind`, the dashboard-cards id, and staff-advances
status.

### Top 5 in this batch (highest user-facing payoff first)
1. admin/payroll/runs/[id]/dtr — "Commit import" looks like a required second step, but it does nothing. The rows were already saved when the admin clicked Parse; `commitDtrAction` only writes an audit row (`admin/payroll/runs/[id]/dtr/actions.ts:296-320`, button at `dtr-upload-client.tsx:479-497`) → Remove the Commit step and relabel Parse as "Import", or make Commit real (rows stay pending until it is clicked). (M)
2. admin/import-patients — Clicking Import inserts up to 2,000 patients at once. There is no preview and no duplicate check (`admin/import-patients/actions.ts:96-104`; the only safeguard is a manual tip at `page.tsx:49-50`), so running the same file twice creates duplicate patients → Add a preview step that says "N rows, M look like existing patients (name + birthdate)", and require a confirm before inserting. (M)
3. admin/payroll/holidays — A holiday that has been disabled can't be turned back on in the app. The page just says "Disabled (re-enable via DB)" (`admin/payroll/holidays/holidays-client.tsx:247`, `:306`) → Add an Enable button and a matching reactivate action. (M)
4. admin/payroll/settings — Each of the 19 payroll settings has its own input and its own Save button (`admin/payroll/settings/settings-client.tsx:180-284`, Save at `:272`). Changing the four holiday-pay multipliers takes four separate saves → Use one Save per category, or a sticky "Save N changes" bar. (M)
5. admin/operations/cron-health — the page looks broken. `admin/operations/layout.tsx:6-14` wraps every route under Operations, with no opt-out, in the `OperationsTabs` bar labelled "Daily Monitoring" (Daily Sheet | Daily Revenue | Cash & Cards | Expenses & P&L | HMO Receivables | Monthly Trends, `operations-tabs.tsx:11-18`) — but Cron Health isn't one of those six tabs, so an admin opening it sees an unrelated 6-tab bar with nothing highlighted. The page then double-pads itself, wrapping its own content in the same `px-4 py-8 sm:px-6 lg:px-8` the layout already applies one level up (`cron-health/page.tsx:39` vs `layout.tsx:7`), and its eyebrow reads "Daily Monitoring" even though it isn't one (`page.tsx:41`). The "Scheduled Task" column also prints the raw route path, e.g. `db-backup` or `template-health?mode=weekly` (`page.tsx:76`, `cron.path.replace("/api/cron/", "")`) → Fix: give Cron Health its own layout so it stops inheriting `OperationsTabs`, drop its now-redundant padding wrapper and Daily-Monitoring eyebrow, and add a plain label per scheduled task ("Weekly template health summary") instead of the raw path. (M)
6. Raw database codes on four other admin pages. Staff advances shows `paid_off`/`written_off` (`admin/reports/staff-advances/page.tsx:218`). Pay runs shows `draft`/`computed`/`finalised` (`admin/payroll/runs/runs-client.tsx:292-306`). Gift-code sales falls back to the raw status (`admin/gift-codes/sales/page.tsx:286-287`). Daily Revenue shows `service_kind` plus the raw service code (`admin/operations/daily-revenue/page.tsx:61`) → Use the label maps that already exist: `RUN_STATUS_LABEL` in `run-review-client.tsx:128-133`, `STATUS_LABELS` in `src/lib/gift-codes/labels.ts`, and a small label map for advances and service kinds. (S)

### Per page

### admin/reports/daily-revenue — audience: admin — complexity: 1
- fine — this is only a permanent redirect to `admin/operations/daily-revenue` (`page.tsx:8-13`). The sidebar test already asserts that no nav item points at it (`src/components/staff/staff-nav-config.test.ts:686`). It stays only so old bookmarks keep working.

### admin/reports/deleted-entries — audience: admin — complexity: 2
- Issue: the header is built by hand with a "← Dashboard" link plus an `<h1>` (`page.tsx:112-128`) instead of `PageHeader` → Fix: use `PageHeader`. Effort S.
- Otherwise fine. The date filter keeps sort and page size, the summary tiles are plain, the cap message is shown on the page (`:213-218`), and the empty state is clear.

### admin/reports/lab-tat — audience: admin — complexity: 2
- Issue: the subtitle shows database column names in code font: `released_at − requested_at` and `services.turnaround_hours` (`page.tsx:63-66`). "TAT", "P95" and "SLA" (`:59`, `:159`, `:162`) are never spelled out → Fix: "Turnaround time = from when the test was ordered to when the result was released. A test is late when it takes longer than the turnaround promised for that service." Add a one-line hint for "P95 = 95% of tests were faster than this". Effort S.
- Issue: the page heading doesn't match the sidebar. The `<h1>` (`:59`) and `metadata.title` (`:19`) say "Lab TAT analytics", while the sidebar says "Lab Turnaround Time" (`src/lib/staff/route-names.ts:37`) → Fix: use `ROUTE_NAME` in a `PageHeader`. Effort S.

### admin/reports/patients-without-consent — audience: admin — complexity: 2
- fine — it has a clear purpose line, a count, a link to the gate settings, a good empty state ("Safe to enable the consent gate", `page.tsx:143-144`), and real paging. The only miss is page shape: the header is built by hand (`:115-138`) instead of `PageHeader`. Effort S.
- Usage check wanted: `patients` with no `patient_consents` row (the number that decides whether the gate can be switched on).

### admin/reports/staff-advances — audience: admin — complexity: 2
- Issue: the Status column prints the raw value (`page.tsx:218`). Possible values are `requested/approved/active/paid_off/written_off/voided` (`supabase/migrations/0044_payroll.sql:269`) → Fix: map them to "Requested", "Approved", "Active", "Paid off", "Written off", "Voided". Effort S.
- Issue: the Role column also prints the raw role (`:173`) → Fix: humanize it the same way (e.g. `xray_technician`). Effort S.
- Issue: the page heading doesn't match the sidebar. The `<h1>` and title say "Staff advances" (`:32`, `:152`), while the sidebar says "Staff Cash Advances" (`src/lib/staff/route-names.ts:28`). The kicker reads "Books & Reports", but the item sits in the Payroll group. There is also no subtitle explaining what an advance is → Fix: a `PageHeader` using `ROUTE_NAME`, plus a one-line subtitle. Effort S.
- Usage check wanted: `staff_advances` row count. The page sits in the Payroll sidebar group (`src/components/staff/staff-nav-config.ts:311`), and if the table is empty, the page could be parked.

### admin/reports/stuck-tests — audience: admin — complexity: 3
- Issue: the "Package headers with no test lines" explainer mentions "(the 0130 migration shape)" (`page.tsx:393`), a developer reference → Fix: replace it with "ask support to repair the missing tests". Effort S.
- The rest is fine. It uses `PageHeader`, statuses are shown in words, and each of the four sections explains itself and has a clear "None — …" empty state. The length is justified by the investigation work the page is for.

### admin/reports/undone-releases — audience: admin — complexity: 2
- fine — the outcome column is in plain words (`page.tsx:315-336`), cascade rows are explained, and the tiles are clear. The only miss is page shape: the header is built by hand (`:109-125`). Effort S.

### admin/operations — audience: admin — complexity: 3
- Issue: the page opens as a wall of numbers: 9 summary tiles, the month/day matrix, and the per-doctor panel, which is also expanded by default (`<details open>`, `admin/operations/_components/doctor-panel.tsx:35`) → Fix: make the doctor panel start collapsed. Effort S.
- The tab bar is fine: `OperationsTabs` carries `from`/`to` via `carryParams` (`operations-tabs.tsx:29-31`).

### admin/operations/cash — audience: admin — complexity: 3
- Issue: the section title "Credit card (Veritas Pay)" (`admin/operations/cash/_components/credit-card-panel.tsx:73`) shows the payment processor's brand name with no explanation → Fix: title it "Credit card" and mention Veritas Pay in the hint line (`:77`). Effort S.
- The rest is fine: collapsible panels, and payment channels are shown in words.

### admin/operations/cron-health — audience: admin — complexity: 4
- Issue: forced into the wrong tab bar. `admin/operations/layout.tsx:6-14` wraps every route under Operations — no opt-out — in `OperationsTabs` (`operations-tabs.tsx:11-18`, six financial-period tabs), but Cron Health owns none of those tabs, so the page renders under a 6-tab bar with nothing highlighted. This is the exact case the skill itself warns about ("a tab bar has to be a set of views, not a set of URLs") and the skill's own notes say Cron Health should NOT join `OperationsTabs` — the layout doesn't honor that. → Fix: give `cron-health/` its own nested layout (or move it out of the `operations/` route tree) so it renders standalone. Effort M.
- Issue: double padding. `cron-health/page.tsx:39` wraps its content in `px-4 py-8 sm:px-6 lg:px-8`, the same classes the inherited `operations/layout.tsx:7` already applies one level up → Fix: drop the page's own wrapper once it's no longer nested under the shared layout (same PR as above). Effort S.
- Issue: wrong eyebrow. `page.tsx:41` sets `eyebrow={SECTION_NAME["/staff/admin/operations"]}` = "Daily Monitoring", which doesn't describe a scheduled-job heartbeat page → Fix: give it its own eyebrow or omit it once decoupled. Effort S.
- Issue: raw dev route names shown to admin. The "Scheduled Task" column renders `cron.path.replace("/api/cron/", "")` (`page.tsx:76`) — e.g. `db-backup`, `template-health?mode=weekly` (the last literally shows a raw query string) → Fix: add a plain `label` field per entry in `CRON_HEARTBEATS` ("Accounting sync", "Weekly template health summary") and render that instead of the path. Effort S.
- Otherwise good: Healthy/Pending/Stale/Unavailable are explained in plain words (`page.tsx:45-50`).

### admin/operations/daily-revenue — audience: admin — complexity: 2
- Issue: each row prints `<code>{service_code}</code>` and the raw `service_kind` (`page.tsx:61`) → Fix: show the kind in words and drop the code, or move it to a tooltip. Effort S.
- Issue: the date form is a bare, hand-built one (`:36-41`), while all four sibling Operations tabs use the shared `DateControls` with This month / This year / Last year buttons → Fix: use `DateControls`. Effort S.
- Issue: each day's section heading prints the raw ISO date (`:55`, `{date}`) → Fix: use `manilaDate`. Effort S.

### admin/operations/expenses — audience: admin/bookkeeper — complexity: 4
- Issue: four fully expanded panels are stacked on one screen: summary, matrix, P&L and cash flow (`page.tsx:195-198`) → Fix: collapse `CashFlowPanel` by default, since it mostly repeats the matrix and the P&L. Effort S.
- The accounting terms are fine here, and they already have hints (`pnl-summary.tsx:50-56`).

### admin/operations/hmo — audience: admin/bookkeeper — complexity: 3
- Issue: raw hex colours (`#0b2a4a`, `#0b6bb3`) are used instead of the brand tokens, for example at `hmo-aging-panel.tsx:28` and `hmo-ar-matrix.tsx:25`, and in `hmo-summary-cards.tsx` and `page.tsx:177`. It looks the same today, but these files are off-theme → Fix: switch to `var(--color-brand-*)`. Effort S.
- The content is fine: the aging mismatch is explained, and there is a link to the claims list.

### admin/operations/trends — audience: admin — complexity: 1
- fine — one chart with one purpose.

### admin/settings/consent-gate — audience: admin — complexity: 2
- Issue: page shape only. There is a page-level `mx-auto max-w-3xl` (`page.tsx:31`) and a hand-built header (`:32-50`). Effort S.
- The toggle is safe and clear: turning it ON asks for confirmation and shows the exact number of blocked patients (`client.tsx:83-101`), and every change is audited.

### admin/settings/dashboard-cards — audience: admin — complexity: 2
- Issue: each card shows its internal id (e.g. `admin.pf_to_pay`) in monospace under the label (`client.tsx:120-122`). Nothing on the page uses the id → Fix: remove it or move it to a tooltip. Effort S.
- Issue: the header is built by hand (`page.tsx:55`) instead of `PageHeader`. Effort S.

### admin/settings/online-booking — audience: admin — complexity: 2
- Issue: page shape only. There is a page-level `mx-auto max-w-3xl` (`page.tsx:21`) and a hand-built header (`:22-42`). Effort S.
- The pause confirmation is a good model: it names who is affected and who is not (`client.tsx:94-103`).

### admin/seo — audience: admin — complexity: 3
- Issue: the page does two unrelated jobs under the title "Search Engines (IndexNow)". It sends pages to IndexNow, and it also counts QR scans on the Google-reviews poster and receipts (`page.tsx:158-203`) → Fix: rename it to cover both, or move Google reviews to Marketing › Booking Sources, which also tracks where patients come from. Effort M.
- Issue: page shape. There is a page-level `mx-auto max-w-3xl` (`:56`) and a hand-built header (`:57-73`). Effort S.

### admin/closures — audience: admin — complexity: 2
- fine — both destructive actions have plain-English confirmations, the empty state is good, and no raw codes are shown. The only miss is page shape: the header is built by hand (`page.tsx:62-71`). Effort S.

### admin/coming-soon/[module] — audience: admin — complexity: 1
- fine — this is a deliberate placeholder. `MODULES` is empty (`page.tsx:14-15`), so every link 404s. The only miss is page shape: `mx-auto max-w-3xl` (`:39`). If no module is planned, the route could be deleted.

### admin/emails-sent — audience: admin — complexity: 2
- fine — it follows the shared list pattern, type and status are shown in words, and it calls out failures from the last 7 days. The only miss is page shape: the header is built by hand (`page.tsx:155-165`). Effort S.

### admin/gift-codes — audience: admin — complexity: 2
- fine — statuses are shown in words via `STATUS_LABELS`/`STATUS_BADGE`, the chips work, and paging is real. The only miss is page shape: the header is built by hand (`page.tsx:187-216`). Effort S.

### admin/gift-codes/[id] — audience: admin — complexity: 2
- Issue: the timestamp for redeemed/cancelled/refunded is built inline with `Intl.DateTimeFormat` (`page.tsx:203-210`) instead of the shared `manilaDateTime` helper the list page already uses → Fix: swap to `manilaDateTime(when)`. Effort S.
- Otherwise fine — Cancel and Refund each open a form with a required reason, and the copy steers the admin toward Refund (`page.tsx:156-177`). The only other miss is page shape: `mx-auto max-w-3xl` (`:71`) and a hand-built header (`:72-101`). Effort S.

### admin/gift-codes/generate — audience: admin — complexity: 1
- fine — sensible defaults, and the 100-code cap is explained. The only miss is page shape: `mx-auto max-w-xl` (`page.tsx:14`). A narrow page suits a form, but the width should sit on the form, not the page root. Effort S.

### admin/gift-codes/sales — audience: admin — complexity: 2
- Issue: the page builds its own status badge and shows the raw status for anything other than redeemed/purchased (`page.tsx:274-289`) → Fix: reuse `STATUS_LABELS`/`STATUS_BADGE` from `src/lib/gift-codes/labels.ts`. Effort S.
- Issue: the purchase date is built inline with `Intl.DateTimeFormat` (`page.tsx:238-246`) instead of `manilaDateTime` → Fix: swap to the shared helper. Effort S.
- Issue: the header is built by hand (`:106-123`). Effort S.

### admin/import-patients — audience: admin — complexity: 3
- Issue: patients are inserted with no preview and no duplicate check (`actions.ts:96-104`). See Top 5 #2. Effort M.
- Issue: the page tells the admin to exclude "rows already in `<code>/staff/patients</code>`" (`page.tsx:49-50`), showing a raw URL path in code font → Fix: say "rows already in Patients", as a link. Effort S.
- Issue: page shape. There is `mx-auto max-w-4xl` (`page.tsx:13`) and a hand-built header. Effort S.
- Usage check wanted: `audit_log` rows for the import action. If it only ran during the initial migration, the page could move to Hidden Tabs.

### admin/newsletter — audience: admin — complexity: 2
- fine — sources are shown in words, the empty states are right, and paging is real. The only miss is page shape: the header is built by hand (`page.tsx:144-164`). Effort S.
- Usage check wanted: `newsletter_campaigns` row count.

### admin/newsletter/new — audience: admin — complexity: 2
- fine — it has a strong two-step send with the recipient count and a "cannot be unsent" warning (`compose-form.tsx:90-118`). Other irreversible sends should copy it. The only miss is page shape: `mx-auto max-w-4xl` (`page.tsx:20`). Effort S.

### admin/patient-merge — audience: admin — complexity: 3
- Issue: after a merge on this page, there is no Recently merged list and no undo here. Undo exists only on the Candidates page (`candidates/candidates-client.tsx:49-113`; `loadRecentMerges` is not used by this page). The page does link to Candidates (`page.tsx:21`) → Fix: show the same "Recently merged (undo within 30 days)" block here. Effort S.
- Issue: the header is built by hand (`page.tsx:15-31`). Effort S.
- The confirmation step is good: the admin must type `MERGE` (`merge-client.tsx:188-212`).
- Usage check wanted: `patient_merges` row count, including rows that were undone.

### admin/patient-merge/candidates — audience: admin — complexity: 3
- Issue: one-click merge asks only a plain `window.confirm()` (`candidates-client.tsx:36`), while the same action on the sibling page requires typing `MERGE` → Fix: pick one confirmation strength for both pages. Effort S.
- Issue: the confidence badge prints the raw internal tier code (`{pair.score.tier}`, `candidates-client.tsx:82`, values like `exact_dup`/`strong`/`probable`/`weak`) unhumanized, while the signal chips right next to it are already mapped through `SIGNAL_LABEL` → Fix: add a `TIER_LABEL` map ("Exact duplicate" / "Strong match" / "Probable match" / "Weak match") and use it. Effort S.
- Issue: the page uses plain slate/cyan Tailwind and no `PageHeader`/`Panel` (`page.tsx:26-41`, e.g. `text-slate-500` at `:40-41`), so it looks like a different app → Fix: switch to the brand tokens with `PageHeader` and `Panel`. Effort M.

### marketing — audience: admin — complexity: 4
- Issue: three different "cost per booking" figures sit on one screen. Two come from what the ad platforms report (Campaign table at `_components/ad-dashboard.tsx:982-1027`, Ad table at `:1208-1256`) and one comes from the clinic's own records (`:1083-1143`). Only a paragraph of text tells them apart (`:1040-1051`) → Fix: put a "reported by ad platform" or "from clinic records" badge on each table heading. Effort S.
- The page is very dense: 5 KPI cards, 2 charts, a funnel, per-platform cards and 3 tables. That is a deliberate port of the marketing kit; note it for the owner and don't change it.

### marketing/ops — audience: admin — complexity: 3
- Issue: all checklist, roadmap and campaign status is kept only in `localStorage` (`_components/ops-tracker.tsx:230-242`, `:310`). Only the sidebar tooltip says "saved in this browser only". The page itself does not, so the owner and the partner will see different ticks → Fix: say so on the page. If it is meant to be shared, store it in the database. Effort S / L.
- Issue: the 12-week roadmap uses relative labels ("Wk 1", "Wk 1–2", `ops-tracker.tsx:142-149`) with no start date, so it can't show where the clinic is in the plan → Fix: store a start date and highlight the current week. Effort M.

### marketing/sources — audience: admin — complexity: 2
- fine — it uses `PageHeader`, `StatCard` and the shared `ProportionTable`, and every table has a plain caveat.

### admin/payroll/employees — audience: admin — complexity: 3
- Issue: dates are built with `Intl.DateTimeFormat` inline (`employees-client.tsx:48-56`) instead of `manilaDate`. There is also `mx-auto max-w-[1400px]` and a hand-built header (`page.tsx:68-77`). Effort S.

### admin/payroll/employees/[id] — audience: admin — complexity: 4
- Issue: the Overview tab is an edit form that is always open. Daily rate, schedule, payment method and regularization date are live inputs on every visit (`employee-detail-client.tsx:319-501`) → Fix: show the values read-only with an Edit button. Effort M.
- Issue: the Leaves tab has its own Grant/Usage/Cash dialogs (`:1407-1698`) that repeat the leaves dashboard's forms (`leaves/leaves-client.tsx:541-829`) → Fix: share one form component, or link to the dashboard with that employee's row open. Effort L.
- Issue: dates use inline `Intl` formatting (`:123-143`), and there is `mx-auto max-w-[1400px]` (`:173`). Effort S.

### admin/payroll/holidays — audience: admin — complexity: 2
- Issue: a disabled holiday is a dead end, "re-enable via DB" (`holidays-client.tsx:247`, `:306`). See Top 5 #3. Effort M.
- Issue: page shape: `mx-auto max-w-[1400px]` (`page.tsx:79`). Effort S.

### admin/payroll/leaves — audience: admin — complexity: 3
- Issue: every employee row shows three buttons, "Add grant", "Record usage" and "Cash conversion" (`leaves-client.tsx:387-424`) → Fix: one Actions menu per row. Effort M.
- Issue: dates use inline `Intl` formatting (`:58-68`), and there is `mx-auto max-w-[1400px]` (`page.tsx:191`). Effort S.

### admin/payroll/ot-slips — audience: admin — complexity: 2
- Issue: the file has a second, hand-built timestamp formatter (`ot-slips-client.tsx:66-78`) next to the shared one it already imports, and there is `mx-auto max-w-[1400px]` (`page.tsx:192`) → Fix: use `manilaDateTime` and `PageHeader`. Effort S.
- Usage check wanted: `payroll_ot_slips` row count.

### admin/payroll/periods — audience: admin — complexity: 2
- Issue: errors appear as a `window.alert` (`periods-client.tsx:88`, `:111`), while every sibling payroll page shows an inline red banner → Fix: use an inline banner. Effort S.
- Issue: the header is built by hand, and there is `mx-auto max-w-[1400px]` (`page.tsx:100`). Effort S.
- See the merge notes: periods overlaps with runs.

### admin/payroll/rates — audience: admin — complexity: 3
- Issue: the column headers "MSC lower/upper", "EE share" and "ER share" (`rates-client.tsx:291-295`, `:493-497`) have no hint. Keep the statutory terms and add a legend: "MSC = Monthly Salary Credit · EE/ER = Employee/Employer share". Effort S.
- Issue: page shape: `mx-auto max-w-[1400px]` (`page.tsx:138`). Effort S.

### admin/payroll/runs — audience: admin — complexity: 2
- Issue: the status pill prints the raw run status (`runs-client.tsx:292-306`), while the detail page already has `RUN_STATUS_LABEL` (`runs/[id]/run-review-client.tsx:128-133`) → Fix: move that map to a shared file and use it in both places. Effort S.
- Issue: page shape: `mx-auto max-w-[1400px]` (`page.tsx:214`). Effort S.

### admin/payroll/runs/[id] — audience: admin — complexity: 5
- Issue: an "Inline vs Slide-out" toggle for the earnings/deductions editor is saved per browser (`run-review-client.tsx:154-212`, `:1192-1225`). On mobile it is forced to slide-out anyway (`:322-336`), so the setting is a leftover implementation choice → Fix: keep slide-out, and delete the toggle and its storage code. Effort M.
- Issue: page shape: `mx-auto max-w-[1400px]` and a hand-built header (`:380`, `:392-441`). Effort S.

### admin/payroll/runs/[id]/dtr — audience: admin — complexity: 4
- Issue: the Commit step does nothing (`actions.ts:296-320`). See Top 5 #1. Effort M.
- Issue: timestamps are built with `Intl` inline (`dtr-upload-client.tsx:81-94`), and there is `mx-auto max-w-[1200px]` (`:261`). Effort S.
- Usage check wanted: `payroll_dtr_imports` row count, to see whether DTR upload is used at all.

### admin/payroll/settings — audience: admin — complexity: 3
- Issue: there is a Save button for every setting (`settings-client.tsx:180-284`). See Top 5 #4. Effort M.
- Issue: page shape: `mx-auto max-w-[1100px]` (`page.tsx:82`). Effort S.

### Merge / cross-page ideas
- **Payroll periods + runs → one pay-cycle page.** Periods creates a run and links to it (`periods-client.tsx`, "+ Create run"). Runs links back through "Manage periods →". Each page is thin and they link to each other. Runs could show periods that have no run yet as rows with a "Create run" button, and the Periods sidebar item could go. Effort L. Ask the owner first.
- **Leave forms are built twice.** The employee detail Leaves tab and the leaves dashboard implement the same three actions separately. Share one form component. Effort L.
- **Patient merge pair.** Keep the two pages, since manual merge and the duplicate finder are different tools. But use one confirmation strength (typed `MERGE`), use one visual style, and show the Recently merged / undo list on both. Effort M in total.
- **One PageHeader sweep across the batch.** Only 11 files in this batch's route folders use `PageHeader`, so most routes build their header by hand. 19 files still set a page-level `mx-auto max-w-*`: all 11 payroll routes, settings/consent-gate, settings/online-booking, seo, gift-codes/[id], gift-codes/generate, import-patients, newsletter/new and coming-soon. It is the same small change each time. Do it as one PR per sidebar group: Payroll, Books & Reports, Admin Tools. Effort M per group.
- **One date-helper sweep in payroll.** Six payroll client files build formats with `Intl.DateTimeFormat` inline. `date-render-surfaces.test.ts` probably has them in its frozen list. Converting them lets that list shrink. Effort S–M.
- **One small status-label module.** Raw status values appear on staff-advances, payroll runs, gift-code sales and daily-revenue. Label maps already exist for runs and gift codes. Add the other two and reuse them. Effort S.
- **Move the Google-reviews scan counts out of the SEO page** into Marketing › Booking Sources, which already answers "where did patients come from". Effort M.
- **Staff Advances sits under Payroll in the sidebar, but its route is under `/reports/`.** That is fine as it is. If the table turns out to be empty, move the page to Hidden Tabs.
- **Operations sub-tabs don't overlap.** Each tab is a different view, the date range carries across tabs correctly, and the legacy `reports/daily-revenue` route is only a redirect.

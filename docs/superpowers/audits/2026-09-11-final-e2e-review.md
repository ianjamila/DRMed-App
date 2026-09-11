# DRMed — final pre-go-live end-to-end review (2026-09-11)

**Scope.** Every role (patient/customer, reception, medtech / x-ray / pathologist, admin) traced end to end on `main` @ `0a50587` (prod ledger 0136), plus read-only prod data checks, plus a live click-through on drmed.ph (Part 2). Method: four parallel Sonnet code-tracing agents (one per role, reports in the session scratchpad), orchestrator verification of every blocker-level claim against code, and Supabase MCP read-only SQL against prod.

**How to read this.** Part 1 is what the code says. Part 2 is what actually happened when the flows were clicked on production with throwaway accounts. Section A is the go-live list; everything in B–D is for the owner to prune.

---

## A. Go-live blockers (must be decided or fixed before day 1)

### A1. Operational — no real medtech or pathologist can sign in *(no code change; clinic action)*
Prod `staff_profiles`: the only medtech (JELOME RILLO, PRINCESS ROMERAL) and pathologist (MARIANO, TAGAYUNA, VICENCIO) rows are the **signature-only** accounts created by `scripts/seed-signatures.ts:125-128` — email `signatory-<PRC>@drmed.internal`, never signed in, no known password, and no Google email to match. Nobody exists for X-ray/ECG (`xray_technician` role exists in code, zero accounts). **Before day 1:** create real accounts (Admin → Users) for each lab person with the Gmail they will use for "Continue with Google", or link a Gmail to the signatory rows. Also: Freya (admin) has still never used Google sign-in; `admin@drmed.ph` / `reception@drmed.ph` seeded test accounts are active on prod — deactivate or rotate after this review.

### A2. Operational — 27 trial-era test requests are still open *(decision, then app clean-up)*
Visits 0032–0041 (29 May → 4 Jul 2026): 22 `requested`, 4 `ready_for_release` (0032 CBC_PC / ROUTINE_PACKAGE / FBS_RBS, 0039 ANNUAL_PHYSICAL_EXAM), 1 `in_progress` (0032 URINALYSIS). All `unpaid` except 0038 (paid, CONSULT still `requested`). Recommended: soft-delete the unpaid visits with reason "trial data" (reception/admin can do it in the app — unpaid → deletable), and "Mark consultation done" on 0038. Then day-1 queues and dashboards start empty.

### A3. Code — HMO package headers never release; revenue never posts; portal package PDF stuck *(lab agent B1, confirmed)*
0133 let each **component** release on an HMO visit, but 0109's two header triggers (`fn_release_header_when_components_done` at `0109_package_release_lifecycle.sql:495-497`, `fn_release_headers_on_visit_paid` at `:568-572`) still test `payment_status in ('paid','waived')` with no HMO carve-out — and there is **no UI that can release a header by hand** (`ReleaseAllButton` targets children only, headers never reach `TestAction`, bulk actions filter `is_package_header = false`). Because `bridge_test_request_released` posts package revenue **only from the header** (`0109:14,43-46`), the package's price and the AR-HMO receivable are never booked; the portal's "Download package result" stays disabled with the wrong tooltip ("Available when all components are released" — they are). **Prod today:** 0 stuck headers, but only because no HMO + package visit has been run through the app yet; 2,420 HMO visits in history, 16 active packages → this fires on the first one. **Fix:** extend both 0109 triggers with the 0133 predicate (`payment_status in ('paid','waived') or hmo_provider_id is not null`, already centralised in `src/lib/visits/money-settled.ts`) via a new migration, and/or add an admin "Release package header" control on the visit page. Also fix the portal tooltip.

### A4. Code — reception can see soft-deleted lab test names/prices on the visit page *(reception agent, confirmed)*
`visits/[id]/page.tsx:282` builds `deletedTestRows` with no section filter, while the live table one line earlier goes through `isVisible()` (which returns nothing for reception since `sectionsForRole("reception") = []`). The "Deleted entries" panel (`page.tsx:1018-1078`) then shows each deleted test's real service name and price to reception — the one thing the partner policy says reception must never see, and reception is one of the two roles that *creates* this state. **Fix:** apply the same `isVisible()` filter to `deletedTestRows` (row-by-row, mirroring the live table). RLS is deliberately not section-aware (0023), so the app filter is the only guard.

### A5. Code — "Waive balance" is offered on HMO visits and its own copy suggests it *(admin agent B-1; severity REDUCED after the Codex review)*
`waiveVisitBalanceAction` (`visits/[id]/actions.ts:514-582`) never reads `hmo_provider_id`; the button gate is `isAdmin && !isPaid && !visitDeleted` (`page.tsx:494`); the dialog text says *"Marks this visit as waived (HMO-covered / charity / no-charge)"* (`waive-balance-dialog.tsx:50-52`). **Correction:** waiving does NOT write off the HMO receivable — the release bridge books AR-HMO by `hmo_provider_id` (`0131_zero_pf_release_exemption.sql:135`) and `v_hmo_unbilled` does not exclude waived visits (0082). The harm is a misleading `waived` status on an HMO visit (and `isPaid` flipping true). Still worth hiding the button on HMO visits and rewording the dialog, but it is a medium bug, not a money blocker.

### A6. Code — any staff role can void any payment *(admin agent B-2, confirmed)*
`voidPaymentAction` (`payments/[id]/void/actions.ts:17`) gates on `requireActiveStaff()` only; `VoidPaymentDialog` renders for every payment row with no role wrapper (`visits/[id]/page.tsx:1080-1115`). In practice RLS hides `payments` rows from lab roles (`0001_init.sql:574`), so a medtech never sees the Void button — the gap is the unguarded server action (any active session with a payment id can void via a crafted call). Every sibling money action is reception/admin or admin-only. **Decision:** restrict to reception + admin (recommended) or admin only.

### A7. Code — booking-confirmation email and public cancel page show the appointment time 8 hours early *(patient agent #1, confirmed in code)*
`notify-appointment-booked.ts:114-118` and `appointments/cancel/[id]/page.tsx:45-50` call `toLocaleString("en-PH", …)` with **no `timeZone`**; the reminder email (`notify-appointment-reminder.ts:53`), the review step and the success panel all pass `Asia/Manila`. Vercel runs UTC, so a 2:00 PM slot is emailed as "6:00 AM". Every slot-based booking is affected. **Fix:** add `timeZone: "Asia/Manila"` in both places (two-line change) — and a test that pins it.

### A8. Compliance — receipt view/print writes no audit row *(reception agent #7, confirmed)*
Neither `visits/[id]/receipt/page.tsx` nor `visits/group/[groupId]/receipt/page.tsx` (nor `print-button.tsx`) calls `audit()`. The receipt shows name, DRM-ID, lines/prices and — while the flash cookie lives — the plaintext PIN. The count sheet, PF slip and the `admin/reports/*` CSVs audit — but five other CSV routes do not (see F/N15). CLAUDE.md: "every print or export that discloses patient data must insert an audit_log row". **Fix:** `receipt.viewed` on render (+ `receipt.printed` from the print button), same pattern as the count sheet.

### A9. Code — "Mark arrived" hides walk-in bookings, so "+ Start visit" is unreachable *(found in the live run, see Part 2 L1)*
`appointments/page.tsx` `loadWalkInsCreatedToday` filters `status = 'confirmed'`; every public lab-request booking has `scheduled_at = null`, so after "Mark arrived" the row is in no section, the only place "+ Start visit" renders. Reception falls back to the patient page and the appointment never completes (dashboard "Walk-ins waiting" sticks). Supersedes the narrower H2.

---

## B. Bugs (real, cited, not blockers)

### B-high
| # | Role | Finding | Where |
|---|---|---|---|
| H1 | Admin | "HMO unbilled aged 90+" dashboard card reads `v_hmo_unbilled` with a bare select — the 1000-row cap bug already fixed on the claims page. **Live today: view has 2,031 rows**, so the card is wrong right now. | `_dashboards/admin-dashboard.tsx:136-140` |
| H2 | Reception | Walk-in-mode appointment marked "arrived" has no path to "+ Start visit" (`patient_id` is null and nothing can attach one), although the slide-over copy promises it. Same via Book-from-inquiry. Workaround: skip the card, register + start from `/staff/patients/new`. | `appointments/transition-buttons.tsx:125`, `new-appointment-sheet.tsx:415-417`, `inquiries/actions.ts:223-233` |
| H3 | Patient | `pending_callback` confirmation email carries a "Cancel this request" button that always lands on "Can't cancel online" (`CANCELLABLE = {"confirmed"}`; the server action would allow it). | `cancel/[id]/page.tsx:19` vs `cancel/[id]/actions.ts:50-59` |
| H4 | Lab | Lab-dashboard "Unclaimed" / "Send-out awaiting" counts skip the money-settled gate the `/staff/queue` list applies → card says 16, list is empty (seen live). **And** the "Oldest unclaimed" + "Pending sign-off" strips embed `patients ( … )` directly on `test_requests`, which has no FK to `patients` (only via `visits`) — the query errors, the error is discarded, and the strip always renders empty ("Nothing waiting in your queue." was shown live next to the count of 16). `/staff/results` does the gate right (`awaitingPayment`). | `lab-dashboard.tsx:112-122,159-168,181-196` vs `queue/page.tsx:165-168` |
| H5 | Lab | Pathologist "Critical alerts" card, strip and "view all" link to `/staff/queue`; the real page `/staff/critical-alerts` (with Acknowledge) exists and the notification bell links it correctly. | `lab-dashboard.tsx:283,340,391` |
| H6 | Admin | Ticking "Send-out test" on a service is a dead end: the cost/vendor fieldset is gated on the server-rendered initial value, so on edit the save is rejected ("unit cost is required") with no way to enter it; on create it silently lands on "Unconfigured send-outs". | `services/service-form.tsx:319`, `services/actions.ts:43,115` |
| H7 | Admin | No self/last-admin guard on `updateStaffUserAction` — an admin can untick their own Active or change their own role and lock themselves out; no "last admin" check anywhere. | `users/actions.ts:90-142`, `users/[id]/edit/page.tsx:79-149` |
| H8 | Admin | "Emails sent" CSV silently caps at 1000 rows (single `.range(0, 9999)` against PostgREST `max_rows = 1000`), no `TRUNCATED` row, audit records the short count. | `src/lib/emails-log/query.ts:174-191` |

### B-medium
| # | Role | Finding | Where |
|---|---|---|---|
| M1 | Patient | Consult-only visit shows in the portal as a "Released" row with "No file" — reads like a broken result. | `portal/(authenticated)/page.tsx:160-163,554-565` |
| M2 | Patient | Three of four portal downloads call `window.open()` **after** an `await` (iOS Safari popup trap); the package PDF path already uses the blob + `<a download>` workaround with a comment explaining why. Needs a device check. | `download-button.tsx:26-44`, `package-card.tsx:73-81`, `lab-request-uploads.tsx:26-38` |
| M3 | Patient | Phone-field error says "required for SMS confirmation" — SMS is never sent (prod Semaphore keys are placeholders; all 52 booking notifications show `sms.skipped`). | `validations/booking.ts:79`, `booking-form.tsx:400` |
| M4 | Reception | Consult lines require a physician at **intake** unconditionally while procedures require one only when PF > 0 (the documented rule); the form hint says "at release time". | `visits/new/actions.ts:253-284`, `visit-form.tsx:577-579` |
| M5 | Reception | Sidebar "New lab request / New imaging request" and dashboard quicklinks pass `?filter=lab|imaging`, but the patient picker drops it — pre-filter never happens. | `visits/new/page.tsx:28-35,232` |
| M6 | Reception | `gift_code` payment method renders raw on the visit page (label map missing the entry; the payment form has it). | `visits/[id]/page.tsx:63-72,1105,1141` |
| M7 | Reception | "↶ Revert" is the only way to move `pending_callback` → `confirmed`; label/tooltip say it's for accidental presses. | `transition-buttons.tsx:140-145`, `appointments/actions.ts:22` |
| M8 | Reception/Admin | `createVisitAction` re-fetches services by id but never re-checks `is_active` (package components do). | `visits/new/actions.ts:101-110` |
| M9 | Admin | Dashboard money cards that cannot be reconciled on click-through: Revenue today (cash received today vs MTD accrual on release date), Net income (MTD vs YTD default), AP outstanding/overdue (bills page has no status filter). Four more cards use the same unpaged bare-select pattern as H1 (bills, patient AR, advances, PF) — 0/0/0/13 rows today, so not yet wrong. | `admin-dashboard.tsx:97-166,201-216,394,416-432` |
| M10 | Admin | HMO provider create/edit shows raw Postgres errors (no `translatePgError`), e.g. duplicate name. | `admin/hmo-providers/actions.ts:52-54,91` |
| M11 | Admin | `unbilled_threshold_days` drives the "stuck unbilled" flag but has no field in the HMO provider form. | `hmo-provider-form.tsx`, `actions.ts:18-31` |
| M12 | Admin | Bulk PF payout rollback voids the disbursement but never unlinks its `doctor_pf_entries` (single-void path does) → stranded entries. | `pf-bulk-payout.ts:38-43,60-65` vs `pf-disbursements.ts:188-191` |
| M13 | Admin | `/staff/signoff` copy tells staff to "flip it on a service" — the checkbox is permanently disabled; and `requires_signoff` has no server-side floor (a crafted POST could set it, and the consolidated chemistry finalise would then force-release past sign-off with no status guard). Prod: 0 services flagged. | `signoff/page.tsx:16-27`, `service-form.tsx:373-390`, `services/actions.ts:~30`, `finalise-consolidated.ts:~175-182` |
| M14 | Admin | Patient AR page: `limit(500)` oldest-first → past 500 open visits the **newest** bucket is what gets cut. 13 open today. | `patient-ar/page.tsx:89-101` |
| M15 | Admin | `patients-without-consent` truncates at 500 by `created_at` then re-sorts by last visit — recently-active old patients can drop off. 7,053 of 7,056 patients lack consent, so the page is over the cap right now. | `src/lib/reports/patients-without-consent.ts:51-63,95` |
| M16 | Admin | `emails-sent` reads through the service-role client (every other report uses the RLS client). | `src/lib/emails-log/query.ts:129,177` |
| M17 | Admin | New per-service result template can be saved for a service already covered by a group template (dead on arrival). | `result-templates/[service_id]/edit/actions.ts:39-46` |

### B-small
- Internal "Phase 10/11" eyebrows and "(Phase 10.4)" copy on reception screens (`gift-codes/sell/page.tsx:52`, `inquiries/page.tsx:102`, `inquiries/new/page.tsx:33`, `inquiry-form.tsx:286`).
- Raw enum on the new-visit form: "pf-split arrangement" (`visit-form.tsx:877`); "Doctor PF" label with no explanation (`:860`).
- `/staff/login` `<title>` is "Staff sign in — drmed.ph — drmed.ph" (suffix applied twice).
- `/schedule#book` anchor does not exist (`cancel/[id]/page.tsx:90,117`).
- `/staff/inquiries` list open to all roles while every child page bounces non-reception/admin (`inquiries/page.tsx:33`).
- Petty-cash page is today-only, no date picker (`payments/petty-cash/page.tsx:15`).
- Price-history table on service edit still shows a dead "Senior disc." column (post-0067).
- `voidCashAdjustmentAction` runs an unscoped reversal-JE lookup and discards it (`cash-drawer/actions.ts:144-161`).
- `createVisitAction` has no role gate beyond active staff (`visits/new/actions.ts:71-95`); not reachable via nav for other roles.
- `src/types/database.ts:4211-4230` still declares the three compensation columns dropped by 0136 (`npm run db:types` not re-run).

---

## C. UX improvements — for the owner to prune (grouped by audience, then cost)

### Patients
- **Trivial:** reword the phone error (M3); hide/disable "Book"/"Help" nav until portal consent is accepted (`patient-shell.tsx:24-34`); fix the package tooltip (A3).
- **Small:** distinct "Seen by Dr. X — nothing to download" treatment for consult-only rows (M1); on the lab-request branch, say "we'll call you to sort out the details" when nothing is selected (`booking-form.tsx:389-393`); either widen `CANCELLABLE` or drop the cancel button on callback emails (H3).
- **Medium:** tell patients on "Still in progress" *why* (awaiting payment vs in the lab) — cuts "where's my result" calls; repeat "reception will call you" on the Review step for the confirm-first lab option.
- **Config, high value:** turn SMS on for real (Semaphore account + real key on Vercel) — the code is already wired and audited; today every "SMS" promise in the UI is empty. Also confirm the "physical hand-off — no message sent" policy on release notifications is what the clinic wants (6 `result.notified` rows say skipped).

### Reception
- **Trivial:** label map for `compensation_arrangement`; remove phase labels; replace native `prompt()`/`alert()` for cash-drawer/EOD void reasons and consent withdrawal with the styled inline-reason dialog used elsewhere; label the consent signatory inputs; count-sheet → cash-drawer direct link; distinguish "fee blank" from "discount zeroed it" errors; consent indicator in the patient list.
- **Small:** "Back to cash drawer" on the closed-EOD panel; explicit confirm on "Close day"; client-side physician-required validation before the round-trip; show which appointment a visit will complete; distinguish "PIN already viewed" from "window expired"; don't lose the in-progress visit form when following the consent nudge; a reception-visible "patients without consent" count (the report is admin-only); earlier duplicate warning on new-patient form; "Start another visit" link on the receipt; "Register patient" link pre-filled from a walk-in row; inquiry → specific appointment/visit links.
- **Medium:** fix the walk-in "arrived" dead end properly (attach-patient action or on-row guidance + easy no-show) (H2); "Confirm" label for `pending_callback` (M7); handle the empty-physician-list case on the Doctor tab.

### Lab
- **Trivial:** inline error instead of `alert()` on claim failure (`queue/claim-button.tsx:27`); "why is this stuck" note on a package header at ready-for-release with 0 ready components.
- **Small:** "Finalise → open next unclaimed test in my section" (today: back to list, re-find, click — one extra round-trip per test); auto-focus + Enter-to-advance in structured entry; dashboard cards pass a `?filter=` so "Unclaimed"/"Send-out" drill down directly; page-scoped search hint on the empty row.
- **Medium:** one-line note on the consolidated chemistry form that finalising releases immediately when money is settled (single tests stop at ready-for-release — two semantics, no signal); one shared "Sign-off not yet available" banner reused on `/staff/signoff`, the services form and the pathologist dashboard.
- **Large:** rapid-entry mode for structured results (tab-optimised, commit-and-jump) — the single biggest per-test cost for a 40-tests/day medtech; a persistent "my next test" queue (claim → do → finalise → auto-claim next oldest in my sections).

### Admin / bookkeeper
- **Trivial:** CSV export on the audit-log viewer; friendly duplicate-name errors on services/HMO providers (M10); drop the dead "Senior disc." column; use `ipAndAgent()` everywhere; rename "Recent advances (most recent 500)" honestly; "historical entries unaffected" note on cash-routing like payment-routing has.
- **Small:** kind/section columns + quick deactivate on the services list; `unbilled_threshold_days` in the HMO provider list/form (M11); state that "Clinic cut" applies to consultations only; dashboard "Visits today" / "Payroll runs" / "Past-due periods" cards should carry their filter into the destination; one-click "widen the date range" on empty report states; cross-link undone-releases ↔ deleted-entries.
- **Medium:** make dashboard money cards reconcile with their destination (M9) or visually mark the ones that are "glance only"; "Outstanding"/"Overdue" filter on AP bills; cross-link Report groups ↔ With template and extend the template-health cron to stray per-service templates (M17); clear partial-failure message on bulk PF payout (M12); confirm single-person EOD close and one-step AP create-and-post are deliberate.
- **Large:** an admin UI to build/edit lab packages (`package_components` has no reader/writer in the app; the order-time error tells staff to "contact admin to set up its composition" for a screen that does not exist); package price roll-up from components.

---

## D. Verified OK (do not re-check)
Each agent's report carries a full "Verified OK" list; the headline: public booking (all four branches), self-registration, dedup, consent recording on both public forms, `/find-my-id`, PIN login + lockout + session/RLS bridge, portal consent gate, every portal read via the patient client, download authorisation + audit, data-export ZIP, rate-limit buckets; password and Google sign-in (fail-closed on inactive/deleted, audited), role-based nav, reception dashboard (no dead links), live visit-table section gating, waive-balance admin-only, mark-done never reaches reception, appointment state machine, appointment → visit handoff (patient-linked case), record payment, receipt reprint, PIN re-issue (shown once, never logged), soft-delete/restore + all five P-codes translated, cash drawer/EOD (server-derived counts, P0048), petty cash, consent capture/withdrawal gating, patient search, discounts single-source, packages, HMO intake, receipt policy, Manila dates in reception + admin slices; role → section mapping, lab-queue gate on worklist tabs only, claim/unclaim/reassign hardened server-side, structured entry + flags, consolidated chemistry re-validation, sign-off honestly dead-ended and locked, doctor lines invisible to medtech/xray, release/undo/bulk/mark-done section-scoped, PDF staff route hardened + audited, results-archive tabs a true partition; deactivated staff blocked on next request, self-delete blocked, `requireAdminStaff` on every admin page, MFA one-way, physician_compensation (0136) fully migrated, discounts + statutory lock, result-template admin gated, all seven `admin/reports/*` paged + audited, audit viewer, `visits.csv`, HMO claims page paging, journal/FS independent of the Sheets sync (daily cron + manual re-sync).

Prod facts confirmed: `requires_signoff` on 0 services; 0 HMO visits ever waived; `bills`/`staff_advances`/PF-pending all 0 rows; Vercel prod env has every expected key incl. the `CONSULTANT_*_STAFF_ID` trio; Google Ads tag + labels present.

---

## E. Decisions only the owner can make
1. A6 — who may void a payment (reception + admin, or admin only)?
2. H3 — should callback bookings be cancellable online, or should the email stop offering it?
3. A2 — soft-delete the 27 trial requests (visits 0032–0041) and mark 0038's consult done?
4. SMS — buy a Semaphore account and turn it on, or remove every "SMS" promise from the UI?
5. Release notifications — keep "physical hand-off, no message" or notify by email on release?
6. M4 — is "physician required at intake for every consult" the intended stricter rule, or should it follow PF > 0 like procedures?
7. A1 — which Gmail addresses do the two medtechs and the releasing pathologist use?
8. Cash-drawer single-person close and one-step AP create-and-post — deliberate?

---

## F. Independent review — Codex `gpt-6-astra`, reasoning xhigh (2026-09-11), reconciled

Codex read CLAUDE.md and this report, then verified sections A and B-high against the code and looked for misses. Raw output: `docs/superpowers/audits/2026-09-11-codex-independent-review.md`. Every claim below was re-checked by the orchestrator against code and, where possible, prod data before being accepted.

### Verdict on our findings
| Item | Codex | Reconciled |
|---|---|---|
| A1, A2 | PARTLY — operational facts it could not see | Our prod SQL is the evidence; stands. |
| A3 | CONFIRMED | Stands (Codex's "while unpaid" caveat is moot — HMO visits never become paid). |
| A4 | CONFIRMED | Stands; also leaks other sections' deleted rows to lab roles. |
| A5 | PARTLY — **refuted the write-off** | Accepted: downgraded to medium (status/UX bug). |
| A6 | PARTLY — click path blocked by RLS | Accepted: wording fixed; server-action gate still needed. |
| A7, A8, A9 | CONFIRMED | Stand. A9 applies to untimed bookings (slot-based labs keep `scheduled_at`); H2 remains a separate fix. |
| H1–H8 | all CONFIRMED (H4 "more broken than reported") | Stand; H4 row updated. |

### New findings from Codex, verified by us
| # | Sev | Finding | Verified how |
|---|---|---|---|
| N1 | **go-live** | Reception (any active staff) can open `/staff/queue/<testId>` directly and **view / amend (replace) a lab result PDF** — page gates only `requireActiveStaff()`, `amendResultAction` likewise, and `results` RLS (0051:21) includes reception. Violates the partner policy the visit page enforces. | code: `queue/[id]/page.tsx:39-49`, `queue/[id]/actions.ts:905` |
| N2 | **go-live** | Consolidated chemistry finalise never checks that all `testRequestIds` belong to `input.visitId` / one patient — a crafted payload merges two patients into one PDF, downloadable by both. | code: `finalise-consolidated.ts:43-55` |
| N3 | **go-live (clinical)** | Consolidated chemistry inserts `result_values` **without `flag`** and never runs critical-value detection (the DB trigger was dropped in 0010; the single-test path computes flags in TS at `queue/[id]/actions.ts:647`). Chemistry PDFs carry no H/L marks and no critical alert is raised. | code: `finalise-consolidated.ts:156-165` (no flag/critical anywhere in the file) |
| N4 | high | Consolidated release sets only `status` — no `released_at` / actor / medium — so those tests vanish from "Released today", dated reports and HMO movement (which excludes null timestamps). | code; prod has 0 such rows only because no consolidated release has run on prod yet |
| N5 | high | Consolidated finalise commits result + junction + values + release **before** rendering/uploading the PDF; an upload failure leaves released tests with no PDF and the idempotency guard refuses a retry ("already have a result"). | code: `finalise-consolidated.ts:102-130,176-210` |
| N6 | high | Undoing one test's release does not withdraw a **shared** consolidated PDF: portal download authorises if *any* linked test is still released (`portal/actions.ts:80-94`). | code |
| N7 | go-live once an X-ray tech exists | 0051 recreated the `results` / `result_test_requests` / `result_values` policies without `xray_technician`; nothing later re-adds it — an X-ray tech cannot read back their own saved results. | code: `0051:21,64,188`; no later migration touches it |
| N8 | high | Receipt reprint lists **deleted** test lines and totals them (lines are mapped with `deleted:` but never filtered before subtotal/total/render). | code: `receipt/page.tsx:159-175,217-219,297` |
| N9 | high | Portal login takes the *newest* unexpired `visit_pins` row (`login/actions.ts:93-99`); every new visit inserts a new PIN (consult-only visits skip the slip, `visits/new/actions.ts:369,504`), and re-issue rewrites the hash without touching `created_at` — so a repeat patient's printed PIN can silently stop working. | code; prod: 0 patients currently hold two unexpired PINs (latent) |
| N10 | high (RA 10173) | Patient data-export ZIP selects `paid_at, reference` on `payments` — columns are `received_at, reference_number` — so `payments.json` is always `[]`; visit/test queries have no `deleted_at` filter or paging. | code + prod schema |
| N11 | medium | Cancelling a multi-service booking cancels only the first appointment of the group. | code: `cancel/[id]/actions.ts:62` |
| N12 | high (with A9) | Untimed bookings are loaded only when `created_at` is today — a confirmed request from yesterday is in no section the next morning. | code: `appointments/page.tsx:160-175` |
| N13 | **go-live if gift codes are sold** | Redeeming a gift code inserts `method: "gift_code"` but **prod's `payments_method_check` allows only cash, gcash, maya, card, bank_transfer, hmo, bpi, maybank** — the insert fails. | prod constraint read via SQL; 0 gift-code payments ever |
| N14 | medium | Selling a gift code for cash writes no `payments` row, so EOD expected cash excludes it → apparent overage. | code: `gift-codes/actions.ts`, `0132:177` |
| N15 | high (RA 10173) | Five CSV routes — `gift-codes/sales.csv`, `operations/{daily,cash,expenses,hmo}.csv` — have **no audit row, no paging, and use the service-role client**. | grep: audit=0, paging=0, admin client=2 in each |
| N16 | medium | Payment and release journal entries use `received_at::date` / `released_at::date` (UTC) instead of the Manila date — a payment before 08:00 Manila posts to the previous day/month. | code: `0091:86`, `0131:141`; prod: 0 of 5 payment JEs affected so far |

### Merged go-live order (Codex's ranking, adjusted after verification)
1. **Role/section authorisation on result view/amend, deleted rows, payment void** — N1, A4, A6
2. **Consolidated chemistry correctness** — N2 (one visit/patient), N3 (flags + critical alerts), N4 (release metadata), N5 (PDF-before-commit or recoverable retry), N6 (shared-PDF undo)
3. **HMO package-header release** — A3
4. **Lab staff accounts + X-ray RLS** — A1, N7
5. **Receipts**: drop deleted lines (N8) and audit view/print (A8)
6. **Last-admin / self-deactivation guard** — H7
7. **Gift codes**: DB constraint (N13) + drawer cash (N14) — or disable gift-code sales at launch
8. **Untimed-booking handoff** — A9 + N12 + H2
9. **Booking email/cancel**: timezone (A7), walk-in copy (L2), callback cancel (H3), group cancel (N11)
10. **PIN issuance vs login selection** — N9
11. **Truncation + missing audits on exports/dashboards** — H1, H8, N15
12. **Patient ZIP** — N10
13. **Manila posting dates in GL bridges** — N16
14. **Send-out config dead end** (H6), **lab dashboard embed + gate** (H4, H5)
15. **Trial-data cleanup** — A2 (owner decision)
16. A5 (medium): hide waive on HMO visits, reword dialog

### Corrections to this report
- Section D "Verified OK" was too broad for: the patient ZIP, PIN re-issue, receipt reprint, consolidated chemistry, partial undo, gift-code payments/drawer, and GL posting dates — each has a counterexample above. Treat D as "the exercised scenarios passed", not a blanket assurance.
- "Every other report uses the RLS client" (M16) and "all CSVs audit" (A8) were false generalisations — see N15.

---

## Part 2 — live run on drmed.ph (2026-09-11, throwaway accounts)

**Accounts used:** Test Admin `admin@drmed.ph` (password reset by the owner via `scripts/create-local-admin.ts --prod`), Test Reception `reception@drmed.ph` (password reset through Admin → Users), `qa-medtech@drmed.ph` + `qa-pathologist@drmed.ph` (created through Admin → Users, deleted at the end), patient **DRM-7264 "Zed Qa-Test"** (booked on `/schedule`, email jamilaian21@gmail.com, dummy mobile). Driven with `playwright-cli` (standalone, allowed via `Bash(playwright-cli:*)`); the Playwright MCP browser was held by another session.

### The chain — every step worked
| Step | Role | Result |
|---|---|---|
| Admin → Users → create medtech + pathologist; admin password reset | admin | OK (type-name-to-confirm on delete; "Password reset. Share…" status) |
| `/schedule` → No, I'm new → Laboratory Request → CBC + PC → About you → Review → Submit | patient | OK — "Booking confirmed", DRM-7264 issued; `appointment.booked` + `.notified` (email ok, sms skipped) audited |
| Appointments → row "Sep 11, 2:06 PM · Walk-in · Qa-Test, Zed · Confirmed" → **Mark arrived** | reception | Status flips, `appointment.arrived` audited — **and the row disappears from every section** (see L1) |
| Patient page → consent "On file — 9/11/2026" (the /schedule self-registration grant, PR 6) → **Mark identity verified** → **+ Start visit** | reception | OK; pre-registered badge cleared, `patient.identity_verified` audited |
| New visit: Lab & Services tab → CBC + PC ₱360 → **Create visit & issue PIN** | reception | OK → receipt page with DRM-ID + Secure PIN, `visit.created` + `visit_pin.issued` audited; **Print & mark as printed wrote no audit row (A8 confirmed)** |
| Portal login DRM-7264 + PIN (before payment) | patient | OK — "Still in progress · Visit #0042", `patient.signin.success` |
| Lab queue before payment | medtech | correctly empty (gate); `/staff/results?status=unclaimed` shows the row as "awaiting payment" |
| Record payment (cash, prefilled ₱360) | reception | OK → Paid/₱0 balance, `payment.recorded`, payment JE posted; Delete button correctly disappears |
| Queue → **Claim** → lands on the test page → 13 CBC fields → **Finalise & generate PDF** | medtech | OK → "ready for release", View/download + Amend buttons, `test_request.claimed` + `result.finalised` |
| Visit page → **Release** | medtech | OK → "Released via physical", `test_request.released` + `result.notified` (email; the "physical hand-off" policy skipped), revenue JE posted |
| Portal → Released row → **Download** | patient | OK — opens the 5-minute signed Storage URL, `result.downloaded` |
| Cleanup: **Undo** release (reason; dialog warns "patient has already downloaded 1 time") → **Void** payment (reason) → **Delete** visit (reason) → delete both qa accounts | admin | all OK; two reversal JEs posted; visit soft-deleted and restorable; portal now shows nothing for the patient |

### What the live run found (new or confirmed)
- **L1 — NEW, high: "Mark arrived" makes a walk-in-type booking vanish.** `appointments/page.tsx` `loadWalkInsCreatedToday` loads only `scheduled_at is null AND status = 'confirmed'`; every public lab-request booking has `scheduled_at = null`, so once arrived it is in no section (Today (0); "All (9)" = the pending callbacks). "+ Start visit" only renders for `arrived`, so it is unreachable for the whole walk-in class — patient-linked or not (H2 covered only the `patient_id = null` case). The dashboard "Walk-ins waiting: 1 / Arrived, awaiting registration" card links to a page that no longer shows the row, and because reception then starts the visit from the patient page the appointment **never** transitions arrived → completed — DRM-7264's appointment is still `arrived` now. **Fix:** include `arrived` in that loader (and let the visit-from-patient-page path complete an arrived appointment for the same patient), or route the dashboard card to a page that lists arrived walk-ins.
- **L2 — confirmation email for a walk-in lab request says "on your selected time"** (subject) and "Date / time: your selected time" (detail box) — the `: "your selected time"` fallback in `notify-appointment-booked.ts:119` fires whenever `scheduled_at` is null, i.e. for every walk-in lab booking, where the patient selected no time at all. Should read "Walk in any time, Mon–Sat 8:00 AM–5:00 PM" (clinic hours from config). Seen in the owner's inbox for DRM-7264 at 2:06 PM; the email otherwise rendered correctly (Resend, branded, View/cancel button).
- **A8 confirmed:** receipt print → no `receipt.*` audit row (28 audit rows in the run, none for the receipt).
- **H1 confirmed live:** admin dashboard "HMO unbilled aged 90+" = ₱954,157; true value ₱2,110,365.40 (all 2,031 rows are > 90 days).
- **H4 confirmed live:** medtech dashboard "Unclaimed in my sections: 16 / Send-out awaiting: 3"; `/staff/queue` → "Queue is empty."
- **A6 nuance:** the medtech's visit page shows "No active payments" (RLS hides `payments` rows from lab roles) so the Void button is not reachable by clicking — the unguarded action is a defense-in-depth gap, not a click-path one. But the same page still offers a lab role the **"Record payment"** link and the Total/Paid/Balance strip on a fully-paid visit.
- **M7 visible:** 9 stale `pending_callback` bookings whose only action is "↶ Revert".
- Admin dashboard also shows **"Possible duplicates: 174"** — a data-hygiene job for the owner (`npm run dedup:patients` exists).
- Portal with zero results renders a bare table header — no empty-state text.
- Date formatting on staff pages is US-style `9/11/2026, 2:10:51 PM` (queue timing, users list, consent "On file — 9/11/2026") while the appointments list uses "Sep 11, 2:06 PM" — inconsistent and ambiguous for a PH clinic (d/m vs m/d).
- Review step of `/schedule` shows the red "Please accept the service agreement" alert before the patient has tried to submit; the service picker is a flat list of ~200 checkboxes with raw codes shown for services lacking a description (e.g. "AMH AMH", "ACETYLCHOLINE_RECEPTOR_AB"); the `/schedule` footer still says only "reception verifies your identity at the counter" (`/register` got PR 7's "and confirms your details").
- Every page `<title>` ends "— drmed.ph — drmed.ph" (site suffix applied twice; staff login, portal, booking).
- Users list has a column showing "Neither" for password-only accounts — check what that column means (sign-in method?).

### What is left behind on prod (deliberate)
- Patient **DRM-7264 "Zed Qa-Test"** (7904a841-…) with one soft-deleted visit #0042 (reason recorded), a voided ₱360 payment, one released-then-undone CBC result + its PDF in Storage, four journal entries (payment, revenue, and their two reversals — net ₱0), and an appointment stuck at `arrived` (L1). Owner may mark it no-show/cancel or leave it.
- 28 audit rows describing exactly the above.
- One booking-confirmation email in jamilaian21@gmail.com (check its "when" line against 2:06 PM — A7).
- `admin@drmed.ph` and `reception@drmed.ph` are still **active** with the QA password — rotate or deactivate before go-live (A1). `qa-medtech` / `qa-pathologist` are soft-deleted.

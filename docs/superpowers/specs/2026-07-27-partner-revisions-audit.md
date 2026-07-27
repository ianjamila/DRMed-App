# Partner Revisions Audit — 2026-07-27

**Status: LOCKED 2026-07-27.** This is the plan of record for the 23-item partner revision list.
The six "Locked decisions" below are adopted as defaults; a client answer may override an
individual decision any time before its PR starts, otherwise build exactly as written here.

Audited against `main` (31e8c49) and prod DB (migrations through 0117 applied; 0118/PR #116 NOT on prod).

Verdicts: **5 done, 5 partial, 13 not done.**

## Item-by-item

### 1. Remove receipt printing for doctor consultations — NOT DONE
- `visits/new/actions.ts:448-452` unconditionally redirects every new visit to `/receipt` or `/group/{id}/receipt`.
- Group receipt renders a dedicated doctor slip FIRST: `visits/group/[groupId]/receipt/page.tsx:17,49-63` (`DOCTOR_KINDS`).
- Single-visit receipt has no kind filter: `visits/[id]/receipt/page.tsx:19-58`.
- Reprint buttons unconditional: `visits/[id]/page.tsx:286-292`, `visits/queue/page.tsx:276-283`.
- **Caveat:** the receipt is the delivery vehicle for the one-time portal Secure PIN + DRM-ID
  (`visits/[id]/receipt/page.tsx:182-216`). Consult-only visits arguably don't need it, but confirm
  with client. Clean cut points: the redirect in `actions.ts:446-452` and the doctor slip in the
  group receipt page.

### 2 & 9. Cash drawer for Reception — PARTIAL (exists, deliberately parked)
- Fully built: `payments/cash-drawer/` (page, client, actions), EOD count in `payments/eod/eod-client.tsx:51-155`.
- Parked in "Hidden tabs" per 2026-06-13 partner feedback: `staff-nav-config.ts:531-559` (roles reception+admin);
  dropped from reception dashboard quick links (`_dashboards/reception-dashboard.tsx:12-14`).
- Fix = restore nav item to Front desk section + reception dashboard quick link. No denomination
  breakdown UI exists (single counted total) — optional enhancement.

### 3. Doctor Procedures with custom peso fields — PARTIAL
- `doctor_procedure` kind exists; new-visit form has a procedure panel (description / HMO approved /
  clinic fee / doctor PF): `visits/new/visit-form.tsx:795-888`, persisted at `actions.ts:197-222,548-573`.
- BUT the line price itself is catalog-driven — only `doctor_consultation` gets a free-entry fee
  (`visit-form.tsx:341-347`, `actions.ts:136-150`).
- Fix: add `procedure_fee__<id>` input mirroring `consult_fee__<id>`; branch `base` on isDoctorKind.
- Also: visit detail page shows clinic fee/PF only for consults (`visits/[id]/page.tsx:654-660` gates on `isConsult`).
- No `doctor_procedure` services seeded (`scripts/seed-services.ts:29`) — catalog is admin-entered.

### 4. Billing & Receipts: classification column + filters + per-visit grouping — NOT DONE
- `visits/page.tsx:196-221` columns have no classification; only date-range filters (`:134-184`);
  query selects `test_requests(id)` only (`:86`) — `services.kind` not even fetched.
- No `visit_group_id` grouping — doctor visit + sibling lab visit are separate rows.
- Vocabulary already in DB: `services.kind` = lab_test / lab_package / doctor_consultation / doctor_procedure.

### 5. Discounts fix/customization — NOT DONE
- Hardcoded 5-option list in THREE places that must stay in sync: `visits/new/visit-form.tsx:66-94`,
  `visits/new/actions.ts:152-179` (hardcoded 0.1/0.05/0.2), CHECK constraint `0011_accounting_capture.sql:79-80`.
- `SENIOR_PWD_RATE = 0.2` hardcoded in `src/lib/pricing/senior.ts:17`.
- TRAP: `0067_normalize_senior_discount.sql` fixed the senior_discount_php data bug (169 services
  discounted 80–116%) and set policy "flat 20%", yet `service-form.tsx:239-248` + `prices-table.tsx`
  still expose the field — bug is re-creatable by hand.
- Proper fix: `discount_types` table + admin UI; or at minimum remove/guard the per-service field.

### 6. Rename "Billing & Receipts" → "Visits" — PARTIAL
- Page already titled "Visits" (`visits/page.tsx:11,125`). Nav label stale: `staff-nav-config.ts:109`
  (+ description `:115`) and `reception-dashboard.tsx:31`.

### 7. Registration Link → Hidden Tabs — NOT DONE
- Still top-level in Front desk: `staff-nav-config.ts:84-89`; also quick link `reception-dashboard.tsx:23`.

### 8. Hidden tabs collapsed by default + admin-only — NOT DONE
- Sections are static (`staff-nav.tsx:111-124`); only subgroups use `<details>` (`:57-102`).
  "Hidden tabs" is declared flat `items:` (`staff-nav-config.ts:537-538`).
- Roles broad (reception/medtech/pathologist see items). `visibleNavFor()` (`:580-602`) has no
  admin-only concept.
- NOTE conflict: making it admin-only removes Cash drawer / Sell gift code / My payslips from
  reception+staff — decide with items 2/9 (restore cash drawer to visible Front desk first).
  My payslips is used by ALL roles — moving it admin-only would break payslip access. Flag to client.

### 10. Waiting-for-payment must not be claimable / not in Lab Queue — NOT DONE (design decision needed)
- Lab queue query never touches `visits.payment_status` (`queue/page.tsx:79-120`); `claimTestAction`
  guards only status+header (`queue/actions.ts:22-57`); same for consolidated chemistry claim.
- Payment currently enforced only at RELEASE (`visits/[id]/actions.ts:78-82`,
  `finalise-consolidated.ts:122-140` — `releaseDeferred:"payment"` is intentional design).
- "waiting" stage exists only in reception queue-stage logic (`src/lib/visits/queue-stage.ts:8,60-67`).
- **Decision needed:** gate must be "paid OR HMO-billed" — a naive payment_status gate would block
  all HMO patients from the bench. Also decide partial-payment behavior.

### 11. Remove "DRM-XXXX · Visit #NNNN" in Lab Result Form — NOT DONE
- Three surfaces: `queue/consolidated/[visitId]/[groupId]/consolidated-form.tsx:163`,
  `queue/[id]/page.tsx:278` and `:550`.

### 12. Unclaimed lab requests in staff/results — DONE (caveat)
- `results/page.tsx:26-31`: `in_progress` filter includes `requested`; `all` has no status predicate;
  no assigned_to filter. Caveat: tab is labelled "In progress" — consider a dedicated "Unclaimed" tab.

### 13. Advance release of paid+completed results — DONE
- `releaseTestAction` releases a single ready test independent of siblings (`visits/[id]/actions.ts:53-116`);
  per-row buttons, bulk release, undo-with-reason all shipped (PRs #102–#105). Package HEADER
  auto-releases only when all components terminal (by design); components release early individually.

### 14. Chemistry FBS_RBS can't enter values — DONE (on prod)
- Root cause: prod group template held 1/14 param rows. Fixed by `0115_restore_chemistry_group_params.sql`
  — CONFIRMED applied to prod (list_migrations 2026-07-27).
- Residual risks: `SERVICE_TO_PARAMS` hardcoded client map (`consolidated-form.tsx:22-34`) — new/renamed
  chemistry code silently disables all rows; patients with `sex=null` lose gendered params (Creatinine,
  Uric Acid) (`:51-54`).

### 15. Visit #0037 routine package can't enter results — PARTIAL
- FBS_RBS component failure = item 14, fixed by 0115.
- Remaining: visits created before `0040_package_decomposition` have flat package requests with ZERO
  components → "No component test requests linked to this header" (`queue/[id]/page.tsx:583-587`),
  no way to enter results. 0040 had no backfill; decomposition failures surfaced only at order time.
- Fix: backfill migration/script decomposing legacy package test_requests.

### 16. info@drmed.ph — DONE (shipping code)
- Single source `src/lib/marketing/site.ts:39`; all consumers read CONTACT.email.
- Stale `drmedhealthcare@gmail.com` in non-shipping docs: `DRMed-Local-SEO-NAP-and-Citations.html:120,121,161`
  (contradicts code — update, it's the citations source doc), `Email-Rendered-FromCode.html:27`,
  `design-handoff/homepage.html:727`.

### 17. NA (Sodium) send-out — DONE (on prod)
- `0116_na_send_out_config.sql` CONFIRMED on prod. `send_out_unit_cost_php` deliberately NULL →
  NA lists on `/staff/admin/accounting/cogs/send-outs/unconfigured` until clinic supplies cost.
  ASK CLIENT for the Hi Precision NA cost.

### 18. Rename reception QUEUE → "Reception Queue" — NOT DONE
- `staff-nav-config.ts:91-95` ("Queue", reception+admin). Collision: Lab section also has "Queue"
  (`:158-161`) — admins see two identical labels. Also rename in `visits/_components/visits-tabs.tsx:6`,
  page h1+metadata (`visits/queue/page.tsx:24,174`), `reception-dashboard.tsx:24`.

### 19. Reception queue day filter, default today — PARTIAL
- Hard-locked to today (`visits/queue/page.tsx:121,134`); no picker (searchParams = stage only).
  Appointments page has a day-picker pattern to lift.

### 20. Lab Queue filters (date / patient / visit #) — NOT DONE
- Only 4 status tabs (`queue/page.tsx:60-64,231-248`). Lift the results-page filter UI
  (`results/page.tsx:196-256`, server filtering `:101-102,139-147`).

### 21. Portal: remove Google review refs + data download — NOT DONE (both live)
- Review card: `portal/(authenticated)/page.tsx:649-667` (+ `src/lib/seo/review.ts:14-24` "portal" source).
  Receipt CTA component `receipt-review-cta.tsx` is now an orphan — delete while here.
  (Review refs in release notifications/emails were NOT in scope of the ask — confirm.)
- Data export: `page.tsx:713-729` + `data-export/route.ts`. NOTE: this was built for RA 10173 (Data
  Privacy Act) compliance — flag to client before removing; consider hiding UI but keeping route.

### 22. Queue deletion w/ confirm + history + reason + undo — NOT DONE
- Zero delete affordances in either queue. No soft-delete columns on test_requests.
- Reuse patterns: undo-release dialog + reason + audit (`visits/[id]/undo-release-dialog.tsx`,
  `actions.ts:369-481`, `0110_undo_release.sql`, report page `admin/reports/undone-releases/`);
  void-payment dialog; amendment reason validation (`queue/[id]/actions.ts:912-920`).
- Design: soft-delete (`deleted_at`, `deleted_by`, `delete_reason`) + restore action + history page.
  Decide roles (admin-only? reception?) and GL implications for billed visits (likely restrict to
  unpaid/zero-payment visits, else route through void-payment first).

### 23. Doctor PF consultation payment — WORKS end-to-end; polish gaps
Flow: counter-priced consult fee + physician → split visits per group → normal payment → PF recognized
at "Mark consultation done" (release) → `doctor_pf_entries` → pf-payouts batches + YTD report.
Gaps, ranked:
1. **Procedures never accrue PF via a sane path** — `markConsultationDoneAction` rejects non-consults
   (`visits/[id]/actions.ts:565-568`); procedures route through lab pipeline. Add "Mark procedure done".
2. **Hardcoded ₱100 clinic cut** (`src/lib/visits/consultation-fee.ts:8`); no per-doctor default fee or
   % split — reception retypes fees each visit, unauditable.
3. **Advertised per-line physician override doesn't exist** — helper text at `visit-form.tsx:505-507`
   lies; `test_requests.attending_physician_id` never written; `visits-attending.ts` actions are dead code.
4. Accounting export drops doctor name (`src/lib/accounting/sync.ts:260,301`, `mappers.ts:127`).
5. No payout acknowledgment slip (nothing to sign at `pf-payouts/[id]`).
6. Silent numeric-fallback in fee split (`consultation-fee.ts:30-35`); no doctor-facing PF statement
   (RLS admin-only, `0064:224-232`); discount-absorption policy baked into trigger SQL.

## Locked decisions (client-friendly wording; client reply may override before the affected PR)

1. **Lab tests before payment (item 10).** Today the lab can start on a sample before payment;
   payment is only enforced at result release. A strict "paid only" queue would block all HMO
   patients (they never pay at the counter).
   *Proposed:* cash patients must be fully paid to appear in the lab queue; HMO-covered visits pass
   through automatically. → Build as "paid OR HMO-billed" gate unless client objects.
2. **Discounts (item 5).** We'll build an admin Discounts page (add/rename, percent or fixed peso).
   *Need from client:* the actual list of discounts they give today + rates. Senior/PWD stays fixed
   at 20% (statutory).
3. **"Download my data" (item 21).** Data Privacy Act right-to-copy feature.
   *Proposed:* hide the portal button, keep the route/capability for formal requests. → Hide UI only.
4. **Consult-only receipts (item 1).** The slip carries the one-time portal PIN; removing it means
   consult-only patients get no portal access.
   *Proposed:* acceptable — they have no lab results to view; they get a slip if lab work is added later.
5. **Sodium (NA) send-out cost (item 17).** Needed to configure COGS.
   *Proposed:* pull the price from the Hi Precision rate card already on file (see send-out
   costs/vendors notes), confirm the number with the client before saving.
6. **Queue deletion (item 22).** *Proposed:* reception + admin may delete UNPAID entries only, with
   required reason, history log, and undo; entries with payments require an admin payment-void first.

## Locked build order

**Model guidance:** PRs A–E are mechanical against this spec — run on **Opus 5**, normal effort,
Sonnet for sub-agents. PRs **F, G, H, I** are judgment-heavy (payment gating w/ HMO carve-out,
discounts schema, deletion lifecycle + GL implications, PF accounting polish) — **switch to Fable**
for those sessions before starting.

- **PR A — Quick wins (start immediately, no schema):** nav rename "Billing & receipts"→"Visits"
  (item 6); reception "Queue"→"Reception Queue" everywhere incl. section tabs/h1/metadata (18);
  remove "DRM-#### · Visit #" from the 3 result-entry surfaces (11); move Registration link into
  Hidden tabs (7); restore Cash drawer to visible Front desk nav + reception dashboard quick link
  (2/9); portal: remove Google-review card + delete orphaned `receipt-review-cta.tsx`, hide
  data-export UI but keep route (21, per decision 3); fix stale gmail in
  `DRMed-Local-SEO-NAP-and-Citations.html` (16).
- **PR B — Hidden tabs behavior (8):** collapsible `<details>` section, collapsed by default;
  admin-only gating EXCEPT "My payslips" moves out to a role-visible location first (all roles need
  payslips) — cash drawer already moved out in PR A.
- **PR C — Queue filters (19, 20):** reception queue day-picker defaulting to today (lift
  appointments day-picker pattern); lab queue date/patient/visit# filters (lift results-page filter
  UI + server filtering).
- **PR D — Visits page classification (4):** classification column from `services.kind`
  (Lab Tests / Doctor Procedures / Doctor Consults), kind filter chips, group rows by
  `visit_group_id` so split visits render as one visit.
- **PR E — Consult receipts + procedure fees (1, 3):** suppress receipt redirect + doctor slip for
  consult-only visits (per decision 4); add `procedure_fee__<id>` free-entry field mirroring
  `consult_fee__<id>`; show clinic fee/PF on visit detail for procedures too.
- **PR F — Lab queue payment gating (10):** gate = paid-in-full OR HMO-billed (decision 1); hide
  from queue AND block claim server-side (incl. consolidated chemistry claim).
- **PR G — Discounts (5):** `discount_types` table + admin CRUD page; Senior/PWD fixed 20%
  statutory; replace hardcoded lists in form/action/CHECK constraint; remove or hard-guard the
  `senior_discount_php` field that re-creates the 0067 bug.
- **PR H — Queue deletion lifecycle (22):** soft-delete (`deleted_at/by/reason`) on unpaid entries
  only (decision 6), confirm dialog + required reason (reuse undo-release pattern), deletion-history
  page (model on undone-releases report), undo/restore action; paid entries → admin void-payment first.
- **PR I — PF polish + legacy repair (23, 15):** "Mark procedure done" path so procedures accrue PF;
  per-doctor default consultation fee + configurable clinic cut (replace hardcoded ₱100); remove the
  false "per-line override" helper text and dead `visits-attending.ts` actions (or wire them up);
  populate doctor name in accounting export; backfill-decompose pre-0040 legacy package visits.
- **Parallel/data task:** confirm NA unit cost from Hi Precision rate card and set
  `send_out_unit_cost_php` (decision 5) — clears the unconfigured-send-outs list.

## Backlog — worth doing, not blocking (surface to client after PR I)

- "Unclaimed" filter tab on staff/results (currently folded into "In progress").
- Cash drawer denomination-count UI for EOD (today a single counted total).
- Doctor-facing PF statement (RLS is admin-only today) + printable payout acknowledgment slip.
- Admin UI for the consolidated chemistry group template; move `SERVICE_TO_PARAMS` out of the
  hardcoded client map; handle `sex=null` patients losing gendered chemistry params.
- Percentage-based PF splits per doctor (model is fixed-peso only).

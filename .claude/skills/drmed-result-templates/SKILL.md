---
name: drmed-result-templates
description: Use when working on DRMed lab result templates, structured result entry, the consolidated chemistry (report-group) form, the lab queue / results archive worklists, or the PDF rendering pipeline. Trigger whenever the user mentions result template, lab result, lab report, lab result PDF, test result, result_templates, result_template_params, result_template_param_ranges, result_values, report_groups, report_group_service_params, group template, consolidated template, chemistry template, CHEMISTRY, consolidated form, claim this report, structured form, structured result entry, pathologist sign-off, requires_signoff, ready_for_release, unclaimed, in progress tab, results archive, status-filter, lab queue, claim test, claimTestAction, claimConsolidated, unclaimOwnTestAction, unclaim-own-button, self-service unclaim, scopeToAllowedSections, reassignTestAction, ReassignPanel, package header, is_package_header, stuck tests, template health, template-health cron, result PDF, render PDF, renderResultPdf, renderOne, loadTemplateParams, loadResultDocumentInput, buildPreviewValues, ResultDocument, pdf-document, @react-pdf/renderer, smoke render, smoke:results, smoke:chemistry, CBC, urinalysis, ROUTINE_PACKAGE, FBS, LIPID_PROFILE, age-banded ranges, reference ranges, abnormal_values, flag computation, critical alerts, dual unit, SI conversion, package summary, P0041, or any staff route under /staff/queue, /staff/results, /staff/admin/result-templates, /staff/signoff. Don't make Claude rediscover the 4-layout pipeline or the group-template indirection from scratch.
---

# DRMed result templates & PDF render pipeline

## What this is

The lab-result PDF generation stack — from the per-service template definition down to the rendered PDF a patient downloads. There are **4 layouts** (`simple` / `dual_unit` / `multi_section` / `imaging_report`) and ~70 seeded service templates. Rarely touched, but every piece of the pipeline matters when it is. Pathologist sign-off is a separate flow gated by `services.requires_signoff`.

## Architecture at a glance

```
supabase/migrations/
├── 0007_result_templates_and_values.sql   ← schema (templates, params, values)
├── 0009_result_param_age_bands.sql        ← age-banded range overrides
├── 0010_drop_compute_result_flag_trigger.sql ← moved flag computation to app (see below)
├── 0040_package_decomposition.sql         ← package headers; tg_test_request_parent_is_header
├── 0051_consolidated_reports_and_signatures.sql / 0053_chemistry_seed.sql ← report_groups + the ONE consolidated CHEMISTRY template
├── 0109_package_release_lifecycle.sql / 0110_undo_release.sql
├── 0115_restore_chemistry_group_params.sql ← repaired the group template after a manual bulk delete
├── 0120–0122                              ← report_group_service_params (which group params each service enables),
│                                            param-delete guardrails (P0041, audited), activation audit
└── 0172_result_edit_commit.sql            ← ONE write path for structured results: result_save_draft /
                                             result_finalise_commit / result_edit_commit (service_role only, row lock,
                                             P0065 stale / P0066 not editable), section read rule
                                             (lab_sections_for_role + staff_can_read_finished_result), P0067 delete guard

src/lib/results/
├── loaders.ts              ← loadTemplateParams(); loadResultDocumentInput(id, { finalisedAtOverride, valuesOverride, signerStaffId }) LAZY-imports the admin client (keep it that way — smoke:results runs under tsx)
├── value-rows.ts           ← pure: submitted values → flagged rows (buildValueRows), PDF values, merge, critical crossings (detectCrossings), missing-value check — every structured write builds its RPC payload here
├── result-edit.ts          ← pure: EDITABLE_STATUSES, validateEditReason, editVersionPath/versionBase (attempt-unique object names), classifyCommitError, countValueChanges
├── preview-data.ts         ← buildPreviewValues() — synthesizes demo values for admin preview
├── render-pdf.ts           ← renderResultPdf() — wraps @react-pdf/renderer renderToBuffer
├── pdf-document.tsx        ← Server Component, ~37KB. The full layout engine.
├── status-filter.ts        ← results-archive tab config as pure data (RESULT_STATUS_SPEC, parseResultStatusFilter)
├── template-health.ts      ← 6 pure drift checks + daily/weekly email gate + shared 26-hour heartbeat threshold
├── collect-template-health.ts ← shared server scan + last daily audit timestamp for the cron and admin health page
└── types.ts                ← ResultLayout, ParamValue, TemplateParam, EffectiveRange, ResultDocumentInput (ageAsOf)

src/lib/actions/results/
├── result-edit-core.ts     ← server-only commit protocol: commitResultFinalise / commitResultEdit (upload → RPC → classify), auditAlertChanges
├── finalise-consolidated.ts ← chemistry finalise (+ release)
└── amend-consolidated.ts   ← chemistry "Edit results" on a finished report

src/app/(staff)/staff/(dashboard)/
├── queue/page.tsx                      ← lab worklist: All / Mine / Pending release / Released today + date-range, patient/test search, visit #, shared sort/paging
├── queue/[id]/page.tsx                 ← single-test detail; REDIRECTS to the consolidated form when the service has a report_group_id
├── queue/[id]/structured-form.tsx      ← form UI for structured entry + finalize
├── queue/consolidated/[visitId]/[groupId]/ ← consolidated (chemistry) page: a report card per finished result (report-cards.tsx, Edit results via ?edit=<resultId> → report-edit-form.tsx, edit history) + the entry form for tests still on the bench (consolidated-values-table.tsx is shared by both forms)
├── results/page.tsx                    ← results archive (status tabs incl. Unclaimed; Manila date bounds; shared sort/paging; fold in src/lib/results/archive-fold.ts)
├── admin/result-templates/[service_id]/edit ← per-service template editor
├── admin/result-templates/group/[group_id]/edit ← GROUP template editor + per-service param mappings (PR #120)
├── admin/result-templates/preview/[service_id]/route.ts, preview/group/[group_id] ← admin preview endpoints
├── admin/reports/stuck-tests           ← orphan detectors: zero-child package headers, visits with no test lines
└── signoff/page.tsx                    ← pathologist sign-off — still a placeholder ("UI to come")

scripts/
├── smoke-render-results.ts             ← npm run smoke:results — render 3 archetypes + package summary
└── smoke-chemistry-consolidated.ts     ← npm run smoke:chemistry
```

## Consolidated report-group templates (chemistry) — the indirection that fools everyone

Chemistry does **not** use per-service templates. 0053 deactivated the 12 per-service chemistry templates and replaced them with ONE template where `service_id is null` and `report_group_id = CHEMISTRY`; the 12 services carry `services.report_group_id`. `queue/[id]/page.tsx` redirects unconditionally to `/staff/queue/consolidated/{visitId}/{groupId}` for any such service, so **reactivating a per-service chemistry template is a no-op** — it is unreachable either way.

- Which group params a given service enables lives in `report_group_service_params` (0120; 19 mapping rows — gendered Creatinine/Uric Acid make 17 entries into 19 pairs). `LIPID_PROFILE_PACKAGE` has NO mappings by design (billing header; its ₱0 components carry the encoding).
- Admin surface (PR #120): `/staff/admin/result-templates/group/[group_id]/edit` + preview. Deleting a param that has values is blocked (P0041) and audited in SQL; activation flips are audited (0122). `/staff/admin/result-templates/health` lists live findings by severity and links to group editing. The daily template-health cron (6am Manila) emails only errors/warnings; `?mode=weekly` (Tuesday 7am Manila) includes informational findings. Every completed scan is audited in both modes, including clean runs. Read the prior daily audit timestamp BEFORE writing the current run; weekly summaries never refresh the daily heartbeat. Missing or older-than-26-hour daily heartbeats override the email gate (daily recovery / weekly ongoing outage), and the page shows the last daily run plus a stale warning. Inactive stray templates are informational history.
- The encoding fields render only after a medtech clicks **"Claim this report"** — that gate is not a bug. Don't claim a real patient's report to look; query `result_template_params` joined through `report_groups.code='CHEMISTRY'` instead.
- Finalise re-validates enabled params server-side (rejects stale submissions).
- **One result, N tests.** Finalise writes ONE `results` row + ONE PDF (`{resultId}.pdf`) linked to every member through `result_test_requests`. Anything that lists tests must fold by `result_id`, not by test — the archive once drew one "CODE PDF →" link per member, eight links to one file. Pure helpers: `src/lib/results/consolidated-reports.ts` (`partitionConsolidatedMembers`, `reportHeadlineStatus`, `codeDuplicatesName`) and `src/lib/results/archive-fold.ts`.
- **The consolidated page shows finished reports too.** It used to load only `requested | in_progress | result_uploaded` and redirect to `/staff/queue` otherwise, so a finished chemistry report (incl. `ready_for_release` awaiting payment) had no page, and every chemistry link — queue Open, Critical Alerts, bell, visit page, lab dashboard, Lab TAT, Stuck tests — dead-ended. It now partitions members: linked to a result WITH a PDF → a report card (one per `result_id`; a visit can have two when a test was added after finalise); otherwise an encoding status → the form. Package headers are excluded by `is_package_header = false`, not by status (a LIPID_PROFILE_PACKAGE header's section is `package` and would fail the section gate). The card links the stored PDF (report of record) rather than re-rendering values — ranges edited since would disagree with the PDF. Page views are audited `result.report_viewed_staff` (5-minute dedupe).
- **Single-test amend refuses shared reports.** `amendResultAction` / `amendStructuredResultAction` return "part of a combined report" when the result or service carries a `report_group_id` or the result has >1 member (a chemistry test would load an inactive per-service template and wipe every member's values). A combined report is edited as a whole with `amendConsolidatedReport` (card → **Edit results**).
- **A combined report is undone and deleted as a whole.** Undo release expands the selection to every member of any combined result it touches and refuses the request when a member is outside the caller's sections, a package header, or on another visit; a member of a finished combined report cannot be soft-deleted on its own (P0067, mirrored as `shared_report` in `src/lib/visits/deletion.ts`).

## Writing a structured result — one path (0172)

Drafts, the first finalise and every edit of a structured result go through three `service_role`-only RPCs that lock the `results` row, so they serialise and a finished result's values can only change through an edit that keeps a version. The JWT write policies on `results` / `result_values` / `result_amendments` are gone — every write is the service-role client.

| Step | RPC | Refuses |
|---|---|---|
| Draft save (single test) | `result_save_draft(p_result_id, p_values)` — upsert | P0066 once finalised |
| First finalise (both paths) | `result_finalise_commit(...)` — values (complete set), `storage_path`, `finalised_at` (fires the status flip inside the transaction), image, initial critical alerts | P0066 when already finalised, not structured, or a live member isn't in progress |
| Edit a finished result | `result_edit_commit(p_attempt_id, …, p_expected_amendment_count, …)` — snapshot (`prior_values_json` built in SQL under the lock), new values (null = PDF-only), new pointer, alert reconciliation | P0065 stale (`amendment_count` moved); P0066 no PDF / not finalised / a live member unfinished / no live member / anchor not live / reason out of 5–2000 |

- **The TypeScript side is `commitResultFinalise` / `commitResultEdit`** (`result-edit-core.ts`): render the PDF from the values ABOUT to be written (`loadResultDocumentInput(..., { valuesOverride })` or the inline builder), upload to an attempt-unique path (`<base>.v<N>.<attempt8>.pdf`, `upsert: false` — v1 is the original, so a finalise writes `.v1.<token>`), call the RPC. A **definite** rejection (SQLSTATE or `PGRST*` code) removes this attempt's objects — but only after re-asking the database whether the attempt committed [R1]; an **unknown** outcome (no code: fetch failure, timeout) keeps them and tells the user to reload. Nothing is removed after a confirmed commit.
- **Replay:** `result_amendments.attempt_id` is unique; the RPC checks it UNDER the row lock, so a lost response can be retried/probed without a second version.
- **`test_requests` is never written by an edit** — status, `released_at`, `released_by`, `release_medium` cannot change; `finalised_at` is untouched, so the advance trigger cannot fire.
- **Alerts on edit:** identity = (parameter, direction, observed SI). New crossings insert (and page), unacknowledged alerts the correction removed are deleted (audited `result.critical_alert_withdrawn`), acknowledged ones are never touched; a value corrected to a different critical value re-pages.
- **Who may read / edit a finished result:** `staff_can_read_finished_result(result_id)` — admin/pathologist always; medtech / xray_technician only when EVERY linked test (deleted ones included) is in `lab_sections_for_role(role)` (mirror of `SECTIONS_BY_ROLE`, pinned by `result-edit-migration.test.ts`) and every LIVE linked test is finished. It gates the `result_values` read policy (alongside the 0151 holder policy for bench drafts), the `result_amendments` read (reception reads none), the Edit button, `amendConsolidatedReport`, and the staff PDF route's `?version=N`.
- **Editor signs; date stays.** The edited PDF signs as the editor (owner decision) and keeps the control number and the ORIGINAL report date; age, reference band, flags and critical thresholds are all taken on that date (`ResultDocumentInput.ageAsOf`, defaulting to `finalisedAt`), so a correction after a birthday cannot move the band.
- **Versions:** v1 is the original; amendment seq N holds version N in `prior_storage_path`; the current PDF is version `amendment_count + 1`. `/staff/results/<testRequestId>/pdf?version=N` serves a replaced version (404 out of range).
- **Print/view audit rows stamp the SERVED version** (`servedAmendmentCount`, `print-summary.ts`): `metadata.amendment_count = (requestedVersion ?? currentVersion) - 1`, so printing a replaced version never marks the correction as handed over in the "Printed …" note (#223 review).
- **A shared report's CURRENT PDF has the every-member section rule too** (0176 PR): a lab role must cover every linked test, deleted ones included (`membersWithinSections` / `resultMemberSections`, `src/lib/results/report-section-gate.ts`). It rides into `canViewResultPdf` as `memberSections` (from `PdfState.memberSections`, so the visit page, queue and Print all only offer what the route serves) and gates `getResultDownloadUrl`. Reception keeps its #221 released-only rule; admin/pathologist are never narrowed.
- **Patient "Result updated" marker** (owner decision 2026-09-25, 0176): `results.patient_last_downloaded_at`, written ONLY by `result_note_patient_download(jsonb)` (service_role; `notePatientDownload` in `src/lib/results/patient-download.ts`) from every portal download path — single, consolidated, package (each merged component) and the data-export ZIP — with the exact `storage_path` served; a path an edit already replaced records `amended_at - 1µs` so the marker stays. Monotonic. Portal shows the chip when `patient_last_downloaded_at < amended_at` (`isUpdatedSinceDownload` — microsecond-precise; Date.parse would round the race case away). Never downloaded → never shown; no reason ever reaches the patient.
- **Clinic-only edit remarks** (0176): `result_amendment_remarks(uuid[])` returns the `queue_claim_remarks` row shape with action `result.amended`, one row per member test, gated per result by `staff_can_read_finished_result` (reception and out-of-section lab staff get none). `fetchClaimEvents` merges it (the Visit page passes `{ includeEdits: false }`); `claimRemarks` words it "Updated <when> by <who> — “reason”" (`timeInText`, so the list doesn't repeat the time). Every correction note says **Updated** (visit page, archive column, report card); the test pages' block is headed **History**, and each chemistry report card has one.
- **`reportEditLoadState`** (`consolidated-reports.ts`) is the shared "never edit over a failed read" rule: the page hides the editor and `amendConsolidatedReport` refuses a save when the template, stored values or mapping read errored.
- **Write paths load template params STRICTLY** (`loadTemplateParams(client, id, { strict: true })` throws `TemplateParamsLoadError`): draft save, both finalises, both edits and `loadResultDocumentInput` (which also refuses a failed value read). A failed range read would otherwise compute no flags and no critical thresholds — an edit then withdraws a still-valid critical alert and the stored PDF prints without ranges. Display pages keep the lenient default.
- **`result_amendments.commit_outcome`** (0176): `result_edit_commit` (redefined in 0176 — the 0172 body plus two marked hunks) records `{alerts_added, alerts_removed, alerts_kept_acknowledged}` in the same transaction and returns it on replay; the lost-response probe in `commitResultEdit` reads it too, so `result.critical_alert_withdrawn` is written even when the response was lost. Pre-0176 edits answer `outcome_unknown` and fall back to the sent alerts.
- **The patient data export scrubs clinic-only audit text** (`patientSafeAuditRows`, `src/lib/portal/export-audit.ts`): reason/note/remark/comment/prior_values keys are dropped at any depth; events stay.
- **`prepareStructured` and `amendStructuredResultAction` load ACTIVE templates only**; an inactive single-service template answers "No active template is configured for this service."
- **A finalised structured single test shows Edit, not the entry form**, and `prepareStructured` refuses it; the amend forms carry `expected_amendment_count`.

## Worklists: lab queue and results archive

- **Lab queue payment gate** (`src/lib/visits/lab-gate.ts`): All/Mine hide tests whose visit is neither paid/waived nor HMO-billed; claims are blocked server-side too. Pending release / Released today are ungated. The predicate itself now lives in `src/lib/visits/money-settled.ts` (`moneySettled`, `MONEY_SETTLED_VISITS_OR`) because migration **0133** made the release trigger agree with it — one definition of "money is settled" for the bench and for release. See `drmed-payments`.
- **Claims are section-scoped server-side.** `claimTestAction` (`queue/actions.ts`) and the consolidated form's claim both run `scopeToAllowedSections(rows, sectionsForRole(role))` (`src/lib/visits/bulk-selection.ts`) before the write — RLS lets every lab role *and reception* write `test_requests`, so the list's section filter is UX, not the guard. `[]` (reception) denies; `null` (admin/pathologist) is unrestricted. Three call sites, three near-identical strings, all worth grepping for by their tail: `"This test is outside the sections you can claim."` (`queue/actions.ts`), `"This report is outside the sections you can claim."` (the consolidated claim), `"This test is outside the sections you can release."` (`visits/[id]/actions.ts`).
- **X-ray is X-ray-technician-only to CLAIM** (owner decision 2026-09-24): `canClaimSection(role, section)` / `claimOwnerRole` in `src/lib/auth/role-sections.ts` layer a single-owner rule (`imaging_xray → xray_technician`) on top of the role scope, so even the unrestricted admin/pathologist cannot claim an x-ray. Enforced in `claimTestAction`, `claimConsolidated` and `reassignTestAction` (the new holder must pass `canClaimSection` for the test's section — that also stopped a medtech being handed an x-ray); the list shows "X-ray technician only", the detail page a status note, and the ReassignPanel lists only eligible staff. Viewing, releasing and unclaiming are unaffected. Ultrasound/ECG deliberately NOT restricted.
- **Queue list Unclaim + Remarks** (#TBD, 0160): `unclaimFromQueueAction` (`queue-unclaim-button.tsx`) takes a LIST of ids so a consolidated chemistry card hands back its whole panel; admin → anyone's claim, everyone else → own only. `performUnclaim` is list-based and writes one `test_request.unclaimed` audit row PER TEST (`resource_id` = the test). The Remarks column reads `queue_claim_remarks(uuid[])` (0160, SECURITY DEFINER, lab roles only, ≤200 ids, returns names + reason only) because `audit_log` SELECT is admin-only; `src/lib/queue/claim-remarks.ts` formats it and collapses per-member group rows. The same history shows as a Remarks column on the results archive (fetched via the signed-in client — the archive's own reads use the admin client, under which the RPC returns nothing) and as the "History" block (claims + result edits, see 0176 above) on `queue/[id]`, the consolidated page and each chemistry report card, all through `fetchClaimEvents` (`src/lib/queue/fetch-claim-events.ts`, chunks at 200) + `ClaimRemarksList`/`ClaimHistory` (`src/components/staff/claim-remarks-list.tsx`). The consolidated page now has Unclaim too (holder or admin, every member in progress). Queue tab `?filter=unclaimed` = requested/in_progress with `assigned_to is null` on the worklist money gate — the exact predicate of the lab card `lab.my_unclaimed` and the admin card `admin.queue_unclaimed`, which both link to it. The Visit page shows a `HandedBackBadge` (`handedBack()` in `claim-remarks.ts` — unclaims only, reassignments don't count) under the status of component and ordinary test rows, never package headers.
- **Self-service unclaim** (`unclaimOwnTestAction` + `queue/[id]/unclaim-own-button.tsx`): the holder can put their own claim back while `status = 'in_progress'` and nothing is uploaded. Ownership is proven in the UPDATE's WHERE (`.eq("assigned_to", ownerId)`), not read-then-write — RLS on `test_requests` is role-scoped, not row-scoped (0023). It shares `performUnclaim` with the admin path and is audited `test_request.unclaimed` with `self_service: true`. Admin's `ReassignPanel` (unclaim anyone / reassign) renders instead for admins, never alongside it.
- **Results archive tabs** (`status-filter.ts`): **Unclaimed** and **In progress** cover the same status pair (`requested`, `in_progress`) and split on ownership (`assigned_to is null` vs not) — a partition, so no row falls out of every tab. Unclaimed sorts oldest-first (a worklist) and shows an "awaiting payment" chip when the lab gate hides the row from the bench.
- **Package headers** (0040) auto-promote to `ready_for_release` on insert and never carry `requested`/`in_progress`; components are ₱0 rows with `parent_id`. Multi-row inserts must list headers before components (the trigger validates against same-statement rows in array order).
- **Soft-deleted lines** (0125) are excluded from both worklists, the consolidated form, and are refused by claim / unclaim / reassign / result entry / finalise.
- **Role sections**: `sectionsForRole(role) === []` means no access — both worklists deny, they don't skip the filter.
- **Every date bound is a Manila half-open window** (`manilaRangeUtc`); the queue pages with `count: "exact"` + `.range()` rather than a row cap. Free-text search runs after the chemistry fold, so it only narrows the page in hand — the UI says so.

## Schema

| Table | Purpose |
|---|---|
| `result_templates` | One per service. `(id, service_id [unique FK], layout, header_notes, footer_notes, is_active, created_at, updated_at)`. Layout ∈ `simple` \| `dual_unit` \| `multi_section` \| `imaging_report`. |
| `result_template_params` | Rows = printable parameters. `(id, template_id, sort_order, section, is_section_header, parameter_name, input_type, unit_si, unit_conv, ref_low_si/high_si, ref_low_conv/high_conv, gender, si_to_conv_factor, allowed_values[], abnormal_values[], placeholder)`. `input_type` ∈ `numeric` \| `free_text` \| `select`. |
| `result_template_param_ranges` (migration `0009_result_param_age_bands.sql`) | Age-banded overrides. `(parameter_id, age_min_months, age_max_months, gender, band_label, ref_low_si/high_si, ...)`. Falls back to `result_template_params` defaults when no row matches. |
| `result_values` | Per-result entry. `(id, result_id, parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank, created_at, updated_at)`. `flag ∈ H` (high) \| `L` (low) \| `A` (abnormal) \| `null`. **Computed in TypeScript** via `pickRangeForPatient` inside `finaliseStructuredAction` and written explicitly on upsert. The original DB trigger was dropped in `0010_drop_compute_result_flag_trigger.sql` because age-banded ranges need patient context (age + sex) that's awkward to join in plpgsql. |

## Render pipeline

| File | Function |
|---|---|
| `loaders.ts` (`loadTemplateParams`) | Query `result_template_params` by `template_id` ordered by `sort_order`. Query all `result_template_param_ranges` for those param IDs. Map ranges into a per-param lookup. Return `TemplateParam[]` with `ranges: ParamRange[]` populated. |
| `preview-data.ts` (`buildPreviewValues`) | For each non-header param: numeric → midpoint (every 5th forced high); select → first allowed value (every 3rd forced abnormal); free_text → `placeholder` or `(sample text)`. **Mirrors trigger logic** so preview matches finalized PDFs. |
| `render-pdf.ts` (`renderResultPdf`) | Calls `renderToBuffer(ResultDocument(input))` → returns `Buffer`. |
| `pdf-document.tsx` | The `Document` tree. Switches on `layout` to render the right structure. Handles units, flags, blank rows, package summary cover, image attachments. |

## The `renderOne()` function

Defined in `scripts/smoke-render-results.ts` (lines ~32–86). Pattern:

```ts
async function renderOne(code: string) {
  // 1. Fetch service by code (CBC_PC, ROUTINE_PACKAGE, URINALYSIS)
  // 2. Fetch result_templates row for that service
  // 3. loadTemplateParams(admin, tpl.id)
  // 4. buildPreviewValues(params)
  // 5. Assemble ResultDocumentInput (mock patient/medtech/control_no)
  // 6. renderResultPdf(input) → Buffer
  // 7. writeFileSync(/tmp/drmed-result-{layout}.pdf)
}
```

Loop in `main()` covers the 3 service codes plus a `package_summary` cover.

## `npm run smoke:results`

Runs `scripts/smoke-render-results.ts`. Renders to `/tmp/drmed-result-{layout}.pdf`. **Re-run after:**

- Template-layout edits in `pdf-document.tsx`
- `result_templates` schema changes
- Age-band range edits in `result_template_param_ranges`
- Flag-threshold changes (`abnormal_values`, ref ranges)
- React-PDF library bumps
- Before pushing to production to verify no regression

## Pathologist sign-off

`services.requires_signoff` boolean (default `false`) added in `0001_init.sql`. Effect:

- Medtech finishes test → status moves to `result_uploaded` (instead of `ready_for_release`)
- Pathologist must sign off → status moves to `ready_for_release`
- Then reception/release flow handles `released` (gated by payment trigger)

The flip itself is 0059's doing: linking a completed result to an `in_progress` test sets `result_uploaded` **only when** `services.requires_signoff`, otherwise `ready_for_release` directly. So `result_uploaded` reads as "linked, awaiting sign-off", and is empty in production because no service has the flag on.

UI state today:
- Medtech queue detail page (`queue/[id]/page.tsx`) shows "Awaiting pathologist sign-off" badge when `requires_signoff=true`
- Admin can toggle the flag per service via `/staff/services` form
- `/staff/(dashboard)/signoff/page.tsx` is a placeholder — full sign-off UI is queued
- The pathologist dashboard's **"Ready for sign-off"** card and its **"Pending sign-off"** strip (`_dashboards/lab-dashboard.tsx`) both count `result_uploaded` and both link `/staff/results?status=ready`. Keep them on the same status: the strip once counted `ready_for_release`, i.e. work already past sign-off, and disagreed with the card beside it.

## How to add a new template

1. Add a row to `result_templates` for the service (pick a `layout`)
2. Add `result_template_params` rows (one per printable parameter) with `sort_order`, units, ref ranges, abnormal values
3. (Optional) Add `result_template_param_ranges` rows for age/gender-banded overrides
4. Update `seed-result-templates.ts` if you want this template to ship with fresh installs
5. **Run `npm run smoke:results`** — eyeball the rendered PDF
6. If the parameter shape doesn't fit any of the 4 layouts, you're either misusing a layout or need a new one (5th layout = significant work in `pdf-document.tsx`)

## How to add a new layout

1. Add the layout value to the `result_templates.layout` CHECK constraint (new migration)
2. Add a `case` branch in `pdf-document.tsx`'s layout switch
3. Add representative service to `smoke-render-results.ts` `SERVICE_CODES`
4. Run smoke + open PDF
5. Document the new layout's intent in the schema comment

## Hard rules

- **Missing values use `is_blank=true` explicitly** — don't omit the row, or PDF layout shifts. `is_blank=true` renders as `—` in all layouts.
- **Flag computation runs server-side in TypeScript** (`buildValueRows` in `value-rows.ts` → `pickRangeForPatient` + `computeFlag`), passed to the 0172 RPCs. The original `compute_result_flag` DB trigger was dropped in `0010`. Don't reintroduce a DB trigger — the picker needs joined patient context that's clean in TS, messy in plpgsql. Use the same `pickRangeForPatient` helper everywhere (form, finalise, preview) so flags don't drift.
- **Dual-unit `si_to_conv_factor`** auto-fills conventional from SI when set. If user enters only conventional, it back-converts or compares against conventional ranges. Don't manually duplicate values.
- **Age-band fallback**: `result_template_param_ranges` overrides default `ref_low_si/high_si` when patient age/sex matches. No match → fall back to defaults. Don't query both and merge client-side; the loader handles it.
- **Imaging attachments**: JPEG / PNG / WebP / PDF only. HEIC/HEIF are not supported by `@react-pdf/renderer` without server-side conversion.
- **`@react-pdf/renderer` typings predate React 19** — `render-pdf.ts` casts through `unknown`. Don't try to "fix" the cast; it's load-bearing.
- **Critical-value alerts**: numeric values crossing `critical_low_si / critical_high_si` thresholds become `critical_alerts` rows, written by the finalise/edit RPC in the same transaction as the values (`detectCrossings`). If a parameter shouldn't trigger alerts, leave the critical thresholds NULL.
- **Never write `results` / `result_values` / `result_amendments` directly for a structured result** — go through `result-edit-core.ts`. A direct write skips the lock, the version check and the snapshot.
- **`filterParamsForPatient`** hides gender-specific rows that don't match patient sex. Don't bypass it on the assumption "we'll filter in UI" — the trigger and the PDF render both consume the unfiltered list otherwise.
- **No module-scope admin-client imports in `src/lib/results/`.** `admin.ts` imports `server-only`, which throws under `tsx`; `loaders.ts` lazy-imports it inside `loadResultDocumentInput` so `npm run smoke:results` keeps working. Follow that pattern.
- **Per-service chemistry templates are dead weight** — change the group template (above), not them.
- **Release is trigger-gated three ways**: payment (`enforce_payment_before_release`), consent (`enforce_consent_before_release`, ships OFF), and attending physician for PF-carrying doctor lines (P0034). A "can't release" report usually means one of these, not the template. Since **0133** the payment leg passes on `paid`, `waived`, **or** `hmo_provider_id is not null` — keep it in lockstep with `src/lib/visits/money-settled.ts`, whose unit test pins the trigger's SQL text (there is no pgTAP runner in `npm test`). "Mark consultation/procedure done" writes `status = 'released'`, so it goes through the same trigger and the same UX gate.

## When this skill should NOT trigger

- Generic database migrations that don't touch result templates — use the `drmed-migrations` skill.
- Auth / RLS work — use the `drmed-rls-and-auth` skill.
- Patient portal result-view/download UI (not template) — separate flow in `src/app/(patient)/portal/(authenticated)/` (reads via `createPatientClient`, see `drmed-rls-and-auth`).
- Lab pricing / quote tools — `services` table writes, but no template involvement.
- Imaging report routes that don't involve PDF rendering.

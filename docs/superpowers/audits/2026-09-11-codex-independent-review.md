Read-only review completed against checkout `0a50587`. I read `CLAUDE.md` first, then the supplied audit. I did not edit files, query a database, run tests, or start servers. Reproduction steps below are proposed scenarios, not executed tests.

Every source file cited below was opened. I did not inspect deployed configuration, production records, or Auth identities; consequently, production counts and account-readiness claims remain unverified. Database conclusions refer to the checked-in migrations and the configured [1,000-row limit](/Users/jamila/Claude/DRMed/supabase/config.toml:18).

## Verification of A1–A9

- **A1 — PARTLY.** The seed script does create active signature-only profiles using internal email addresses and no password. That supports the concern about those accounts **as initially created**. It does not establish today’s roster, later password/email changes, Google identities, or whether test accounts remain active. I cannot independently confirm “no real medtech/pathologist can sign in” or “zero X-ray accounts” without inspecting production Auth/profile data. [seed-signatures.ts:125](/Users/jamila/Claude/DRMed/scripts/seed-signatures.ts:125)

- **A2 — PARTLY.** The suggested cleanup mechanisms exist: unpaid, unreleased visits can be deleted; consultations can be marked completed by an appropriately authorized staff member. The specific 27 requests, visit numbers, payment states, and whether consultation 0038 actually occurred are production facts I could not verify. Payment alone is insufficient evidence to mark a consultation clinically complete. [deletion.ts:49](/Users/jamila/Claude/DRMed/src/lib/visits/deletion.ts:49), [visits/[id]/actions.ts:612](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts:612)

- **A3 — CONFIRMED, with a narrower meaning of “never.”** Component completion releases a package header only when `payment_status` is `paid` or `waived`; the alternative trigger also runs only on transition to those states. Neither recognizes an unpaid HMO-backed visit. Components are explicitly excluded from revenue posting, and the portal requires the header to be released before enabling the package download. Thus an otherwise completed HMO package can remain stuck and unrecognized **while its visit remains unpaid**. A later paid/waived transition can release it. [0109_package_release_lifecycle.sql:495](/Users/jamila/Claude/DRMed/supabase/migrations/0109_package_release_lifecycle.sql:495), [0109_package_release_lifecycle.sql:568](/Users/jamila/Claude/DRMed/supabase/migrations/0109_package_release_lifecycle.sql:568), [0131_zero_pf_release_exemption.sql:44](/Users/jamila/Claude/DRMed/supabase/migrations/0131_zero_pf_release_exemption.sql:44), [portal/page.tsx:218](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/page.tsx:218)

- **A4 — CONFIRMED.** Deleted rows bypass the section filter applied to active rows, and their service names and prices are rendered. Reception’s allowed section list is empty. The same omission can reveal another section’s deleted entries to lab/imaging roles. [visits/[id]/page.tsx:282](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx:282), [visits/[id]/page.tsx:1024](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx:1024), [role-sections.ts:33](/Users/jamila/Claude/DRMed/src/lib/auth/role-sections.ts:33)

- **A5 — PARTLY; the alleged financial write-off is refuted.** An admin can waive an HMO visit: neither the button nor action excludes HMO coverage. However, the action changes only `payment_status`. The release bridge still posts to HMO receivables when an HMO provider exists, and the unbilled view does not exclude waived visits. I found no write-off posting caused by this action. This is a misleading status/control issue, not demonstrated destruction of the HMO receivable. [visits/[id]/page.tsx:494](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx:494), [visits/[id]/actions.ts:525](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts:525), [0131_zero_pf_release_exemption.sql:135](/Users/jamila/Claude/DRMed/supabase/migrations/0131_zero_pf_release_exemption.sql:135), [0082_v_hmo_views_kind.sql:41](/Users/jamila/Claude/DRMed/supabase/migrations/0082_v_hmo_views_kind.sql:41)

- **A6 — PARTLY.** The authorization defect is confirmed: any active staff session can call the action with a known payment ID, and its service-role client performs the void. The ordinary medtech click path is not established: payment RLS hides payment rows from medtech/pathologist sessions, so their visit page normally has no corresponding Void button. The report’s later qualification is correct and should replace its stronger opening wording. [payments/[id]/void/actions.ts:17](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/payments/[id]/void/actions.ts:17), [payments/[id]/void/actions.ts:65](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/payments/[id]/void/actions.ts:65), [0001_init.sql:574](/Users/jamila/Claude/DRMed/supabase/migrations/0001_init.sql:574)

- **A7 — CONFIRMED in code.** Both formatters omit `timeZone`. On a UTC server, a 14:00 Manila appointment is displayed as 06:00. The booked-notification value also feeds SMS, not just email. The precise eight-hour production symptom depends on the deployed runtime timezone, which I did not inspect. [notify-appointment-booked.ts:114](/Users/jamila/Claude/DRMed/src/lib/notifications/notify-appointment-booked.ts:114), [cancel/[id]/page.tsx:45](/Users/jamila/Claude/DRMed/src/app/(marketing)/appointments/cancel/[id]/page.tsx:45)

- **A8 — CONFIRMED.** Neither receipt renderer nor the shared print handler records the disclosure. Clearing the PIN cookie does not supply an audit row. This violates the explicit receipt/print requirement in `CLAUDE.md`. The claim that *all other CSVs* audit is incorrect; see N15. [single receipt/page.tsx:110](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx:110), [group receipt/page.tsx:22](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx:22), [print-button.tsx:24](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/print-button.tsx:24), [CLAUDE.md:161](/Users/jamila/Claude/DRMed/CLAUDE.md:161)

- **A9 — CONFIRMED for untimed appointments.** The untimed loader requires `confirmed`, while Start visit appears only after `arrived` and only with a patient ID. Marking an untimed appointment arrived therefore removes it before its next-step link can appear. This does **not** affect every public lab booking: services requiring a slot retain `scheduled_at`. [appointments/page.tsx:160](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/page.tsx:160), [transition-buttons.tsx:125](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/transition-buttons.tsx:125), [timing.ts:64](/Users/jamila/Claude/DRMed/src/lib/appointments/timing.ts:64)

## Verification of B-high

- **H1 — CONFIRMED in code.** The dashboard aggregates a bare `v_hmo_unbilled` select, while the claims page uses paged fetching. With more than 1,000 qualifying rows, the dashboard can understate the aged amount/count. The report’s production count was not independently verified. [admin-dashboard.tsx:136](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx:136), [admin-dashboard.tsx:239](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx:239), [hmo-claims/page.tsx:31](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/page.tsx:31)

- **H2 — CONFIRMED, independently of A9.** Walk-in mode explicitly creates an appointment with `patientId: null`. The transition UI cannot start a visit without that ID, and completion rejects an unlinked appointment. Registering the person separately does not supply an attachment operation in this flow. Keeping arrived rows visible would therefore solve only A9. [new-appointment-actions.ts:81](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/new-appointment-actions.ts:81), [transition-buttons.tsx:125](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/transition-buttons.tsx:125), [appointments/actions.ts:166](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/actions.ts:166)

- **H3 — CONFIRMED.** Pending-callback notifications include a cancellation link, but the page permits only `confirmed`. The action itself permits `pending_callback`, so the inconsistency is in the page’s eligibility check. [notify-appointment-booked.ts:78](/Users/jamila/Claude/DRMed/src/lib/notifications/notify-appointment-booked.ts:78), [cancel/[id]/page.tsx:19](/Users/jamila/Claude/DRMed/src/app/(marketing)/appointments/cancel/[id]/page.tsx:19), [cancel/[id]/actions.ts:50](/Users/jamila/Claude/DRMed/src/app/(marketing)/appointments/cancel/[id]/actions.ts:50)

- **H4 — PARTLY; the oldest-unclaimed strip is more broken than reported.** The unclaimed and send-out counts omit the worklist payment gate. However, the oldest-unclaimed query also embeds `patients` directly from `test_requests`, which has a visit FK rather than a patient FK. Under the checked-in schema this relationship cannot resolve; its error is discarded and rendered as an empty list. The pending-signoff strip repeats that invalid embed. Thus the oldest strip is not simply an inflated count/list awaiting a payment filter. [lab-dashboard.tsx:112](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:112), [lab-dashboard.tsx:159](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:159), [lab-dashboard.tsx:181](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:181), [lab-dashboard.tsx:260](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:260), [0001_init.sql:131](/Users/jamila/Claude/DRMed/supabase/migrations/0001_init.sql:131)

- **H5 — CONFIRMED.** The critical-alert card and activity entries link to the general queue. A real critical-alert screen exists for pathologists/admins. The medtech activity link needs a role-appropriate destination rather than indiscriminately pointing everyone at the restricted acknowledgement page. [lab-dashboard.tsx:283](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:283), [lab-dashboard.tsx:335](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:335), [critical-alerts/page.tsx:48](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/critical-alerts/page.tsx:48)

- **H6 — CONFIRMED.** The checkbox is uncontrolled, and the cost/vendor fields depend on the original `is_send_out` value. Turning an existing service into a send-out leaves required fields unavailable, so update rejects it. Creation skips that configuration validation and can create an unconfigured send-out; reopening it for editing is a workaround for that creation path. [service-form.tsx:300](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/services/service-form.tsx:300), [service-form.tsx:319](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/services/service-form.tsx:319), [services/actions.ts:65](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/services/actions.ts:65), [services/actions.ts:115](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/services/actions.ts:115)

- **H7 — CONFIRMED.** Role and Active remain editable for the administrator’s own profile, and the update action performs a service-role update without checking self-demotion, self-deactivation, or the remaining active-admin count. The separate self-delete protection does not cover these operations. [staff-form.tsx:91](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/users/staff-form.tsx:91), [staff-form.tsx:127](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/users/staff-form.tsx:127), [users/actions.ts:90](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/users/actions.ts:90)

- **H8 — CONFIRMED.** A single oversized `.range()` does not paginate around the server cap. The export receives the short array, audits that array’s length, and returns CSV without a truncation indication. [emails-log/query.ts:174](/Users/jamila/Claude/DRMed/src/lib/emails-log/query.ts:174), [emails-sent/export/route.ts:44](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/admin/emails-sent/export/route.ts:44)

## New findings

**N1 — Reception can directly view and replace a lab result PDF.**

The individual queue page checks active-staff membership but does not enforce service-section access. It exposes View and Amend when a result exists. Both the download action and PDF amendment action then use a service-role client without checking the caller’s role or allowed section. The amendment replaces the canonical patient-facing PDF.

**Reproduce:** As reception, open `/staff/queue/<id>` for a finalized uploaded/send-out lab result. Click View/download, then amend it with a corrected PDF and a valid reason. The checked-in authorization permits both operations. The staff-read policies include reception, so this is reachable through the direct page URL.

[queue/[id]/page.tsx:39](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx:39), [queue/[id]/page.tsx:449](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx:449), [queue/[id]/actions.ts:905](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts:905), [queue/[id]/actions.ts:1006](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts:1006), [queue/[id]/actions.ts:1580](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts:1580), [0023_xray_technician_role.sql:67](/Users/jamila/Claude/DRMed/supabase/migrations/0023_xray_technician_role.sql:67)

**N2 — Consolidated finalization accepts tests belonging to different patients.**

Finalization proves claim ownership and parameter enablement, but does not prove that every test belongs to `input.visitId` or the same visit. The PDF loader assumes that invariant and takes the patient identity from the first linked test. Patient download authorization subsequently accepts any owned, released link to that shared PDF.

**Reproduce:** As a medtech, claim an FBS order for patient A and a creatinine order for patient B, both using the chemistry group. Modify a valid finalization request to include both claimed IDs and their enabled values, with A’s visit ID. The server permits one shared result; its PDF combines values under one patient’s identity and becomes downloadable through both patients’ released orders. This requires a modified action payload; the normal form scopes its initial query correctly.

[finalise-consolidated.ts:43](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:43), [finalise-consolidated.ts:145](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:145), [loaders.ts:188](/Users/jamila/Claude/DRMed/src/lib/results/loaders.ts:188), [portal/actions.ts:80](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/actions.ts:80)

**N3 — Consolidated chemistry omits abnormal flags and critical alerts.**

This path inserts numerical values without `flag`, and never invokes critical-value detection. The database flag-computation trigger was deliberately removed because the application now owns that calculation. The PDF loader uses the stored flag; it does not compensate.

**Reproduce:** On a valid paid, consented chemistry visit, enter a value above a configured reference limit and critical threshold, then finalize. The consolidated path saves the value without an H/L flag and creates no corresponding critical alert. This is separate from B-medium’s signoff concern.

[finalise-consolidated.ts:156](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:156), [0010_drop_compute_result_flag_trigger.sql:20](/Users/jamila/Claude/DRMed/supabase/migrations/0010_drop_compute_result_flag_trigger.sql:20), [loaders.ts:214](/Users/jamila/Claude/DRMed/src/lib/results/loaders.ts:214), [single-test critical detection:647](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts:647)

**N4 — Consolidated release does not record release time, actor, or medium.**

The update sets only `status: "released"`. Status-advancement triggers populate completion information, not these release fields. Consequently, successfully released tests can disappear from Released today and date-based reports; HMO movement reporting explicitly excludes missing release timestamps.

**Reproduce:** Finalize a paid standalone chemistry report, then inspect Released today and the report for that Manila day. Its tests are released with null release metadata and do not match the date filters.

[finalise-consolidated.ts:180](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:180), [0059_fix_result_status_advancement.sql:61](/Users/jamila/Claude/DRMed/supabase/migrations/0059_fix_result_status_advancement.sql:61), [queue/page.tsx:180](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/page.tsx:180), [0097_ops_hmo_provider_ar.sql:29](/Users/jamila/Claude/DRMed/supabase/migrations/0097_ops_hmo_provider_ar.sql:29)

**N5 — A failed consolidated finalization can leave committed clinical work without a PDF or a usable retry.**

The action commits a finalized result and its links, then values and release, before rendering/uploading the PDF. An upload failure returns an error after those writes. A subsequent attempt is rejected because the tests already have a result. Additionally, failure of the final `storage_path` update is ignored and can produce a success response.

**Reproduce:** In a controlled test environment, make the storage upload fail during an otherwise valid consolidated finalization. The tests can already be released, the result has no downloadable path, and retry says they already have a result. A finalized/ready result also falls outside the group editor’s actionable statuses.

[finalise-consolidated.ts:102](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:102), [finalise-consolidated.ts:124](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:124), [finalise-consolidated.ts:180](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:180), [finalise-consolidated.ts:200](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:200), [consolidated/page.tsx:41](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx:41)

**N6 — Undoing one test’s release does not withdraw its values from a shared PDF.**

Undo changes the selected test IDs. Its database cascade handles package headers, not every test sharing a consolidated result. The portal authorizes the unchanged whole PDF when any linked test remains released.

**Reproduce:** Release standalone FBS and creatinine together in one chemistry PDF. Undo only FBS. The patient can obtain a **new** download URL through the still-released creatinine result and read the withdrawn FBS value. This persists beyond the lifetime of any previously issued signed URL.

[visits/[id]/actions.ts:462](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts:462), [0110_undo_release.sql:58](/Users/jamila/Claude/DRMed/supabase/migrations/0110_undo_release.sql:58), [portal/actions.ts:80](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/actions.ts:80), [portal/actions.ts:102](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/actions.ts:102)

**N7 — The X-ray role cannot read its result links or structured values under the later RLS policies.**

Migration 0023 added X-ray access, but migration 0051 introduced the result junction and recreated value policies without `xray_technician`. The queue detail reads results through that junction and loads draft values through the RLS client. The saved database data is not necessarily deleted, but it becomes unavailable to the operator’s normal editing/viewing flow.

**Reproduce:** As an X-ray technician, save a structured imaging draft or finalize/upload an imaging result, then reload its detail page. The result embedding is hidden by junction RLS; saved draft values also fail the value-read policy, leaving the result panel or restored fields missing.

[0051_consolidated_reports_and_signatures.sql:62](/Users/jamila/Claude/DRMed/supabase/migrations/0051_consolidated_reports_and_signatures.sql:62), [0051_consolidated_reports_and_signatures.sql:239](/Users/jamila/Claude/DRMed/supabase/migrations/0051_consolidated_reports_and_signatures.sql:239), [queue/[id]/page.tsx:47](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx:47), [queue/[id]/page.tsx:213](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx:213)

**N8 — Receipts print deleted tests and include them in the amount due.**

Both receipt variants retain all test rows. They filter deleted rows only when deciding whether a receipt should exist, then render and total the unfiltered rows. Meanwhile, the deletion trigger correctly subtracts a deleted line from the visit total.

**Reproduce:** Create an unpaid visit containing two standalone lab lines priced ₱100 and ₱200. Delete the ₱200 line and reprint. The visit total becomes ₱100, while the receipt still lists both lines and totals ₱300. The group receipt repeats the mistake.

[single receipt/page.tsx:159](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx:159), [single receipt/page.tsx:217](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx:217), [single receipt/page.tsx:297](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx:297), [group receipt/page.tsx:134](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx:134), [0125_queue_entry_soft_delete.sql:184](/Users/jamila/Claude/DRMed/supabase/migrations/0125_queue_entry_soft_delete.sql:184)

**N9 — PIN issuance and reissue can produce credentials the patient cannot use.**

Login selects only the newest unexpired PIN by its original `created_at`. Two ordinary flows conflict with that rule:

- **Consultation after a lab visit:** creation inserts a new PIN, then intentionally suppresses its flash/receipt. The previously supplied lab PIN stops matching, and the patient receives no replacement.
- **Reissue for an older visit:** reissue changes the named visit’s hash and expiry without changing its creation timestamp. If a newer unexpired PIN exists, login ignores the freshly printed replacement.

**Reproduce:** First obtain a valid lab PIN, then create a later consultation-only visit and retry that PIN. Separately, with two unexpired visits, reissue the older visit’s PIN and try the printed replacement.

[portal/login/actions.ts:93](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/login/actions.ts:93), [visits/new/actions.ts:369](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/new/actions.ts:369), [visits/new/actions.ts:504](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/new/actions.ts:504), [reissue-pin.ts:49](/Users/jamila/Claude/DRMed/src/lib/actions/visits/reissue-pin.ts:49), [reissue-pin.ts:70](/Users/jamila/Claude/DRMed/src/lib/actions/visits/reissue-pin.ts:70)

**N10 — The patient data ZIP silently omits payments and can export deleted or truncated history.**

The payment query selects nonexistent `paid_at` and `reference` columns; the schema defines `received_at` and `reference_number`. Query errors are discarded, and `payments.json` becomes `[]`. Visit/test queries also omit soft-delete filters and pagination. The ZIP’s `truncated` flag tracks its PDF-size limit, not those query failures or row caps.

**Reproduce:** Download a ZIP for a patient with one recorded payment: `payments.json` is empty. Add a soft-deleted unpaid order and it appears in exported history without a deletion marker. With over 1,000 matching test/history rows, the corresponding collection is silently shortened.

[data-export/route.ts:39](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/data-export/route.ts:39), [data-export/route.ts:48](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/data-export/route.ts:48), [data-export/route.ts:130](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/data-export/route.ts:130), [data-export/route.ts:181](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/data-export/route.ts:181), [0001_init.sql:167](/Users/jamila/Claude/DRMed/supabase/migrations/0001_init.sql:167)

**N11 — Cancelling a multi-service booking leaves sibling appointments active.**

Booking creates one appointment per service with a shared group ID, but sends notification for only the first appointment. The public cancellation action updates only that appointment ID.

**Reproduce:** Submit a public booking for two lab services, then cancel using the emailed link. The first appointment becomes cancelled; the second remains confirmed. Reopening the emailed link reports the first appointment already cancelled rather than offering cancellation of the remaining service.

[appointments/create.ts:143](/Users/jamila/Claude/DRMed/src/lib/appointments/create.ts:143), [schedule/actions.ts:466](/Users/jamila/Claude/DRMed/src/app/(marketing)/schedule/actions.ts:466), [cancel/[id]/actions.ts:40](/Users/jamila/Claude/DRMed/src/app/(marketing)/appointments/cancel/[id]/actions.ts:40), [cancel/[id]/actions.ts:62](/Users/jamila/Claude/DRMed/src/app/(marketing)/appointments/cancel/[id]/actions.ts:62)

**N12 — Untimed requests also disappear at midnight without any arrival transition.**

The only untimed-confirmed loader restricts `created_at` to today. The other loaded sections require either a scheduled time or `pending_callback`. An outstanding confirmed request from yesterday therefore belongs to none of the displayed lists.

**Reproduce:** Submit an untimed lab request Monday evening and leave it confirmed. Open reception’s appointments page Tuesday morning: the outstanding request is absent. Fixing A9’s status predicate alone will not fix this date condition.

[appointments/page.tsx:160](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/page.tsx:160), [appointments/page.tsx:241](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/page.tsx:241)

**N13 — Gift-code redemption conflicts with the checked-in payment constraint.**

Redemption inserts a payment using `method: "gift_code"`, but the latest checked-in `payments_method_check` permits no such value. The gift-code migrations do not extend it.

**Reproduce:** Sell a valid gift code, open an unpaid visit, and redeem that code as payment. Under the migration-defined schema, the payment insert fails its method constraint before the redemption completes. This is more substantial than B-medium’s raw `gift_code` display label.

[payments/new/actions.ts:148](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/payments/new/actions.ts:148), [0011_accounting_capture.sql:174](/Users/jamila/Claude/DRMed/supabase/migrations/0011_accounting_capture.sql:174), [0014_gift_code_purchase_method.sql:11](/Users/jamila/Claude/DRMed/supabase/migrations/0014_gift_code_purchase_method.sql:11)

**N14 — Selling a gift code for cash does not increase expected drawer cash.**

Selling records purchase tender on `gift_codes`, without a payment or drawer-adjustment entry. Drawer cash-in sums only `payments`. Thus a correctly collected gift-code sale becomes an apparent overage.

**Reproduce:** With an otherwise balanced drawer, sell a ₱500 gift code using Cash and place the money in the till. Expected cash stays unchanged; counting the actual cash produces a ₱500 overage.

[gift-codes/actions.ts:63](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/gift-codes/actions.ts:63), [0014_gift_code_purchase_method.sql:4](/Users/jamila/Claude/DRMed/supabase/migrations/0014_gift_code_purchase_method.sql:4), [0132_eod_denomination_count.sql:177](/Users/jamila/Claude/DRMed/supabase/migrations/0132_eod_denomination_count.sql:177), [0132_eod_denomination_count.sql:221](/Users/jamila/Claude/DRMed/supabase/migrations/0132_eod_denomination_count.sql:221)

**N15 — Five additional CSV routes lack export audits and pagination.**

The gift-code sales export discloses buyer names/contact details without an audit row. The daily, cash, expenses, and HMO operations exports also have no audit call and build totals from unpaged selects. These operations exports contain aggregates rather than patient result details, but still violate the project’s general export-audit/paging requirement. All five use the service-role client.

**Reproduce:** Download the gift-code sales CSV containing a named buyer: there is no export audit insertion. With 1,001 qualifying sales, only 1,000 are returned. For the HMO operations CSV, use history producing over 1,000 provider/date movement rows: its bare all-history-through-`to` query yields an incomplete opening/ending balance, without a truncation warning. The other operations exports have the same defect when their source result sets exceed the cap.

[gift sales/route.ts:50](/Users/jamila/Claude/DRMed/src/app/api/admin/gift-codes/sales.csv/route.ts:50), [gift sales/route.ts:99](/Users/jamila/Claude/DRMed/src/app/api/admin/gift-codes/sales.csv/route.ts:99), [daily.csv/route.ts:22](/Users/jamila/Claude/DRMed/src/app/api/admin/operations/daily.csv/route.ts:22), [cash.csv/route.ts:25](/Users/jamila/Claude/DRMed/src/app/api/admin/operations/cash.csv/route.ts:25), [expenses.csv/route.ts:32](/Users/jamila/Claude/DRMed/src/app/api/admin/operations/expenses.csv/route.ts:32), [hmo.csv/route.ts:24](/Users/jamila/Claude/DRMed/src/app/api/admin/operations/hmo.csv/route.ts:24), [CLAUDE.md:216](/Users/jamila/Claude/DRMed/CLAUDE.md:216)

**N16 — Payment and release journal entries can be posted to the previous Manila day.**

The latest payment bridge casts `received_at::date`; the latest release bridge casts `released_at::date` or uses `current_date`. Neither converts to Manila first. With the UTC database timezone documented by this repository, transactions before 08:00 Manila fall on the previous accounting date, while drawer cash uses Manila correctly.

**Reproduce:** Record a payment at **October 1, 07:30 Manila**, equivalent to September 30, 23:30 UTC. Its payment journal is dated September 30, while October 1’s drawer includes the cash. A timestamped release has the same boundary problem.

[0091_clinical_backfill_provenance.sql:86](/Users/jamila/Claude/DRMed/supabase/migrations/0091_clinical_backfill_provenance.sql:86), [0131_zero_pf_release_exemption.sql:141](/Users/jamila/Claude/DRMed/supabase/migrations/0131_zero_pf_release_exemption.sql:141), [0132_eod_denomination_count.sql:180](/Users/jamila/Claude/DRMed/supabase/migrations/0132_eod_denomination_count.sql:180), [CLAUDE.md:212](/Users/jamila/Claude/DRMed/CLAUDE.md:212)

## Ranked go-live list

This ordering assumes the reviewed features will be available at launch. A1–A2 require operational verification before deciding the corrective action.

1. **Enforce role/section authorization on result access, amendments, deleted rows, and payment voids — N1, A4, A6:** active staff can currently perform actions outside their clinical or financial role. [queue actions:905](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts:905)
2. **Bind every consolidated result to one verified visit/patient — N2:** otherwise one result can mix patients’ data and be released to both. [finalise-consolidated.ts:43](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:43)
3. **Restore consolidated flags/critical detection and working alert navigation — N3, H5:** dangerous values can escape the expected clinical follow-up workflow. [finalise-consolidated.ts:156](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:156)
4. **Make consolidated completion recoverable after failure — N5:** an upload failure can strand released tests without a patient PDF. [finalise-consolidated.ts:180](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:180)
5. **Withdraw shared PDFs consistently when any included result is unreleased — N6:** the portal currently continues issuing access to withdrawn values. [portal/actions.ts:80](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/actions.ts:80)
6. **Verify usable clinical accounts and repair X-ray result RLS — A1, N7:** staff must be able to sign in and retrieve their saved work. [0051_consolidated_reports_and_signatures.sql:62](/Users/jamila/Claude/DRMed/supabase/migrations/0051_consolidated_reports_and_signatures.sql:62)
7. **Fix HMO package-header release — A3:** completed HMO packages can remain unavailable and fail to recognize package revenue/receivables. [0109_package_release_lifecycle.sql:495](/Users/jamila/Claude/DRMed/supabase/migrations/0109_package_release_lifecycle.sql:495)
8. **Remove deleted charges from both receipt variants — N8:** patients can receive a bill that exceeds their actual visit balance. [receipt/page.tsx:217](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx:217)
9. **Stamp release metadata in consolidated finalization — N4:** completed clinical work otherwise disappears from dated operational and HMO reporting. [finalise-consolidated.ts:180](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:180)
10. **Prevent loss of the last active administrator — H7:** an ordinary profile edit can remove the clinic’s administrative recovery path. [users/actions.ts:111](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/users/actions.ts:111)
11. **Repair gift-code redemption and drawer integration before accepting voucher sales — N13, N14:** the code can collect cash for a tender that cannot be redeemed and then misstate the drawer. [payments/new/actions.ts:148](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/payments/new/actions.ts:148)
12. **Use Manila posting dates in accounting bridges — N16:** early-morning transactions can enter the wrong day or month. [0091_clinical_backfill_provenance.sql:90](/Users/jamila/Claude/DRMed/supabase/migrations/0091_clinical_backfill_provenance.sql:90)
13. **Reconcile PIN issuance/reissue with login selection — N9:** routine subsequent visits and reissues can lock patients out. [portal/login/actions.ts:93](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/login/actions.ts:93)
14. **Complete the untimed-booking handoff and patient attachment flow — A9, H2, N12:** requests disappear on arrival or overnight, and unregistered walk-ins cannot be attached for completion. [appointments/page.tsx:160](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/page.tsx:160)
15. **Make public cancellation work for callback requests and whole booking groups — H3, N11:** patients currently cannot reliably cancel what they booked. [cancel/actions.ts:62](/Users/jamila/Claude/DRMed/src/app/(marketing)/appointments/cancel/[id]/actions.ts:62)
16. **Correct booking notification/cancellation timezones — A7:** slot-based patients can receive the wrong arrival time. [notify-appointment-booked.ts:114](/Users/jamila/Claude/DRMed/src/lib/notifications/notify-appointment-booked.ts:114)
17. **Add required receipt and export disclosure audits — A8, N15:** these screens currently disclose information without the mandated trace. [CLAUDE.md:161](/Users/jamila/Claude/DRMed/CLAUDE.md:161)
18. **Remove silent financial/export truncation — H1, H8, N15:** dashboards and downloaded reports can present partial amounts as complete totals. [hmo.csv/route.ts:24](/Users/jamila/Claude/DRMed/src/app/api/admin/operations/hmo.csv/route.ts:24)
19. **Repair the patient ZIP’s payment query, deletion handling, and paging — N10:** a successful download currently misrepresents the patient’s records. [data-export/route.ts:66](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/data-export/route.ts:66)
20. **Make send-out configuration completable and validated — H6:** normal service editing can become impossible, while creation accepts incomplete costing configuration. [services/actions.ts:115](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/services/actions.ts:115)
21. **Repair lab dashboard relationship queries and eligibility filters — H4:** staff otherwise see empty activity strips or work counts they cannot act on. [lab-dashboard.tsx:181](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:181)
22. **Reconcile the alleged trial records with clinic owners — A2:** establish which records are fixtures and which represent unfinished real work before cleaning the opening queue. [deletion.ts:49](/Users/jamila/Claude/DRMed/src/lib/visits/deletion.ts:49)

A5 does not qualify as the claimed financial-loss blocker. Its HMO wording/status behavior should be corrected, but the cited implementation does not write off the receivable. [0131_zero_pf_release_exemption.sql:135](/Users/jamila/Claude/DRMed/supabase/migrations/0131_zero_pf_release_exemption.sql:135)

## Disagreements with the report

- **A1–A2 are operational observations, not independently verified code conclusions.** The seed mechanism and cleanup capabilities are supported; the current account roster, 27-record count, and proposed completion of a particular consultation are not established by this read-only source review. [seed-signatures.ts:125](/Users/jamila/Claude/DRMed/scripts/seed-signatures.ts:125), [visits/[id]/actions.ts:612](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts:612)

- **A5’s “writes off live receivable” explanation is wrong.** Waiving changes visit status; HMO release accounting and unbilled eligibility still preserve the HMO receivable. [visits/[id]/actions.ts:550](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts:550), [0082_v_hmo_views_kind.sql:41](/Users/jamila/Claude/DRMed/supabase/migrations/0082_v_hmo_views_kind.sql:41)

- **A6 needs its later click-path qualification in the finding itself.** The action authorization flaw is real, but payment RLS prevents the ordinary medtech Void-button path described earlier. [0001_init.sql:574](/Users/jamila/Claude/DRMed/supabase/migrations/0001_init.sql:574)

- **A9 does not cover every lab booking, and fixing it does not subsume H2.** Slot-required labs retain a schedule; null-patient appointments still need an attachment mechanism even after arrived rows remain visible. [timing.ts:64](/Users/jamila/Claude/DRMed/src/lib/appointments/timing.ts:64), [appointments/actions.ts:166](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/appointments/actions.ts:166)

- **H4’s oldest-unclaimed explanation is incomplete.** Its invalid relationship query must be repaired before its payment-gate discrepancy can even be meaningfully observed. [lab-dashboard.tsx:187](/Users/jamila/Claude/DRMed/src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:187), [0001_init.sql:133](/Users/jamila/Claude/DRMed/supabase/migrations/0001_init.sql:133)

- **“All CSVs audit” and M16’s “every other report uses RLS” are false generalizations.** Gift-code sales and operations CSV routes provide counterexamples. Their defects are separate from the already-reported dashboard caps. [gift sales/route.ts:50](/Users/jamila/Claude/DRMed/src/app/api/admin/gift-codes/sales.csv/route.ts:50), [hmo.csv/route.ts:23](/Users/jamila/Claude/DRMed/src/app/api/admin/operations/hmo.csv/route.ts:23)

- **Section D’s “Verified OK” wording is too broad for several workflows.** The patient ZIP, PIN reissue, receipt reprint, consolidated chemistry, partial undo, gift-code payments/drawer behavior, and Manila accounting dates have concrete counterexamples above. Its assurance should be limited to the exact scenarios actually exercised. [data-export/route.ts:66](/Users/jamila/Claude/DRMed/src/app/(patient)/portal/(authenticated)/data-export/route.ts:66), [reissue-pin.ts:70](/Users/jamila/Claude/DRMed/src/lib/actions/visits/reissue-pin.ts:70), [finalise-consolidated.ts:156](/Users/jamila/Claude/DRMed/src/lib/actions/results/finalise-consolidated.ts:156), [0091_clinical_backfill_provenance.sql:90](/Users/jamila/Claude/DRMed/supabase/migrations/0091_clinical_backfill_provenance.sql:90)
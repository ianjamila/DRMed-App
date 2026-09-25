# Delete patients (soft delete, restorable) — 2026-09-24

Owner request (2026-09-24): "allow deleting of patients. make sure there is a confirm button
and that it doesnt remove their past history" → approved design, then "include all worth
considering".

## Why now (prod, read-only, 2026-09-24)

The owner's own email carries five test patient rows: three online bookings from June (one
appointment each, zero visits) and two QA records (one with a visit). Two of the bookings differ
from the first only by a one-digit birthdate typo and a one-letter last-name typo respectively. `resolve_patient_guarded` reuses a row only on an exact
(lower(email), last_name, birthdate) triple, so each typo minted a new DRM-ID. There is no way
to remove a row today: `patients` has no `deleted_at` (0150 says so), and the patient page has
no delete button.

## Owner decisions

1. **Admins only** delete and restore (`requireAdminStaff()`), matching Patient Merge.
2. **Restorable, no time limit.** Admin Tools › Deleted Patients lists them with Restore.
3. **Blocked while anything is open — owner revised rule, 2026-09-24, after review:**
   an appointment that is `pending_callback` (with or without a date), or `confirmed`/`arrived`
   with `scheduled_at` today or later (Manila date); any unfinished clinical work on a
   non-deleted visit/test request; any non-HMO, non-deleted visit with `payment_status` in
   (`unpaid`, `partial`); or an HMO visit with an unpaid patient share (co-pay/excess) **or** an
   open/unsettled HMO claim. A settled HMO claim does not itself block deletion, regardless of
   the visit's cached payment status. Clinical completion and money rules are independent;
   the exact predicates below govern both the dialog and the database. The dialog lists all
   blockers and disables confirmation; the database is the gate.
4. **Confirm = reason + red button.** Reason is required: `duplicate` / `test_record` /
   `patient_request` / `other` (+ note, required for `other`, max 500 chars). Stored on the row
   and in the audit log.
5. **A deleted identity that books or registers again gets a fresh record.** Deleted rows are
   invisible to all matching. Staff can restore + merge if it was the same real person.

## Soft delete, never a row removal

`patients` gains `deleted_at timestamptz`, `deleted_by uuid → staff_profiles`,
`delete_reason text` (check in the four values), `delete_note text`. Partial index on
`(id) where deleted_at is null and merged_into_id is null` for the active-directory reads.

Deletion/restoration writes only the patient lifecycle fields (and normal `updated_at`) plus
an append-only audit event. No cascade to visits, test_requests, results, payments, bill lines,
appointments, consents, contact messages or PINs; no historical audit row is rewritten.
Past visits keep counting in revenue and every financial/clinical report. Active-patient
worklists and acquisition counts are explicitly separate from historical reporting below.

**Core-delete migration** (next free number when PR 2 starts — 0159/0160 are claimed by other branches and PR 1 takes 0161; working name `patient_soft_delete.sql`):

- Columns, index and row checks: an active row has all four deletion fields NULL; a deleted
  row has timestamp, actor and a valid reason, trimmed note at most 500 characters, and a
  nonblank note for `other`. A row cannot be both deleted and merged. Use a restrictive
  `deleted_by` FK so deleting a staff profile cannot erase attribution.
- `patient_delete_blockers(p_patient_id uuid)` returns a deterministic JSON list of
  `{kind, resource_id, visit_id, label, amount_php, href}` (amount nullable). The dialog reads
  it through an admin-gated action; `delete_patient` calls the same SQL evaluator under lock.
  A preview is advisory; no client-provided blocker list or kept count is trusted.
- `delete_patient(p_patient_id uuid, p_reason text, p_note text, p_actor uuid, p_context jsonb)`
  and `restore_patient(p_patient_id uuid, p_actor uuid, p_context jsonb)` are security definer,
  service_role-only EXECUTE, with explicit revokes from PUBLIC/anon/authenticated. Both verify `p_actor` is an
  active, non-deleted admin in `staff_profiles`; the action derives it from
  `requireAdminStaff()`, never form input. Both use the locking protocol below. Delete refuses
  an absent/deleted/merged row; restore requires a deleted, unmerged row and clears all four
  fields. Restore may create a duplicate identity after re-registration: keep both DRM-IDs
  and offer the existing admin merge flow, never auto-merge.
- Successful RPCs return the patient ID/DRM-ID and kept counts. Refusals raise registered
  SQLSTATEs; blockers travel in JSON `DETAIL`, not a competing success-return shape. Reserve
  P0057–P0061 (agreed between sessions 2026-09-24: P0054 `feat/payment-edit`, P0062–P0064 `feat/sheet-sync`; migration 0167) for unauthorized lifecycle write, inactive patient, open blockers, invalid
  deletion metadata, and invalid restore state respectively; recheck reservations against
  other branches before implementation. Register translations in `src/lib/accounting/pg-errors.ts`.
  Audit `patient.deleted`/`patient.restored` **inside the same transaction**, with actor,
  patient/resource IDs, reason/note, kept counts and request IP/UA supplied by the server in
  `p_context` (only those context keys are accepted).
  An audit insert failure rolls back the change; actions do not double-log it.
- Guard, write locks, patient-session enforcement, views and DRM-ID correction as detailed
  below. Pick the number against all open branches immediately before coding.
- Types regenerated into `src/types/database.ts`.

### Blockers: exact database rules

- **Appointments:** `status = 'pending_callback'`, regardless of `scheduled_at`, OR
  `status in ('confirmed','arrived')` and `scheduled_at >=` today's Manila midnight expressed
  as a UTC instant. SQL uses `date_trunc('day', now() at time zone 'Asia/Manila') at time zone
  'Asia/Manila'`; app previews use `manilaRangeUtc(todayManilaISODate(), null).fromIso`. Do not compare to
  UTC `current_date` or to the current time: an earlier appointment today still blocks.
  `cancelled`, `no_show`, `completed` do not block. Migration 0019 permits dated
  `pending_callback` rows and requires a date for the other statuses.
- **Clinical work:** join `test_requests` to `visits`; both `deleted_at` values must be NULL.
  Any status outside `('released','cancelled')` blocks: the real open statuses from 0001 are
  `requested`, `in_progress`, `result_uploaded`, `ready_for_release`. There is no
  `test_requests.status = 'completed'` and no stored visit completion status. Include doctor
  consultations/procedures, unsectioned lines and package headers as well as components;
  `markDoctorLineDoneAction` uses `released`. `src/lib/visits/queue-stage.ts` supplies the
  terminal statuses, but its lab-only/leaf-only filter and payment-derived `completed` stage
  are not sufficient for this owner rule. A live visit with no live lines is incomplete
  intake and blocks until staff completes or queue-deletes it. A visit containing only
  terminal live lines has no clinical blocker; apply the separate money rules.
- **Non-HMO money:** a live visit with `hmo_provider_id is null` and
  `payment_status in ('unpaid','partial')` blocks. `paid`/`waived` do not block financially;
  neither bypasses unfinished clinical work. Existing visit/test soft deletion stays governed
  by 0125/0147; this feature does not waive balances or alter those guards.
- **HMO patient share:** 0011 stores `test_requests.final_price_php` and
  `hmo_approved_amount_php`; 0034 stores claim transfers to patients as
  `hmo_claim_items.patient_billed_amount_php` (non-voided `hmo_claim_resolutions` with
  `destination = 'patient_bill'`). There is no independent co-pay balance column. For each
  live, non-cancelled billable line (`parent_id is null`, including priced package headers),
  use the live claim item's `billed_amount_php` as insurer coverage once billed, otherwise
  its explicit `hmo_approved_amount_php`. A live claim means `batch_voided = false` and a batch
  with `voided_at is null` / status other than `voided`; disagreement is a reconciliation
  blocker. Patient principal is
  `sum(greatest(final_price_php - coverage, 0)) + sum(live patient_billed_amount_php)`.
  Subtract only this visit's non-voided patient payments (`payments.method <> 'hmo'`), floor
  the result at zero, and block if positive; never net one visit's overpayment against another.
  Use SQL numeric/centavos, not floating point. `waived` clears the original visit co-pay
  component, not a later claim-to-patient transfer. Do not count package components twice.
- **HMO claim balance:** for every non-voided claim item linked through a test/visit to this
  patient, unresolved = `billed_amount_php - paid_amount_php - patient_billed_amount_php -
  written_off_amount_php`. Positive unresolved blocks regardless of batch label/response
  (`draft`, `rejected`, etc. are not settlements). Zero is settled/resolved; a transfer to
  the patient still feeds the patient-share calculation. Approved positive coverage with no
  live claim is **unbilled/open**, not settled (0146 `v_hmo_unbilled`). A voided batch does
  not discharge the underlying claim: evaluate the line as unbilled again. Check live claims
  even if their referenced visit/line was incorrectly soft-deleted; never lose receivables
  through an operational filter.
- **Incomplete HMO accounting:** NULL coverage on a positive-price HMO line is unknown,
  not zero or automatically fully covered. Missing price snapshots, inconsistent claim and
  approval amounts, or allocations referencing voided/mismatched payments return a named
  `hmo_reconciliation` blocker linking the visit/claim. Staff must reconcile/capture the
  coverage (explicit zero means no insurer share) before deletion. Do not guess from the
  Patient AR page's `total_php - paid_php`, the GL account total, or cached `payment_status`.
  `recordHmoSettlementAction` in `admin/accounting/hmo-claims/actions.ts` writes `method='hmo'`
  payments and allocations separately; count the allocations once as insurer settlement,
  never again as patient payments. A partial-failure payment without complete allocations
  is not proof of a settled claim. Fully paid/written-off insurer coverage with no unpaid
  patient share and no clinical work permits deletion even if the visit remains `unpaid`.

Return all blocker categories, deduplicated by kind/resource, with links to appointments,
visits/tests or HMO claim batches. Aggregate financial rows before joining to avoid multiplying
payments by tests/allocations. Outstanding claims/transfers on otherwise deleted visits stay
visible in the evaluation. `historic_hmo_claims` (0076) has a patient-name string, no patient FK;
do not fuzzy-match that accounting archive into this guard. Unredeemed gift codes likewise
have purchaser text, not patient ownership (0013); they do not block. Redeemed gift-code
payments count as patient payments, and all gift-code/AR history remains intact.

**Amended 2026-09-25 (read-only prod-count review of the 0167 implementation) — three rules
above are corrected against real prod data:**

- **Non-HMO money:** a live visit with `total_php = paid_php` does **not** block, even if
  `payment_status` still reads `unpaid`. Prod has 4,147 historical imported visits with
  `total_php = 0` and `payment_status = 'unpaid'` forever — the payment-status recalc only
  runs on a `payments` insert/void, and these never had one. Unfixed, 2,188 of 6,892 patients
  would have been permanently undeletable though only 6 actually owe money. The blocker label
  can therefore never read "₱0.00 unpaid".
- **Incomplete HMO accounting:** NULL coverage on an **unclaimed** line (no live claim item,
  no explicit `hmo_approved_amount_php`) is **not** a reconciliation blocker — it is treated
  as fully covered by the HMO (patient share ₱0), consistent with 0133 (an HMO visit releases
  without a counter payment collected at the counter). Prod has never claimed a line or set
  `hmo_approved_amount_php` outside a `doctor_procedure` line's creation-time default (there is
  no UI path to record it before a claim exists) — unfixed, 443 of 925 HMO patients would have
  been permanently blocked. This narrows only the "never recorded" case; a missing price
  snapshot and a claim that disagrees with its approval still block as reconciliation problems.
- **Appointments:** a `confirmed`/`arrived` row with `scheduled_at is null` **does** block,
  in addition to the existing rules. Online lab-request bookings insert `confirmed` with
  `scheduled_at` NULL (`src/lib/appointments/create.ts`), and the appointments page treats
  these as open forever — 30 prod patients would otherwise have been silently deletable while
  an open walk-in request sat unresolved.

A fourth fix (no rule change, an implementation gap): a claim amount already transferred to the
patient (`hmo_claim_items.patient_billed_amount_php`) must keep blocking even after its
`test_requests` line, or its whole `visits` row, is (wrongly) soft-deleted — 0147 already
requires this for the underlying claim balance, and the patient-share calculation must honour
the same invariant, sourced from the claim item directly rather than the live line/visit.

### Trusted lifecycle writes (no GUC bypass)

Create a private `patient_lifecycle_writer` PostgreSQL role: NOLOGIN, NOINHERIT, NOBYPASSRLS;
no membership for `authenticator`, `anon`, `authenticated` or `service_role`. It owns only the
delete/restore RPCs. Grant schema USAGE, SELECT for their reads, UPDATE of the four lifecycle
columns, INSERT into `audit_log` and USAGE on `audit_log_id_seq` (0001's bigserial); add
role-specific SELECT/UPDATE/INSERT RLS policies only on the tables those grants require.
The RPC owner reads `patients` and `staff_profiles`; blocker/kept-count helpers read the child
tables as the migration owner. Read-only blocker/lock helpers remain owned by the
migration owner, with EXECUTE granted only to service_role and this private role. No app role
gets schema CREATE, role membership or a general execute-as-owner function.

Use a **SECURITY INVOKER** `BEFORE INSERT OR UPDATE` patient guard so `current_user` is the
actual writing function's role, not the trigger owner's. INSERT always requires all deletion
fields NULL, including service-role inserts. On UPDATE, any change to those fields requires
`current_user = 'patient_lifecycle_writer'`; unchanged fields do not trigger a refusal.
Restore is the only permitted change to an already-deleted patient (normal `updated_at`
bookkeeping excepted). A custom GUC, nested trigger, staff/admin JWT or direct service-role
UPDATE cannot authorize it. Keep row CHECKs as independent protection. This is deliberately
different from 0125's transition-validation triggers; 0125 has no GUC authorization pattern.
Privileged migration owners can administer the database; runtime clients cannot assume this
role. A trigger's EXECUTE ACL is revoked from runtime roles after installation.

All new/replaced functions pin `search_path = pg_catalog, public, pg_temp` and schema-qualify
application objects. Existing-signature `CREATE OR REPLACE FUNCTION` retains its ACL (0158);
restate the intended grants anyway. The only new patient-facing EXECUTE exception is the
claim-scoped RLS identity helper below, which accepts no arbitrary patient ID.

### One locking protocol for deletion and all patient-associated writes

Use transaction-scoped advisory locks `pg_advisory_xact_lock(hashtext('patient_lifecycle'),
hashtext(patient_id::text))`, shared by every writer below. For multiple patients, acquire
distinct advisory keys in sorted numeric order, then patient rows in UUID order. Hash
collisions merely serialize unrelated patients. Helpers are VOLATILE and run at READ COMMITTED:
after waiting for the lock, issue a **new SELECT** for activity/blockers. Never reuse a
pre-lock snapshot. Delete/restore take `SELECT … FOR UPDATE` on the patient after this lock.

- Add BEFORE INSERT/UPDATE/DELETE guards to appointments and visits, and to their writable
  dependents: test requests, payments, PINs, consent events, results/result links and uploads,
  HMO claim items/allocations/resolutions and affected batch transitions. Resolve patient IDs
  through the FKs, lock old and new IDs on reassignment, then re-read `deleted_at` and
  `merged_into_id`. Inactive means refuse; NULL appointment patients remain valid walk-ins.
  For multi-patient results/batches lock all affected patients. Audit insertion is exempt:
  it must still record refused attempts, historical access and skipped notifications.
- Supported multi-row writers acquire the complete patient lock set **before** modifying
  child rows. Triggers also protect direct/stale PostgREST writes and nested financial
  recalculations. A direct update that takes a child row lock first can deadlock with another
  transaction; abort/retry the whole transaction on 40P01/40001, never continue a partial
  mutation. Do not use session locks or assume locks survive separate Supabase calls.
- `appointments_insert_slot_guarded` (latest body 0154) takes patient locks before existing
  slot locks and rechecks activity before insertion. Cover reschedule/reopen/attach actions,
  not only the search picker. `/schedule` and staff `new-appointment-actions.ts` both filter
  the submitted existing patient UUID again; the DB guard is still authoritative.
- Replace `createOneVisit`'s separate visit/line inserts in `visits/new/actions.ts` with one
  transactional RPC taking the patient lock before creating the visit, lines (headers first),
  PIN and intake updates. Recheck activity in that RPC. Guard later line additions, payment
  voids, claim reopening and visit/test restores too: none may introduce work/debt after
  deletion. Existing financial/payment/consent triggers continue to fire.
- `resolve_patient_guarded` keeps 0158's identity advisory lock **first**, preserving its
  key and referral-source behavior. Select an active candidate, take its lifecycle lock,
  and re-read both activity and the matching triple. If it changed/disappeared, repeat the
  active lookup under the identity lock and otherwise insert a fresh patient. Hold locks
  until commit. Delete/restore do not acquire identity locks, so they cannot reverse this
  order. A later booking transaction still checks activity; resolution is not a reservation.
  If a new-patient booking loses this race, re-resolve/retry once before any booking writes;
  an existing-ID booking returns the generic lookup-again error, never silently switches IDs.
- Merge and undo-merge move from separate client updates into admin-only transactional RPCs
  `merge_patients_guarded` / `undo_patient_merge_guarded` (service_role-only EXECUTE),
  shared by `admin/patient-merge/actions.ts` and `scripts/patient-dedup/engine.ts`. Lock all
  source/keep/chain IDs before moving FKs. Merge requires both active; restore before merging
  a deleted row. Undo requires the original merged source and active keep, with neither
  deleted; first clear the source's merge marker within that transaction, then move history.
  A rollback restores the marker too. This makes the regular activity guards applicable to
  moved rows without a trigger bypass flag. Retain existing merge snapshots/auditing.
  These RPCs are owned by a separate private `patient_merge_writer` role with the same
  NOLOGIN/NOINHERIT/NOBYPASSRLS and no-app-membership rules. Grant only their
  required table/sequence privileges and role-specific policies. Root merge-marker changes
  require that role; the guard allows only the validated undo transition on a merged source,
  with `deleted_at` still NULL. This role cannot change deletion metadata. Delete/restore
  retain their separate owner. Both merge RPCs validate the active admin actor server-side.

### DRM-ID generation, in this same batch

Fix the latent production bug in 0001's `generate_drm_id()`; it is independent of deletion
(production is in the low DRM-7000s). Call `nextval('public.drm_id_seq')` **once**, convert
that value to text `n`, and return `'DRM-' || lpad(n, greatest(4, length(n)), '0')`.
Keep the existing unique constraint and sequence/default; never renumber existing records,
restart/reseed downward, reclaim deleted/merged IDs, or introduce uniqueness on email.
Before rollout verify the sequence is ahead of all issued numeric suffixes, including
deleted/merged rows; any necessary correction advances only, with allocation excluded during
the correction. Normal rollback/deletion leaves sequence gaps. A local isolated test crosses
9999 → 10000 → 10001 and proves a retained DRM-1000 is neither reused nor collided with.

## One shared "active patient" rule — deleted AND merged

Research found merged tombstones (`merged_into_id is not null`) are already hidden in some
places but leak in others. The delete feature needs the same hiding everywhere, so one helper
covers both: `activePatients(q)` in `src/lib/patients/active.ts` applies
`.is("deleted_at", null).is("merged_into_id", null)`, plus the SQL predicate in views/RPCs.

Paths under `staff/` below are relative to `src/app/(staff)/staff/(dashboard)/`; public and
portal route names identify their corresponding `src/app/(marketing)` / `(patient)` folders.

### Directory/matching/authentication — active only

| Read path | Required change |
|---|---|
| `staff/patients/page.tsx` → `v_patients_directory` | Both predicates in SQL; admin inclusive source below |
| `staff/appointments/new-appointment-actions.ts` search AND existing-ID resolution | Filter each query, not just `searchPatientsAction` |
| `staff/appointments/actions.ts` attach-patient and its sheet | Filter submitted patient; DB recheck on attachment |
| `staff/patients/[id]/edit/page.tsx`, `edit-actions.ts`, identity verification in `[id]/actions.ts` | Active target required for edit/verify/consent reads and writes; historical patient detail remains reachable |
| `staff/visits/new/page.tsx` picker AND direct `?patient=` preselection | Filter both queries; guarded creation RPC |
| `/schedule/actions.ts` DRM-ID/last-name lookup AND submitted-ID/portal resolution | Active lookup at both steps, then guarded insertion |
| `src/lib/patients/resolve.ts` → `resolve_patient_guarded`; `/register/actions.ts`; `staff/patients/actions.ts` | Active-only matching, identity/lifecycle locks as above |
| `/find-my-id/actions.ts` | Active candidates only; unchanged generic public response |
| `/portal/login/actions.ts`, `requirePatientProfile`, all portal actions | Enforce the portal section below; no merged-chain authentication fallback |
| `src/lib/patients/find-duplicates.ts` → `findCandidatesForInput` | Both predicates on direct candidates |
| Same module → `loadCandidatePairs*` / `v_patient_dedup_candidate_pairs` | Filter both sides in view's active CTE (0106); covers admin dashboard, merge list and `api/cron/dedup-digest/route.ts` |
| `staff/admin/patient-merge/actions.ts` candidate lookup/preview/execution | Active sources and targets; explicit undo exception under lock |
| `staff/admin/settings/consent-gate/page.tsx` | Active worklist counts |
| `staff/marketing/sources/page.tsx` | Active new-patient acquisition count only; appointment/contact/history totals remain unchanged |
| `v_patients_without_consent` (0150), `src/lib/reports/patients-without-consent.ts`, report + CSV | Filter candidates in SQL before sorting/counting/paging |
| `scripts/patient-dedup/engine.ts` load, target and chain checks | Active-only candidates; use guarded transactional merge |
| `scripts/clinical-backfill/engine.ts` patient index AND `priorClinicalPatients` token-reuse map | Filter both; active-check explicit DRM overrides and commit targets |
| `scripts/clinical-backfill/followups/worksheet.ts`, `followups/resolutions.ts` | Active worksheet candidates and resolution targets |
| `staff/admin/import-patients/actions.ts`, `scripts/import-legacy-customers.ts` | Currently insert-only, not matching paths; deletion fields cannot be imported, new IDs use the fixed sequence. Any reuse added later must use the active rule |
| Seed/smoke patient lookups (`scripts/seed-{test-users,sample-results,screenshot-data}.ts`, `scripts/smoke-chemistry-consolidated.ts`) | Reuse active fixtures only; an explicit fixture DRM-ID already retained by an inactive row errors, never overwrites/reactivates it |

### History lookup — keep deleted/merged records resolvable

| Read path | Keep |
|---|---|
| `staff/patients/[id]/page.tsx`, `[id]/consent/print/page.tsx` | Direct record, visits, consent history and deletion banner; mutations separately gated |
| Staff visits/receipts/payments/results/appointments pages, PDFs and exports | Existing patient FK joins including `patients!inner`; no active-patient predicate |
| `staff/queue/[id]/actions.ts` demographic reads for existing results/amendments | Resolve original demographics; write actions require active patient/restoration |
| `src/lib/consent/gate.ts`, SQL consent-release guards (0086/0088) | Resolve the actual visit's consent; do not replace with directory lookup |
| `staff/audit/page.tsx` patient enrichment | Preserve deleted and merged patient names/IDs |
| `src/lib/emails-log/query.ts` DRM filter AND patient-name enrichment | Historical email search still finds deleted/merged identities |
| `src/components/staff/notification-bell.tsx`, `src/lib/appointments/booking-alert.ts` | Resolve the patient named by the historical/staff event; no blanket patient filter |
| `staff/admin/patient-merge/actions.ts` merge ledger, snapshots, undo display | Keep original identities; undo authorization is separate |
| `v_hmo_*` patient joins (0146), Patient AR, financial/clinical dashboards, reports, sheets/CSV | Preserve money, clinical counts and patient labels; retain existing visit/test deletion filters only |
| Portal data export and history joins | Preserve record shape, but only after current active-session/RLS authorization; deleted patients cannot invoke these |
| `historic_hmo_claims`, gift-code history, contact messages | Preserve textual identities/links; no fuzzy deletion propagation |

The retired `commit_hmo_history_run`/historical patient-name index from 0035/0036 were removed
by 0069; do not patch dead definitions or invent an email uniqueness conflict. Search source,
scripts, SQL views/RPCs and embedded joins when validating coverage. Keep a test inventory of
active selectors versus historical lookups so a future blanket filter cannot hide history.

### Views and the inclusive admin source

Re-create `v_patients_directory` (0143), `v_patient_dedup_candidate_pairs` (0106) and
`v_patients_without_consent` (0150) with the active predicate **and** explicit
`WITH (security_invoker = true)`. For directory/consent views revoke ALL from PUBLIC, anon,
authenticated, then grant SELECT to authenticated and service_role; for duplicate candidates
grant SELECT only to service_role (all current callers use the admin client). Mirror table/view
revokes in `supabase/seed.sql` and extend `src/lib/supabase/hardened-views.test.ts`.
Do not re-create financial views with active-patient filtering. Grants survive a view replace;
reloptions must be restated, per `CLAUDE.md`.

Add `v_patients_directory_admin`, also `security_invoker = true`: same directory columns and
lateral last-visit calculation, plus deletion metadata/actor name, excludes merged
rows but **includes deleted rows**, and has SQL `WHERE public.has_role(array['admin'])`.
Grant SELECT to authenticated only after revoking PUBLIC/anon/authenticated/service_role;
read it with the RLS staff client after `requireAdminStaff()`. Non-admin direct SELECT returns
no rows. `?deleted=1` uses this source for both count and data, preserving identical allowed
sort columns, filters, page sizes and unique ID tie-break. Deleted Patients uses it with
`deleted_at is not null`. A non-admin flag is rejected; never fetch inclusively then filter in
JavaScript. Base staff patient/history SELECT policies remain unchanged. Fetch kept counts
for the selected page IDs through `patient_kept_counts(p_patient_ids uuid[])`, a read-only,
service-role-only security-definer RPC (also callable by the lifecycle owner for its audit).
The server checks admin before calling it. This deliberately covers the service-only consent
ledger (0086); an invoker view must not silently count RLS-hidden consent rows as zero. Counts
are display enrichment, not sort/filter/page inputs; exports chunk the same count lookup.

### Portal and patient-facing delivery

- Add a shared `getActivePatientSession()` server helper which verifies the cookie and reads
  the referenced patient with both active predicates. `requirePatientProfile()` wraps it;
  remove its merged-chain fallback. Use it in all five exported actions in
  `/portal/(authenticated)/actions.ts` (single/consolidated/package PDF, upload URL, upload
  deletion), portal page/layout/book/data-export, `src/lib/actions/consent/portal-accept.ts`,
  and `/schedule/actions.ts`'s portal submission branch. PIN login checks activity before
  PIN work and again before issuing the cookie. Keep existing rate limits and generic
  credential/session errors; never reveal deleted/merged status through public endpoints.
- Re-create `current_patient_id()` as a STABLE SECURITY DEFINER helper, owned by the migration
  owner, with pinned search_path and EXECUTE only for anon/authenticated/service_role. It
  derives the ID from the existing JWT/GUC contract and returns it only if the underlying
  patient is active. It takes no ID argument and does not follow merges. The owner reads the
  base table without invoking patient RLS recursively; verify this in local tests. Existing
  0114/0151 policies then deny old patient-scoped JWTs without restricting staff history.
  Keep every portal data read on `createPatientClient`, including ownership checks before
  storage signing/removal; admin-client mutations also hit the activity guards.
- Already-issued storage URLs can remain usable for their existing maximum five-minute TTL;
  deletion prevents authorization on subsequent requests, not retrieval of an already-downloaded
  PDF. A request already authorized before deletion can finish; recheck immediately before
  storage signing/removal and use the database guard for attachment-row deletion.
  Reject subsequent requests using old cookies while inactive. Restore intentionally permits
  still-unexpired cookies/PINs again; no credential rows are rewritten or lifetime extended.
- Add `src/lib/notifications/active-patient-recipient.ts` for an authoritative active lookup
  immediately before each patient email/SMS provider call. Apply in `notify-released.ts`,
  `notify-released-bulk.ts`, `notify-appointment-booked.ts`, `notify-appointment-reminder.ts`,
  `/register/actions.ts` (all ID/welcome sends), `/find-my-id/actions.ts` and the merge
  confirmation sender (active keep only). Reminder cron also filters joined patients when
  selecting work, but its sender rechecks, including retries/delayed execution. Preserve
  `patient_id` in deferred work; never send solely to a cached address after a delay.
- Inactive linked patient: skip **all** channels, record an audit skip without exposing it to
  the public caller, and never fall back to appointment walk-in contact fields. A genuinely
  NULL patient ID remains a walk-in. Historical email logs, staff alerts and unrelated
  newsletter/contact subscriptions are not deleted or silently unsubscribed. A provider call
  admitted before deletion can already be in flight; document this delivery boundary rather
  than promising recall. Tests delete before the final recipient check and assert zero sends.


## Deleting — the UI

- **Patient page** (`patients/[id]/page.tsx`), admins only: a **Delete patient** button in the
  header actions, danger style.
- Opens the existing `ConfirmDialog` (danger variant; focus trap, Escape/backdrop cancel —
  `admin/payroll/runs/[id]/_components/confirm-dialog.tsx`). It moves to
  `src/components/staff/confirm-dialog.tsx` so patients, payroll and the Deleted page share
  one copy; payroll's import is updated, behaviour unchanged. The reason picker and blocker
  list go in its `body` (a ReactNode); one new optional prop, `confirmDisabled`, disables the
  confirm button while blocked or while the reason is missing.
- Body: name, DRM-ID, birthdate; a "kept" summary (N visits, N payments, N appointments,
  N consents — "these stay on file"); the reason picker + note; and, when blocked, a list of
  blockers with links (appointment, unfinished test/visit, patient balance, unbilled/open HMO
  claim or reconciliation issue), the button disabled. Counts cover all kept history;
  they are not derived from active-directory filters.
- On success: redirect to the patient list with a toast "DRM-1234 deleted · Undo" — Undo calls
  restore (same admin gate).
- Audit: the RPC writes `patient.deleted` (metadata: drm_id, reason, note, kept counts) and
  `patient.restored`, following `patient.merged` / `patient.merge.undone` naming.

## History pages keep working

Opening a visit, receipt, result, payment or appointment whose patient is deleted still
renders, with a banner: "This patient record was deleted on <date> by <name> (<reason>)." —
admins see a **Restore** link in it. The patient page itself stays reachable by URL for admins
(banner + Restore, no Delete/Start visit/Reissue PIN); non-admins get the banner and a
read-only page.

This is enforced in the write paths, not just buttons. `patients/[id]/edit-actions.ts`,
`patients/[id]/actions.ts` (verify identity), `src/lib/actions/consent/{grant,withdraw}.ts`,
`src/lib/actions/visits/reissue-pin.ts` (both patient-page and visit-page callers), new visits,
attachment/check-in actions and merge all require an active target. The edit route refuses
inactive patients before rendering a form. Root patient updates participate in the lifecycle
lock and recheck activity; metadata authorization remains a separate SECURITY INVOKER guard.
Child-table activity guards are SECURITY DEFINER with fixed search_path so direct runtime
writes cannot evade checks through RLS-hidden parents. They never grant a metadata bypass.
Historical result amendments, financial reversals, claim changes and queue restores require
restoring the patient first; downloads, prints and read-access audit events remain available.
The sole merged-row write exception is the named service-role-only undo-merge RPC, under its
private owner, clearing its validated source marker under lock; do not expose a general
inactive-row edit operation.

## Admin Tools › Deleted Patients

New page `admin/deleted-patients`, admin-only, added to the Admin Tools nav (Title Case label
"Deleted Patients"). Columns: DRM-ID, name, deleted on, deleted by, reason (+note), kept
counts. Sortable by deleted on (default desc), paginated with the house list helpers
(`parseSort` / `parsePageSize`, database count + range, ID tie-break; `fetchAllRows` for complete
exports — no implicit 1,000-row cap), using `v_patients_directory_admin`. Each row:
**Restore** (ConfirmDialog, primary variant) and a link to the record.

## Also in scope (owner: "include all worth considering")

1. **Delete shortcut on the duplicates list** (`admin/patient-merge`): each candidate pair
   gets "Delete this one" beside each side, opening the same confirm box pre-filled with reason
   `duplicate`. For test records and bad self-registrations that aren't a true merge.
2. **"Show deleted" toggle on the patient list**, admin-only, off by default. When on, deleted
   rows appear greyed with a "Deleted" badge and link to the record; remembered per-viewer in
   the URL (`?deleted=1`), not storage. Uses `v_patients_directory_admin`, never the permanently
   active-only `v_patients_directory`; merged rows stay hidden in both.
3. **Likely-duplicate warning at check-in.** The staff near-match warning
   (`findCandidatesForInput`, tier ≥ probable) today runs only when staff create a patient or
   appointment by hand. Online bookings and self-registrations skip it, which is exactly how
   the owner's typo bookings got through. Add a **"Possible duplicates"** panel to the patient page, shown to
   reception and admin when the record is active and `pre_registered` (and at the Verify identity step),
   listing matches with tier, differing fields highlighted (e.g. a birthdate one digit apart),
   and actions: Open, Merge (admin — deep-links the merge page with the pair selected), Delete
   this one (admin). Same panel on the Reception Queue check-in row as a small "Possible
   duplicate" badge linking to it.
4. **Clean up the owner's five test rows** after this ships to prod: the five rows listed in
   the private rollout notes, reason `test_record`, through the new UI (not SQL). Their appointments are
   past-dated, but this does not prove deletability: preview all revised appointment, clinical
   and money blockers on prod first. **Done only
   with the owner's go-ahead at that step** — it touches live data.
5. **Same-PR documentation:** update `docs/drmed-user-guide.html` for the new flows, blocked
   messages, HMO reconciliation, restoration and portal/delivery behavior, plus the tracked
   `drmed-migrations`, `drmed-payments`, `drmed-rls-and-auth` and `drmed-booking-and-intake`
   skill maps when their cited paths change. This spec edit itself changes no implementation.

## Testing

- Unit (vitest): reason/note validation, admin gates, active helper and complete query-surface
  inventory (including embedded joins, scripts and history exceptions), blocker labels/error
  translation, notification recipient suppression and toast undo. SQL is the authoritative
  blocker evaluator; any preview arithmetic is pinned to the same fixtures.
- DB (`supabase/tests/*.sql`, local stack only — never a fixture on prod via MCP): all six
  appointment statuses, dated/undated callback, earlier-today versus yesterday and Manila
  midnight crossing UTC; all real clinical statuses, doctor lines, headers/components,
  empty intake and independently deleted visit/test rows; non-HMO unpaid/partial/paid/waived.
  Exercise HMO co-pay paid/unpaid, full/partial settlement, patient-bill transfer, write-off,
  rejected/draft/unbilled/voided batches, NULL/zero approval, voided payments, incomplete
  allocation rollback, and package counting. A settled claim with zero patient share and
  terminal work must allow deletion even with stale `unpaid`; paid visits with open work fail.
- Guard/ACL DB tests: direct INSERT carrying any deletion field and direct lifecycle UPDATE
  fail for anon/authenticated/service_role; arbitrary GUCs do not help; callers cannot assume
  the private role. Reason/actor consistency, already-deleted/merged/missing patients, restore
  round-trip and audit-failure rollback; anon/authenticated cannot call management RPCs.
  Verify function ownership/search_path, RLS without recursion, view security_invoker/ACLs,
  seed parity and non-admin denial of the inclusive source.
- Two-connection DB tests (both lock orderings): delete versus appointment/visit insertion,
  reopen/reschedule/attach, new test, payment void, HMO claim reopen, visit/test restore,
  merge/undo and patient edit. If the writer commits first, deletion sees its blockers; if
  deletion commits first, the writer refuses. Include two same-triple resolves after deletion
  (one fresh row), resolve blocked behind deletion (re-read, not stale reuse), and delayed
  booking after resolution. Check deadlock retry aborts the entire transaction.
- Portal tests: cookie issued before deletion cannot download any PDF, sign/view/delete an
  upload, consent, export data or book; an already-issued patient-scoped JWT sees no rows
  through direct RLS reads. Same for merged IDs; no chain fallback. Restore honors still-valid
  credentials as specified. Public login/recovery never disclose deletion status. PIN reissue
  through either caller fails while inactive. All patient senders skip a delayed delivery
  after deletion, while historical email lookup and staff history still work.
- DRM-ID DB tests: isolated local sequence 9999 → 10000 → 10001, retained DRM-1000, concurrent
  allocations, fresh identity using a deleted patient's email, restore without renumbering,
  and no sequence decrement after rollback. Sequence changes are not transactional: use a
  disposable local database/sequence fixture, never prod and never a rollback-only cleanup.
  Mutation-check each guard test against a deliberately broken local function to prove it fails.
- Browser (Playwright, local dev, throwaway patient): delete with reason → gone from list and
  pickers → visit page shows banner → Deleted Patients → Restore → back in list; admin Show
  deleted uses correct counts/sorts/pages, non-admin cannot enable it; blocked patients show
  actionable clinical/money/claim links; duplicates panel only on an active pre-registered pair.
  Retained results/payments/appointments/consents/audit and financial report totals are unchanged.
- Prod verification after `db push`: by OBJECT (columns, functions, grants, trigger enabled,
  view definitions/predicates, security_invoker, private-role membership, function ownership/
  search_path, sequence watermark), read-only. Run normal test/typecheck/lint gates for the
  later implementation; no runtime tests or migration are implied by this document edit.

## Rollout — four PRs in sequence (owner, 2026-09-24)

Each PR is independently reviewable and revertible; later PRs build on earlier ones.

1. **DRM-ID fix** — the `generate_drm_id()` correction, sequence-watermark check and the
   9999 → 10000 boundary test. Independent of deletion; ships first.
2. **Core delete/restore** — the core-delete migration: columns/checks, blocker evaluator, delete/restore RPCs under
   the private lifecycle role, the patient guard, the active-patient rule on every
   directory/matching path, portal session + RLS cut-off, notification suppression, write-path
   refusal for inactive patients, the confirm dialog, history banners, Deleted Patients, docs.
   `delete_patient` re-checks blockers under its own row lock, so the only gap until PR 3 is a
   simultaneous write racing the delete; it is audit-logged and restorable.
3. **Race-proofing** — the shared lifecycle lock protocol and child-table activity guards, the
   transactional visit-creation RPC, and the guarded merge/undo-merge RPCs under their own
   private role, with the two-connection tests.
4. **Extras** — Show deleted toggle, duplicates-page Delete shortcut, Possible-duplicates panel
   and Reception Queue badge.

After PR 2 is live: preview blockers on prod for the owner's five test rows and delete them
through the UI, only with the owner's go-ahead at that step.

## Review changes (Codex, 2026-09-24)

- Closed old-session portal/RLS and notification-dispatch gaps, with explicit URL/in-flight limits.
- Added shared lifecycle locks, transactional visit creation/merge, and mutation-side activity guards.
- Replaced the incorrect 0125/GUC claim with private-role authorization, including INSERT checks.
- Listed active selectors, CLI/import reuse maps and history exceptions; retained staff/audit/email lookups.
- Named hardened views/ACLs and the inclusive admin source for Show deleted and Deleted Patients.
- Recorded the owner's revised clinical and HMO rules, actual amount/status sources and reconciliation cases.
- Enforced read-only archived records in actions/database guards, including PIN and merge/undo paths.
- Included the independent DRM-ID truncation fix, monotonic sequence policy and 9999-boundary test.
- Added concurrency, security, financial, history and delivery tests plus same-PR documentation updates.

## Out of scope

- Hard delete / data-subject erasure. "Requested by patient" hides the record; true erasure of
  medical records conflicts with retention rules and is a separate owner/legal decision.
- Deleting staff, visits or appointments (they have their own flows).

# Patient delete — PR 3a: lifecycle locks, child-table guards, transactional creation paths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use **Sonnet** for task subagents. Tasks 2–15 (SQL: lock primitives, guard triggers, RPCs, RLS helper, ACLs) get an **Opus** review; the app tasks get Sonnet reviews.

**Goal:** Nothing can add work, money or clinical data to a deleted or merged patient — not through the app, not through a stale PostgREST write, not by racing a delete. Every patient-owned write takes the patient's lifecycle lock (shared), delete/restore take it exclusive, and the four multi-step creation paths (new visit, first result, HMO settlement, closure reschedule) become single transactions.

**Architecture:** One migration (**0184**) adds a lock primitive `lifecycle_lock_and_assert(uuid[], p_exclusive boolean)` (+ lock-only `lifecycle_lock`), a **result-membership lock** `lifecycle_lock_results(uuid[], p_exclusive boolean)` (changing which tests a result holds takes it exclusive; every other results-family write takes it shared, BEFORE resolving the result's patients) and patient-path resolvers that follow **every** patient-bearing reference of a row (the union is locked and asserted); one generic SECURITY DEFINER guard trigger `enforce_patient_activity()` installed as `a_lifecycle_guard` (the name sorts first, so it fires before every other BEFORE trigger) on 16 patient-owned tables, default-refuse on an inactive patient with five narrow column-shaped exceptions, plus one-patient-per-result on result links; re-creates `recompute_hmo_batch_status` with a batch row lock (concurrent settlements can no longer leave a settled batch `submitted`); re-creates `delete_patient`/`restore_patient` with `FOR NO KEY UPDATE`; makes five existing RPCs take the advisory lock before their row locks; adds `create_visit_encounter`, `result_create_linked`, `record_hmo_settlement`, `reschedule_closure_appointments` and `notification_skip_summary`; hardens `resolve_patient_guarded` (case-insensitive, lock + re-read); makes `current_patient_id()` JWT-only and drops `set_patient_context`. The app switches those four flows to the RPCs, retries once on P0072 / deadlock, re-resolves a booking once on P0058, re-orders undo-merge, and gains a "Patient messages not sent" section on Cron Health.

**Tech Stack:** Postgres 17 (Supabase local stack on OrbStack, container `supabase_db_DRMed`), psql smoke tests in `supabase/tests/`, a two-connection Node `pg` script, Next.js 16 server actions, vitest, Playwright MCP for the browser smoke.

**Spec:** `docs/superpowers/specs/2026-09-24-patient-delete-design.md`, section **"PR 3 revision — split into 3a and 3b"** (its 3a subsections are the scope; it supersedes the earlier "One locking protocol…" section where they differ). **Spec fix carried here:** the helper signature is `lifecycle_lock_and_assert(patient_ids uuid[], p_exclusive boolean)`, not `mode text` — Task 28 corrects the spec text. Out of scope: merge/undo RPCs, consent re-sync, merge snapshots, dedup chain re-parenting, CLI actor, merge-marker enforcement (all PR 3b).

---

## Facts established 2026-09-25 (read-only research; re-check at Task 0)

**Numbers (claimed in `~/Claude/DRMed/.claims/`):** migration **0184**; **P0072** = patient changed mid-save (retry once), **P0073** = visit encounter could not be created (message passes through). Other in-flight claims: 0179 `feat/result-copy-followups`, 0182 `feat/staff-view-as-role`, 0183 `feat/waived-balance-gl` (plan only), 0185 `feat/eod-date-picker`, 0170 `feat/sheet-sync`. P0054 payment-edit, P0057–P0061 0167, P0062–P0064 sheet-sync, P0065–P0067 released-chemistry-edit, P0068 result-copy, P0069–P0071 waived-balance. New RPC input validation uses standard SQLSTATEs (`22023` invalid_parameter_value, `42501` insufficient_privilege) whose messages pass through `translatePgError`'s `default:` — `pg-error-coverage.test.ts` accepts standard codes.

**Function overlaps and the REPLAY rule (revised 2026-09-28 after Codex plan review P1-3; coordinate — Task 0 Step 4, Task 15 Step 6, Task 29 Step 3, Task 31 Step 1).**

Deploy order and replay order differ: prod applies a migration when its PR ships (0184 will land on prod AFTER 0186, with `--include-all`), a fresh replay applies files in NUMBER order. When two migrations re-create the same function, the final body must be the same under both orders. So:

- **If the other migration is already on main when 0184 is rebased** (numbered below 0184): 0184 copies ITS body and re-applies 0184's marked edits. 0184 is higher-numbered and lands later, so both orders end on 0184's body.
- **If 0184 reaches main first**, the other branch is the second-lander and its number is LOWER than 0184: it must **not** re-create the function in its own low-numbered file (on prod it would land after 0184 and win; on replay 0184 would win — two different databases). It moves that re-creation into a **NEW migration, claimed fresh and numbered above 0184**, whose body is 0184's body plus its own edits. Task 15 Step 6's standing test (`lifecycle-owned-functions.test.ts`) fails on that branch until it does.
- **A migration numbered ABOVE 0184 that is already on main** and re-creates a 0184-owned function would beat 0184 on replay while losing to it on prod: 0184 must then be renumbered above it (claim a new number) — the same standing test's "highest-numbered definition carries the lifecycle marker" check catches it.
- **Fresh-replay equivalence is a ship prerequisite, not a note** (Task 29 Step 3, re-run in Task 31 Step 1 if main moved): an isolated fresh replay must pass the smokes, and every 0184-owned function's definition on the replay must equal the one on the prod-order stack.

| Function | 0184 changes | Other definers (state 2026-09-28) | What happens |
|---|---|---|---|
| `result_edit_commit` | membership + lifecycle lock before the row lock; replay pre-check | **0179 — MERGED (#239, on prod)** | 0184 copies **0179's** body (0176 + three `-- 0179` hunks). No action for 0179. |
| `resolve_patient_guarded` | case-insensitive last name, lifecycle lock + re-read, P0072 | 0170 sheet-sync (unmerged; `set search_path = ''`, `app.referral_origin = 'patient'` around the insert) | 0184's body is a superset. 0170 lands first → 0184 re-copies. 0184 lands first → 0170 moves its re-creation to a new migration > 0184 (body = 0184's + its edits). |
| `correct_payment` | lifecycle lock before the row lock | 0183 waived-balance-gl (unmerged; Tasks 1–5 committed, re-creates it from 0174) | Same rule as above. |
| `recompute_hmo_batch_status` | batch row lock before reading the items (P2-5) | 0034 only (0118 changed grants) | New overlap: none in flight (checked 2026-09-28). |
| `delete_patient`, `restore_patient`, `result_save_draft`, `result_finalise_commit`, `appointments_insert_slot_guarded`, `current_patient_id` | see Tasks 3, 8, 14 | 0167, 0172, 0154, 0167 | No in-flight branch re-creates them (checked 2026-09-28). |

0182 (`has_role`/`staff_role`), 0185 (`eod_unclosed_days`) and 0186 (alert settings) are on prod above 0184's number and re-create none of the functions above (checked 2026-09-28) — 0184 can keep its number; Task 31 Step 1 re-checks.

**State on 2026-09-28 (re-check at Task 0).** `origin/main` = `1e73db7c` (0179 merged, #239); prod head **0186** (0182, 0185, 0186 applied; 0179 applied). The local stack's ledger reads `…0179,0180,0181,0182,0183,0185,0186` plus `0170` — **0170 and 0183 are other sessions' unmerged branches applied locally**; never reset to "clean them up". Local has **zero** results whose tests span more than one patient (the one-patient-per-result rule below changes nothing existing); Task 0 Step 6 checks prod read-only.

**Every patient-bearing reference on the 16 guarded tables** (FK catalog, local, 2026-09-28 — Codex plan review P1-1). The guard locks and asserts the UNION of all of them, so a row whose references disagree (an active patient's test linked to a deleted patient's result, a component whose `parent_id` sits on a deleted patient's visit) is refused instead of passing on the one path that happens to be checked:

| Table | References followed (→ patient) |
|---|---|
| `visits`, `patient_consents` | `patient_id` |
| `appointments`, `appointment_attachments` | `patient_id` (NULL = walk-in / not yet linked: no patient) |
| `test_requests` | `visit_id` → visit; `parent_id` → header test → visit |
| `payments` | `visit_id` → visit; `corrects_payment_id` → payment → visit |
| `visit_pins` | `visit_id` → visit |
| `results` | its own membership: `result_test_requests` rows → tests → visits (unlinked = none) |
| `result_test_requests` | `test_request_id` → test; `result_id` → the result's membership |
| `result_values` | `result_id` → membership |
| `result_amendments` | `result_id` → membership; `test_request_id` → test |
| `critical_alerts` | `result_id` → membership; `test_request_id` → test; `patient_id`; `withdrawn_by_amendment` → amendment → its result + test (0179) |
| `hmo_claim_items` | `test_request_id` → test (`batch_id` names no patient) |
| `hmo_payment_allocations` | `item_id` → item; `payment_id` → payment |
| `hmo_claim_resolutions` | `item_id` → item |
| `doctor_pf_entries` | `test_request_id` → test; `hmo_allocation_id` → allocation → item ∪ payment |

Not patient-bearing (checked): `results.report_group_id` (report_groups has no patient/visit column), `hmo_claim_items.batch_id`, `visits.visit_group_id` (no FK), `appointments.booking_group_id`, `*.legacy_import_run_id`, `test_requests.discount_kind`.

**Result membership (Codex plan review P1-2).** Which patient a results-family row belongs to is decided by `result_test_requests`, a separate table. A patient lock alone cannot stop the membership changing under a writer (a value insert resolves patient A; a link to patient B commits; B is deleted; the value commits under B, whose lock it never held). So membership has its own advisory lock, key `(hashtext('result_membership'), hashtext(result_id::text))`: `result_test_requests` INSERT/UPDATE/DELETE and `results` DELETE take it **exclusive**; every other results-family write (`results` UPDATE, `result_values`, `result_amendments`, `critical_alerts`) takes it **shared** — including on an UNLINKED result — and only then resolves the patients. Global lock order: **membership lock(s) → patient lifecycle lock(s) → row locks → re-read.** Delete/restore and ownership moves never take a membership lock, so no cycle can form through it.

**0179 follow-up columns** (`result_amendments.patient_contacted_at/_by`, `patient_notified_at`, `patient_notified_channels`, `patient_notify_error`): written by `result_mark_copy_contacted`, `result_claim_patient_notify`, `result_record_patient_notify` AFTER they row-lock the amendment. They are follow-up bookkeeping (the sender itself checks the recipient is active, `checkPatientRecipient`) — the fifth guard exception, like alert acknowledgement; no lock taken, so no row-lock-before-advisory-lock ordering is introduced in those functions.

**Money is compared in centavos (Codex plan review P2-4).** Every money column involved is `numeric(10,2)` (`visits.total_php`, `test_requests.*_php`, `payments.amount_php`) or `numeric(12,2)` (`hmo_payment_allocations.amount_php`). The app computes line prices with JS numbers (`discounts.ts` rounds a percent discount to centavos, but `base - discount` and any sum are floats: 100.10 + 200.20 = 300.29999999999995). So both the app and the RPCs normalise every amount to integer centavos (`Math.round(x * 100)` / `round(x * 100)::bigint`) before comparing or summing.

**Schema (local stack, 2026-09-25).**
- `cogs_send_out_entries` no longer exists (dropped by 0166) — the spec matrix row is moot; no guard.
- `critical_alerts` acknowledgement columns: **`acknowledged_at`, `acknowledged_by`** (no note column). Created only inside `result_finalise_commit` / `result_edit_commit`; acknowledged by `critical-alerts/actions.ts:12-72` (pathologist/admin, conditional update).
- `visit_pins` login bookkeeping columns: **`failed_attempts`, `locked_until`, `last_used_at`** (portal `login/actions.ts` ~169-178 and ~226-233). Reissue changes `pin_hash`/`expires_at`.
- `doctor_pf_entries` disbursement link column: **`disbursement_id`** only (`pf-disbursements.ts:81-86`; unlink in `pf-disbursement-void.ts`).
- `appointments` has **no `updated_at`**. Staff transitions (`appointments/actions.ts` `transitionGroup`) update `status` only; cancel/no-show are app-unguarded by design.
- `results` has no patient FK (0051 dropped it); `result_test_requests` has PK `(result_id, test_request_id)` plus **`uq_result_test_requests_test_request`** (one result per test). `result_amendments.attempt_id` (0172) is the edit replay key.
- Trigger order: same-timing triggers fire in name order (C collation). Existing BEFORE triggers are named `tg_*` / `trg_*`; `a_lifecycle_guard` sorts before all of them, so the advisory lock is taken before any other trigger takes a row lock (0183's planned payments guard locks `visits FOR UPDATE`).
- Nested writers that matter: `recalc_visit_payment` (payments → visits), `fn_queue_delete_cascade` (test_requests → visits/test_requests), `maintain_repeat_patient_flag` (visits → patients), `tg_hmo_item_paid_amount_recompute` / resolution recompute (→ items), `tg_hmo_batch_voided_propagate` (batch → **all** items of the batch), `recompute_hmo_batch_status` (→ batches only), `tg_payment_void_cascade_allocations` (payments → allocations), `bridge_pf_at_hmo_allocation` (→ `doctor_pf_entries`), `advance_test_on_rtr_insert` / `advance_test_on_result_upload` (→ test_requests). A batch **void** with settled items is already refused by P0010, so only a batch **reopen** reaches an inactive patient's item.
- FKs into patient-owned tables with cascades: `visit_pins`←visits (cascade), `result_values`/`result_amendments`/`critical_alerts`/`result_test_requests`←results (cascade), `test_requests.parent_id` (cascade), `patient_consents`←patients (cascade). Not patient-owned (not guarded): `audit_log`, `patient_merges` (3b), `gift_codes` (redemption needs a guarded payment), `contact_messages`, `hmo_claim_batches`, journal tables, sheet-sync's tables (0170, not on main).
- `audit_log` has `idx_audit_log_action` (the skip summary needs no new index). `resource_id` is uuid.
- Local: `max_locks_per_transaction = 64`, `max_connections = 100`. Advisory locks share the lock table, so one transaction can hold several thousand; Task 1 measures it and reads prod's values.
- `patients.created_at` exists (the resolver's "oldest active candidate" order).

**App (file:line on origin/main 175f53ee).**
- New visit: `visits/new/actions.ts` — `createVisitAction` (83-585) → `createOneVisit` (669-807, user client, visits insert then ONE bulk test_requests insert, headers before components) ×1-2 → bulk `visit_pins` insert (admin, one shared bcrypt hash) → `pre_registered` clear (admin) → audits `patient.identity_verified`, `visit.created`, `visit_pin.issued`, `package.decomposed` → best-effort appointment completion. `deleteVisitCascade` (811-817) compensates. No behavioural test exists.
- Results creation, three sites, none transactional: `finalise-consolidated.ts:283-311` (consolidated; resume logic 205-268), `queue/[id]/actions.ts:219-243` (`prepareStructured`, single structured), `queue/[id]/actions.ts:795-820` (`uploadResultAction` first upload; fixed path `${patient}/${visit}/${tr}.pdf` with `upsert: true`, line 719/749). `commitWithUploads` (`result-edit-core.ts:61-116`) is module-private.
- HMO settlement: `admin/accounting/hmo-claims/actions.ts:650-767` (`recordHmoSettlementAction`): one payment per visit in a loop, bulk allocations, two unchecked compensating-delete loops.
- Closures: `admin/closures/actions.ts:107-217` (`bulkRescheduleForClosureAction`, chunks of 200, JS active filter, per-row + summary audits); `admin/closures/page.tsx:43-59` preview counts **without** the active filter (overcounts).
- Merge/undo: `admin/patient-merge/actions.ts` — `mergePatientsAction` 134-359 (six unchecked repoints; notice email 285-305 records its outcome only inline in `patient.merged`), `undoMergeAction` 414-534 (six unchecked repoints 466-493, field clear 496-506, **source marker cleared last at 509**, ledger 512-515). `actions.tables.test.ts` pins table-list parity with `scripts/patient-dedup/engine.ts`.
- Booking: `resolvePatient()` (`src/lib/patients/resolve.ts:59-70`, no retry) has 4 callers; `appointments_insert_slot_guarded` has 2 callers, both in `src/lib/appointments/create.ts` (175, 242).
- `translatePgError` (`src/lib/accounting/pg-errors.ts`) has no 40001/40P01 handling anywhere in the repo.
- Skip audits: `auditSkippedInactiveRecipient` (`src/lib/notifications/inactive-recipient-audit.ts`), metadata `{sender, reason, patient_id}`; senders `notify-released`, `notify-released-bulk`, `notify-appointment-booked`, `notify-appointment-reminder`, `register` (3), `find-my-id`, `send-statement-email`; reasons `deleted | merged | missing | lookup_failed` (+ `walk_in` from the two release senders). `checkPatientRecipient` (`active-patient-recipient.ts:43`) never reports `lookup_failed` to Sentry; `reportError()` (`src/lib/observability/report-error.ts`) is the convention.
- Cron Health: `admin/operations/cron-health/page.tsx` — one server component, one `<table>`, `requireAdminStaff()`.
- `ConfirmDialog` (`src/components/staff/confirm-dialog.tsx`) props include `confirmDisabled`; the delete dialog (`patient-delete-button.tsx:163-186`) renders the blocker list with no DOM id.
- `scripts/smoke-print.ts`: `pg` is a dependency; `SMOKE_PRINT_DB_URL` default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`; env guard `isLocalHost`/`hostOf` from `scripts/lib/env-guard`; already has a 5-client race check.
- README never names `SUPABASE_JWT_SECRET`; `.env.example` (33-39) and CLAUDE.md do.
- `set_patient_context` has no caller and no grant; `current_patient_id()` (0167) still reads the `app.current_patient_id` GUC first.

## File map

**Database**
- Create `supabase/migrations/0184_patient_lifecycle_locks.sql` — built section by section (Tasks 2–15), **re-runnable** on the local stack (`create or replace`, `drop … if exists`).
- Create `supabase/tests/0184_patient_lifecycle_locks_smoke.sql` — LOCAL ONLY, `begin … rollback`, one `do $sN$` section per SQL task, each with a negative control.
- Modify `supabase/tests/0167_patient_soft_delete_smoke.sql` — flip the assertions 0184 intentionally changes (Task 4 Step 6, Task 15 Step 4).
- Create `scripts/smoke-lifecycle-locks.ts` (+ `package.json` script `smoke:locks`) — two-connection races.
- Modify `src/types/database.ts` — regenerated, trimmed to 0184's objects.

**Libs**
- Create `src/lib/patients/lifecycle-retry.ts` (+ test) — `isLifecycleRetryable`, `withLifecycleRetry`.
- Create `src/lib/visits/encounter-payload.ts` (+ test) — pure builder of the `create_visit_encounter` payload (moved out of `createOneVisit`).
- Create `src/lib/actions/results/create-linked.ts` — `callResultCreateLinked` / `createLinkedResult` (server-only wrappers of `result_create_linked`).
- Create `src/lib/appointments/patient-recovery.ts` (+ `create.test.ts`) — `insertWithPatientRecovery`, `LOOKUP_AGAIN_ERROR`.
- Create `src/lib/patients/undo-merge-steps.ts` (+ test) — undo-merge step order and runner.
- Create `src/lib/notifications/skip-labels.ts` (+ test) — plain words for Cron Health's skipped-message table.
- Create `src/lib/visits/creation-paths.test.ts` — static pin: no direct inserts into the RPC-owned tables.
- Modify `src/lib/accounting/pg-errors.ts` (P0072, P0073, 40001, 40P01), `src/lib/actions/results/result-edit-core.ts` (export `commitWithUploads`, retry), `src/lib/patients/resolve.ts`, `src/lib/appointments/create.ts`, `src/lib/notifications/active-patient-recipient.ts`, `src/lib/patients/write-guards.test.ts`.

**Actions / pages**
- `visits/new/actions.ts`, `queue/[id]/actions.ts`, `src/lib/actions/results/finalise-consolidated.ts`, `admin/accounting/hmo-claims/actions.ts`, `admin/closures/{actions.ts,page.tsx}`, `admin/patient-merge/actions.ts`, `admin/operations/cron-health/page.tsx`, `src/components/staff/{confirm-dialog.tsx,patient-delete-button.tsx}`.

**Docs**
- `docs/drmed-user-guide.html`, `README.md`, `CLAUDE.md`, the spec, `.claude/skills/drmed-{migrations,rls-and-auth,booking-and-intake,payments,results-and-lab}/SKILL.md` if present (tracked copies; see Task 28).

## Conventions every task follows

- Paths under `staff/` mean `src/app/(staff)/staff/(dashboard)/`.
- Apply the migration to the local stack (re-runnable):
  `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 < supabase/migrations/0184_patient_lifecycle_locks.sql`
- Run the smoke test:
  `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/0184_patient_lifecycle_locks_smoke.sql 2>&1 | grep -E "NOTICE|ERROR" | tail -60`
- The local stack is **shared by every worktree and other live sessions**. Never `supabase db reset` without the check in Task 29. Never run a fixture against prod (no MCP `execute_sql` fixtures; read-only SELECTs only).
- Every smoke section is a `do $sN$ … $sN$;` block appended **before the file's final `rollback;`**; it raises `notice '0184 sN.k OK'` per assertion via `pg_temp.expect`, and captures SQLSTATEs with `pg_temp.state_of` (so a "should have failed" is asserted OUTSIDE the failing statement — the NOTE ON SHAPE in `0147_hmo_claim_delete_guard_smoke.sql`).
- Every new/replaced function pins `set search_path = pg_catalog, public, pg_temp` (except `resolve_patient_guarded`, which uses `''` to stay a superset of 0170) and schema-qualifies objects. Every new function revokes `all` from `public, anon, authenticated` and grants exactly what the task says. Trigger functions revoke from `service_role` too (firing needs no EXECUTE).
- Lock order everywhere: **result-membership lock(s) (results family only, sorted) → patient lifecycle lock(s) (sorted) → row locks → a fresh re-read.** Never shared-then-exclusive on one key in one transaction (take the exclusive first when a transaction will change membership).
- Money: compare and sum in integer centavos (`round(x * 100)::bigint` in SQL, `Math.round(x * 100)` in TS), never raw `numeric = numeric` against a JS float.
- A smoke assertion about lock ORDER or text position must require every position it compares to be `> 0` (a missing call returns 0 and would otherwise pass) and gets a mutation check that removes the call.
- Unit tests: `npx vitest run <file>`. Before every TS commit: `npm run typecheck && npx vitest run <changed tests>`; full `npm test && npm run lint` at Tasks 24 and 29. Capture long output to a log file in the scratchpad and report only failures.
- Commits: Conventional Commits ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Nothing is pushed until Task 31.
- Scratchpad for throwaway files: the executing session's scratchpad (2026-09-28: `/private/tmp/claude-501/-Users-jamila/68a00369-7b20-4431-96c1-fbeea5171386/scratchpad/`; below: `$SCRATCH`).

---

### Task 0: Preconditions and coordination

**Files:** none (git, claims, local DB only).

- [ ] **Step 1: Rebase onto current main.** The branch holds only the two spec commits (`01a9ff60`, `425d5d87`) and this plan.

```bash
cd /Users/jamila/Claude/DRMed/.worktrees/patient-delete-locks
git fetch -q origin && git rebase origin/main && git log --oneline -5
```
Expected: the spec + plan commits on top of `origin/main` (`1e73db7c` or later — it already holds **0179**, so Task 8 (4c) copies 0179's `result_edit_commit`). If main now also contains 0170 or 0183, note which — Task 8/9 must copy those bodies instead of 0174/0167 (see the replay rule in Facts). Also list every migration on main numbered above 0184 and grep it for the 0184-owned functions (table in Facts): `for f in $(ls supabase/migrations | awk -F_ '$1>"0184"'); do grep -oiE "function +public\.(delete_patient|restore_patient|result_save_draft|result_finalise_commit|result_edit_commit|correct_payment|appointments_insert_slot_guarded|resolve_patient_guarded|current_patient_id|recompute_hmo_batch_status)\b" supabase/migrations/$f; done` — expected: nothing. Any hit means 0184 must be renumbered above it (stop and ask the controller to claim a new number).

- [ ] **Step 2: Confirm the claims.**

```bash
npm run -s claim -- list | grep -E "0184|P0072|P0073"
```
Expected: all three held by `feat/patient-delete-locks`. If any is gone, stop and ask the controller.

- [ ] **Step 3: Local stack at ≥ 0186 with 0179 applied, by object.**

```bash
docker exec supabase_db_DRMed psql -U postgres -d postgres -Atc "select max(version) from supabase_migrations.schema_migrations; select count(*) from information_schema.columns where table_name='visits' and column_name='is_sample'; select count(*) from information_schema.columns where table_name='result_amendments' and column_name='patient_contacted_at'; select rolsuper, rolcreaterole from pg_roles where rolname='postgres';"
```
Expected (2026-09-28): version `0186`, `1`, `1`, `f|t`. If the 0179 column is missing, stop and ask (0179 is merged and should have been applied by its session). If the ledger is below 0181 or the `is_sample` column is missing, apply it (0181 is re-runnable — `add column if not exists`, `create index if not exists`):
`docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 < supabase/migrations/0181_visit_sample_flag.sql`
and, only if the ledger row is missing afterwards, stamp it:
`docker exec supabase_db_DRMed psql -U postgres -d postgres -c "insert into supabase_migrations.schema_migrations (version, name, statements) values ('0181','visit_sample_flag','{}') on conflict do nothing"`.
Note the ledger head (other sessions apply their branches here — 0170's `trg_patients_referral_origin` is present locally although 0170 is not on main; that's fine, don't reset).

- [ ] **Step 4: Confirm the overlap notes are where the other sessions will see them.** The plan revision of 2026-09-28 appended a "**2026-09-28 — 0184 overlap / REPLAY rule**" paragraph to each of these memory files (the other sessions' start-here notes): `~/.claude/projects/-Users-jamila/memory/drmed-sheet-sync.md` (`resolve_patient_guarded`), `drmed-result-copy-followups.md` (`result_edit_commit`; 0179 merged — informational, plus the 0179 follow-up-column exception), `drmed-released-unpaid-followups-decisions.md` (`correct_payment`). Verify with `grep -c "0184 overlap / REPLAY rule"` on each (expect 1). The rule they state: if 0184 reaches main first, the second-lander must NOT re-create the function in its own lower-numbered file — it ships a new migration, claimed fresh and numbered above 0184, holding 0184's body plus its edits; fresh-replay equivalence is its ship prerequisite. Also run `ListAgents`; if a live session for sheet-sync (jamila-08) or waived-balance is listed, `SendMessage` it that rule in one paragraph.

- [ ] **Step 5: Link files for the later `db push`, and deps.**

```bash
mkdir -p supabase/.temp && cp /Users/jamila/Claude/DRMed/supabase/.temp/{project-ref,linked-project.json,pooler-url} supabase/.temp/ 2>&1 | tail -2
test -d node_modules || npm ci
```

- [ ] **Step 6: Read-only prod facts the design relies on** (MCP `execute_sql`, SELECT only — never a fixture):

```sql
-- One-patient-per-result: expect 0 (the new junction check then changes nothing existing).
select count(*) from (select rtr.result_id from public.result_test_requests rtr
  join public.test_requests tr on tr.id = rtr.test_request_id join public.visits v on v.id = tr.visit_id
  group by 1 having count(distinct v.patient_id) > 1) s;
-- A component whose header sits on a different visit, an alert whose patient differs from its test's: expect 0 / 0.
select count(*) from public.test_requests c join public.test_requests h on h.id = c.parent_id where c.visit_id <> h.visit_id;
select count(*) from public.critical_alerts ca join public.test_requests tr on tr.id = ca.test_request_id
  join public.visits v on v.id = tr.visit_id where ca.patient_id is distinct from v.patient_id;
-- The rollup function's ACL, to restate exactly in Task 12.
select proacl, prosecdef, proconfig from pg_proc where oid = 'public.recompute_hmo_batch_status(uuid)'::regprocedure;
select version from supabase_migrations.schema_migrations order by version desc limit 5;
```
Record the numbers in the Task 0 report. A non-zero first count means an existing multi-patient result: STOP and ask — the one-patient-per-result check (Task 6) would then refuse re-linking it. Non-zero second/third counts are informational (the union lock covers them).

---

### Task 1: Spike — prove the lock mechanics on PG 17 (throwaway, not committed)

The design rests on seven behaviours. Prove them before writing the migration.

**Files:** none committed. Scratch: `$SCRATCH/lock-spike.sql`, `$SCRATCH/lock-spike-2conn.sh`.

- [ ] **Step 1: Single-connection facts.** Write `$SCRATCH/lock-spike.sql`:

```sql
-- LOCAL ONLY. Everything rolls back.
begin;
-- (1) Re-entrancy: exclusive then shared on the same key in one transaction is fine.
select pg_advisory_xact_lock(hashtext('patient_lifecycle'), 42);
select pg_advisory_xact_lock_shared(hashtext('patient_lifecycle'), 42);
select count(*) as held_modes from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and objid = 42;  -- expect 2

-- (2) A SECURITY DEFINER trigger function with EXECUTE revoked from every runtime role still fires for them.
create table public.spike_t (id int primary key, v text);
grant select, insert, update on public.spike_t to service_role, authenticated;
create function public.spike_guard() returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $g$
begin
  perform pg_advisory_xact_lock_shared(hashtext('patient_lifecycle'), 7);
  new.v := new.v || ':' || current_user;   -- runs as the definer
  return new;
end $g$;
revoke all on function public.spike_guard() from public, anon, authenticated, service_role;
create trigger a_spike before insert on public.spike_t for each row execute function public.spike_guard();
set local role service_role;
insert into public.spike_t values (1, 'x');
reset role;
select v from public.spike_t;                        -- expect 'x:postgres'

-- (3) postgres can re-run CREATE OR REPLACE on delete_patient (owned by patient_lifecycle_writer).
select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = 'delete_patient';  -- patient_lifecycle_writer
do $d$ declare v text; begin
  select pg_get_functiondef('public.delete_patient(uuid,text,text,uuid,jsonb)'::regprocedure) into v;
  execute v;                                          -- same body: must not raise
end $d$;
select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = 'delete_patient';  -- still patient_lifecycle_writer

-- (4) A pg_temp plpgsql helper can `set local role` to the private role and back.
create function pg_temp.as_writer() returns text language plpgsql as $f$
begin
  set local role patient_lifecycle_writer;
  return current_user;
end $f$;
select pg_temp.as_writer();                           -- expect patient_lifecycle_writer
reset role;

-- (5) Lock-table capacity: one transaction holding 3,000 distinct shared advisory keys.
select count(*) from (select pg_advisory_xact_lock_shared(hashtext('patient_lifecycle'), g) from generate_series(1, 3000) g) s;
show max_locks_per_transaction;
rollback;
```
Run: `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 < $SCRATCH/lock-spike.sql`
Expected: `held_modes = 2`; `x:postgres`; owner unchanged before/after; `patient_lifecycle_writer`; the 3,000 count returns `3000` with no "out of shared memory". Then read prod's settings read-only via MCP `execute_sql`: `show max_locks_per_transaction; show max_connections;` — record them; the closure RPC's largest realistic lock set (one clinic day's appointments, < 200 patients) must be far below `max_locks_per_transaction × max_connections`.

- [ ] **Step 2: Two-connection facts.** Write `$SCRATCH/lock-spike-2conn.sh`:

```bash
#!/bin/zsh
# (6) A child INSERT waiting on the advisory lock holds no KEY SHARE on patients yet,
#     so a FOR NO KEY UPDATE on the patient row does not deadlock with it.
# (7) A volatile plpgsql statement run AFTER the wait sees a row the other session committed.
PSQL=(docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At)
$PSQL[@] <<'SQL' &
begin;
select pg_advisory_xact_lock(hashtext('patient_lifecycle'), 99);
select pg_sleep(3);
create temp table if not exists spike_seen(x int);
commit;
SQL
sleep 0.5
$PSQL[@] <<'SQL'
create or replace function pg_temp.after_wait() returns text language plpgsql as $f$
declare t0 timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock_shared(hashtext('patient_lifecycle'), 99);   -- waits ~2.5 s
  return round(extract(epoch from clock_timestamp() - t0))::text;
end $f$;
begin; select pg_temp.after_wait() as waited_seconds; commit;
SQL
wait
```
Run: `zsh $SCRATCH/lock-spike-2conn.sh` — expect `waited_seconds` 2 or 3 (shared waits for exclusive). The fresh-snapshot-after-wait property (7) is proven properly in Task 16's script (`delete_first` scenarios); here it is enough that the wait happens.

- [ ] **Step 3: Decide.** All hold → continue. If (2) or (3) fails, stop and report the exact error (the design needs a definer trigger and an owner-transfer-free replace). If (5) fails below 3,000, record the ceiling — Task 13's RPC must then refuse more than that many distinct patients with a clear message (add it there).

---
### Task 2: Lock primitives and patient-path resolvers

**Files:**
- Create: `supabase/migrations/0184_patient_lifecycle_locks.sql`
- Create: `supabase/tests/0184_patient_lifecycle_locks_smoke.sql`

- [ ] **Step 1: Write the smoke-test skeleton + section s1 (fails: functions missing).**

```sql
-- =============================================================================
-- 0184_patient_lifecycle_locks_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after 0184 is applied:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/0184_patient_lifecycle_locks_smoke.sql
--
-- Runs inside BEGIN … ROLLBACK; leaves no rows behind. Single-connection only:
-- the two-connection races live in scripts/smoke-lifecycle-locks.ts. Sections:
--   s1  lock primitives + patient-path resolvers
--   s2  delete/restore take FOR NO KEY UPDATE
--   s3  guards: visits, appointments, patient_consents, appointment_attachments
--   s4  guards: test_requests, payments, visit_pins
--   s5  guards: results, result_test_requests, result_values, result_amendments, critical_alerts
--   s6  guards: HMO items/allocations/resolutions, doctor_pf_entries, mixed batch
--   s7  existing RPCs pre-acquire (result_*, correct_payment, appointments_insert_slot_guarded)
--   s8  resolve_patient_guarded
--   s9  create_visit_encounter
--   s10 result_create_linked
--   s11 record_hmo_settlement
--   s12 reschedule_closure_appointments
--   s13 current_patient_id JWT-only, set_patient_context gone, notification_skip_summary
--   s14 catalog sweep: owners, search_path, ACLs, trigger order
-- =============================================================================

begin;

do $guard$
begin
  if (select count(*) from public.patients) > 5000 then
    raise exception 'refusing: % patients looks like prod — this test is LOCAL ONLY',
      (select count(*) from public.patients);
  end if;
end
$guard$;

-- --- Shared fixture -----------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000184', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'lk-admin@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000184', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'lk-reception@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000184', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'lk-medtech@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active)
values
  ('a0000000-0000-4000-8000-000000000184', 'LK Admin', 'admin', true),
  ('a1000000-0000-4000-8000-000000000184', 'LK Reception', 'reception', true),
  ('a2000000-0000-4000-8000-000000000184', 'LK Medtech', 'medtech', true);

insert into public.services (id, code, name, price_php, kind)
values
  ('c0000000-0000-4000-8000-000000000184', 'LK-LAB',     'LK smoke lab test',   1000, 'lab_test'),
  ('c1000000-0000-4000-8000-000000000184', 'LK-LAB2',    'LK smoke lab test 2',  400, 'lab_test'),
  ('c2000000-0000-4000-8000-000000000184', 'LK-PKG',     'LK smoke package',    1500, 'lab_package'),
  ('c3000000-0000-4000-8000-000000000184', 'LK-CONSULT', 'LK smoke consult',     500, 'doctor_consultation');

insert into public.hmo_providers (id, name)
values ('b0000000-0000-4000-8000-000000000184', 'LK Smoke HMO');

-- Helpers (pg_temp: vanish with the session).
create function pg_temp.mk_patient(tag text) returns uuid language sql as $f$
  insert into public.patients (drm_id, first_name, last_name, birthdate, email)
  values ('DRM-LK' || tag, 'Smoke', 'Lk' || tag, '1990-01-01', 'lk' || lower(tag) || '@example.test')
  returning id;
$f$;

create function pg_temp.mk_visit(p uuid, hmo boolean default false) returns uuid language sql as $f$
  insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php, hmo_provider_id)
  values ('V-LK-' || substr(md5(random()::text), 1, 10), p, 'unpaid', 0, 0,
          case when hmo then 'b0000000-0000-4000-8000-000000000184'::uuid end)
  returning id;
$f$;

create function pg_temp.mk_line(v uuid, status text default 'requested', final numeric default 0,
                                parent uuid default null, header boolean default false,
                                svc uuid default 'c0000000-0000-4000-8000-000000000184')
returns uuid language sql as $f$
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, parent_id, is_package_header)
  values (v, svc, status, 'a0000000-0000-4000-8000-000000000184', final, final, parent, header)
  returning id;
$f$;

create function pg_temp.mk_pay(v uuid, amount numeric, method text default 'cash') returns uuid language sql as $f$
  insert into public.payments (visit_id, amount_php, method, received_by)
  values (v, amount, method, 'a1000000-0000-4000-8000-000000000184')
  returning id;
$f$;

-- Deletes a patient WITHOUT the blocker check (fixtures need inactive
-- patients that still own children). Same mechanism 0167's smoke uses.
create function pg_temp.kill(p uuid) returns void language plpgsql as $f$
begin
  set local role patient_lifecycle_writer;
  update public.patients
     set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000184', delete_reason = 'test_record'
   where id = p;
  reset role;
end $f$;

create function pg_temp.revive(p uuid) returns void language plpgsql as $f$
begin
  set local role patient_lifecycle_writer;
  update public.patients set deleted_at = null, deleted_by = null, delete_reason = null, delete_note = null
   where id = p;
  reset role;
end $f$;

create function pg_temp.merge_into(src uuid, keep uuid) returns void language sql as $f$
  update public.patients set merged_into_id = keep, merged_at = now() where id = src;
$f$;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception '0184 % FAILED: got [%], want [%]', label, got, want;
  end if;
  raise notice '0184 % OK', label;
end $f$;

-- Runs sql; returns the SQLSTATE it raised, or 'ok'.
create function pg_temp.state_of(sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute sql;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- Number of advisory locks this backend holds in a given mode.
create function pg_temp.held(mode text) returns int language sql as $f$
  select count(*)::int from pg_locks
   where locktype = 'advisory' and pid = pg_backend_pid() and pg_locks.mode = held.mode
     and classid = (hashtext('patient_lifecycle'))::oid;
$f$;

-- Same, for the result-membership namespace.
create function pg_temp.held_results(mode text) returns int language sql as $f$
  select count(*)::int from pg_locks
   where locktype = 'advisory' and pid = pg_backend_pid() and pg_locks.mode = held_results.mode
     and classid = (hashtext('result_membership'))::oid;
$f$;

-- Does this backend hold the lifecycle lock on patient p in mode m?
create function pg_temp.holds(p uuid, m text) returns boolean language sql as $f$
  select exists (select 1 from pg_locks
   where locktype = 'advisory' and pid = pg_backend_pid() and mode = m
     and classid = (hashtext('patient_lifecycle'))::oid and objid = (hashtext(p::text))::oid);
$f$;

-- 0119 strips PUBLIC EXECUTE from every function postgres creates, temp ones
-- included; helpers called after `set local role …` need an explicit grant.
do $grant$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', f);
  end loop;
end
$grant$;

-- --- s1: lock primitives + resolvers ------------------------------------------
do $s1$
declare
  p  uuid := pg_temp.mk_patient('S1A');
  d  uuid := pg_temp.mk_patient('S1D');
  m  uuid := pg_temp.mk_patient('S1M');
  k  uuid := pg_temp.mk_patient('S1K');
  f0 uuid := pg_temp.mk_patient('S1F');   -- never written for: no lock held on it yet
  v  uuid;
  tr uuid;
  r  uuid;
  pay uuid;
  b  uuid;
  it uuid;
  q uuid; vq uuid; hq uuid; payq uuid; rq uuid; amq uuid; itq uuid; alq uuid;
  pq uuid[];
  s0 int;
  x0 int;
begin
  v  := pg_temp.mk_visit(p, true);
  tr := pg_temp.mk_line(v, 'in_progress', 1000);
  pay := pg_temp.mk_pay(v, 100);
  insert into public.results (generation_kind, uploaded_by) values ('structured', 'a2000000-0000-4000-8000-000000000184')
    returning id into r;
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted')
    returning id into b;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (b, tr, 1000)
    returning id into it;
  perform pg_temp.kill(d);
  perform pg_temp.merge_into(m, k);

  -- lifecycle_norm: distinct + sorted, NULL kept once.
  perform pg_temp.expect('s1.1 norm dedups and sorts',
    public.lifecycle_norm(array[k, p, p, k])::text,
    (select array_agg(x order by x) from unnest(array[k, p]) x)::text);
  perform pg_temp.expect('s1.2 norm keeps one NULL',
    array_length(public.lifecycle_norm(array[p, null, null]::uuid[]), 1)::text, '2');

  -- Locks: shared and exclusive, counted in pg_locks.
  s0 := pg_temp.held('ShareLock');
  -- f0 (and k below) own no rows, so no guard has locked them earlier in this
  -- transaction (once Tasks 4-7 install the guards, p already is).
  perform public.lifecycle_lock_and_assert(array[f0, f0], false);
  perform pg_temp.expect('s1.3 shared lock taken once per distinct patient',
    (pg_temp.held('ShareLock') - s0)::text, '1');
  x0 := pg_temp.held('ExclusiveLock');
  perform public.lifecycle_lock_and_assert(array[k], true);
  perform pg_temp.expect('s1.4 exclusive lock taken',
    (pg_temp.held('ExclusiveLock') - x0)::text, '1');

  -- Assertion: inactive / missing / NULL refuse; empty and NULL array are no-ops.
  perform pg_temp.expect('s1.5 CONTROL active patient passes',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L]::uuid[], false)$q$, p)), 'ok');
  perform pg_temp.expect('s1.6 deleted patient refused',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L]::uuid[], false)$q$, d)), 'P0058');
  perform pg_temp.expect('s1.7 merged patient refused',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L]::uuid[], false)$q$, m)), 'P0058');
  perform pg_temp.expect('s1.8 missing patient refused',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L]::uuid[], false)$q$, gen_random_uuid())), 'P0058');
  perform pg_temp.expect('s1.9 NULL element refused (unresolved parent)',
    pg_temp.state_of(format($q$select public.lifecycle_lock_and_assert(array[%L, null]::uuid[], false)$q$, p)), 'P0058');
  perform pg_temp.expect('s1.10 empty array is a no-op',
    pg_temp.state_of($q$select public.lifecycle_lock_and_assert('{}'::uuid[], false)$q$), 'ok');
  perform pg_temp.expect('s1.11 NULL array is a no-op',
    pg_temp.state_of($q$select public.lifecycle_lock_and_assert(null::uuid[], false)$q$), 'ok');
  perform pg_temp.expect('s1.12 lock-only primitive does not assert',
    pg_temp.state_of(format($q$select public.lifecycle_lock(array[%L]::uuid[], false)$q$, d)), 'ok');
  begin
    perform public.lifecycle_lock_and_assert(array[d], false);
  exception when sqlstate 'P0058' then
    perform pg_temp.expect('s1.13 message names the DRM-ID', (sqlerrm like '%DRM-LKS1D%')::text, 'true');
  end;

  -- Resolvers.
  perform pg_temp.expect('s1.14 visit → patient',
    public.lifecycle_patients_of_visits(array[v])::text, array[p]::text);
  perform pg_temp.expect('s1.15 missing visit → NULL (fail closed)',
    public.lifecycle_patients_of_visits(array[gen_random_uuid()])::text, '{NULL}');
  perform pg_temp.expect('s1.16 test request → patient',
    public.lifecycle_patients_of_test_requests(array[tr])::text, array[p]::text);
  perform pg_temp.expect('s1.17 unlinked result → empty',
    public.lifecycle_patients_of_result(r)::text, '{}');
  insert into public.result_test_requests (result_id, test_request_id) values (r, tr);
  perform pg_temp.expect('s1.18 linked result → patient',
    public.lifecycle_patients_of_result(r)::text, array[p]::text);
  perform pg_temp.expect('s1.19 claim item → patient',
    public.lifecycle_patients_of_hmo_items(array[it])::text, array[p]::text);
  perform pg_temp.expect('s1.20 payment → patient',
    public.lifecycle_patients_of_payments(array[pay])::text, array[p]::text);
  perform pg_temp.expect('s1.21 row resolver: test_requests',
    public.lifecycle_patients_of_row('test_requests', jsonb_build_object('visit_id', v), false)::text, array[p]::text);
  perform pg_temp.expect('s1.22 row resolver: walk-in appointment → empty',
    public.lifecycle_patients_of_row('appointments', jsonb_build_object('patient_id', null), false)::text, '{}');
  perform pg_temp.expect('s1.23 row resolver: allocation = item ∪ payment',
    public.lifecycle_norm(public.lifecycle_patients_of_row('hmo_payment_allocations',
      jsonb_build_object('item_id', it, 'payment_id', pay), false))::text, array[p]::text);
  perform pg_temp.expect('s1.24 row resolver: delete drops a vanished parent',
    public.lifecycle_patients_of_row('visit_pins', jsonb_build_object('visit_id', gen_random_uuid()), true)::text, '{}');
  perform pg_temp.expect('s1.25 row resolver: unknown table fails closed',
    pg_temp.state_of($q$select public.lifecycle_patients_of_row('staff_profiles', '{}'::jsonb, false)$q$), 'P0058');

  -- Every patient-bearing reference is followed (Codex plan review P1-1).
  -- q is a second active patient; each row below names p on one path and q on another.
  q  := pg_temp.mk_patient('S1Q');
  vq := pg_temp.mk_visit(q, true);
  hq := pg_temp.mk_line(vq, 'in_progress', 0, null, true, 'c2000000-0000-4000-8000-000000000184');
  payq := pg_temp.mk_pay(vq, 10, 'hmo');
  insert into public.results (generation_kind, uploaded_by) values ('structured', 'a2000000-0000-4000-8000-000000000184')
    returning id into rq;
  insert into public.result_test_requests (result_id, test_request_id) values (rq, pg_temp.mk_line(vq, 'in_progress', 10));
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (rq, (select test_request_id from public.result_test_requests where result_id = rq), 'x', 'a2000000-0000-4000-8000-000000000184',
            now(), 'smoke', 'a2000000-0000-4000-8000-000000000184', 1)
    returning id into amq;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php)
    values (b, pg_temp.mk_line(vq, 'released', 10), 10) returning id into itq;
  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (payq, itq, 10)
    returning id into alq;
  pq := array[p, q];
  pq := (select array_agg(x order by x) from unnest(pq) x);
  perform pg_temp.expect('s1.26 test_requests: visit ∪ parent header',
    public.lifecycle_norm(public.lifecycle_patients_of_row('test_requests',
      jsonb_build_object('visit_id', v, 'parent_id', hq), false))::text, pq::text);
  perform pg_temp.expect('s1.27 payments: visit ∪ corrected payment',
    public.lifecycle_norm(public.lifecycle_patients_of_row('payments',
      jsonb_build_object('visit_id', v, 'corrects_payment_id', payq), false))::text, pq::text);
  perform pg_temp.expect('s1.28 result_test_requests: test ∪ the result''s membership',
    public.lifecycle_norm(public.lifecycle_patients_of_row('result_test_requests',
      jsonb_build_object('test_request_id', tr, 'result_id', rq), false))::text, pq::text);
  perform pg_temp.expect('s1.29 result_amendments: result ∪ test',
    public.lifecycle_norm(public.lifecycle_patients_of_row('result_amendments',
      jsonb_build_object('result_id', rq, 'test_request_id', tr), false))::text, pq::text);
  perform pg_temp.expect('s1.30 critical_alerts: result ∪ test ∪ patient_id ∪ withdrawn_by_amendment',
    public.lifecycle_norm(public.lifecycle_patients_of_row('critical_alerts',
      jsonb_build_object('result_id', r, 'test_request_id', tr, 'patient_id', p, 'withdrawn_by_amendment', amq), false))::text, pq::text);
  perform pg_temp.expect('s1.31 doctor_pf_entries: test ∪ HMO allocation',
    public.lifecycle_norm(public.lifecycle_patients_of_row('doctor_pf_entries',
      jsonb_build_object('test_request_id', tr, 'hmo_allocation_id', alq), false))::text, pq::text);
  perform pg_temp.expect('s1.32 an optional reference that is NULL adds nothing',
    public.lifecycle_norm(public.lifecycle_patients_of_row('test_requests',
      jsonb_build_object('visit_id', v, 'parent_id', null), false))::text, array[p]::text);
  perform pg_temp.expect('s1.33 an optional reference to a MISSING row fails closed (NULL element)',
    (array_position(public.lifecycle_patients_of_row('payments',
      jsonb_build_object('visit_id', v, 'corrects_payment_id', gen_random_uuid()), false), null) is not null)::text, 'true');
  perform pg_temp.expect('s1.34 result resolver can leave one test out (junction UPDATE)',
    public.lifecycle_patients_of_result(r, tr)::text, '{}');

  -- Result-membership lock (Codex plan review P1-2).
  perform pg_temp.expect('s1.35 result ids of a row: critical alert = result ∪ withdrawing amendment''s result',
    public.lifecycle_norm(public.lifecycle_result_ids_of_row('critical_alerts',
      jsonb_build_object('result_id', r, 'withdrawn_by_amendment', amq)))::text,
    (select array_agg(x order by x) from unnest(array[r, rq]) x)::text);
  perform pg_temp.expect('s1.36 result ids of a non-results row → empty',
    public.lifecycle_result_ids_of_row('visits', jsonb_build_object('id', v))::text, '{}');
  s0 := pg_temp.held_results('ShareLock');
  perform public.lifecycle_lock_results(array[r, r, null], false);
  perform pg_temp.expect('s1.37 shared membership lock, once per distinct result, NULLs ignored',
    (pg_temp.held_results('ShareLock') - s0)::text, '1');
  x0 := pg_temp.held_results('ExclusiveLock');
  perform public.lifecycle_lock_results(array[rq], true);
  perform pg_temp.expect('s1.38 exclusive membership lock',
    (pg_temp.held_results('ExclusiveLock') - x0)::text, '1');

  -- ACLs: no runtime role may call the primitives.
  perform pg_temp.expect('s1.39 no runtime EXECUTE on primitives',
    (select bool_or(has_function_privilege(r2, f, 'execute'))::text
       from unnest(array['anon','authenticated','service_role']) r2,
            unnest(array[
              'public.lifecycle_lock(uuid[],boolean)',
              'public.lifecycle_lock_and_assert(uuid[],boolean)',
              'public.lifecycle_lock_results(uuid[],boolean)',
              'public.lifecycle_norm(uuid[])',
              'public.lifecycle_patients_of_visits(uuid[])',
              'public.lifecycle_patients_of_test_requests(uuid[])',
              'public.lifecycle_patients_of_result(uuid,uuid)',
              'public.lifecycle_patients_of_hmo_items(uuid[])',
              'public.lifecycle_patients_of_payments(uuid[])',
              'public.lifecycle_patients_of_amendments(uuid[])',
              'public.lifecycle_patients_of_allocations(uuid[])',
              'public.lifecycle_via(text,text)',
              'public.lifecycle_result_ids_of_row(text,jsonb)',
              'public.lifecycle_patients_of_row(text,jsonb,boolean)']) f),
    'false');
end
$s1$;

rollback;
```

- [ ] **Step 2: Run it — expect FAIL** (`function public.lifecycle_norm(uuid[]) does not exist`).

Run: the smoke command from Conventions. Expected: `ERROR:  function public.lifecycle_norm(uuid[]) does not exist`.

- [ ] **Step 3: Write the migration header + section (1).**

```sql
-- =============================================================================
-- 0184_patient_lifecycle_locks.sql — patient delete PR 3a
-- =============================================================================
-- Race-proofs patient deletion (0167). Spec:
-- docs/superpowers/specs/2026-09-24-patient-delete-design.md, "PR 3 revision".
--
-- ONE LOCK, TWO MODES. Key (hashtext('patient_lifecycle'), hashtext(patient_id::text)),
-- the key 0167's delete_patient / restore_patient already take EXCLUSIVE.
-- Every other patient-owned write takes it SHARED, so writers never wait for
-- each other, only for a delete/restore; a statement that moves a row to a
-- different patient takes it EXCLUSIVE on old and new (sorted). Lock order
-- everywhere: advisory lock(s) first, sorted by key → row locks → fresh re-read.
-- Never shared-then-exclusive on one key in one transaction (upgrades deadlock).
--
-- (1) lifecycle_lock / lifecycle_lock_and_assert, the result-membership lock
--     lifecycle_lock_results, and resolvers that follow EVERY patient-bearing reference
-- (2) delete_patient / restore_patient re-created with FOR NO KEY UPDATE
-- (3) enforce_patient_activity(): the default-refuse guard, as a_lifecycle_guard
-- (4) existing RPCs take the lock before their row locks
-- (5) resolve_patient_guarded: case-insensitive, locked, re-read
-- (6) create_visit_encounter
-- (7) result_create_linked
-- (8) record_hmo_settlement
-- (9) reschedule_closure_appointments
-- (10) current_patient_id JWT-only, set_patient_context dropped, notification_skip_summary
-- (11) post-conditions
--
-- P-codes: P0072 the patient on a record changed while it was being saved
-- (the transaction aborted; retry once), P0073 a visit encounter could not be
-- created (message passes through). Input validation in the new RPCs uses
-- 22023 / 42501 (messages pass through translatePgError). P0058 (0167) is
-- the refusal on an inactive patient.
--
-- Re-runnable on the local stack. Function bodies copied from earlier
-- migrations say which file and lines they came from.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- (1) Lock primitives. SECURITY DEFINER, owned by the migration owner (which
-- owns every patient-owned table and is not subject to their RLS): an
-- RLS-hidden parent can never look like "no patient". EXECUTE is revoked from
-- every runtime role; guard triggers and the RPCs below call these as their
-- owner. VOLATILE: every statement after a lock wait takes a fresh snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.lifecycle_norm(p_ids uuid[])
returns uuid[]
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) from unnest(p_ids) x;
$$;

-- Takes the lifecycle lock on every distinct patient, in ascending key order.
-- Lock only — the resolver (5) re-reads and decides itself.
create or replace function public.lifecycle_lock(p_patient_ids uuid[], p_exclusive boolean)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_key int;
begin
  for v_key in
    select distinct hashtext(x::text) as k
      from unnest(coalesce(p_patient_ids, '{}'::uuid[])) x
     where x is not null
     order by k
  loop
    if p_exclusive then
      perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), v_key);
    else
      perform pg_advisory_xact_lock_shared(hashtext('patient_lifecycle'), v_key);
    end if;
  end loop;
end;
$$;

-- Lock, then re-read every patient with a fresh statement. A NULL element is
-- a required parent that did not resolve: fail closed.
create or replace function public.lifecycle_lock_and_assert(p_patient_ids uuid[], p_exclusive boolean)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_bad record;
begin
  if p_patient_ids is null or cardinality(p_patient_ids) = 0 then
    return;
  end if;
  if array_position(p_patient_ids, null) is not null then
    raise exception 'this record''s patient could not be found — reload and try again'
      using errcode = 'P0058';
  end if;

  perform public.lifecycle_lock(p_patient_ids, p_exclusive);

  select x as id, p.drm_id, p.deleted_at, p.merged_into_id
    into v_bad
    from unnest(p_patient_ids) x
    left join public.patients p on p.id = x
   where p.id is null or p.deleted_at is not null or p.merged_into_id is not null
   order by x
   limit 1;
  if found then
    if v_bad.drm_id is null then
      raise exception 'this record''s patient could not be found — reload and try again'
        using errcode = 'P0058';
    elsif v_bad.merged_into_id is not null then
      raise exception 'patient % was merged into another record — use the kept record', v_bad.drm_id
        using errcode = 'P0058';
    else
      raise exception 'patient % is deleted — restore the record before changing it', v_bad.drm_id
        using errcode = 'P0058';
    end if;
  end if;
end;
$$;

-- Patient paths. A parent that does not exist yields a NULL element.
create or replace function public.lifecycle_patients_of_visits(p_visit_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from unnest(p_visit_ids) x
    left join public.visits v on v.id = x;
$$;

create or replace function public.lifecycle_patients_of_test_requests(p_test_request_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from unnest(p_test_request_ids) x
    left join public.test_requests tr on tr.id = x
    left join public.visits v on v.id = tr.visit_id;
$$;

-- A result has no patient until it is linked (0051): an unlinked draft is
-- inert. Callers hold the result's MEMBERSHIP lock (below) before calling
-- this, so the answer cannot change under them. p_except_test leaves one link
-- out (a junction UPDATE judges the result's OTHER links).
create or replace function public.lifecycle_patients_of_result(p_result_id uuid, p_except_test uuid default null)
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from public.result_test_requests rtr
    left join public.test_requests tr on tr.id = rtr.test_request_id
    left join public.visits v on v.id = tr.visit_id
   where rtr.result_id = p_result_id
     and rtr.test_request_id is distinct from p_except_test;
$$;

-- A result amendment belongs to its result's patients and its test's patient.
create or replace function public.lifecycle_patients_of_amendments(p_amendment_ids uuid[])
returns uuid[]
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_out uuid[] := '{}';
  a     record;
begin
  for a in
    select x, am.id, am.result_id, am.test_request_id
      from unnest(p_amendment_ids) x
      left join public.result_amendments am on am.id = x
  loop
    if a.id is null then
      v_out := v_out || null::uuid;   -- missing: fail closed
    else
      v_out := v_out || public.lifecycle_patients_of_result(a.result_id)
                     || public.lifecycle_patients_of_test_requests(array[a.test_request_id]);
    end if;
  end loop;
  return v_out;
end;
$$;

-- An HMO allocation belongs to its claim item's patient and its payment's patient.
create or replace function public.lifecycle_patients_of_allocations(p_allocation_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(pid), '{}'::uuid[]) from (
    select v1.patient_id as pid
      from unnest(p_allocation_ids) x
      left join public.hmo_payment_allocations al on al.id = x
      left join public.hmo_claim_items i on i.id = al.item_id
      left join public.test_requests tr on tr.id = i.test_request_id
      left join public.visits v1 on v1.id = tr.visit_id
    union all
    select v2.patient_id
      from unnest(p_allocation_ids) x
      left join public.hmo_payment_allocations al on al.id = x
      left join public.payments pay on pay.id = al.payment_id
      left join public.visits v2 on v2.id = pay.visit_id
  ) s;
$$;

-- One reference → its patients. A NULL/empty reference names nobody ('{}');
-- a reference to a row that does not exist yields a NULL element (fail closed).
create or replace function public.lifecycle_via(p_kind text, p_id text)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if nullif(p_id, '') is null then
    return '{}'::uuid[];
  end if;
  return case p_kind
    when 'patient'      then array[p_id::uuid]   -- a missing patient fails in lifecycle_lock_and_assert
    when 'visit'        then public.lifecycle_patients_of_visits(array[p_id::uuid])
    when 'test_request' then public.lifecycle_patients_of_test_requests(array[p_id::uuid])
    when 'payment'      then public.lifecycle_patients_of_payments(array[p_id::uuid])
    when 'result'       then public.lifecycle_patients_of_result(p_id::uuid)
    when 'amendment'    then public.lifecycle_patients_of_amendments(array[p_id::uuid])
    when 'hmo_item'     then public.lifecycle_patients_of_hmo_items(array[p_id::uuid])
    when 'allocation'   then public.lifecycle_patients_of_allocations(array[p_id::uuid])
  end;
end;
$$;

-- The results whose MEMBERSHIP a results-family row depends on.
create or replace function public.lifecycle_result_ids_of_row(p_table text, p_row jsonb)
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select array_remove(case
    when p_row is null then '{}'::uuid[]
    when p_table = 'results' then array[nullif(p_row ->> 'id', '')::uuid]
    when p_table in ('result_test_requests', 'result_values', 'result_amendments')
      then array[nullif(p_row ->> 'result_id', '')::uuid]
    when p_table = 'critical_alerts'
      then array[nullif(p_row ->> 'result_id', '')::uuid,
                 (select am.result_id from public.result_amendments am
                   where am.id = nullif(p_row ->> 'withdrawn_by_amendment', '')::uuid)]
    else '{}'::uuid[]
  end, null);
$$;

-- The result-membership lock: key (hashtext('result_membership'),
-- hashtext(result_id)), sorted, NULLs ignored. EXCLUSIVE when the write
-- changes which tests a result holds (result_test_requests insert/update/
-- delete, results delete); SHARED for every other results-family write. Taken
-- BEFORE the patient lock — the patient set of a result is only stable while
-- its membership is.
create or replace function public.lifecycle_lock_results(p_result_ids uuid[], p_exclusive boolean)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_key int;
begin
  for v_key in
    select distinct hashtext(x::text) as k
      from unnest(coalesce(p_result_ids, '{}'::uuid[])) x
     where x is not null
     order by k
  loop
    if p_exclusive then
      perform pg_advisory_xact_lock(hashtext('result_membership'), v_key);
    else
      perform pg_advisory_xact_lock_shared(hashtext('result_membership'), v_key);
    end if;
  end loop;
end;
$$;

create or replace function public.lifecycle_patients_of_hmo_items(p_item_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from unnest(p_item_ids) x
    left join public.hmo_claim_items i on i.id = x
    left join public.test_requests tr on tr.id = i.test_request_id
    left join public.visits v on v.id = tr.visit_id;
$$;

create or replace function public.lifecycle_patients_of_payments(p_payment_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from unnest(p_payment_ids) x
    left join public.payments pay on pay.id = x
    left join public.visits v on v.id = pay.visit_id;
$$;

-- The patients a row (as jsonb) belongs to: the UNION over EVERY
-- patient-bearing reference the row carries (Facts table; Codex plan review
-- P1-1), so references that disagree are all locked and asserted, never just
-- the one path someone thought of. For a DELETE a vanished parent is dropped:
-- it can only be a cascade from the parent's own (guarded) delete. A new
-- patient-bearing column on any of these tables must be added here AND to
-- the Facts table; s14.5 fails on an FK the resolver does not know.
create or replace function public.lifecycle_patients_of_row(p_table text, p_row jsonb, p_for_delete boolean)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v uuid[];
begin
  v := case p_table
    when 'visits'                  then public.lifecycle_via('patient', p_row ->> 'patient_id')
                                        || case when p_row ->> 'patient_id' is null then array[null::uuid] else '{}'::uuid[] end
    when 'patient_consents'        then public.lifecycle_via('patient', p_row ->> 'patient_id')
                                        || case when p_row ->> 'patient_id' is null then array[null::uuid] else '{}'::uuid[] end
    when 'appointments'            then public.lifecycle_via('patient', p_row ->> 'patient_id')
    when 'appointment_attachments' then public.lifecycle_via('patient', p_row ->> 'patient_id')
    when 'test_requests'           then public.lifecycle_via('visit', p_row ->> 'visit_id')
                                        || public.lifecycle_via('test_request', p_row ->> 'parent_id')
    when 'payments'                then public.lifecycle_via('visit', p_row ->> 'visit_id')
                                        || public.lifecycle_via('payment', p_row ->> 'corrects_payment_id')
    when 'visit_pins'              then public.lifecycle_via('visit', p_row ->> 'visit_id')
    when 'results'                 then public.lifecycle_via('result', p_row ->> 'id')
    when 'result_test_requests'    then public.lifecycle_via('test_request', p_row ->> 'test_request_id')
                                        || public.lifecycle_via('result', p_row ->> 'result_id')
    when 'result_values'           then public.lifecycle_via('result', p_row ->> 'result_id')
    when 'result_amendments'       then public.lifecycle_via('result', p_row ->> 'result_id')
                                        || public.lifecycle_via('test_request', p_row ->> 'test_request_id')
    when 'critical_alerts'         then public.lifecycle_via('result', p_row ->> 'result_id')
                                        || public.lifecycle_via('test_request', p_row ->> 'test_request_id')
                                        || public.lifecycle_via('patient', p_row ->> 'patient_id')
                                        || public.lifecycle_via('amendment', p_row ->> 'withdrawn_by_amendment')
    when 'hmo_claim_items'         then public.lifecycle_via('test_request', p_row ->> 'test_request_id')
    when 'hmo_payment_allocations' then public.lifecycle_via('hmo_item', p_row ->> 'item_id')
                                        || public.lifecycle_via('payment', p_row ->> 'payment_id')
    when 'hmo_claim_resolutions'   then public.lifecycle_via('hmo_item', p_row ->> 'item_id')
    when 'doctor_pf_entries'       then public.lifecycle_via('test_request', p_row ->> 'test_request_id')
                                        || public.lifecycle_via('allocation', p_row ->> 'hmo_allocation_id')
  end;
  if v is null then
    raise exception 'lifecycle guard: no patient path for table %', p_table using errcode = 'P0058';
  end if;
  if p_for_delete then
    v := array(select x from unnest(v) x where x is not null);
  end if;
  return v;
end;
$$;

revoke all on function public.lifecycle_norm(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_lock(uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_lock_and_assert(uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_lock_results(uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_visits(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_test_requests(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_result(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_hmo_items(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_payments(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_amendments(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_allocations(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_via(text, text) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_result_ids_of_row(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_row(text, jsonb, boolean) from public, anon, authenticated, service_role;
```

Note on `visits`/`patient_consents`: `patient_id` is NOT NULL there, so a NULL can only mean a malformed row — the extra `array[null]` makes it fail closed rather than read as "nobody". On `appointments`/`appointment_attachments` NULL is a real walk-in / not-yet-linked upload and names nobody.

- [ ] **Step 4: Apply and run — expect PASS.** Apply (Conventions), run the smoke. Expected: `0184 s1.1 OK` … `0184 s1.39 OK`, no ERROR.

- [ ] **Step 5: Mutation check (vacuous-assertions rule).** Temporarily change `lifecycle_lock_and_assert`'s `where p.id is null or p.deleted_at is not null …` to `where false`, re-apply, re-run: s1.6/s1.7/s1.8 must FAIL. Then make `lifecycle_patients_of_row`'s `test_requests` branch drop its `parent_id` term: s1.26 must FAIL. Then make `lifecycle_lock_results` take the SHARED lock when asked for exclusive: s1.38 must FAIL. Restore each, re-apply, re-run: PASS.

- [ ] **Step 6: Commit.**

```bash
git add supabase/migrations/0184_patient_lifecycle_locks.sql supabase/tests/0184_patient_lifecycle_locks_smoke.sql
git commit -m "feat(db): lifecycle lock primitives and patient-path resolvers (0184 part 1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `delete_patient` / `restore_patient` take `FOR NO KEY UPDATE`

`FOR UPDATE` on the patient conflicts with the FK KEY SHARE a child insert takes, so a writer already holding KEY SHARE and then waiting for the advisory lock would deadlock with delete. Delete/restore change only non-key columns, so `FOR NO KEY UPDATE` is enough and does not conflict with KEY SHARE.

**Files:** Modify `supabase/migrations/0184_patient_lifecycle_locks.sql`, `supabase/tests/0184_patient_lifecycle_locks_smoke.sql`.

- [ ] **Step 1: Add smoke section s2 (fails: bodies still say `for update`).** Append before `rollback;`:

```sql
-- --- s2: delete/restore row-lock strength --------------------------------------
do $s2$
declare
  p uuid := pg_temp.mk_patient('S2A');
begin
  perform pg_temp.expect('s2.1 delete_patient uses FOR NO KEY UPDATE',
    (pg_get_functiondef('public.delete_patient(uuid,text,text,uuid,jsonb)'::regprocedure) ~* 'for\s+no\s+key\s+update')::text, 'true');
  perform pg_temp.expect('s2.2 restore_patient uses FOR NO KEY UPDATE',
    (pg_get_functiondef('public.restore_patient(uuid,uuid,jsonb)'::regprocedure) ~* 'for\s+no\s+key\s+update')::text, 'true');
  perform pg_temp.expect('s2.3 owners unchanged',
    (select string_agg(r.rolname, ',' order by p2.proname) from pg_proc p2 join pg_roles r on r.oid = p2.proowner
      where p2.proname in ('delete_patient', 'restore_patient')),
    'patient_lifecycle_writer,patient_lifecycle_writer');
  perform pg_temp.expect('s2.4 EXECUTE still service_role only',
    (has_function_privilege('service_role', 'public.delete_patient(uuid,text,text,uuid,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.delete_patient(uuid,text,text,uuid,jsonb)', 'execute')
     and has_function_privilege('service_role', 'public.restore_patient(uuid,uuid,jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.restore_patient(uuid,uuid,jsonb)', 'execute'))::text, 'true');
  -- Round trip still works.
  perform public.delete_patient(p, 'test_record', '', 'a0000000-0000-4000-8000-000000000184', '{}'::jsonb);
  perform pg_temp.expect('s2.5 delete works', (select (deleted_at is not null)::text from public.patients where id = p), 'true');
  perform public.restore_patient(p, 'a0000000-0000-4000-8000-000000000184', '{}'::jsonb);
  perform pg_temp.expect('s2.6 restore works', (select (deleted_at is null)::text from public.patients where id = p), 'true');
end
$s2$;
```
Run the smoke: expect `0184 s2.1 FAILED`.

- [ ] **Step 2: Add section (2) to the migration.** Copy `delete_patient` and `restore_patient` **verbatim** from `supabase/migrations/0167_patient_soft_delete.sql` (lines 529–606 and 608–669 — the two `create or replace function` statements through their closing `$$;`), changing exactly one line in each: `     for update;` → `     for no key update;`. Put this header above them:

```sql
-- ---------------------------------------------------------------------------
-- (2) delete_patient / restore_patient — bodies copied from 0167 (lines
-- 529-669); the ONLY change is FOR UPDATE → FOR NO KEY UPDATE on the patient
-- row. FOR UPDATE conflicts with the KEY SHARE a child insert's FK check
-- takes; these functions change no key column, and every writer takes its
-- advisory lock before its first FK check (BEFORE triggers run before RI
-- triggers; RPCs lock at entry), so the weaker lock cannot let a write slip
-- past a delete. postgres replaces them in place (INHERIT on
-- patient_lifecycle_writer, 0167); ownership and grants are unchanged —
-- restated below anyway.
-- ---------------------------------------------------------------------------
```
and after them:

```sql
revoke all on function public.delete_patient(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.restore_patient(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.delete_patient(uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.restore_patient(uuid, uuid, jsonb) to service_role;
```

- [ ] **Step 3: Apply, run — expect PASS** (s1 + s2). Check the owner did not change: s2.3.

- [ ] **Step 4: Commit.** `git commit -am "feat(db): delete/restore take FOR NO KEY UPDATE (0184 part 2)"` (with the Co-Authored-By trailer).

---
### Task 4: The guard — `enforce_patient_activity()` on visits, appointments, patient_consents, appointment_attachments

One trigger function serves every table (Tasks 4–7 only add `create trigger` lines). Rule: on an inactive patient every INSERT/UPDATE/DELETE is refused (P0058) except five column-shaped exceptions, two deletes and the unlinked results insert; a no-op UPDATE is always allowed; there is no trigger-depth exemption, so nested writes are checked like any other. Results-family rows take the result-membership lock before resolving patients; every patient-bearing reference of a row is locked and asserted (Facts table); a result link must keep the result to one patient.

**Files:** Modify the migration, the 0184 smoke, and `supabase/tests/0167_patient_soft_delete_smoke.sql`.

- [ ] **Step 1: Add smoke section s3 (fails: no trigger yet).** Append before `rollback;`:

```sql
-- --- s3: guards on the direct-patient tables -----------------------------------
do $s3$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S3A');
  b  uuid := pg_temp.mk_patient('S3B');
  d  uuid := pg_temp.mk_patient('S3D');
  m  uuid := pg_temp.mk_patient('S3M');
  vd uuid;
  va uuid;
  ap1 uuid; ap2 uuid; ap3 uuid; ap4 uuid; apw uuid;
  att_d uuid;
  x0 int;
begin
  -- Children created while the patients are active, then the patients go inactive.
  vd := pg_temp.mk_visit(d);
  va := pg_temp.mk_visit(a);
  insert into public.appointments (patient_id, status, scheduled_at) values
    (d, 'confirmed', now() + interval '1 day') returning id into ap1;
  insert into public.appointments (patient_id, status, scheduled_at) values
    (d, 'confirmed', now() + interval '1 day') returning id into ap2;
  insert into public.appointments (patient_id, status, scheduled_at) values
    (d, 'confirmed', now() + interval '2 days') returning id into ap3;
  insert into public.appointments (patient_id, status, scheduled_at) values
    (d, 'pending_callback', null) returning id into ap4;
  insert into public.appointments (patient_id, walk_in_name, status, scheduled_at) values
    (null, 'Walk In', 'confirmed', now() + interval '1 day') returning id into apw;
  insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes)
    values (gen_random_uuid(), d, 'lab-request-forms/s3.pdf', 's3.pdf', 'application/pdf', 10) returning id into att_d;
  perform pg_temp.kill(d);
  perform pg_temp.merge_into(m, a);

  -- visits
  perform pg_temp.expect('s3.1 CONTROL new visit on an active patient',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, b)), 'ok');
  perform pg_temp.expect('s3.2 FIRST visit on a deleted patient is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, d)), 'P0058');
  perform pg_temp.expect('s3.3 visit on a merged patient is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, m)), 'P0058');
  perform pg_temp.expect('s3.4 editing a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$update public.visits set notes = 'x' where id = %L$q$, vd)), 'P0058');
  perform pg_temp.expect('s3.5 a no-op update is allowed',
    pg_temp.state_of(format($q$update public.visits set notes = notes where id = %L$q$, vd)), 'ok');
  perform pg_temp.expect('s3.6 soft-deleting a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$update public.visits set deleted_at = now(), deleted_by = %L, delete_reason = 'x' where id = %L$q$, k_admin, vd)), 'P0058');
  x0 := pg_temp.held('ExclusiveLock');
  perform pg_temp.expect('s3.7 CONTROL moving a visit between two active patients',
    pg_temp.state_of(format($q$update public.visits set patient_id = %L where id = %L$q$, b, va)), 'ok');
  perform pg_temp.expect('s3.8 …takes EXCLUSIVE on old and new',
    (pg_temp.held('ExclusiveLock') - x0 >= 2)::text, 'true');
  perform pg_temp.expect('s3.9 moving a visit onto a deleted patient is refused',
    pg_temp.state_of(format($q$update public.visits set patient_id = %L where id = %L$q$, d, va)), 'P0058');
  set local role service_role;
  perform pg_temp.expect('s3.10 service_role gets no bypass',
    pg_temp.state_of(format($q$select pg_temp.mk_visit(%L)$q$, d)), 'P0058');
  reset role;

  -- appointments
  perform pg_temp.expect('s3.11 CONTROL booking an active patient',
    pg_temp.state_of(format($q$insert into public.appointments (patient_id, status, scheduled_at) values (%L, 'confirmed', now() + interval '3 days')$q$, b)), 'ok');
  perform pg_temp.expect('s3.12 booking a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.appointments (patient_id, status, scheduled_at) values (%L, 'confirmed', now() + interval '3 days')$q$, d)), 'P0058');
  perform pg_temp.expect('s3.13 CONTROL a walk-in is never guarded',
    pg_temp.state_of($q$insert into public.appointments (walk_in_name, status, scheduled_at) values ('W', 'confirmed', now() + interval '3 days')$q$), 'ok');
  -- (That cancel takes NO lock cannot be shown here — this transaction already
  -- locked d while creating its fixtures; smoke:locks proves it doesn't wait.)
  perform pg_temp.expect('s3.14 cancelling a deleted patient''s appointment is allowed',
    pg_temp.state_of(format($q$update public.appointments set status = 'cancelled' where id = %L$q$, ap1)), 'ok');
  perform pg_temp.expect('s3.16 marking no-show is allowed',
    pg_temp.state_of(format($q$update public.appointments set status = 'no_show' where id = %L$q$, ap2)), 'ok');
  perform pg_temp.expect('s3.17 marking arrived is refused',
    pg_temp.state_of(format($q$update public.appointments set status = 'arrived' where id = %L$q$, ap3)), 'P0058');
  perform pg_temp.expect('s3.18 cancel + another column is refused (exception is column-shaped)',
    pg_temp.state_of(format($q$update public.appointments set status = 'cancelled', notes = 'x' where id = %L$q$, ap3)), 'P0058');
  perform pg_temp.expect('s3.19 rescheduling is refused',
    pg_temp.state_of(format($q$update public.appointments set scheduled_at = now() + interval '5 days' where id = %L$q$, ap3)), 'P0058');
  perform pg_temp.expect('s3.20 attaching a walk-in to a deleted patient is refused',
    pg_temp.state_of(format($q$update public.appointments set patient_id = %L, walk_in_name = null where id = %L$q$, d, apw)), 'P0058');
  perform pg_temp.expect('s3.21 deleting a deleted patient''s appointment row is allowed',
    pg_temp.state_of(format($q$delete from public.appointments where id = %L$q$, ap4)), 'ok');

  -- patient_consents (0167's patients guard only covered DELETED; merged was open)
  perform pg_temp.expect('s3.22 CONTROL consent event for an active patient',
    pg_temp.state_of(format($q$insert into public.patient_consents (patient_id, event_type, reason, actor_kind, created_by) values (%L, 'withdrawn', 'smoke', 'staff', %L)$q$, b, k_admin)), 'ok');
  perform pg_temp.expect('s3.23 consent event for a MERGED patient is refused',
    pg_temp.state_of(format($q$insert into public.patient_consents (patient_id, event_type, reason, actor_kind, created_by) values (%L, 'withdrawn', 'smoke', 'staff', %L)$q$, m, k_admin)), 'P0058');

  -- appointment_attachments (0167's delete-only guard folded in)
  perform pg_temp.expect('s3.24 CONTROL upload row for an active patient',
    pg_temp.state_of(format($q$insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes) values (gen_random_uuid(), %L, 'lab-request-forms/b.pdf', 'b.pdf', 'application/pdf', 10)$q$, b)), 'ok');
  perform pg_temp.expect('s3.25 upload row for a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes) values (gen_random_uuid(), %L, 'lab-request-forms/d.pdf', 'd.pdf', 'application/pdf', 10)$q$, d)), 'P0058');
  perform pg_temp.expect('s3.26 removing a deleted patient''s upload is refused',
    pg_temp.state_of(format($q$delete from public.appointment_attachments where id = %L$q$, att_d)), 'P0058');
  perform pg_temp.expect('s3.27 0167''s delete-only guard is gone (folded in)',
    (select count(*)::text from pg_trigger where tgname = 'trg_appointment_attachments_delete_guard'), '0');

  -- The guard fires FIRST among BEFORE row triggers on every guarded table so far.
  perform pg_temp.expect('s3.28 a_lifecycle_guard fires first',
    (select string_agg(first_trigger, ',' order by rel) from (
       select c.relname as rel,
              (select t.tgname from pg_trigger t
                where t.tgrelid = c.oid and not t.tgisinternal and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
                order by t.tgname collate "C" limit 1) as first_trigger
         from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relname in ('visits', 'appointments', 'patient_consents', 'appointment_attachments')) s),
    'a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard,a_lifecycle_guard');
end
$s3$;
```

- [ ] **Step 2: Run — expect FAIL** at `s3.2` (got `ok`: the first visit on a deleted patient is still accepted).

- [ ] **Step 3: Add section (3) to the migration.**

```sql
-- ---------------------------------------------------------------------------
-- (3) The guard. DEFAULT REFUSE: on an inactive (deleted or merged) patient,
-- every INSERT, UPDATE and DELETE on a patient-owned table raises P0058,
-- except these, which are allowed whatever the patient's state and so take
-- no lock at all (they add no work and move no money):
--   appointments      UPDATE changing only status, to cancelled / no_show
--                     (owner decision 2026-09-25); DELETE
--   visit_pins        UPDATE changing only failed_attempts / locked_until /
--                     last_used_at (portal sign-in bookkeeping); DELETE
--                     (retention). A PIN REISSUE changes pin_hash: refused.
--   critical_alerts   UPDATE changing only acknowledged_at / acknowledged_by
--   doctor_pf_entries UPDATE changing only disbursement_id (paying a doctor
--                     for work already done adds nothing to the patient)
--   result_amendments UPDATE changing only the 0179 follow-up bookkeeping
--                     (patient_contacted_at/_by, patient_notified_at,
--                     patient_notified_channels, patient_notify_error) — the
--                     notice sender checks the recipient itself
--   results           INSERT (unlinked until result_test_requests — inert)
-- A no-op UPDATE (nothing but updated_at changes) is always allowed: the
-- recompute triggers rewrite identical values. There is NO trigger-depth
-- exemption — a nested write (a batch reopen propagating batch_voided to an
-- inactive patient's claim item) is refused like any other.
--
-- Everything else:
--  1. results family only: take the result-MEMBERSHIP lock on every result
--     the row depends on (old and new) — EXCLUSIVE for a result_test_requests
--     write or a results DELETE (membership changes), SHARED otherwise. From
--     here on no link to those results can be added or removed until commit,
--     so the patients resolved in step 2 are the result's real patients.
--  2. resolve the row's patients over EVERY patient-bearing reference (old
--     and new), take the lifecycle lock — EXCLUSIVE on old+new when the write
--     moves the row to a different patient set, SHARED otherwise — and assert
--     all active.
--  3. resolve again: if the set moved while we waited (a visit/test moved to
--     another patient), raise P0072 (the caller retries in a fresh
--     transaction; never "lock the new one too" — a newly found key may sort
--     below one already held).
--  4. result_test_requests INSERT/UPDATE: one patient per result — the new
--     link's patient must be the patient of the result's other links
--     (23514). Under the exclusive membership lock this cannot race.
--
-- Installed as a_lifecycle_guard: same-timing triggers fire in name order and
-- every other BEFORE trigger is tg_*/trg_*, so this lock is always taken
-- before another trigger takes a row lock (0183's planned payments guard locks
-- visits FOR UPDATE). SECURITY DEFINER (see (1)); EXECUTE revoked — firing
-- needs none.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_patient_activity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_o       jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_n       jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_changed text[];
  v_old     uuid[] := '{}';
  v_new     uuid[] := '{}';
  v_set     uuid[];
  v_again   uuid[];
  v_owner   uuid[];
begin
  -- (a) Allowed whatever the patient's state; no lock.
  if tg_op = 'DELETE' and tg_table_name in ('appointments', 'visit_pins') then
    return old;
  end if;
  if tg_op = 'INSERT' and tg_table_name = 'results' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}'::text[])
      into v_changed
      from jsonb_object_keys(v_n) k
     where k <> 'updated_at'
       and (v_n -> k) is distinct from (v_o -> k);
    if cardinality(v_changed) = 0 then
      return new;
    end if;
    if (tg_table_name = 'appointments'
          and v_changed = array['status']
          and v_n ->> 'status' in ('cancelled', 'no_show'))
       or (tg_table_name = 'visit_pins'
          and v_changed <@ array['failed_attempts', 'last_used_at', 'locked_until'])
       or (tg_table_name = 'critical_alerts'
          and v_changed <@ array['acknowledged_at', 'acknowledged_by'])
       or (tg_table_name = 'doctor_pf_entries'
          and v_changed = array['disbursement_id'])
       or (tg_table_name = 'result_amendments'
          and v_changed <@ array['patient_contacted_at', 'patient_contacted_by', 'patient_notified_at',
                                 'patient_notified_channels', 'patient_notify_error']) then
      return new;
    end if;
  end if;

  -- (b) Results family: the membership lock FIRST (see header, step 1).
  if tg_table_name in ('results', 'result_test_requests', 'result_values', 'result_amendments', 'critical_alerts') then
    perform public.lifecycle_lock_results(
      public.lifecycle_result_ids_of_row(tg_table_name, v_o) || public.lifecycle_result_ids_of_row(tg_table_name, v_n),
      tg_table_name = 'result_test_requests' or (tg_table_name = 'results' and tg_op = 'DELETE'));
  end if;

  -- (c) Lock the owning patients, assert, re-resolve.
  if v_o is not null then
    v_old := public.lifecycle_patients_of_row(tg_table_name, v_o, tg_op = 'DELETE');
  end if;
  if v_n is not null then
    v_new := public.lifecycle_patients_of_row(tg_table_name, v_n, false);
  end if;
  v_set := public.lifecycle_norm(v_old || v_new);

  perform public.lifecycle_lock_and_assert(
    v_set,
    tg_op = 'UPDATE' and public.lifecycle_norm(v_old) is distinct from public.lifecycle_norm(v_new));

  v_again := public.lifecycle_norm(
       case when v_o is not null
            then public.lifecycle_patients_of_row(tg_table_name, v_o, tg_op = 'DELETE')
            else '{}'::uuid[] end
    || case when v_n is not null
            then public.lifecycle_patients_of_row(tg_table_name, v_n, false)
            else '{}'::uuid[] end);
  if v_again is distinct from v_set then
    raise exception 'the patient on this record changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  -- (d) One patient per result (Codex plan review P1-1, "enforce ownership
  -- consistency"): a link may only join a result whose OTHER links belong to
  -- the same patient. Stable under the exclusive membership lock from (b).
  if tg_table_name = 'result_test_requests' and tg_op <> 'DELETE' then
    v_owner := public.lifecycle_norm(array_remove(
                 public.lifecycle_patients_of_result((v_n ->> 'result_id')::uuid,
                   case when tg_op = 'UPDATE' and (v_o ->> 'result_id') = (v_n ->> 'result_id')
                        then (v_o ->> 'test_request_id')::uuid end)
                 || public.lifecycle_patients_of_test_requests(array[(v_n ->> 'test_request_id')::uuid]),
                 null));
    if cardinality(v_owner) > 1 then
      raise exception 'a result can only hold one patient''s tests — create a separate result for this test'
        using errcode = '23514';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.enforce_patient_activity() from public, anon, authenticated, service_role;

-- Tables whose rows name the patient directly.
drop trigger if exists a_lifecycle_guard on public.visits;
create trigger a_lifecycle_guard
  before insert or update or delete on public.visits
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.appointments;
create trigger a_lifecycle_guard
  before insert or update or delete on public.appointments
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.patient_consents;
create trigger a_lifecycle_guard
  before insert or update or delete on public.patient_consents
  for each row execute function public.enforce_patient_activity();

-- 0167's delete-only attachment guard is folded in: the general guard covers
-- INSERT/UPDATE/DELETE and takes the lock.
drop trigger if exists trg_appointment_attachments_delete_guard on public.appointment_attachments;
drop function if exists public.enforce_appointment_attachment_delete();
drop trigger if exists a_lifecycle_guard on public.appointment_attachments;
create trigger a_lifecycle_guard
  before insert or update or delete on public.appointment_attachments
  for each row execute function public.enforce_patient_activity();
```

- [ ] **Step 4: Apply, run 0184 smoke — expect PASS** (s1–s3).

- [ ] **Step 5: Mutation check.** Temporarily delete the `appointments … cancelled/no_show` exception clause, re-apply: s3.14/s3.16 must FAIL (P0058). Temporarily change `perform public.lifecycle_lock_and_assert(` to `perform public.lifecycle_lock(` : s3.2/s3.12/s3.23/s3.25 must FAIL. Restore both, re-apply, PASS.

- [ ] **Step 6: Reconcile the 0167 smoke with the new rule.** Run it: `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/0167_patient_soft_delete_smoke.sql 2>&1 | grep -E "NOTICE|ERROR" | tail -40`. Two assertions are expected to fail and are updated in place:
  - `s1.28 CURRENT: first visit on a deleted patient is accepted` → rename to `s1.28 first visit on a deleted patient is refused (0184)` and expect `'P0058'`; replace the comment block above it ("This pins CURRENT, ACTUAL behaviour … PR 3 adds child-table guards — update this when it does.") with: `-- Since 0184 the a_lifecycle_guard trigger on visits refuses ANY visit on a deleted patient, first or second.`
  - `s9.6 attachment delete guard is definer, pinned` → assert the successor instead:

```sql
  perform pg_temp.expect('s9.6 attachment guard (0184 a_lifecycle_guard) is definer, pinned',
    (select format('%s|%s', p.prosecdef, p.proconfig)
       from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = 'public.appointment_attachments'::regclass and t.tgname = 'a_lifecycle_guard'),
    't|{"search_path=pg_catalog, public, pg_temp"}');
```
  If any OTHER 0167 assertion fails, decide by this rule and nothing else: if it writes to a child row of an inactive patient in a way the exception list in section (3) does not allow, 0184 is right — flip it to `P0058` with a `(0184)` suffix on the label; if the write IS in the exception list, 0184 has a bug — fix the guard, not the test. Re-run until the 0167 smoke is all OK.

- [ ] **Step 7: Commit.** `git add -A supabase && git commit -m "feat(db): default-refuse lifecycle guard on visits, appointments, consents, uploads (0184 part 3)"` (+ trailer).

---

### Task 5: Guards on test_requests, payments, visit_pins

**Files:** migration, 0184 smoke.

- [ ] **Step 1: Add smoke section s4 (fails).**

```sql
-- --- s4: guards on the visit-path tables ----------------------------------------
do $s4$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S4A');
  d  uuid := pg_temp.mk_patient('S4D');
  va uuid; vd uuid; vd2 uuid;
  la uuid; ld uuid; ld_rel uuid;
  ha uuid; hd uuid;
  pa uuid; pd uuid;
  pin_d uuid;
begin
  va := pg_temp.mk_visit(a);
  vd := pg_temp.mk_visit(d);
  vd2 := pg_temp.mk_visit(d);
  la := pg_temp.mk_line(va, 'requested', 100);
  ld := pg_temp.mk_line(vd, 'requested', 100);
  ld_rel := pg_temp.mk_line(vd2, 'released', 0);
  ha := pg_temp.mk_line(va, 'in_progress', 0, null, true, 'c2000000-0000-4000-8000-000000000184');
  hd := pg_temp.mk_line(vd, 'in_progress', 0, null, true, 'c2000000-0000-4000-8000-000000000184');
  pd := pg_temp.mk_pay(vd, 50);
  insert into public.visit_pins (visit_id, pin_hash) values (vd, '$2a$12$abcdefghijklmnopqrstuuM2ZyN0bN6o5uX0B0Qe0b8bOIG8J8r5a')
    returning id into pin_d;
  perform pg_temp.kill(d);

  -- test_requests
  perform pg_temp.expect('s4.1 CONTROL add a line on an active patient''s visit',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 10)$q$, va)), 'ok');
  perform pg_temp.expect('s4.2 add a line on a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 10)$q$, vd)), 'P0058');
  perform pg_temp.expect('s4.3 status change is refused',
    pg_temp.state_of(format($q$update public.test_requests set status = 'in_progress' where id = %L$q$, ld)), 'P0058');
  perform pg_temp.expect('s4.4 cancelling a released line is refused (reverses revenue + PF)',
    pg_temp.state_of(format($q$update public.test_requests set status = 'cancelled', cancelled_reason = 'x' where id = %L$q$, ld_rel)), 'P0058');
  perform pg_temp.expect('s4.5 soft-deleting a line is refused',
    pg_temp.state_of(format($q$update public.test_requests set deleted_at = now(), deleted_by = %L, delete_reason = 'x' where id = %L$q$, k_admin, ld)), 'P0058');
  perform pg_temp.expect('s4.6 moving a line from an active visit onto a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$update public.test_requests set visit_id = %L where id = %L$q$, vd, la)), 'P0058');
  perform pg_temp.expect('s4.7 a line pointing at a visit that does not exist fails closed',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 10)$q$, gen_random_uuid())), 'P0058');
  -- Mismatched references (Codex plan review P1-1): every reference is locked and asserted.
  perform pg_temp.expect('s4.7a CONTROL a component under its own visit''s header',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 0, %L, false)$q$, va, ha)), 'ok');
  perform pg_temp.expect('s4.7b a component on an ACTIVE visit whose parent header is on a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 0, %L, false)$q$, va, hd)), 'P0058');
  perform pg_temp.expect('s4.7c a payment on an ACTIVE visit that corrects a deleted patient''s payment is refused',
    pg_temp.state_of(format($q$insert into public.payments (visit_id, amount_php, method, received_by, corrects_payment_id) values (%L, 10, 'cash', %L, %L)$q$,
      va, 'a1000000-0000-4000-8000-000000000184', pd)), 'P0058');

  -- payments
  perform pg_temp.expect('s4.8 CONTROL payment on an active patient''s visit',
    pg_temp.state_of(format($q$select pg_temp.mk_pay(%L, 10)$q$, va)), 'ok');
  perform pg_temp.expect('s4.9 payment on a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$select pg_temp.mk_pay(%L, 10)$q$, vd)), 'P0058');
  perform pg_temp.expect('s4.10 voiding a deleted patient''s payment is refused',
    pg_temp.state_of(format($q$update public.payments set voided_at = now(), voided_by = %L, void_reason = 'x' where id = %L$q$, k_admin, pd)), 'P0058');
  perform pg_temp.expect('s4.11 hard-deleting a deleted patient''s payment is refused',
    pg_temp.state_of(format($q$delete from public.payments where id = %L$q$, pd)), 'P0058');

  -- visit_pins
  perform pg_temp.expect('s4.12 sign-in bookkeeping on a deleted patient''s PIN is allowed',
    pg_temp.state_of(format($q$update public.visit_pins set failed_attempts = failed_attempts + 1, locked_until = now() where id = %L$q$, pin_d)), 'ok');
  perform pg_temp.expect('s4.13 PIN REISSUE (hash change) is refused',
    pg_temp.state_of(format($q$update public.visit_pins set pin_hash = 'x', expires_at = now() + interval '60 days' where id = %L$q$, pin_d)), 'P0058');
  perform pg_temp.expect('s4.14 new PIN row on a deleted patient''s visit is refused',
    pg_temp.state_of(format($q$insert into public.visit_pins (visit_id, pin_hash) values (%L, 'x')$q$, vd2)), 'P0058');
  perform pg_temp.expect('s4.15 PIN retention delete is allowed',
    pg_temp.state_of(format($q$delete from public.visit_pins where id = %L$q$, pin_d)), 'ok');

  -- Restore lifts it.
  perform pg_temp.revive(d);
  perform pg_temp.expect('s4.16 after restore, a line can be added again',
    pg_temp.state_of(format($q$select pg_temp.mk_line(%L, 'requested', 10)$q$, vd)), 'ok');
end
$s4$;
```
Run: expect `s4.2 FAILED: got [ok]`.

- [ ] **Step 2: Add the triggers to section (3) of the migration.**

```sql
-- Tables that reach the patient through visit_id.
drop trigger if exists a_lifecycle_guard on public.test_requests;
create trigger a_lifecycle_guard
  before insert or update or delete on public.test_requests
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.payments;
create trigger a_lifecycle_guard
  before insert or update or delete on public.payments
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.visit_pins;
create trigger a_lifecycle_guard
  before insert or update or delete on public.visit_pins
  for each row execute function public.enforce_patient_activity();
```

- [ ] **Step 3: Apply, run — PASS** (s1–s4). Also extend s3.28's table list? No — s14 (Task 15) checks trigger order on all 16 tables.

- [ ] **Step 4: Run the neighbouring smokes** — they write lines/payments on active patients and must stay green: `0147_hmo_claim_delete_guard_smoke.sql`, `0161_payment_correction_smoke.sql`, `0174_correct_payment_stale_guard_smoke.sql`, `0043_eod_cash_reconciliation_smoke.sql`, `0030_op_gl_bridge_smoke.sql` (same docker command, one file at a time, `| grep -E "ERROR|FAIL" | head`). Expected: no ERROR/FAIL. A failure here means a fixture wrote to an inactive patient or the guard mis-resolves a path — investigate with superpowers:systematic-debugging, don't loosen the guard.

- [ ] **Step 5: Commit** — `feat(db): lifecycle guard on test_requests, payments, visit_pins (0184 part 4)`.

---

### Task 6: Guards on results, result_test_requests, result_values, result_amendments, critical_alerts

**Files:** migration, 0184 smoke.

- [ ] **Step 1: Add smoke section s5 (fails).** The template/parameter fixture is local to the section.

```sql
-- --- s5: guards on the results family ---------------------------------------------
do $s5$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  k_med   constant uuid := 'a2000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S5A');
  b  uuid := pg_temp.mk_patient('S5B');
  d  uuid := pg_temp.mk_patient('S5D');
  va uuid; vb uuid; vd uuid;
  ta uuid; ta2 uuid; ta3 uuid; ta4 uuid; tb uuid; td uuid; td2 uuid;
  ra uuid; rd uuid; r_new uuid; r_un uuid; r_b uuid;
  tpl uuid; prm uuid;
  al uuid; am_d uuid; am_a uuid;
  s0 int; x0 int;
begin
  insert into public.result_templates (service_id, layout) values ('c1000000-0000-4000-8000-000000000184', 'simple')
    returning id into tpl;
  insert into public.result_template_params (template_id, sort_order, parameter_name, input_type)
    values (tpl, 1, 'LK param', 'numeric') returning id into prm;
  va := pg_temp.mk_visit(a);
  vb := pg_temp.mk_visit(b);
  vd := pg_temp.mk_visit(d);
  ta  := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  ta2 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');  -- never linked
  ta3 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');  -- never linked
  ta4 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');  -- never linked
  tb  := pg_temp.mk_line(vb, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  td  := pg_temp.mk_line(vd, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  td2 := pg_temp.mk_line(vd, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into ra;
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into rd;
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into r_b;
  insert into public.result_test_requests (result_id, test_request_id) values (ra, ta), (rd, td), (r_b, tb);
  insert into public.result_values (result_id, parameter_id, numeric_value_si) values (rd, prm, 1);
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id)
    values (rd, td, prm, 'high', 'LK param', d) returning id into al;
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (rd, td, 'x', k_med, now(), 'smoke', k_med, 1) returning id into am_d;
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq)
    values (ra, ta, 'x', k_med, now(), 'smoke', k_med, 1) returning id into am_a;
  perform pg_temp.kill(d);

  perform pg_temp.expect('s5.1 an UNLINKED result row can always be inserted (inert)',
    pg_temp.state_of(format($q$insert into public.results (generation_kind, uploaded_by) values ('structured', %L)$q$, k_med)), 'ok');
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into r_new;
  -- ta2 was never linked (uq_result_test_requests_test_request allows one result per test).
  perform pg_temp.expect('s5.2 CONTROL link a result to an active patient''s unlinked test',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, r_new, ta2)), 'ok');
  perform pg_temp.expect('s5.3 linking a result to a deleted patient''s test is refused',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, r_new, td2)), 'P0058');
  perform pg_temp.expect('s5.4 editing a deleted patient''s result row is refused',
    pg_temp.state_of(format($q$update public.results set notes = 'x' where id = %L$q$, rd)), 'P0058');
  perform pg_temp.expect('s5.5 CONTROL editing an active patient''s result row',
    pg_temp.state_of(format($q$update public.results set notes = 'x' where id = %L$q$, ra)), 'ok');
  perform pg_temp.expect('s5.6 saving a value on a deleted patient''s result is refused',
    pg_temp.state_of(format($q$update public.result_values set numeric_value_si = 2 where result_id = %L$q$, rd)), 'P0058');
  perform pg_temp.expect('s5.7 inserting an amendment row is refused',
    pg_temp.state_of(format($q$insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by, prior_uploaded_at, reason, amended_by, amendment_seq) values (%L, %L, 'x', %L, now(), 'x', %L, 2)$q$, rd, td, k_med, k_med)), 'P0058');
  perform pg_temp.expect('s5.8 acknowledging a deleted patient''s critical alert is allowed',
    pg_temp.state_of(format($q$update public.critical_alerts set acknowledged_at = now(), acknowledged_by = %L where id = %L$q$, k_med, al)), 'ok');
  perform pg_temp.expect('s5.9 changing anything else on the alert is refused',
    pg_temp.state_of(format($q$update public.critical_alerts set observed_value_si = 9 where id = %L$q$, al)), 'P0058');
  perform pg_temp.expect('s5.10 new critical alert for a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id) values (%L, %L, %L, 'low', 'LK param', %L)$q$, rd, td, prm, d)), 'P0058');
  perform pg_temp.expect('s5.11 deleting a deleted patient''s result is refused',
    pg_temp.state_of(format($q$delete from public.results where id = %L$q$, rd)), 'P0058');
  perform pg_temp.expect('s5.12 unlinking (junction delete) is refused',
    pg_temp.state_of(format($q$delete from public.result_test_requests where result_id = %L$q$, rd)), 'P0058');

  -- Mismatched references (Codex plan review P1-1): every reference is locked and asserted.
  perform pg_temp.expect('s5.13 linking an ACTIVE patient''s test to a DELETED patient''s result is refused',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, rd, ta3)), 'P0058');
  perform pg_temp.expect('s5.14 an amendment naming an active test but a deleted patient''s result is refused',
    pg_temp.state_of(format($q$insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by, prior_uploaded_at, reason, amended_by, amendment_seq) values (%L, %L, 'x', %L, now(), 'x', %L, 9)$q$, rd, ta, k_med, k_med)), 'P0058');
  perform pg_temp.expect('s5.15 an alert naming an active test + patient but a deleted patient''s result is refused',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id) values (%L, %L, %L, 'low', 'LK param', %L)$q$, rd, ta, prm, a)), 'P0058');
  perform pg_temp.expect('s5.16 an alert on an active result + test but patient_id = the deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id) values (%L, %L, %L, 'low', 'LK param', %L)$q$, ra, ta, prm, d)), 'P0058');
  perform pg_temp.expect('s5.17 an alert on an active result withdrawn by a DELETED patient''s amendment is refused',
    pg_temp.state_of(format($q$insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name, patient_id, withdrawn_by_amendment) values (%L, %L, %L, 'low', 'LK param', %L, %L)$q$, ra, ta, prm, a, am_d)), 'P0058');

  -- The same Codex case through the real client path: an authenticated admin
  -- under RLS (0151's admin manage policy on the junction).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', k_admin)::text, true);
  perform set_config('request.jwt.claim.sub', k_admin::text, true);
  perform pg_temp.expect('s5.18 authenticated admin: active test → deleted patient''s result is refused',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, rd, ta3)), 'P0058');
  perform pg_temp.expect('s5.19 authenticated admin CONTROL: active test → an unlinked result',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, r_new, ta3)), 'ok');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- One patient per result.
  perform pg_temp.expect('s5.20 linking another ACTIVE patient''s test to a result is refused (one patient per result)',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, r_b, ta4)), '23514');
  perform pg_temp.expect('s5.21 CONTROL a second test of the SAME patient joins the result',
    pg_temp.state_of(format($q$insert into public.result_test_requests (result_id, test_request_id) values (%L, %L)$q$, ra, ta4)), 'ok');

  -- 0179 follow-up bookkeeping on a deleted patient's amendment: allowed; anything else refused.
  perform pg_temp.expect('s5.22 marking a deleted patient contacted about a correction is allowed',
    pg_temp.state_of(format($q$update public.result_amendments set patient_contacted_at = now(), patient_contacted_by = %L where id = %L$q$, k_med, am_d)), 'ok');
  perform pg_temp.expect('s5.23 recording a notice outcome is allowed',
    pg_temp.state_of(format($q$update public.result_amendments set patient_notified_at = now(), patient_notified_channels = '{}', patient_notify_error = 'skipped' where id = %L$q$, am_d)), 'ok');
  perform pg_temp.expect('s5.24 changing the amendment''s reason is refused',
    pg_temp.state_of(format($q$update public.result_amendments set reason = 'x', patient_contacted_at = now() where id = %L$q$, am_d)), 'P0058');

  -- Membership lock modes (Codex plan review P1-2).
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into r_un;
  s0 := pg_temp.held_results('ShareLock');
  insert into public.result_values (result_id, parameter_id, numeric_value_si) values (r_un, prm, 5);
  perform pg_temp.expect('s5.25 a value on an UNLINKED result still takes the SHARED membership lock',
    (pg_temp.held_results('ShareLock') - s0)::text, '1');
  x0 := pg_temp.held_results('ExclusiveLock');
  insert into public.result_test_requests (result_id, test_request_id)
    values (r_un, pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184'));
  perform pg_temp.expect('s5.26 a link takes the EXCLUSIVE membership lock',
    (pg_temp.held_results('ExclusiveLock') - x0)::text, '1');
  perform pg_temp.expect('s5.27 CONTROL an active patient''s amendment reason can still change',
    pg_temp.state_of(format($q$update public.result_amendments set reason = 'y' where id = %L$q$, am_a)), 'ok');
end
$s5$;
```
Run: expect `s5.3 FAILED: got [ok]`. (If a `result_values` trigger refuses a value on an UNLINKED result, s5.25 inserts the value after linking instead and counts the shared lock on a SECOND value for another unlinked result via `results` UPDATE — the point is that an unlinked result's writer takes the shared membership lock.)

- [ ] **Step 2: Add the triggers.**

```sql
-- The results family. results has no patient FK (0051): its patients are
-- whoever its result_test_requests rows point at; an unlinked row is inert.
drop trigger if exists a_lifecycle_guard on public.results;
create trigger a_lifecycle_guard
  before insert or update or delete on public.results
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.result_test_requests;
create trigger a_lifecycle_guard
  before insert or update or delete on public.result_test_requests
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.result_values;
create trigger a_lifecycle_guard
  before insert or update or delete on public.result_values
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.result_amendments;
create trigger a_lifecycle_guard
  before insert or update or delete on public.result_amendments
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.critical_alerts;
create trigger a_lifecycle_guard
  before insert or update or delete on public.critical_alerts
  for each row execute function public.enforce_patient_activity();
```

- [ ] **Step 3: Apply, run — PASS** (s1–s5). Run `0172_result_edit_commit_smoke.sql` and the 0179 smoke (`supabase/tests/0179_*_smoke.sql` if present) — must stay green (active patients only).

- [ ] **Step 4: Mutation checks** (each must FAIL, then restore + re-apply): (a) in the guard, pass `false` instead of the exclusive expression to `lifecycle_lock_results` → s5.26 fails; (b) delete step (d) (one patient per result) → s5.20 fails; (c) drop the `result_id` term from the `critical_alerts` branch of `lifecycle_patients_of_row` → s5.15 fails; (d) drop the `result_amendments` follow-up exception → s5.22 fails. The race half of the membership protocol is proven in Task 16 (`membership_*` races).

- [ ] **Step 5: Commit** — `feat(db): lifecycle guard on the results family — membership lock, every reference, one patient per result (0184 part 5)`.

---

### Task 7: Guards on HMO claim items, allocations, resolutions and doctor PF entries (+ mixed batch)

**Files:** migration, 0184 smoke.

- [ ] **Step 1: Add smoke section s6 (fails).**

```sql
-- --- s6: HMO + PF guards, mixed batch ---------------------------------------------
do $s6$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S6A');   -- active, open item
  d  uuid := pg_temp.mk_patient('S6D');   -- deleted, SETTLED item in the same batch
  va uuid; vd uuid; ta uuid; td uuid; td_un uuid;
  bat uuid; bat2 uuid; ia uuid; id_ uuid; id_un uuid;
  pay_d uuid; alloc_d uuid; pf_d uuid; pay_a uuid;
  phys uuid; disb uuid;
begin
  va := pg_temp.mk_visit(a, true);
  vd := pg_temp.mk_visit(d, true);
  ta := pg_temp.mk_line(va, 'released', 1000);
  td := pg_temp.mk_line(vd, 'released', 1000);
  td_un := pg_temp.mk_line(vd, 'released', 500);
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted') returning id into bat;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bat, ta, 1000) returning id into ia;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bat, td, 1000) returning id into id_;
  -- d's item: settled (paid 1000).
  pay_d := pg_temp.mk_pay(vd, 1000, 'hmo');
  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (pay_d, id_, 1000) returning id into alloc_d;
  -- d's second item sits in a VOIDED batch (the reopen case).
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted') returning id into bat2;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bat2, td_un, 500) returning id into id_un;
  update public.hmo_claim_batches set voided_at = now(), voided_by = k_admin, void_reason = 'smoke', status = 'voided' where id = bat2;
  insert into public.physicians (slug, full_name, specialty) values ('lk-smoke-doc', 'LK Smoke Doc', 'General')
    returning id into phys;
  insert into public.doctor_pf_entries (test_request_id, physician_id, pf_php, recognition_basis, recognized_at)
    values (td, phys, 100, 'cash_at_release', now())
    returning id into pf_d;
  perform pg_temp.kill(d);

  -- Mixed batch: settling ACTIVE a's item succeeds although deleted d's settled item shares the batch.
  pay_a := pg_temp.mk_pay(va, 1000, 'hmo');
  perform pg_temp.expect('s6.1 mixed batch: settling the active patient''s item succeeds',
    pg_temp.state_of(format($q$insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (%L, %L, 1000)$q$, pay_a, ia)), 'ok');
  perform pg_temp.expect('s6.2 …and the batch rolled up (recompute touched only batches + a''s item)',
    (select status from public.hmo_claim_batches where id = bat), 'paid');

  perform pg_temp.expect('s6.3 voiding the deleted patient''s allocation is refused (reopens a settled balance)',
    pg_temp.state_of(format($q$update public.hmo_payment_allocations set voided_at = now(), voided_by = %L, void_reason = 'x' where id = %L$q$, k_admin, alloc_d)), 'P0058');
  perform pg_temp.expect('s6.4 a resolution on the deleted patient''s item is refused',
    pg_temp.state_of(format($q$insert into public.hmo_claim_resolutions (item_id, destination, amount_php, resolved_by) values (%L, 'write_off', 1, %L)$q$, id_, k_admin)), 'P0058');
  perform pg_temp.expect('s6.5 editing the deleted patient''s claim item is refused',
    pg_temp.state_of(format($q$update public.hmo_claim_items set hmo_response = 'paid' where id = %L$q$, id_)), 'P0058');
  perform pg_temp.expect('s6.6 reopening a voided batch that holds a deleted patient''s item is refused (nested write checked)',
    pg_temp.state_of(format($q$update public.hmo_claim_batches set voided_at = null, voided_by = null, void_reason = null, status = 'submitted' where id = %L$q$, bat2)), 'P0058');
  perform pg_temp.expect('s6.7 …and the batch stayed voided',
    (select (voided_at is not null)::text from public.hmo_claim_batches where id = bat2), 'true');

  -- doctor_pf_entries: linking a disbursement is allowed; anything else is refused.
  insert into public.doctor_pf_disbursements (batch_number, physician_id, posted_date, method, total_php, recorded_by)
    values ((select coalesce(max(batch_number), 0) + 1 from public.doctor_pf_disbursements),
            phys, (now() at time zone 'Asia/Manila')::date, 'cash', 100, k_admin)
    returning id into disb;
  perform pg_temp.expect('s6.8 paying the doctor (disbursement link) is allowed',
    pg_temp.state_of(format($q$update public.doctor_pf_entries set disbursement_id = %L where id = %L$q$, disb, pf_d)), 'ok');
  perform pg_temp.expect('s6.9 voiding the PF entry is refused',
    pg_temp.state_of(format($q$update public.doctor_pf_entries set voided_at = now(), voided_by = %L, void_reason = 'x' where id = %L$q$, k_admin, pf_d)), 'P0058');
  -- Mismatched references (Codex plan review P1-1): a PF entry for an ACTIVE
  -- patient's test that points at a DELETED patient's HMO allocation.
  perform pg_temp.expect('s6.10 a PF entry whose allocation belongs to a deleted patient is refused',
    pg_temp.state_of(format($q$insert into public.doctor_pf_entries (test_request_id, physician_id, pf_php, recognition_basis, recognized_at, hmo_allocation_id) values (%L, %L, 10, 'hmo_at_settlement', now(), %L)$q$, ta, phys, alloc_d)), 'P0058');
  perform pg_temp.expect('s6.11 an allocation of an ACTIVE item to a deleted patient''s payment is refused',
    pg_temp.state_of(format($q$insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (%L, %L, 1)$q$, pay_d, ia)), 'P0058');
end
$s6$;
```
Fixture facts (local, 2026-09-25): `doctor_pf_disbursements` requires `batch_number, physician_id, posted_date, method ∈ (cash, gcash, bank_transfer), total_php ≠ 0, recorded_by`; `doctor_pf_entries.recognition_basis ∈ (cash_at_release, hmo_at_settlement, clawback)`; `physicians` requires `slug, full_name, specialty`. If a trigger on `doctor_pf_disbursements` insists on more (e.g. a posted JE), copy the extra columns from the insert in `src/lib/actions/accounting/pf-disbursements.ts:67` — the assertion under test is the `doctor_pf_entries` update, not the disbursement row.
Run: expect `s6.3 FAILED: got [ok]`.

- [ ] **Step 2: Add the triggers.**

```sql
-- HMO sub-ledger rows and doctor PF entries (via test_request / item / payment).
-- hmo_claim_batches is NOT guarded: a batch holds many patients, and
-- recompute_hmo_batch_status only ever writes batches. A reopen that would
-- un-void an inactive patient's item fails in that item's guard.
drop trigger if exists a_lifecycle_guard on public.hmo_claim_items;
create trigger a_lifecycle_guard
  before insert or update or delete on public.hmo_claim_items
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.hmo_payment_allocations;
create trigger a_lifecycle_guard
  before insert or update or delete on public.hmo_payment_allocations
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.hmo_claim_resolutions;
create trigger a_lifecycle_guard
  before insert or update or delete on public.hmo_claim_resolutions
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.doctor_pf_entries;
create trigger a_lifecycle_guard
  before insert or update or delete on public.doctor_pf_entries
  for each row execute function public.enforce_patient_activity();
```

- [ ] **Step 3: Apply, run — PASS** (s1–s6). Re-run `0147_hmo_claim_delete_guard_smoke.sql` and `0030_op_gl_bridge_smoke.sql`: green.

- [ ] **Step 4: Mutation check.** Temporarily comment out the `doctor_pf_entries` exception: s6.8 must FAIL. Restore.

- [ ] **Step 5: Commit** — `feat(db): lifecycle guard on HMO sub-ledger and PF entries (0184 part 6)`.

---
### Task 8: Existing RPCs take the lifecycle lock before their row locks

`result_save_draft`, `result_finalise_commit`, `result_edit_commit`, `correct_payment` lock their target row first today; `appointments_insert_slot_guarded` takes a slot lock first. The guard triggers inside them would then take the advisory lock *after* a row lock — the order that can deadlock with a delete. Each is re-created to: resolve its patient set with a plain read → `lifecycle_lock_and_assert` → its existing row/slot lock → re-resolve (P0072 if the set moved). NULLs are dropped from the pre-acquired set so each function's own not-found message still wins; the triggers still fail closed.

**Files:** migration (section (4)), 0184 smoke.

- [ ] **Step 1: Add smoke section s7 (fails).**

```sql
-- --- s7: existing RPCs lock the patient first ---------------------------------------
do $s7$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  k_med   constant uuid := 'a2000000-0000-4000-8000-000000000184';
  a  uuid := pg_temp.mk_patient('S7A');
  d  uuid := pg_temp.mk_patient('S7D');
  va uuid; vd uuid; td uuid; td2 uuid; rd uuid; rd2 uuid; pd uuid; att uuid := gen_random_uuid();
  f  text;
  def text;
  lp int; rp int; mp int;
  res jsonb;
begin
  -- Text order: the lifecycle call comes before the first FOR UPDATE / slot
  -- lock. BOTH positions must be > 0: position() returns 0 for a missing call,
  -- and 0 < n would pass (Codex plan review P3).
  foreach f in array array[
    'public.result_save_draft(uuid,jsonb)',
    'public.result_finalise_commit(uuid,uuid,jsonb,text,integer,timestamp with time zone,jsonb,jsonb)',
    'public.result_edit_commit(uuid,uuid,integer,uuid,text,uuid,text,integer,jsonb,jsonb,jsonb)',
    'public.correct_payment(uuid,numeric,text,text,text,text,uuid,uuid,jsonb)']
  loop
    def := lower(pg_get_functiondef(f::regprocedure));
    lp := position('lifecycle_lock_and_assert' in def);
    rp := position('for update' in def);
    perform pg_temp.expect('s7.1 lock before row lock: ' || f, (lp > 0 and rp > 0 and lp < rp)::text, 'true');
    -- The three result RPCs take the membership lock before the patient lock.
    if f like 'public.result_%' then
      mp := position('lifecycle_lock_results' in def);
      perform pg_temp.expect('s7.1m membership lock before patient lock: ' || f, (mp > 0 and lp > 0 and mp < lp)::text, 'true');
    end if;
  end loop;
  def := pg_get_functiondef('public.appointments_insert_slot_guarded(jsonb,uuid,timestamp with time zone,boolean)'::regprocedure);
  lp := position('lifecycle_lock_and_assert' in def);
  rp := position('appt_slot:' in def);
  perform pg_temp.expect('s7.2 lock before slot lock: appointments_insert_slot_guarded', (lp > 0 and rp > 0 and lp < rp)::text, 'true');

  -- Behaviour on a deleted patient.
  va := pg_temp.mk_visit(a);
  vd := pg_temp.mk_visit(d);
  td := pg_temp.mk_line(vd, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  td2 := pg_temp.mk_line(vd, 'released', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  insert into public.results (generation_kind, uploaded_by) values ('structured', k_med) returning id into rd;
  insert into public.result_test_requests (result_id, test_request_id) values (rd, td);
  insert into public.results (generation_kind, uploaded_by, storage_path, file_size_bytes, finalised_at)
    values ('structured', k_med, 'x/y.pdf', 10, now()) returning id into rd2;
  insert into public.result_test_requests (result_id, test_request_id) values (rd2, td2);
  -- A committed edit attempt recorded BEFORE the delete (for the replay case).
  insert into public.result_amendments (result_id, test_request_id, prior_storage_path, prior_uploaded_by,
                                        prior_uploaded_at, reason, amended_by, amendment_seq, attempt_id, commit_outcome)
    values (rd2, td2, 'x/old.pdf', k_med, now(), 'smoke edit', k_med, 1, att,
            jsonb_build_object('alerts_added', '[]'::jsonb, 'alerts_removed', 0, 'alerts_kept_acknowledged', 0));
  pd := pg_temp.mk_pay(vd, 50);
  perform pg_temp.kill(d);

  perform pg_temp.expect('s7.3 result_save_draft on a deleted patient',
    pg_temp.state_of(format($q$select public.result_save_draft(%L, '[]'::jsonb)$q$, rd)), 'P0058');
  perform pg_temp.expect('s7.4 result_finalise_commit on a deleted patient',
    pg_temp.state_of(format($q$select public.result_finalise_commit(%L, %L, '[]'::jsonb, 'p.pdf', 1, now(), null, '[]'::jsonb)$q$, rd, k_med)), 'P0058');
  perform pg_temp.expect('s7.5 result_edit_commit (new attempt) on a deleted patient',
    pg_temp.state_of(format($q$select public.result_edit_commit(%L, %L, 1, %L, 'a long enough reason', %L, 'n.pdf', 1, null, null, null)$q$, gen_random_uuid(), rd2, k_med, td2)), 'P0058');
  res := public.result_edit_commit(att, rd2, 0, k_med, 'smoke edit', td2, 'n.pdf', 1, null, null, null);
  perform pg_temp.expect('s7.6 …but a REPLAY of an attempt that already committed still answers',
    (res ->> 'replayed'), 'true');
  perform pg_temp.expect('s7.7 correct_payment on a deleted patient',
    pg_temp.state_of(format($q$select public.correct_payment(%L, 40, 'cash', null, null, 'smoke fix', %L)$q$, pd, k_admin)), 'P0058');
  perform pg_temp.expect('s7.8 correct_payment moving money ONTO a deleted patient''s visit',
    pg_temp.state_of(format($q$select public.correct_payment(%L, 10, 'cash', null, null, 'move', %L, %L)$q$,
      pg_temp.mk_pay(va, 10), k_admin, vd)), 'P0058');
  perform pg_temp.expect('s7.9 correct_payment on a missing payment keeps its own message (P0054)',
    pg_temp.state_of(format($q$select public.correct_payment(%L, 1, 'cash', null, null, 'x', %L)$q$, gen_random_uuid(), k_admin)), 'P0054');
  perform pg_temp.expect('s7.10 appointments_insert_slot_guarded for a deleted patient',
    pg_temp.state_of(format($q$select public.appointments_insert_slot_guarded(jsonb_build_array(jsonb_build_object('patient_id', %L, 'status', 'confirmed', 'scheduled_at', (now() + interval '1 day')::text)))$q$, d)), 'P0058');
  perform pg_temp.expect('s7.11 CONTROL walk-in through the same RPC',
    pg_temp.state_of($q$select public.appointments_insert_slot_guarded(jsonb_build_array(jsonb_build_object('walk_in_name', 'W', 'status', 'confirmed', 'scheduled_at', (now() + interval '1 day')::text)))$q$), 'ok');
  perform pg_temp.expect('s7.12 CONTROL active patient through the same RPC',
    pg_temp.state_of(format($q$select public.appointments_insert_slot_guarded(jsonb_build_array(jsonb_build_object('patient_id', %L, 'status', 'confirmed', 'scheduled_at', (now() + interval '1 day')::text)))$q$, a)), 'ok');
end
$s7$;
```
Run: expect `s7.1 … FAILED`. (If s7.6's argument list does not match 0176's validation order, read 0176 lines 224–300: the replay branch returns before any argument validation, so any values pass.)

- [ ] **Step 2: Add section (4) to the migration.** Header:

```sql
-- ---------------------------------------------------------------------------
-- (4) Existing RPCs take the lifecycle lock BEFORE their own row/slot lock.
-- Each body is copied verbatim from its latest migration; the only changes
-- are the lines marked "-- 0184:". NULLs are dropped from the pre-acquired set
-- so each function's own not-found error still wins (its guard triggers still
-- fail closed). After the row lock the set is resolved again: a record that
-- moved to another patient while we waited raises P0072 (retry once).
-- ---------------------------------------------------------------------------
```

  **(4a) `result_save_draft`** — copy `0172_result_edit_commit.sql` lines 571–613, then:
  - in `declare`, add `  v_patients uuid[];  -- 0184`
  - immediately after `begin`, insert:
```sql
  -- 0184: the result-membership lock (shared), then the patient lifecycle
  -- lock, before the result row lock.
  perform public.lifecycle_lock_results(array[p_result_id], false);
  v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null));
  perform public.lifecycle_lock_and_assert(v_patients, false);
```
  - immediately after the `if not found then raise exception 'result not found' … end if;` that follows the row lock, insert:
```sql
  -- 0184: the result's patients must still be the ones we locked.
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null))
       is distinct from v_patients then
    raise exception 'the patient on this result changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;
```
  then copy its `revoke`/`grant` (0172 lines 614–615).

  **(4b) `result_finalise_commit`** — copy 0172 lines 437–562 and its `revoke`/`grant` (563–568). Same three edits as (4a) (declare `v_patients uuid[];`, the lock block after `begin`, the P0072 block after the row lock's not-found check).

  **(4c) `result_edit_commit`** — copy **`0179_result_copy_followups.sql`** (merged, #239 — it is 0176's body plus three `-- 0179` hunks): the `create or replace function public.result_edit_commit(` statement at line 56 through its closing `$$;`, and its `revoke`/`grant` (~342–347). Keep the three `-- 0179` hunks byte-for-byte (`result-copy-followups-migration.test.ts` pins them — run it after). Edits:
  - declare: `  v_patients uuid[];  -- 0184` and `  v_replay_first boolean;  -- 0184`
  - immediately after `begin`, insert:
```sql
  -- 0184: a replay of an attempt that already committed writes nothing, so it
  -- must still answer after the patient was deleted (the app would otherwise
  -- treat the rejection as final and remove the committed PDF). Only a NEW
  -- attempt takes the lifecycle lock — before the result row lock.
  v_replay_first := exists (select 1 from public.result_amendments a where a.attempt_id = p_attempt_id);
  if not v_replay_first then
    perform public.lifecycle_lock_results(array[p_result_id], false);
    v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null));
    perform public.lifecycle_lock_and_assert(v_patients, false);
  end if;
```
  - immediately after the replay branch's closing `end if;` (the `if found then … return … end if;` under "2) Replay", before "3) Editable?"), insert:
```sql
  -- 0184: the pre-check saw a committed attempt, but it is gone now (its
  -- result was deleted in between). Nothing to replay and no lock was taken.
  if v_replay_first then
    raise exception 'this edit could not be confirmed — reload the result to check it'
      using errcode = 'P0066';
  end if;
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null))
       is distinct from v_patients then
    raise exception 'the patient on this result changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;
```

  **(4d) `correct_payment`** — copy `0174_correct_payment_stale_guard.sql` lines 48–187, changing `create function` to `create or replace function` (same signature, so the 0174 ACL is kept), and its `comment`/`revoke`/`grant` (192–198). Edits:
  - declare: `  v_patients uuid[];  -- 0184`
  - immediately before `  select * into v_old` (after the two P0054 argument checks), insert:
```sql
  -- 0184: lifecycle locks — the payment's patient and, for a move, the target
  -- visit's — before the payment row lock.
  v_patients := public.lifecycle_norm(array_remove(
                  public.lifecycle_patients_of_payments(array[p_payment_id])
                  || case when p_visit_id is null then '{}'::uuid[]
                          else public.lifecycle_patients_of_visits(array[p_visit_id]) end,
                  null));
  perform public.lifecycle_lock_and_assert(v_patients, false);
```
  - immediately after the `if v_old.voided_at is not null then … end if;` block, insert:
```sql
  -- 0184: still the same patients?
  if public.lifecycle_norm(array_remove(
       public.lifecycle_patients_of_payments(array[p_payment_id])
       || case when p_visit_id is null then '{}'::uuid[]
               else public.lifecycle_patients_of_visits(array[p_visit_id]) end,
       null)) is distinct from v_patients then
    raise exception 'the patient on this payment changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;
```
  If 0183 (`feat/waived-balance-gl`) is on main by now, copy ITS `correct_payment` and apply the same edits.

  **(4e) `appointments_insert_slot_guarded`** — copy `0154_website_messages_inbox.sql` lines 213–269 and its `revoke`/`grant` (273–276). One edit — immediately after `begin`, insert:
```sql
  -- 0184: every named patient's lifecycle lock (shared, sorted) BEFORE the slot
  -- lock, refusing an inactive patient before anything is inserted. A walk-in
  -- row (no patient_id) names nobody.
  perform public.lifecycle_lock_and_assert(
    array(select distinct nullif(e.elem ->> 'patient_id', '')::uuid
            from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as e(elem)
           where nullif(e.elem ->> 'patient_id', '') is not null),
    false);
```
  (The alias is `e(elem)`, not `r` — the function already declares a plpgsql variable `r`, and an alias of the same name is an ambiguity error.)

- [ ] **Step 3: Apply, run — PASS** (s1–s7). Re-run `0172_result_edit_commit_smoke.sql`, `0161_payment_correction_smoke.sql`, `0174_correct_payment_stale_guard_smoke.sql`: green (behaviour on active patients unchanged).

- [ ] **Step 4: Mutation checks.** (a) Remove the `if not v_replay_first then` wrapper in (4c) (lock always): s7.6 must FAIL with P0058. (b) Delete the `perform public.lifecycle_lock_and_assert(v_patients, false);` line from `correct_payment`: s7.1 for correct_payment must FAIL (lp = 0) — before the P3 fix it silently passed. (c) Move `lifecycle_lock_results` below the patient lock in `result_save_draft`: s7.1m must FAIL. Restore each, re-apply, PASS.

- [ ] **Step 5: Commit** — `feat(db): result/payment/booking RPCs take the patient lock before row locks (0184 part 7)`.

---

### Task 9: `resolve_patient_guarded` — case-insensitive, locked, re-read

**Files:** migration (section (5)), 0184 smoke.

- [ ] **Step 1: Add smoke section s8 (fails).**

```sql
-- --- s8: resolve_patient_guarded ---------------------------------------------------
do $s8$
declare
  old_p uuid; new_p uuid; d uuid;
  r record;
  s0 int;
  fields jsonb := jsonb_build_object('first_name', 'Smoke', 'last_name', 'Lks8', 'birthdate', '1990-01-01',
                                     'email', 'lks8@example.test');
begin
  insert into public.patients (drm_id, first_name, last_name, birthdate, email, created_at)
    values ('DRM-LKS8OLD', 'Smoke', 'Lks8', '1990-01-01', 'lks8@example.test', now() - interval '2 days')
    returning id into old_p;
  insert into public.patients (drm_id, first_name, last_name, birthdate, email, created_at)
    values ('DRM-LKS8NEW', 'Smoke', 'Lks8', '1990-01-01', 'lks8@example.test', now() - interval '1 day')
    returning id into new_p;

  s0 := pg_temp.held('ShareLock');
  select * into r from public.resolve_patient_guarded('LKS8@example.test', 'Lks8', '1990-01-01', fields);
  perform pg_temp.expect('s8.1 reuses the OLDEST active candidate', (r.id = old_p and r.reused)::text, 'true');
  perform pg_temp.expect('s8.2 …holding its lifecycle lock (shared)', (pg_temp.held('ShareLock') - s0 >= 1)::text, 'true');
  select * into r from public.resolve_patient_guarded('lks8@example.test', 'LKS8', '1990-01-01', fields);
  perform pg_temp.expect('s8.3 last name matches case-insensitively', (r.id = old_p)::text, 'true');

  perform pg_temp.kill(old_p);
  select * into r from public.resolve_patient_guarded('lks8@example.test', 'Lks8', '1990-01-01', fields);
  perform pg_temp.expect('s8.4 a deleted candidate is skipped', (r.id = new_p)::text, 'true');
  perform pg_temp.kill(new_p);
  select * into r from public.resolve_patient_guarded('lks8@example.test', 'Lks8', '1990-01-01', fields);
  perform pg_temp.expect('s8.5 no active candidate → a FRESH record', (not r.reused and r.id not in (old_p, new_p))::text, 'true');

  perform pg_temp.expect('s8.6 search_path is empty (superset of 0170)',
    (select proconfig::text from pg_proc where oid = 'public.resolve_patient_guarded(text,text,date,jsonb)'::regprocedure),
    '{search_path=""}');
  perform pg_temp.expect('s8.7 still stamps app.referral_origin (0170 compatibility)',
    (pg_get_functiondef('public.resolve_patient_guarded(text,text,date,jsonb)'::regprocedure) like '%app.referral_origin%')::text, 'true');
  perform pg_temp.expect('s8.8 EXECUTE service_role only',
    (has_function_privilege('service_role', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute'))::text, 'true');
end
$s8$;
```
(The P0072 branch — a candidate deleted while the resolver waits — needs two connections: Task 16 `resolve_blocked_behind_delete`.) Run: expect `s8.1` or `s8.3 FAILED`.

- [ ] **Step 2: Add section (5).** If 0170 is on main, first diff its `resolve_patient_guarded` against the body below and carry over anything else it adds.

```sql
-- ---------------------------------------------------------------------------
-- (5) resolve_patient_guarded — 0167's body (lines 901-944) plus:
--   * last name matched case-insensitively (owner, 2026-09-25; prod had zero
--     active case-variant groups). The identity lock key already lowercased.
--   * the OLDEST active candidate (created_at, id), deterministic.
--   * the candidate's lifecycle lock (shared) and a fresh re-read of activity
--     AND the triple; if either changed while we waited → P0072, and the app
--     retries once in a fresh transaction (never a second lifecycle lock here:
--     a new candidate's key may sort below one already held).
--   * search_path '' and app.referral_origin = 'patient' around the insert —
--     a superset of 0170 (sheet-sync), so either may land first.
-- The identity advisory lock stays FIRST with the key unchanged since 0158.
-- Delete/restore never take identity locks, so this order cannot invert.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_patient_guarded(
  p_email text, p_last_name text, p_birthdate date, p_fields jsonb
)
returns table (id uuid, drm_id text, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform pg_advisory_xact_lock(
    hashtext('patient_resolve:' || lower(p_email) || ':' || lower(p_last_name) || ':' || p_birthdate::text)
  );
  select p.id, p.drm_id into v
    from public.patients p
   where p.email = lower(p_email)
     and lower(p.last_name) = lower(p_last_name)
     and p.birthdate = p_birthdate
     and p.deleted_at is null
     and p.merged_into_id is null
   order by p.created_at, p.id
   limit 1;
  if found then
    perform public.lifecycle_lock(array[v.id], false);
    perform 1
      from public.patients p
     where p.id = v.id
       and p.email = lower(p_email)
       and lower(p.last_name) = lower(p_last_name)
       and p.birthdate = p_birthdate
       and p.deleted_at is null
       and p.merged_into_id is null;
    if not found then
      raise exception 'this patient record changed while the booking was being saved — try again'
        using errcode = 'P0072';
    end if;
    return query select v.id, v.drm_id, true;
    return;
  end if;
  perform pg_catalog.set_config('app.referral_origin', 'patient', true);
  return query
  insert into public.patients (
    first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered,
    referral_source
  ) values (
    p_fields->>'first_name', p_fields->>'last_name', nullif(p_fields->>'middle_name',''),
    (p_fields->>'birthdate')::date,
    nullif(p_fields->>'sex',''),
    nullif(p_fields->>'phone',''), lower(p_email), nullif(p_fields->>'address',''),
    true,
    (select rs.id from public.referral_sources rs where rs.id = nullif(p_fields->>'referral_source',''))
  ) returning patients.id, patients.drm_id, false;
  perform pg_catalog.set_config('app.referral_origin', '', true);
end;
$$;

revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
revoke execute on function public.resolve_patient_guarded(text, text, date, jsonb) from anon, authenticated;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;
```

- [ ] **Step 3: Apply, run — PASS** (s1–s8). Run `npx vitest run src/lib/patients/active-views.test.ts` — it reads the LATEST definition of `resolve_patient_guarded` and must still find both active predicates. If it pins other text of 0167's body (e.g. `p.last_name = p_last_name`), update that expectation to the case-insensitive form and say so in the commit message.

- [ ] **Step 4: Commit** — `feat(db): resolver matches last name case-insensitively and re-reads under the lifecycle lock (0184 part 8)`.

---
### Task 10: `create_visit_encounter` — the whole encounter in one transaction

Replaces `createOneVisit` ×1–2 + the PIN insert + the `pre_registered` clear + the audits, and the `deleteVisitCascade` compensation disappears. Pricing, discounts, the doctor-fee split and package decomposition stay in TypeScript (they are reads) and arrive as rows; the RPC re-checks the actor, the shape and each visit's total, takes the patient lock, and writes everything.

**Payload contract** (built by Task 18's `buildEncounterPayload`):

```jsonc
// p_visits: 1 element (no split) or 2 (doctor half first, then lab half)
[{
  "visit": { "total_php": 1500, "notes": null, "hmo_provider_id": null, "hmo_approval_date": null,
             "hmo_authorization_no": null, "attending_physician_id": null, "is_sample": false },
  "lines": [   // every test_requests row, client-minted ids; components reference their header
    { "id": "…", "service_id": "…", "base_price_php": 1500, "discount_kind": null, "discount_amount_php": 0,
      "final_price_php": 1500, "hmo_provider_id": null, "hmo_approval_date": null, "hmo_authorization_no": null,
      "receptionist_remarks": null, "clinic_fee_php": null, "doctor_pf_php": null,
      "procedure_description": null, "hmo_approved_amount_php": null,
      "parent_id": null, "is_package_header": true, "status": "in_progress" }
  ]
}]
```

**Files:** migration (section (6)), 0184 smoke.

- [ ] **Step 1: Add smoke section s9 (fails).**

```sql
-- --- s9: create_visit_encounter ------------------------------------------------------
create function pg_temp.enc_line(id uuid, svc uuid, price numeric, parent uuid, header boolean, status text)
returns jsonb language sql as $f$
  select jsonb_build_object('id', id, 'service_id', svc, 'base_price_php', price, 'discount_kind', null,
    'discount_amount_php', 0, 'final_price_php', price, 'hmo_provider_id', null, 'hmo_approval_date', null,
    'hmo_authorization_no', null, 'receptionist_remarks', null, 'clinic_fee_php', null, 'doctor_pf_php', null,
    'procedure_description', null, 'hmo_approved_amount_php', null, 'parent_id', parent,
    'is_package_header', header, 'status', status);
$f$;
create function pg_temp.enc_visit(total numeric, lines jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('visit', jsonb_build_object('total_php', total, 'notes', null, 'hmo_provider_id', null,
    'hmo_approval_date', null, 'hmo_authorization_no', null, 'attending_physician_id', null, 'is_sample', false),
    'lines', lines);
$f$;
do $grant9$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', f);
  end loop;
end
$grant9$;

do $s9$
declare
  k_rec  constant uuid := 'a1000000-0000-4000-8000-000000000184';
  k_med  constant uuid := 'a2000000-0000-4000-8000-000000000184';
  k_pkg  constant uuid := 'c2000000-0000-4000-8000-000000000184';
  k_lab  constant uuid := 'c0000000-0000-4000-8000-000000000184';
  k_lab2 constant uuid := 'c1000000-0000-4000-8000-000000000184';
  k_con  constant uuid := 'c3000000-0000-4000-8000-000000000184';
  hash   constant text := '$2a$12$' || repeat('a', 53);
  a uuid := pg_temp.mk_patient('S9A');
  pr uuid := pg_temp.mk_patient('S9P');
  d uuid := pg_temp.mk_patient('S9D');
  h uuid := gen_random_uuid();
  g uuid := gen_random_uuid();
  one jsonb; res jsonb; vid uuid; n int;
begin
  one := pg_temp.enc_visit(1900, jsonb_build_array(
    pg_temp.enc_line(h, k_pkg, 1500, null, true, 'in_progress'),
    pg_temp.enc_line(gen_random_uuid(), k_lab, 400, null, false, 'requested'),
    pg_temp.enc_line(gen_random_uuid(), k_lab, 0, h, false, 'requested'),
    pg_temp.enc_line(gen_random_uuid(), k_lab2, 0, h, false, 'requested')));
  res := public.create_visit_encounter(k_rec, a, hash, jsonb_build_array(one), null, '{"ip":"203.0.113.5","user_agent":"smoke"}');
  vid := (res -> 'visits' -> 0 ->> 'id')::uuid;
  perform pg_temp.expect('s9.1 one visit created', jsonb_array_length(res -> 'visits')::text, '1');
  perform pg_temp.expect('s9.2 four bill lines', (select count(*)::text from public.test_requests where visit_id = vid), '4');
  perform pg_temp.expect('s9.3 package header auto-promoted (0040)',
    (select status from public.test_requests where id = h), 'ready_for_release');
  perform pg_temp.expect('s9.4 total and creator recorded',
    (select total_php::text || '|' || created_by::text from public.visits where id = vid), '1900.00|' || k_rec);
  perform pg_temp.expect('s9.5 one PIN row with the given hash',
    (select count(*)::text from public.visit_pins where visit_id = vid and pin_hash = hash), '1');
  perform pg_temp.expect('s9.6 audits: visit.created, visit_pin.issued, package.decomposed(2 components)',
    (select string_agg(action || coalesce(':' || (metadata ->> 'component_count'), ''), ',' order by action collate "C")
       from public.audit_log where patient_id = a and action in ('visit.created', 'visit_pin.issued', 'package.decomposed')),
    'package.decomposed:2,visit.created,visit_pin.issued');
  perform pg_temp.expect('s9.7 visit.created metadata counts order lines, not components',
    (select (metadata ->> 'service_count') || '|' || (metadata ->> 'total_php')
       from public.audit_log where patient_id = a and action = 'visit.created' order by created_at limit 1), '2|1900.00');

  -- Split encounter + pre-registered patient.
  update public.patients set pre_registered = true where id = pr;
  res := public.create_visit_encounter(k_rec, pr, hash, jsonb_build_array(
    pg_temp.enc_visit(500, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_con, 500, null, false, 'requested'))),
    pg_temp.enc_visit(400, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_lab, 400, null, false, 'requested')))),
    g, null);
  perform pg_temp.expect('s9.8 split: two visits share the group id',
    (select count(*)::text from public.visits where visit_group_id = g), '2');
  perform pg_temp.expect('s9.9 split: both carry the same PIN hash',
    (select count(distinct pin_hash)::text || '|' || count(*)::text from public.visit_pins vp
       join public.visits v on v.id = vp.visit_id where v.visit_group_id = g), '1|2');
  perform pg_temp.expect('s9.10 identity verified: pre_registered cleared + audited',
    (select (not pre_registered)::text from public.patients where id = pr)
      || '|' || (select count(*)::text from public.audit_log where patient_id = pr and action = 'patient.identity_verified')
      || '|' || (res ->> 'identity_verified'), 'true|1|true');

  -- Refusals write nothing.
  perform pg_temp.kill(d);
  n := (select count(*) from public.visits where patient_id = d);
  perform pg_temp.expect('s9.11 deleted patient refused',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$, k_rec, d, hash, one)), 'P0058');
  perform pg_temp.expect('s9.12 …and nothing was written', (select count(*) from public.visits where patient_id = d)::text, n::text);
  perform pg_temp.expect('s9.13 total that does not match the lines',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$,
      k_rec, a, hash, jsonb_set(one, '{visit,total_php}', '1'))), 'P0073');
  perform pg_temp.expect('s9.14 a medtech cannot start a visit',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$, k_med, a, hash, one)), 'P0073');
  perform pg_temp.expect('s9.15 component whose header is not in the payload',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$,
      k_rec, a, hash, pg_temp.enc_visit(0, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_lab, 0, gen_random_uuid(), false, 'requested'))))), 'P0073');
  perform pg_temp.expect('s9.16 two visits without a group id',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb, %L::jsonb))$q$, k_rec, a, hash, one, one)), 'P0073');
  perform pg_temp.expect('s9.17 an unhashed PIN',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, 'ABCD2345', jsonb_build_array(%L::jsonb))$q$, k_rec, a, one)), 'P0073');
  n := (select count(*) from public.visits where patient_id = a);
  perform pg_temp.expect('s9.18 a failing SECOND visit leaves no first visit behind (atomic)',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb, %L::jsonb), %L)$q$,
      k_rec, a, hash,
      pg_temp.enc_visit(400, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_lab, 400, null, false, 'requested'))),
      pg_temp.enc_visit(400, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), gen_random_uuid(), 400, null, false, 'requested'))),
      gen_random_uuid())), '23503');
  perform pg_temp.expect('s9.19 …visit count unchanged', (select count(*) from public.visits where patient_id = a)::text, n::text);
  -- Centavo normalisation (Codex plan review P2-4): the app sums JS floats.
  n := (select count(*) from public.visits where patient_id = a);
  res := public.create_visit_encounter(k_rec, a, hash, jsonb_build_array(
    pg_temp.enc_visit(300.29999999999995, jsonb_build_array(
      pg_temp.enc_line(gen_random_uuid(), k_lab, 100.10, null, false, 'requested'),
      pg_temp.enc_line(gen_random_uuid(), k_lab2, 200.20, null, false, 'requested')))), null, null);
  vid := (res -> 'visits' -> 0 ->> 'id')::uuid;
  perform pg_temp.expect('s9.21 100.10 + 200.20 sent as the JS float 300.29999999999995 is accepted, stored 300.30',
    (select total_php::text from public.visits where id = vid), '300.30');
  res := public.create_visit_encounter(k_rec, a, hash, jsonb_build_array(
    pg_temp.enc_visit(79.99000000000001, jsonb_build_array(
      jsonb_set(jsonb_set(pg_temp.enc_line(gen_random_uuid(), k_lab, 79.99000000000001, null, false, 'requested'),
                          '{base_price_php}', '99.99'), '{discount_amount_php}', '20')))), null, null);
  vid := (res -> 'visits' -> 0 ->> 'id')::uuid;
  perform pg_temp.expect('s9.22 a discounted line whose float final is 79.99000000000001 is stored 79.99',
    (select total_php::text || '|' || (select final_price_php::text from public.test_requests where visit_id = vid)
       from public.visits where id = vid), '79.99|79.99');
  res := public.create_visit_encounter(k_rec, a, hash, jsonb_build_array(
    pg_temp.enc_visit(0.30000000000000004, jsonb_build_array(
      pg_temp.enc_line(gen_random_uuid(), k_con, 0.1, null, false, 'requested'),
      pg_temp.enc_line(gen_random_uuid(), k_con, 0.2, null, false, 'requested'))),
    pg_temp.enc_visit(100.1, jsonb_build_array(pg_temp.enc_line(gen_random_uuid(), k_lab, 100.1, null, false, 'requested')))),
    gen_random_uuid(), null);
  perform pg_temp.expect('s9.23 a split encounter with fractional totals on both halves',
    (select string_agg(total_php::text, ',' order by total_php) from public.visits
      where id in (select (x ->> 'id')::uuid from jsonb_array_elements(res -> 'visits') x)), '0.30,100.10');
  perform pg_temp.expect('s9.24 a real one-centavo mismatch is still refused',
    pg_temp.state_of(format($q$select public.create_visit_encounter(%L, %L, %L, jsonb_build_array(%L::jsonb))$q$, k_rec, a, hash,
      pg_temp.enc_visit(300.31, jsonb_build_array(
        pg_temp.enc_line(gen_random_uuid(), k_lab, 100.10, null, false, 'requested'),
        pg_temp.enc_line(gen_random_uuid(), k_lab2, 200.20, null, false, 'requested'))))), 'P0073');
  perform pg_temp.expect('s9.25 …three encounters, four visits written',
    ((select count(*) from public.visits where patient_id = a) - n)::text, '4');

  perform pg_temp.expect('s9.20 EXECUTE service_role only',
    (has_function_privilege('service_role', 'public.create_visit_encounter(uuid,uuid,text,jsonb,uuid,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.create_visit_encounter(uuid,uuid,text,jsonb,uuid,jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.create_visit_encounter(uuid,uuid,text,jsonb,uuid,jsonb)', 'execute'))::text, 'true');
end
$s9$;
```
Run: expect `function public.create_visit_encounter(...) does not exist`.

- [ ] **Step 2: Add section (6).**

```sql
-- ---------------------------------------------------------------------------
-- (6) create_visit_encounter — one transaction for what visits/new/actions.ts
-- did in 3-5 PostgREST calls plus a compensating delete: the visit(s) (two
-- sharing visit_group_id when the order has doctor AND lab lines), every
-- test_requests row (headers and standalone lines first, then package
-- components — tg_test_request_parent_is_header, 0040), one visit_pins row per
-- visit carrying the SAME bcrypt hash, the pre_registered clear, and the
-- audit rows (patient.identity_verified, visit.created, visit_pin.issued,
-- package.decomposed) — so a crash can no longer leave a visit without its
-- lines, PIN or audit trail. Prices come from the app (pure reads + TS
-- arithmetic, src/lib/visits/encounter-payload.ts); this re-checks the actor,
-- the shape and that each visit's total equals its lines. P0073 = refused
-- here (message passes through); P0058 = inactive patient.
-- ---------------------------------------------------------------------------
create or replace function public.create_visit_encounter(
  p_actor          uuid,
  p_patient_id     uuid,
  p_pin_hash       text,
  p_visits         jsonb,
  p_visit_group_id uuid  default null,   -- set only for a split (doctor + lab) encounter
  p_context        jsonb default null    -- {ip, user_agent} for the audit rows
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ip       inet;
  v_ua       text := left(nullif(p_context ->> 'user_agent', ''), 512);
  v_visit    jsonb;
  v_lines    jsonb;
  v_total    numeric;
  v_sum_c    bigint;    -- centavos
  v_id       uuid;
  v_number   text;
  v_hmo      uuid;
  v_out      jsonb := '[]'::jsonb;
  v_verified boolean;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role in ('reception', 'admin') and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only active reception or admin staff can start a visit' using errcode = 'P0073';
  end if;
  if p_patient_id is null then
    raise exception 'choose a patient' using errcode = 'P0073';
  end if;
  if jsonb_typeof(p_visits) is distinct from 'array' or jsonb_array_length(p_visits) not in (1, 2) then
    raise exception 'a visit encounter has one or two visits' using errcode = 'P0073';
  end if;
  if (jsonb_array_length(p_visits) = 2) <> (p_visit_group_id is not null) then
    raise exception 'a split encounter needs a group id, and only a split one has one' using errcode = 'P0073';
  end if;
  if p_pin_hash is null or p_pin_hash !~ '^\$2[aby]\$[0-9]{2}\$.{53}$' then
    raise exception 'the portal PIN was not hashed' using errcode = 'P0073';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))) then
    raise exception 'unexpected audit context' using errcode = 'P0073';
  end if;
  begin
    v_ip := nullif(p_context ->> 'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  -- Shape of every line, before anything is written.
  for v_visit in select value from jsonb_array_elements(p_visits) loop
    v_lines := v_visit -> 'lines';
    if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) = 0 then
      raise exception 'each visit needs at least one line' using errcode = 'P0073';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_lines) l
       where (l ->> 'id') is null or (l ->> 'service_id') is null
          or coalesce(l ->> 'status', '') not in ('requested', 'in_progress')
          or ((l ->> 'is_package_header')::boolean) is distinct from ((l ->> 'status') = 'in_progress')
          or (nullif(l ->> 'parent_id', '') is not null and not exists (
                select 1 from jsonb_array_elements(v_lines) h
                 where h ->> 'id' = l ->> 'parent_id' and (h ->> 'is_package_header')::boolean))
    ) then
      raise exception 'a bill line is malformed (missing id, bad status, or a component without its package)'
        using errcode = 'P0073';
    end if;
    -- Compared in integer CENTAVOS: the app sums JS numbers (100.10 + 200.20
    -- arrives as 300.29999999999995) and every money column is numeric(10,2).
    v_total := (v_visit -> 'visit' ->> 'total_php')::numeric;
    select coalesce(sum(round((l ->> 'final_price_php')::numeric * 100)), 0)::bigint into v_sum_c
      from jsonb_array_elements(v_lines) l;
    if v_total is null or round(v_total * 100)::bigint <> v_sum_c then
      raise exception 'the visit total (%) does not match its lines (%)', round(v_total, 2), v_sum_c / 100.0
        using errcode = 'P0073';
    end if;
  end loop;

  -- The patient's lifecycle lock (shared) before the first row is written.
  perform public.lifecycle_lock_and_assert(array[p_patient_id], false);

  -- M5: a visit means the patient is at the counter — identity verified.
  update public.patients set pre_registered = false where id = p_patient_id and pre_registered;
  v_verified := found;
  if v_verified then
    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    values (p_actor, 'staff', p_patient_id, 'patient.identity_verified', 'patient', p_patient_id,
            jsonb_build_object('via', 'visit_created'), v_ip, v_ua);
  end if;

  for v_visit in select value from jsonb_array_elements(p_visits) with ordinality as t(value, n) order by n loop
    v_lines := v_visit -> 'lines';
    v_total := round((v_visit -> 'visit' ->> 'total_php')::numeric, 2);   -- centavos, as checked above
    v_hmo   := nullif(v_visit -> 'visit' ->> 'hmo_provider_id', '')::uuid;

    insert into public.visits (patient_id, total_php, notes, created_by, hmo_provider_id, hmo_approval_date,
                               hmo_authorization_no, attending_physician_id, visit_group_id, is_sample)
    values (p_patient_id, v_total, nullif(v_visit -> 'visit' ->> 'notes', ''), p_actor, v_hmo,
            nullif(v_visit -> 'visit' ->> 'hmo_approval_date', '')::date,
            nullif(v_visit -> 'visit' ->> 'hmo_authorization_no', ''),
            nullif(v_visit -> 'visit' ->> 'attending_physician_id', '')::uuid,
            p_visit_group_id,
            coalesce((v_visit -> 'visit' ->> 'is_sample')::boolean, false))
    returning id, visit_number into v_id, v_number;

    -- Headers + standalone lines, then components. The money columns are
    -- numeric(10,2): the assignment cast rounds every amount to centavos.
    insert into public.test_requests (id, visit_id, service_id, requested_by, base_price_php, discount_kind,
                                      discount_amount_php, final_price_php, hmo_provider_id, hmo_approval_date,
                                      hmo_authorization_no, receptionist_remarks, clinic_fee_php, doctor_pf_php,
                                      procedure_description, hmo_approved_amount_php, parent_id,
                                      is_package_header, status)
    select x.id, v_id, x.service_id, p_actor, x.base_price_php, x.discount_kind,
           coalesce(x.discount_amount_php, 0), x.final_price_php, x.hmo_provider_id, x.hmo_approval_date,
           x.hmo_authorization_no, x.receptionist_remarks, x.clinic_fee_php, x.doctor_pf_php,
           x.procedure_description, x.hmo_approved_amount_php, x.parent_id, x.is_package_header, x.status
      from jsonb_to_recordset(v_lines) as x(id uuid, service_id uuid, base_price_php numeric, discount_kind text,
             discount_amount_php numeric, final_price_php numeric, hmo_provider_id uuid, hmo_approval_date date,
             hmo_authorization_no text, receptionist_remarks text, clinic_fee_php numeric, doctor_pf_php numeric,
             procedure_description text, hmo_approved_amount_php numeric, parent_id uuid,
             is_package_header boolean, status text)
     where x.parent_id is null;
    insert into public.test_requests (id, visit_id, service_id, requested_by, base_price_php, discount_kind,
                                      discount_amount_php, final_price_php, hmo_provider_id, hmo_approval_date,
                                      hmo_authorization_no, receptionist_remarks, clinic_fee_php, doctor_pf_php,
                                      procedure_description, hmo_approved_amount_php, parent_id,
                                      is_package_header, status)
    select x.id, v_id, x.service_id, p_actor, x.base_price_php, x.discount_kind,
           coalesce(x.discount_amount_php, 0), x.final_price_php, x.hmo_provider_id, x.hmo_approval_date,
           x.hmo_authorization_no, x.receptionist_remarks, x.clinic_fee_php, x.doctor_pf_php,
           x.procedure_description, x.hmo_approved_amount_php, x.parent_id, x.is_package_header, x.status
      from jsonb_to_recordset(v_lines) as x(id uuid, service_id uuid, base_price_php numeric, discount_kind text,
             discount_amount_php numeric, final_price_php numeric, hmo_provider_id uuid, hmo_approval_date date,
             hmo_authorization_no text, receptionist_remarks text, clinic_fee_php numeric, doctor_pf_php numeric,
             procedure_description text, hmo_approved_amount_php numeric, parent_id uuid,
             is_package_header boolean, status text)
     where x.parent_id is not null;

    insert into public.visit_pins (visit_id, pin_hash) values (v_id, p_pin_hash);

    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    select p_actor, 'staff', p_patient_id, 'visit.created', 'visit', v_id,
           jsonb_build_object(
             'visit_number', v_number,
             'total_php', v_total,
             'service_count', count(*) filter (where nullif(l ->> 'parent_id', '') is null),
             'visit_group_id', p_visit_group_id,
             'hmo_provider_id', v_hmo,
             'discounted_lines', count(*) filter (where nullif(l ->> 'parent_id', '') is null
                                                   and coalesce((l ->> 'discount_amount_php')::numeric, 0) > 0),
             'is_sample', coalesce((v_visit -> 'visit' ->> 'is_sample')::boolean, false)),
           v_ip, v_ua
      from jsonb_array_elements(v_lines) l;

    -- Never the PIN or its hash (RA 10173) — only that one was issued.
    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    values (p_actor, 'staff', p_patient_id, 'visit_pin.issued', 'visit', v_id,
            jsonb_build_object('visit_number', v_number, 'reason', 'visit_created'), v_ip, v_ua);

    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    select p_actor, 'staff', p_patient_id, 'package.decomposed', 'test_request', (h.value ->> 'id')::uuid,
           jsonb_build_object(
             'visit_id', v_id,
             'package_service_id', (h.value ->> 'service_id')::uuid,
             'package_code', s.code,
             'package_name', s.name,
             'component_count', (select count(*) from jsonb_array_elements(v_lines) c
                                  where c ->> 'parent_id' = h.value ->> 'id'),
             'component_service_ids', coalesce((select jsonb_agg(c.value ->> 'service_id' order by c.n)
                                                  from jsonb_array_elements(v_lines) with ordinality as c(value, n)
                                                 where c.value ->> 'parent_id' = h.value ->> 'id'), '[]'::jsonb)),
           v_ip, v_ua
      from jsonb_array_elements(v_lines) as h(value)
      left join public.services s on s.id = (h.value ->> 'service_id')::uuid
     where (h.value ->> 'is_package_header')::boolean;

    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'visit_number', v_number));
  end loop;

  return jsonb_build_object('visits', v_out, 'identity_verified', v_verified);
end;
$$;

revoke all on function public.create_visit_encounter(uuid, uuid, text, jsonb, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_visit_encounter(uuid, uuid, text, jsonb, uuid, jsonb) to service_role;
```

- [ ] **Step 3: Apply, run — PASS** (s1–s9). `visit.created` metadata now carries the centavo-rounded total (`1900.00` in jsonb; a JS reader parses it as 1900).

- [ ] **Step 3b: Mutation check.** Replace the centavo comparison with the old `v_total <> sum(...)` numeric comparison: s9.21/s9.22/s9.23 must FAIL with P0073. Restore.

- [ ] **Step 4: Commit** — `feat(db): create_visit_encounter — visit, lines, PIN and audits in one transaction (0184 part 9)`.

---
### Task 11: `result_create_linked` — a result and all its links in one transaction

Replaces the three two-call creations (consolidated finalise, single structured draft, first PDF upload). A `results` INSERT has no patient (0051), so the row and its `result_test_requests` links must land together or not at all.

**Files:** migration (section (7)), 0184 smoke.

- [ ] **Step 1: Add smoke section s10 (fails).**

```sql
-- --- s10: result_create_linked ---------------------------------------------------------
do $s10$
declare
  k_med constant uuid := 'a2000000-0000-4000-8000-000000000184';
  k_rec constant uuid := 'a1000000-0000-4000-8000-000000000184';
  a uuid := pg_temp.mk_patient('S10A');
  b uuid := pg_temp.mk_patient('S10B');
  d uuid := pg_temp.mk_patient('S10D');
  va uuid; vb uuid; vd uuid; t1 uuid; t2 uuid; t3 uuid; t4 uuid; tb uuid; td uuid; tdel uuid;
  r uuid; n int;
begin
  va := pg_temp.mk_visit(a);
  vd := pg_temp.mk_visit(d);
  t1 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  t2 := pg_temp.mk_line(va, 'in_progress', 100, null, false, 'c1000000-0000-4000-8000-000000000184');
  t3 := pg_temp.mk_line(va, 'in_progress', 100);
  t4 := pg_temp.mk_line(va, 'in_progress', 100);
  tdel := pg_temp.mk_line(va, 'in_progress', 100);
  update public.test_requests set deleted_at = now(), deleted_by = k_med, delete_reason = 'smoke' where id = tdel;
  td := pg_temp.mk_line(vd, 'in_progress', 100);
  vb := pg_temp.mk_visit(b);
  tb := pg_temp.mk_line(vb, 'in_progress', 100);
  perform pg_temp.kill(d);

  r := public.result_create_linked(k_med, array[t1, t2], 'structured', null, null, null, null);
  perform pg_temp.expect('s10.1 structured draft linked to both tests',
    (select count(*)::text from public.result_test_requests where result_id = r), '2');
  perform pg_temp.expect('s10.2 …not finalised, tests not advanced',
    (select (finalised_at is null)::text from public.results where id = r)
      || '|' || (select string_agg(distinct status, ',') from public.test_requests where id in (t1, t2)), 'true|in_progress');
  r := public.result_create_linked(k_med, array[t3], 'uploaded', null, 'p/v/t3/attempt-1.pdf', 1234, '  note  ');
  perform pg_temp.expect('s10.3 uploaded result: path, size, trimmed note',
    (select storage_path || '|' || file_size_bytes || '|' || notes from public.results where id = r), 'p/v/t3/attempt-1.pdf|1234|note');
  perform pg_temp.expect('s10.4 …and the link advanced the test (0059 trigger)',
    (select (status <> 'in_progress')::text from public.test_requests where id = t3), 'true');

  n := (select count(*) from public.results);
  perform pg_temp.expect('s10.5 a test that already has a result',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'uploaded', null, 'x.pdf', 1, null)$q$, k_med, t3)), 'P0066');
  perform pg_temp.expect('s10.6 deleted patient''s test',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'uploaded', null, 'x.pdf', 1, null)$q$, k_med, td)), 'P0058');
  perform pg_temp.expect('s10.7 an active and a deleted patient''s test together',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L, %L]::uuid[], 'structured', null, null, null, null)$q$, k_med, t4, td)), 'P0058');
  perform pg_temp.expect('s10.8 a soft-deleted test',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'structured', null, null, null, null)$q$, k_med, tdel)), 'P0066');
  perform pg_temp.expect('s10.9 an uploaded result without a file',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'uploaded', null, null, null, null)$q$, k_med, t4)), '22023');
  perform pg_temp.expect('s10.10 a test listed twice',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L, %L]::uuid[], 'structured', null, null, null, null)$q$, k_med, t4, t4)), '22023');
  perform pg_temp.expect('s10.11 reception cannot create results',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L]::uuid[], 'structured', null, null, null, null)$q$, k_rec, t4)), '42501');
  perform pg_temp.expect('s10.11b two ACTIVE patients'' tests in one result',
    pg_temp.state_of(format($q$select public.result_create_linked(%L, array[%L, %L]::uuid[], 'structured', null, null, null, null)$q$, k_med, t4, tb)), '23514');
  perform pg_temp.expect('s10.12 no results row was left by any refusal',
    (select count(*) from public.results)::text, n::text);
  perform pg_temp.expect('s10.13 EXECUTE service_role only',
    (has_function_privilege('service_role', 'public.result_create_linked(uuid,uuid[],text,uuid,text,integer,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.result_create_linked(uuid,uuid[],text,uuid,text,integer,text)', 'execute'))::text, 'true');
end
$s10$;
```
Run: expect `function … does not exist`.

- [ ] **Step 2: Add section (7).**

```sql
-- ---------------------------------------------------------------------------
-- (7) result_create_linked — the results row and ALL its result_test_requests
-- links in one transaction. Before this, each creation path inserted the row,
-- then the links in a second call; a failure between them left an orphan
-- results row that no resume check could find (it keys off the links), and a
-- first PDF upload removed the object while the row still pointed at it.
--   structured: a draft (storage_path NULL, finalised_at NULL — the 0059
--     trigger only advances a structured test once finalised_at is set, which
--     result_finalise_commit does). p_report_group_id marks a consolidated
--     report (finalised_by_staff_id = actor, as finalise-consolidated did).
--   uploaded: the PDF is already stored at an attempt-unique path; linking
--     advances the tests (0059).
-- Tests are row-locked in id order after the patient lock, so two first
-- uploads of one test serialise; the loser gets P0066 ("already has a
-- result", message passes through — the result family's code, 0172).
-- ---------------------------------------------------------------------------
create or replace function public.result_create_linked(
  p_actor            uuid,
  p_test_request_ids uuid[],
  p_generation_kind  text,
  p_report_group_id  uuid default null,
  p_storage_path     text default null,
  p_file_size_bytes  int  default null,
  p_notes            text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ids      uuid[] := public.lifecycle_norm(array_remove(p_test_request_ids, null));
  v_patients uuid[];
  v_live     int;
  v_result   uuid;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role in ('medtech', 'pathologist', 'xray_technician', 'admin')
       and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only active lab staff can record a result' using errcode = '42501';
  end if;
  if p_generation_kind is null or p_generation_kind not in ('structured', 'uploaded') then
    raise exception 'unknown result kind %', p_generation_kind using errcode = '22023';
  end if;
  if p_generation_kind = 'uploaded' and (p_storage_path is null or p_file_size_bytes is null) then
    raise exception 'an uploaded result needs its stored PDF' using errcode = '22023';
  end if;
  if p_generation_kind = 'structured' and p_storage_path is not null then
    raise exception 'a structured draft has no PDF until it is finalised' using errcode = '22023';
  end if;
  if p_report_group_id is not null and p_generation_kind <> 'structured' then
    raise exception 'only a structured result can be a consolidated report' using errcode = '22023';
  end if;
  if cardinality(v_ids) = 0 or cardinality(v_ids) <> cardinality(p_test_request_ids) then
    raise exception 'list each test once' using errcode = '22023';
  end if;

  -- The new result's id is minted here so its MEMBERSHIP lock (exclusive —
  -- this call creates the membership) is taken first, as everywhere else:
  -- membership lock → patient locks → row locks.
  v_result := gen_random_uuid();
  perform public.lifecycle_lock_results(array[v_result], true);
  v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_test_requests(v_ids), null));
  if cardinality(v_patients) > 1 then
    raise exception 'a result can only hold one patient''s tests — create a separate result for each patient'
      using errcode = '23514';
  end if;
  perform public.lifecycle_lock_and_assert(v_patients, false);

  perform 1 from public.test_requests tr where tr.id = any(v_ids) order by tr.id for update;
  select count(*) into v_live
    from public.test_requests tr
    join public.visits v on v.id = tr.visit_id
   where tr.id = any(v_ids) and tr.deleted_at is null and v.deleted_at is null;
  if v_live <> cardinality(v_ids) then
    raise exception 'a test was not found or has been deleted — reload the page' using errcode = 'P0066';
  end if;
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_test_requests(v_ids), null))
       is distinct from v_patients then
    raise exception 'the patient on this test changed while the result was being saved — try again'
      using errcode = 'P0072';
  end if;
  if exists (select 1 from public.result_test_requests rtr where rtr.test_request_id = any(v_ids)) then
    raise exception 'this test already has a result — reload the page' using errcode = 'P0066';
  end if;

  insert into public.results (id, generation_kind, storage_path, file_size_bytes, uploaded_by, notes,
                              report_group_id, finalised_by_staff_id, finalised_at)
  values (v_result, p_generation_kind, p_storage_path, p_file_size_bytes, p_actor, nullif(btrim(coalesce(p_notes, '')), ''),
          p_report_group_id, case when p_report_group_id is not null then p_actor end, null);

  insert into public.result_test_requests (result_id, test_request_id)
  select v_result, x from unnest(v_ids) x;

  return v_result;
end;
$$;

revoke all on function public.result_create_linked(uuid, uuid[], text, uuid, text, int, text) from public, anon, authenticated;
grant execute on function public.result_create_linked(uuid, uuid[], text, uuid, text, int, text) to service_role;
```

- [ ] **Step 3: Apply, run — PASS** (s1–s10).

- [ ] **Step 4: Commit** — `feat(db): result_create_linked — result row and links in one transaction (0184 part 10)`.

---

### Task 12: `record_hmo_settlement` — payments and allocations in one transaction

**Files:** migration (section (8)), 0184 smoke.

- [ ] **Step 1: Add smoke section s11 (fails).**

```sql
-- --- s11: record_hmo_settlement ------------------------------------------------------------
do $s11$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  k_rec   constant uuid := 'a1000000-0000-4000-8000-000000000184';
  a uuid := pg_temp.mk_patient('S11A');
  b uuid := pg_temp.mk_patient('S11B');
  d uuid := pg_temp.mk_patient('S11D');
  va uuid; vb uuid; vd uuid;
  ia1 uuid; ia2 uuid; ib uuid; id_ uuid; iother uuid; ic1 uuid; ic2 uuid;
  bat uuid; bat_other uuid; bat_c uuid;
  res jsonb; n int;
  def text; lp int; bp int; ip int;
begin
  va := pg_temp.mk_visit(a, true); vb := pg_temp.mk_visit(b, true); vd := pg_temp.mk_visit(d, true);
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted') returning id into bat;
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted') returning id into bat_other;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values
    (bat, pg_temp.mk_line(va, 'released', 300), 300) returning id into ia1;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values
    (bat, pg_temp.mk_line(va, 'released', 200), 200) returning id into ia2;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values
    (bat, pg_temp.mk_line(vb, 'released', 500), 500) returning id into ib;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values
    (bat, pg_temp.mk_line(vd, 'released', 100), 100) returning id into id_;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values
    (bat_other, pg_temp.mk_line(vb, 'released', 50), 50) returning id into iother;
  perform pg_temp.kill(d);

  res := public.record_hmo_settlement(k_admin, bat, 1000, now(), jsonb_build_array(
    jsonb_build_object('item_id', ia1, 'amount_php', 300),
    jsonb_build_object('item_id', ia2, 'amount_php', 200),
    jsonb_build_object('item_id', ib,  'amount_php', 500)), ' BANK-1 ', '{"ip":"203.0.113.7"}');
  perform pg_temp.expect('s11.1 one payment per visit, one allocation per item',
    jsonb_array_length(res -> 'payment_ids')::text || '|' || (res ->> 'allocation_count'), '2|3');
  perform pg_temp.expect('s11.2 payment amounts per visit',
    (select string_agg(amount_php::text, ',' order by amount_php) from public.payments where visit_id in (va, vb) and method = 'hmo'), '500.00,500.00');
  perform pg_temp.expect('s11.3 items rolled up (paid = billed)',
    (select string_agg((paid_amount_php = billed_amount_php)::text, ',') from public.hmo_claim_items where id in (ia1, ia2, ib)), 'true,true,true');
  perform pg_temp.expect('s11.4 reference trimmed, audit written',
    (select reference_number from public.payments where id = (res -> 'payment_ids' ->> 0)::uuid)
      || '|' || (select count(*)::text from public.audit_log where action = 'hmo_settlement.recorded' and resource_id = bat), 'BANK-1|1');

  n := (select count(*) from public.payments where method = 'hmo');
  perform pg_temp.expect('s11.5 an item of a deleted patient refuses the whole settlement',
    pg_temp.state_of(format($q$select public.record_hmo_settlement(%L, %L, 100, now(), jsonb_build_array(jsonb_build_object('item_id', %L, 'amount_php', 100)))$q$, k_admin, bat, id_)), 'P0058');
  perform pg_temp.expect('s11.6 an item from another batch',
    pg_temp.state_of(format($q$select public.record_hmo_settlement(%L, %L, 50, now(), jsonb_build_array(jsonb_build_object('item_id', %L, 'amount_php', 50)))$q$, k_admin, bat, iother)), '22023');
  perform pg_temp.expect('s11.7 amounts that do not add up to the total',
    pg_temp.state_of(format($q$select public.record_hmo_settlement(%L, %L, 999, now(), jsonb_build_array(jsonb_build_object('item_id', %L, 'amount_php', 50)))$q$, k_admin, bat_other, iother)), '22023');
  perform pg_temp.expect('s11.8 the same item twice',
    pg_temp.state_of(format($q$select public.record_hmo_settlement(%L, %L, 50, now(), jsonb_build_array(jsonb_build_object('item_id', %L, 'amount_php', 25), jsonb_build_object('item_id', %L, 'amount_php', 25)))$q$, k_admin, bat_other, iother, iother)), '22023');
  perform pg_temp.expect('s11.9 non-admin actor',
    pg_temp.state_of(format($q$select public.record_hmo_settlement(%L, %L, 50, now(), jsonb_build_array(jsonb_build_object('item_id', %L, 'amount_php', 50)))$q$, k_rec, bat_other, iother)), '42501');
  -- Over-allocation on the LAST visit (P0012) must roll back the earlier visit's payment too.
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values
    (bat_other, pg_temp.mk_line(va, 'released', 10), 10) returning id into ia1;
  perform pg_temp.expect('s11.10 an over-allocation on a later visit fails the whole call',
    pg_temp.state_of(format($q$select public.record_hmo_settlement(%L, %L, 90, now(), jsonb_build_array(jsonb_build_object('item_id', %L, 'amount_php', 50), jsonb_build_object('item_id', %L, 'amount_php', 40)))$q$, k_admin, bat_other, iother, ia1)), 'P0012');
  perform pg_temp.expect('s11.11 …leaving no payment behind (the old compensating loop is gone)',
    (select count(*) from public.payments where method = 'hmo')::text, n::text);
  -- Centavos (Codex plan review P2-4): amounts arrive as JS floats.
  insert into public.hmo_claim_batches (provider_id, status) values ('b0000000-0000-4000-8000-000000000184', 'submitted') returning id into bat_c;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values
    (bat_c, pg_temp.mk_line(va, 'released', 100.10), 100.10) returning id into ic1;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values
    (bat_c, pg_temp.mk_line(va, 'released', 200.20), 200.20) returning id into ic2;
  res := public.record_hmo_settlement(k_admin, bat_c, 300.29999999999995, now(), jsonb_build_array(
    jsonb_build_object('item_id', ic1, 'amount_php', 100.10000000000001),
    jsonb_build_object('item_id', ic2, 'amount_php', 200.2)));
  perform pg_temp.expect('s11.12a fractional amounts: one payment of 300.30, allocations 100.10 + 200.20, batch paid',
    (select amount_php::text from public.payments where id = (res -> 'payment_ids' ->> 0)::uuid)
      || '|' || (select string_agg(amount_php::text, ',' order by amount_php) from public.hmo_payment_allocations where item_id in (ic1, ic2))
      || '|' || (select status from public.hmo_claim_batches where id = bat_c),
    '300.30|100.10,200.20|paid');

  -- Batch-level serialisation (Codex plan review P2-5): text order, every position > 0.
  def := lower(pg_get_functiondef('public.record_hmo_settlement(uuid,uuid,numeric,timestamp with time zone,jsonb,text,jsonb)'::regprocedure));
  lp := position('lifecycle_lock_and_assert' in def);
  bp := position('from public.hmo_claim_batches b where b.id = p_batch_id for no key update' in def);
  ip := position('order by i.id for update' in def);
  perform pg_temp.expect('s11.12b settlement: patient locks → batch row → item rows',
    (lp > 0 and bp > 0 and ip > 0 and lp < bp and bp < ip)::text, 'true');
  def := lower(pg_get_functiondef('public.recompute_hmo_batch_status(uuid)'::regprocedure));
  bp := position('for no key update' in def);
  ip := position('from public.hmo_claim_items' in def);
  perform pg_temp.expect('s11.12c the rollup locks the batch row before it reads the items',
    (bp > 0 and ip > 0 and bp < ip)::text, 'true');

  perform pg_temp.expect('s11.12 EXECUTE service_role only',
    (has_function_privilege('service_role', 'public.record_hmo_settlement(uuid,uuid,numeric,timestamp with time zone,jsonb,text,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.record_hmo_settlement(uuid,uuid,numeric,timestamp with time zone,jsonb,text,jsonb)', 'execute'))::text, 'true');
end
$s11$;
```
(s11.10: whichever visit sorts first gets its payment inserted before the failing one; either order proves atomicity because the count is compared with the pre-call total.) Run: expect `function … does not exist`.

- [ ] **Step 2: Add section (8).**

```sql
-- ---------------------------------------------------------------------------
-- (8) record_hmo_settlement — what recordHmoSettlementAction did as N+1
-- PostgREST inserts with a best-effort compensating delete (whose own errors
-- were never checked): one hmo payment per visit, then that visit's
-- allocations, in ONE transaction. The whole patient set is locked (shared,
-- sorted) first, then the items are row-locked in id order — that row lock
-- is what serialises competing allocations on one item; patient locks do not
-- serialise settlements of different patients in one batch. A deleted
-- patient's item refuses the whole call (restore first); a mixed batch whose
-- OTHER items belong to deleted patients is fine. p_received_at receives the
-- same value the action used to write to payments.received_at. Lock order:
-- patient locks → the BATCH row (two settlements of one batch serialise, so
-- the rollup never misses the other one's items) → the items in id order.
-- All money is normalised to integer centavos before any comparison.
-- ---------------------------------------------------------------------------
create or replace function public.record_hmo_settlement(
  p_actor            uuid,
  p_batch_id         uuid,
  p_total_amount_php numeric,
  p_received_at      timestamptz,
  p_items            jsonb,
  p_bank_reference   text  default null,
  p_context          jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ip          inet;
  v_items       uuid[];
  v_sum_c       bigint;   -- centavos
  v_patients    uuid[];
  v_payment     uuid;
  v_payment_ids uuid[] := '{}';
  v_alloc       int := 0;
  v_n           int;
  v_ref         text := nullif(btrim(coalesce(p_bank_reference, '')), '');
  r             record;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can record an HMO settlement' using errcode = '42501';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))) then
    raise exception 'unexpected audit context' using errcode = '22023';
  end if;
  begin
    v_ip := nullif(p_context ->> 'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'choose at least one claim item' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) x
              where nullif(x ->> 'item_id', '') is null
                 or coalesce((x ->> 'amount_php')::numeric, 0) <= 0) then
    raise exception 'every claim item needs an amount above zero' using errcode = '22023';
  end if;
  -- Money in integer CENTAVOS (the app sends JS numbers).
  select array_agg((x ->> 'item_id')::uuid), sum(round((x ->> 'amount_php')::numeric * 100))::bigint
    into v_items, v_sum_c
    from jsonb_array_elements(p_items) x;
  if cardinality(public.lifecycle_norm(v_items)) <> cardinality(v_items) then
    raise exception 'a claim item is listed twice' using errcode = '22023';
  end if;
  if p_total_amount_php is null or v_sum_c <> round(p_total_amount_php * 100)::bigint then
    raise exception 'the item amounts (%) must add up to the total (%)', v_sum_c / 100.0, round(p_total_amount_php, 2)
      using errcode = '22023';
  end if;

  v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_hmo_items(v_items), null));
  perform public.lifecycle_lock_and_assert(v_patients, false);

  -- The BATCH row next (Codex plan review P2-5): two settlements of one
  -- batch serialise here, so the second one's rollup sees the first one's
  -- items paid. Then the items, in id order (competing allocations on one
  -- item serialise on these).
  perform 1 from public.hmo_claim_batches b where b.id = p_batch_id for no key update;
  if not found then
    raise exception 'this claim batch no longer exists — reload the page' using errcode = '22023';
  end if;
  perform 1 from public.hmo_claim_items i where i.id = any(v_items) order by i.id for update;
  if (select count(*) from public.hmo_claim_items i where i.id = any(v_items)) <> cardinality(v_items) then
    raise exception 'some claim items were not found — reload the batch' using errcode = '22023';
  end if;
  if exists (select 1 from public.hmo_claim_items i where i.id = any(v_items) and i.batch_id is distinct from p_batch_id) then
    raise exception 'all items must belong to this batch' using errcode = '22023';
  end if;
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_hmo_items(v_items), null))
       is distinct from v_patients then
    raise exception 'a claim item''s patient changed while the settlement was being saved — try again'
      using errcode = 'P0072';
  end if;

  for r in
    select tr.visit_id,
           sum(round((x ->> 'amount_php')::numeric * 100))::bigint / 100.0 as amount,
           array_agg(i.id) as item_ids
      from jsonb_array_elements(p_items) x
      join public.hmo_claim_items i on i.id = (x ->> 'item_id')::uuid
      join public.test_requests tr on tr.id = i.test_request_id
     group by tr.visit_id
     order by tr.visit_id
  loop
    insert into public.payments (visit_id, amount_php, method, reference_number, received_at, received_by)
    values (r.visit_id, r.amount, 'hmo', v_ref, p_received_at, p_actor)
    returning id into v_payment;
    v_payment_ids := v_payment_ids || v_payment;

    insert into public.hmo_payment_allocations (payment_id, item_id, amount_php)
    select v_payment, (x ->> 'item_id')::uuid, round((x ->> 'amount_php')::numeric, 2)
      from jsonb_array_elements(p_items) x
     where (x ->> 'item_id')::uuid = any(r.item_ids);
    get diagnostics v_n = row_count;
    v_alloc := v_alloc + v_n;
  end loop;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata,
                                ip_address, user_agent)
  values (p_actor, 'staff', 'hmo_settlement.recorded', 'hmo_claim_batch', p_batch_id,
          jsonb_build_object('total_amount_php', round(p_total_amount_php, 2),
                             'payment_count', cardinality(v_payment_ids),
                             'allocation_count', v_alloc,
                             'payment_ids', to_jsonb(v_payment_ids),
                             'bank_reference', v_ref),
          v_ip, left(nullif(p_context ->> 'user_agent', ''), 512));

  return jsonb_build_object('payment_ids', to_jsonb(v_payment_ids), 'allocation_count', v_alloc);
end;
$$;

revoke all on function public.record_hmo_settlement(uuid, uuid, numeric, timestamptz, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_hmo_settlement(uuid, uuid, numeric, timestamptz, jsonb, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (8b) recompute_hmo_batch_status — 0034's body (lines ~383-430) with ONE
-- change: the batch row is locked (FOR NO KEY UPDATE) before the items are
-- read. Before, two transactions resolving the LAST two items of a batch
-- each saw the other's item still open (uncommitted) and returned — both
-- committed and the batch stayed 'submitted' for good (Codex plan review
-- P2-5). Now the second waits for the first's commit and, as a volatile
-- plpgsql function, reads the items with a fresh snapshot after the wait.
-- NO KEY UPDATE does not conflict with the KEY SHARE an item insert's FK
-- check takes on the batch. search_path pinned; SECURITY DEFINER and the
-- EXECUTE ACL restated exactly as Task 0 Step 6 read them from prod.
-- ---------------------------------------------------------------------------
```
  Copy `recompute_hmo_batch_status` from `0034_hmo_ar_subledger.sql` (the `create or replace function public.recompute_hmo_batch_status(p_batch_id uuid)` statement, ~line 383, through its `$$;`). Change exactly: (1) `set search_path = public` → `set search_path = pg_catalog, public, pg_temp`; (2) the first statement `select status into v_current from public.hmo_claim_batches where id = p_batch_id;` → `select status into v_current from public.hmo_claim_batches where id = p_batch_id for no key update;  -- 0184: serialise the rollup per batch`. Then restate the ACL exactly as prod has it (Task 0 Step 6 `proacl`; on 2026-09-28 local, compare with `\df+ public.recompute_hmo_batch_status`) — e.g. `revoke all … from public, anon, authenticated;` + the same grants it has today. Do NOT widen it. If a trigger function that calls it is SECURITY INVOKER, the grant it relies on must stay — check `tg_hmo_batch_status_rollup_from_item`'s `prosecdef` first.

- [ ] **Step 3: Apply, run — PASS** (s1–s11). Re-run `0147_hmo_claim_delete_guard_smoke.sql` and `0030_op_gl_bridge_smoke.sql` (they settle HMO items): green.

- [ ] **Step 3b: Mutation checks.** (a) Remove `for no key update` from the rollup: s11.12c fails here, and Task 16's `hmo_last_two_items_both_commit` race must fail (batch left `submitted`) — run it once in this state after Task 16 exists, or record this mutation for Task 29 Step 2. (b) Replace the centavo total check with a raw `v_sum <> p_total_amount_php` numeric comparison: s11.12a must FAIL (22023 — 100.10000000000001 + 200.2 is not 300.29999999999995). Restore.

- [ ] **Step 4: Commit** — `feat(db): record_hmo_settlement — payments and allocations in one transaction, batch-level lock; rollup locks the batch (0184 part 11)`.

---

### Task 13: `reschedule_closure_appointments` (+ dry run for the preview)

**Files:** migration (section (9)), 0184 smoke.

- [ ] **Step 1: Add smoke section s12 (fails).** Dates are far in the future so no real appointment collides.

```sql
-- --- s12: reschedule_closure_appointments --------------------------------------------------
do $s12$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  k_rec   constant uuid := 'a1000000-0000-4000-8000-000000000184';
  day  constant date := '2031-03-03';
  big  constant date := '2031-03-04';
  a uuid := pg_temp.mk_patient('S12A');
  d uuid := pg_temp.mk_patient('S12D');
  ap_conf uuid; ap_arr uuid; ap_walk uuid; ap_late uuid; ap_dead uuid; ap_prev uuid; ap_next uuid; ap_canc uuid;
  res jsonb; i int; p uuid;
begin
  -- Isolation first (Codex plan review P2-7): the RPC acts on EVERY eligible
  -- appointment of the day, so the days must hold nothing but this fixture.
  -- (Everything here rolls back, but a stranger's row would skew the counts.)
  if exists (select 1 from public.clinic_closures where closed_on between '2031-03-02' and '2031-03-04')
     or exists (select 1 from public.appointments
                 where scheduled_at >= '2031-03-02 00:00+08' and scheduled_at < '2031-03-05 00:00+08') then
    raise exception '0184 s12: 2031-03-02..04 are not empty on this stack (another session''s fixture?) — pick three other empty days';
  end if;
  insert into public.clinic_closures (closed_on, reason, created_by) values (day, 'smoke', k_admin), (big, 'smoke big', k_admin);
  insert into public.appointments (patient_id, status, scheduled_at) values (a, 'confirmed', '2031-03-03 09:00+08') returning id into ap_conf;
  insert into public.appointments (patient_id, status, scheduled_at) values (a, 'arrived',   '2031-03-03 10:00+08') returning id into ap_arr;
  insert into public.appointments (walk_in_name, status, scheduled_at) values ('W', 'confirmed', '2031-03-03 11:00+08') returning id into ap_walk;
  insert into public.appointments (patient_id, status, scheduled_at) values (a, 'confirmed', '2031-03-03 23:59+08') returning id into ap_late;
  insert into public.appointments (patient_id, status, scheduled_at) values (d, 'confirmed', '2031-03-03 12:00+08') returning id into ap_dead;
  insert into public.appointments (patient_id, status, scheduled_at) values (a, 'confirmed', '2031-03-02 23:59+08') returning id into ap_prev;
  insert into public.appointments (patient_id, status, scheduled_at) values (a, 'confirmed', '2031-03-04 00:00+08') returning id into ap_next;
  insert into public.appointments (patient_id, status, scheduled_at) values (a, 'cancelled', '2031-03-03 13:00+08') returning id into ap_canc;
  perform pg_temp.kill(d);

  res := public.reschedule_closure_appointments(day, k_admin, true, null);
  perform pg_temp.expect('s12.1 dry run counts (walk-ins count, inactive skipped, Manila day bounds)',
    (res ->> 'affected') || '|' || (res ->> 'skipped_inactive'), '4|1');
  perform pg_temp.expect('s12.2 dry run changes nothing',
    (select status from public.appointments where id = ap_conf), 'confirmed');

  res := public.reschedule_closure_appointments(day, k_admin, false, '{"ip":"203.0.113.9","user_agent":"smoke"}');
  perform pg_temp.expect('s12.3 real run counts', (res ->> 'affected') || '|' || (res ->> 'skipped_inactive'), '4|1');
  perform pg_temp.expect('s12.4 eligible rows → pending_callback, no time',
    (select count(*)::text from public.appointments
      where id in (ap_conf, ap_arr, ap_walk, ap_late) and status = 'pending_callback' and scheduled_at is null), '4');
  perform pg_temp.expect('s12.5 the deleted patient''s row is untouched',
    (select status from public.appointments where id = ap_dead), 'confirmed');
  perform pg_temp.expect('s12.6 the Manila-day boundaries hold',
    (select string_agg(status, ',' order by scheduled_at) from public.appointments where id in (ap_prev, ap_next, ap_canc)),
    'confirmed,cancelled,confirmed');
  perform pg_temp.expect('s12.7 per-row audits + one summary',
    (select count(*)::text from public.audit_log where action = 'appointment.bulk_rescheduled_for_closure'
       and resource_id in (ap_conf, ap_arr, ap_walk, ap_late))
      || '|' || (select (metadata ->> 'affected') || '/' || (metadata ->> 'skipped_inactive') from public.audit_log
                  where action = 'closure.bulk_rescheduled' and metadata ->> 'closed_on' = day::text), '4|4/1');
  res := public.reschedule_closure_appointments(day, k_admin, false, null);
  perform pg_temp.expect('s12.8 re-running finds nothing', res ->> 'affected', '0');

  -- No row cap: 1,200 patients on one day, one transaction.
  for i in 1..1200 loop
    insert into public.patients (drm_id, first_name, last_name, birthdate) values ('DRM-LKB' || i, 'B', 'Lkb' || i, '1990-01-01')
      returning id into p;
    insert into public.appointments (patient_id, status, scheduled_at) values (p, 'confirmed', '2031-03-04 09:00+08');
  end loop;
  res := public.reschedule_closure_appointments(big, k_admin, false, null);
  perform pg_temp.expect('s12.9 1,200 rows in one call (no PostgREST cap, no chunk half-commit)',
    ((res ->> 'affected')::int >= 1200)::text, 'true');   -- >= because ap_next also sits on 2031-03-04

  perform pg_temp.expect('s12.10 a closure that no longer exists',
    pg_temp.state_of(format($q$select public.reschedule_closure_appointments('2031-12-25', %L, false, null)$q$, k_admin)), '22023');
  perform pg_temp.expect('s12.11 non-admin actor',
    pg_temp.state_of(format($q$select public.reschedule_closure_appointments(%L, %L, false, null)$q$, day, k_rec)), '42501');
  perform pg_temp.expect('s12.12 EXECUTE service_role only',
    (has_function_privilege('service_role', 'public.reschedule_closure_appointments(date,uuid,boolean,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.reschedule_closure_appointments(date,uuid,boolean,jsonb)', 'execute'))::text, 'true');
end
$s12$;
```
Run: expect `function … does not exist`.

- [ ] **Step 2: Add section (9).**

```sql
-- ---------------------------------------------------------------------------
-- (9) reschedule_closure_appointments — the admin "reschedule everyone on a
-- closed day" action, previously a JS loop of 200-row PostgREST updates (a
-- half-finished run was possible, and the preview counted inactive patients
-- the action would skip). One transaction: lock every candidate patient
-- (shared, sorted, lock only — an inactive patient is SKIPPED, never a
-- reason to fail), row-lock the still-eligible rows, move them to
-- pending_callback, audit each + one summary. Walk-ins are always eligible.
-- p_dry_run returns the same counts without locking or writing (the closures
-- page preview). The Manila day is [closed_on 00:00+08, +1 day).
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_closure_appointments(
  p_closed_on date,
  p_actor     uuid,
  p_dry_run   boolean default false,
  p_context   jsonb   default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_from       timestamptz := p_closed_on::timestamp at time zone 'Asia/Manila';
  v_to         timestamptz := (p_closed_on + 1)::timestamp at time zone 'Asia/Manila';
  v_ip         inet;
  v_ua         text := left(nullif(p_context ->> 'user_agent', ''), 512);
  v_patients   uuid[];
  v_candidates int;
  v_ids        uuid[] := '{}';
  v_inactive   int;
  v_affected   int := 0;
  r            record;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can reschedule a closed day' using errcode = '42501';
  end if;
  if p_closed_on is null or not exists (select 1 from public.clinic_closures c where c.closed_on = p_closed_on) then
    raise exception 'this closure no longer exists — reload the page' using errcode = '22023';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))) then
    raise exception 'unexpected audit context' using errcode = '22023';
  end if;
  begin
    v_ip := nullif(p_context ->> 'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  if coalesce(p_dry_run, false) then
    return (
      select jsonb_build_object(
               'affected', count(*) filter (where a.patient_id is null
                                              or (p.deleted_at is null and p.merged_into_id is null)),
               'skipped_inactive', count(*) filter (where a.patient_id is not null
                                                      and (p.id is null or p.deleted_at is not null
                                                           or p.merged_into_id is not null)),
               'skipped_changed', 0)
        from public.appointments a
        left join public.patients p on p.id = a.patient_id
       where a.scheduled_at >= v_from and a.scheduled_at < v_to
         and a.status in ('confirmed', 'arrived'));
  end if;

  select array_agg(distinct a.patient_id) filter (where a.patient_id is not null), count(*)
    into v_patients, v_candidates
    from public.appointments a
   where a.scheduled_at >= v_from and a.scheduled_at < v_to
     and a.status in ('confirmed', 'arrived');
  perform public.lifecycle_lock(coalesce(v_patients, '{}'::uuid[]), false);

  -- Fresh read under the locks; a patient not in the locked set (booked after
  -- the first read) is left alone and counted as changed.
  for r in
    select a.id
      from public.appointments a
      left join public.patients p on p.id = a.patient_id
     where a.scheduled_at >= v_from and a.scheduled_at < v_to
       and a.status in ('confirmed', 'arrived')
       and (a.patient_id is null
            or (a.patient_id = any(coalesce(v_patients, '{}'::uuid[]))
                and p.deleted_at is null and p.merged_into_id is null))
     order by a.id
       for update of a
  loop
    v_ids := v_ids || r.id;
  end loop;

  select count(*) into v_inactive
    from public.appointments a
    join public.patients p on p.id = a.patient_id
   where a.scheduled_at >= v_from and a.scheduled_at < v_to
     and a.status in ('confirmed', 'arrived')
     and (p.deleted_at is not null or p.merged_into_id is not null);

  for r in
    update public.appointments a
       set status = 'pending_callback', scheduled_at = null
      from (select a2.id, a2.status as previous_status from public.appointments a2 where a2.id = any(v_ids)) prev
     where a.id = prev.id
    returning a.id, a.patient_id, prev.previous_status
  loop
    v_affected := v_affected + 1;
    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    values (p_actor, 'staff', r.patient_id, 'appointment.bulk_rescheduled_for_closure', 'appointment', r.id,
            jsonb_build_object('closed_on', p_closed_on, 'previous_status', r.previous_status,
                               'new_status', 'pending_callback'),
            v_ip, v_ua);
  end loop;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata,
                                ip_address, user_agent)
  values (p_actor, 'staff', 'closure.bulk_rescheduled', 'clinic_closure', null,
          jsonb_build_object('closed_on', p_closed_on, 'affected', v_affected,
                             'skipped', v_inactive + greatest(v_candidates - v_affected - v_inactive, 0),
                             'skipped_inactive', v_inactive,
                             'skipped_changed', greatest(v_candidates - v_affected - v_inactive, 0)),
          v_ip, v_ua);

  return jsonb_build_object('affected', v_affected, 'skipped_inactive', v_inactive,
                            'skipped_changed', greatest(v_candidates - v_affected - v_inactive, 0));
end;
$$;

revoke all on function public.reschedule_closure_appointments(date, uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.reschedule_closure_appointments(date, uuid, boolean, jsonb) to service_role;
```
Note on `previous_status`: the old action wrote the literal `'confirmed_or_arrived'`; this writes the real prior status. Nothing reads the key (grep `previous_status` under `src/` to confirm at implementation; if something does, keep the literal instead).

- [ ] **Step 3: Apply, run — PASS** (s1–s12). s12.9 takes a few seconds (1,200 patients).

- [ ] **Step 4: Commit** — `feat(db): reschedule_closure_appointments — one transaction, skips inactive patients, dry run for the preview (0184 part 12)`.

---
### Task 14: `current_patient_id()` from the JWT only, drop `set_patient_context`, `notification_skip_summary`

**Files:** migration (section (10)), 0184 smoke, `src/lib/patients/active-views.test.ts`.

- [ ] **Step 1: Add smoke section s13 (fails).**

```sql
-- --- s13: portal identity + skip summary ----------------------------------------------------
do $s13$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000184';
  k_rec   constant uuid := 'a1000000-0000-4000-8000-000000000184';
  p uuid := pg_temp.mk_patient('S13A');
  d uuid := pg_temp.mk_patient('S13D');
  n int;
begin
  perform pg_temp.kill(d);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('app.current_patient_id', p::text, true);
  perform pg_temp.expect('s13.1 the legacy GUC alone no longer identifies a patient',
    coalesce(public.current_patient_id()::text, 'null'), 'null');
  perform set_config('app.current_patient_id', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', p)::text, true);
  perform pg_temp.expect('s13.2 the JWT claim identifies an active patient', public.current_patient_id()::text, p::text);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', d)::text, true);
  perform pg_temp.expect('s13.3 …but not a deleted one', coalesce(public.current_patient_id()::text, 'null'), 'null');
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect('s13.4 set_patient_context is gone',
    coalesce(to_regprocedure('public.set_patient_context(uuid)')::text, 'gone'), 'gone');
  perform pg_temp.expect('s13.5 current_patient_id still callable by every policy role',
    (has_function_privilege('anon', 'public.current_patient_id()', 'execute')
     and has_function_privilege('authenticated', 'public.current_patient_id()', 'execute')
     and has_function_privilege('service_role', 'public.current_patient_id()', 'execute'))::text, 'true');

  -- Skip summary.
  insert into public.audit_log (actor_type, action, metadata, created_at) values
    ('system', 'notification.skipped_inactive_patient', '{"sender":"lk-smoke-released","reason":"deleted"}', now() - interval '1 day'),
    ('system', 'notification.skipped_inactive_patient', '{"sender":"lk-smoke-released","reason":"deleted"}', now() - interval '2 days'),
    ('system', 'notification.skipped_inactive_patient', '{"sender":"lk-smoke-register","reason":"merged"}', now() - interval '20 days'),
    ('system', 'notification.skipped_inactive_patient', '{"sender":"lk-smoke-register","reason":"merged"}', now() - interval '40 days');
  perform pg_temp.expect('s13.6 summary over 7 and 30 days',
    (select string_agg(sender || '/' || reason || '=' || skipped_7d || '/' || skipped_30d, ',' order by sender collate "C")
       from public.notification_skip_summary() where sender like 'lk-smoke-%'),
    'lk-smoke-released/deleted=2/2,lk-smoke-register/merged=0/1');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', k_rec)::text, true);
  perform set_config('request.jwt.claim.sub', k_rec::text, true);
  n := (select count(*) from public.notification_skip_summary() where sender like 'lk-smoke-%');
  perform pg_temp.expect('s13.7 a non-admin sees no rows (audit_log RLS; invoker)', n::text, '0');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', k_admin)::text, true);
  perform set_config('request.jwt.claim.sub', k_admin::text, true);
  n := (select count(*) from public.notification_skip_summary() where sender like 'lk-smoke-%');
  perform pg_temp.expect('s13.8 an admin sees them', n::text, '2');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.expect('s13.9 EXECUTE: authenticated yes, anon no',
    (has_function_privilege('authenticated', 'public.notification_skip_summary()', 'execute')
     and not has_function_privilege('anon', 'public.notification_skip_summary()', 'execute'))::text, 'true');
end
$s13$;
```
Run: expect `s13.1 FAILED` (the GUC still works).

- [ ] **Step 2: Add section (10).**

```sql
-- ---------------------------------------------------------------------------
-- (10a) current_patient_id() — the JWT claim only. The app.current_patient_id
-- GUC fallback (0001/0114) was the set_patient_context bridge: nothing calls
-- it, and any transaction that could set a GUC could have claimed to be any
-- patient. 0167's active filter, SECURITY DEFINER and grants are kept.
-- ---------------------------------------------------------------------------
create or replace function public.current_patient_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p.id
    from public.patients p
   where p.id = nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'patient_id', '')::uuid
     and p.deleted_at is null
     and p.merged_into_id is null;
$$;

revoke all on function public.current_patient_id() from public;
grant execute on function public.current_patient_id() to anon, authenticated, service_role;

drop function if exists public.set_patient_context(uuid);

-- ---------------------------------------------------------------------------
-- (10b) notification_skip_summary — Cron Health's "Patient messages not
-- sent": recorded notification.skipped_inactive_patient rows by sender and
-- reason, last 7 and 30 days. SECURITY INVOKER: audit_log's RLS (admin-only
-- SELECT) decides who sees anything. These are RECORDED skips — an outage
-- can fail both the recipient lookup and its audit insert (lookup_failed is
-- also reported to Sentry by the app).
-- ---------------------------------------------------------------------------
create or replace function public.notification_skip_summary()
returns table (sender text, reason text, skipped_7d bigint, skipped_30d bigint)
language sql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(a.metadata ->> 'sender', 'unknown') as sender,
         coalesce(a.metadata ->> 'reason', 'unknown') as reason,
         count(*) filter (where a.created_at >= now() - interval '7 days')  as skipped_7d,
         count(*)                                                          as skipped_30d
    from public.audit_log a
   where a.action = 'notification.skipped_inactive_patient'
     and a.created_at >= now() - interval '30 days'
   group by 1, 2
   order by 1, 2;
$$;

revoke all on function public.notification_skip_summary() from public, anon;
grant execute on function public.notification_skip_summary() to authenticated, service_role;
```

- [ ] **Step 3: Apply, run — PASS** (s1–s13). Re-run the 0167 smoke (its s6 portal section uses `request.jwt.claims` only — it must stay green).

- [ ] **Step 4: Pin the JWT-only rule.** In `src/lib/patients/active-views.test.ts`, inside `it("current_patient_id returns only an active patient", …)`, add:

```ts
    // 0184: the JWT claim is the only identity source; the legacy GUC bridge is gone.
    expect(body).not.toMatch(/app\.current_patient_id/);
```
and add a new test after it:

```ts
  it("set_patient_context was dropped (0184) and nothing re-creates it", () => {
    const creates = files.filter((f) =>
      /create\s+(or\s+replace\s+)?function\s+public\.set_patient_context/i.test(
        readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
      ),
    );
    expect(creates.every((f) => f < "0184")).toBe(true);
    const drop = readFileSync(join(MIGRATIONS_DIR, "0184_patient_lifecycle_locks.sql"), "utf8");
    expect(drop).toMatch(/drop\s+function\s+if\s+exists\s+public\.set_patient_context\(uuid\)/i);
  });
```
(`files`, `MIGRATIONS_DIR`, `readFileSync`, `join` are already defined/imported at the top of that file — check the names and reuse them.) Run: `npx vitest run src/lib/patients/active-views.test.ts` — PASS.

- [ ] **Step 5: Commit** — `feat(db): portal identity from the JWT only, drop set_patient_context, skip summary (0184 part 13)`.

---

### Task 15: Post-conditions, catalog sweep, and the neighbouring smokes

**Files:** migration (section (11)), 0184 smoke.

- [ ] **Step 1: Add smoke section s14 (catalog sweep).**

```sql
-- --- s14: catalog sweep --------------------------------------------------------------------
do $s14$
declare
  k_tables constant text[] := array['visits', 'appointments', 'patient_consents', 'appointment_attachments',
    'test_requests', 'payments', 'visit_pins', 'results', 'result_test_requests', 'result_values',
    'result_amendments', 'critical_alerts', 'hmo_claim_items', 'hmo_payment_allocations',
    'hmo_claim_resolutions', 'doctor_pf_entries'];
  t text;
begin
  foreach t in array k_tables loop
    perform pg_temp.expect('s14.1 guard present, enabled, first: ' || t,
      (select string_agg(tgname || ':' || tgenabled, ',') from (
         select tg.tgname, tg.tgenabled from pg_trigger tg
          where tg.tgrelid = ('public.' || t)::regclass and not tg.tgisinternal
            and (tg.tgtype & 2) = 2 and (tg.tgtype & 1) = 1
          order by tg.tgname collate "C" limit 1) f),
      'a_lifecycle_guard:O');
  end loop;
  perform pg_temp.expect('s14.2 no guard on patients-independent tables',
    (select count(*)::text from pg_trigger where tgname = 'a_lifecycle_guard'
       and tgrelid::regclass::text not in (select 'public.' || x from unnest(k_tables) x)
       and tgrelid::regclass::text not in (select x from unnest(k_tables) x)), '0');
  perform pg_temp.expect('s14.3 every 0184 definer function is owned by postgres and search_path-pinned',
    (select coalesce(string_agg(p.proname, ','), 'none') from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('lifecycle_lock', 'lifecycle_lock_and_assert', 'lifecycle_lock_results', 'lifecycle_patients_of_visits',
          'lifecycle_patients_of_test_requests', 'lifecycle_patients_of_result', 'lifecycle_patients_of_hmo_items',
          'lifecycle_patients_of_payments', 'lifecycle_patients_of_amendments', 'lifecycle_patients_of_allocations',
          'lifecycle_via', 'lifecycle_result_ids_of_row', 'recompute_hmo_batch_status',
          'lifecycle_patients_of_row', 'enforce_patient_activity',
          'create_visit_encounter', 'result_create_linked', 'record_hmo_settlement',
          'reschedule_closure_appointments', 'current_patient_id')
        and (r.rolname <> 'postgres' or not p.prosecdef
             or not (p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%'))), 'none');
  perform pg_temp.expect('s14.4 nothing new is callable by anon',
    (select coalesce(string_agg(p.proname, ','), 'none') from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('lifecycle_lock', 'lifecycle_lock_and_assert', 'lifecycle_norm', 'enforce_patient_activity',
          'create_visit_encounter', 'result_create_linked', 'record_hmo_settlement',
          'reschedule_closure_appointments', 'notification_skip_summary', 'resolve_patient_guarded',
          'result_save_draft', 'result_finalise_commit', 'result_edit_commit', 'correct_payment',
          'appointments_insert_slot_guarded')
        and has_function_privilege('anon', p.oid, 'execute')), 'none');
  -- Every FK from a guarded table into a patient-bearing table is one the row
  -- resolver follows (Facts table). A new such column fails here until
  -- lifecycle_patients_of_row learns it (Codex plan review P1-1).
  perform pg_temp.expect('s14.5 the resolver knows every patient-bearing FK',
    (select string_agg(c.conrelid::regclass::text || '.' || a.attname, ',' order by 1)
       from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and cardinality(c.conkey) = 1
        and c.conrelid::regclass::text = any(k_tables)
        and c.confrelid::regclass::text in ('patients', 'visits', 'test_requests', 'payments', 'results',
              'result_amendments', 'hmo_claim_items', 'hmo_payment_allocations')),
    'appointment_attachments.patient_id,appointments.patient_id,critical_alerts.patient_id,critical_alerts.result_id,'
    || 'critical_alerts.test_request_id,critical_alerts.withdrawn_by_amendment,doctor_pf_entries.hmo_allocation_id,'
    || 'doctor_pf_entries.test_request_id,hmo_claim_items.test_request_id,hmo_claim_resolutions.item_id,'
    || 'hmo_payment_allocations.item_id,hmo_payment_allocations.payment_id,patient_consents.patient_id,'
    || 'payments.corrects_payment_id,payments.visit_id,result_amendments.result_id,result_amendments.test_request_id,'
    || 'result_test_requests.result_id,result_test_requests.test_request_id,result_values.result_id,'
    || 'test_requests.parent_id,test_requests.visit_id,visit_pins.visit_id,visits.patient_id');
end
$s14$;
```

- [ ] **Step 2: Add section (11) — post-conditions that abort the deploy if anything is missing.**

```sql
-- ---------------------------------------------------------------------------
-- (11) Post-conditions. Abort the migration if any guarded table lacks its
-- enabled a_lifecycle_guard, if set_patient_context survived, if delete /
-- restore still take FOR UPDATE, or if anon can execute a writer.
-- ---------------------------------------------------------------------------
do $post$
declare
  t text;
  f text;
begin
  foreach t in array array['visits', 'appointments', 'patient_consents', 'appointment_attachments',
    'test_requests', 'payments', 'visit_pins', 'results', 'result_test_requests', 'result_values',
    'result_amendments', 'critical_alerts', 'hmo_claim_items', 'hmo_payment_allocations',
    'hmo_claim_resolutions', 'doctor_pf_entries'] loop
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass
                    and tgname = 'a_lifecycle_guard' and tgenabled = 'O') then
      raise exception '0184 post-condition: public.% has no enabled a_lifecycle_guard', t;
    end if;
  end loop;
  if to_regprocedure('public.set_patient_context(uuid)') is not null then
    raise exception '0184 post-condition: set_patient_context still exists';
  end if;
  foreach f in array array['public.delete_patient(uuid,text,text,uuid,jsonb)', 'public.restore_patient(uuid,uuid,jsonb)',
                          'public.recompute_hmo_batch_status(uuid)'] loop
    if pg_get_functiondef(f::regprocedure) !~* 'for\s+no\s+key\s+update' then
      raise exception '0184 post-condition: % does not take FOR NO KEY UPDATE', f;
    end if;
  end loop;
  foreach f in array array['public.create_visit_encounter(uuid,uuid,text,jsonb,uuid,jsonb)',
    'public.result_create_linked(uuid,uuid[],text,uuid,text,integer,text)',
    'public.record_hmo_settlement(uuid,uuid,numeric,timestamp with time zone,jsonb,text,jsonb)',
    'public.reschedule_closure_appointments(date,uuid,boolean,jsonb)',
    'public.lifecycle_lock_and_assert(uuid[],boolean)',
    'public.lifecycle_lock_results(uuid[],boolean)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '0184 post-condition: % is executable by a client role', f;
    end if;
  end loop;
end
$post$;
```

- [ ] **Step 3: Apply, run the 0184 smoke — PASS** (s1–s14, every notice OK).

- [ ] **Step 4: Run every smoke the change can touch**, one by one, each must be all OK / no ERROR: `0167_patient_soft_delete_smoke.sql` (after Task 4 Step 6's edits), `0147_hmo_claim_delete_guard_smoke.sql`, `0161_payment_correction_smoke.sql`, `0172_result_edit_commit_smoke.sql`, `0174_correct_payment_stale_guard_smoke.sql`, `0163_drm_id_width_smoke.sql`, `0151_rls_initplan_smoke.sql`, `0043_eod_cash_reconciliation_smoke.sql`, `0030_op_gl_bridge_smoke.sql`, `0028_gl_foundation_smoke.sql`, `0044_payroll_smoke.sql`, `0149_ap_cash_bill_payment_drawer_smoke.sql`, `0152_cash_journal_descriptions_smoke.sql`. Apply the Task 4 Step 6 rule to any 0167 failure; for any other file, a failure is a 0184 bug until proven otherwise.

- [ ] **Step 5: Re-apply the whole migration twice in a row** (re-runnable check): the apply command twice, both clean.

- [ ] **Step 6: The replay-order standing gate** (Codex plan review P1-3). Create `src/lib/patients/lifecycle-owned-functions.test.ts`. It makes the replay rule in Facts enforceable on OTHER branches: after they rebase onto a main that holds 0184, their `npm test` fails until they move a re-creation of a 0184-owned function out of their lower-numbered file.

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDIT_COMMIT_0179_HUNKS } from "@/lib/results/edit-commit-0179-hunks";

// 0184 (patient lifecycle locks) owns the FINAL body of these functions.
// A fresh replay applies migrations in NUMBER order, prod in SHIP order, so
// both must end on a body that carries 0184's lock (Codex plan review P1-3):
//  1. the highest-numbered definition carries the function's lifecycle marker;
//  2. no migration numbered below 0184 defines it except those already on
//     main when 0184 shipped (frozen below). A branch numbered below 0184
//     that still needs to change one of these (0170 sheet-sync:
//     resolve_patient_guarded; 0183 waived-balance: correct_payment) must
//     put that re-creation in a NEW migration, claimed fresh, numbered above
//     0184, whose body is 0184's plus its own edits.
//  3. 0184's result_edit_commit still carries every 0179 hunk.

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const FILES = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const LIFECYCLE = "0184_patient_lifecycle_locks.sql";

type Owned = { marker: (body: string) => boolean; allowedBelow: readonly string[] };

// allowedBelow: FROZEN at implementation from `git grep -liE "function +public\.<name>\(" origin/main -- supabase/migrations`
// on the rebased branch (Task 0 Step 1) — fill each list from that output, never by hand-guessing.
export const OWNED: Record<string, Owned> = {
  delete_patient: { marker: (b) => /for\s+no\s+key\s+update/i.test(b), allowedBelow: [/* e.g. "0167_patient_soft_delete.sql" */] },
  restore_patient: { marker: (b) => /for\s+no\s+key\s+update/i.test(b), allowedBelow: [] },
  result_save_draft: { marker: (b) => /lifecycle_lock_results[\s\S]*lifecycle_lock_and_assert/.test(b), allowedBelow: [] },
  result_finalise_commit: { marker: (b) => /lifecycle_lock_results[\s\S]*lifecycle_lock_and_assert/.test(b), allowedBelow: [] },
  result_edit_commit: { marker: (b) => /lifecycle_lock_results[\s\S]*lifecycle_lock_and_assert/.test(b), allowedBelow: [] },
  correct_payment: { marker: (b) => /lifecycle_lock_and_assert/.test(b), allowedBelow: [] },
  appointments_insert_slot_guarded: { marker: (b) => /lifecycle_lock_and_assert/.test(b), allowedBelow: [] },
  resolve_patient_guarded: { marker: (b) => /lifecycle_lock\(/.test(b) && /lower\(p\.last_name\)/.test(b), allowedBelow: [] },
  current_patient_id: { marker: (b) => !/app\.current_patient_id/.test(b), allowedBelow: [] },
  recompute_hmo_batch_status: { marker: (b) => /for\s+no\s+key\s+update/i.test(b), allowedBelow: [] },
};

/** Every definition of public.<name>(…) in the given files: [file, body] in file order. */
export function definitions(files: { name: string; text: string }[], name: string): [string, string][] {
  const head = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "gi");
  const out: [string, string][] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(head)) {
      const end = f.text.indexOf("\n$$;", m.index!);
      out.push([f.name, f.text.slice(m.index!, end < 0 ? undefined : end)]);
    }
  }
  return out;
}

/** Problems with the owned functions over a migration set (pure, so it can be mutation-tested). */
export function ownedFunctionProblems(files: { name: string; text: string }[]): string[] {
  const problems: string[] = [];
  for (const [name, o] of Object.entries(OWNED)) {
    const defs = definitions(files, name);
    const last = defs.at(-1);
    if (!last) { problems.push(`${name}: no definition`); continue; }
    if (last[0] < LIFECYCLE) problems.push(`${name}: last defined in ${last[0]}, below 0184`);
    if (!o.marker(last[1])) problems.push(`${name}: its highest-numbered definition (${last[0]}) lost the 0184 lifecycle marker`);
    for (const [file] of defs) {
      if (file < LIFECYCLE && !o.allowedBelow.includes(file)) {
        problems.push(`${name}: re-created in ${file}, numbered below 0184 — move it to a new migration above 0184 (see the replay rule)`);
      }
    }
  }
  return problems;
}

const real = FILES.map((name) => ({ name, text: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));

describe("0184-owned functions survive replay AND ship order", () => {
  it("no problems on the real migrations", () => {
    expect(ownedFunctionProblems(real)).toEqual([]);
  });

  it("mutation: a lower-numbered branch re-creating correct_payment is caught", () => {
    const body = definitions(real, "correct_payment").at(-1)![1];
    const intruder = { name: "0183_waived_balance_gl.sql", text: `${body}\n$$;` };
    const files = [...real, intruder].sort((a, b) => a.name.localeCompare(b.name));
    expect(ownedFunctionProblems(files).join("\n")).toMatch(/correct_payment: re-created in 0183_waived_balance_gl\.sql/);
  });

  it("mutation: a higher-numbered definition without the lock is caught", () => {
    const files = [...real, { name: "9999_later.sql", text: "create or replace function public.correct_payment(x uuid) returns void language sql as $$ select 1\n$$;" }];
    expect(ownedFunctionProblems(files).join("\n")).toMatch(/correct_payment: its highest-numbered definition \(9999_later\.sql\) lost/);
  });

  it("0184's result_edit_commit still carries every 0179 hunk", () => {
    const body = definitions(real, "result_edit_commit").find(([f]) => f === LIFECYCLE)![1];
    for (const h of EDIT_COMMIT_0179_HUNKS) expect(body, h.label).toContain(h.to);
  });
});
```
Fill every `allowedBelow` from the grep (each list is the files on main that define the function today, e.g. `result_edit_commit` → `0172_…`, `0176_…`, `0179_…`). Run `npx vitest run src/lib/patients/lifecycle-owned-functions.test.ts` — PASS. Mutation: temporarily delete `"0179_result_copy_followups.sql"` from `result_edit_commit.allowedBelow` → the first test FAILS naming it; restore. (If `definitions` trips on a `create function` with a different `$tag$` than `$$`, extend the end search to that tag rather than loosening the checks.)

- [ ] **Step 7: Commit** — `feat(db): 0184 post-conditions, catalog sweep and the replay-order gate`.

---
### Task 16: Two-connection race script (`npm run smoke:locks`)

Single-connection smokes cannot show *ordering*. This script opens two `pg` connections and interleaves them: for each race it proves the loser **waited** (the query was still pending 400 ms after it started) — and, where it matters, **on which lock** (`waitingOn` reads the waiter's ungranted `pg_locks` row: the lifecycle or membership advisory lock, or a row; elapsed time alone does not say what blocked it — Codex plan review P3) — and then got the right outcome — writer-first ⇒ the delete sees the writer's blocker (P0059); delete-first ⇒ the writer is refused (P0058). It follows `scripts/smoke-print.ts`: `load-env` → `requireLocalOrExplicitProd` → refuse a non-local DB URL → `new pg.Client({ connectionString })`.

**Files:**
- Create: `scripts/smoke-lifecycle-locks.ts`
- Modify: `package.json` (script `"smoke:locks": "tsx scripts/smoke-lifecycle-locks.ts"`, next to `smoke:print`)

- [ ] **Step 1: Write the script.**

```ts
/**
 * smoke:locks — two-connection races for the patient lifecycle lock (0184).
 *
 * LOCAL ONLY. Creates its own staff/patients/visits/claims, runs each race
 * with two real connections (A = the lifecycle change, B = the writer), and
 * removes everything it created in `finally` (payments are hard-deleted, so
 * bridge_payment_delete leaves a net-zero reversal pair in the local ledger).
 *
 * Every race asserts BOTH that the second party waited and what it got.
 * Run: npm run smoke:locks   (needs the local stack with 0184 applied)
 */
import "./lib/load-env";
import { requireLocalOrExplicitProd, hostOf, isLocalHost } from "./lib/env-guard";
import { randomUUID } from "node:crypto";
import pg from "pg";

requireLocalOrExplicitProd("smoke:locks", {
  writes:
    "creates and then removes temporary staff, patients, visits, lines, results, payments, appointments, one closure day it inserted itself and HMO claim rows (payment deletes leave net-zero reversal journal entries)",
});

const DB_URL =
  process.env.SMOKE_LOCKS_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!isLocalHost(hostOf(DB_URL))) {
  console.error("smoke:locks takes real locks and writes fixtures — it runs against the LOCAL stack only.");
  process.exit(1);
}

const ADMIN = randomUUID();
const RECEPTION = randomUUID();
const HMO = randomUUID();
const SERVICE = randomUUID();
const TAG = `LKR${Date.now().toString(36).toUpperCase()}`;
const made = {
  patients: [] as string[],
  batches: [] as string[],
  results: [] as string[],
  // closed_on values THIS run inserted (clinic_closures' PK is closed_on) —
  // cleanup deletes only these, never a closure that was already there (P2-7).
  closures: [] as string[],
};
let seq = 0;

type Client = pg.Client & { pid: number };
const results: { name: string; ok: boolean; detail: string }[] = [];

async function connect(): Promise<Client> {
  const c = new pg.Client({ connectionString: DB_URL }) as Client;
  await c.connect();
  await c.query("set lock_timeout = '15s'");
  c.pid = (await c.query("select pg_backend_pid() as pid")).rows[0].pid as number;
  return c;
}

/** What connection `c` is waiting for right now, read from pg_locks by `s`. */
async function waitingOn(s: Client, c: Client): Promise<string> {
  const { rows } = await s.query(
    `select case when locktype = 'advisory' and classid = (hashtext('patient_lifecycle'))::oid then 'lifecycle'
                 when locktype = 'advisory' and classid = (hashtext('result_membership'))::oid then 'membership'
                 when locktype in ('transactionid', 'tuple') then 'row'
                 else locktype end as what
       from pg_locks where pid = $1 and not granted limit 1`,
    [c.pid],
  );
  return rows[0]?.what ?? "none";
}

/** A past Manila day with no closure and no appointment on it — verified, not assumed (P2-7). */
async function isolatedPastDay(s: Client): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const y = 1975 + Math.floor(Math.random() * 20);
    const m = 1 + Math.floor(Math.random() * 12);
    const d = 1 + Math.floor(Math.random() * 28);
    const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const { rows } = await s.query(
      `select exists (select 1 from public.clinic_closures where closed_on = $1::date)
           or exists (select 1 from public.appointments
                       where scheduled_at >= ($1::date)::timestamp at time zone 'Asia/Manila'
                         and scheduled_at <  ($1::date + 1)::timestamp at time zone 'Asia/Manila') as taken`,
      [day],
    );
    if (!rows[0].taken) return day;
  }
  throw new Error("could not find an empty past day for the closure race");
}

/** The appointment ids on a Manila day. */
async function appointmentsOn(s: Client, day: string): Promise<string[]> {
  const { rows } = await s.query(
    `select id from public.appointments
      where scheduled_at >= ($1::date)::timestamp at time zone 'Asia/Manila'
        and scheduled_at <  ($1::date + 1)::timestamp at time zone 'Asia/Manila' order by id`,
    [day],
  );
  return rows.map((r) => r.id as string);
}

/** SQLSTATE a promise rejected with, or "ok". */
async function stateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? `error: ${(e as Error).message}`;
  }
}

/** True when `p` is still pending after `ms` — i.e. it is waiting on a lock. */
async function stillWaiting(p: Promise<unknown>, ms = 400): Promise<boolean> {
  const pending = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  return winner === pending;
}

function expectEq(label: string, got: unknown, want: unknown) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function race(name: string, fn: (a: Client, b: Client, s: Client) => Promise<void>) {
  const a = await connect();
  const b = await connect();
  const s = await connect();
  try {
    await fn(a, b, s);
    results.push({ name, ok: true, detail: "" });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
  } finally {
    for (const c of [a, b]) await c.query("rollback").catch(() => undefined);
    await Promise.all([a.end(), b.end(), s.end()]);
  }
}

// --- fixtures (setup client `s`, autocommit) ----------------------------------
async function mkPatient(s: Client, label: string): Promise<{ id: string; email: string; last: string }> {
  seq += 1;
  const last = `Lkr${seq}${label}`;
  const email = `${TAG.toLowerCase()}-${seq}@example.test`;
  const { rows } = await s.query(
    `insert into public.patients (drm_id, first_name, last_name, birthdate, email)
     values ($1, 'Race', $2, '1990-01-01', $3) returning id`,
    [`DRM-${TAG}-${seq}`, last, email],
  );
  made.patients.push(rows[0].id);
  return { id: rows[0].id, email, last };
}
async function mkVisit(s: Client, patientId: string, hmo = false): Promise<string> {
  const { rows } = await s.query(
    `insert into public.visits (patient_id, payment_status, total_php, paid_php, hmo_provider_id)
     values ($1, 'unpaid', 0, 0, $2) returning id`,
    [patientId, hmo ? HMO : null],
  );
  return rows[0].id;
}
async function mkLine(s: Client, visitId: string, status: string, price: number): Promise<string> {
  const { rows } = await s.query(
    `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
     values ($1, $2, $3, $4, $5, $5) returning id`,
    [visitId, SERVICE, status, ADMIN, price],
  );
  return rows[0].id;
}
async function mkPayment(s: Client, visitId: string, amount: number, method = "cash"): Promise<string> {
  const { rows } = await s.query(
    `insert into public.payments (visit_id, amount_php, method, received_by) values ($1, $2, $3, $4) returning id`,
    [visitId, amount, method, RECEPTION],
  );
  return rows[0].id;
}
/** A patient with one released, fully paid visit: kept history, nothing open. */
async function mkDeletable(s: Client, label: string) {
  const p = await mkPatient(s, label);
  const v = await mkVisit(s, p.id);
  await s.query(`update public.visits set total_php = 100 where id = $1`, [v]);
  const line = await mkLine(s, v, "released", 100);
  const pay = await mkPayment(s, v, 100);
  await assertDeletable(s, p.id);
  return { ...p, visit: v, line, pay };
}
async function assertDeletable(s: Client, patientId: string) {
  const { rows } = await s.query(`select public.patient_delete_blockers($1) as b`, [patientId]);
  const blockers = rows[0].b as unknown[];
  if (blockers.length > 0) {
    throw new Error(`fixture is not deletable — adjust it, blockers: ${JSON.stringify(blockers)}`);
  }
}
const del = (c: Client, patientId: string) =>
  c.query(`select public.delete_patient($1, 'test_record', '', $2, '{}'::jsonb)`, [patientId, ADMIN]);
const tomorrowIso = () => new Date(Date.now() + 36 * 3600_000).toISOString();

async function setup(s: Client) {
  await s.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $3, '', now(), now(), now()),
            ($2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $4, '', now(), now(), now())`,
    [ADMIN, RECEPTION, `${TAG.toLowerCase()}-admin@example.test`, `${TAG.toLowerCase()}-rec@example.test`],
  );
  await s.query(
    `insert into public.staff_profiles (id, full_name, role, is_active)
     values ($1, 'Race Admin', 'admin', true), ($2, 'Race Reception', 'reception', true)`,
    [ADMIN, RECEPTION],
  );
  await s.query(`insert into public.services (id, code, name, price_php, kind) values ($1, $2, 'Race lab', 100, 'lab_test')`, [
    SERVICE,
    `${TAG}-LAB`,
  ]);
  await s.query(`insert into public.hmo_providers (id, name) values ($1, $2)`, [HMO, `${TAG} HMO`]);
}

async function cleanup(s: Client) {
  const ids = made.patients;
  if (ids.length === 0) return;
  // Restore anything we deleted, so the guards let the teardown through.
  await s.query(
    `select public.restore_patient(p.id, $2, '{}'::jsonb) from public.patients p
      where p.id = any($1::uuid[]) and p.deleted_at is not null`,
    [ids, ADMIN],
  );
  const steps = [
    `delete from public.hmo_payment_allocations where item_id in (select i.id from public.hmo_claim_items i join public.test_requests tr on tr.id = i.test_request_id join public.visits v on v.id = tr.visit_id where v.patient_id = any($1::uuid[]))`,
    `delete from public.payments where visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`,
    `delete from public.hmo_claim_items where test_request_id in (select tr.id from public.test_requests tr join public.visits v on v.id = tr.visit_id where v.patient_id = any($1::uuid[]))`,
    `delete from public.test_requests where parent_id is not null and visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`,
    `delete from public.test_requests where visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`,
    `delete from public.visits where patient_id = any($1::uuid[])`,
    `delete from public.appointments where patient_id = any($1::uuid[])`,
    `delete from public.audit_log where patient_id = any($1::uuid[])`,
    `delete from public.patients where id = any($1::uuid[])`,
  ];
  // Results first: their links reference test_requests with ON DELETE RESTRICT.
  if (made.results.length > 0) await s.query(`delete from public.results where id = any($1::uuid[])`, [made.results]);
  for (const sql of steps) await s.query(sql, [ids]);
  if (made.batches.length > 0) await s.query(`delete from public.hmo_claim_batches where id = any($1::uuid[])`, [made.batches]);
  // Only the days THIS run inserted (recorded from the insert that succeeded).
  if (made.closures.length > 0) await s.query(`delete from public.clinic_closures where closed_on = any($1::date[])`, [made.closures]);
  await s.query(`delete from public.audit_log where actor_id = any($1::uuid[])`, [[ADMIN, RECEPTION]]);
  await s.query(`delete from public.services where id = $1`, [SERVICE]);
  await s.query(`delete from public.hmo_providers where id = $1`, [HMO]);
  await s.query(`delete from public.staff_profiles where id = any($1::uuid[])`, [[ADMIN, RECEPTION]]);
  await s.query(`delete from auth.users where id = any($1::uuid[])`, [[ADMIN, RECEPTION]]);
}

// --- races ----------------------------------------------------------------------
async function main() {
  const s = await connect();
  try {
    await setup(s);

    await race("delete first → new visit refused", async (a, b, s2) => {
      const p = await mkPatient(s2, "DV");
      await a.query("begin");
      await del(a, p.id);
      await b.query("begin");
      const w = stateOf(b.query(`insert into public.visits (patient_id, payment_status, total_php, paid_php) values ($1, 'unpaid', 0, 0)`, [p.id]));
      expectEq("writer waited", await stillWaiting(w), true);
      expectEq("…on the lifecycle lock (not a row)", await waitingOn(s2, b), "lifecycle");
      await a.query("commit");
      expectEq("writer outcome", await w, "P0058");
    });

    await race("new visit first → delete sees it (P0059)", async (a, b, s2) => {
      const p = await mkPatient(s2, "VD");
      await b.query("begin");
      await b.query(`insert into public.visits (patient_id, payment_status, total_php, paid_php) values ($1, 'unpaid', 0, 0)`, [p.id]);
      await a.query("begin");
      const d = stateOf(del(a, p.id));
      expectEq("delete waited", await stillWaiting(d), true);
      expectEq("…on the lifecycle lock", await waitingOn(s2, a), "lifecycle");
      await b.query("commit");
      expectEq("delete outcome", await d, "P0059");
    });

    await race("delete first → booking RPC refused", async (a, b, s2) => {
      const p = await mkPatient(s2, "DA");
      await a.query("begin");
      await del(a, p.id);
      const rows = JSON.stringify([{ patient_id: p.id, status: "confirmed", scheduled_at: tomorrowIso() }]);
      const w = stateOf(b.query(`select public.appointments_insert_slot_guarded($1::jsonb)`, [rows]));
      expectEq("booking waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("booking outcome", await w, "P0058");
    });

    await race("booking first → delete sees the appointment (P0059)", async (a, b, s2) => {
      const p = await mkPatient(s2, "AD");
      const rows = JSON.stringify([{ patient_id: p.id, status: "confirmed", scheduled_at: tomorrowIso() }]);
      await b.query("begin");
      await b.query(`select public.appointments_insert_slot_guarded($1::jsonb)`, [rows]);
      await a.query("begin");
      const d = stateOf(del(a, p.id));
      expectEq("delete waited", await stillWaiting(d), true);
      await b.query("commit");
      expectEq("delete outcome", await d, "P0059");
    });

    await race("delete first → new line on an old visit refused", async (a, b, s2) => {
      const p = await mkDeletable(s2, "DL");
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(
        `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php) values ($1, $2, 'requested', $3, 10, 10)`,
        [p.visit, SERVICE, ADMIN]));
      expectEq("writer waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("writer outcome", await w, "P0058");
    });

    await race("delete first → payment void refused", async (a, b, s2) => {
      const p = await mkDeletable(s2, "DP");
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(
        `update public.payments set voided_at = now(), voided_by = $2, void_reason = 'race' where id = $1`, [p.pay, ADMIN]));
      expectEq("void waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("void outcome", await w, "P0058");
    });

    await race("delete first → visit restore refused", async (a, b, s2) => {
      const p = await mkDeletable(s2, "DR");
      const v2 = await mkVisit(s2, p.id);
      await s2.query(`update public.visits set deleted_at = now(), deleted_by = $2, delete_reason = 'race' where id = $1`, [v2, ADMIN]);
      await assertDeletable(s2, p.id);
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(
        `update public.visits set deleted_at = null, deleted_by = null, delete_reason = null where id = $1`, [v2]));
      expectEq("restore waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("restore outcome", await w, "P0058");
    });

    await race("delete first → HMO batch reopen refused", async (a, b, s2) => {
      const p = await mkPatient(s2, "DH");
      const v = await mkVisit(s2, p.id, true);
      await s2.query(`update public.visits set total_php = 100 where id = $1`, [v]);
      const line = await mkLine(s2, v, "released", 100);
      await s2.query(`update public.test_requests set hmo_approved_amount_php = 100, hmo_provider_id = $2 where id = $1`, [line, HMO]);
      const b1 = (await s2.query(`insert into public.hmo_claim_batches (provider_id, status) values ($1, 'submitted') returning id`, [HMO])).rows[0].id;
      const b2 = (await s2.query(`insert into public.hmo_claim_batches (provider_id, status) values ($1, 'submitted') returning id`, [HMO])).rows[0].id;
      made.batches.push(b1, b2);
      await s2.query(`insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values ($1, $2, 100)`, [b1, line]);
      await s2.query(`update public.hmo_claim_batches set voided_at = now(), voided_by = $2, void_reason = 'race', status = 'voided' where id = $1`, [b1, ADMIN]);
      const i2 = (await s2.query(`insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values ($1, $2, 100) returning id`, [b2, line])).rows[0].id;
      const pay = await mkPayment(s2, v, 100, "hmo");
      await s2.query(`insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values ($1, $2, 100)`, [pay, i2]);
      await assertDeletable(s2, p.id);
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(
        `update public.hmo_claim_batches set voided_at = null, voided_by = null, void_reason = null, status = 'submitted' where id = $1`, [b1]));
      expectEq("reopen waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("reopen outcome", await w, "P0058");
    });

    await race("delete first → patient edit refused", async (a, b, s2) => {
      const p = await mkPatient(s2, "DE");
      await a.query("begin");
      await del(a, p.id);
      const w = stateOf(b.query(`update public.patients set phone = '09170000000' where id = $1`, [p.id]));
      expectEq("edit waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("edit outcome", await w, "P0058");
    });

    await race("resolver blocked behind a delete re-reads (P0072), retry gets a fresh record", async (a, b, s2) => {
      const p = await mkPatient(s2, "RB");
      const fields = JSON.stringify({ first_name: "Race", last_name: p.last, birthdate: "1990-01-01", email: p.email });
      await a.query("begin");
      await del(a, p.id);
      const resolve = () => b.query(`select * from public.resolve_patient_guarded($1, $2, '1990-01-01', $3::jsonb)`, [p.email, p.last, fields]);
      const w = stateOf(resolve());
      expectEq("resolver waited", await stillWaiting(w), true);
      await a.query("commit");
      expectEq("resolver outcome", await w, "P0072");
      const again = await resolve();
      expectEq("retry reused", again.rows[0].reused, false);
      made.patients.push(again.rows[0].id);
      if (again.rows[0].id === p.id) throw new Error("retry reused the deleted record");
    });

    await race("two resolves of a deleted identity → one fresh record", async (a, b, s2) => {
      const p = await mkPatient(s2, "RR");
      await del(s2, p.id);
      const fields = JSON.stringify({ first_name: "Race", last_name: p.last, birthdate: "1990-01-01", email: p.email });
      const q = `select * from public.resolve_patient_guarded($1, $2, '1990-01-01', $3::jsonb)`;
      await a.query("begin");
      const first = await a.query(q, [p.email, p.last, fields]);
      await b.query("begin");
      const second = b.query(q, [p.email, p.last, fields]);
      expectEq("second waited on the identity lock", await stillWaiting(second), true);
      await a.query("commit");
      const got = await second;
      await b.query("commit");
      made.patients.push(first.rows[0].id);
      expectEq("first created", first.rows[0].reused, false);
      expectEq("second reused the same fresh record", `${got.rows[0].id}|${got.rows[0].reused}`, `${first.rows[0].id}|true`);
    });

    await race("delayed booking after resolution is refused once the record is deleted", async (a, b, s2) => {
      const p = await mkPatient(s2, "RL");
      const fields = JSON.stringify({ first_name: "Race", last_name: p.last, birthdate: "1990-01-01", email: p.email });
      const r = await b.query(`select * from public.resolve_patient_guarded($1, $2, '1990-01-01', $3::jsonb)`, [p.email, p.last, fields]);
      expectEq("resolved to the existing record", r.rows[0].id, p.id);
      await del(a, p.id);
      const rows = JSON.stringify([{ patient_id: p.id, status: "confirmed", scheduled_at: tomorrowIso() }]);
      expectEq("booking outcome", await stateOf(b.query(`select public.appointments_insert_slot_guarded($1::jsonb)`, [rows])), "P0058");
    });

    await race("a record moved to another patient while the writer waited → P0072", async (a, b, s2) => {
      const p = await mkPatient(s2, "MP");
      const q = await mkPatient(s2, "MQ");
      const v = await mkVisit(s2, p.id);
      await a.query("begin");
      await a.query(`update public.visits set patient_id = $2 where id = $1`, [v, q.id]);
      await b.query("begin");
      const w = stateOf(b.query(
        `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php) values ($1, $2, 'requested', $3, 10, 10)`,
        [v, SERVICE, ADMIN]));
      expectEq("writer waited", await stillWaiting(w), true);
      expectEq("…on the lifecycle lock", await waitingOn(s2, b), "lifecycle");
      await a.query("commit");
      expectEq("writer outcome", await w, "P0072");
    });

    await race("deadlock aborts the whole transaction; a retry succeeds", async (a, b, s2) => {
      const p = await mkPatient(s2, "KP");
      const q = await mkPatient(s2, "KQ");
      const v1 = await mkVisit(s2, p.id);
      const vx = await mkVisit(s2, p.id);
      const tr1 = await mkLine(s2, v1, "requested", 10);
      await a.query("begin");
      await a.query(`update public.test_requests set receptionist_remarks = 'A' where id = $1`, [tr1]); // shared p + row tr1
      await b.query("begin");
      const bMove = stateOf(b.query(`update public.visits set patient_id = $2 where id = $1`, [vx, q.id])); // row vx, waits EXCLUSIVE p
      expectEq("B waited", await stillWaiting(bMove), true);
      const aTouch = stateOf(a.query(`update public.visits set notes = 'A' where id = $1`, [vx])); // waits row vx → cycle
      // The victim settles first (deadlock_timeout); the survivor cannot finish
      // until the victim rolls back, so never await both together.
      const first = await Promise.race([
        aTouch.then((st) => ({ who: "A" as const, st })),
        bMove.then((st) => ({ who: "B" as const, st })),
      ]);
      expectEq("the first to settle is the deadlock victim", first.st, "40P01");
      if (first.who === "A") {
        await a.query("rollback");
        expectEq("B then completes", await bMove, "ok");
        await b.query("commit");
        const { rows } = await s2.query(`select receptionist_remarks from public.test_requests where id = $1`, [tr1]);
        expectEq("victim A's earlier statement was rolled back too", rows[0].receptionist_remarks, null);
        expectEq("A's retry (whole transaction) succeeds",
          await stateOf(a.query(`update public.test_requests set receptionist_remarks = 'A' where id = $1`, [tr1])), "ok");
      } else {
        await b.query("rollback");
        expectEq("A then completes", await aTouch, "ok");
        await a.query("commit");
        const { rows } = await s2.query(`select patient_id from public.visits where id = $1`, [vx]);
        expectEq("victim B's move was rolled back", rows[0].patient_id, p.id);
        expectEq("B's retry succeeds",
          await stateOf(b.query(`update public.visits set patient_id = $2 where id = $1`, [vx, q.id])), "ok");
      }
    });

    // HMO batch rollup (Codex plan review P2-5). Three separate scenarios:
    // both successful settlements COMMIT and the batch ends paid; a competing
    // settlement of one item is refused; and the rollup's own batch lock
    // (not only the RPC's) serialises two plain allocation inserts.
    async function mkBatchOfTwo(s2: Client, label: string) {
      const pa = await mkPatient(s2, `${label}A`);
      const pb = await mkPatient(s2, `${label}B`);
      const va = await mkVisit(s2, pa.id, true);
      const vb = await mkVisit(s2, pb.id, true);
      const bat = (await s2.query(`insert into public.hmo_claim_batches (provider_id, status) values ($1, 'submitted') returning id`, [HMO])).rows[0].id as string;
      made.batches.push(bat);
      const item = async (v: string) =>
        (await s2.query(`insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values ($1, $2, 100) returning id`,
          [bat, await mkLine(s2, v, "released", 100)])).rows[0].id as string;
      return { bat, va, vb, ia: await item(va), ib: await item(vb) };
    }
    const settle = (c: Client, bat: string, item: string) =>
      c.query(`select public.record_hmo_settlement($1, $2, 100, now(), $3::jsonb)`,
        [ADMIN, bat, JSON.stringify([{ item_id: item, amount_php: 100 }])]);
    async function batchState(s2: Client, bat: string) {
      const { rows } = await s2.query(
        `select b.status,
                (select count(*) from public.hmo_claim_items i where i.batch_id = b.id and i.paid_amount_php = i.billed_amount_php)::int as paid_items,
                (select count(*) from public.hmo_payment_allocations al join public.hmo_claim_items i on i.id = al.item_id
                  where i.batch_id = b.id and al.voided_at is null)::int as allocations,
                (select count(*) from public.payments p join public.hmo_payment_allocations al on al.payment_id = p.id
                  join public.hmo_claim_items i on i.id = al.item_id where i.batch_id = b.id and p.voided_at is null)::int as payments
           from public.hmo_claim_batches b where b.id = $1`, [bat]);
      return `${rows[0].status}|${rows[0].paid_items}|${rows[0].allocations}|${rows[0].payments}`;
    }

    await race("two settlements of the last two items of one batch BOTH commit → batch paid", async (a, b, s2) => {
      const f = await mkBatchOfTwo(s2, "S2");
      await a.query("begin");
      await settle(a, f.bat, f.ia);
      await b.query("begin");
      const other = stateOf(settle(b, f.bat, f.ib));
      expectEq("the second settlement waits for the first (batch row)", await stillWaiting(other), true);
      expectEq("…on a row lock, not a patient lock", await waitingOn(s2, b), "row");
      await a.query("commit");
      expectEq("B settled", await other, "ok");
      await b.query("commit");
      expectEq("durable: batch paid, 2 items paid, 2 allocations, 2 payments", await batchState(s2, f.bat), "paid|2|2|2");
    });

    await race("a competing settlement of the SAME item is refused (P0012)", async (a, b, s2) => {
      const f = await mkBatchOfTwo(s2, "SC");
      await a.query("begin");
      await settle(a, f.bat, f.ia);
      await b.query("begin");
      const same = stateOf(settle(b, f.bat, f.ia));
      expectEq("the same item waits", await stillWaiting(same), true);
      await a.query("commit");
      expectEq("the second settlement of that item", await same, "P0012");
      await b.query("rollback");
      expectEq("durable: only A's allocation", await batchState(s2, f.bat), "submitted|1|1|1");
    });

    await race("the rollup itself serialises: two plain allocation inserts on the last two items → batch paid", async (a, b, s2) => {
      const f = await mkBatchOfTwo(s2, "SR");
      const pa = await mkPayment(s2, f.va, 100, "hmo");
      const pb = await mkPayment(s2, f.vb, 100, "hmo");
      const alloc = (c: Client, pay: string, item: string) =>
        c.query(`insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values ($1, $2, 100)`, [pay, item]);
      await a.query("begin");
      await alloc(a, pa, f.ia);
      await b.query("begin");
      const second = stateOf(alloc(b, pb, f.ib));
      expectEq("the second rollup waits on the batch row", await stillWaiting(second), true);
      await a.query("commit");
      expectEq("B allocated", await second, "ok");
      await b.query("commit");
      expectEq("durable: batch paid (the rollup saw A's commit)", (await batchState(s2, f.bat)).split("|")[0], "paid");
    });

    // Result membership (Codex plan review P1-2).
    async function mkResult(s2: Client): Promise<string> {
      const r = (await s2.query(`insert into public.results (generation_kind, uploaded_by) values ('structured', $1) returning id`, [ADMIN])).rows[0].id as string;
      made.results.push(r);
      return r;
    }
    const resultWrite = (c: Client, r: string) =>
      c.query(`update public.results set notes = 'race' where id = $1`, [r]);   // a results-family write (shared membership)
    const link = (c: Client, r: string, tr: string) =>
      c.query(`insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)`, [r, tr]);

    await race("membership: linking a result waits for a writer of that (still unlinked) result", async (a, b, s2) => {
      const p = await mkPatient(s2, "MU");
      const v = await mkVisit(s2, p.id);
      const tr = await mkLine(s2, v, "in_progress", 10);
      const r = await mkResult(s2);
      await a.query("begin");
      await resultWrite(a, r);                       // unlinked: patients {} — only the membership lock
      await b.query("begin");
      const l = stateOf(link(b, r, tr));
      expectEq("the link waited", await stillWaiting(l), true);
      expectEq("…on the membership lock", await waitingOn(s2, b), "membership");
      await a.query("commit");
      expectEq("link outcome", await l, "ok");
      await b.query("commit");
    });

    await race("membership: a writer queued behind a link then locks the NEW patient", async (a, b, s2) => {
      const q = await mkPatient(s2, "MQ2");
      const v = await mkVisit(s2, q.id);
      const tr = await mkLine(s2, v, "in_progress", 10);
      const r = await mkResult(s2);
      await b.query("begin");
      await link(b, r, tr);                          // exclusive membership on r, shared lifecycle on q
      await a.query("begin");
      const w = stateOf(resultWrite(a, r));
      expectEq("the writer waited", await stillWaiting(w), true);
      expectEq("…on the membership lock", await waitingOn(s2, a), "membership");
      await b.query("commit");
      expectEq("writer outcome", await w, "ok");
      const { rows } = await s2.query(
        `select exists (select 1 from pg_locks where pid = $1 and locktype = 'advisory' and granted
                         and classid = (hashtext('patient_lifecycle'))::oid and objid = (hashtext($2::text))::oid) as held`,
        [a.pid, q.id]);
      expectEq("the writer holds the lifecycle lock of the patient the result now belongs to", rows[0].held, true);
      await a.query("commit");
    });

    await race("cancel/no-show never wait for a delete in progress (no lock on the exception path)", async (a, b, s2) => {
      const p = await mkPatient(s2, "CN");
      // A PAST confirmed appointment does not block deletion.
      const ap = (await s2.query(
        `insert into public.appointments (patient_id, status, scheduled_at) values ($1, 'confirmed', now() - interval '10 days') returning id`,
        [p.id])).rows[0].id;
      await assertDeletable(s2, p.id);
      await a.query("begin");
      await del(a, p.id);                       // holds the EXCLUSIVE lifecycle lock
      const w = stateOf(b.query(`update public.appointments set status = 'no_show' where id = $1`, [ap]));
      expectEq("no-show did not wait", await stillWaiting(w, 300), false);
      expectEq("no-show outcome", await w, "ok");
      await a.query("commit");
    });

    await race("closure reschedule: a delete committed first is skipped; a cancel committed first is left alone", async (a, b, s2) => {
      // An ISOLATED past day (Codex plan review P2-7): the RPC acts on every
      // eligible appointment of the day, so the day must hold only ours —
      // checked BEFORE anything is changed. Past, so its confirmed
      // appointments do not block deletion. The closure is inserted with no
      // ON CONFLICT: if it already existed the insert fails and nothing of
      // anyone else's is touched or later deleted.
      const day = await isolatedPastDay(s2);
      await s2.query(`insert into public.clinic_closures (closed_on, reason, created_by) values ($1, 'race', $2)`, [day, ADMIN]);
      made.closures.push(day);                      // recorded only after OUR insert succeeded
      const pd = await mkPatient(s2, "CD");
      const pc = await mkPatient(s2, "CC");
      const pk = await mkPatient(s2, "CK");
      const ins = `insert into public.appointments (patient_id, status, scheduled_at) values ($1, 'confirmed', $2::timestamptz) returning id`;
      const apD = (await s2.query(ins, [pd.id, `${day} 09:00+08`])).rows[0].id as string;
      const apC = (await s2.query(ins, [pc.id, `${day} 10:00+08`])).rows[0].id as string;
      const apK = (await s2.query(ins, [pk.id, `${day} 11:00+08`])).rows[0].id as string;
      expectEq("the day holds exactly our three appointments", (await appointmentsOn(s2, day)).join(","), [apD, apC, apK].sort().join(","));
      await assertDeletable(s2, pd.id);
      await a.query("begin");
      await del(a, pd.id);
      await a.query(`update public.appointments set status = 'cancelled' where id = $1`, [apC]);
      const w = b.query(`select public.reschedule_closure_appointments($1, $2, false, null) as r`, [day, ADMIN]);
      expectEq("reschedule waited", await stillWaiting(w.then(() => undefined)), true);
      expectEq("…on the deleted patient's lifecycle lock", await waitingOn(s2, b), "lifecycle");
      await a.query("commit");
      const r = (await w).rows[0].r as { affected: number; skipped_inactive: number; skipped_changed: number };
      expectEq("only the untouched patient moved", r.affected, 1);
      expectEq("the deleted patient was skipped", r.skipped_inactive, 1);
      expectEq("the cancelled row counted as changed", r.skipped_changed, 1);
      const { rows: moved } = await s2.query(
        `select resource_id from public.audit_log where action = 'appointment.bulk_rescheduled_for_closure'
            and metadata ->> 'closed_on' = $1 order by 1`, [day]);
      expectEq("the moved row is ours and only ours", moved.map((m) => m.resource_id).join(","), apK);
    });
  } finally {
    await cleanup(s).catch((e) => console.error("cleanup failed:", (e as Error).message));
    await s.end();
  }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} races passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
```

- [ ] **Step 2: Add the npm script** in `package.json` next to `"smoke:print"`: `"smoke:locks": "tsx scripts/smoke-lifecycle-locks.ts",`.

- [ ] **Step 3: Run it.** `npm run -s smoke:locks > $SCRATCH/smoke-locks.log 2>&1; echo exit=$?; tail -25 $SCRATCH/smoke-locks.log`
Expected: `21/21 races passed`, `exit=0`. The closure race picks its own empty past day (`isolatedPastDay`) and proves it holds only its three appointments before changing anything; its cleanup deletes only the closure day it inserted.
Mutation checks (each must FAIL, then restore + re-apply): make the junction branch take the SHARED membership lock → both `membership:` races fail (no wait); remove the batch lock from `recompute_hmo_batch_status` → "the rollup itself serialises" fails (batch left `submitted`); remove the batch lock from `record_hmo_settlement` only → "two settlements … BOTH commit" still passes (the rollup lock covers it) — expected, the two locks are belt and braces; note it in the report.
A fixture failure ("fixture is not deletable — adjust it, blockers: […]") means the local blocker rules differ from this plan's assumption — adjust the fixture to clear exactly the listed blocker (the blocker JSON names it), never the assertion. A scenario that ends `got "ok", want "P0058"` is a real hole: stop and debug (superpowers:systematic-debugging).

- [ ] **Step 4: Confirm the guard-coverage test accepts the new runner.** `npx vitest run scripts/lib/guard-coverage.test.ts` — PASS (the script builds no service-role client; the guard call comes first anyway).

- [ ] **Step 5: Commit** — `test(db): two-connection lifecycle-lock races (npm run smoke:locks)`.

---
### Task 17: App foundations — P-codes, retry helper, generated types

**Files:**
- Modify: `src/lib/accounting/pg-errors.ts`, `src/types/database.ts`
- Create: `src/lib/patients/lifecycle-retry.ts`, `src/lib/patients/lifecycle-retry.test.ts`

- [ ] **Step 1: Run the coverage guard — expect FAIL** listing P0072 and P0073: `npx vitest run src/lib/accounting/pg-error-coverage.test.ts`.

- [ ] **Step 2: Translations.** In `pg-errors.ts`, after the `P0067` case and before `default:`:

```ts
    // Patient lifecycle locks (0184). P0072: the record moved to another
    // patient (or the patient was deleted/merged) while this save waited for
    // the lock; the transaction rolled back whole, so trying again is safe —
    // callers retry once automatically (src/lib/patients/lifecycle-retry.ts).
    case "P0072":
      return "This patient's records changed while you were saving. Please try again.";
    // create_visit_encounter (0184): a refusal the SQL words for reception
    // (bad total, malformed package, wrong role) — pass it through.
    case "P0073":
      return err.message
        ? `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}.`
        : "The visit could not be created. Please try again.";
    // A deadlock victim / serialization failure: nothing was saved.
    case "40P01":
    case "40001":
      return "Another change to the same records was being saved at the same moment. Please try again.";
```
Run the guard — PASS.

- [ ] **Step 3: Write the failing retry test** `src/lib/patients/lifecycle-retry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { isLifecycleRetryable, withLifecycleRetry } from "./lifecycle-retry";

type Out = { data: string | null; error: { code?: string | null; message: string } | null };
const ok: Out = { data: "done", error: null };
const err = (code: string | null): Out => ({ data: null, error: { code, message: code ?? "network" } });

describe("isLifecycleRetryable", () => {
  it("retries a moved record, a deadlock and a serialization failure", () => {
    for (const code of ["P0072", "40P01", "40001"]) expect(isLifecycleRetryable({ code })).toBe(true);
  });
  it("never retries a refusal, a missing code or success", () => {
    for (const code of ["P0058", "P0059", "23505", "P0073", null, undefined]) {
      expect(isLifecycleRetryable(code === undefined ? null : { code })).toBe(false);
    }
  });
});

describe("withLifecycleRetry", () => {
  it("returns the first result when it is not retryable", async () => {
    const call = vi.fn(async () => err("P0058"));
    expect(await withLifecycleRetry(call)).toEqual(err("P0058"));
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("calls exactly once more after P0072 and returns the second result", async () => {
    const call = vi.fn<() => Promise<Out>>().mockResolvedValueOnce(err("P0072")).mockResolvedValueOnce(ok);
    expect(await withLifecycleRetry(call)).toEqual(ok);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("does not loop: a second retryable failure is returned as is", async () => {
    const call = vi.fn(async () => err("40P01"));
    expect(await withLifecycleRetry(call)).toEqual(err("40P01"));
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("never retries an unknown outcome (no code) — it may have committed", async () => {
    const call = vi.fn(async () => err(null));
    await withLifecycleRetry(call);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
```
Run: `npx vitest run src/lib/patients/lifecycle-retry.test.ts` — FAIL (module missing).

- [ ] **Step 4: Implement** `src/lib/patients/lifecycle-retry.ts`:

```ts
// Retry-once for the patient lifecycle lock protocol (0184). A transaction
// that loses a race is rolled back WHOLE — P0072 (the record moved to another
// patient, or the patient changed, while it waited for the lock), 40P01
// (chosen as a deadlock victim), 40001 (serialization failure) — so calling
// the same RPC again, in a fresh transaction, can never double-write.
// Exactly one retry: a second loss is shown to the user (translatePgError).
// A call with NO code is an unknown outcome (lost response) and is never
// retried here — it may have committed.
export const LIFECYCLE_RETRYABLE_CODES: ReadonlySet<string> = new Set(["P0072", "40P01", "40001"]);

export function isLifecycleRetryable(err: { code?: string | null } | null | undefined): boolean {
  return !!err?.code && LIFECYCLE_RETRYABLE_CODES.has(err.code);
}

export async function withLifecycleRetry<T extends { error: { code?: string | null } | null }>(
  call: () => PromiseLike<T>,
): Promise<T> {
  const first = await call();
  if (!isLifecycleRetryable(first.error)) return first;
  return await call();
}
```
Run — PASS.

- [ ] **Step 5: Regenerate types.** `npm run db:types` writes the WHOLE local schema, which on the shared stack includes other branches' objects (e.g. 0170's sheet tables). Generate to a temp file and copy in only 0184's changes:

```bash
npx supabase gen types typescript --local > $SCRATCH/database.full.ts
diff <(grep -n "" src/types/database.ts | cut -d: -f2-) $SCRATCH/database.full.ts > $SCRATCH/types.diff; wc -l $SCRATCH/types.diff
```
From the full file, copy into `src/types/database.ts` exactly these `Functions` entries (alphabetical position, same shape as their neighbours): `create_visit_encounter`, `result_create_linked`, `record_hmo_settlement`, `reschedule_closure_appointments`, `notification_skip_summary`, and the internal ones only if the generator lists them (`lifecycle_*`, `enforce_patient_activity` are not callable — leave them out if absent); delete the `set_patient_context` entry. Nothing else changes. `npm run typecheck` — PASS.

- [ ] **Step 6: Commit** — `feat(patients): P0072/P0073 + deadlock translations, retry-once helper, types for 0184`.

---

### Task 18: New visit → `create_visit_encounter`

**Files:**
- Create: `src/lib/visits/encounter-payload.ts`, `src/lib/visits/encounter-payload.test.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`, `src/lib/patients/write-guards.test.ts`

- [ ] **Step 1: Write the failing payload test** `src/lib/visits/encounter-payload.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEncounterVisit, toCentavos, type EncounterLineInput } from "./encounter-payload";

let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const line = (service_id: string, final: number, extra: Partial<EncounterLineInput> = {}): EncounterLineInput => ({
  service_id, base_price_php: final, discount_kind: null, discount_amount_php: 0, final_price_php: final,
  clinic_fee_php: null, doctor_pf_php: null, procedure_description: null, hmo_approved_amount_php: null, ...extra,
});
const hmo = { hmo_provider_id: "h", hmo_approval_date: "2026-09-25", hmo_authorization_no: "A1" };

describe("buildEncounterVisit", () => {
  it("sums the order lines into the visit total", () => {
    const r = buildEncounterVisit({
      lines: [line("s1", 100), line("s2", 250)], decompositions: [], hmo, attendingPhysicianId: null,
      receptionistRemarks: "rm", notes: "n", isSample: false,
    }, nextId);
    expect(r.ok && r.payload.visit.total_php).toBe(350);
  });

  it("turns a package line into a header plus ₱0 components that point at it", () => {
    const r = buildEncounterVisit({
      lines: [line("pkg", 1500, { discount_kind: "senior", discount_amount_php: 300, final_price_php: 1200 })],
      decompositions: [{ headerLine: { service_id: "pkg" }, componentServiceIds: ["c1", "c2"] }],
      hmo, attendingPhysicianId: null, receptionistRemarks: "rm", notes: null, isSample: false,
    }, nextId);
    if (!r.ok) throw new Error(r.error);
    const [header, ...components] = r.payload.lines;
    expect(header).toMatchObject({ service_id: "pkg", is_package_header: true, status: "in_progress", parent_id: null, final_price_php: 1200 });
    expect(components.map((c) => c.service_id)).toEqual(["c1", "c2"]);
    for (const c of components) {
      expect(c).toMatchObject({
        parent_id: header!.id, is_package_header: false, status: "requested", base_price_php: 0,
        discount_kind: null, discount_amount_php: 0, final_price_php: 0, receptionist_remarks: null,
        clinic_fee_php: null, doctor_pf_php: null, procedure_description: null, hmo_approved_amount_php: null,
        hmo_provider_id: "h", hmo_approval_date: "2026-09-25", hmo_authorization_no: "A1",
      });
    }
    expect(r.payload.visit.total_php).toBe(1200);
  });

  it("pairs two lines of the same package with their own decompositions, in order", () => {
    const r = buildEncounterVisit({
      lines: [line("pkg", 100), line("pkg", 200)],
      decompositions: [
        { headerLine: { service_id: "pkg" }, componentServiceIds: ["a"] },
        { headerLine: { service_id: "pkg" }, componentServiceIds: ["b"] },
      ],
      hmo, attendingPhysicianId: null, receptionistRemarks: null, notes: null, isSample: true,
    }, nextId);
    if (!r.ok) throw new Error(r.error);
    const headers = r.payload.lines.filter((l) => l.is_package_header);
    expect(headers.map((h) => h.final_price_php)).toEqual([100, 200]);
    const childOf = (h: { id: string }) => r.payload.lines.filter((l) => l.parent_id === h.id).map((l) => l.service_id);
    expect(headers.map(childOf)).toEqual([["a"], ["b"]]);
    expect(r.payload.visit.is_sample).toBe(true);
  });

  it("refuses a decomposition with no matching order line", () => {
    const r = buildEncounterVisit({
      lines: [line("s1", 100)], decompositions: [{ headerLine: { service_id: "pkg" }, componentServiceIds: ["c"] }],
      hmo, attendingPhysicianId: null, receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    expect(r.ok).toBe(false);
  });

  it("sums fractional prices in centavos: 100.10 + 200.20 is 300.3, not 300.29999999999995", () => {
    const r = buildEncounterVisit({
      lines: [line("s1", 100.1), line("s2", 200.2)], decompositions: [], hmo, attendingPhysicianId: null,
      receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    expect(r.ok && r.payload.visit.total_php).toBe(300.3);
    expect(100.1 + 200.2).not.toBe(300.3); // the float trap this guards against
  });

  it("normalises a float-noisy discounted line to centavos (99.99 − 20 → 79.99)", () => {
    const noisy = 99.99 - 20; // 79.99000000000001
    const r = buildEncounterVisit({
      lines: [line("s1", noisy, { base_price_php: 99.99, discount_kind: "promo", discount_amount_php: 20 })],
      decompositions: [], hmo, attendingPhysicianId: null, receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    if (!r.ok) throw new Error(r.error);
    expect(r.payload.lines[0]!.final_price_php).toBe(79.99);
    expect(r.payload.visit.total_php).toBe(79.99);
  });

  it("each half of a split encounter carries its own centavo total", () => {
    const half = (prices: number[]) => buildEncounterVisit({
      lines: prices.map((p, i) => line(`s${i}`, p)), decompositions: [], hmo, attendingPhysicianId: null,
      receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    const doctor = half([0.1, 0.2]);
    const lab = half([100.1]);
    expect(doctor.ok && doctor.payload.visit.total_php).toBe(0.3);
    expect(lab.ok && lab.payload.visit.total_php).toBe(100.1);
  });

  it("toCentavos rounds float noise to the nearest centavo", () => {
    expect(toCentavos(300.29999999999995)).toBe(30030);
    expect(toCentavos(79.99000000000001)).toBe(7999);
    expect(toCentavos(0)).toBe(0);
  });

  it("gives standalone lines status requested and every line an id", () => {
    const r = buildEncounterVisit({
      lines: [line("s1", 100)], decompositions: [], hmo, attendingPhysicianId: "doc",
      receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    if (!r.ok) throw new Error(r.error);
    expect(r.payload.lines[0]).toMatchObject({ status: "requested", is_package_header: false, parent_id: null });
    expect(r.payload.lines.every((l) => l.id.length === 36)).toBe(true);
    expect(r.payload.visit.attending_physician_id).toBe("doc");
  });
});
```
Run — FAIL (module missing).

- [ ] **Step 2: Implement** `src/lib/visits/encounter-payload.ts` — the pure half of the old `createOneVisit` (lines 700–790), no Supabase:

```ts
// The payload for create_visit_encounter (0184): one visit's header fields and
// every test_requests row it will hold, with client-minted ids so package
// components can point at their header before anything is inserted. Pure —
// the DB reads (services, package components, physician compensation) happen
// in the action; the RPC re-checks totals and shape and writes it all in one
// transaction. Components are ₱0 rows: the header carries the package price.

export interface EncounterLineInput {
  service_id: string;
  base_price_php: number;
  discount_kind: string | null;
  discount_amount_php: number;
  final_price_php: number;
  clinic_fee_php: number | null;
  doctor_pf_php: number | null;
  procedure_description: string | null;
  hmo_approved_amount_php: number | null;
}

export interface EncounterHmo {
  hmo_provider_id: string | null;
  hmo_approval_date: string | null;
  hmo_authorization_no: string | null;
}

export interface EncounterDecomposition {
  headerLine: { service_id: string };
  componentServiceIds: string[];
}

export interface EncounterLine extends EncounterLineInput, EncounterHmo {
  id: string;
  receptionist_remarks: string | null;
  parent_id: string | null;
  is_package_header: boolean;
  status: "requested" | "in_progress";
}

export interface EncounterVisitPayload {
  visit: EncounterHmo & {
    total_php: number;
    notes: string | null;
    attending_physician_id: string | null;
    is_sample: boolean;
  };
  lines: EncounterLine[];
}

export interface EncounterVisitInput {
  lines: EncounterLineInput[];
  decompositions: EncounterDecomposition[];
  hmo: EncounterHmo;
  attendingPhysicianId: string | null;
  receptionistRemarks: string | null;
  notes: string | null;
  isSample: boolean;
}

/** Integer centavos. create_visit_encounter (0184) compares totals in centavos,
 *  and JS sums drift (100.10 + 200.20 = 300.29999999999995). */
export const toCentavos = (php: number): number => Math.round(php * 100);
const fromCentavos = (centavos: number): number => centavos / 100;
const money = (php: number): number => fromCentavos(toCentavos(php));
const moneyOrNull = (php: number | null): number | null => (php === null ? null : money(php));

export function buildEncounterVisit(
  input: EncounterVisitInput,
  newId: () => string,
): { ok: true; payload: EncounterVisitPayload } | { ok: false; error: string } {
  const packageServiceIds = new Set(input.decompositions.map((d) => d.headerLine.service_id));
  // Every amount leaves here rounded to centavos (numeric(10,2) in the DB).
  const base = (l: EncounterLineInput) => ({
    service_id: l.service_id,
    base_price_php: money(l.base_price_php),
    discount_kind: l.discount_kind,
    discount_amount_php: money(l.discount_amount_php),
    final_price_php: money(l.final_price_php),
    hmo_provider_id: input.hmo.hmo_provider_id,
    hmo_approval_date: input.hmo.hmo_approval_date,
    hmo_authorization_no: input.hmo.hmo_authorization_no,
    receptionist_remarks: input.receptionistRemarks,
    clinic_fee_php: moneyOrNull(l.clinic_fee_php),
    doctor_pf_php: moneyOrNull(l.doctor_pf_php),
    procedure_description: l.procedure_description,
    hmo_approved_amount_php: moneyOrNull(l.hmo_approved_amount_php),
  });

  // Duplicate package lines pair up with their decompositions in order.
  const packageLinesBySvc = new Map<string, EncounterLineInput[]>();
  for (const l of input.lines) {
    if (!packageServiceIds.has(l.service_id)) continue;
    const queue = packageLinesBySvc.get(l.service_id) ?? [];
    queue.push(l);
    packageLinesBySvc.set(l.service_id, queue);
  }

  const headers: EncounterLine[] = [];
  const components: EncounterLine[] = [];
  for (const d of input.decompositions) {
    const line = packageLinesBySvc.get(d.headerLine.service_id)?.shift();
    if (!line) return { ok: false, error: `Internal error: missing package line for service ${d.headerLine.service_id}` };
    const headerId = newId();
    headers.push({ ...base(line), id: headerId, parent_id: null, is_package_header: true, status: "in_progress" });
    for (const componentServiceId of d.componentServiceIds) {
      components.push({
        ...base(line),
        id: newId(),
        service_id: componentServiceId,
        base_price_php: 0,
        discount_kind: null,
        discount_amount_php: 0,
        final_price_php: 0,
        receptionist_remarks: null,
        clinic_fee_php: null,
        doctor_pf_php: null,
        procedure_description: null,
        hmo_approved_amount_php: null,
        parent_id: headerId,
        is_package_header: false,
        status: "requested",
      });
    }
  }
  const standalone: EncounterLine[] = input.lines
    .filter((l) => !packageServiceIds.has(l.service_id))
    .map((l) => ({ ...base(l), id: newId(), parent_id: null, is_package_header: false, status: "requested" as const }));

  return {
    ok: true,
    payload: {
      visit: {
        // Summed in integer centavos, so it equals the RPC's own sum exactly.
        total_php: fromCentavos(input.lines.reduce((sum, l) => sum + toCentavos(l.final_price_php), 0)),
        notes: input.notes,
        ...input.hmo,
        attending_physician_id: input.attendingPhysicianId,
        is_sample: input.isSample,
      },
      lines: [...headers, ...standalone, ...components],
    },
  };
}
```
Run the test — PASS.

- [ ] **Step 3: Rewire `createVisitAction`.** In `visits/new/actions.ts`:
  1. Replace the block from `const created: OneVisitResult[] = [];` (line ~348) through the end of the per-visit audit loop (the `for (const c of created) { … package.decomposed … }` closing brace, line ~511) with:

```ts
  // One visit, or two sharing groupId (doctor half first, then lab half).
  const visitSpecs = split
    ? [
        { lines: doctorLines, hmo: doctorHmo, attendingPhysicianId: parsed.data.attending_physician_id ?? null },
        { lines: labLines, hmo: labHmo, attendingPhysicianId: null },
      ]
    : [
        {
          lines,
          hmo: doctorLines.length > 0 ? doctorHmo : labHmo,
          attendingPhysicianId: doctorLines.length > 0 ? parsed.data.attending_physician_id ?? null : null,
        },
      ];

  // Pure reads first — a misconfigured package aborts with nothing written.
  const payloads: EncounterVisitPayload[] = [];
  for (const spec of visitSpecs) {
    const decomp = await loadPackageDecompositionsForLines(supabase, spec.lines, servicesForDecomp);
    if (!decomp.ok) return { ok: false, error: decomp.error };
    const built = buildEncounterVisit(
      {
        lines: spec.lines,
        decompositions: decomp.decompositions,
        hmo: spec.hmo,
        attendingPhysicianId: spec.attendingPhysicianId,
        receptionistRemarks: parsed.data.receptionist_remarks,
        notes: parsed.data.notes ?? null,
        isSample: parsed.data.is_sample,
      },
      () => crypto.randomUUID(),
    );
    if (!built.ok) return { ok: false, error: built.error };
    payloads.push(built.payload);
  }

  // One PIN for the whole encounter (portal login is per patient); only its
  // bcrypt hash leaves this function. The plain PIN is shown once below.
  const plainPin = generatePin();
  const pinHash = await hashPin(plainPin);
  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();

  // 0184: visit(s), every line, the PIN rows, the pre-registration clear and
  // the audit rows in ONE transaction under the patient's lifecycle lock —
  // no half-created visit to clean up any more.
  const { data: encounter, error: encErr } = await withLifecycleRetry(() =>
    admin.rpc("create_visit_encounter", {
      p_actor: session.user_id,
      p_patient_id: parsed.data.patient_id,
      p_pin_hash: pinHash,
      p_visits: payloads as unknown as Json,
      p_visit_group_id: groupId ?? undefined,
      p_context: { ip, user_agent: ua },
    }),
  );
  if (encErr || !encounter) {
    return { ok: false, error: translatePgError(encErr ?? { message: "Could not create the visit." }) };
  }
  const created = (encounter as { visits: { id: string; visit_number: string }[] }).visits.map((v) => ({
    visitId: v.id,
    visitNumber: v.visit_number,
  }));
```
  2. Everything after that (appointment completion, `setVisitPinFlash`, the redirects) keeps using `created[0]!.visitId`, `groupId`, `plainPin` exactly as today — read it through once and fix any reference to the removed `OneVisitResult` fields (`c.hmo`, `c.decompositions`, `c.headerIdsForAudit`) — there should be none left outside the deleted block.
  3. Delete `interface OneVisitInput`, `interface OneVisitResult`, `type TestRequestInsertRow`, `createOneVisit` and `deleteVisitCascade` (lines ~596–817). Keep `PackageDecomposition` / `loadPackageDecompositionsForLines` (still used) — change `PackageDecomposition` to `import type { EncounterDecomposition }` from the new module if the shapes are identical (they are: `{ headerLine: { service_id }, componentServiceIds }`).
  4. Imports: add `import { buildEncounterVisit, type EncounterVisitPayload } from "@/lib/visits/encounter-payload";`, `import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";`, `import { translatePgError } from "@/lib/accounting/pg-errors";`, `import { ipAndAgent } from "@/lib/server/action-helpers";`, `import type { Database, Json } from "@/types/database";`; remove `audit` and `headers` imports if now unused (the linter will say).
  5. Keep the `assertPatientActive` call at line ~121 — it is the friendly first refusal; the RPC is the authoritative one. Update its comment to: `// 0167/0184: friendly refusal before any pricing work; create_visit_encounter re-checks under the lifecycle lock.`

- [ ] **Step 4: Update the write-guard inventory.** In `src/lib/patients/write-guards.test.ts`: add to `KNOWN_WRITER_RPCS` the line `"create_visit_encounter", // visits/new/actions.ts createVisitAction — visit, lines, PIN in one transaction (0184).`; delete the two `EXEMPT` entries for `visits/new/actions.ts:createOneVisit` and `:deleteVisitCascade` (they no longer exist — the "no stale EXEMPT" test would fail). Run: `npx vitest run src/lib/patients/write-guards.test.ts` — PASS (createVisitAction calls `assertPatientActive` directly).

- [ ] **Step 5: Gates.** `npm run typecheck && npx vitest run src/lib/visits/encounter-payload.test.ts src/lib/patients/write-guards.test.ts src/lib/visits/query-surfaces.test.ts` — PASS. Commit — `feat(visits): start a visit through create_visit_encounter — one transaction, no compensating delete`.

---
### Task 19: Results → `result_create_linked` (three call sites) + attempt-unique first upload

**Files:**
- Create: `src/lib/actions/results/create-linked.ts`
- Modify: `src/lib/actions/results/result-edit-core.ts` (export `commitWithUploads`), `src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts` (`prepareStructured`, `uploadResultAction`), `src/lib/actions/results/finalise-consolidated.ts`, `src/lib/patients/write-guards.test.ts`
- Test: `src/lib/actions/results/result-edit-core.test.ts` (existing) + a new case

- [ ] **Step 1: Export the commit protocol.** In `result-edit-core.ts` change `async function commitWithUploads<T>(` to `export async function commitWithUploads<T>(` and export its outcome type: `export type CommitOutcome<T> = …` (rename nothing else). Its header comment gains one line: `// Also used by the first PDF upload (queue/[id]/actions.ts uploadResultAction, 0184).`

- [ ] **Step 2: Retry the result RPCs once on a lost race.** In the same file, wrap each `admin.rpc("result_edit_commit", …)` / `admin.rpc("result_finalise_commit", …)` call inside the `call` closures as `withLifecycleRetry(() => admin.rpc(…))` (import from `@/lib/patients/lifecycle-retry`). Same attempt id and object paths: a P0072/40P01 attempt rolled back whole, so re-sending it is safe and the objects stay pointed-at-by-nothing until the retry commits.

- [ ] **Step 3: Write** `src/lib/actions/results/create-linked.ts`:

```ts
import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";

type Admin = ReturnType<typeof createAdminClient>;

export interface CreateLinkedResultArgs {
  actor: string;
  testRequestIds: string[];
  kind: "structured" | "uploaded";
  reportGroupId?: string | null;
  storagePath?: string | null;
  fileSizeBytes?: number | null;
  notes?: string | null;
}

/** The raw RPC call (0184 result_create_linked): the results row + every link, one transaction. */
export function callResultCreateLinked(admin: Admin, a: CreateLinkedResultArgs) {
  return withLifecycleRetry(() =>
    admin.rpc("result_create_linked", {
      p_actor: a.actor,
      p_test_request_ids: a.testRequestIds,
      p_generation_kind: a.kind,
      p_report_group_id: a.reportGroupId ?? undefined,
      p_storage_path: a.storagePath ?? undefined,
      p_file_size_bytes: a.fileSizeBytes ?? undefined,
      p_notes: a.notes ?? undefined,
    }),
  );
}

/** For a structured draft (no storage): create it, or report why not. */
export async function createLinkedResult(
  admin: Admin,
  a: CreateLinkedResultArgs,
): Promise<{ ok: true; resultId: string } | { ok: false; code: string | null; error: string }> {
  const { data, error } = await callResultCreateLinked(admin, a);
  if (error || !data) {
    return {
      ok: false,
      code: error?.code ?? null,
      error: translatePgError(error ?? { message: "Could not create the result." }),
    };
  }
  return { ok: true, resultId: data as string };
}
```

- [ ] **Step 4: `prepareStructured`** (`queue/[id]/actions.ts` ~219–243). Replace the `insert results` + `insert result_test_requests` block inside `if (!resultId) { … }` with:

```ts
    // 0184: the draft row and its link in one transaction (was two calls —
    // a failure between them leaked an orphan results row on every retry).
    const created = await createLinkedResult(admin, {
      actor: session.user_id,
      testRequestIds: [testRequestId],
      kind: "structured",
    });
    if (created.ok) {
      resultId = created.resultId;
      isNewResult = true;
    } else if (created.code === "P0066") {
      // Someone created it a moment ago (two tabs, a double click): use theirs
      // if it is still an unfinished structured draft.
      const { data: raced } = await admin
        .from("result_test_requests")
        .select("result_id, results!inner(id, generation_kind, finalised_at)")
        .eq("test_request_id", testRequestId)
        .maybeSingle();
      const r = raced ? (Array.isArray(raced.results) ? raced.results[0] : raced.results) ?? null : null;
      if (!r || r.generation_kind !== "structured" || r.finalised_at !== null) {
        return { ok: false, error: created.error };
      }
      resultId = r.id;
    } else {
      return { ok: false, error: created.error };
    }
```
(The `else if (existing?.generation_kind !== "structured")` branch that follows stays as it is.)

- [ ] **Step 5: `finaliseConsolidatedReport`** (`finalise-consolidated.ts` ~283–311). Replace the `results` insert + junction insert (the whole `else { … }` body after the resume branch, keeping its long comment) with:

```ts
    const created = await createLinkedResult(admin, {
      actor: session.user_id,
      testRequestIds: input.testRequestIds,
      kind: "structured",
      reportGroupId: input.groupId,
    });
    if (!created.ok) return { ok: false, error: created.error };
    resultId = created.resultId;
```
(The RPC sets `finalised_by_staff_id = actor` when `reportGroupId` is given and leaves `finalised_at` NULL — exactly what the removed insert did.)

- [ ] **Step 6: `uploadResultAction`** (`queue/[id]/actions.ts` ~719–822). Rewrite the storage + row part so every upload goes to an attempt-unique path through `commitWithUploads`:

```ts
  // 0184: every upload gets its OWN object path (upsert off), and the row(s)
  // pointing at it are written in one transaction. A rejection removes only
  // this attempt's object; a lost response is re-checked by path before
  // anything is removed — never a committed PDF (result-edit-core.ts).
  const attemptId = randomUUID();
  const path = editVersionPath(`${visit.patient_id}/${visit.id}/${testRequest.id}`, 0, attemptId);
  const buffer = Buffer.from(await file.arrayBuffer());
  const probe = async (): Promise<boolean | null> => {
    const { data, error } = await admin.from("results").select("id").eq("storage_path", path).maybeSingle();
    if (error) return null;
    return data != null;
  };
  const upload = [{ bucket: "results" as const, path, body: buffer, contentType: "application/pdf" }];

  let resultId: string;
  if (existingResult) {
    // Replace-in-place (a first upload whose status flip failed pre-0059).
    const outcome = await commitWithUploads(admin, upload, () =>
      admin
        .from("results")
        .update({
          storage_path: path,
          file_size_bytes: file.size,
          uploaded_by: session.user_id,
          uploaded_at: new Date().toISOString(),
          notes: notes || null,
        })
        .eq("id", existingResult.id)
        .select("id")
        .single(),
    probe);
    if (outcome.status === "failed") return { ok: false, error: outcome.error };
    resultId = existingResult.id;
    // (the existing "re-advance the test if still stuck at in_progress" block follows unchanged)
  } else {
    const outcome = await commitWithUploads(admin, upload, () =>
      callResultCreateLinked(admin, {
        actor: session.user_id,
        testRequestIds: [testRequest.id],
        kind: "uploaded",
        storagePath: path,
        fileSizeBytes: file.size,
        notes: notes || null,
      }),
    probe);
    if (outcome.status === "failed") return { ok: false, error: outcome.error };
    if (outcome.data) {
      resultId = outcome.data as string;
    } else {
      // Committed but the response was lost: find the row by this attempt's path.
      const { data: row } = await admin.from("results").select("id").eq("storage_path", path).single();
      resultId = row!.id;
    }
  }
```
  Delete the old fixed `path` constant, the `upsert: true` upload, and both `admin.storage.from("results").remove([path])` compensations. Keep the `result.uploaded` audit exactly as it is (its `storage_path` metadata now carries the attempt path). Imports: `randomUUID` from `node:crypto`, `editVersionPath` from `@/lib/results/result-edit`, `commitWithUploads` from `@/lib/actions/results/result-edit-core`, `createLinkedResult, callResultCreateLinked` from `@/lib/actions/results/create-linked`.
  Before editing, grep for any reader that assumes the old fixed name: `grep -rn "\${testRequest.id}.pdf\|test_request_id}.pdf\|\.pdf\`" src | grep -v "\.test\."` — signed URLs read `results.storage_path`, so none should; if one does, switch it to the stored path.

- [ ] **Step 7: A test for the upload probe contract.** Add to `src/lib/actions/results/result-edit-core.test.ts` a case in the existing `commitWithUploads` style (reuse its fake admin/storage helpers): *"a P0066 rejection of a first upload removes only this attempt's object"* — call the exported `commitWithUploads` with one pending object, a `call` returning `{ data: null, error: { code: "P0066", message: "this test already has a result — reload the page" } }` and a `probe` returning `false`; assert the object was uploaded then removed and the outcome is `{ status: "failed", error: "This test already has a result — reload the page." }`. And its twin: probe returns `true` ⇒ status `committed`, nothing removed. (If the file already covers both branches generically for `commitResultFinalise`, add only the P0066-first-upload case.) Run — PASS.

- [ ] **Step 8: Write-guard inventory.** `KNOWN_WRITER_RPCS` += `"result_create_linked", // create-linked.ts — a result row and its links (0184).`. `callResultCreateLinked`/`createLinkedResult` live in `src/lib/actions/**` (scanned) and contain the RPC call with no guard of their own → add EXEMPT entries in the style of the `commitResultEdit` one: `"Shared creation helper for result_create_linked — every caller (prepareStructured, finaliseConsolidatedReport, uploadResultAction) calls assertPatientActive first, and the RPC itself refuses an inactive patient under the lifecycle lock (0184)."`. Run the test — PASS; also `npx vitest run src/lib/actions/results src/lib/results` — PASS.

- [ ] **Step 9: Commit** — `feat(results): create results and their links in one transaction; first uploads use attempt-unique paths`.

---

### Task 20: HMO settlement → `record_hmo_settlement`

**Files:** `src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts`, `src/lib/patients/write-guards.test.ts`.

- [ ] **Step 1: Replace the body** of `recordHmoSettlementAction` after the `assertClaimItemsPatientsActive` check (from `// Load items + their visit_ids.` through the final `return`) with:

```ts
  // 0184: payments (one per visit) and allocations in ONE transaction, under
  // the claim patients' lifecycle locks and the items' row locks — no
  // compensating delete loop, no orphan payment if an allocation is refused.
  const { ip, ua } = await ipAndAgent();
  const { data, error } = await withLifecycleRetry(() =>
    admin.rpc("record_hmo_settlement", {
      p_actor: session.user_id,
      p_batch_id: parsed.data.batch_id,
      p_total_amount_php: parsed.data.total_amount_php,
      // The same value the action used to write to payments.received_at.
      p_received_at: parsed.data.payment_date,
      p_items: parsed.data.items,
      p_bank_reference: parsed.data.bank_reference ?? undefined,
      p_context: { ip, user_agent: ua },
    }),
  );
  if (error || !data) return { ok: false, error: translatePgError(error ?? { message: "Could not record the settlement." }) };
  const out = data as { payment_ids: string[]; allocation_count: number };

  revalidatePath(`${BASE_PATH}/batches/${parsed.data.batch_id}`);
  return { ok: true, data: { payment_ids: out.payment_ids, allocation_count: out.allocation_count } };
```
Replace the NOTE comment above the function with: `// Settlement (0184): record_hmo_settlement writes one hmo payment per visit and every allocation in one transaction, audited inside it (hmo_settlement.recorded).` Remove now-unused imports/helpers only if nothing else in the file uses them (`fetchCompleteRowsByIds` and `auditMeta` are used by siblings — check before removing). Add `import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";`.

- [ ] **Step 2: Inventory.** `KNOWN_WRITER_RPCS` += `"record_hmo_settlement", // hmo-claims/actions.ts recordHmoSettlementAction (0184).` The action calls `assertClaimItemsPatientsActive` directly, so no EXEMPT entry. Run write-guards — PASS.

- [ ] **Step 3: Gates + commit.** `npm run typecheck && npx vitest run src/lib/patients/write-guards.test.ts src/lib/validations` — PASS. Commit — `feat(hmo): record a settlement in one transaction (record_hmo_settlement)`.

---

### Task 21: Closures → `reschedule_closure_appointments` (action + preview)

**Files:** `src/app/(staff)/staff/(dashboard)/admin/closures/{actions.ts,page.tsx}`, `src/lib/patients/write-guards.test.ts`, `src/lib/patients/query-surfaces.test.ts` (if it lists the closures files).

- [ ] **Step 1: The action.** Replace the body of `bulkRescheduleForClosureAction` after the `closed_on` validation and the closure re-read (keep both) with:

```ts
  const admin = createAdminClient();
  const { ip, ua } = await ipAndAgent();
  // 0184: one transaction — select, lock the patients, skip inactive ones,
  // update, audit (per row + summary). No 200-row chunks that could stop
  // half-way, no row cap.
  const { data, error } = await withLifecycleRetry(() =>
    admin.rpc("reschedule_closure_appointments", {
      p_closed_on: closedOn,
      p_actor: session.user_id,
      p_dry_run: false,
      p_context: { ip, user_agent: ua },
    }),
  );
  if (error || !data) return { ok: false, error: translatePgError(error ?? { message: "Could not reschedule." }) };
  const r = data as { affected: number; skipped_inactive: number; skipped_changed: number };

  revalidatePath("/staff/admin/closures");
  revalidatePath("/staff/appointments");
  return { ok: true, affected: r.affected, skipped: r.skipped_inactive + r.skipped_changed };
```
(`session` is the value `requireAdminStaff()` already returns at the top — name it if it is currently discarded.) Replace the long comment above the function with: `// Moves every confirmed/arrived appointment on the closed Manila day to pending_callback via reschedule_closure_appointments (0184): one transaction; a deleted or merged patient's appointment is skipped, never a reason to fail; walk-ins always move.` Delete `UPDATE_CHUNK`, the `RescheduleCandidate` type and any imports left unused (`fetchCompleteRows`, `manilaRangeUtc`, `isActivePatient`, `PatientLifecycle`, `audit`, `headers`) — let `npm run lint` say which.

- [ ] **Step 2: The preview** (`page.tsx` 43–59). Replace the hand-rolled count with the same RPC in dry-run mode, so the number on the page is exactly what the button will do:

```ts
  const admin = createAdminClient();
  const previews = await Promise.all(
    upcoming.map(async (c) => {
      const { data, error } = await admin.rpc("reschedule_closure_appointments", {
        p_closed_on: c.closed_on,
        p_actor: session.user_id,
        p_dry_run: true,
      });
      const r = data as { affected: number; skipped_inactive: number } | null;
      return { closedOn: c.closed_on, affected: error || !r ? null : r.affected, skippedInactive: r?.skipped_inactive ?? 0 };
    }),
  );
```
Adapt to the page's actual variable names (`upcoming` = the closures list it already loads; `session` = `await requireAdminStaff()`). Where the page prints the affected count, print `affected` and, when `skippedInactive > 0`, add ` (${skippedInactive} on deleted or merged records will be left as they are)`. When `affected` is `null` print `—` with a `title="Could not count"`. Import `createAdminClient` (the page is admin-gated; the RPC is service_role-only by design — note it in a one-line comment).

- [ ] **Step 3: Inventory.** `KNOWN_WRITER_RPCS` += `"reschedule_closure_appointments", // admin/closures/actions.ts (0184) — skips inactive patients inside the RPC.` The action has no `assert*Active` call by design → add EXEMPT: `"admin/closures/actions.ts:bulkRescheduleForClosureAction": "Deliberately unguarded: reschedule_closure_appointments locks every candidate patient and SKIPS deleted/merged ones inside the transaction (0184) — one inactive patient must never block rescheduling the whole closed day."` (use the file-path key format the test uses). If `query-surfaces.test.ts` classified the removed `patients(...)` embed in `closures/actions.ts`, remove that entry (its "no stale entries" check will say so). Run both tests — PASS.

- [ ] **Step 4: Gates + commit.** typecheck, lint on the two files, the two tests. Commit — `feat(closures): reschedule a closed day in one transaction; preview counts exactly what will move`.

---

### Task 22: Booking — resolver retry, one re-resolve on P0058, generic lookup-again

**Files:** `src/lib/patients/resolve.ts` (+ its test file), `src/lib/appointments/create.ts`, `src/lib/appointments/create.test.ts` (create if absent).

- [ ] **Step 1: `resolvePatient` retries a lost race once.** In `resolve.ts`, wrap the RPC: `const { data, error } = await withLifecycleRetry(() => admin.rpc("resolve_patient_guarded", { … }));` and translate: `if (error || !row) return { ok: false, error: error ? translatePgError(error) : "Could not save patient details." };`. Update the comment above it: reuse is on `(lower(email), lower(last_name), birthdate)` since 0184, active records only (0167), oldest first.
  If `resolvePatientCore`'s in-memory test double compares `last_name` exactly, make it case-insensitive too and add a test *"reuses a record whose last name differs only in case"* next to *"reuses an existing patient"*.

- [ ] **Step 2: Write the failing booking test.** Extract the insert-with-recovery into a pure-ish helper so it can be tested without a DB. In `create.ts` add:

```ts
export const LOOKUP_AGAIN_ERROR = "We couldn't use that patient record. Look the patient up again, then book.";

/**
 * Insert the booking rows; recover once from a patient that stopped being
 * active between resolution and insert (0184: the insert re-checks under the
 * patient's lifecycle lock). A patient RESOLVED from typed details is resolved
 * again and the insert retried once; a patient chosen by id (staff picker,
 * portal session) is never silently swapped — the caller gets a generic
 * lookup-again error that does not say whether a record was deleted.
 */
export async function insertWithPatientRecovery<T>(args: {
  patient: PatientResolution;
  insert: (patient: PatientResolution) => PromiseLike<{ data: T | null; error: { code?: string | null; message: string } | null }>;
  resolveAgain: () => Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }>;
}): Promise<{ ok: true; data: T; patient: PatientResolution } | { ok: false; error: { code?: string | null; message: string } | string }> {
  let patient = args.patient;
  let res = await withLifecycleRetry(() => args.insert(patient));
  if (res.error?.code === "P0058") {
    if (patient.resolution !== "reused" && patient.resolution !== "created") {
      return { ok: false, error: LOOKUP_AGAIN_ERROR };
    }
    const again = await args.resolveAgain();
    if (!again.ok) return { ok: false, error: again.error };
    patient = again.patient;
    res = await withLifecycleRetry(() => args.insert(patient));
    if (res.error?.code === "P0058") return { ok: false, error: LOOKUP_AGAIN_ERROR };
  }
  if (res.error || !res.data) return { ok: false, error: res.error ?? "Could not save the appointment." };
  return { ok: true, data: res.data, patient };
}
```
  Test file `src/lib/appointments/create.test.ts` (it must not import `server-only`; if `create.ts` does, move `insertWithPatientRecovery` + `LOOKUP_AGAIN_ERROR` into a new `src/lib/appointments/patient-recovery.ts` and import it from both):

```ts
import { describe, expect, it, vi } from "vitest";
import { insertWithPatientRecovery, LOOKUP_AGAIN_ERROR } from "./patient-recovery";

const p = (resolution: "existing" | "reused" | "created" | "walk_in", patientId = "p1") =>
  ({ patientId, drmId: null, email: null, resolution });
const refused = { data: null, error: { code: "P0058", message: "patient DRM-0001 is deleted" } };
const done = { data: ["a1"], error: null };

describe("insertWithPatientRecovery", () => {
  it("re-resolves once for a typed-in patient and books the fresh record", async () => {
    const insert = vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce(done);
    const resolveAgain = vi.fn(async () => ({ ok: true as const, patient: p("created", "p2") }));
    const r = await insertWithPatientRecovery({ patient: p("reused"), insert, resolveAgain });
    expect(r).toMatchObject({ ok: true, patient: { patientId: "p2" } });
    expect(resolveAgain).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[1][0].patientId).toBe("p2");
  });
  it("never swaps a patient chosen by id — generic lookup-again, no deletion wording", async () => {
    const r = await insertWithPatientRecovery({ patient: p("existing"), insert: vi.fn(async () => refused), resolveAgain: vi.fn() });
    expect(r).toEqual({ ok: false, error: LOOKUP_AGAIN_ERROR });
    expect(LOOKUP_AGAIN_ERROR).not.toMatch(/delet|merg/i);
  });
  it("gives up after one re-resolve", async () => {
    const insert = vi.fn(async () => refused);
    const r = await insertWithPatientRecovery({ patient: p("created"), insert, resolveAgain: async () => ({ ok: true, patient: p("created", "p3") }) });
    expect(r).toEqual({ ok: false, error: LOOKUP_AGAIN_ERROR });
    expect(insert).toHaveBeenCalledTimes(2);
  });
  it("retries a moved record (P0072) once with the same patient", async () => {
    const insert = vi.fn().mockResolvedValueOnce({ data: null, error: { code: "P0072", message: "x" } }).mockResolvedValueOnce(done);
    const r = await insertWithPatientRecovery({ patient: p("existing"), insert, resolveAgain: vi.fn() });
    expect(r.ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
```
Run — FAIL (module missing); implement (Step 2's helper in `patient-recovery.ts`, importing `PatientResolution` as a type from `./create`, or moving the interface there and re-exporting it from `create.ts`); run — PASS.

- [ ] **Step 3: Use it in both booking paths.** In `createAppointmentGroup`, replace the `admin.rpc("appointments_insert_slot_guarded", …)` call and its error handling with:

```ts
  const buildRows = (pt: PatientResolution) => services.map((s) => ({ /* the existing row object, with patient_id: pt.patientId, walk_in_name: pt.walkInName ?? null, walk_in_phone: pt.walkInPhone ?? null */ }));
  const inserted = await insertWithPatientRecovery({
    patient,
    insert: (pt) =>
      admin.rpc("appointments_insert_slot_guarded", {
        p_rows: buildRows(pt),
        p_physician_id: physicianId ?? undefined,
        p_scheduled_at: timing.scheduledAtIso ?? undefined,
        p_allow_concurrent: allowConcurrent || (input.mode === "relaxed" && input.override),
      }),
    resolveAgain: input.resolvePatient,
  });
  if (!inserted.ok) {
    const e = inserted.error;
    if (typeof e === "string") return { ok: false, error: e };
    if (e.code === "P0040") return { ok: false, error: "That slot was just taken. Please pick another time." };
    return { ok: false, error: translatePgError(e) };
  }
  const created = inserted.data;
  const finalPatient = inserted.patient;
```
  (write `buildRows` as the literal existing object — no placeholder comment in the real code), and return `patient: finalPatient` and check `created.length !== services.length` as before. Do the same in `createLabRequestOnlyBooking` (one row; its generic fallback message stays `"Could not save the request."`).

- [ ] **Step 4: Confirm `resolution` is set right by every caller.** `grep -n "resolution:" src/app/(marketing)/schedule/actions.ts src/app/(marketing)/register/actions.ts "src/app/(staff)/staff/(dashboard)/appointments/"*.ts` — a patient picked by id (staff picker, portal session) must be `"existing"`; one from `resolvePatient()` must be `"reused"`/`"created"` (per `row.reused`). Fix any caller that labels a picked patient otherwise.

- [ ] **Step 5: Gates + commit.** `npx vitest run src/lib/appointments src/lib/patients && npm run typecheck` — PASS. Commit — `feat(booking): re-resolve once when a typed-in patient was deleted mid-booking; never swap a chosen record`.

---

### Task 23: Undo-merge — clear the source marker first, stop on the first error

3a's guards refuse moving rows back onto a still-merged source, so the old order (move rows, then clear the marker) would now fail half-way. Prod has 0 `patient_merges` ledger rows (2026-09-25), so nothing live depends on the old order.

**Files:** `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts`, its test `actions.tables.test.ts` (unchanged unless it pins statement order), new pure helper + test.

- [ ] **Step 1: A pure step list with a failing test.** Create `src/lib/patients/undo-merge-steps.ts`:

```ts
// The order undo-merge writes in (0184). The source's merge marker is cleared
// FIRST — the lifecycle guard refuses any row moved onto a still-merged
// (inactive) patient — then its rows move back table by table, then the kept
// record's filled-in fields are cleared, then the ledger is marked undone.
// The runner stops at the first failed step: the ledger stays NOT undone and
// the admin sees which step failed; running Undo again is safe (every step is
// idempotent — moving rows already back, or clearing a cleared marker,
// changes nothing).
export const UNDO_MERGE_TABLES = [
  "visits",
  "appointments",
  "audit_log",
  "critical_alerts",
  "patient_consents",
  "appointment_attachments",
] as const;

export type UndoStep =
  | { kind: "clear_source_marker" }
  | { kind: "move_back"; table: (typeof UNDO_MERGE_TABLES)[number] }
  | { kind: "clear_filled_fields" }
  | { kind: "mark_ledger_undone" };

export function undoMergeSteps(): UndoStep[] {
  return [
    { kind: "clear_source_marker" },
    ...UNDO_MERGE_TABLES.map((table) => ({ kind: "move_back" as const, table })),
    { kind: "clear_filled_fields" },
    { kind: "mark_ledger_undone" },
  ];
}

export async function runUndoSteps(
  steps: readonly UndoStep[],
  run: (step: UndoStep) => Promise<{ error: { message: string } | null }>,
): Promise<{ ok: true } | { ok: false; failedAt: UndoStep; completed: number; error: string }> {
  for (let i = 0; i < steps.length; i++) {
    const { error } = await run(steps[i]!);
    if (error) return { ok: false, failedAt: steps[i]!, completed: i, error: error.message };
  }
  return { ok: true };
}
```
  and `src/lib/patients/undo-merge-steps.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runUndoSteps, undoMergeSteps, UNDO_MERGE_TABLES } from "./undo-merge-steps";

describe("undoMergeSteps", () => {
  it("clears the source marker before moving any row back, and marks the ledger last", () => {
    const steps = undoMergeSteps();
    expect(steps[0]).toEqual({ kind: "clear_source_marker" });
    expect(steps.at(-1)).toEqual({ kind: "mark_ledger_undone" });
    expect(steps.filter((s) => s.kind === "move_back").map((s) => (s as { table: string }).table)).toEqual([...UNDO_MERGE_TABLES]);
  });
});

describe("runUndoSteps", () => {
  it("stops at the first failure and never marks the ledger undone", async () => {
    const run = vi.fn(async (s: { kind: string; table?: string }) =>
      s.kind === "move_back" && s.table === "appointments" ? { error: { message: "boom" } } : { error: null });
    const r = await runUndoSteps(undoMergeSteps(), run);
    expect(r).toMatchObject({ ok: false, completed: 2, failedAt: { kind: "move_back", table: "appointments" } });
    expect(run.mock.calls.map((c) => c[0].kind)).not.toContain("mark_ledger_undone");
  });
  it("runs every step when none fails", async () => {
    const r = await runUndoSteps(undoMergeSteps(), async () => ({ error: null }));
    expect(r).toEqual({ ok: true });
  });
});
```
  Run — FAIL, implement (above), PASS. Then make `actions.tables.test.ts` also require `UNDO_MERGE_TABLES` to equal the merge action's table list and `FK_TABLES` in `scripts/patient-dedup/engine.ts` (same parity rule it already applies).

- [ ] **Step 2: Rewrite the undo sequence** in `undoMergeAction` (lines ~466–515: the six moves, the field clear, the marker clear, the ledger update) as:

```ts
  const moved = (m.moved ?? {}) as Record<string, (string | number)[]>;
  const outcome = await runUndoSteps(undoMergeSteps(), async (step) => {
    switch (step.kind) {
      case "clear_source_marker":
        return admin.from("patients").update({ merged_into_id: null, merged_at: null }).eq("id", m.source_id);
      case "move_back": {
        const ids = moved[step.table] ?? [];
        if (ids.length === 0) return { error: null };
        return step.table === "audit_log"
          ? admin.from("audit_log").update({ patient_id: m.source_id }).in("id", ids.map(Number))
          : admin.from(step.table).update({ patient_id: m.source_id }).in("id", ids as string[]);
      }
      case "clear_filled_fields":
        return Object.keys(clear).length === 0
          ? { error: null }
          : admin.from("patients").update(clear).eq("id", m.keep_id);
      case "mark_ledger_undone":
        return admin.from("patient_merges").update({ undone_at: new Date().toISOString(), undone_by: session.user_id }).eq("id", m.id);
    }
  });
  if (!outcome.ok) {
    await reportError({
      scope: "undoMergeAction",
      error: new Error(outcome.error),
      metadata: { merge_id: m.id, failed_at: outcome.failedAt, completed_steps: outcome.completed },
    });
    return {
      ok: false,
      error: `Undo stopped part-way (step ${outcome.completed + 1}: ${outcome.error}). Nothing is marked undone — run Undo again; steps already done are safe to repeat.`,
    };
  }
```
  (`clear` is the object the action already computes from `filled_from_source`; compute it BEFORE this block. Match the existing variable names — `m`, `admin`, `session`. If the typed client rejects `admin.from(step.table)` with a union table name, switch on `step.table` with one literal `.from("…")` per case.) The `patient.merge.undone` audit and `revalidatePath` calls stay after the block. Import `reportError` from `@/lib/observability/report-error` and the two helpers.

- [ ] **Step 3: Local proof against the guards.** With the dev DB: merge two throwaway active patients through `mergePatientsAction`'s SQL equivalent (or the Admin UI in Task 29's browser smoke), then undo — both records active again, rows back on the source, ledger undone. Record it in the Task 29 smoke list rather than here if the UI path is easier.

- [ ] **Step 4: Gates + commit.** `npx vitest run src/lib/patients src/app/\(staff\)/staff/\(dashboard\)/admin/patient-merge && npm run typecheck` — PASS. Commit — `fix(patients): undo-merge clears the source marker first and stops on the first error`.

---

### Task 24: Remaining writers retry once; full gate

**Files:** `src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts` (`saveDraftValues`), `src/app/(staff)/staff/(dashboard)/payments/[id]/{edit,move}/actions.ts` (the `correct_payment` callers).

- [ ] **Step 1:** Wrap `admin.rpc("result_save_draft", …)` in `saveDraftValues` and each `admin.rpc("correct_payment", …)` call in `withLifecycleRetry(() => …)`. No other change: their errors already go through `translatePgError`, which now words P0072/40P01.

- [ ] **Step 2: Full gate.** `npm test > $SCRATCH/test.log 2>&1; echo test=$?; npm run typecheck > $SCRATCH/tc.log 2>&1; echo tc=$?; npm run lint > $SCRATCH/lint.log 2>&1; echo lint=$?` — all `0`; on failure read only the failing part of the log.

- [ ] **Step 3: Commit** — `feat(patients): result drafts and payment edits retry once on a lost lifecycle race`.

---
### Task 25: Owner extras — "Patient messages not sent", Sentry on lookup failures, merge-notice skip audit

**Files:**
- Create: `src/lib/notifications/skip-labels.ts`, `src/lib/notifications/skip-labels.test.ts`
- Modify: `src/lib/notifications/inactive-recipient-audit.ts`, `admin/operations/cron-health/page.tsx`, `admin/patient-merge/actions.ts`

- [ ] **Step 1: Failing label test** `src/lib/notifications/skip-labels.test.ts` — every sender key written anywhere in `src/` has a plain label (so a new sender can't show a raw code on Cron Health):

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKIP_REASON_LABEL, SKIP_SENDER_LABEL, skipReasonLabel, skipSenderLabel } from "./skip-labels";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("skip labels", () => {
  it("labels every sender that records a skipped patient message", () => {
    const senders = new Set<string>();
    for (const file of walk(join(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("auditSkippedInactiveRecipient")) continue;
      for (const m of text.matchAll(/sender:\s*"([a-z0-9-]+)"/g)) senders.add(m[1]!);
    }
    expect(senders.size).toBeGreaterThan(5);
    expect([...senders].filter((s) => !(s in SKIP_SENDER_LABEL))).toEqual([]);
  });
  it("labels every reason, and falls back to plain words for an unknown one", () => {
    for (const r of ["deleted", "merged", "missing", "lookup_failed", "walk_in"]) expect(SKIP_REASON_LABEL[r]).toBeTruthy();
    expect(skipReasonLabel("some_new_reason")).toBe("Some new reason");
    expect(skipSenderLabel("some-new-sender")).toBe("Some new sender");
  });
});
```
Run — FAIL.

- [ ] **Step 2: Implement** `src/lib/notifications/skip-labels.ts`:

```ts
import { humaniseCode } from "@/lib/format/humanise-code";

// Plain words for Cron Health's "Patient messages not sent" (0184). Keys are
// the `sender` / `reason` values auditSkippedInactiveRecipient records.
export const SKIP_SENDER_LABEL: Record<string, string> = {
  "notify-released": "Result ready (one test)",
  "notify-released-bulk": "Results ready (several tests)",
  "notify-appointment-booked": "Booking confirmation",
  "notify-appointment-reminder": "Appointment reminder",
  register: "Registration email",
  "find-my-id": "Find my DRM-ID email",
  "send-statement-email": "Statement email",
  "patient-merge": "Records combined notice",
};

export const SKIP_REASON_LABEL: Record<string, string> = {
  deleted: "Record deleted",
  merged: "Record merged into another",
  missing: "Record not found",
  lookup_failed: "Could not check the record",
  walk_in: "No patient record (walk-in)",
};

export const skipSenderLabel = (key: string) => SKIP_SENDER_LABEL[key] ?? humaniseCode(key.replace(/-/g, "_"));
export const skipReasonLabel = (key: string) => SKIP_REASON_LABEL[key] ?? humaniseCode(key);
```
(Check `humaniseCode("some_new_reason")` returns `"Some new reason"`; if its casing differs, adjust the test's expectation to its actual output, not the helper.) Run — PASS.

- [ ] **Step 3: Sentry on `lookup_failed`.** In `inactive-recipient-audit.ts`, after the `audit(…)` call:

```ts
  // A lookup failure is an outage, not a deleted patient: it must be visible
  // even when the audit insert above failed with it (0184). No PII — ids only.
  if (args.reason === "lookup_failed") {
    await reportError({
      scope: "notifications.recipient_lookup",
      error: new Error(`patient recipient lookup failed (${args.sender})`),
      metadata: { sender: args.sender, patient_id: args.patientId, resource_type: args.resourceType },
    });
  }
```
Import `reportError` from `@/lib/observability/report-error` (both files are `server-only`). Wrap the `audit(...)` call in `try { … } catch (e) { console.error("skip audit failed", e); }` so the Sentry report still runs when the audit insert fails.

- [ ] **Step 4: The merge notice records its skip.** In `mergePatientsAction`, right after `const recipient = await checkPatientRecipient(admin, keep_id);`:

```ts
  if (recipient.kind === "inactive") {
    await auditSkippedInactiveRecipient({
      sender: "patient-merge",
      patientId: keep_id,
      reason: recipient.reason,
      resourceType: "patient",
      resourceId: keep_id,
    });
  }
```
(Import it. The inline `notification` metadata on `patient.merged` stays too.)

- [ ] **Step 5: Cron Health section.** In `cron-health/page.tsx`, load the summary with the RLS client (the function is SECURITY INVOKER; `audit_log` RLS shows admins everything):

```ts
  const { data: skips, error: skipsError } = await supabase.rpc("notification_skip_summary");
```
and render, after the heartbeat table's closing `</div>`:

```tsx
      <section className="mt-10" aria-labelledby="skipped-messages-heading">
        <h2 id="skipped-messages-heading" className="text-lg font-bold text-[color:var(--color-brand-navy)]">
          Patient messages not sent
        </h2>
        <p className="mb-3 mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Result, booking and reminder messages the clinic did not send because the patient record was deleted,
          merged or could not be checked. These are the skips that were recorded — if the database was down, a
          check can fail without leaving a record (those are also reported to the error monitor).
        </p>
        {skipsError ? (
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            The skipped-message counts could not be loaded. Please try again.
          </p>
        ) : !skips || skips.length === 0 ? (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">None in the last 30 days.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <PlainTh label="Message" />
                  <PlainTh label="Why It Was Not Sent" />
                  <PlainTh label="Last 7 Days" />
                  <PlainTh label="Last 30 Days" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {skips.map((s) => (
                  <tr key={`${s.sender}:${s.reason}`}>
                    <td className="px-4 py-3">{skipSenderLabel(s.sender)}</td>
                    <td className="px-4 py-3">{skipReasonLabel(s.reason)}</td>
                    <td className="px-4 py-3 tabular-nums">{s.skipped_7d}</td>
                    <td className="px-4 py-3 tabular-nums">{s.skipped_30d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
```
Import `skipSenderLabel, skipReasonLabel`. Update the page's `subtitle` to mention it: `"Latest recorded runs of the clinic's scheduled tasks, and patient messages that were not sent. All timestamps are in Manila time."`.

- [ ] **Step 6: Gates + commit.** `npx vitest run src/lib/notifications && npm run typecheck` — PASS. Commit — `feat(ops): Cron Health lists patient messages not sent; lookup failures reach Sentry; merge notice records its skip`.

---

### Task 26: Small follow-ups — `confirmDescribedBy`, README

**Files:** `src/components/staff/confirm-dialog.tsx`, `src/components/staff/patient-delete-button.tsx`, `README.md`.

- [ ] **Step 1: `ConfirmDialog` prop.** Add to `Props`: `confirmDescribedBy?: string;` (comment: `// id of an element explaining why confirm is disabled (e.g. the blocker list) — announced with the button`). Destructure it and put `aria-describedby={confirmDescribedBy}` on the confirm `<button>`.

- [ ] **Step 2: Delete dialog uses it.** In `patient-delete-button.tsx`: `const blockersId = useId();` (import `useId` from React); give the blocker `<div role="alert" …>` `id={blockersId}`; pass `confirmDescribedBy={blockers.length > 0 ? blockersId : undefined}` to `ConfirmDialog`. If `patient-delete-button.test.tsx` renders the markup, add an assertion that the confirm button's `aria-describedby` equals the alert's `id` when blockers exist.

- [ ] **Step 3: README.** Under "First-time setup" add a step between 2 and 3:

```md
   For a **local** stack (`supabase start`), also set `SUPABASE_JWT_SECRET` in
   `.env.development.local` — copy `JWT_SECRET` from `supabase status -o env`.
   The patient portal signs its short-lived patient tokens with it; without it
   every portal page fails to read data.
```

- [ ] **Step 4: Gates + commit.** `npx vitest run src/components/staff && npm run typecheck` — PASS. Commit — `chore(ui): delete dialog announces why Delete is disabled; README names SUPABASE_JWT_SECRET`.

---

### Task 27: Standing gate — creation goes through the RPCs

**Files:** Create `src/lib/visits/creation-paths.test.ts`.

- [ ] **Step 1: Write the test.**

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// 0184: a visit, a result, their links and PINs are created only inside the
// transactional RPCs (create_visit_encounter, result_create_linked,
// record_hmo_settlement). A new direct insert would bring back the half-created
// states (a visit with no lines or PIN, an orphan results row) those RPCs
// removed. Money inserts that are single statements stay allowed where listed.

const SRC = join(process.cwd(), "src");
const FORBIDDEN = ["visits", "test_requests", "visit_pins", "results", "result_test_requests"];
const ALLOWED: Record<string, string[]> = {
  payments: ["src/app/(staff)/staff/(dashboard)/payments/new/actions.ts"],
  hmo_payment_allocations: ["src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts"],
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ rel: relative(process.cwd(), p).split(sep).join("/"), text: readFileSync(p, "utf8") }));
const insertsInto = (table: string) =>
  files
    .filter((f) => new RegExp(`\\.from\\(\\s*"${table}"\\s*\\)\\s*\\.\\s*(insert|upsert)\\(`).test(f.text))
    .map((f) => f.rel);

describe("creation paths (0184)", () => {
  it.each(FORBIDDEN)("nothing in src/ inserts into %s directly", (table) => {
    expect(insertsInto(table)).toEqual([]);
  });
  it.each(Object.keys(ALLOWED))("only the listed files insert into %s", (table) => {
    expect(insertsInto(table).sort()).toEqual([...ALLOWED[table]!].sort());
  });
  it("mutation proof: the matcher sees a multi-line insert", () => {
    const re = /\.from\(\s*"visits"\s*\)\s*\.\s*(insert|upsert)\(/;
    expect(re.test(`admin\n  .from("visits")\n  .insert({})`)).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — PASS after Tasks 18–20. (If `payments` shows another legitimate single-insert site, e.g. a gift-code redemption, add it to `ALLOWED` with a one-line comment saying why it is a single statement.) **Mutation check:** temporarily add `await admin.from("results").insert({})` to any action → the test FAILS; revert.

- [ ] **Step 3: Commit** — `test(visits): creation of visits/results/PINs goes through the 0184 RPCs`.

---

### Task 28: Documentation

**Files:** `docs/drmed-user-guide.html`, `CLAUDE.md`, the spec, `.claude/skills/drmed-{migrations,rls-and-auth,booking-and-intake,payments,result-templates}/SKILL.md`.

- [ ] **Step 1: Spec fix.** In `docs/superpowers/specs/2026-09-24-patient-delete-design.md`, "Helper security contract (Codex P1-19)": replace `lifecycle_lock_and_assert(patient_ids uuid[], mode text)` with `lifecycle_lock_and_assert(patient_ids uuid[], p_exclusive boolean)`; in the 3a matrix row for `cogs_send_out_entries` append "(dropped by 0166 — nothing to guard)"; in "Admission" note `a_lifecycle_guard` fires first by name.

- [ ] **Step 2: User guide.** Bump the version line (next minor, today's date). Add, where the guide describes deleting a patient ("Delete a patient record" in 5.6 Patient tools), one sentence: `While a record is being deleted, anything saved for that patient at the same moment waits a moment and is then refused with <q>… is deleted — restore the record before changing it</q>; cancelling or marking an appointment as a no-show still works on a deleted record.` In the closures section, say the preview number is exactly how many appointments will move, and that appointments of deleted or merged records are left alone. In Cron Health (if the guide documents it), describe **Patient messages not sent**. Update the booking section: a returning patient is matched on email, last name (capital letters don't matter) and birthdate.

- [ ] **Step 3: CLAUDE.md.** In "Payment-gating…/Other DB-side automation", add a bullet:
  `- **Patient lifecycle lock (0184):** every write to a patient-owned table (visits, lines, payments, PINs, appointments, consents, uploads, results + links/values/amendments/alerts, HMO items/allocations/resolutions, PF entries) passes the \`a_lifecycle_guard\` trigger: shared lock on the patient, refuse (P0058) if deleted or merged — except cancel/no-show, PIN sign-in bookkeeping and retention delete, alert acknowledgement and PF disbursement links. Delete/restore take the lock exclusive. Results-family writes first take a result-MEMBERSHIP lock (exclusive to add/remove a link), and a result holds one patient's tests only. Every patient-bearing reference of a row is locked and asserted. Multi-step creation goes through \`create_visit_encounter\`, \`result_create_linked\`, \`record_hmo_settlement\`, \`reschedule_closure_appointments\` — never direct inserts (\`creation-paths.test.ts\`). P0072 = the record moved mid-save: callers retry once (\`withLifecycleRetry\`).`
  Replace "The older `set_patient_context()` function still exists but nothing calls it." with "`set_patient_context()` was dropped in 0184; `current_patient_id()` reads only the JWT claim." Update the P-code list ("in use on main") when this merges: `P0072–P0073`. Add a "Where things live" row: `| Lifecycle-lock retry (\`withLifecycleRetry\`), booking patient recovery, undo-merge step order | \`src/lib/patients/{lifecycle-retry,undo-merge-steps}.ts\`, \`src/lib/appointments/patient-recovery.ts\` |`.

- [ ] **Step 4: Skills** (tracked under `.claude/skills/` in this worktree; if a skill folder is not tracked here, update the container copy `~/Claude/DRMed/.claude/skills/` instead and say so in the commit message): `drmed-migrations` — P-code registry P0072/P0073, the `a_lifecycle_guard` naming rule (must sort first), "a new patient-owned table needs `a_lifecycle_guard` + a `lifecycle_patients_of_row` branch, and a new patient-bearing FK column on a guarded table needs a `lifecycle_via` term (s14.5 fails otherwise)", lock order (membership → patient → row → re-read), one patient per result, money compared in centavos, the REPLAY rule for 0184-owned functions (a lower-numbered branch re-creating one must ship a new migration above 0184; `lifecycle-owned-functions.test.ts`), fresh replay on an isolated second stack (Task 29 Step 3's recipe), `smoke:locks`. `drmed-rls-and-auth` — `current_patient_id()` JWT-only, `set_patient_context` gone. `drmed-booking-and-intake` — resolver case-insensitive + oldest-first + P0072 retry, `insertWithPatientRecovery`. `drmed-payments` — `record_hmo_settlement`, `correct_payment` lock order, guard exceptions (PF disbursement link). `drmed-result-templates` — `result_create_linked`, attempt-unique first-upload paths via `commitWithUploads`.

- [ ] **Step 5: Commit** — `docs: lifecycle locks in the user guide, CLAUDE.md, skills and spec`.

---

### Task 29: Full verification

- [ ] **Step 1: Static gates.** `npm test && npm run typecheck && npm run lint` (logs to `$SCRATCH`) — all PASS.

- [ ] **Step 2: Mutation checks** (each must FAIL, then revert): remove the `a_lifecycle_guard` trigger on `payments` in a scratch copy of the migration and re-apply → s4.9/s4.10 fail; swap the order of `lifecycle_lock_and_assert` and the row lock in `result_save_draft` → s7.1 fails; delete the lifecycle call from `correct_payment` → s7.1 fails (both-positions rule); make the junction branch take the SHARED membership lock → s5.26 and both `membership:` races fail; remove the batch lock from `recompute_hmo_batch_status` → s11.12c and the rollup race fail; compare visit totals as raw numerics → s9.21–s9.23 fail; make `withLifecycleRetry` never retry → its test fails; delete `patient-merge` from `SKIP_SENDER_LABEL` → skip-labels test fails; add a fake lower-numbered definer to `lifecycle-owned-functions.test.ts`'s input → its mutation test proves the check fires. Re-apply the real migration after the SQL ones.

- [ ] **Step 3: Fresh replay on an ISOLATED stack — a ship prerequisite** (Codex plan review P1-3). Never `supabase db reset` the shared stack for this (other sessions' unmerged 0170/0183 live there). Instead bring up a second, throwaway Supabase stack from a copy of this branch's `supabase/` folder with its own project id and ports; `supabase start` on an empty project applies every migration in NUMBER order — that is the fresh replay.

```bash
R=$SCRATCH/replay && rm -rf $R && mkdir -p $R && cp -R supabase $R/supabase && rm -rf $R/supabase/.temp/project-ref $R/supabase/.temp/linked-project.json $R/supabase/.temp/pooler-url
# Keep supabase/.temp/postgres-version if present: it pins the Postgres image (see memory
# supabase-postgres-denied-function-segfault — never run 17.6.1.106/.111).
node -e '
const fs=require("fs");const p=process.argv[1];let s=fs.readFileSync(p,"utf8");
s=s.replace(/^project_id = ".*"$/m,"project_id = \"DRMed_replay\"");
for (const [a,b] of [[54321,55321],[54322,55322],[54320,55320],[54329,55329],[54323,55323],[54324,55324],[54325,55325],[54326,55326],[54327,55327],[54328,55328]]) s=s.split(`port = ${a}`).join(`port = ${b}`);
for (const sec of ["studio","inbucket","edge_runtime","analytics"]) s=s.replace(new RegExp(`(\\[${sec}\\][^\\[]*?)enabled = true`),"$1enabled = false");
fs.writeFileSync(p,s);' $R/supabase/config.toml
grep -nE "^project_id|^port|shadow_port" $R/supabase/config.toml
/opt/homebrew/bin/supabase start --workdir $R > $SCRATCH/replay-start.log 2>&1; echo exit=$?; tail -5 $SCRATCH/replay-start.log
```
Expected: `exit=0`, every migration applied (the log lists them; the last is the highest on the branch). A failure here IS the finding — a migration that cannot replay from empty (fix it; never "stamp" around it). If the second stack cannot start at all (ports taken, OrbStack memory), STOP and ask the owner whether to (a) free resources and retry or (b) reset the shared stack after warning the other sessions — shipping waits for one of them.

Then, against the replay container (`supabase_db_DRMed_replay`, port 55322):

```bash
RP=(docker exec -i supabase_db_DRMed_replay psql -U postgres -d postgres -v ON_ERROR_STOP=1)
for f in 0184_patient_lifecycle_locks 0167_patient_soft_delete 0147_hmo_claim_delete_guard 0161_payment_correction 0172_result_edit_commit 0174_correct_payment_stale_guard 0151_rls_initplan 0163_drm_id_width; do
  echo "== $f"; $RP[@] < supabase/tests/${f}_smoke.sql > $SCRATCH/replay-$f.log 2>&1; grep -cE "OK" $SCRATCH/replay-$f.log; grep -E "ERROR|FAILED" $SCRATCH/replay-$f.log | head -3
done
SMOKE_LOCKS_DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres npm run -s smoke:locks > $SCRATCH/replay-locks.log 2>&1; echo exit=$?; tail -3 $SCRATCH/replay-locks.log
```
Expected: no ERROR/FAILED in any file, `21/21 races passed`.

**Order equivalence.** Re-apply 0184 on the SHARED stack last (the Conventions apply command — this is the prod order: 0184 after 0186), then compare every 0184-owned function's definition on both stacks:

```bash
Q="select p.oid::regprocedure::text || E'\n' || pg_get_functiondef(p.oid) || coalesce(array_to_string(p.proacl, ','), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('delete_patient','restore_patient','result_save_draft','result_finalise_commit','result_edit_commit','correct_payment','appointments_insert_slot_guarded','resolve_patient_guarded','current_patient_id','recompute_hmo_batch_status','enforce_patient_activity','create_visit_encounter','result_create_linked','record_hmo_settlement','reschedule_closure_appointments','notification_skip_summary') order by 1"
docker exec supabase_db_DRMed psql -U postgres -d postgres -Atc "$Q" > $SCRATCH/defs-prod-order.txt
docker exec supabase_db_DRMed_replay psql -U postgres -d postgres -Atc "$Q" > $SCRATCH/defs-replay.txt
diff $SCRATCH/defs-prod-order.txt $SCRATCH/defs-replay.txt && echo EQUIVALENT
```
Expected: `EQUIVALENT`. Also `npx vitest run src/lib/patients/lifecycle-owned-functions.test.ts` — PASS. A diff means some migration re-creates a 0184-owned function in an order-dependent way: apply the replay rule in Facts (never paper over it by re-applying).

Finally `/opt/homebrew/bin/supabase stop --workdir $R --no-backup` and `rm -rf $R`. Record in the task report: the replay's migration count and head, the smoke/race counts, and `EQUIVALENT`. **Task 31 does not start without this record for the final rebased HEAD.**

- [ ] **Step 4: Browser smoke** (Playwright MCP, local dev on the port the DRMed local-smoke recipe uses, pointed at the LOCAL stack; text checks via `browser_snapshot` / `browser_evaluate`, one screenshot at most per item):
  1. New visit with a package + a consult (split) for a throwaway patient → both visits exist with the same PIN slip; the queue shows the lines; Visit page OK.
  2. Delete that patient is blocked (open work) → cancel a line… or use a second throwaway patient with a paid released visit → delete it → try starting a visit for it via a stale tab of the New visit form → refused with the deleted message, no visit created.
  3. Lab queue: first PDF upload on a test → result appears; its stored path ends `.v0.<token>.pdf`.
  4. Structured entry: save a draft, then finalise → unchanged behaviour.
  5. HMO: settle a two-visit batch → two payments, items paid; Cron Health shows **Patient messages not sent** (seed a skip row locally if none).
  6. Closures: add a closure on a day with a throwaway patient's appointment and a deleted patient's appointment → the preview says "1 … (1 on deleted or merged records will be left as they are)"; Reschedule → 1 moved.
  7. Merge two throwaway patients, then Undo → both active, rows back.
  8. Public `/schedule`: book with details that match a patient that is deleted while the form is open (delete it in another tab before submitting) → a fresh DRM-ID booking, no error.
  Record each result in the task report; any failure → fix, re-run Step 1.

- [ ] **Step 5: Commit fixes** with their own messages.

---

### Task 30: Review gates

- [ ] **Step 1: Opus code review** — `superpowers:requesting-code-review` over `git diff origin/main...HEAD` with focus: the guard's exception list vs the spec matrix, lock ordering in every RPC (advisory before row, sorted, no shared→exclusive), P0072 re-resolution, the replay pre-check in `result_edit_commit`, ACLs/ownership/search_path, `current_patient_id` JWT-only, the undo-merge order, the upload cleanup contract.
- [ ] **Step 2: Codex xhigh diff review** — `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"` then `/codex-review` at **xhigh** on the branch diff (never through a pipe; open the report and confirm `Status: Completed` and real content before trusting it; exit 0 means it ran, not that it was clean).
- [ ] **Step 3:** Fix every confirmed finding (match existing patterns), re-run Task 29 Steps 1 and 3 (smokes + `smoke:locks`), commit. Run a Codex recheck on the fix commits if any finding was P1.

---

### Task 31: Ship — PR, prod migration, merge

- [ ] **Step 1: Re-check the overlaps under the replay rule.** `git fetch origin && git log --oneline origin/main -10`.
  - If 0170 or 0183 reached main since Task 0: rebase, re-copy the overlapping body (`resolve_patient_guarded` / `correct_payment`) from THEIR migration re-applying 0184's marked edits, add their file to that function's `allowedBelow` in `lifecycle-owned-functions.test.ts`, re-run the 0184 smoke.
  - If a migration numbered ABOVE 0184 reached main and re-creates a 0184-owned function (the Task 0 Step 1 grep; the standing test's "highest-numbered definition" check fails): STOP — 0184 must be renumbered above it (claim a new number via the controller), never "copied back" into a lower file.
  - If main moved at all since Task 29 Step 3 and brought migrations: re-run Task 29 Step 3 (isolated fresh replay + order equivalence) on the rebased HEAD. **Do not continue without a passing replay record for the exact HEAD being shipped.**
  - `npm run -s claim -- list | grep 0184` still ours; MCP `list_migrations` shows no 0184 on prod.
  - Re-read the three memory notes (Task 0 Step 4): if 0170/0183 are still unmerged, they carry the obligation (new migration above 0184); `SendMessage` their live sessions (if `ListAgents` shows them) that 0184 is about to reach main.

- [ ] **Step 2: Push and open the PR.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/patient-delete-locks
gh pr create --title "feat(patients): lifecycle locks + child-table guards; visits, results, HMO settlements and closure reschedules in one transaction (0184)" --body-file <(cat <<'MD'
PR 3a of the patient-delete rollout (spec: docs/superpowers/specs/2026-09-24-patient-delete-design.md, "PR 3 revision").

- Every write to a patient-owned table takes the patient's lifecycle lock (shared); delete/restore take it exclusive. A deleted or merged patient gets nothing new — at the database, not only in the app — except cancel/no-show, PIN sign-in bookkeeping, alert acknowledgement and paying a doctor for work already done.
- Starting a visit, creating a result, recording an HMO settlement and rescheduling a closed day are each ONE transaction (no half-created visits, orphan results or stray payments).
- Online booking matches last name case-insensitively and never reuses a record deleted mid-booking; a staff-chosen record is never silently swapped.
- Undo-merge clears the source marker first and stops on the first error; Cron Health lists patient messages that were not sent; the portal identity comes from the JWT only (`set_patient_context` dropped).
- Migration 0184, P0072–P0073.

Verification: npm test / typecheck / lint; 0184 smoke s1–s14 + neighbouring smokes; `npm run smoke:locks` (21 two-connection races, incl. result membership and HMO batch rollup); isolated fresh replay + replay/ship-order equivalence (Task 29 Step 3); browser smoke; Opus review + Codex xhigh review.

Not in this PR: merge/undo RPCs, consent re-sync, merge snapshots, dedup chain flattening, CLI actor, merge-marker enforcement (PR 3b).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
MD
)
```

- [ ] **Step 3: Apply 0184 to prod right before the merge** (owner-authorised Claude `db push`, 2026-09-24). From this worktree, rebased on current main:

```bash
/opt/homebrew/bin/supabase db push --dry-run 2>&1 | tail -8
```
Expected: exactly `0184_patient_lifecycle_locks.sql` pending (use `--include-all` only if the dry-run shows lower-numbered branches' files are NOT listed — i.e. only 0184). Push for real, then verify by OBJECT with read-only MCP `execute_sql`:

```sql
select c.relname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where t.tgname = 'a_lifecycle_guard' order by 1;                                             -- 16 rows, all O
select to_regprocedure('public.set_patient_context(uuid)');                                    -- null
select pg_get_functiondef('public.delete_patient(uuid,text,text,uuid,jsonb)'::regprocedure) ~* 'for\s+no\s+key\s+update'; -- t
select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname in ('delete_patient','restore_patient'); -- patient_lifecycle_writer ×2
select p.proname, p.prosecdef, p.proconfig from pg_proc p
 where p.proname in ('create_visit_encounter','result_create_linked','record_hmo_settlement','reschedule_closure_appointments',
                     'lifecycle_lock_and_assert','enforce_patient_activity','notification_skip_summary','resolve_patient_guarded','current_patient_id');
select has_function_privilege('anon','public.create_visit_encounter(uuid,uuid,text,jsonb,uuid,jsonb)','execute'),
       has_function_privilege('authenticated','public.record_hmo_settlement(uuid,uuid,numeric,timestamp with time zone,jsonb,text,jsonb)','execute'); -- f, f
select version from supabase_migrations.schema_migrations where version = '0184';               -- 1 row
select count(*) from public.patients where deleted_at is not null;                              -- unchanged (5 as of 2026-09-25)
```
If any check fails, stop and report — do not merge.

- [ ] **Step 4: Owner merges** (ask for the OK; DRMed merges are the owner's). Then confirm `gh pr view --json state` = MERGED and the Vercel Production deployment for the merge commit is Ready — merge ≠ deploy. Update the memory file `drmed-patient-delete.md` (3a shipped, 3b next) and CLAUDE.md's ledger line in a follow-up only if the owner asks.

---

## Self-review notes (plan author)

- **Spec coverage (3a).** Lock modes + admission + deadlock analysis → T2–T4, T8 (NO KEY UPDATE T3; triggers fire first by name T4; RPCs pre-acquire T8–T13; exclusive on ownership change T4). Re-resolution / P0072 → T4 (guard), T8, T9, T11, T12; race proof T16. Helper security contract → T2 (definer, pinned, EXECUTE revoked; fail closed on unresolved parent). Default-refuse matrix, every row → T4–T7 (appointments/visit_pins/critical_alerts/doctor_pf_entries exceptions; results unlinked insert; batches unguarded; reopen refused s6.6; mixed batch s6.1; `cogs_send_out_entries` gone — noted). Transactional creation: visit encounter T10/T18, results (structured + upload, attempt path, probe, lost response, overlapping first uploads — row locks + P0066 + commitWithUploads) T11/T19, HMO settlement T12/T20 (competing allocations + concurrent settlements in one batch: T16), closure reschedule + dry-run preview + >1,000 rows + inactive skip + concurrent cancel/delete T13/T16/T21, resolver T9/T22, merge/undo compatibility T23. Owner extras: Cron Health card + Sentry + merge notice T25; drop GUC T14; README + ConfirmDialog T26. Owner decisions: HMO billing of a deleted patient stays refused (guards on items, s6.4/s6.5); case-insensitive resolver (s8.3); cancel/no-show allowed (s3.14–s3.16); split 3a/3b (scope line).
- **Deliberately PR 3b:** merge/undo RPCs under `patient_merge_writer`, consent reconciliation, snapshots, chain re-parenting, CLI actor, merge-marker enforcement.
- **Known limits, stated in code comments:** the closure RPC takes one advisory lock per distinct patient (Task 1 measures the ceiling); `previous_status` in the closure audit is now the real status; hard-deleting a payment in `smoke:locks` cleanup leaves a net-zero reversal pair in the local ledger. The rollup's batch lock is taken after the item row lock inside the item trigger, so two MULTI-item plain statements touching the same two items of one batch in opposite orders can deadlock (40P01 — rolled back whole; RPC callers retry once); the settlement RPC avoids it by locking the batch before its items.

### Revision 2026-09-28 — Codex xhigh plan review (session 01a0e5c1-1296-7010-b660-52b5a813ae6f)

| Finding | Where it is closed |
|---|---|
| **P1-1** resolver followed one path (junction via test only; alerts/amendments ignored `result_id`; `test_requests` ignored `parent_id`) | Facts "Every patient-bearing reference" table; Task 2 `lifecycle_via` + union `lifecycle_patients_of_row` (also `payments.corrects_payment_id`, `critical_alerts.withdrawn_by_amendment`, `doctor_pf_entries.hmo_allocation_id`) + s1.26–s1.34; one-patient-per-result (guard step (d), `result_create_linked`) + s5.20/s5.21, s10.11b; negative tests with mismatched refs s4.7b/c, s5.13–s5.17, s6.10/s6.11, incl. an **authenticated admin under RLS** s5.18; catalog sweep s14.5 fails on an unknown patient-bearing FK |
| **P1-2** membership could change under a result writer | Facts "Result membership"; Task 2 `lifecycle_lock_results` + `lifecycle_result_ids_of_row`; guard step (b) (exclusive for links/results delete, shared for every other results-family write, incl. unlinked results); Task 8 result RPCs and Task 11 take it first (s7.1m); s5.25/s5.26; races `membership: …` ×2 (waited on the membership lock; the queued writer then holds the NEW patient's lock) |
| **P1-3** "whichever lands second copies the body" broke replay | Facts replay rule + table (0179 now merged → copied; 0170/0183 must ship a new migration above 0184 if 0184 lands first); memory notes (Task 0 Step 4); standing gate `lifecycle-owned-functions.test.ts` (Task 15 Step 6); fresh replay on an isolated stack + replay/ship-order definition diff is a ship prerequisite (Task 29 Step 3, Task 31 Step 1) |
| **P2-4** exact numeric vs JS float totals | Centavo comparison in `create_visit_encounter` (s9.21–s9.24) and `record_hmo_settlement` (s11.12a); `toCentavos` in `encounter-payload.ts` (+ tests with fractional prices, a float-noisy discount, a split encounter) |
| **P2-5** concurrent settlements left the batch `submitted` | `recompute_hmo_batch_status` re-created with a batch row lock (Task 12 (8b), s11.12c); `record_hmo_settlement` locks the batch before its items (s11.12b); three races: both settlements COMMIT → durable `paid|2|2|2`; same item → P0012; plain allocations → rollup lock alone ends `paid` |
| **P2-6** s5.2 control could never pass | s5.2 links a fresh, never-linked test `ta2` |
| **P2-7** closure race could touch other sessions' rows | `isolatedPastDay` (verified empty before any change), closure inserted without `ON CONFLICT` and recorded only after it succeeds, "exactly our three appointments" pre-check, moved-rows ⊆ ours post-check; s12 isolation pre-check |
| **P3** `position()` = 0 passed; elapsed time alone | s7.1/s7.2/s7.1m/s11.12b/s11.12c require every position > 0 + mutation checks; `waitingOn` names the lock a waiter is blocked on in the key races |
| Found while revising (0179 merged after the plan was written) | `result_edit_commit` copied from 0179 (+ the 0179 hunks pinned in the standing test); the 0179 follow-up columns on `result_amendments` are a fifth guard exception (s5.22–s5.24) |

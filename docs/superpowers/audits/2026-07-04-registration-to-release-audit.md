# Registration → Release journey audit

**Date:** 2026-07-04
**Scope:** Full patient journey — registration (staff / `/register` self-reg / QR poster) → appointment booking (public `/schedule` / staff slide-over) → visit creation + DRM-ID/PIN receipt → payment recording + DB payment gate → lab queue claim → result entry (structured + PDF) → sign-off → release → patient notification → patient portal access.
**Method:** 8 parallel read-only stage audits (one sub-agent per stage), each tracing UI ↔ server action ↔ DB trigger/RLS agreement, audit-log coverage, and stuck-state analysis; all trigger/policy/function claims verified against the **live** Supabase schema (project `qhptbmafrosgibooelpp`) via `pg_get_functiondef` / `pg_policies` / live data queries, not against migration files or comments alone.
**Purpose:** pre-implementation check of `docs/superpowers/specs/2026-07-04-release-lifecycle-design.md` (the release-lifecycle spec), plus a sweep for other bugs of the class that produced Visit #0037.

**Verdict: GO** — every load-bearing mechanism the spec relies on is confirmed against the live DB. Four spec amendments are required first (S1–S4 below, applied to the spec in the same commit as this audit). The journey sweep also surfaced eight HIGH findings *outside* the spec's scope — none block it, but several deserve scheduling in the same epoch.

---

## 1. Spec assumption verification (Features 1 & 3 machinery)

| Spec assumption | Verdict |
|---|---|
| `bridge_test_request_released` books JE on any →`released`; idempotency guard = `EXISTS(posted JE for source_kind='test_request', source_id)`; a `reversed` original unblocks re-release | **CONFIRMED** (live fn def; matches `journal_entries_one_posted_per_source`, which excludes `source_kind='reversal'`) |
| `bridge_test_request_cancelled` reversal pattern (reversal JE, original → `reversed`, PF/COGS soft-void) reusable for undo | **CONFIRMED** (live fn def, 0064) |
| Payment + consent gates fire only on transitions **to** `released`; payment gate passes exactly `('paid','waived')` | **CONFIRMED** (live fn defs) |
| No code path today produces `released → ready_for_release`; no existing trigger misbehaves on that transition | **CONFIRMED** (all 4 in-app status-write sites + `finalise-consolidated.ts` + all 10 live triggers walked) |
| Headers carry the price, components ₱0; bridge skips components (0041) → header release books package revenue | **CONFIRMED** (0041 guard present in live fn; sampled header/component pairs share `visit_id` 100%) |
| Single-statement bulk release: AFTER-row triggers see sibling updates | **CONFIRMED** — and already proven in production: `finalise-consolidated.ts` does `.update({status:'released'}).in('id', ids)` today |
| Leg A/B don't pre-check consent — safe? | **CONFIRMED safe** — both gates are scoped only by `visit_id`; a component that just passed both gates guarantees its header (same visit, same txn) passes both |
| `released_by` null-safe via `auth.uid()` | **CONFIRMED**, with note: payments recorded via admin-client flows (gift-code redemption, HMO bridges) run with `auth.uid()=NULL`, so Leg B can legitimately write `released_by=NULL` — nullable, consistent with 0064 precedent |
| Undo cascade nulls `package_completed_at`; `IS NULL` guard re-stamps on re-release; `tg_check_header_completion_on_release` doesn't misfire | **CONFIRMED** (live fn defs) |
| Portal hides an undone result instantly | **CONFIRMED in effect — framing corrected** (see S4/H2: the portal does not actually exercise RLS; every read path re-checks `status='released'` in app code, so the hiding is real but enforced app-side) |
| "Anyone who can release" = medtech/pathologist (+ admin) | **WRONG as stated, right in practice** — live RLS grants UPDATE to **all five staff roles** (reception+admin via an `ALL` policy; medtech/pathologist/**xray_technician** via the UPDATE policy). Reception never sees Release/Undo controls only because `sectionsForRole('reception') = []` filters every test row out of the visit page — the UI section-gate is load-bearing, not the RLS |
| Undoing a header directly is "not offered" | **CONFIRMED, but the server-action guard is the ONLY enforcement** — no CHECK/trigger/RLS blocks a direct header `released → ready_for_release`. Implement the guard exactly as spec'd; it is load-bearing |
| `release_medium = 'other'` is valid | **CONFIRMED** (live CHECK constraint) |
| `VoidPaymentDialog` pattern: required reason, "submit disabled while blank" | **Detail wrong** — the real pattern (`void-payment-dialog.tsx:18-21,65`) is an inline expand, validate-on-click with an inline "Reason is required." error; Confirm is disabled only while pending |

Additional facts the spec's Context section was missing (now added there):

- `tg_header_auto_promote` (BEFORE, 0040): a package header inserted/updated at `in_progress` is force-promoted to `ready_for_release` — headers sit "ready" from the moment of visit creation, before any component has results. (Compatible with Feature 1's Leg A, which flips `ready_for_release → released`.)
- `tg_check_header_completion_on_release` (BEFORE, 0042): stamps `package_completed_at` on the header row itself when it transitions to `released` with all components terminal.
- **A third release path exists**: consolidated chemistry finalisation (`src/lib/actions/results/finalise-consolidated.ts`) bulk-updates group members to `released` — including package components (`parent_id` set) — with a soft `releaseDeferred` when a gate rejects. Feature 1's Leg A, being a trigger, fires correctly from this path too, but the spec must account for it existing.
- Live `bridge_test_request_released` short-circuits rows with `legacy_import_run_id IS NOT NULL` (added after 0064's file; undocumented). Harmless to the spec — the undo trigger's defensive no-JE branch covers it.

---

## 2. Findings — spec-blocking (amendments applied)

### S1 [HIGH] Feature 3's "patient already viewed" warning would silently always show zero
All three patient download paths write a single audit action, `result.downloaded`, with `resource_type='result'` — never `'test_request'` — and **three different metadata shapes**: the single-test path carries `metadata.test_request_id`; the report-group consolidated path carries **no test_request reference at all** (only `resource_id = results.id`); the package-consolidated path keys by header with components only in `metadata.merged_component_ids[]`. The spec's assumed second "access-intent" action **does not exist**. A naive `WHERE action='result.downloaded' AND resource_id = $testRequestId` count returns 0 every time — the RA-10173 safeguard would ship silently broken.
**Amendment:** Feature 3 now specifies a 3-way union count (metadata `test_request_id` match ∪ `resource_id IN (SELECT result_id FROM result_test_requests WHERE test_request_id=$1)` ∪ `merged_component_ids @> [$1]`), plus normalizing all three write sites to also write `metadata.test_request_ids` (array) going forward.

### S2 [HIGH] Bulk-release notification fan-out was unaddressed
As drafted, `releaseAllReadyComponentsAction` fires `notifyResultReleased` per component: a 3-component package = 3 emails + 3 SMS attempts to the same patient within seconds, while the header auto-release moment (the actual "your package is complete") stays silent.
**Amendment (recommended, confirm before PR 2):** the bulk action sends **one consolidated notification per action** ("N results from your visit are ready"); single-component `releaseTestAction` behavior unchanged; header auto-release sends nothing (its components already notified).

### S3 [MEDIUM] Three stuck package headers live, not one — rollout step added
Visits **#0032 (unpaid), #0037 (paid), #0039 (unpaid)** — 100% of package visits ever created — have headers stuck at `ready_for_release`. Feature 1's trigger only acts on new transitions.
**Amendment:** rollout step added to PR 2 — after deploy, release the stuck packages **through the new UI** (bulk button), not a data migration: #0037 releases immediately (paid); #0032/#0039 stay correctly gated until paid. Human actor, real audit rows, notifications fire.

### S4 [MEDIUM] Accuracy corrections
Role list (all five staff roles can release/undo at the DB layer; UI section-gate is the real restriction — documented as load-bearing), portal-visibility framing (app-level released-only filters, not exercised RLS), `VoidPaymentDialog` real pattern, the third release path, the two undocumented package triggers, the legacy-import bridge guard, and Feature 2's filter nuance (**`status='released'` leaf rows, not "terminal"** — a terminal-based mirror would count `cancelled` as released; unit test added to the testing list).

---

## 3. Findings — HIGH, outside the spec's scope

Ranked by (patient impact × proximity). None block the spec; H3/H4 interact with it.

### H1 Sign-off is a dead end one admin click away
`services.requires_signoff` is a live, unguarded checkbox, but `/staff/signoff/page.tsx` is a placeholder and **no code anywhere writes `signed_off_at/by`** — there is no path from `result_uploaded` to `ready_for_release`. Flipping the toggle on any service strands every future result on it. Dormant today (0 of 300 services flagged). *Fix direction: block/warn on the toggle until sign-off is built — or build the sign-off queue; it touches the same status machine as this spec's work.*

### H2 The patient-portal RLS bridge is dead code
`set_patient_context()` has **zero call sites**; every portal read uses the service-role client with hand-written `.eq("patient_id", …)` app filters. The patient RLS policies exist and are correctly scoped — they're just never exercised. Current behavior verified correct on every path (including post-merge logins, which fail closed), but CLAUDE.md's "RLS is the source of truth" is false in practice and one forgotten filter in a future portal page is a cross-patient breach with no DB backstop. *Fix direction: either wire portal reads through the anon role + `set_patient_context()` for real, or codify the admin+filter pattern with a lint/test asserting ownership filters under `portal/**`.*

### H3 HMO / zero-balance visits can never become releasable
Nothing in the codebase ever sets `payment_status='waived'`; the staff payment form has no HMO method; a ₱0 visit can't receive a payment row (`amount_php > 0` CHECK) to trip the recalc's `total=0 → paid` branch. Every HMO visit in prod is legacy-imported; the first live one will be permanently stuck at `unpaid` — and Feature 1's **Leg B will never fire for it**, same root cause. *Fix direction: a gated staff "waive balance / mark HMO-covered" action with reason + audit row. Natural companion PR to this spec's epoch.*

### H4 Voiding a payment never updates the visit's payment status
`trg_payments_recalc` is AFTER **INSERT** only, and its sum doesn't filter `voided_at IS NULL` (the payments skill doc claims it does — stale). The GL reversal books correctly, but a fully-refunded visit stays `paid` forever, so the payment gate keeps passing for new releases on it. Latent — zero voided payments exist in prod. *Fix direction: fire recalc on the void UPDATE and add the voided filter; one small migration.*

### H5 Lab-queue stuck-states: orphaned claims + consolidated-flow holes
(a) **No unclaim/reassign exists** — `assigned_to` is write-once, result entry hard-rejects non-assignees *including admin*; a claimed test whose medtech leaves is stuck at `in_progress` until DB surgery. (b) **Consolidated chemistry flow**: a second medtech can silently steal a claimed group (no optimistic guard; audit logs success either way); `finaliseConsolidatedReport` checks **neither ownership nor role**; `started_at` is never stamped. (c) **"Finalise + release" lies**: when a gate defers release, the server notes `releaseDeferred` but the type never carries it to the client — the medtech is told nothing and believes it released. (c) is the exact silent-failure pattern that produced #0037. *Fix direction: admin reassign action; mirror `claimTestAction`'s guard; ownership check in finalise; thread `releaseDeferred` to the UI.*

### H6 Anon can INSERT directly into `appointments`; double-booking has no DB guard
The public INSERT policy is `with_check(true)` (0001) — anyone with the (by-design public) anon key can insert junk appointments straight past the honeypot, rate limit, and every slot/hours validation, landing in the reception queue. Separately, slot-conflict prevention is SELECT-then-INSERT with **no unique/exclusion constraint** — concurrent requests race into the same slot. *Fix direction: one hardening migration — tighten/replace the public INSERT policy (SECURITY DEFINER RPC) + partial unique index on `(physician_id, scheduled_at) WHERE status NOT IN ('cancelled','no_show')`.*

### H7 Consent time-bomb ahead of enabling the gate
Patients created via public booking or self-reg get **no consent row**, and visit creation never captures one. All 11 live pre-registered patients have `consent_current=false`; three already completed visits. The consent gate is OFF in prod (`consent_settings.gate_required=false`) — the day it's toggled on, those patients' releases block with no warning, surfaced only at release time (and, pre-Feature-1, package components don't even have the button that shows the warning). *Fix direction: intake-time consent capture/banner for `consent_current=false` patients + a pre-flight "active patients without consent" report before anyone flips the gate.*

### H8 Notification send failures are invisible to monitoring
None of the three notifiers report to Sentry; failures land only as audit rows behind the admin emails-sent page. A real Resend domain misconfig ran undetected in June (live audit rows show the 400s). A released result whose notification fails = patient never told, nobody alerted. *Fix direction: `reportError()` on `kind:'error'` results in all three notifiers (+ optional failures digest). Cheap; fold into PR 2's notification work.*

---

## 4. Findings — MEDIUM

- **M1** Reminder cron can't retry: the daily "tomorrow" window shifts past an appointment whose reminder failed — a one-day outage permanently drops those reminders (design gap in the 2026-06-16 reminders spec). Fix: rolling catch-up window (`reminder_sent_at IS NULL AND scheduled_at` in the next N days).
- **M2** Patient merge dead-ends the old DRM-ID+PIN with no notice (fails closed — verified no cross-account leak; 176 merges live). Fix: notify surviving DRM-ID on merge, or login fallback through `merged_into_id`.
- **M3** Portal consent gate is a `z-50` overlay — result data is already in the RSC payload underneath. Fix: suppress the data fetch, not just the UI.
- **M4** Self-registration dedup is silent, weaker than the staff path (exact 3-field vs fuzzy tiers), and SELECT-then-INSERT can double-insert on concurrent submits; no unique constraint backs it (554 live dedup-candidate pairs). Fix: run the fuzzy scorer on `/register` input + advisory lock.
- **M5** `pre_registered` is write-once — nothing ever clears it; "verify identity" badge permanently stale (live: patients with completed staff visits still flagged). Fix: staff "verify identity" action or auto-clear on first visit.
- **M6** No dev/prod guard on outbound notifications — real keys in `.env.local` + `npm run dev` + Release click = real patient emailed. Fix: explicit `NOTIFICATIONS_LIVE`-style env gate.
- **M7** `release_medium` never gates the notification channel — a `physical` hand-off still emails/texts "sign in to view." Needs an explicit product decision (candidate for Feature 1's PR or a follow-up).
- **M8** Critical-value alerts have no acknowledge path — `acknowledged_at/by` columns + RLS exist, no code writes them; realtime-only bell misses alerts fired while no tab is open. Dormant (0 rows live).
- **M9** Deferred consolidated release has no retry hook (component case is closed by Feature 1's buttons; the deferred *state* still deserves a nudge when payment lands).
- **M10** Payments actions return raw `error.message` in places instead of `translatePgError` (void path does it right); staff patient email field lacks `.email()` validation (self-reg has it); PIN *issuance* has no dedicated audit action (reissue does); visit creation uses compensating deletes rather than a transaction (0 damage observed live); double-submit protection on payments is client-only; self-reg rate limit fails open when `x-forwarded-for` is absent (two silent bypasses stack).

## 5. Findings — LOW / INFO

- Audit action-name drift: `test_request.claimed` (single) vs `test_request.claim` (consolidated) — and the consolidated one logs success even on 0-row updates. Feature-5-style exact-string reports would miss grouped claims.
- Patient visit-detail page flattens packages (header shows "No file"); the main portal list handles packages correctly — harmonize alongside Feature 4.
- `updatePatientAction` uses the admin client where the RLS-bound client suffices (the exact pattern the rls-and-auth skill warns about).
- SMS is dead code in prod (Semaphore never configured; 0 of 27 sends succeeded — all `skipped`); module header comment reads as active dual-channel.
- Test/service names (stigma-adjacent for some panels) appear in notification bodies; result *values* correctly never do.
- `/register` + QR poster have **zero production usage** — code-verified only; smoke both branches before printing the poster.
- `status='cancelled'` is unreachable from any staff UI today (0 rows live) — Feature 1's fully-cancelled-package guard is correct but currently moot.
- No visit ↔ appointment linkage; stale `confirmed` appointments accumulate with no no-show sweep (by design, but invisible).
- Migration-version drift hygiene: eight migrations applied remotely under timestamped versions (e.g. 0092–0097, 0104, 0108) while local files use 4-digit names — `supabase migration list` before the first new `db push`, and don't be surprised by the mismatch.
- Two skill docs are stale where it matters: drmed-payments (claims recalc excludes voided rows — it doesn't) and the queue detail page's "header releases automatically" copy (the spec already fixes the latter).

## 6. Verified OK (invariants confirmed end-to-end)

- **Payment gate** (`('paid','waived')` only, transition-to-released only) and **consent gate** are live, DB-enforced, and re-fire on re-release; `translatePgError` already distinguishes both rejection classes.
- **Audit coverage** is comprehensive at every stage (create/claim/finalise/upload/amend/release/void/PIN attempts/downloads/merges), all via the shared `audit()` helper; `audit_log` is never purged.
- **PIN machinery**: 8-char safe alphabet, bcrypt cost 12, 60-day expiry, 5-attempt/15-min lockout + per-IP rate limit, all outcomes audit-logged, plain PIN never logged/stored, reissue is reception/admin-gated. Session cookie has every hardening property CLAUDE.md claims; secret rotation fails to a clean re-login.
- **Books ⇔ status** invariants: JE balance/period-lock/one-posted-per-source constraints all live; PF/COGS "one open row per test_request" indexes are `WHERE voided_at IS NULL`, so undo→re-release inserts cleanly.
- **Single-test claim race** is safe (optimistic `WHERE status='requested'` + row-count check); queue-stage helpers correctly exclude headers and terminal rows (well-tested); structured and PDF result paths converge on the same status machine (0059).
- **Visit #0037 portal view** confirmed live: patient sees the released NA test, "0 of 3 released" for the package, no consolidated download — released components are individually visible regardless of header state, exactly the semantics Features 1/3 assume.
- **No migration drift**: all 108 local migrations applied to prod.

## 7. Go / no-go and recommendations

**GO.** The spec's mechanism is sound — every trigger, constraint, gate, and idempotency behavior it depends on verified against production. The amendments (S1–S4) are applied to the spec in this commit. Rollout order unchanged (Feature 2 → 1+4 → 3 → 5).

**Recommended, same epoch (not in the 4 PRs):**
1. **H3 waive-balance action** — without it, Feature 1 Leg B is dead code for the HMO/zero-balance class.
2. **H4 void-recalc migration** — small, closes a payment-gate integrity hole; natural sibling of this spec's migration work.
3. **H8 Sentry on notifier failures** — one-file change, fold into PR 2.
4. **H1 guard the `requires_signoff` toggle** (disable with a "not yet wired" note) until a sign-off queue exists.

**Schedule separately:** H2 (portal RLS strategy — decide: real RLS vs codified app-filter + lint), H5 (lab-queue ops cluster: reassign/steal-guard/ownership/deferred-visibility), H6 (booking hardening migration), H7 (consent pre-flight before the gate is ever enabled), then the MEDIUMs.

---

## 8. Approved remediation sequence (user-approved 2026-07-04)

The user approved fixing **all** findings. PRs 1–4 are the spec's rollout
order, unchanged. PRs 5–9 below are the remediation grouping — one PR per
subsystem, each self-contained and shippable in order. Finding references
(S/H/M) point at §2–§5 above.

**PR 1 — Feature 2** (spec): Released column in reception Queue. No migration.

**PR 2 — Features 1+4** (spec): header auto-release migration, package-card
release UI (per-component + bulk), harmonized visit layout, consolidated
bulk-action notification (S2), `reportError()` in all three notifiers (H8).
Post-deploy: release the three stuck packages via the new UI (S3).

**PR 3 — Feature 3** (spec): undo-release migration + UI, viewed-warning
union query + `metadata.test_request_ids` normalization (S1).

**PR 4 — Feature 5** (spec): admin undone-releases report.

**PR 5 — Payments integrity:** void→recalc migration (fire
`recalc_visit_payment` on the void UPDATE + `voided_at IS NULL` filter in
the sum; H4); staff "waive balance / HMO-covered" action setting
`payment_status='waived'` — admin-gated, required reason,
VoidPaymentDialog-pattern confirm, audit row (H3); route
`recordPaymentAction`/`redeemGiftCode` errors through `translatePgError`
(M10); correct the stale recalc claim in `.claude/skills/drmed-payments/SKILL.md`.

**PR 6 — Lab queue operations:** admin unclaim/reassign action for
`assigned_to` (audit-logged; H5a); consolidated-flow fixes — optimistic
claim guard + row-count check + `started_at` stamp + unify audit action to
`test_request.claimed`, ownership check in `finaliseConsolidatedReport`,
thread `releaseDeferred` to the UI so the medtech sees "finalised — release
deferred until payment" (H5b/c); disable the `requires_signoff` service
toggle with a "sign-off queue not yet built" note (H1 — full sign-off queue
deliberately deferred, see below); critical-value acknowledge action +
unacked-alerts list page (M8); "stuck tests" admin report
(`in_progress`/`ready_for_release` older than N days — proactive guard for
this audit's whole bug class).

**PR 7 — Booking + registration hardening:** migration tightening the
public `appointments` INSERT (SECURITY DEFINER RPC or real `with_check`) +
partial unique index `(physician_id, scheduled_at) WHERE status NOT IN
('cancelled','no_show')`, app catches the unique-violation as `slot_taken`
(H6); reminder cron rolling catch-up window (M1); fuzzy-dedup advisory on
`/register` + advisory lock around resolve's check-then-insert (M4);
`pre_registered` clearing — auto-clear on first staff visit + explicit
"verify identity" action (M5); `.email()` on staff patient schemas, loud
rate-limit fail-open, `ipAndAgent()` reuse (M10). Operational note: smoke
`/register` (both branches) before the QR poster ships.

**PR 8 — Consent + notification correctness:** intake consent capture/
banner for `consent_current=false` patients + admin "patients without
consent" pre-flight report (H7); portal consent gate suppresses the data
fetch instead of overlaying (M3); `NOTIFICATIONS_LIVE`-style env guard
(M6); skip email/SMS when `release_medium='physical'`/`'pickup'` (M7);
patient-merge notification of the surviving DRM-ID (M2); `visit_pin.issued`
audit row (M10); fix SMS comment drift + use the RLS-bound client in
`updatePatientAction` (LOWs).

**PR 9 — Portal RLS enforcement (H2):** wire portal reads through an
anon-key client + `set_patient_context()` so the patient RLS policies
actually enforce; keep the app-level ownership filters as
defense-in-depth; add a test asserting every `portal/**` query is
ownership-scoped. If real RLS wiring proves infeasible mid-implementation,
STOP and report — do not silently fall back to documenting the admin-client
pattern. Optional rider: harmonize the patient visit-detail page's package
display with the main list's PackageCard.

**Explicitly deferred (not in this programme):** building the real
pathologist sign-off queue (needs workflow design with the pathologist;
PR 6's toggle guard defuses the hazard); "add test to existing visit" flow;
genericized wording for stigma-sensitive service names in notifications
(product decision); visit↔appointment linkage/no-show sweep.

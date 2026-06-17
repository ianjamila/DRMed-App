# Patient-Dedup Hardening — Design

- **Date:** 2026-06-17
- **Branch:** `feat/patient-dedup-hardening` (off `origin/main` @ `7f190f1`)
- **Status:** Design — approved for spec; pending writing-plans
- **Domain skills:** `drmed-booking-and-intake` (resolve.ts core), `drmed-rls-and-auth` (audit, RLS, enumeration), `drmed-migrations` (view/table/trigger), `drmed-staff-ui` (dashboard card, cross-links)

## 1. Problem & prod sizing

Today, patient dedup (`src/lib/patients/resolve.ts`, shared by `/schedule` booking, the
staff `+ New appointment` slide-over, and `/register`) is a **silent exact match** on
`lower(email) + last_name + birthdate`. A returning customer who enters a different
email, surname, or birthdate gets a brand-new DRM-ID. RA 10173 rules out a public
"is this you?" confirm (patient enumeration), which is *why* the dedup is silent.

Sizing on prod (`DRMed App` = `qhptbmafrosgibooelpp`, active rows = `merged_into_id IS NULL`):

| Fact | Value |
|---|---|
| Active patients | 6,843 |
| └ legacy-import rows (`legacy_import_run_id` set) | 6,839 |
| └ **organic** (booking / register / reception) | **4** |
| No email on file | 4,988 (73%) |
| Full phone on file | 3,671 (53%) |
| Merges already done (tombstones) | 176 |

Duplicate candidates the exact key **misses** today:

| Signal | Clusters | Patients | Organic-only |
|---|---|---|---|
| Same email, name/birthdate differs | 85 | 194 | 0 (83 legacy-only, 2 mixed) |
| Same last_name + birthdate, diff email | 8 | 16 | 0 |
| Same first+last+birthdate, diff email (strongest) | 1 | 2 | — |
| Same phone, multiple identities | 286 | 658 | 0 organic |
| └ same surname (likely real dup) | 170 | — | — |
| └ **different surname (shared family phone — NOT a dup)** | **116** | — | — |

**Two facts steer the whole design:**

1. **Phone is a dangerous match key.** 41% (116/286) of multi-identity phone clusters are
   different-surname — families sharing one number. Phone must only ever be a **weak
   warning signal**, never an auto-reuse or auto-merge key.
2. **The backlog is ~99% a legacy-import artifact; organic intake has barely run** (4
   patients). So this work is mostly **forward-looking prevention + a legacy cleanup
   tool**, not patching a live organic leak. Traffic is about to grow (domain cutover +
   SEO Tier 1 just shipped), so prevention is cheap insurance now.

## 2. Goals, non-goals, principles

**Goals**
- Stop *new* duplicates at the **authenticated** surfaces (staff create-patient flows).
- Give returning patients a self-serve way to recover their DRM-ID so they don't create a new record (public, enumeration-safe).
- Give admins a ranked **possible-duplicates report** that feeds the existing merge tool, to clear the legacy backlog.
- Make every merge **reversible within a window** so the cleanup is low-risk.

**Non-goals**
- No auto-merge, ever. No silent auto-reuse on a loosened key.
- No change to the public `/schedule` / `/register` *silent dedup* key in `resolve.ts`
  (public surfaces can't show candidates without enabling enumeration; prevention there
  is the recovery flow).
- No SMS/WhatsApp channels (email-only per project policy).

**Principles**
- **A wrong merge is worse than a duplicate.** Every merge is an explicit human confirm; merges are reversible.
- **One scoring source of truth** — blocking in SQL, scoring in pure, unit-tested TS.
- **Enumeration safety on public surfaces** — never reveal a DRM-ID on screen for a match; email it to the on-file address; always show the same neutral response.

## 3. Architecture — shared scoring layer

```
src/lib/patients/
├── resolve.ts          UNCHANGED — exact-key silent dedup (public + staff "new")
├── duplicates.ts       NEW · PURE (no "server-only") · vitest-tested
│     scorePair(a, b) → { score, signals[], tier }
│     normalizeForMatch(fields)  (lower/trim helpers shared with SQL semantics)
└── find-duplicates.ts  NEW · DB wrapper (receives admin client, like resolve.ts)
      loadCandidatePairs(admin)         → admin report (reads the SQL view)
      findCandidatesForInput(admin, f)  → staff near-match warning (one-vs-all)
```

Mirrors the codebase's existing **pure-logic / DB-I/O split** (`timing.ts` pure ↔
`create.ts` DB). **SQL does blocking only** (set logic, indexed). **TS does all
scoring** (`scorePair`) → the report and the staff warning are guaranteed to agree.

## 4. Scoring engine — `duplicates.ts` (pure)

`scorePair(a, b)` takes two already-normalized candidate field sets
(`{ first_name, last_name, birthdate, email, phone_normalized, address, sex }`) and
returns `{ score, signals[], tier }`.

**Signals** (booleans/derived, each surfaced as a labeled chip in the UI):

| Signal | Definition |
|---|---|
| `exact_email` | both non-null, normalized-equal |
| `same_birthdate` | both non-null, equal |
| `same_last_name` | normalized-equal |
| `same_first_name` | normalized-equal |
| `fuzzy_name` | similarity(first+' '+last) ≥ 0.85 **and** not exact first+last |
| `same_phone` | `phone_normalized` equal, both 10 digits |
| `same_address` | both non-null, normalized-equal |
| `same_sex` | both non-null, equal |

**Weights** (points):

| Signal | Points |
|---|---|
| `exact_email` | +50 |
| `same_birthdate` | +25 |
| `same_last_name` | +15 |
| `same_first_name` | +15 |
| `fuzzy_name` | +10 |
| `same_phone` | +20 (see guard) |
| `same_address` | +10 |
| `same_sex` | +3 |

**Tiers:**
- `exact_dup` — `exact_email && same_first_name && same_last_name && same_birthdate` (definitionally the same person, regardless of score).
- `strong` — score ≥ 70 **and** passes the corroboration guard.
- `probable` — score ≥ 45 **and** passes the corroboration guard.
- `weak` — score ≥ 25.
- below 25 → not a candidate (filtered out).

**Family-phone / corroboration guard (the crux):** a pair may only reach `strong` or
`probable` if it has at least one **non-phone identity corroboration** — one of
`{ exact_email, (same_birthdate && same_last_name), (same_first_name && same_last_name),
(fuzzy_name && same_birthdate) }`. A pair whose only positive signals are
`same_phone` (+ optionally `same_address`/`same_sex`) **stays `weak`**, no matter the
points. This is what keeps the 116 family-phone clusters out of the actionable tiers.
Additionally, `same_phone` contributes only +8 (not +20) when `same_last_name` is false.

Pure → exhaustively vitest-tested (see §13).

## 5. SQL blocking layer + phone normalization

### 5a. Phone normalization (folded-in extra #2)
Add a maintained normalized phone so blocking is robust and index-friendly (no regex in
the hot path forever):
- `patients.phone_normalized text` — last 10 digits of the digits-only phone.
- `trg_patients_normalise_phone` BEFORE INSERT/UPDATE OF phone → sets it (NULL when < 10 digits).
- Index `idx_patients_phone_normalized` (partial, `WHERE phone_normalized IS NOT NULL`).
- One-time backfill of existing rows in the migration.

### 5b. Candidate-pairs view
`v_patient_dedup_candidate_pairs` (`security_invoker = true` → staff RLS applies) emits
candidate **pairs** `(id_a < id_b)` where both rows have `merged_into_id IS NULL` and
they share **≥1 blocking key**:
- same normalized email, OR
- same `phone_normalized`, OR
- same `last_name` + `birthdate`, OR
- trigram name match (uses `idx_patients_name_trgm`; threshold ~0.6 in SQL, refined by TS scoring).

The view returns the **raw fields for both sides** (id, drm_id, first/last/middle name,
birthdate, email, phone_normalized, address, sex, pre_registered, legacy flag,
created_at) — **no score** (scoring is TS). Expected output is a few hundred pairs, so
TS-side scoring of the full set is cheap.

## 6. Component D — admin "possible duplicates" report

- Route: `/staff/admin/patient-merge/candidates` (adjacent to the existing merge tool;
  cross-linked both ways in the page header). Admin-gated (`requireAdminStaff`).
- `loadCandidatePairs(admin)` reads the view → `scorePair` each → filter to `tier >=
  probable` by default (a query-param toggle reveals `weak`) → sort by score desc →
  **group by shared cluster**.
- Each pair row shows both records (name, DRM-ID, birthdate, email, phone), the matched
  **signal chips**, the **tier badge**, and a **legacy/organic** marker.
- **Per-pair "Review & merge"** inline (folded with extra #5 undo): opens a confirm with
  a **merge preview** (counts of visits/appointments/etc. that will move, from a dry
  count) → single confirm reuses the existing audited merge path. No bulk merge.
- A "Recently merged" panel lists merges still inside the undo window with an **Undo**
  action (see §10 undo).

## 7. Component C — staff near-match warning

- `checkPatientDuplicatesAction(fields)` (new server action) → `findCandidatesForInput`
  → small blocking query
  `(email = X) OR (phone_normalized = Y) OR (last_name = L AND birthdate = B)` over
  active patients → `scorePair(input, row)` → return `tier >= probable`, sorted.
- Wired into **two surfaces**, called debounced from the client as the user fills
  name + birthdate + email/phone:
  1. `+ New appointment` slide-over **"New patient" mode** (`new-appointment-sheet.tsx`).
  2. Reception's **`/staff/patients/new`** form.
- Renders matched patient(s) inline (name, DRM-ID, birthdate — staff are authorized, no
  enumeration concern) with **"Use this patient instead"** → switches the flow to the
  existing record (slide-over: switch to Existing mode preselected; reception form:
  navigate to that patient). **Non-blocking.**
- **Soft confirm only on the `exact_dup` tier:** creating a separate record despite a
  near-certain match requires one explicit acknowledge click, and the create-anyway is
  audit-logged (`patient.create.dup_override` with the matched DRM-ID). Everything weaker
  is purely advisory.

## 8. Component A — public "email me my DRM-ID" recovery

- Route: `/find-my-id` (marketing group). Controlled-input client form (React-19 form
  reset gotcha). Linked from the portal sign-in ("Forgot your DRM-ID?") and the
  `/schedule` existing-patient path.
- Fields: `email`, `last_name`, `birthdate` (the exact dedup key). New rate-limit bucket
  `patient_id_recovery` + honeypot.
- `recoverDrmIdAction(fields)` looks up the exact dedup key. On a match → emails the
  DRM-ID to the on-file address (== the supplied email) via `sendEmail` +
  `renderEmailShell` + `emailHighlight` (the exact `/register` matched-path pattern).
  **Always returns the same neutral message** regardless of match
  ("If a record matches those details, we've emailed the DRM-ID to that address") —
  never reveals on screen.
- Recovery is **email-key only** (no phone lookup) — phone-based recovery could leak a
  DRM-ID to a family member sharing the number.
- Audits `patient.id_recovery.matched` / `patient.id_recovery.no_match` (actor anonymous).
- Copy for the 73% no-email legacy patients: "No email on file? Please visit or call
  reception."

## 9. Component B — phone as a secondary signal (folded)

Phone is **not** a key anywhere. It is a single weighted signal inside `scorePair`
(+20, or +8 when surnames differ), gated by the corroboration guard so it can never push
a different-surname pair into an actionable tier. Surfaced as a "same phone" chip in both
the report and the staff warning.

## 10. Folded-in extras (now in scope)

1. **Legacy backlog cleanup (operational).** Post-deploy runbook in §15: an admin works
   the report `strong → probable`, merging true dups (the 194 email-missed + 170
   same-surname-phone candidates). The 116 family-phone clusters appear only as `weak`
   (guarded) and are skipped.
2. **Phone-normalization column + trigger** — see §5a.
3. **Admin-dashboard card** — add a `DASHBOARD_CARDS` entry (`src/lib/dashboards/cards.ts`),
   admin-only: "Possible duplicates" with the open-candidate count (pairs at
   `tier >= probable`, computed by reusing `loadCandidatePairs` + filter — a few hundred
   pairs, cheap) linking to the report.
4. **Weekly digest cron** — `/api/cron/dedup-digest` (Vercel cron in `vercel.json`,
   e.g. `0 1 * * 1` Mondays), CRON_SECRET-guarded like `appointment-reminders`. Counts
   open candidates by tier, lists the top `strong` pairs, emails admin recipients
   (`staff_profiles` role=admin with email) via the branded email shell. Audits a
   `system` action.
5. **Merge undo window.** New table `patient_merges` records each merge with the exact
   **moved row IDs** (captured via `UPDATE … RETURNING`) and the `filled_from_source`
   field list. The existing merge action writes this row. New `undoMergeAction(mergeId)`
   (admin, within an undo window — constant, e.g. 30 days, and not already undone)
   reverses: re-point the recorded row IDs back to `source_id`, restore the source row
   (`merged_into_id = NULL`, `merged_at = NULL`), null out exactly the
   `filled_from_source` fields on the kept row (safe: merge only fills fields that were
   NULL on keep), mark `undone_at`/`undone_by`, audit `patient.merge.undone`.

## 11. Data model / migrations

Sequential, applied to prod via Supabase MCP (IPv6 push gotcha), then `npm run db:types`:

- **0105** — phone normalization: `phone_normalized` column + `trg_patients_normalise_phone` + index + backfill.
- **0106** — `v_patient_dedup_candidate_pairs` view (`security_invoker = true`).
- **0107** — `patient_merges` table + RLS (staff `has_role` select; writes service-role
  only) + indexes (`keep_id`, `source_id`, `merged_at`, partial `WHERE undone_at IS NULL`).

(May be consolidated into fewer files at plan time; kept separate here for clarity.)

## 12. Audit & rate-limit additions (no migration — text values)

- Audit actions: `patient.create.dup_override`, `patient.id_recovery.matched`,
  `patient.id_recovery.no_match`, `patient.merge.undone`, `system.dedup_digest.sent`.
  (Existing `patient.merged` is extended to also write the `patient_merges` row.)
- Rate-limit bucket: `patient_id_recovery` (add to the `RateLimitBucket` union + `RATE_LIMITS`; suggest 60 min / max 5, per-IP — mirrors `patient_registration`).

## 13. Testing

- **vitest `duplicates.test.ts`** (pure): the full signal matrix; tier thresholds;
  `exact_dup` detection; **family-phone never reaches strong/probable** (different
  surname + same phone → `weak`); fuzzy-name edges (near-match vs unrelated); phone
  down-weighting when surnames differ; null/empty field handling.
- **vitest** for `RecoverIdSchema` (and any new zod schemas) edge cases.
- **DB orchestration** (`find-duplicates.ts`, the actions, the view, the cron, undo) is
  verified by `npm run typecheck` + `npm run build` + manual/Playwright smoke against the
  **local** Supabase stack (or the prod-smoke recipe): report renders + ranks; staff
  warning fires + "use this" switches; recovery emails on match and is neutral on miss;
  a merge + undo round-trips cleanly.

## 14. File manifest

**New**
- `supabase/migrations/0105_patient_phone_normalized.sql`
- `supabase/migrations/0106_patient_dedup_candidates_view.sql`
- `supabase/migrations/0107_patient_merges.sql`
- `src/lib/patients/duplicates.ts` + `duplicates.test.ts`
- `src/lib/patients/find-duplicates.ts`
- `src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/page.tsx` (+ inline merge/undo client + actions)
- `src/app/(marketing)/find-my-id/page.tsx` + `find-my-id-form.tsx` + `actions.ts`
- `src/app/api/cron/dedup-digest/route.ts`
- staff dup-check action (e.g. `src/lib/patients/check-duplicates-action.ts` or colocated)

**Modified**
- `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts` — capture moved IDs (`RETURNING`), write `patient_merges`, add `undoMergeAction`.
- `src/app/(staff)/staff/(dashboard)/admin/patient-merge/page.tsx` + merge-client — cross-link + "recently merged / undo".
- `new-appointment-sheet.tsx` + `new-appointment-actions.ts` — near-match warning in "New" mode.
- `/staff/patients/new` form + its action — near-match warning + `exact_dup` soft confirm.
- `src/lib/dashboards/cards.ts` — "Possible duplicates" admin card.
- `src/lib/rate-limit/check.ts` — `patient_id_recovery` bucket.
- portal sign-in page + `/schedule` existing-patient path — "Forgot your DRM-ID?" link.
- `vercel.json` — `dedup-digest` cron.
- `src/types/database.ts` — regenerated after migrations.

## 15. Rollout / ops

1. Land migrations on prod via MCP; `npm run db:types`.
2. Deploy. Verify the report renders and the staff warning fires.
3. **Legacy cleanup session:** admin works the report `strong → probable`, merging true
   dups; `weak` (incl. family phones) skipped. Merges are undoable within the window.
4. Confirm the weekly digest fires (or trigger once manually) and lands in an admin inbox.

## 16. Risks / open questions

- **Undo edge case:** if someone edits a kept-row field that was filled-from-source
  *between* merge and undo, undo nulls it. Mitigated by the short window + admin-only;
  acceptable.
- **Trigram threshold tuning:** SQL block threshold (~0.6) is intentionally loose
  (recall), with TS `fuzzy_name` (≥0.85) as the precise gate. May need tuning against the
  real legacy set during the cleanup session.
- **Digest recipients:** sourced from `staff_profiles` role=admin with an email; if none
  have emails set, the cron no-ops gracefully (logs/audits skipped) — matches the
  email-only "skip when unconfigured" pattern.

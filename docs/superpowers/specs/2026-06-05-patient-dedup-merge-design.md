# Patient de-dup / merge pass — design

**Date:** 2026-06-05
**Status:** Design approved, ready for implementation plan
**Context:** Part B prerequisite of the operational-analytics dashboard project
([[project-ops-analytics-dashboard]]). Follows the clinical backfill (v1.15.0)
and Part A enrichment (v1.16.0 / v1.16.1).

## Problem

The `patients` table contains duplicate records of the same person, introduced
by the **v1.11.0 CUSTOMER_LIST2 import (2026-05-25)**: same phone, or
birthdate+name, with typos, missing DOB, and double-submits (e.g. BLANCAFLOR
ELMER ×4 incl. exact dup DRM-1837/1838).

Two concrete harms:

1. **Marketing/Growth pack accuracy (the primary driver).** Part B's
   distinct-customer count and new-vs-repeat split are computed from the
   `patients` table. Duplicates inflate distinct customers and corrupt
   new-vs-repeat.
2. **Held clinical data.** The clinical backfill matches a transaction's patient
   by name (`matchKey` = surname + first given token). When a name maps to 2+
   patient rows it returns `ambiguous` and **holds** the row rather than guess
   (RA 10173 — correct). ~245 doctor consults (and a larger set of lab tests)
   are currently held this way. Collapsing the duplicate patient rows to one
   surviving row makes the name resolve uniquely, so a **re-run of the backfill
   auto-attaches** the held clinical data with no hand-work.

## Grounding facts (prod `qhptbmafrosgibooelpp`, verified 2026-06-05)

- **7,015 live patients** (`merged_into_id is null`).
- Duplicate clusters by key:
  - same normalized **name**: 165 clusters / 340 rows
  - same **phone**: 347 clusters / 805 rows
  - same **name + DOB**: 98 clusters / 199 rows
- **Phone alone is unsafe.** Of the 347 phone clusters, only **56 share the same
  name**; the other **291 are different-name rows on the same phone** — families
  sharing one number. Auto-merging on phone alone would fuse different people.
- **The high-confidence dup rows are near-empty stubs.** The 241 rows that clear
  a high-confidence tier (name+DOB or name+phone) carry **0 consents, 0 alerts,
  0 appointments, 1 visit total**. The clinical data isn't on them — it's in the
  held pile, waiting for de-dup. The merge is therefore mechanically near-trivial;
  its value is collapsing the stubs so the re-run backfill can attach the held data.

## Risk model (why the policy is conservative)

Under RA 10173, merging two **different** people is a real breach: person A's
visits/results get welded onto person B's record, and B could later pull A's labs
through the patient portal. A **missed** merge merely leaves a duplicate that
slightly inflates a count. Wrong-merge ≫ missed-merge, and the merge is
effectively irreversible. Therefore: **auto-merge only at near-certain
confidence; review the rest.**

## Decisions (locked via brainstorm)

### Merge policy: auto high-confidence, review the medium tier

A cluster member is **auto-merged** into the canonical row only when it clears
one of these tiers **and conflicts on nothing**:

- **Tier 1** — same name **+ same exact DOB**
- **Tier 2** — same name **+ same phone**, DOB compatible (equal, or missing on one)
- **Tier 2′** — same name **+ same email** (email is a strong identifier)

**Hard guards** that veto an auto-merge regardless of tier, applied **pairwise
against the chosen canonical**:

- DOBs both present and **different** → skip (catches Jr/Sr on a shared family phone)
- Sex both present and **different** → skip

Because the test is pairwise against the canonical, a **mixed cluster** folds the
true duplicates and leaves the odd member out (→ review).

Everything that does **not** clear a high-confidence tier — name-only with no
corroborating DOB/phone/email, or any conflict — goes to a **review CSV**, not
auto-merged. This mirrors the stance the backfill already takes by holding
ambiguous rows. The user actions these later via the existing admin merge UI
(`/staff/admin/patient-merge`).

### Canonical (kept) row selection

Within a cluster, keep the row with priority:

1. **most visits** attached, then
2. **most-complete** profile (fewest null fields among phone/email/birthdate/sex/address/middle_name), then
3. **oldest** — earliest `created_at`, tie-broken by lowest DRM-ID number.

Stakes are low: the merge fills missing fields from the source either way, and a
tombstoned row's old DRM-ID still resolves to the canonical row (patient
auth/receipts follow `merged_into_id`), so the choice can't break a patient login.

### Clustering key must match the backfill exactly

Clustering uses **`matchKey(last_name, first_name)`** imported from the backfill's
`scripts/clinical-backfill/lib/names.ts` (surname + first given token, diacritics
stripped) — reconstructed from the patients table's structured `last_name` /
`first_name` columns, exactly as `buildPatientIndex` in
`scripts/clinical-backfill/lib/patient-match.ts` does. If this key drifts from the
backfill's, merges won't dissolve the held rows. The same module must be the
single source of truth.

## Architecture

A standalone script package `scripts/patient-dedup/`, mirroring the existing
`scripts/clinical-enrich/` and `scripts/clinical-backfill/` engines: a pure,
unit-tested core + an engine on the Supabase **admin (service-role) client** + a
dry-run-gated CLI. The admin client talks HTTPS, so the IPv6 direct-DB
limitation does not apply — the same path `enrich:clinical` already uses against
remote.

```
scripts/patient-dedup/
  index.ts            # CLI entrypoint; parses flags, calls engine
  engine.ts           # loads rows, builds plan, dry-run reporting + commit
  validate.sql        # post-run verification queries
  lib/
    normalize.ts      # re-exports matchKey from backfill names.ts; phone/email normalizers
    cluster.ts        # (pure) group live patients into dup clusters
    cluster.test.ts
    plan.ts           # (pure) canonical pick + per-member AUTO/REVIEW classification
    plan.test.ts
```

New npm script: `"dedup:patients": "tsx --env-file=.env.local scripts/patient-dedup/index.ts"`.

### Components

**`lib/normalize.ts`** — re-exports `matchKey`, `normalizeName` from
`../../clinical-backfill/lib/names`. Adds:
- `phoneKey(raw)` → digits-only, or `null` if `< 7` digits.
- `emailKey(raw)` → `lower(trim(raw))` or `null`.

**`lib/cluster.ts`** *(pure, no I/O)* —
- Input: `PatientRow[]` (`id, drm_id, first_name, last_name, middle_name, sex, phone, email, birthdate, address, created_at, visit_count`).
- **Clusters strictly by `matchKey`** — a simple group-by on the name key. A
  cluster is any key shared by ≥ 2 live rows. Corroborating signals
  (DOB/phone/email) are **not** used here; they're a `plan.ts` concern. This keeps
  families safe by construction: different surnames produce different keys and are
  never joined, so a shared phone can never pull two different people into one
  cluster.
- Returns `Cluster[]` (each = `PatientRow[]`, size ≥ 2).
- **Known limitation (acceptable):** a duplicate with a *misspelled surname*
  produces a different `matchKey` and won't cluster. That's deliberate — it keeps
  clustering identical to the backfill matcher (so this pass dissolves exactly the
  held set) and avoids reintroducing cross-name phone joins. Such cases, if any,
  land in neither pile here and remain for manual admin merge.

**`lib/plan.ts`** *(pure, no I/O)* —
- `pickCanonical(cluster)` → the kept row per the priority rule above.
- For each non-canonical member, `classify(member, canonical)` →
  `{ action: "auto", tier: "name+dob"|"name+phone"|"name+email" } | { action: "review", reason }`.
  - `auto` requires a tier hit **and** no DOB-conflict **and** no sex-conflict.
  - `review` reasons: `"name-only"`, `"dob-conflict"`, `"sex-conflict"`.
- Returns a `ClusterPlan { canonical, auto: Member[], review: Member[] }`.

**`engine.ts`** —
- Loads all live patients (`merged_into_id is null`) with a per-row visit count
  (single grouped query, not per-row — backfill perf lesson).
- Builds clusters → plans.
- **Dry-run (default):** prints a summary (clusters, auto-merge count, review
  count, rows affected) and writes two CSVs to `tmp/`:
  `patient-dedup-auto-plan-<ts>.csv` and `patient-dedup-review-<ts>.csv`.
- **Commit (`--commit --confirm="I-mean-it"`):** for each `auto` member, runs the
  merge op below. Idempotent — skips a source already tombstoned.

**`index.ts`** — flag parsing + gating identical to `enrich:clinical`:
default dry-run; `--commit` requires `--confirm="I-mean-it"` (exit 3 otherwise).
Target DB is whatever `.env.local` points at (currently remote/prod); there is no
separate `--prod` flag, matching the enrich convention.

### The merge op (per source → canonical)

The admin Server Action's semantics
(`src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts`), **corrected
to cover all five FK tables** (the Server Action currently reassigns only
visits/appointments/audit_log and silently skips `critical_alerts` and
`patient_consents`):

1. Reassign `patient_id = canonical WHERE patient_id = source` on: **visits,
   appointments, audit_log, critical_alerts, patient_consents**.
2. Re-point chains: `UPDATE patients SET merged_into_id = canonical WHERE
   merged_into_id = source`.
3. Fill-missing on canonical from source — `middle_name, sex, phone, email,
   address, **birthdate**` — never overwrite a non-null value. (Birthdate is added
   vs. the Server Action because import stubs often carry DOB on only one row.)
4. Tombstone source: `merged_into_id = canonical, merged_at = now`.
5. Write one `audit_log` row: `action = "patient.merged"`, system actor
   (consistent with how the backfill/enrich engines write audit rows), metadata =
   `{ kept_drm_id, merged_drm_id, merged_patient_id, tier, moved: { ... } }`.

Sequential and idempotent — no SQL transaction needed. A partial failure re-runs
cleanly: already-moved FK rows are no-ops, an already-tombstoned source is skipped.

> **Follow-up (out of scope here, noted):** the admin Server Action should be
> patched to also reassign `critical_alerts` + `patient_consents`. Tracked
> separately so this data pass isn't blocked on UI work.

## Data flow / runbook

```
1. npm run dedup:patients                              # dry-run; review the two CSVs
2. npm run dedup:patients -- --commit --confirm="I-mean-it"
3. npm run backfill:clinical:consult -- --commit --confirm="I-mean-it"   # attach held consults
   npm run backfill:clinical:lab     -- --commit --confirm="I-mean-it"   # attach held lab tests
4. npm run enrich:clinical -- --commit --confirm="I-mean-it"             # attribute doctor/discount on newly-attached visits
5. psql/MCP: run scripts/patient-dedup/validate.sql
```

All of steps 2–4 are **GL-silent** (the 0091 guard blocks any GL side-effect;
the backfill/enrich are already GL-silent). No migration is required — the merge
uses existing columns (`merged_into_id`, `merged_at` from 0025).

## Verification (`validate.sql`)

- live-patient delta (before vs after), and count of new tombstones.
- duplicate clusters remaining by each key (expect high-confidence tiers → 0).
- held ambiguous consults remaining (expect a large drop).
- `audit_log` rows with `action = 'patient.merged'` written this pass.
- **GL leak = 0** (reuse the backfill/enrich GL-silence assertion).

## Testing

`vitest`, pure logic only (no `server-only`, no DB):

- **`cluster.test.ts`**
  - family on a shared phone (different surnames) → **not** clustered together.
  - three rows with the same `matchKey` → one cluster of size 3.
  - name-only pair (no corroboration) → still clustered (so it reaches review).
  - misspelled-surname duplicate → separate clusters (documented limitation).
- **`plan.test.ts`**
  - Tier 1/2/2′ each → `auto` with the right tier.
  - Jr/Sr same name+phone, conflicting DOB → `review: dob-conflict`.
  - same name, conflicting sex → `review: sex-conflict`.
  - name-only, no DOB/phone/email → `review: name-only`.
  - mixed cluster: two members auto, one conflicting member → review (partial merge).
  - canonical priority: most-visits beats more-complete beats older; ties fall through.

## Scope

**In scope:** the de-dup script + tests, the dry-run CSVs, the commit path, the
validate SQL, and the post-merge runbook (re-run backfills + enrich).

**Out of scope (by design):**
- The 291 different-name-shared-phone clusters (families) — never merged.
- Name-only clusters with no corroboration — written to the review CSV for the
  user to action via the existing admin merge UI; not auto-merged.
- Patching the admin Server Action's missing FK reassignments (noted as a
  follow-up, tracked separately).
- Part B itself (SQL views, Daily report, dashboard packs) — its own plan, written
  against the cleaned data after this pass lands.

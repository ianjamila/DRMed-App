# Historical Clinical Backfill — Design Spec

**Date:** 2026-06-03
**Status:** Approved design, pending spec review → implementation plan
**Related:** `2026-05-25-legacy-customer-import-design.md` (patient import, v1.11.0),
Phase 12.B books import (`scripts/history-import/*`), `0030_op_gl_bridge.sql`,
`0090_split_visit_and_consult_anchor.sql`

---

## 1. Context & goal

`drmed.ph` is live. Three data layers were supposed to be backfilled from the
legacy system; two already are:

| Layer | Prod state (2026-06-03) | Status |
|---|---|---|
| Patients | 4,297 (`legacy_import_run` provenance) | ✅ done (v1.11.0) |
| Accounting books — `journal_entries` (`source_kind='history_import'`) | 22,009 JEs, 2023-12 → 2026-07 | ✅ done (12.B) |
| HMO subledger — `historic_hmo_claims` | 6,033 | ✅ done (12.A/12.B) |
| **Clinical operational — `visits` / `test_requests` / `results` / `payments`** | **3 / 11 / 4 / 2 (test data only)** | ❌ **this project** |

The **clinical operational layer is empty**. The goal is to backfill it so the
real 2023-12 → cutover history populates the operational app surfaces
(per-patient visit history, the visits/queue pages, operational dashboards),
**consistent with — and without disturbing — the books already loaded.**

### Locked decisions (from brainstorm, 2026-06-03)

1. **Fidelity: full operational mirror.** Reconstruct `visits` + `test_requests`
   (at `status='released'`) + `payments` for amounts actually collected, with
   `payment_status` reflecting what was paid.
2. **Window: 2023-12 → app cutover.** Start Dec 2023 to match the books' date
   span exactly. Cutover = first real app use (~2026-05-26); rows dated on/after
   cutover are the app's responsibility, not the sheet's.
3. **Unmatched patients: create new patient records** (with strong dedup), since
   the sheet's transacting population is a superset of the registered 4,297.
4. **Tooling: standalone import scripts** reusing the proven 12.B / legacy-import
   ergonomics (ExcelJS reader, dry-run → review CSVs → `--commit --confirm`,
   `requireLocalOrExplicitProd` guard).

### Non-goals

- **No result values / PDFs.** The source is a billing ledger with no lab values
  or doctor notes. Historical `test_requests` are released metadata shells with
  **no `results` row**. Patient-downloadable historical results is explicitly out
  of scope (would need a different source).
- **No new accounting entries.** The backfill is **GL-silent** — the books
  already hold every peso (22k history_import JEs).
- Not an in-app/self-service tool. One-time CLI backfill.

---

## 2. Source data

`~/Downloads/DR MED MASTERSHEET.xlsx` (7.6 MB) — the same file 12.B reads.
Two tabs, one row per service line (column maps already encoded in
`scripts/history-import/lab-services.ts` and `doctor-consultations.ts`):

**`LAB SERVICE`** (~6,500 rows/yr): `posting_date`, `control_no`, `test_no`,
`patient_name`, `hmo_flag`, `hmo_provider`, `service`, `base`, `final`, `mop`,
HMO billing/payment status, OR number, dates.

**`DOCTOR CONSULTATION`**: same shape plus `clinic_fee` and `doctor_pf` (the
clinic recognises only `clinic_fee`; PF passed through to the doctor).

There is **no stable patient identifier** in the sheet — patients appear by
`patient_name` (free text, mixed `"Last, First Middle"` / `"First Last"`). The
registered-patient list (`patients`) also has only names (birthdates blank,
"Age" garbage). **Matching is name-only.**

`control_no` is the per-transaction receipt number → the **visit grouping key**.
`test_no` is per service line within a transaction.

---

## 3. End state & success criteria

For each in-window sheet row that is postable and patient-resolvable:

- A `visits` row exists (one per `(tab, control_no)` encounter), with
  `payment_status` computed from inserted `payments`, `total_php` = Σ line
  finals, correct `patient_id`, HMO provider when applicable.
- One `test_requests` row per service line, `status='released'`, prices
  snapshotted, `legacy_import_run_id` + `legacy_source_ref` set.
- A `payments` row for the collected amount (omitted when nothing was collected).
- **Zero** new `journal_entries` created by the backfill (GL-silence assertion).
- Re-running the importer inserts nothing new (idempotent).
- Reconciliation: clinical `Σ final_price` per year ties (within tolerance) to
  the books' lab+consult revenue for that year.
- Match quality reviewed by a human via dry-run CSVs **before** any commit.

---

## 4. Validated schema / trigger findings (final review, 2026-06-03)

Confirmed against prod (`qhptbmafrosgibooelpp`):

- **Release/consent/payment gates are `UPDATE`-only.** Inserting a
  `test_requests` row already at `status='released'` bypasses
  `enforce_payment_before_release`, `enforce_consent_before_release` (also
  `consent_settings.gate_required = false`), and the revenue-JE bridge
  `bridge_test_request_released` (fires on `UPDATE→released`). ✅ test releases
  are GL-silent on INSERT for free.
- **`bridge_payment_insert` fires `AFTER INSERT` on `payments`** → DR cash / CR
  AR. This is the **one** double-post vector. Must be suppressed for legacy rows.
- **`recalc_visit_payment` fires `AFTER INSERT` on `payments`** → sets
  `visits.paid_php` / `payment_status`. **Keep active** (no GL effect).
- **`payments_block_after_close` fires `BEFORE INSERT`** → `eod_lock_check`.
  `eod_close_records` is currently empty so it never blocks, but guard it anyway
  for re-run safety.
- `visits` INSERT also fires `maintain_repeat_patient_flag` (sets
  `is_repeat_patient` when patient has >1 visit — harmless/desirable).
- `test_requests` INSERT fires only `fn_header_auto_promote` (no-op unless
  `is_package_header`) and `fn_test_request_parent_is_header` (no-op for
  `parent_id IS NULL`).
- **Constraints to respect:**
  - `visits.visit_number` UNIQUE, NOT NULL.
  - `test_requests.test_number` UNIQUE, **nullable** → leave NULL (Postgres
    allows many NULLs; avoids colliding with the app sequence).
  - `test_requests.status` ∈ {requested, in_progress, result_uploaded,
    ready_for_release, released, cancelled}.
  - `test_requests.release_medium` ∈ {physical, email, viber, gcash, pickup,
    other} → use **`'physical'`** (NOT the invalid `'legacy_paper'`).
  - `test_requests.discount_amount_php` NOT NULL (`>= 0`); `discount_kind` ∈
    {senior_pwd_20, pct_10, pct_5, other_pct_20, custom} or NULL.
  - `payments.amount_php > 0` (strict) → only insert when collected > 0.
  - `payments.method` ∈ {cash, gcash, maya, card, bank_transfer, hmo, bpi,
    maybank} → **no `bdo`** (map BDO → `bank_transfer`).
  - `staff_profiles.id → auth.users(id)` → the system user needs a paired
    `auth.users` row.
- `legacy_import_runs` exists: `(id, source, started_at, ended_at, rows_in,
  rows_inserted, rows_skipped, rows_flagged, dry_run, run_by, notes)` — reuse it.

---

## 5. Migration — provenance + GL/lock guards

One migration (`00NN_clinical_backfill_provenance.sql`; next free number at
implementation time — currently 0090 is highest):

1. **Provenance columns** on `visits`, `test_requests`, `payments`:
   ```sql
   alter table public.<t>
     add column legacy_import_run_id uuid references public.legacy_import_runs(id),
     add column legacy_source_ref text;
   create unique index <t>_legacy_source_ref_key
     on public.<t> (legacy_source_ref) where legacy_source_ref is not null;
   create index idx_<t>_legacy_import_run on public.<t> (legacy_import_run_id)
     where legacy_import_run_id is not null;
   ```
2. **Guard the three insert-path functions** — add at the very top:
   - `bridge_payment_insert()`: `if NEW.legacy_import_run_id is not null then return NEW; end if;`
   - `payments_block_after_close()`: `if (coalesce(NEW,OLD)).legacy_import_run_id is not null then return coalesce(NEW,OLD); end if;`
     (only the INSERT path carries legacy rows; OLD has it on later updates too)
   - `bridge_test_request_released()`: `if NEW.legacy_import_run_id is not null then return NEW; end if;` (defensive — covers a future UPDATE that re-releases a legacy row)
   Leave `recalc_visit_payment`, `maintain_repeat_patient_flag` untouched.
3. **Smoke** (`scripts/smoke-clinical-backfill.sql`): insert a non-legacy
   payment → exactly one posted JE; insert a legacy payment → zero JEs but
   `payment_status` recalculated; both respect/ignore an `eod_close_records`
   row as designed. Assert `journal_entries` count delta = expected.

Follow the `drmed-migrations` checklist (RLS unaffected — service-role writes;
no new tables needing policies; regenerate `src/types/database.ts` via
`db:types` after applying).

---

## 6. Record construction (exact mapping)

### System user
A dedicated **"Legacy Import" `staff_profile`** (`role='admin'`,
`is_active=false`) with a paired `auth.users` row, created idempotently via a
setup step reusing the `scripts/create-local-admin.ts` pattern. Its id is used
for all `NOT NULL` actor columns: `test_requests.requested_by`/`released_by`,
`payments.received_by`; and (nullable) `visits.created_by`.

### Visit (one per `(tab, control_no)`; fallback `(patient_id, visit_date)` when control_no blank)
| Column | Value |
|---|---|
| `patient_id` | resolved/created patient (§7) |
| `visit_number` | `H-<control_no>` (or `H-<tab>-<n>` synth when blank), uniqueness-checked with numeric suffix on collision |
| `visit_date` | `posting_date` |
| `total_php` | Σ of the visit's line `final_price_php` |
| `payment_status` | insert explicit `'unpaid'` (column is NOT NULL; visit is inserted before payments) — `recalc_visit_payment` then flips it to `partial`/`paid` when the payment row lands |
| `hmo_provider_id` | mapped from `hmo_provider` (12.B normalizer + seeded `hmo_providers`) when HMO; else NULL |
| `attending_physician_id` | from a `Doctor` column if present & matchable to `physicians`; else NULL |
| `created_by` | system user |
| `created_at` | set to `visit_date` (chronological lists) |
| `visit_group_id` | links a consult + lab visit sharing `(patient, date, control_no)` across tabs (0090) |
| `legacy_import_run_id`, `legacy_source_ref` | run id, `"<TAB> control=<control_no>"` |

### Test request (one per service line)
| Column | Value |
|---|---|
| `visit_id`, `service_id` | parent visit; mapped service (§8) |
| `status` | `'released'` |
| `requested_by` / `requested_at` | system user / `posting_date` |
| `released_by` / `released_at` | system user / `posting_date` |
| `release_medium` | `'physical'` |
| `base_price_php` | sheet `base` (fallback `final`) |
| `discount_amount_php` | `max(base − final, 0)`; `discount_kind='custom'` when >0 else NULL |
| `final_price_php` | sheet `final` (fallback `base`) |
| `clinic_fee_php` / `doctor_pf_php` | consult tab only, from `clinic_fee`/`doctor_pf` |
| `hmo_*` | provider/approved-amount when HMO |
| `test_number` | NULL |
| `is_package_header` | false; `parent_id` NULL |
| original sheet `service` text | stored in `receptionist_remarks` (and `procedure_description` for procedures) |
| `legacy_import_run_id`, `legacy_source_ref` | run id, `"<TAB> r<row_number>"` |

### Payment (only when collected > 0)
| Column | Value |
|---|---|
| `visit_id` | parent visit |
| `amount_php` | collected: cash-style → `final`; HMO → patient cash portion (often 0 → no row) |
| `method` | MOP→method map (cash/gcash/maya/card/bank_transfer/hmo; **BDO→bank_transfer**, CHEQUE→bank_transfer, blank→cash) |
| `reference_number` | OR number if present |
| `received_by` / `received_at` | system user / `date_paid` (fallback `posting_date`) |
| `legacy_import_run_id`, `legacy_source_ref` | run id, `"<TAB> r<row_number> pay"` |

`recalc_visit_payment` then computes `payment_status` from these rows; the GL
bridge is skipped via the legacy guard.

---

## 7. Patient matching & dedup

1. **Normalize** both sides: strip accents, lowercase, collapse whitespace/punct,
   parse `"Last, First Middle"` ↔ `"First Last"`. Match key `(last, first)`;
   gender as a tiebreaker when available. Respect `patients.merged_into_id` (use
   the canonical surviving row).
2. **Unique** candidate → link.
3. **Multiple** candidates → **ambiguous CSV, never auto-pick** (RA 10173 leak
   risk). Held for manual resolution; not committed in the auto pass.
4. **No** candidate → new-patient candidate. **Dedup within the new set** so one
   person's many transactions create exactly one new patient (and that new
   patient is reused across their visits). New patients carry
   `legacy_import_run_id`, `pre_registered=false`, `birthdate=NULL`,
   `birthdate_confirmed=false`, and `legacy_intake` capturing the source.
5. Dry-run emits **`new-patients.csv`** and **`ambiguous.csv`** for human
   sign-off before commit.

---

## 8. Service mapping

- **Lab lines:** best-effort match `service` text → `services` (278 active
  lab_test/lab_package rows) by normalized name/code. Unmatched → a generic
  **"Legacy lab test"** service (`kind='lab_test'`, created once), with the
  original text preserved in `receptionist_remarks`. Dry-run emits
  **`unmapped-services.csv`** ranked by frequency to grow the match table.
- **Consult lines:** `service_id` = `CONSULT` anchor (0090); fee from
  `clinic_fee`/`doctor_pf`, snapshotted into `final_price_php`.

---

## 9. Pipeline & CLI ergonomics

New `scripts/clinical-backfill/` (shared lib + two entrypoints), mirroring 12.B:

```
npm run backfill:clinical:lab     -- --year=2024            # dry-run
npm run backfill:clinical:lab     -- --year=2024 --commit --confirm="I-mean-it"
npm run backfill:clinical:consult -- --year=2024 [--commit --confirm=...]
```

- Per-year, per-tab, chunked to stay under the PostgREST 1000-row cap (12.B's
  monthly-window pattern).
- Dry-run: summary + CSVs (`matched`, `ambiguous`, `new-patients`,
  `unmapped-services`, `exclusions`), no writes.
- Commit: open a `legacy_import_runs` row (`source='clinical_backfill:<tab>'`,
  `dry_run=false`), create new patients → visits → test_requests → payments,
  then stamp `ended_at` + counts.
- `requireLocalOrExplicitProd` guard (reuse `scripts/lib/env-guard`).

---

## 10. Idempotency & rollback

- **Idempotency:** each row's `legacy_source_ref` is checked before insert
  (fetch existing set per run/tab/window) **and** enforced by the partial unique
  index. Re-runs no-op.
- **Rollback (dev / mistake recovery):** delete-by-run, child→parent order:
  `payments` → `test_requests` → `visits` → new `patients`, all
  `where legacy_import_run_id = '<run>'`. Because the backfill is GL-silent,
  there are no JEs to reverse. (Voiding is NOT used — these never posted.)

---

## 11. Validation & reconciliation

`scripts/clinical-backfill/validate.sql` (read-only), run after each commit:

- Per `(year, tab)`: visit / test_request / payment counts.
- `payment_status` distribution; visits with `total_php=0`; orphan checks.
- **GL-silence assertion:** no `journal_entries` rows reference a clinical
  `legacy_source_ref` and the JE count is unchanged across the commit window.
- **Patient match-rate:** auto-linked vs new vs ambiguous.
- **Books reconciliation:** clinical `Σ final_price` per year vs the books'
  `4100`+`4200`(+`4500`) revenue per year (expect close; flag variance for
  review — discounts/zero-fee consults explain known gaps).

---

## 12. Patient-portal degradation

A released historical `test_requests` has no `results` row. Verify the patient
portal renders this as *"Released — pre-system record (no digital copy on
file)"* rather than offering a broken download / erroring. If it doesn't degrade
cleanly, a small portal tweak is in scope (driven off "no results row +
`legacy_import_run_id` present"). Verified at 390×844 and desktop.

---

## 13. Build sequence (dispatches)

1. **Migration** — provenance columns + 3 guards + indexes; GL-silence smoke;
   `db:types`.
2. **Shared lib** — ExcelJS readers (reuse 12.B), name normalizer + patient
   matcher, service mapper, MOP→method map, system-user setup (auth+profile).
3. **Dry-run reporter** — summary + all CSVs, no writes. → **review checkpoint:
   real match-rate + new-patient + unmapped-service numbers signed off.**
4. **Commit path** — patients → visits → test_requests → payments; idempotent;
   `--confirm` gated; `requireLocalOrExplicitProd`.
5. **Validation SQL** + books reconciliation.
6. **Run** local → staging → prod (per-year); portal degradation check; update
   memory + RELEASE_NOTES.

---

## 14. Risks → mitigations

| Risk | Mitigation |
|---|---|
| Wrong-patient link (RA 10173 leak) | never auto-pick ambiguous; dry-run human review; audit via `legacy_import_runs` |
| Duplicate patients from name variants | aggressive normalize + dedup within new set + `new-patients.csv` review |
| Revenue double-count | legacy guard on `bridge_payment_insert`; INSERT-as-released is bridge-silent; GL-silence validation assertion |
| Period-lock block on backdated payments | guard on `payments_block_after_close`; `eod_close_records` empty today |
| `visit_number` collision | `H-`prefix + uniqueness check + numeric suffix |
| Re-run / partial failure | `legacy_source_ref` idempotency + delete-by-run rollback |
| Service-name sprawl | generic legacy service fallback + `unmapped-services.csv` to iterate |

---

## 15. Open items to resolve during dry-run (not blockers)

- Confirm the transaction-tab `patient_name` format (Last,First vs First Last) —
  the normalizer handles both; dry-run match-rate validates.
- Exact cutover date (default: day before first real app visit, 2026-05-26).
- Whether to link consult+lab halves via `visit_group_id` in this pass or defer
  (default: link when `(patient, date, control_no)` matches across tabs).
- Tolerance threshold for the books reconciliation variance.

# Clinical-backfill follow-ups — ambiguous held rows + unmapped lab services

**Status:** Track B (unmapped safe-auto) ✅ APPLIED to prod 2026-06-11. Track A
(ambiguous) ✅ machinery built + tested, ⏳ awaiting clinic-partner sign-off before
the gated import. **Prod project:** `qhptbmafrosgibooelpp`.
**Origin:** the two follow-ups flagged at the end of the v1.15.0 historical clinical
backfill ([[project-clinical-backfill]]): "1,548 held ambiguous rows" + "69 unmapped
lab services."

## Ground truth (fresh dry-runs vs current prod, 2026-06-10)

The "1,548" was the 2026-06-03 figure; interim commits + matcher gains absorbed most.
Real residual:

| | Lab | Consult | Total |
|---|--:|--:|--:|
| **Ambiguous (held — NOT in prod)** | 362 | 77 | **439** |
| **Unmapped lab services (names)** | 70 | 0 | **70** |

The 439 held rows collapse to **~39 name-clusters / 80 candidate patients** (e.g.
"VICENCIO,ROBERT ALAIN" recurs 11× → same 2 candidates). The sheet rows carry only
name/date/control/service/amount/HMO/MOP — **no DOB/age/contact** — so name alone
cannot disambiguate. The clinic partner must decide each cluster (RA 10173: never
auto-pick an identity).

---

## Track A — Ambiguous held rows (439) → partner-decision machinery

Every candidate is an empty shell from the 2026-05-25 customer-master import
(`n_visits=0`). The existing `patient-dedup` tool, run on current prod, finds **0 safe
auto-merges, 42 review items across 40 clusters** (31 dob-conflict, 10 name-only, 1
sex-conflict) — its `classify()` correctly routes any DOB/sex mismatch to review. So
there is no "auto-resolving" bucket: every cluster is either **SAME** (duplicate of one
person — DOB typo / middle-name abbrev / name typo) or **DISTINCT** (father/son Sr/Jr/III,
siblings, namesakes), and both are partner sign-off items.

### Deliverables (built this session, no prod writes)

`scripts/clinical-backfill/followups/`:

- **`worksheet.ts`** — generates three artifacts under `tmp/`:
  - `clinical-followup-worksheet-*.csv` — one row/cluster: candidates side-by-side
    (DRM-ID/DOB/middle/sex/phone/visits), the dedup verdict, a **non-binding** hint
    (SAME?/DISTINCT?/REVIEW/MANUAL + reason), and #held lab/consult rows it unblocks.
  - `clinical-followup-detail-*.csv` — one row per held transaction (date, service,
    amount) so the partner can see what each cluster's labs were.
  - `clinical-cluster-resolutions.template-*.csv` — the blank decision sheet
    (`cluster_key, sheet_name, candidates, decision, target_drm, notes`).
- **`resolutions.ts`** (+ `.test.ts`, 10 tests) — parses/validates the filled decision
  file; `decision ∈ {SAME, DISTINCT, SKIP}`; blank rows = undecided (safe to fill
  incrementally). Builds the matchKey→patient_id override.
- **`resolve.ts`** — Phase-1 runner: performs the **SAME** merges via the audited dedup
  `mergeOne` (FK reassignment + tombstone + audit_log). Dry-run by default; `--commit
  --confirm="I-mean-it" --prod` to write.
- **engine.ts `--resolutions=<file>`** — on an ambiguous row, routes the cluster's rows
  to the partner-chosen patient (matchKey override) instead of holding. DISTINCT clusters
  import here; SAME clusters single-match after the merge. New counter: "resolved via
  partner override". Validated end-to-end on a synthetic file (vicencio DISTINCT 17 +
  daet SAME 10 → ambiguous 362→335, override 27).

### Post-sign-off runbook (one command set, after the partner fills the file)

```
# 1. partner fills clinical-cluster-resolutions.csv (decision + target_drm per cluster)
# 2. merge the SAME duplicates:
tsx --env-file=.env.local scripts/clinical-backfill/followups/resolve.ts \
    --file=<resolutions.csv> --commit --confirm="I-mean-it" --prod
# 3. import the held rows (single-match for SAME, override for DISTINCT):
npm run backfill:clinical:lab     -- --commit --confirm="I-mean-it" --resolutions=<resolutions.csv> --prod
npm run backfill:clinical:consult -- --commit --confirm="I-mean-it" --resolutions=<resolutions.csv> --prod
# 4. validate: re-run dry-runs → ambiguous drops by the resolved rows; GL-silence=0.
```

### Surgical-write audit (advisor #3)

A re-run mints **0 new patients**: the 46 would-be-"new" rows (2 lab + 44 consult) are
all low-quality single-token / junk sheet names (`9`, `bbbb`, `GEMMA`, surname-only
`BECHAYDA`) that **already exist as "TOKEN TOKEN" stubs** from v1.15.0, each carrying the
exact `clinical_name_token` the engine recomputes — so commit-time idempotency reuses
them and their rows are already imported (idempotent-skip). The re-run therefore writes
only the resolved held rows.

---

## Track B — Unmapped lab services (70) → 985-row safe-auto re-point ✅ APPLIED

1,319 historical `test_requests` were pinned to the generic **LEGACY-LAB** shell with the
real name in `receptionist_remarks` ("legacy service: <NAME>"). Re-pointing them to the
right catalog service fixes **categorization in the Part-B ops analytics** — and is an FK
UPDATE on already-released rows, **GL-silent + money-neutral**.

### GL-silence proof (advisor #4)

All 9 `test_requests` triggers analysed: the 2 GL bridges fire only `WHEN` status
transitions to released (no-op on a same-status update); the 4 status/parent triggers are
`UPDATE OF status/parent_id` (don't fire); both payment + consent gates are internally
gated to `new.status='released' AND old.status<>'released'` (no-op, no block); and
`bridge_test_request_released` additionally has the `legacy_import_run_id IS NOT NULL →
return` 0091 guard. **Empirically confirmed:** `journal_entries` count **22,424 before =
22,424 after** (delta 0). Only `service_id` changed — amounts untouched.

### Three tiers (`service-aliases.ts`)

- **SAFE-AUTO (32 names → 985 rows) — APPLIED.** Unambiguous spelling/suffix/abbrev
  variants of one existing service (`ROUTINE PACKAGE - ORIG`→ROUTINE_PACKAGE,
  `PROTHROMBIN TIME PT`→…PROTIME, `BLOOD TYPING`→…W/ RH FACTOR, `CPK TOTAL`→CK TOTAL, …).
  Run via `repoint-services.ts --commit --confirm --prod`; one `service.repoint_legacy`
  audit row written; idempotent (re-run = 0).
- **PARTNER-CONFIRM (~28 names) — DEFERRED.** New services (corporate packages
  LIKHAAN / GICA / METAL-HARDWARE combined order, TOTAL HEALTH, MEN'S HEALTH, niche
  immunology — anti-dsDNA, anti-Smith, AMA, PIVKA-II, C.diff, histopath) OR clinically
  ambiguous (**TROP-I ≠ TROP-T** — different analyte; CULTURE/SENSITIVITY specimen
  unknown; 25-OH VIT D vs VITAMIN D (CMIA); HIV ELISA method; XRAY view nuances). A wrong
  alias is a record error → needs the clinic partner.
- **NOT-A-TEST (9 names) — DEFERRED.** HOME SERVICE FEE ×8 amounts (delivery surcharge —
  catalog has HOME_SERVICE/_800/_900/_1000 but not 500/700/1100/1200) + GIFT CERTIFICATE
  PROMO (payment artifact). Must NOT be aliased to a lab service.

After the re-point, **334** rows remain on LEGACY-LAB (38 distinct names = the two
deferred tiers).

### Rendering safe + fully reversible

- **Portal rendering verified.** ~405 of the re-pointed rows now point at `lab_package`-kind
  services as flat standalone rows (`is_package_header=false`, `parent_id=null`, no
  children). The patient-portal results query routes on `is_package_header`/`parent_id`,
  **not** `service.kind` (`src/app/(patient)/portal/(authenticated)/page.tsx` ~L140-152), so
  they fall through to `standaloneReleased` and render as normal lines — now with a real test
  name instead of "Legacy lab test". The package-download path requires `is_package_header=
  true` (`actions.ts` ~L273), so these can't trigger it.
- **Reversible.** The UPDATE preserved `receptionist_remarks='legacy service: <NAME>'`, so any
  row can be mapped back to LEGACY-LAB by name if a mapping is ever disputed.

---

## Outcome

- **Track B applied 2026-06-11:** 985/1,319 re-pointed, GL delta 0, idempotent, audit row
  written. 334 deferred rows documented above.
- **Track A built + tested 2026-06-11:** worksheet + resolver + engine override + 10 tests;
  71 backfill/dedup tests green; typecheck + lint clean. **Awaiting partner sign-off** on
  the ~39-cluster worksheet before the gated merge + import.

### Follow-ups (partner-led)

1. Fill the cluster-resolutions worksheet → run the post-sign-off runbook (439 held rows).
2. Define the ~28 partner-confirm services (new catalog entries / correct analytes) →
   extend `SAFE_AUTO` (or a new tier) and re-run `repoint-services.ts`.
3. Decide HOME SERVICE FEE + GIFT CERT handling (fee line vs new home_service codes).
4. Optional data-quality: merge surname-only "TOKEN TOKEN" stubs into the right patient
   where unambiguous (most can't be attributed — sheet gave only a surname).

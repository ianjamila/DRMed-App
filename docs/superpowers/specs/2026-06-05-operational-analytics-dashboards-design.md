# Operational & Marketing Analytics Dashboards — Design Spec

**Date:** 2026-06-05
**Status:** Approved design, pending spec review → implementation plan
**Related:** `2026-06-03-historical-clinical-backfill-design.md` (the backfill that
populated the data this reads), `v_daily_revenue_by_service` (existing view),
the existing `admin/reports/*` + `admin/accounting/hmo-claims/*` surfaces.

---

## 1. Context & goal

The clinical operational layer is now backfilled (v1.15.0: 8,081 visits / 18,639
released test_requests / 7,276 payments, Dec 2023 → now) alongside the accounting
books. The clinic currently tracks daily operations in a **manual Google-Sheet
"DAILY" ledger** (one column per day, hand-keyed). The goal is to **reproduce
that report in-app from the database, and extend it into a decision-driving
analytics suite** for management, operations, and marketing.

The owner's stated next step after this is **using Claude to build marketing
campaigns/ads**. This spec deliberately stops at **aggregate analytics** (the
inputs to that) and defers the per-patient **campaign engine** (segments, recall
lists, the campaign-brief export, consent) to its own project — see §13.

### Scope (this spec = sub-projects 1 + 2)

- **Part A — Historical enrichment (single sheet re-read pass).** Recover three
  fields the backfill dropped, all from re-reading the master sheet:
  1. **Attending doctor** — the consult tab's column 8 *is* the doctor surname →
     set `visits.attending_physician_id` (unblocks every per-doctor/specialty cut).
  2. **Discount type** — both tabs split Senior/PWD vs other discounts → set
     `test_requests.discount_kind` precisely (currently all historical = `custom`).
  3. **New vs repeat customer** — the lab tab hand-tracked this → store a per-visit
     marker so historical new-vs-repeat is *accurate*, not name-match-approximate.
- **Part B — Analytics dashboards.** A faithful **Daily report**, **trend
  charts**, a **today snapshot**, and four analytics packs (HMO, Doctor/Specialty
  productivity, Marketing/Growth, Ops deep-dive), all driven by SQL views.

### Out of scope (deferred — see §13 Roadmap)

- **Campaign engine (sub-project 3):** per-patient segments, recall/win-back
  lists, cross-sell/market-basket targeting, lifetime-value, the "campaign brief
  → Claude" export, and the consent/lawful-basis design those require. This spec
  produces only **aggregate** numbers (counts/sums by day/service/doctor/HMO),
  which carry low privacy risk; individual targeting is the next project.
- No changes to the accounting GL. Analytics are **read-only** over existing data.
- No replacement of the existing HMO **AR/claims** module — we *reuse* its views.

---

## 2. Locked decisions (from brainstorm, 2026-06-05)

1. **Audience: both** — a management/analytics area (trends over the full
   history) **plus** a light "today" snapshot for the front desk.
2. **Presentation: charts + cards.** Add **`recharts`** (no charting lib exists
   today; existing reports are server-rendered tables). Headline figures as
   number cards; trends as line/bar/stacked charts; detailed/ledger data as
   tables (CSV-exportable).
3. **Data layer: SQL views**, extending the `v_daily_revenue_by_service` pattern.
   No pre-aggregated summary table, no per-page ad-hoc aggregation.
4. **Doctor attribution:** a small **reviewed surname→physician map** (24 distinct
   values), not fuzzy matching — doctor identity is high-stakes. Unmatched →
   "Other" + a review CSV; ambiguous bare "DANTES" → "Other".
5. **Packs:** all four selected — HMO, Doctor/Specialty productivity,
   Marketing/Growth, Ops deep-dive.
6. **Placement:** a new **Admin → Operations** area with tabs (*Daily report ·
   Trends*); the today-snapshot cards live on the staff dashboard (front desk).

---

## 3. Part A — Historical enrichment pass

One script re-reads the master sheet once and recovers three dropped fields
(§3.1–3.6). All writes are GL-silent UPDATEs on legacy rows (no `status` change;
`bridge_test_request_released` short-circuits on `legacy_import_run_id`),
idempotent (fill-only-where-still-default), dry-run → review CSV → `--commit`.

### 3.1 The finding (doctor)

The `DOCTOR CONSULTATION` tab's **column 8** (header mislabeled "SERVICE") holds
the **attending doctor's surname**, stored as Google-Sheets formula cells — read
`cell.value.result` (e.g. `"GAYO"`). The original backfill mapped every consult
to the generic `CONSULT` service and dropped column 8; all 8,081 legacy visits
have `attending_physician_id = NULL`.

### 3.2 The reviewed surname → physician map

24 distinct surnames; ~93% of consult volume maps cleanly (initials disambiguate
the two Vicencios / Marianos / Danteses). **Proposed map (for user review):**

| Sheet col-8 | Volume | → Physician | Specialty |
|---|---|---|---|
| GAYO | 2,270 | Dr. Katherine Gayo | Pediatrician |
| R.VICENCIO | 2,267 | Dr. Robert Vicencio | IM · Cardiologist |
| LORENZO | 838 | Dr. Angelica Lorenzo | ENT |
| BROJAS | 382 | Dr. Maria Cecilia Castelo-Brojas | OB-GYN |
| ELLEAZAR | 326 | Dr. Jaemari Elleazar | Family Medicine |
| MANUEL | 316 | Dr. Archangel Manuel | IM · Pulmonologist |
| A. VICENCIO | 282 | Dr. Aurora Vicencio | Pediatrician |
| MENDOZA | 176 | Dr. Armelle Keisha Mendoza | Family Medicine |
| ARCEGA | 156 | Dr. Alain Arcega | Ophthalmologist |
| ANTONIO | 156 | Dr. Dominique Antonio | Pediatrician |
| PACIS | 146 | Dr. Julie Ann Pacis-Caling | Family Medicine |
| ANGLO | 143 | Dr. Claudette Anglo | ENT |
| N. MARIANO | 130 | Dr. Nadia Mariano | OB-GYN |
| F. DANTES | 110 | Dr. Ferdinand Dantes | IM · Gastroenterologist |
| A. DANTES | 58 | Dr. Angelle Dantes | IM · Oncologist |
| LIBIRAN | 47 | Dr. Gideon Libiran | IM · Nephrologist |
| BALDEVISO | 39 | Dr. Lei Baldeviso | IM · Diabetologist |
| ALVAREZ | 27 | Dr. Mary Rose Alvarez | Surgeon |
| **JOSON** (53), **SEVILLEJA** (46), **CHING** (12), **SAYSON** (2), **VILLANUEVA** (1) | 114 | → **Other** (not in roster) | — |
| **DANTES** (bare) | 7 | → **Other** (ambiguous F vs A) | — |

The map lives as an explicit constant in the script (reviewed, not fuzzy). A
normalizer handles case/spacing/punctuation so `"R.VICENCIO"`, `"R. VICENCIO"`
collapse to one key.

### 3.3 Mechanics

- New script under `scripts/doctor-attribution/` (reuse the clinical-backfill
  `lib/xlsx.ts` reader + env-guard + report CSV writer). Per the proven
  ergonomics: **dry-run → review CSV → `--commit --confirm`**, prod via `--prod`.
- For each committed consult `test_request` (`legacy_source_ref = 'DOCTOR
  CONSULTATION r<n>'`), read row `<n>`'s col-8 surname, resolve via the map, and
  set `visits.attending_physician_id` on the parent visit **(only where currently
  NULL)**. One consult line ↔ one visit in this data, so the visit-level field is
  the natural home; the dashboard counts consults by `visits.attending_physician_id`.
- **GL-silent & safe:** setting `attending_physician_id` is an UPDATE that does
  not change `status`; `bridge_test_request_released` only fires on
  `status→released` *and* short-circuits on `legacy_import_run_id`. No JE effect.
- **Unmatched** ("Other") → leave `attending_physician_id` NULL and emit
  `doctor-attribution-unmatched.csv` (surname, count, sample dates) for partner
  review. The dashboard renders NULL-physician consults as **"Other / unattributed."**
- **Idempotent:** re-running only fills still-NULL visits; re-runs change nothing
  once applied.
- **Validation SQL:** counts attributed vs Other; per-physician consult totals;
  asserts zero JE delta.

> Roster physicians with **no** col-8 appearance (Dr. Daniel John Mariano —
> Radiologist; Dr. Lizcel Alonzo — Psychiatrist) simply have zero historical
> consults; that is expected, not an error.

### 3.4 Discount-type recovery (BIR / Senior-PWD compliance)

The backfill set every historical discount to `discount_kind='custom'`. The sheet
keeps the split in dedicated columns, mapping cleanly to the existing enum
(`{senior_pwd_20, pct_10, pct_5, other_pct_20, custom}`):

- **LAB SERVICE:** col 10 Senior/PWD (20%) → `senior_pwd_20`; col 11 Discount
  (10%) → `pct_10`; col 12 Discount (5%) → `pct_5`.
- **DOCTOR CONSULTATION:** col 10 Senior/PWD (20%) → `senior_pwd_20`; col 11
  Other discounts (20%) → `other_pct_20`.

For each committed line with a discount, set `test_requests.discount_kind` from
whichever column is non-zero (Senior/PWD takes precedence if multiple). Lines with
no discount stay NULL. Enables the Senior/PWD vs other cut over full history.

### 3.5 New-vs-repeat recovery

The LAB SERVICE tab's **col 17 "NEW / REPEAT CUSTOMER"** is the clinic's own
ground-truth flag. A tiny migration adds nullable **`visits.source_new_repeat
text`** (`'new' | 'repeat'`); Part A sets it from col 17 for lab visits (consult
tab has no such column → left NULL). The new-vs-repeat metric (§5.2) uses this
recovered flag where present (history) and computes first-visit from visit history
otherwise (live) — making the headline marketing metric accurate, not
name-match-approximate, for the historical period.

### 3.6 Flow & safety

All three recoveries run in the **same** dry-run → commit pass per tab, keyed on
`legacy_source_ref` (the row pointer already on every backfilled record).
GL-silent, idempotent, with a combined `enrichment-summary` + per-field unmatched
CSVs. Validation SQL asserts zero JE delta and reports attribution/discount/new-
repeat coverage.

---

## 4. Part B — Data layer (SQL views)

One migration adds analytics views (read-only; service-role/admin access; no RLS
changes). All views aggregate **all** clinical rows (legacy + live), so history
and go-forward data flow through the same surfaces automatically.

### 4.1 The payment-channel rule (used everywhere)

Each **visit** is assigned one **payment channel**:
1. `hmo` if `visit.hmo_provider_id IS NOT NULL` (HMO visits usually have **no**
   patient payment row — channel must come from the visit, not `payments.method`);
2. else the visit's `payments.method` (`cash`/`gcash`/`bpi`/`card`/`bank_transfer`/…);
3. else `unpaid` (non-HMO visit with no payment).

A `test_request` inherits its visit's channel. **Display labels:** Cash · GCash ·
BPI · Card · **Bank transfer** · HMO (+ Unpaid). Note: historical **BDO** folded
into `bank_transfer` (86 rows, 1.2%) — shown under "Bank transfer." A `v_payment_channel`
helper (visit_id → channel) centralizes this.

### 4.2 Section rule

- **Lab** = service kind ∈ {lab_test, lab_package, vaccine, home_service} (and any
  future non-doctor kind).
- **Doctor consult** = kind ∈ {doctor_consultation, doctor_procedure}.

### 4.3 Views (indicative)

- `v_ops_daily_lab` — per (business_date, channel): distinct customers, # tests,
  sales (Σ final), discounts.
- `v_ops_daily_consult` — per (business_date, channel, physician_id, specialty):
  # consults, sales, discounts, **PF (Σ doctor_pf_php)**, distinct customers.
- `v_ops_service_demand` — per (business_date, service_id, kind): count, revenue,
  discount (top-services / Pareto / demand-trend source; extends/streamlines the
  existing `v_daily_revenue_by_service`).
- `v_ops_patient_acquisition` — per (month, is_legacy/source): new patients
  (first-visit detection), new vs repeat, referral_source bucket, age band, sex.
- `v_ops_hmo_contribution` — per (period, hmo_provider): revenue, visit count,
  share of total; joins the existing **`v_hmo_provider_summary` / `v_hmo_ar_aging`**
  for billed/collected/outstanding rather than recomputing AR.
- `v_ops_sendout_margin` — per (service, period): volume, revenue, send-out unit
  cost, est. margin (services flagged `is_send_out`, 82 of them have costs).

`business_date = (released_at AT TIME ZONE 'Asia/Manila')::date` (matches
`v_daily_revenue_by_service`). "Distinct customers" = `count(distinct
visit.patient_id)`. Granularity rollups (week/month/year) computed in the query
or a thin date-trunc wrapper.

---

## 5. Part B — Surfaces

Lives under **`/staff/(dashboard)/admin/operations`** with shared `SectionTabs`
(navy-pill, per `feedback_staff_ui_conventions`). Admin-gated
(`requireAdminStaff`). Plain language on user-facing labels.

### 5.1 Daily report (`/admin/operations/daily`) — reproduce the sheet

Date picker (default: today; supports a date or a range that rolls up). Two
tables mirroring the manual ledger:

- **Lab tests:** rows = Distinct customers · # of tests · Sales · Discounts;
  columns = Cash · GCash · BPI · Card · Bank transfer · HMO · **Total**.
- **Doctor consults:** rows = # of consultations · Sales · Discounts · **PF
  collected**; same channel columns + Total; then a **per-doctor breakdown**
  (consults · sales · PF, with "Other" row for unattributed).

CSV export. This is the "reiterate" deliverable — the in-app, always-current
replacement for the hand-keyed sheet.

### 5.2 Trends (`/admin/operations/trends`) — the "improve" deliverable

Date-range + granularity (day / week / month) with presets (This month · Last
month · This year · Custom). Charts (recharts) grouped by pack:

**Core (always):** Visits/day · Lab tests/day · Consults/day · Revenue/day;
revenue by section & channel; payment-method mix over time.

**HMO pack:** HMO revenue contribution (share of revenue + visit volume, bar +
table); **HMO collection scorecard** — billed vs collected vs outstanding, %
collected, aging, ranked (reusing `v_hmo_ar_aging`/`v_hmo_provider_summary`);
HMO-vs-cash mix trend.

**Doctor/Specialty pack:** consults · revenue · PF · unique patients **per doctor**
and **per specialty** (stacked bar / leaderboard); needs Part A.

**Marketing/Growth pack:** new vs repeat patients + monthly new-patient
acquisition; referral-source breakdown; age/sex demographics; service & specialty
demand + seasonality (by month).

**Ops deep-dive pack:** top services Pareto (volume & revenue); revenue per visit
& per clinic day; busiest day-of-week; send-out vs in-house + margin;
**discounts by type** (Senior/PWD vs other — BIR-relevant, full history via §3.4).

### 5.3 Today snapshot (cards on the staff dashboard)

A small `stat-card` row (reusing `_dashboards/_components/stat-card.tsx`): today's
visits, lab tests, consults, revenue, PF collected. Visible to reception/admin —
the "light ops snapshot." (Card visibility honors the existing dashboard-card prefs.)

---

## 6. Data feasibility & caveats (state honestly in the UI)

| Cut | History coverage |
|---|---|
| Visits / tests / consults / revenue / discounts / payment-channel | **Full** 2023→now |
| Per-doctor / per-specialty consults | **Full**, after Part A (~93% named, ~7% "Other") |
| HMO contribution & collection | **Full** (uses existing AR views + 6,033 historic claims) |
| Send-out margin | Full for the 82 costed send-out services |
| Referral source | ~85% of patients (customer import captured it); richer going forward |
| Age / sex demographics | ~80% of patients have a birthdate; sex where recorded |
| Discount type (Senior/PWD vs other) | **Full**, after Part A §3.4 recovers it from the sheet (was lumped `custom`) |
| New-vs-repeat (lab) | **Accurate** for lab history via recovered col-17 flag (§3.5); consult history + retention *cohorts* still computed/approximate |
| Retention cohorts / repeat-frequency | Reliable **going forward**; legacy cohort curves approximate (name-only matching) — label "approximate for pre-2026" |

Surfaces that depend on partial data show a small "based on N% with data" note so
nobody over-reads them.

---

## 7. Tech & conventions

- **Server Components** for reads (query the views, typed against generated
  `Database`); **recharts** in `'use client'` chart components fed server-computed
  data. Mobile-first (390×844) per `feedback_mobile_first_for_new_pages`; tables
  get `overflow-x-auto`.
- Admin-gated (`requireAdminStaff`); analytics are aggregate, no patient PII rows
  surfaced (lists/PII are the deferred campaign project).
- Add `recharts` to `package.json`. Reuse `SectionTabs`, `stat-card`, the
  `admin/reports` period-preset patterns.
- Existing `admin/reports/daily-revenue` and `lab-tat` are **kept**; the new
  Operations area supersedes daily-revenue's intent — link/redirect rather than
  duplicate (decide during implementation).

---

## 8. Build sequence (dispatches)

1. **Part A enrichment** — tiny migration (`visits.source_new_repeat`); the
   single-pass recovery script (doctor map §3.2 + discount-type §3.4 + new/repeat
   §3.5); dry-run → review CSVs → commit (local → prod via MCP env) + validation.
   Ship first; prerequisite + low-risk + GL-silent.
2. **Views migration** — the `v_ops_*` views + `v_payment_channel` helper; regen
   types; SQL smoke (counts reconcile to raw).
3. **Daily report** page (the faithful reproduction) + CSV export.
4. **Trends — core + Ops pack** (recharts scaffolding, presets, the volume/revenue
   charts).
5. **HMO pack** (contribution + scorecard, reusing AR views).
6. **Doctor/Specialty pack** (depends on Part A).
7. **Marketing/Growth pack** (new-vs-repeat, referral, demographics, demand).
8. **Today snapshot** cards on the dashboard.
9. Mobile pass + RELEASE_NOTES + memory.

---

## 9. Success criteria

- Daily report for any past date **ties** to the manual sheet (within the known
  BDO→bank-transfer relabel) and to `v_daily_revenue_by_service` revenue totals.
- Part A: ≥93% of historical consults attributed to a named physician; remainder
  cleanly bucketed "Other" with a review CSV; zero JE delta.
- Every chart loads at 390px and desktop; analytics are admin-only.
- No new patient-level PII surface (aggregates only) — campaign targeting stays in
  the deferred project.

---

## 10. Risks → mitigations

| Risk | Mitigation |
|---|---|
| Wrong doctor attribution (identity error) | reviewed explicit map, not fuzzy; user signs off §3.2; unmatched→Other, never guessed |
| Over-reading partial-data marketing cuts | "based on N% with data" labels; honest coverage table (§6) |
| Re-running attribution double-writes | idempotent (fill-NULL-only); GL-silent |
| View performance as data grows | modest volume now; add indexes / materialize only if measured slow |
| Duplicate-patient inflation in retention | label pre-2026 retention "approximate"; campaign project will dedupe properly |
| Scope creep into per-patient marketing | hard line: this spec is aggregate-only; targeting = sub-project 3 |

---

## 11. Open items to resolve during implementation

- Confirm the §3.2 surname→physician map (esp. the 5 "Other" surnames — are any
  actually current doctors under a different name?).
- Whether to redirect/retire `admin/reports/daily-revenue` once the Operations
  Daily report ships.
- Exact "clinic day" definition for per-clinic-day revenue (operating days vs
  calendar days).

---

## 12. Privacy posture

Everything here is **aggregate** (counts/sums by day, service, doctor, HMO,
referral bucket, age band) — low RA 10173 risk, admin-only. The moment we produce
**named patient lists for outreach** (the campaign engine), a consent / lawful-
basis design is required on top of the existing `patient_consents` system. That
is intentionally the **next** project, not this one.

---

## 13. Roadmap — sub-project 3: Campaign engine (separate brainstorm)

Builds on these analytics to enable Claude-driven campaigns/ads:
- Patient **segments** (recall/due-for-test, lapsed/win-back, high-value, new).
- **Cross-sell / market-basket** (tests bought together → bundles/offers).
- **Referral-source ROI** (value per channel, not just count) → ad-budget allocation.
- **Doctor-as-draw** (which doctors bring new patients) → feature in ads.
- **LTV & retention cohorts**; "what to promote now" action board.
- ⭐ **Campaign-brief export** — structured insight → hand to Claude to draft ads.
- **Consent & lawful basis** for marketing use of patient data (the gating concern).

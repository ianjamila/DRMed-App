# Part B — Operational Daily Report (full daily P&L) — design

**Date:** 2026-06-05
**Status:** Design — ready for review
**Context:** Part B of the operational-analytics dashboard project
([[project-ops-analytics-dashboard]]). Follows Part A enrichment (v1.16.x) and
the patient de-dup pass (2026-06-05). Built against the cleaned, enriched data.

## Goal

Reproduce — and improve on — the clinic's manual **`DAILY MONITORING`** Google
Sheet as an in-app screen at **`Admin → Operations`**: a per-day operational
**P&L + cash + receivables cockpit**. The manual sheet is the source of truth for
what management expects to see; the app version must tie to it, then add
flexibility (date ranges, per-doctor/specialty, drill-down, export, and — in a
later sub-phase — charts).

## Reconciliation (why we trust the model)

The exact metric formulas were **validated against the real sheet**, not guessed.
Reconciling **Dec 4, 2023** (`DAILY MONITORING` tab) against the de-duped DB:

| Metric | Sheet | DB | |
|---|---|---|---|
| Lab — # tests | 50 | 50 | ✓ |
| Lab — distinct customers | 12 | 12 | ✓ |
| Lab — SALES (gross) | 23,985 | 23,985 | ✓ |
| Lab — discounts | 1,668 | 1,668 | ✓ |
| Lab — net (= sheet "gross profit") | 22,317 | 22,317 | ✓ |
| Lab — HMO lines | 13 | 13 | ✓ |
| Consult — sales / discounts | 7,400 / 7,400 | 7,400 / 7,400 | ✓ |
| Consult — count | 11 | 10 | ⚠ 1 still-held consult |

Lab ties to the peso; the only gap is 1 of the 77 still-held ambiguous consults.

### Locked metric formulas

- **SALES (gross)** = `Σ test_requests.base_price_php` — **not** `final_price_php`.
  The existing `v_daily_revenue_by_service` uses net `final_price_php`, so B1 needs
  **new views**.
- **DISCOUNTS** = `Σ discount_amount_php`. **Net / "gross profit"** = `Σ final_price_php`
  ( = gross − discount ).
- **DISTINCT CUSTOMERS** = `count(distinct visits.patient_id)` (accurate post-dedup).
- **business_date** = `(test_requests.released_at at time zone 'Asia/Manila')::date`.
- **LAB** = `services.kind in ('lab_test','lab_package','vaccine','home_service')`;
  **CONSULT** = `services.kind = 'doctor_consultation'`.
- **Channel (the method dimension):** `HMO` when `visits.hmo_provider_id is not null`,
  else the visit's `payments.method` mapped `cash→CASH, gcash→GCASH, bpi→BPI,
  bank_transfer→BDO, card→CARD PAY`. (BDO folds into `bank_transfer`, per history.)
- **Consult "DISCOUNTS" = the doctor's PF pass-through** (sales ≈ discounts → clinic
  net consult ≈ 0 for shareholder/rent doctors). Consult **PF COLLECTED** =
  `Σ doctor_pf_php`. Per-doctor/specialty productivity must show **counts/PF
  separately from clinic revenue** (a high-volume shareholder doctor is ₱0 clinic
  Sales by design — not "broken").

## The sheet is a full daily P&L — section → source-of-record map

The `DAILY MONITORING` tab is 128 rows: operational stats **plus** cash collection,
expenses, credit-card settlement, an HMO receivables subledger, and a cash-flow
roll. The key architectural principle: **each section reads from its existing
system of record**, so the report cannot disagree with the books.

| Sheet section | Rows | Source of record |
|---|---|---|
| LAB TESTS stats | 4–28 | `test_requests`/`visits`/`payments` — **new views** (✓ reconciled) |
| DOCTOR CONSULT stats | 29–50 | same — **new views** (✓ reconciled) |
| Rent / Mobile APE / Procedures | 51–53 | service categories + `physicians.compensation_arrangement` |
| TOTAL REV / DISC / GROSS PROFIT | 54–56 | rollups |
| CASH COLLECTED (by method, Veritas, HMO-rcvd) | 57–69 | `payments` + EOD cash recon (12.C) |
| EXPENSES (17 lines) | 70–87 | accounting books `journal_entries` + payroll (12.6) + AP (12.4) |
| NET INCOME | 88 | gross profit − expenses |
| CREDIT CARD (Veritas Pay) | 89–91 | card `payments` + settlement |
| HMO LAB RECEIVABLES (per provider) | 92–124 | **existing `v_hmo_*` views** |
| CASH FLOW (start/+collected/−expenses/=ending) | 125–128 | rollup |

So B1 is a **unifying read-layer over new operational views + 4 existing
subsystems** (payments/EOD, GL, HMO AR, payroll/AP), rendered in the familiar
day-matrix. It introduces **no new bookkeeping**.

## Architecture

- **Data layer = SQL views**, extending the `v_daily_revenue_by_service` pattern.
  Each section gets a view (or reuses an existing one). All read-only; no writes.
- **UI** = a new Server-Component route `Admin → Operations`, with a shared
  `SectionTabs` header (per `drmed-staff-ui` conventions): tabs **Daily report**
  (this spec) and **Trends** (Part B2). Server-rendered tables; the wide day-matrix
  scrolls horizontally on mobile.
- **Placement & gating:** under `src/app/(staff)/staff/(dashboard)/admin/operations/`,
  gated by `requireAdminStaff` (matches the existing `admin/reports/*`).
- **`recharts`** is **not** added in B1.1 (the Daily report is a numeric matrix +
  summary cards). It is introduced in **B1/Part-B Trends** when the first chart lands.

## Build phasing (each phase shippable)

- **B1.1 — Operational block** *(this spec's detail; build first)*: LAB + CONSULT
  stats by channel + HMO, totals + gross profit, **per-doctor & per-specialty**.
- **B1.2 — Cash collected + credit card**: collections by method, Veritas Pay,
  HMO-received (ties to EOD 12.C).
- **B1.3 — Expenses + Net income + Cash flow**: GL-sourced expense rollup → net
  income → cash flow.
- **B1.4 — HMO receivables subledger**: per-provider in/out/ending (reuse `v_hmo_*`).

B1.2–B1.4 get their own specs/plans when reached; their source mapping is fixed
above. The rest of this document specifies **B1.1**.

---

## B1.1 — Operational block (detailed design)

### Views

**`v_ops_daily_channel`** — grain `(business_date, section, channel)`:

```sql
create or replace view public.v_ops_daily_channel as
with base as (
  select
    (tr.released_at at time zone 'Asia/Manila')::date as business_date,
    case when s.kind = 'doctor_consultation' then 'consult' else 'lab' end as section,
    case
      when v.hmo_provider_id is not null then 'hmo'
      else coalesce(pm.method, 'unpaid')
    end as channel,
    v.patient_id,
    tr.base_price_php, tr.discount_amount_php, tr.final_price_php
  from public.test_requests tr
  join public.services s on s.id = tr.service_id
  join public.visits   v on v.id = tr.visit_id
  -- one representative payment method per visit (the visit's dominant method).
  left join lateral (
    select method from public.payments p
    where p.visit_id = v.id
    order by amount_php desc nulls last
    limit 1
  ) pm on true
  where tr.status = 'released'
)
select business_date, section, channel,
       count(*)                                   as line_count,
       count(distinct patient_id)                 as distinct_customers,
       coalesce(sum(base_price_php),0)::numeric(14,2)     as sales_gross,
       coalesce(sum(discount_amount_php),0)::numeric(14,2) as discount,
       coalesce(sum(final_price_php),0)::numeric(14,2)     as net
from base
group by business_date, section, channel;
```

> **Channel attribution rule:** a visit's channel is `HMO` if it carries an
> `hmo_provider_id`, otherwise the method of its **largest payment**. Mixed-method
> visits are rare and historically single-method (this reconciled exactly for the
> sample day); the view also exposes the per-visit grain implicitly so a future
> per-payment split can refine it without changing consumers. `unpaid` should not
> appear for released rows (payment-gating guarantees paid), but is kept as a
> defensive bucket and surfaced if non-zero.

**`v_ops_daily_totals`** — grain `(business_date, section)` — for the
cross-channel **distinct-customer total** and the **PF collected** figure that
don't roll up by summing channels:

```sql
create or replace view public.v_ops_daily_totals as
select
  (tr.released_at at time zone 'Asia/Manila')::date as business_date,
  case when s.kind = 'doctor_consultation' then 'consult' else 'lab' end as section,
  count(*)                                  as line_count,
  count(distinct v.patient_id)              as distinct_customers,
  coalesce(sum(tr.base_price_php),0)::numeric(14,2)      as sales_gross,
  coalesce(sum(tr.discount_amount_php),0)::numeric(14,2) as discount,
  coalesce(sum(tr.final_price_php),0)::numeric(14,2)     as net,
  coalesce(sum(tr.doctor_pf_php) filter (where s.kind='doctor_consultation'),0)::numeric(14,2) as pf_collected
from public.test_requests tr
join public.services s on s.id = tr.service_id
join public.visits   v on v.id = tr.visit_id
where tr.status = 'released'
group by business_date, section;
```

> **Verified columns:** `doctor_pf_php` is on **`test_requests`** (`tr.`), summed for
> consult lines. `attending_physician_id` is populated on **`visits`** (Part A set
> 7,335/7,399 consults; `test_requests.attending_physician_id` is empty — do not use
> it). PF is positive on 5,688 consult lines.

**`v_ops_daily_doctor`** — grain `(business_date, physician_id)` — per-doctor &
per-specialty consult productivity:

```sql
create or replace view public.v_ops_daily_doctor as
select
  (tr.released_at at time zone 'Asia/Manila')::date as business_date,
  ph.id as physician_id, ph.full_name, ph.specialty, ph.compensation_arrangement,
  count(*)                                   as consult_count,
  coalesce(sum(tr.base_price_php),0)::numeric(14,2)  as sales_gross,
  coalesce(sum(tr.doctor_pf_php),0)::numeric(14,2)   as pf_collected
from public.test_requests tr
join public.services s on s.id = tr.service_id
join public.visits   v on v.id = tr.visit_id
join public.physicians ph on ph.id = v.attending_physician_id
where tr.status = 'released' and s.kind = 'doctor_consultation'
group by business_date, ph.id, ph.full_name, ph.specialty, ph.compensation_arrangement;
```

Consults with no `attending_physician_id` (the ~59 "Other" from Part A) aggregate
under an "Unattributed" bucket in the UI (left-join handled UI-side or via a
`coalesce` label).

### Page & layout

Route `admin/operations/page.tsx` (Server Component), tabbed via `SectionTabs`:

- **Controls:** a month picker (default = current Manila month) and an optional
  custom `from`/`to` range, mirroring `admin/reports/daily-revenue`.
- **Summary cards** (top): month totals — distinct customers, # tests, # consults,
  gross sales, discounts, net/gross-profit, PF collected. Plain numbers, no chart
  lib.
- **Day-matrix** (the reproduction): rows = the sheet's metric rows grouped by
  **LAB TESTS** and **DOCTOR CONSULT** (distinct customers · #tests/#consults ·
  sales · discounts · totals · gross profit), each split by channel
  (CASH/GCASH/BPI/BDO/CARD PAY/HMO) + total; columns = days of the selected month.
  Horizontally scrollable; sticky first (label) columns.
- **Per-doctor / per-specialty** panel: a collapsible table — consult count, gross
  sales, PF collected per doctor (grouped by specialty), for the selected range.
  Shareholder/rent doctors are flagged so ₱0 clinic-sales reads as *by design*.

### Improvements over the sheet (in B1.1)

1. **Any month / custom date range** (the sheet is one fixed wide grid).
2. **Per-doctor & per-specialty** consult rollups (the manual tab lacks this).
3. **CSV export** of the current view (reuse the `writeCsv`-style download or a
   route handler).
4. **Drill-down (optional, nice-to-have):** a day header links to that day's
   visits list. Deferred if it expands scope.

### Data flow

Server Component → `createAdminClient()` (read-only) → select from the three views
filtered by `business_date` range → pivot into the matrix in JS (as
`daily-revenue` already does) → render. No Server Actions (read-only screen).

### Error handling

Standard: empty range → friendly "no activity" state; view/query error → the
short server-error pattern (no stack traces). Numbers formatted via the existing
`en-PH` PHP formatter.

### Testing

- **Pure pivot/format helpers** (matrix assembly, channel-label mapping, totals
  reconciliation) → `vitest` unit tests (no DB).
- **A reconciliation smoke**: a SQL assertion (or seed-backed test) that
  `v_ops_daily_*` reproduce the Dec 4 2023 figures above (50/12/23985/1668/22317).
- Migration follows the **drmed-migrations** checklist (views are
  `security definer`-free, read-only; no RLS rows to add; no audit obligations for
  read-only aggregate views — confirm in the migration step).

## Out of scope (B1.1)

- Cash-collected / credit-card / expenses / net-income / HMO-AR / cash-flow
  sections → **B1.2–B1.4** (sources fixed in the map above).
- Charts / Trends tab → **Part B2** (introduces `recharts`).
- Any write path, any change to how revenue/discount/PF are *captured* (B1 only
  reads).

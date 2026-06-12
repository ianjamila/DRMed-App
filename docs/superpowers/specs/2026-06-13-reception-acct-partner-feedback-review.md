# Reception/Acct partner feedback — final review & scope (2026-06-13)

Partner (clinic co-owner) reviewed the reception account and sent a request list.
This doc is the analyzed, validated, and user-decided scope. Nothing implemented yet.

## Partner's original list (verbatim summary)

1. Customers last & first name only — no middle name, why?
2. Billing print: file & paper size A5.
3. Dashboard "visits" breakdown: LAB > IMAGING (Xray/Ultrasound/ECG) > DOCTOR CONSULT > DOCTOR PROCEDURE.
4. Remove tabs: My payslips, Sell gift code, Cash drawer. (User: hide into "Hidden tabs", don't remove.)
5. Quick quote: remove Single quote mode; add HMO rates in builder; senior/disc not working; services marked "*" or packages → senior NOT applicable.
6. Reception nav/dashboard reorg: FRONT DESK (New patient registration / Appointments [consult, home service] / Queue: waiting-for-payment > processing > completed), BILLING (Billing summary / Quick quote / Petty cash), SERVICES (New lab request / New imaging request [xray, ultrasound, ECG]).

## Decisions (user, 2026-06-13)

| # | Decision |
|---|---|
| Cash drawer | **Defer the feature** — clinic counts cash manually at EOD for now. Hide tab from reception (admin keeps access). |
| HMO rates | Validated — already in the app (see findings). Close the gaps, no per-provider rate table. |
| "Billing Summary" | = the **printed patient billing** (the existing visit receipt) — NOT a new page. A5 work covers it. |
| ECG as imaging | OK for now (reclassify; imaging tech will see ECGs in their queue). |
| Hide other items? | **Keep everything else** (Patients, Inquiries, Registration link, Visit archive). Only the three partner-named tabs move to Hidden tabs. |
| Packages + senior | **Confirmed: packages must NOT get the 20% senior/PWD discount. Fix it.** |
| Approved extras | Centralize senior-price logic in one shared helper (quote + visit form). Hide matching dashboard cards via `/staff/admin/settings/dashboard-cards` when nav tabs hide. |

## Validation findings (prod, 2026-06-13)

### Senior/PWD discount — confirmed broken in quote, unenforced for packages
- Migration `0067` (2026-05-26) nulled `senior_discount_php` for the **entire catalog** (the column had held senior *price*, not discount — produced 80–116% discounts). Prod confirms: **0 services** have `senior_discount_php` set, all kinds.
- Visit form (`visits/new/visit-form.tsx:118-123`) has the `base × 0.20` fallback → works.
- Quote (`quote/quote-workbench.tsx:29-32`) has **no fallback** → senior price shows "—" for every service; builder's senior toggle silently charges cash price. This is the partner's "senior/disc not working".
- **No eligibility flag exists** — the visit form offers "Senior / PWD 20%" on every line including packages.
- Prod impact: **648 senior-discounted `lab_package` lines, ₱212,328.86 total discount** (2023-12-04 → 2026-05-22). Most are historical backfill (reflect what was genuinely charged then — do NOT touch; books are reconciled). Fix is forward-looking enforcement only.

### HMO rates — already in the app; two real gaps + data gaps
- Single `services.hmo_price_php` per service (no per-provider rates anywhere; partner not asking for them).
- Quote table has an HMO column (both modes); single-quote copy text includes HMO.
- **Gap A:** builder's "HMO total" renders ONLY when *every* picked item has an HMO price (`quote-workbench.tsx:416-427`). Coverage: lab_test 246/259, **lab_package 1/20, doctor_consultation 0/15**, vaccine 1/2, home_service 0/4 — so any quote containing a consult or package suppresses the HMO total. This is why it looks "missing".
- **Gap B:** the builder's copyable summary (`builderSummary()`, lines 148-159) includes **only cash/senior prices — never HMO**.
- Data follow-up (partner): fill `hmo_price_php` for the packages/consults that ARE HMO-billable.

### Middle name — captured, never displayed
- `patients.middle_name` exists (`0001_init.sql:76`); staff patient form + public /register capture it.
- Receipt prints `last_name, first_name` only and doesn't even SELECT middle_name (`visits/[id]/receipt/page.tsx:28,110`). Lists/dashboards same. Display-only fix.

### ECG — currently a chemistry lab test
- Prod row: `ECG / 12-Lead ECG, kind=lab_test, section=chemistry, ₱400 cash / ₱1,276 HMO`.
- Imaging is identified by `section IN ('imaging_xray'(49), 'imaging_ultrasound'(15))`. No `imaging_ecg` section exists (check constraint `0006:22`, mirror list `src/lib/auth/role-sections.ts`).
- Reclassification = migration extending the section check + role-sections + move the service row. Side effect (approved): xray_technician's queue gains ECGs; medtech loses them.
- 13 services have `section = NULL` — map them when building the dashboard breakdown.

### Print/A5
- No `@page { size }` rule anywhere — receipts print at browser default (A4/Letter). Receipt body is `max-w-2xl` (~672px), wider than A5 printable width → needs layout tightening alongside `@page { size: A5 }`. Group receipt's `print:break-before-page` per slip carries over.

### Hide mechanism
- "Hidden tabs" subgroup already exists in `staff-nav-config.ts:433-448` but nested under the **Admin section** → reception-visible items parked there would render under an "Admin" heading. Restructure to a per-role-visible top-level Hidden tabs section (or equivalent) when moving: My payslips (all roles → hidden), Sell gift code, Cash drawer.
- Coherence: reception dashboard hardcodes Quicklinks (Sell gift code, Cash drawer, End of day → remove) and shows "Gift codes sold" + "Cash drawer" cards → hide via `dashboard_card_prefs` settings page (zero code).

## Suggested designs (proposed, pending user OK)

### Reception visit queue (FRONT DESK > Queue) — NEW page
Today-scoped (Manila), three stages as tabs (SectionTabs):
- **Waiting for payment** — `visits.payment_status IN (unpaid, partial)`. Action: Record payment.
- **Processing** — paid/waived AND ≥1 lab/imaging `test_request` in a non-terminal status (not released/cancelled). Action: open visit.
- **Completed** — paid AND no lab/imaging test outstanding. Action: Print billing (A5).
- Consult-only visits: count as Completed once paid (on main there's no consult "done" signal; the unmerged `feat/split-visit-doctor-lab` branch adds consult mark-done — if it ships, wire it in).
- Placement: make it the landing tab of the Visits area (Queue | New visit | Archive) so the sidebar "Queue" item = `/staff/visits/queue`.

### Dashboard visits breakdown (partner #3)
Keep "Visits today" headline = visit count. Beneath it, **count orders (test_requests), not visits**, by category: Lab (lab kinds + send-outs + unsectioned) · Imaging (`imaging_*` sections + ECG) · Consults (`doctor_consultation`) · Procedures (`doctor_procedure`) · Other (vaccine/home-service, shown only when >0). Rationale: order counts = workload, no double-count ambiguity; a mixed visit contributes to each bucket it actually has orders in. (Rejected alternative: visit-level counts — mixed visits make the numbers not sum to the headline.)

### Nav reorg (reception)
- **Front desk:** New patient registration (`/staff/patients/new`), Patients, Appointments, Registration link, Queue (new), Inquiries
- **Billing:** Billing & receipts (→ visit archive; each visit → Print billing A5), Quick quote, Petty cash (pending definition — see open items)
- **Services:** New lab request / New imaging request → `/staff/visits/new` with the service picker **pre-filtered** (not hard-restricted — mixed visits stay possible)
- **Hidden tabs:** My payslips, Sell gift code, Cash drawer
- Appointments sub-views (Doctors consultation / Home service): add filter tabs on `/staff/appointments` (rows already carry `home_service_requested`).
- Mirror the same three groups in the dashboard Quicklinks.

## PR plan

1. **PR 1 — pricing correctness (senior + quote):** migration `senior_pwd_eligible boolean default true` on services, `false` for `lab_package`; shared senior-price helper (`senior_discount_php ?? base×0.20`, 0/N.A. when ineligible) used by quote + visit form; visit form hides/disables "Senior / PWD 20%" for ineligible lines; quote: remove Single-quote mode, senior columns via helper ("Not applicable" for packages), HMO price in builder copy summary, show partial HMO totals with explicit "N items have no HMO rate" instead of all-or-nothing; admin services editor gets the eligibility toggle. Regen types.
2. **PR 2 — billing print:** A5 `@page` + layout pass on single + group receipts; middle name on receipts, patient header, search results, visits list.
3. **PR 3 — chrome:** nav reorg + Hidden tabs restructure + quicklinks; dashboard visits-breakdown; appointments filter tabs; ECG→imaging migration; hide the 2 dashboard cards via settings (no code).
4. **PR 4 — reception queue page.**

## Open items (need partner/user input)

1. **"Starred" services:** no service name in the DB contains "\*" — the asterisks are presumably on the clinic's PRINTED price sheet marking senior-not-applicable items. Once the eligibility toggle exists (PR 1), partner just unticks those services in the admin Services editor — or sends the list for us to seed.
2. **"Petty cash" (reception, BILLING group):** ambiguous. Two readings: (a) till in/out adjustments — but that's part of the deferred cash-drawer system; (b) reception records small cash expenses (currently admin-only Quick expense). Recommendation: (b) — a minimal reception petty-cash expense form reusing the quick-expense machinery. Confirm before building.
3. **HMO price data entry:** packages (1/20) and consults (0/15) lack HMO prices — partner to provide rates for the ones that are HMO-billable.
4. Re-confirm hiding **My payslips** is intended even though payroll generates real payslips for reception staff.

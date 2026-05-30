# Split visit (Doctor PF / Lab & Services) + manual consultation pricing — Design

- **Date:** 2026-05-31
- **Status:** Approved (pending spec review)
- **Author:** brainstormed with partner-driven requirements
- **Surfaces touched:** reception "New visit" flow, visit receipt, services catalog, one migration

## Background

Reception's "New visit" form already classifies every service by `kind`
(`doctor_consultation`, `doctor_procedure` vs `lab_test`, `lab_package`,
`home_service`, `vaccine`) and the accounting layer already books doctor PF and
lab to separate GL accounts (4200/4500 vs 4100). But today reception saves a
**single `visits` row** holding both categories, producing **one `visit_number`,
one PIN, one `payment_status`, and one combined receipt**.

The partner requested two changes:

1. **Split the encounter into two visits** — one for **Doctor / Professional
   Fee**, one for **Lab & Services** — because the printed *official receipt*
   must be separate. The driver is that **the physician's professional fee is the
   physician's own income** (separate OR from the clinic's lab revenue); a pooled
   `payment_status` cannot represent "PF paid, lab unpaid."
2. **Make doctor consultation price manually entered** — remove the doctor
   *consultation* catalog because "the price always depends." The
   PF / rent / shareholder compensation scheme stays exactly as-is.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| How separate are the two visits? | **Two full visit records** — each own `visit_number`, PIN, `payment_status`, receipt. |
| Why split? | **Doctor PF is separate income** → separate official receipt. |
| Numbering & linking | **Two independent sequential `visit_number`s** + a hidden `visit_group_id` sibling link. |
| When does it split? | **Automatically** when an order has **both** a doctor item and a lab/service item. Single-category orders stay one visit. |
| Payment (v1) | **Two separate payments**, one OR each. "Collect for both" convenience screen deferred to v2. |
| PIN | **One shared PIN** written to both visits' `visit_pins` rows (same hash, same expiry). |
| Manual pricing scope | **Consultations only.** `doctor_procedure` keeps catalog prices. |
| Consultation line fields | **Attending physician + typed amount** (labeled "Consultation"; optional remarks). |
| HMO on the split | **Per-section, independent.** Doctor section and Lab section each have their own HMO toggle/provider; each resulting visit carries its section's HMO. |
| Consultation release / PF accrual | **Add a manual "Mark consultation done" release path** (Change C) — result-less consultation lines currently can't reach `released`, so doctor PF never posts. This makes "doctor PF as separate income" work end-to-end. |

## Why this is contained (key grounding facts)

- **Portal access is per-patient, not per-visit.** Login matches the *latest*
  unexpired `visit_pins` row and the portal lists *all* of the patient's released
  results (`src/app/(patient)/portal/(authenticated)/page.tsx` loads by
  `patient_id`, not `visit_id`). Splitting therefore does **not** break the
  portal — but it forces the shared-PIN decision (otherwise only the
  last-created PIN would log in and the other receipt would print a dead PIN).
- **Doctor-line pricing is snapshotted, not read from the catalog at use time.**
  GL bridge (`0064_pf_cogs_schema.sql` `bridge_test_request_released`),
  `doctor_pf_entries`, and `src/lib/accounting/sync.ts` all read
  `test_requests.{base_price_php, final_price_php, clinic_fee_php, doctor_pf_php}`
  — never `services.price_php` for doctor lines. So removing the consultation
  catalog price cannot affect already-released lines or any downstream
  accounting; it only touches the form + the creation action.
- **`visit_number` is a sequence-backed column default**
  (`generate_visit_number()` → `visit_number_seq`, `0001_init.sql`). Two inserts
  yield two sequential numbers with zero numbering changes.
- **`physicians.compensation_arrangement`** (`pf_split`/`rent_paying`/
  `shareholder`, default `pf_split`; `0064_pf_cogs_schema.sql`) drives the
  `clinic_fee_php` default (100 for `pf_split`, 0 otherwise). Untouched.

---

## Change A — Manual consultation pricing

### A1. Catalog anchor

- Add **one** generic service: `code = CONSULT`, name "Consultation",
  `kind = 'doctor_consultation'`, `price_php = 0`, `is_active = true`. New
  consultation lines attach to this service as their `service_id` (FK is
  `NOT NULL`; the line carries the real amount as a snapshot).
- Set every **existing** `doctor_consultation` service (the per-specialty
  `CONSULT_*` rows) to **`is_active = false`**. They are **kept, not deleted** —
  historical released `test_requests` reference them via `service_id` and their
  prices are already snapshotted. Deactivating only removes them from pickers.

### A2. Form — Doctor section (`visits/new/visit-form.tsx`)

- The consultation stops being a catalog pick. The Doctor section becomes:
  - **Attending physician** dropdown (already present).
  - **Consultation fee ₱** — manual numeric input, **blank by default** (price
    always depends).
  - Existing optional **clinic fee** / **doctor PF** override inputs, still
    auto-defaulted from the selected physician's `compensation_arrangement`
    (100/remainder for `pf_split`; 0/full for `rent_paying`/`shareholder`).
  - Optional remarks (existing `receptionist_remarks`).
- `doctor_procedure` keeps its **catalog picker unchanged** (price + clinic/PF
  split as today).
- Remove the catalog-price display (`basePriceFor`) for the consultation only.

### A3. Action (`visits/new/actions.ts`)

- When a consultation fee `> 0` is submitted, create a `test_requests` row on the
  `CONSULT` service with `base_price_php` = `final_price_php` = the typed amount
  (minus any discount, if a discount is applied), `kind = 'doctor_consultation'`.
- Run the **identical** `clinic_fee_php` / `doctor_pf_php` split logic that
  exists today (lines ~138–151) — only the *source of the total* changes from
  `services.price_php` to the typed amount.
- **Validation:** a consultation line requires **both** an attending physician
  and a fee `> 0`. Physician-without-fee or fee-without-physician is a
  user-facing error.

### A4. Small follow-ups

- Exclude `doctor_consultation` from the admin **Prices** editor
  (`/staff/admin/prices`) — show it as "priced at counter" rather than an
  editable price field.
- `/schedule` already hides doctor prices, and reception prices the consultation
  at the counter on arrival, so booking is unaffected. **Verify** during
  implementation that no appointment→visit path auto-creates a priced
  consultation.

### A5. Explicitly untouched

PF/rent/shareholder scheme, `clinic_fee_php`/`doctor_pf_php` semantics,
`doctor_pf_entries` accrual, GL routing (4200/4500 clinic fee, 2110/2160 PF),
accounting export. All read snapshots, not the catalog.

---

## Change B — Split into two visits

### B1. Schema

- Add `visits.visit_group_id uuid null` (indexed). Siblings of a split share one
  group id; standalone visits stay `NULL`.
- **No RLS change** (patient policy keys on `patient_id`), **no payment-gating
  change**, **no audit-trigger change** — an additive, low-risk column per the
  `drmed-migrations` checklist.

### B2. Creation flow (`visits/new/actions.ts`)

On save, partition the order:

- **Doctor set** = a manual consultation line (if fee `> 0`) and/or any
  `doctor_procedure` lines.
- **Lab & Services set** = everything else (`lab_test`, `lab_package` + its
  decomposed components, `home_service`, `vaccine`).

Then:

- **Both sets non-empty → split.** Mint one `visit_group_id`. Create:
  - **Doctor visit** — carries `attending_physician_id` and the **Doctor
    section's** HMO fields; holds the consultation + procedure `test_requests`;
    `total_php` = sum of its lines.
  - **Lab visit** — carries the **Lab section's** HMO fields; holds the
    lab/service `test_requests`; `total_php` = sum of its lines.
  - Package decomposition unchanged — a `lab_package` header+components stay
    together on the Lab visit; no package ever spans both visits.
- **One set only → today's behavior.** Single visit, `visit_group_id = NULL`,
  that section's HMO.

**Atomicity:** the two-visit create must be all-or-nothing (no half-encounter /
orphan visit + dead OR number). Implementation chooses between (a) a single
`SECURITY DEFINER` RPC that creates both visits + their `test_requests` +
`visit_pins` atomically, or (b) app-code inserts wrapped in a `try/catch` that
deletes the first visit if the second fails. **Lean (a) RPC** because this is
OR/money; final call in the implementation plan.

### B3. PIN

Generate **one** plain PIN per encounter; write it (same `pin_hash`, same
`expires_at`) to **both** visits' `visit_pins` rows. Either receipt's printed PIN
logs in; the patient sees consult + lab results together. Both receipts print the
same DRM-ID + PIN.

> Known minor edge (acceptable, same class as today's multi-visit behavior):
> admin **reissue-PIN** updates only the latest visit's row, desyncing the two
> hashes; login still works (uses latest), but the older slip's printed PIN goes
> stale. Optional v2: reissue updates all rows sharing the `visit_group_id`.

### B4. Receipt output

- **Split encounter →** redirect after save to a **combined receipt view** keyed
  by `visit_group_id` that stacks **two complete OR slips** — "Doctor /
  Professional Fee" (own `visit_number` + total) and "Lab & Services" (own
  `visit_number` + total), page-break between — then **one** shared Patient
  Portal Access block (DRM-ID + shared PIN) at the bottom. One Print → two slips.
  - The plain PIN flash must be keyed to the **`visit_group_id`** (not a single
    `visit.id`), and both slips honor the existing "shown once" rule.
- **Single split visit →** opening `/staff/visits/[id]/receipt` for a visit that
  belongs to a group renders its own slip and offers a **"Print combined receipt
  →"** link to the group view.
- **Standalone (non-split) visit →** existing `/staff/visits/[id]/receipt`
  unchanged.

### B5. Payment (v1)

Two **separate** payments, one OR each, via today's
`/staff/payments/new?visit_id=…`. Each visit's `payment_status` is independent.
No new payment UI in v1. Doctor revenue (4200) and lab revenue (4100) land on
their respective visits automatically — no GL change. "Collect for both"
convenience screen deferred to v2.

### B6. Staff cross-linking

On the visit-detail page, show *"Part of the same visit as #0124 — Lab &
Services →"* (and the reverse) so siblings are traceable. A grouped encounter row
in the visit **list** is deferred to v2.

---

## Change C — "Mark consultation done" (release path so doctor PF accrues)

### Why this is needed

A `doctor_consultation` line is created at `status = 'requested'` and has **no
working path to `released`** today: the only forward action for a result-less
line is "claim in queue" → `in_progress`, and from there the only step is *upload
a result* (which a consultation never has). The Release button in `TestAction`
(`visits/[id]/page.tsx:764`) is hard-keyed to `ready_for_release`, which a
consultation can never reach. So `bridge_test_request_released` never fires for
consultations and **doctor PF never posts** (no `doctor_pf_entries` row, no JE).
This pre-existing gap defeats the partner's "doctor PF is separate income" goal,
so this feature closes it.

### Design

- Add a **"Mark consultation done"** affordance in `TestAction` for
  `kind = 'doctor_consultation'` lines at `status IN ('requested','in_progress')`.
  (Plain-language label per project convention; under the hood it sets
  `status = 'released'`.)
- It calls the **existing** `releaseTestAction`
  (`visits/[id]/actions.ts`) — a direct `requested → released` transition is
  valid (the release trigger fires on *any* old≠new `→ released`). No queue claim
  or result upload required.
- **Payment gating unchanged & authoritative:** `enforce_payment_before_release`
  still requires `visits.payment_status IN ('paid','waived')`. The button is
  disabled in the UI until paid/waived (UX); the trigger is the source of truth.
- On release, `bridge_test_request_released` fires the consult PF branch:
  cash visit → PF to **2110** (`recognition_basis = 'cash_at_release'`); HMO
  visit (Doctor-section HMO set) → PF parked in **2160**
  (`hmo_at_settlement`). This is exactly the per-section HMO behavior from B2.
- **P0034 alignment:** release of a consult requires a resolvable
  `attending_physician_id`. New consultations always have one (Change A
  validation). Legacy/edge rows missing it surface the translated P0034 message.
- `release_medium` defaults to a sensible value for a result-less line (no PDF
  delivery); confirm the exact default in the plan. Ensure the release is
  **audit-logged** (RA 10173) — verify `releaseTestAction` already audits and
  extend if not.

### Scope

Scoped to **`doctor_consultation`**. `doctor_procedure` lines that produce a
result release normally; any result-less procedure/`vaccine`/`home_service` gap
is **not** addressed here (separate concern, noted in non-goals).

---

## Edge cases

- **Doctor only** (consultation and/or procedure, no labs) → one Doctor visit,
  `visit_group_id = NULL`.
- **Lab only** → one Lab visit, `visit_group_id = NULL`. (Current behavior.)
- **Consultation fee blank / 0** → no consultation line; if there are no
  procedures either, no Doctor visit.
- **Procedure but no consultation, plus labs** → still splits; Doctor visit holds
  only the procedure (attending physician still required for its clinic/PF split).
- **Empty order** → blocked by existing validation.
- **Per-section HMO differs** (e.g., doctor on Maxicare, lab cash) → honored;
  each visit gets its own `hmo_provider_id`, and the PF GL routes to 2160 vs 2110
  accordingly.
- **"Mark consultation done" before payment** → blocked (button disabled in UI;
  `enforce_payment_before_release` rejects regardless, as source of truth).
- **Legacy consultation line with no attending physician** → release raises
  P0034, shown via the translated message; new consultations always have one.

## Migration & types

One migration following the `drmed-migrations` workflow:

1. `alter table public.visits add column visit_group_id uuid;` + index.
2. Insert the `CONSULT` anchor service; `update services set is_active = false
   where kind = 'doctor_consultation' and code <> 'CONSULT';`
3. `supabase db diff` → test on local stack → apply to staging → prod →
   `npm run db:types`.

No RLS/payment-gating/audit-trigger changes. (Remote apply note: direct DB host
is IPv6-only/unreachable here — apply via Supabase MCP or the IPv4 pooler, and
record the migration row, per project convention.)

## Testing

- **Vitest (pure logic, no `server-only`):**
  - Order-partition: given a mix of lines, returns correct Doctor set / Lab set /
    split decision (both-present, doctor-only, lab-only, consultation-blank).
  - Consultation split math: typed amount + physician scheme → expected
    `clinic_fee_php` / `doctor_pf_php` (pf_split=100/rest; rent/shareholder=0/full;
    manual overrides honored).
- **Smoke / manual UI** (mobile-first, verify at 390×844 per project convention):
  - Both-category order → two visits, two numbers, shared group id, shared PIN,
    combined two-slip receipt, two independent payments → independent
    `payment_status`.
  - Consultation end-to-end: create → pay → **"Mark consultation done"** →
    line `released` → PF posts. Cash → `doctor_pf_entries` + JE to 2110; HMO
    (Doctor-section provider set) → parked in 2160.
  - "Mark consultation done" is disabled/blocked until the visit is paid/waived.
  - Single-category order → unchanged single receipt.

## Non-goals / deferred (v2)

- "Collect for both" combined payment screen.
- Grouped encounter row in the visit list.
- Reissue-PIN syncing both sibling `visit_pins` rows.
- Backfill: **forward-only** — existing combined visits stay combined.
- Multiple attending physicians per encounter (model still assumes one).
- Release path for other result-less kinds (`doctor_procedure` with no result,
  `vaccine`, `home_service`) — same theoretical gap, but out of scope here;
  Change C is scoped to `doctor_consultation`.

## Blast radius confirmed safe

`payments`, `results`, `audit_log`, `journal_entries`, `doctor_pf_entries`,
`hmo_payment_allocations`, package decomposition, and the patient portal all key
off `test_request_id`/`patient_id`/snapshots and are unaffected by the visit
split beyond naturally landing each line on its correct visit. `inquiries.
linked_visit_id` / `gift_codes.redeemed_visit_id` attach to whichever single
visit the post-creation action targets — no change needed.

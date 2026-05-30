# Split Visit (Doctor PF / Lab & Services) + Manual Consultation Pricing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a reception order contains both a doctor item and a lab/service item, create two linked visits (Doctor / Professional Fee + Lab & Services), each with its own official-receipt number, payment status and receipt; make doctor consultation price manually entered; and add a "Mark consultation done" release path so doctor PF actually posts to the books.

**Architecture:** Three coordinated changes on the reception "New visit" surface. Pure decision logic (partition + consultation-fee split) is extracted into `src/lib/visits/*` modules unit-tested with vitest (no `server-only`). The visit-creation Server Action orchestrates one-or-two visit creation with a shared PIN and best-effort rollback. The form gains a manual consultation fee and a per-section HMO selector. A new group-keyed combined receipt renders two slips. A "Mark consultation done" action+button releases result-less consultation lines, reusing the existing release/PF-accrual machinery.

**Tech Stack:** Next.js 16 (App Router, Server Components + Server Actions), Supabase (Postgres + RLS), TypeScript strict, vitest, Tailwind. Spec: `docs/superpowers/specs/2026-05-31-split-visit-and-manual-consultation-design.md`.

---

## File Structure

**Create:**
- `src/lib/visits/order-lines.ts` — pure: classify a line's kind, partition lines into doctor/lab, decide split.
- `src/lib/visits/order-lines.test.ts` — vitest.
- `src/lib/visits/consultation-fee.ts` — pure: `defaultClinicFee`, `splitDoctorFee`.
- `src/lib/visits/consultation-fee.test.ts` — vitest.
- `supabase/migrations/0090_split_visit_and_consult_anchor.sql` — `visits.visit_group_id` column + index; `CONSULT` anchor service; deactivate per-specialty consultation services.
- `src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx` — combined two-slip receipt.
- `src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/print-button.tsx` — re-export of the existing print button (or import the shared one).
- `src/app/(staff)/staff/(dashboard)/visits/[id]/mark-done-button.tsx` — "Mark consultation done" client button.

**Modify:**
- `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts` — manual consult fee, per-section HMO, two-visit split, shared PIN, group flash, rollback.
- `src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx` — manual consultation fee input; per-section HMO selectors; import `defaultClinicFee`.
- `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` — add `markConsultationDoneAction`.
- `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx` — pass `kind` to `TestAction`; render mark-done button for consultations; sibling cross-link.
- `src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx` — "Print combined receipt" link when the visit belongs to a group.
- `src/lib/auth/visit-pin-flash.ts` — group-keyed flash.
- `src/app/(staff)/staff/(dashboard)/admin/prices/prices-table.tsx` — show `doctor_consultation` as "priced at counter" (read-only).
- `scripts/seed-services.ts` — add the `CONSULT` anchor idempotently.
- `src/types/database.ts` — regenerated (do not hand-edit).

---

## Phase 0 — Migration, types, seed

### Task 0.1: Write the migration

**Files:**
- Create: `supabase/migrations/0090_split_visit_and_consult_anchor.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0090_split_visit_and_consult_anchor.sql
-- Two changes:
--  (1) visits.visit_group_id — links the two halves (Doctor PF / Lab & Services)
--      of one counter encounter that was split into two visits. NULL for
--      standalone (non-split) visits. Additive, nullable; no RLS change (the
--      patient policy keys on patient_id), no payment-gating/audit change.
--  (2) Manual consultation pricing: introduce one generic CONSULT anchor
--      service (price 0 — the amount is typed at the counter and snapshotted
--      onto each test_requests line) and deactivate the per-specialty
--      consultation catalog so it stops appearing in pickers. Existing rows are
--      kept for FK/history; their prices are already snapshotted on released
--      test_requests.

alter table public.visits
  add column if not exists visit_group_id uuid;

create index if not exists idx_visits_visit_group_id
  on public.visits(visit_group_id)
  where visit_group_id is not null;

-- Generic consultation anchor. price_php = 0; reception types the real fee.
insert into public.services (code, name, kind, price_php, is_active, requires_signoff)
values ('CONSULT', 'Consultation', 'doctor_consultation', 0, true, false)
on conflict (code) do update
  set name = excluded.name,
      kind = excluded.kind,
      is_active = true,
      requires_signoff = false;

-- Retire the per-specialty consultation catalog (kept for FK/history).
update public.services
  set is_active = false
  where kind = 'doctor_consultation'
    and code <> 'CONSULT';
```

- [ ] **Step 2: Apply to a local Supabase stack and verify**

Run:
```bash
supabase start
supabase db reset   # applies all migrations incl. 0090 to the local stack
```
Expected: reset completes without error. Then verify:
```bash
supabase db query "select code, is_active from public.services where kind='doctor_consultation' order by code;"
```
Expected: exactly one active row `CONSULT`; all `CONSULT_*` rows `is_active=false`. And:
```bash
supabase db query "select column_name from information_schema.columns where table_name='visits' and column_name='visit_group_id';"
```
Expected: one row `visit_group_id`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0090_split_visit_and_consult_anchor.sql
git commit -m "feat(db): add visit_group_id + CONSULT anchor, retire consult catalog"
```

### Task 0.2: Regenerate types

**Files:**
- Modify: `src/types/database.ts` (generated)

- [ ] **Step 1: Regenerate from the local stack**

Run: `npm run db:types`
Expected: `src/types/database.ts` updates; `visits` Row/Insert/Update gain `visit_group_id: string | null`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors from the regenerated types yet — code changes come later).

- [ ] **Step 3: Commit**

```bash
git add src/types/database.ts
git commit -m "chore(db): regenerate types for 0090"
```

### Task 0.3: Add the CONSULT anchor to the seed script (idempotent)

**Files:**
- Modify: `scripts/seed-services.ts`

- [ ] **Step 1: Add CONSULT to the seeded services**

Find the `doctor_consultation` block (the `CONSULT_*` entries around lines 164–288) and add a `CONSULT` entry at the top of that block so a fresh seed/reseed includes the anchor. Use the same object shape the script already uses for other services:

```ts
  // Generic manual-price consultation anchor (price typed at the counter).
  // Migration 0090 also inserts this; seeding keeps a fresh DB consistent.
  { code: "CONSULT", name: "Consultation", kind: "doctor_consultation", price_php: 0, turnaround_hours: null, requires_signoff: false },
```

(Match the exact property names used by the surrounding entries in this file — if the file omits `requires_signoff`/`turnaround_hours` on other rows, omit them here too.)

- [ ] **Step 2: Run the seed against the local stack to confirm idempotency**

Run: `npm run seed:services`
Expected: completes without error; re-running does not duplicate `CONSULT` (the script upserts on `code`).

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-services.ts
git commit -m "chore(seed): include CONSULT consultation anchor"
```

---

## Phase A — Manual consultation pricing

### Task A1: Pure consultation-fee module (TDD)

**Files:**
- Create: `src/lib/visits/consultation-fee.ts`
- Test: `src/lib/visits/consultation-fee.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/visits/consultation-fee.test.ts
import { describe, it, expect } from "vitest";
import { defaultClinicFee, splitDoctorFee } from "./consultation-fee";

describe("defaultClinicFee", () => {
  it("is 100 for pf_split (and unknown)", () => {
    expect(defaultClinicFee("pf_split")).toBe(100);
    expect(defaultClinicFee(undefined)).toBe(100);
  });
  it("is 0 for rent_paying and shareholder", () => {
    expect(defaultClinicFee("rent_paying")).toBe(0);
    expect(defaultClinicFee("shareholder")).toBe(0);
  });
});

describe("splitDoctorFee", () => {
  it("defaults clinic fee from arrangement and PF to the remainder", () => {
    expect(
      splitDoctorFee({ finalPrice: 500, arrangement: "pf_split", clinicFeeRaw: "", doctorPfRaw: "" }),
    ).toEqual({ clinic_fee_php: 100, doctor_pf_php: 400 });
  });
  it("gives the doctor the full fee for rent_paying", () => {
    expect(
      splitDoctorFee({ finalPrice: 500, arrangement: "rent_paying", clinicFeeRaw: "", doctorPfRaw: "" }),
    ).toEqual({ clinic_fee_php: 0, doctor_pf_php: 500 });
  });
  it("honors explicit overrides", () => {
    expect(
      splitDoctorFee({ finalPrice: 800, arrangement: "pf_split", clinicFeeRaw: "150", doctorPfRaw: "650" }),
    ).toEqual({ clinic_fee_php: 150, doctor_pf_php: 650 });
  });
  it("never produces a negative PF", () => {
    expect(
      splitDoctorFee({ finalPrice: 50, arrangement: "pf_split", clinicFeeRaw: "", doctorPfRaw: "" }),
    ).toEqual({ clinic_fee_php: 100, doctor_pf_php: 0 });
  });
  it("falls back to the arrangement default for invalid clinic-fee input", () => {
    expect(
      splitDoctorFee({ finalPrice: 500, arrangement: "pf_split", clinicFeeRaw: "abc", doctorPfRaw: "" }),
    ).toEqual({ clinic_fee_php: 100, doctor_pf_php: 400 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/visits/consultation-fee.test.ts`
Expected: FAIL — "Cannot find module './consultation-fee'".

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/visits/consultation-fee.ts
// Pure helpers for the doctor consult/procedure fee split. No server-only
// imports so this is unit-testable. Shared by the visit form (defaults for
// display) and the visit-creation action (authoritative snapshot).

/** Clinic's cut of a doctor fee, defaulted from the physician's arrangement. */
export function defaultClinicFee(arrangement: string | undefined | null): number {
  if (arrangement === "rent_paying" || arrangement === "shareholder") return 0;
  return 100; // pf_split (and unknown) → clinic keeps ₱100
}

interface SplitInput {
  finalPrice: number;
  arrangement: string | undefined | null;
  clinicFeeRaw: string; // raw form value; "" means "use the default"
  doctorPfRaw: string;  // raw form value; "" means "remainder"
}

/**
 * Split a doctor line's final price into clinic_fee + doctor_pf.
 * Empty/invalid clinic-fee input falls back to the arrangement default;
 * empty/invalid PF input falls back to (final − clinic fee), floored at 0.
 */
export function splitDoctorFee({
  finalPrice,
  arrangement,
  clinicFeeRaw,
  doctorPfRaw,
}: SplitInput): { clinic_fee_php: number; doctor_pf_php: number } {
  const cfDefault = defaultClinicFee(arrangement);
  const cfNum = clinicFeeRaw.trim() === "" ? cfDefault : Number(clinicFeeRaw);
  const clinic_fee_php = Number.isFinite(cfNum) && cfNum >= 0 ? cfNum : cfDefault;

  const pfDefault = Math.max(0, finalPrice - clinic_fee_php);
  const pfNum = doctorPfRaw.trim() === "" ? pfDefault : Number(doctorPfRaw);
  const doctor_pf_php = Number.isFinite(pfNum) && pfNum >= 0 ? pfNum : pfDefault;

  return { clinic_fee_php, doctor_pf_php };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/visits/consultation-fee.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/visits/consultation-fee.ts src/lib/visits/consultation-fee.test.ts
git commit -m "feat(visits): pure doctor-fee split helper"
```

### Task A2: Action reads the manual consultation fee + arrangement-aware split

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`

> This task changes ONLY how a `doctor_consultation` line is priced (manual fee instead of catalog price) and centralizes the split via `splitDoctorFee`. The two-visit split + per-section HMO come in Phase B; for now the action still creates one visit.

- [ ] **Step 1: Import the helper and load the physician arrangement**

At the top of the file, add the import:

```ts
import { splitDoctorFee, defaultClinicFee } from "@/lib/visits/consultation-fee";
```

After the `services` fetch (currently around line 91–98), add a fetch of the attending physician's arrangement (used for the server-side default; the form also sends explicit values):

```ts
  let attendingArrangement: string | null = null;
  if (parsed.data.attending_physician_id) {
    const admin = createAdminClient();
    const { data: phys } = await admin
      .from("physicians")
      .select("compensation_arrangement")
      .eq("id", parsed.data.attending_physician_id)
      .maybeSingle();
    attendingArrangement = phys?.compensation_arrangement ?? null;
  }
```

- [ ] **Step 2: Price consultation lines from the manual fee**

In the `lines = parsed.data.service_ids.map(...)` block, replace the `base` computation and the consultation split. Find:

```ts
    const base = hmoSelected && hmoPrice != null ? hmoPrice : cashPrice;
```

Replace with (consultation base = the typed fee; everything else unchanged):

```ts
    // doctor_consultation: price is typed at the counter, not from the catalog.
    const consultFeeRaw =
      s.kind === "doctor_consultation"
        ? formData.get(`consult_fee__${service_id}`)?.toString() ?? ""
        : "";
    const consultFee = Number(consultFeeRaw);
    const base =
      s.kind === "doctor_consultation"
        ? Number.isFinite(consultFee) && consultFee >= 0
          ? consultFee
          : 0
        : hmoSelected && hmoPrice != null
          ? hmoPrice
          : cashPrice;
```

Then find the consultation split block (currently lines ~141–151):

```ts
    let clinic_fee_php: number | null = null;
    let doctor_pf_php: number | null = null;
    if (s.kind === "doctor_consultation") {
      const cfRaw = formData.get(`clinic_fee__${service_id}`)?.toString() ?? "";
      const cfNum = cfRaw === "" ? 100 : Number(cfRaw);
      clinic_fee_php = Number.isFinite(cfNum) && cfNum >= 0 ? cfNum : 100;
      const pfRaw = formData.get(`doctor_pf__${service_id}`)?.toString() ?? "";
      const pfDefault = Math.max(0, final_price_php - clinic_fee_php);
      const pfNum = pfRaw === "" ? pfDefault : Number(pfRaw);
      doctor_pf_php = Number.isFinite(pfNum) && pfNum >= 0 ? pfNum : pfDefault;
    }
```

Replace with (arrangement-aware via the shared helper):

```ts
    let clinic_fee_php: number | null = null;
    let doctor_pf_php: number | null = null;
    if (s.kind === "doctor_consultation") {
      const split = splitDoctorFee({
        finalPrice: final_price_php,
        arrangement: attendingArrangement,
        clinicFeeRaw: formData.get(`clinic_fee__${service_id}`)?.toString() ?? "",
        doctorPfRaw: formData.get(`doctor_pf__${service_id}`)?.toString() ?? "",
      });
      clinic_fee_php = split.clinic_fee_php;
      doctor_pf_php = split.doctor_pf_php;
    }
```

In the `doctor_procedure` block just below it, replace the inline default (`cfRaw === "" ? 0 : ...` and the PF default) with the same helper for consistency. Find the procedure split (lines ~165–173):

```ts
      if (clinic_fee_php === null) {
        const cfRaw = formData.get(`clinic_fee__${service_id}`)?.toString() ?? "";
        const cfNum = cfRaw === "" ? 0 : Number(cfRaw);
        clinic_fee_php = Number.isFinite(cfNum) && cfNum >= 0 ? cfNum : 0;
        const pfRaw = formData.get(`doctor_pf__${service_id}`)?.toString() ?? "";
        const pfDefault = Math.max(0, final_price_php - clinic_fee_php);
        const pfNum = pfRaw === "" ? pfDefault : Number(pfRaw);
        doctor_pf_php = Number.isFinite(pfNum) && pfNum >= 0 ? pfNum : pfDefault;
      }
```

Replace with:

```ts
      if (clinic_fee_php === null) {
        // Procedures default clinic fee to 0 unless reception types one; PF is
        // the remainder. (defaultClinicFee handles rent/shareholder = 0 too.)
        const cfRaw = formData.get(`clinic_fee__${service_id}`)?.toString() ?? "";
        const split = splitDoctorFee({
          finalPrice: final_price_php,
          arrangement: attendingArrangement,
          clinicFeeRaw: cfRaw.trim() === "" ? "0" : cfRaw,
          doctorPfRaw: formData.get(`doctor_pf__${service_id}`)?.toString() ?? "",
        });
        clinic_fee_php = split.clinic_fee_php;
        doctor_pf_php = split.doctor_pf_php;
      }
```

- [ ] **Step 3: Validate consultation lines (physician + positive fee)**

Immediately after the `lines` array is built and before `const totalPhp = ...`, add:

```ts
  // A consultation must have a positive (manual) fee and an attending physician
  // — release later requires the physician (P0034), and a ₱0 consult is a slip.
  const hasConsult = lines.some(
    (l) => services.find((s) => s.id === l.service_id)?.kind === "doctor_consultation",
  );
  if (hasConsult) {
    if (!parsed.data.attending_physician_id) {
      return { ok: false, error: "Select an attending physician for the consultation." };
    }
    const badConsult = lines.some(
      (l) =>
        services.find((s) => s.id === l.service_id)?.kind === "doctor_consultation" &&
        !(l.final_price_php > 0),
    );
    if (badConsult) {
      return { ok: false, error: "Enter a consultation fee greater than ₱0." };
    }
  }
```

- [ ] **Step 4: Typecheck + run the full unit suite**

Run: `npm run typecheck && npm test`
Expected: PASS. (`hmoSelected` is still defined; we only changed `base` for consultation lines.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/new/actions.ts"
git commit -m "feat(visits): price doctor consultations from a manual fee"
```

### Task A3: Form — manual consultation fee input

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx`

- [ ] **Step 1: Import the shared default and add consult-fee line state**

Replace the local `defaultClinicFee` (lines ~61–65) with an import. At the top with the other imports add:

```ts
import { defaultClinicFee } from "@/lib/visits/consultation-fee";
```

Delete the local function:

```ts
/** Derive default clinic_fee from physician compensation arrangement. */
function defaultClinicFee(arrangement: string | undefined): number {
  if (arrangement === "rent_paying" || arrangement === "shareholder") return 0;
  return 100;
}
```

Add a `consultFee` field to `LineState` (interface around lines 76–85):

```ts
interface LineState {
  discountKind: DiscountKind;
  customDiscount: string;
  clinicFee: string;
  doctorPf: string;
  procedureDescription: string;
  hmoApprovedAmount: string;
  consultFee: string; // manual consultation fee (doctor_consultation only)
}
```

Add `consultFee: ""` to the default object in `getLine` (lines ~287–298):

```ts
  function getLine(id: string): LineState {
    return (
      lineState[id] ?? {
        discountKind: "",
        customDiscount: "",
        clinicFee: "",
        doctorPf: "",
        procedureDescription: "",
        hmoApprovedAmount: "",
        consultFee: "",
      }
    );
  }
```

- [ ] **Step 2: Make a consultation's base price the typed fee**

In the `lines = useMemo(...)` block (lines ~305–316), make the base for a consultation come from `consultFee`:

```ts
  const lines = useMemo(() => {
    return services
      .filter((s) => selected.has(s.id))
      .map((s) => {
        const ls = getLine(s.id);
        const base =
          s.kind === "doctor_consultation"
            ? (() => {
                const n = Number(ls.consultFee);
                return Number.isFinite(n) && n >= 0 ? n : 0;
              })()
            : basePriceFor(s, hmoSelected);
        const discount = discountFor(s, base, ls.discountKind, ls.customDiscount);
        const final = Math.max(0, base - discount);
        return { service: s, base, discount, final, ls };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, selected, hmoSelected, lineState]);
```

- [ ] **Step 3: Show "priced at counter" instead of a catalog price for CONSULT**

In the service-picker card (around lines 512–556), where `const display = basePriceFor(s, hmoSelected);` is used, special-case consultation. Replace:

```ts
            const display = basePriceFor(s, hmoSelected);
```

with:

```ts
            const isConsultPick = s.kind === "doctor_consultation";
            const display = basePriceFor(s, hmoSelected);
```

and replace the price `<span>` (lines ~548–555):

```tsx
                  <span className="font-semibold text-[color:var(--color-brand-cyan)]">
                    {formatPhp(display)}
                    {hmoSelected && s.hmo_price_php != null ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                        hmo
                      </span>
                    ) : null}
                  </span>
```

with:

```tsx
                  <span className="font-semibold text-[color:var(--color-brand-cyan)]">
                    {isConsultPick ? (
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                        priced at counter
                      </span>
                    ) : (
                      <>
                        {formatPhp(display)}
                        {hmoSelected && s.hmo_price_php != null ? (
                          <span className="ml-1 text-[10px] uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                            hmo
                          </span>
                        ) : null}
                      </>
                    )}
                  </span>
```

- [ ] **Step 4: Render a Consultation fee input on the consult line**

In the per-line detail block, the consultation branch is `{isConsult ? (...) : null}` (lines ~675–723). Add a fee input as the first field inside that grid, before the Clinic fee field. Find the opening of that block:

```tsx
                  {isConsult ? (
                    <div className="mt-2 grid grid-cols-12 gap-2 rounded-md bg-[color:var(--color-brand-bg)] px-2 py-2">
                      <div className="col-span-6 sm:col-span-3">
                        <Label
                          htmlFor={`clinic_fee__${s.id}`}
                          className="text-[10px]"
                        >
                          Clinic fee
                        </Label>
```

Insert immediately after the opening `<div ...px-2 py-2">` and before the Clinic-fee `<div>`:

```tsx
                      <div className="col-span-12 sm:col-span-4">
                        <Label
                          htmlFor={`consult_fee__${s.id}`}
                          className="text-[10px]"
                        >
                          Consultation fee (₱)
                        </Label>
                        <input
                          id={`consult_fee__${s.id}`}
                          name={`consult_fee__${s.id}`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={ls.consultFee}
                          onChange={(e) =>
                            updateLine(s.id, { consultFee: e.target.value })
                          }
                          placeholder="amount"
                          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 font-mono text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
                        />
                      </div>
```

(The existing `clinicFeeDefault`/`doctorPfDefault` already use `defaultClinicFee` + `final`, so once the fee is typed they recompute correctly.)

- [ ] **Step 5: Typecheck, lint, and visually verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS.
Then `npm run dev`, open `/staff/visits/new?patient_id=<a real id>`, Doctor tab: select **Consultation**, confirm a "Consultation fee" field appears, typing 500 updates the line Final + the visit Total, and the picker shows "priced at counter". Verify at 390×844 (mobile) too.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx"
git commit -m "feat(visits): manual consultation fee input on the new-visit form"
```

### Task A4: Admin Prices — show consultation as "priced at counter"

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/prices/prices-table.tsx`

- [ ] **Step 1: Read the file to find the price cell/editor**

Run: open `prices-table.tsx`. Locate where each service row renders its editable `price_php` cell (search for `price_php`).

- [ ] **Step 2: Render consultation rows read-only**

For rows where `service.kind === "doctor_consultation"`, replace the editable price input with static text "priced at counter". Concretely, wrap the price-input cell:

```tsx
{service.kind === "doctor_consultation" ? (
  <span className="text-xs text-[color:var(--color-brand-text-soft)]">
    priced at counter
  </span>
) : (
  /* existing price input/editor JSX, unchanged */
)}
```

(If the table also renders `hmo_price_php` / `senior_discount_php` editors, apply the same guard to those cells for consultation rows.)

- [ ] **Step 3: Typecheck, lint, verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Open `/staff/admin/prices`, confirm the `CONSULT` row shows "priced at counter" with no editable price, and other services are unchanged. (Deactivated `CONSULT_*` rows won't show if the table filters `is_active`; if it shows inactive rows, they should also display "priced at counter".)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/prices/prices-table.tsx"
git commit -m "feat(admin): show consultations as priced-at-counter"
```

---

## Phase B — Two-visit split

### Task B1: Pure order-partition module (TDD)

**Files:**
- Create: `src/lib/visits/order-lines.ts`
- Test: `src/lib/visits/order-lines.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/visits/order-lines.test.ts
import { describe, it, expect } from "vitest";
import { isDoctorKind, partitionByCategory, shouldSplit } from "./order-lines";

const line = (id: string, kind: string) => ({ id, kind });

describe("isDoctorKind", () => {
  it("classifies doctor kinds", () => {
    expect(isDoctorKind("doctor_consultation")).toBe(true);
    expect(isDoctorKind("doctor_procedure")).toBe(true);
  });
  it("treats everything else as non-doctor", () => {
    expect(isDoctorKind("lab_test")).toBe(false);
    expect(isDoctorKind("lab_package")).toBe(false);
    expect(isDoctorKind("home_service")).toBe(false);
    expect(isDoctorKind("vaccine")).toBe(false);
  });
});

describe("partitionByCategory", () => {
  it("splits lines into doctor and lab buckets, preserving order", () => {
    const lines = [
      line("a", "lab_test"),
      line("b", "doctor_consultation"),
      line("c", "lab_package"),
      line("d", "doctor_procedure"),
    ];
    const { doctor, lab } = partitionByCategory(lines, (l) => l.kind);
    expect(doctor.map((l) => l.id)).toEqual(["b", "d"]);
    expect(lab.map((l) => l.id)).toEqual(["a", "c"]);
  });
});

describe("shouldSplit", () => {
  it("is true only when both buckets are non-empty", () => {
    expect(shouldSplit([line("a", "lab_test"), line("b", "doctor_consultation")], (l) => l.kind)).toBe(true);
  });
  it("is false for doctor-only", () => {
    expect(shouldSplit([line("b", "doctor_consultation")], (l) => l.kind)).toBe(false);
  });
  it("is false for lab-only", () => {
    expect(shouldSplit([line("a", "lab_test")], (l) => l.kind)).toBe(false);
  });
  it("is false for an empty order", () => {
    expect(shouldSplit([], (l) => l.kind)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/visits/order-lines.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/visits/order-lines.ts
// Pure classification of reception order lines into the two billing
// categories: Doctor / Professional Fee vs Lab & Services. No server-only
// imports — unit-testable.

const DOCTOR_KINDS = new Set(["doctor_consultation", "doctor_procedure"]);

/** True for doctor consultation/procedure kinds; everything else is Lab & Services. */
export function isDoctorKind(kind: string): boolean {
  return DOCTOR_KINDS.has(kind);
}

/** Partition items into doctor/lab buckets, preserving input order in each. */
export function partitionByCategory<T>(
  items: T[],
  kindOf: (item: T) => string,
): { doctor: T[]; lab: T[] } {
  const doctor: T[] = [];
  const lab: T[] = [];
  for (const item of items) {
    if (isDoctorKind(kindOf(item))) doctor.push(item);
    else lab.push(item);
  }
  return { doctor, lab };
}

/** A split is warranted only when the order spans BOTH categories. */
export function shouldSplit<T>(items: T[], kindOf: (item: T) => string): boolean {
  const { doctor, lab } = partitionByCategory(items, kindOf);
  return doctor.length > 0 && lab.length > 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/visits/order-lines.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/visits/order-lines.ts src/lib/visits/order-lines.test.ts
git commit -m "feat(visits): pure order-line partition helper"
```

### Task B2: Group-keyed PIN flash

**Files:**
- Modify: `src/lib/auth/visit-pin-flash.ts`

- [ ] **Step 1: Generalize the flash to support a group key**

Replace the `FlashPayload` interface and `peekVisitPinFlash` with a version that carries an optional `group_id`, and add a group peek. Find:

```ts
interface FlashPayload {
  visit_id: string;
  pin: string;
}
```

Replace with:

```ts
interface FlashPayload {
  // For a standalone visit, visit_id is set. For a split encounter, group_id
  // is set (the combined receipt is keyed by visit_group_id).
  visit_id?: string;
  group_id?: string;
  pin: string;
}
```

Then add, after `peekVisitPinFlash`:

```ts
// Read-only — safe in Server Components. Matches a split-encounter flash by
// its visit_group_id.
export async function peekVisitGroupPinFlash(
  groupId: string,
): Promise<string | null> {
  const c = await cookies();
  const raw = c.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FlashPayload;
    if (parsed.group_id !== groupId) return null;
    return parsed.pin;
  } catch {
    return null;
  }
}
```

`setVisitPinFlash` already accepts a `FlashPayload`, so `setVisitPinFlash({ group_id, pin })` now type-checks with no further change. `peekVisitPinFlash` reads `parsed.visit_id` which is now optional — it still returns the pin only when `visit_id` matches, so standalone behavior is unchanged.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/auth/visit-pin-flash.ts
git commit -m "feat(auth): support group-keyed visit PIN flash"
```

### Task B3: Action — create two visits with a shared PIN, group link, per-section HMO, rollback

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`

> This is the core refactor. We (1) parse per-section HMO, (2) compute per-line HMO by category, (3) extract a `createOneVisit` helper that creates a visit + its test_requests (with package decomposition) and returns its id, (4) orchestrate one-or-two visits with a shared PIN and best-effort rollback.

- [ ] **Step 1: Update the validation Schema for per-section HMO**

Replace the HMO fields in `Schema` (lines ~48–59). Find:

```ts
const Schema = z.object({
  patient_id: z.string().uuid("Pick a valid patient."),
  service_ids: z
    .array(z.string().uuid())
    .min(1, "Select at least one service."),
  hmo_provider_id: optionalUuid,
  hmo_approval_date: optionalDate,
  hmo_authorization_no: optionalText(80),
  receptionist_remarks: optionalText(40),
  notes: z.string().trim().max(2000).optional(),
  attending_physician_id: optionalUuid,
});
```

Replace with:

```ts
const Schema = z.object({
  patient_id: z.string().uuid("Pick a valid patient."),
  service_ids: z
    .array(z.string().uuid())
    .min(1, "Select at least one service."),
  // Per-section HMO: doctor lines and lab lines each carry their own provider.
  doctor_hmo_provider_id: optionalUuid,
  doctor_hmo_approval_date: optionalDate,
  doctor_hmo_authorization_no: optionalText(80),
  lab_hmo_provider_id: optionalUuid,
  lab_hmo_approval_date: optionalDate,
  lab_hmo_authorization_no: optionalText(80),
  receptionist_remarks: optionalText(40),
  notes: z.string().trim().max(2000).optional(),
  attending_physician_id: optionalUuid,
});
```

Update the `safeParse` argument (lines ~71–80) to read the new fields:

```ts
  const parsed = Schema.safeParse({
    patient_id: formData.get("patient_id"),
    service_ids: formData.getAll("service_ids"),
    doctor_hmo_provider_id: formData.get("doctor_hmo_provider_id"),
    doctor_hmo_approval_date: formData.get("doctor_hmo_approval_date"),
    doctor_hmo_authorization_no: formData.get("doctor_hmo_authorization_no"),
    lab_hmo_provider_id: formData.get("lab_hmo_provider_id"),
    lab_hmo_approval_date: formData.get("lab_hmo_approval_date"),
    lab_hmo_authorization_no: formData.get("lab_hmo_authorization_no"),
    receptionist_remarks: formData.get("receptionist_remarks"),
    notes: formData.get("notes") ?? "",
    attending_physician_id: formData.get("attending_physician_id"),
  });
```

- [ ] **Step 2: Compute per-line HMO by category and carry `kind` on each line**

Add the imports near the top:

```ts
import { isDoctorKind, partitionByCategory } from "@/lib/visits/order-lines";
```

In the `lines` map, the line currently keys HMO off the single `hmoSelected`. Replace `const hmoSelected = parsed.data.hmo_provider_id !== null;` (line ~102) with per-category booleans:

```ts
  const doctorHmoSelected = parsed.data.doctor_hmo_provider_id !== null;
  const labHmoSelected = parsed.data.lab_hmo_provider_id !== null;
```

Inside the `.map`, compute the line's HMO from its kind. Find the `base` block from Task A2 Step 2 and change its non-consultation branch to use the per-category flag:

```ts
    const lineHmoSelected = isDoctorKind(s.kind) ? doctorHmoSelected : labHmoSelected;
    const base =
      s.kind === "doctor_consultation"
        ? Number.isFinite(consultFee) && consultFee >= 0
          ? consultFee
          : 0
        : lineHmoSelected && hmoPrice != null
          ? hmoPrice
          : cashPrice;
```

Add `kind: s.kind` to the returned line object (the `return { service_id, base_price_php: base, ... }` near line 176):

```ts
    return {
      service_id,
      kind: s.kind,
      base_price_php: base,
      discount_kind,
      discount_amount_php,
      final_price_php,
      clinic_fee_php,
      doctor_pf_php,
      procedure_description,
      hmo_approved_amount_php,
    };
```

- [ ] **Step 3: Extract a `createOneVisit` helper**

Add this helper near the bottom of the file (after `createVisitAction`, before the Phase-14 helpers). It encapsulates one visit's creation — visit row + package decomposition + test_requests — and returns the new visit's id/number plus the decomposition audit data. It throws on error so the orchestrator can roll back.

```ts
interface VisitHmo {
  hmo_provider_id: string | null;
  hmo_approval_date: string | null;
  hmo_authorization_no: string | null;
}

interface OneVisitInput {
  patientId: string;
  createdBy: string;
  lines: Array<{
    service_id: string;
    kind: string;
    base_price_php: number;
    discount_kind: string | null;
    discount_amount_php: number;
    final_price_php: number;
    clinic_fee_php: number | null;
    doctor_pf_php: number | null;
    procedure_description: string | null;
    hmo_approved_amount_php: number | null;
  }>;
  services: Array<{ id: string; kind: string; code: string; name: string }>;
  hmo: VisitHmo;
  attendingPhysicianId: string | null;
  receptionistRemarks: string | null;
  notes: string | null;
  visitGroupId: string | null;
}

interface OneVisitResult {
  visitId: string;
  visitNumber: string;
  decompositions: PackageDecomposition[];
  headerIdsForAudit: Array<string | null>;
}

// Creates a single visit and all its test_requests (incl. package
// decomposition). Throws Error on any failure; the caller rolls back.
async function createOneVisit(
  supabase: SupabaseClient<Database>,
  input: OneVisitInput,
): Promise<OneVisitResult> {
  const totalPhp = input.lines.reduce((sum, l) => sum + l.final_price_php, 0);

  const { data: visit, error: visitErr } = await supabase
    .from("visits")
    .insert({
      patient_id: input.patientId,
      total_php: totalPhp,
      notes: input.notes,
      created_by: input.createdBy,
      hmo_provider_id: input.hmo.hmo_provider_id,
      hmo_approval_date: input.hmo.hmo_approval_date,
      hmo_authorization_no: input.hmo.hmo_authorization_no,
      attending_physician_id: input.attendingPhysicianId,
      visit_group_id: input.visitGroupId,
    })
    .select("id, visit_number")
    .single();
  if (visitErr || !visit) {
    throw new Error(visitErr?.message ?? "Could not create visit.");
  }

  const decompositionResult = await loadPackageDecompositionsForLines(
    supabase,
    input.lines,
    input.services,
  );
  if (!decompositionResult.ok) {
    await deleteVisitCascade(supabase, visit.id);
    throw new Error(decompositionResult.error);
  }
  const decompositions = decompositionResult.decompositions;
  const packageServiceIds = new Set(decompositions.map((d) => d.headerLine.service_id));

  const headerRows = input.lines
    .filter((l) => packageServiceIds.has(l.service_id))
    .map((l) => ({
      visit_id: visit.id,
      service_id: l.service_id,
      requested_by: input.createdBy,
      base_price_php: l.base_price_php,
      discount_kind: l.discount_kind,
      discount_amount_php: l.discount_amount_php,
      final_price_php: l.final_price_php,
      hmo_provider_id: input.hmo.hmo_provider_id,
      hmo_approval_date: input.hmo.hmo_approval_date,
      hmo_authorization_no: input.hmo.hmo_authorization_no,
      receptionist_remarks: input.receptionistRemarks,
      clinic_fee_php: l.clinic_fee_php,
      doctor_pf_php: l.doctor_pf_php,
      procedure_description: l.procedure_description,
      hmo_approved_amount_php: l.hmo_approved_amount_php,
      is_package_header: true as const,
      status: "in_progress" as const,
    }));

  const standaloneRows = input.lines
    .filter((l) => !packageServiceIds.has(l.service_id))
    .map((l) => ({
      visit_id: visit.id,
      service_id: l.service_id,
      requested_by: input.createdBy,
      base_price_php: l.base_price_php,
      discount_kind: l.discount_kind,
      discount_amount_php: l.discount_amount_php,
      final_price_php: l.final_price_php,
      hmo_provider_id: input.hmo.hmo_provider_id,
      hmo_approval_date: input.hmo.hmo_approval_date,
      hmo_authorization_no: input.hmo.hmo_authorization_no,
      receptionist_remarks: input.receptionistRemarks,
      clinic_fee_php: l.clinic_fee_php,
      doctor_pf_php: l.doctor_pf_php,
      procedure_description: l.procedure_description,
      hmo_approved_amount_php: l.hmo_approved_amount_php,
      is_package_header: false as const,
    }));

  const headerRowsBySvcId = new Map<string, string[]>();
  if (headerRows.length > 0) {
    const headerInserts = await supabase
      .from("test_requests")
      .insert(headerRows)
      .select("id, service_id");
    if (headerInserts.error || !headerInserts.data) {
      await deleteVisitCascade(supabase, visit.id);
      throw new Error(`Failed to create package header rows: ${headerInserts.error?.message}`);
    }
    for (const row of headerInserts.data) {
      const arr = headerRowsBySvcId.get(row.service_id) ?? [];
      arr.push(row.id);
      headerRowsBySvcId.set(row.service_id, arr);
    }
  }

  const headerIdsForAudit: Array<string | null> = [];
  // Same explicit shape the original action used, so the mixed
  // [...standaloneRows, ...componentRows] insert keeps type-checking.
  const componentRows: Array<{
    visit_id: string;
    service_id: string;
    requested_by: string;
    base_price_php: number;
    discount_amount_php: number;
    final_price_php: number;
    hmo_provider_id: string | null;
    hmo_approval_date: string | null;
    hmo_authorization_no: string | null;
    parent_id: string;
    is_package_header: false;
  }> = [];
  for (const d of decompositions) {
    const headerIdQueue = headerRowsBySvcId.get(d.headerLine.service_id) ?? [];
    const headerId = headerIdQueue.shift();
    if (!headerId) {
      await deleteVisitCascade(supabase, visit.id);
      throw new Error(`Internal error: missing header row for service ${d.headerLine.service_id}`);
    }
    headerRowsBySvcId.set(d.headerLine.service_id, headerIdQueue);
    headerIdsForAudit.push(headerId);
    for (const componentServiceId of d.componentServiceIds) {
      componentRows.push({
        visit_id: visit.id,
        service_id: componentServiceId,
        requested_by: input.createdBy,
        base_price_php: 0,
        discount_amount_php: 0,
        final_price_php: 0,
        hmo_provider_id: input.hmo.hmo_provider_id,
        hmo_approval_date: input.hmo.hmo_approval_date,
        hmo_authorization_no: input.hmo.hmo_authorization_no,
        parent_id: headerId,
        is_package_header: false,
      });
    }
  }

  const allLeafRows = [...standaloneRows, ...componentRows];
  if (allLeafRows.length > 0) {
    const { error: leafErr } = await supabase.from("test_requests").insert(allLeafRows);
    if (leafErr) {
      await deleteVisitCascade(supabase, visit.id);
      throw new Error(`Visit created but tests failed: ${leafErr.message}`);
    }
  }

  return {
    visitId: visit.id,
    visitNumber: visit.visit_number,
    decompositions,
    headerIdsForAudit,
  };
}

// Best-effort cleanup. test_requests.visit_id has NO on-delete-cascade, so
// delete the lines first; visit_pins DOES cascade with the visit.
async function deleteVisitCascade(
  supabase: SupabaseClient<Database>,
  visitId: string,
): Promise<void> {
  await supabase.from("test_requests").delete().eq("visit_id", visitId);
  await supabase.from("visits").delete().eq("id", visitId);
}
```

- [ ] **Step 4: Replace the single-visit creation block with the split orchestrator**

In `createVisitAction`, replace everything from the original visit insert (line ~191, the comment `// Create the visit, including the HMO...`) through the final `redirect(...)` (line ~424) with the orchestration below. (The `lines`, `services`, `totalPhp`-per-visit, audit, and PIN are now handled here / in the helper.)

**First delete the now-unused `const totalPhp = lines.reduce(...)` line (~189)** — each visit's total is computed inside `createOneVisit`, so a top-level `totalPhp` is dead and will trip lint/`noUnusedLocals`.

```ts
  // Partition the order into the two billing categories.
  const { doctor: doctorLines, lab: labLines } = partitionByCategory(
    lines,
    (l) => l.kind,
  );
  const split = doctorLines.length > 0 && labLines.length > 0;

  const doctorHmo: VisitHmo = {
    hmo_provider_id: parsed.data.doctor_hmo_provider_id,
    hmo_approval_date: parsed.data.doctor_hmo_approval_date,
    hmo_authorization_no: parsed.data.doctor_hmo_authorization_no,
  };
  const labHmo: VisitHmo = {
    hmo_provider_id: parsed.data.lab_hmo_provider_id,
    hmo_approval_date: parsed.data.lab_hmo_approval_date,
    hmo_authorization_no: parsed.data.lab_hmo_authorization_no,
  };

  const servicesForDecomp = services.map((s) => ({
    id: s.id,
    kind: s.kind,
    code: s.code,
    name: s.name,
  }));

  // crypto.randomUUID is available in the Node runtime.
  const groupId = split ? crypto.randomUUID() : null;

  const created: OneVisitResult[] = [];
  try {
    if (split) {
      created.push(
        await createOneVisit(supabase, {
          patientId: parsed.data.patient_id,
          createdBy: session.user_id,
          lines: doctorLines,
          services: servicesForDecomp,
          hmo: doctorHmo,
          attendingPhysicianId: parsed.data.attending_physician_id ?? null,
          receptionistRemarks: parsed.data.receptionist_remarks,
          notes: parsed.data.notes ?? null,
          visitGroupId: groupId,
        }),
      );
      created.push(
        await createOneVisit(supabase, {
          patientId: parsed.data.patient_id,
          createdBy: session.user_id,
          lines: labLines,
          services: servicesForDecomp,
          hmo: labHmo,
          attendingPhysicianId: null,
          receptionistRemarks: parsed.data.receptionist_remarks,
          notes: parsed.data.notes ?? null,
          visitGroupId: groupId,
        }),
      );
    } else {
      // Single visit: all lines, the section's HMO, physician only if doctor.
      const onlyDoctor = doctorLines.length > 0;
      created.push(
        await createOneVisit(supabase, {
          patientId: parsed.data.patient_id,
          createdBy: session.user_id,
          lines: lines,
          services: servicesForDecomp,
          hmo: onlyDoctor ? doctorHmo : labHmo,
          attendingPhysicianId: onlyDoctor
            ? parsed.data.attending_physician_id ?? null
            : null,
          receptionistRemarks: parsed.data.receptionist_remarks,
          notes: parsed.data.notes ?? null,
          visitGroupId: null,
        }),
      );
    }
  } catch (err) {
    // Roll back anything created so we never leave an orphan visit / dead OR.
    for (const c of created) await deleteVisitCascade(supabase, c.visitId);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not create visit.",
    };
  }

  // One shared PIN across all created visits (portal is per-patient; login
  // matches the latest pin row). Same hash + expiry on every visit_pins row.
  const plainPin = generatePin();
  const pinHash = await hashPin(plainPin);
  const admin = createAdminClient();
  const { error: pinErr } = await admin
    .from("visit_pins")
    .insert(created.map((c) => ({ visit_id: c.visitId, pin_hash: pinHash })));
  if (pinErr) {
    for (const c of created) await deleteVisitCascade(supabase, c.visitId);
    return { ok: false, error: `Visit created but PIN failed: ${pinErr.message}` };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  for (const c of created) {
    const visitLines = split
      ? c.visitId === created[0]!.visitId
        ? doctorLines
        : labLines
      : lines;
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: parsed.data.patient_id,
      action: "visit.created",
      resource_type: "visit",
      resource_id: c.visitId,
      metadata: {
        visit_number: c.visitNumber,
        total_php: visitLines.reduce((s, l) => s + l.final_price_php, 0),
        service_count: visitLines.length,
        visit_group_id: groupId,
        discounted_lines: visitLines.filter((l) => l.discount_amount_php > 0).length,
      },
      ip_address: ip,
      user_agent: ua,
    });

    // One audit row per package decomposition on this visit.
    for (let i = 0; i < c.decompositions.length; i++) {
      const d = c.decompositions[i]!;
      const pkgService = services.find((s) => s.id === d.headerLine.service_id);
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: parsed.data.patient_id,
        action: "package.decomposed",
        resource_type: "test_request",
        resource_id: c.headerIdsForAudit[i] ?? null,
        metadata: {
          visit_id: c.visitId,
          package_service_id: d.headerLine.service_id,
          package_code: pkgService?.code ?? null,
          package_name: pkgService?.name ?? null,
          component_count: d.componentServiceIds.length,
          component_service_ids: d.componentServiceIds,
        },
        ip_address: ip,
        user_agent: ua,
      });
    }
  }

  if (split && groupId) {
    await setVisitPinFlash({ group_id: groupId, pin: plainPin });
    redirect(`/staff/visits/group/${groupId}/receipt`);
  } else {
    await setVisitPinFlash({ visit_id: created[0]!.visitId, pin: plainPin });
    redirect(`/staff/visits/${created[0]!.visitId}/receipt`);
  }
```

> Note: `redirect()` throws internally — keep it outside the try/catch (as above) so it isn't caught by the rollback handler.

- [ ] **Step 5: Typecheck + unit tests**

Run: `npm run typecheck && npm test`
Expected: PASS. If `crypto` is flagged, it is a Node global in the server runtime; no import needed. If lint complains, add `// eslint-disable-next-line` only where genuinely required.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/new/actions.ts"
git commit -m "feat(visits): split into two visits with shared PIN + rollback"
```

### Task B4: Form — per-section HMO selectors

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx`

> Replace the single visit-level HMO fieldset + single `hmoSelected` with a Doctor-section HMO and a Lab-section HMO. Lab lines price off the lab HMO; doctor procedures price off the doctor HMO; consultations are manual.

- [ ] **Step 1: Replace single HMO state with two**

Find:

```ts
  const [hmoProviderId, setHmoProviderId] = useState<string>("");
```

Replace with:

```ts
  const [doctorHmoProviderId, setDoctorHmoProviderId] = useState<string>("");
  const [labHmoProviderId, setLabHmoProviderId] = useState<string>("");
```

Find:

```ts
  const hmoSelected = hmoProviderId !== "";
```

Replace with:

```ts
  const doctorHmoSelected = doctorHmoProviderId !== "";
  const labHmoSelected = labHmoProviderId !== "";
  // Per-line HMO flag: doctor lines use the doctor HMO, lab lines the lab HMO.
  const hmoSelectedFor = (kind: string) =>
    DOCTOR_KINDS.has(kind) ? doctorHmoSelected : labHmoSelected;
```

- [ ] **Step 2: Use per-line HMO in price computations**

In the `lines` useMemo (the block edited in Task A3 Step 2), change the non-consultation base to use `hmoSelectedFor`:

```ts
        const base =
          s.kind === "doctor_consultation"
            ? (() => {
                const n = Number(ls.consultFee);
                return Number.isFinite(n) && n >= 0 ? n : 0;
              })()
            : basePriceFor(s, hmoSelectedFor(s.kind));
```

In the service picker (`visibleServices.map`), the `display`/`hmo` badge used the global `hmoSelected`. Replace `const display = basePriceFor(s, hmoSelected);` (from Task A3 Step 3) with:

```ts
            const isConsultPick = s.kind === "doctor_consultation";
            const lineHmoSelected = hmoSelectedFor(s.kind);
            const display = basePriceFor(s, lineHmoSelected);
```

and in that card's price span replace the two `hmoSelected` references with `lineHmoSelected`.

- [ ] **Step 3: Replace the HMO fieldset markup with two section selectors**

Delete the entire existing HMO `<fieldset>` (lines ~350–399, "HMO authorisation (optional)"). In its place, add a small reusable block twice — one for Lab, one for Doctor. Add this helper component at the bottom of the file (outside `VisitForm`):

```tsx
function HmoSection({
  legend,
  prefix,
  providers,
  value,
  onChange,
}: {
  legend: string;
  prefix: "doctor" | "lab";
  providers: { id: string; name: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = value !== "";
  return (
    <fieldset className="grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] p-4">
      <legend className="px-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {legend}
      </legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1 sm:col-span-3">
          <Label htmlFor={`${prefix}_hmo_provider_id`}>Provider</Label>
          <select
            id={`${prefix}_hmo_provider_id`}
            name={`${prefix}_hmo_provider_id`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          >
            <option value="">— Cash / no HMO —</option>
            {providers.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        {selected ? (
          <>
            <div className="grid gap-1">
              <Label htmlFor={`${prefix}_hmo_approval_date`}>Approval date</Label>
              <StableInput
                id={`${prefix}_hmo_approval_date`}
                name={`${prefix}_hmo_approval_date`}
                type="date"
              />
            </div>
            <div className="grid gap-1 sm:col-span-2">
              <Label htmlFor={`${prefix}_hmo_authorization_no`}>Authorization no.</Label>
              <StableInput
                id={`${prefix}_hmo_authorization_no`}
                name={`${prefix}_hmo_authorization_no`}
                maxLength={80}
                placeholder="e.g. ABC-123456"
              />
            </div>
          </>
        ) : null}
      </div>
    </fieldset>
  );
}
```

Render both where the old fieldset was:

```tsx
      <HmoSection
        legend="Lab & Services HMO (optional)"
        prefix="lab"
        providers={hmoProviders}
        value={labHmoProviderId}
        onChange={setLabHmoProviderId}
      />
      <HmoSection
        legend="Doctor / PF HMO (optional)"
        prefix="doctor"
        providers={hmoProviders}
        value={doctorHmoProviderId}
        onChange={setDoctorHmoProviderId}
      />
```

- [ ] **Step 4: Add a "this will create 2 receipts" hint (optional but recommended)**

Above the submit button, surface the split so reception isn't surprised. Add, before the `<div className="flex gap-3">` submit row:

```tsx
      {doctorSelectedCount > 0 && labSelectedCount > 0 ? (
        <p className="rounded-lg border border-dashed border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] px-3 py-2 text-xs text-[color:var(--color-brand-navy)]">
          This order has both Doctor and Lab &amp; Services items — it will create{" "}
          <strong>two visits and two receipts</strong> (one for the doctor&apos;s
          professional fee, one for lab &amp; services).
        </p>
      ) : null}
```

(Reuses the existing `doctorSelectedCount` / `labSelectedCount` memos. Update the helper text near line 411 that says "every selection is part of this one visit, receipt, and total" to: "Doctor and Lab & Services items are billed on separate receipts.")

- [ ] **Step 5: Typecheck, lint, verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS. In dev: a both-categories order shows two HMO sections + the two-receipts hint; selecting the Lab HMO swaps lab prices to HMO but leaves the typed consultation fee untouched; selecting the Doctor HMO swaps procedure prices. Check 390×844.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx"
git commit -m "feat(visits): per-section HMO + split hint on new-visit form"
```

### Task B5: Combined receipt route (two slips)

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/print-button.tsx`

- [ ] **Step 1: Create the print button (reuse the existing client component)**

```tsx
// .../visits/group/[groupId]/receipt/print-button.tsx
export { PrintButton } from "../../../[id]/receipt/print-button";
```

(If TS path resolution complains about the relative depth, import from the alias instead: `export { PrintButton } from "@/app/(staff)/staff/(dashboard)/visits/[id]/receipt/print-button";`.)

- [ ] **Step 2: Create the combined receipt page**

```tsx
// .../visits/group/[groupId]/receipt/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { peekVisitGroupPinFlash } from "@/lib/auth/visit-pin-flash";
import { formatPhp } from "@/lib/marketing/format";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { getPatientConsentState } from "@/lib/consent/gate";
import { PrintButton } from "./print-button";

export const metadata = { title: "Combined receipt — staff" };

interface Props {
  params: Promise<{ groupId: string }>;
}

const DOCTOR_KINDS = new Set(["doctor_consultation", "doctor_procedure"]);

export default async function GroupReceiptPage({ params }: Props) {
  const { groupId } = await params;
  const supabase = await createClient();

  const { data: visits } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, total_php, visit_group_id,
        patients!inner (
          id, drm_id, first_name, last_name,
          senior_pwd_id_kind, senior_pwd_id_number
        ),
        test_requests (
          id, base_price_php, discount_kind, discount_amount_php, final_price_php,
          services ( code, name, price_php, kind )
        )
      `,
    )
    .eq("visit_group_id", groupId)
    .order("visit_number", { ascending: true });

  if (!visits || visits.length === 0) notFound();
  const patient = Array.isArray(visits[0]!.patients)
    ? visits[0]!.patients[0]
    : visits[0]!.patients;
  if (!patient) notFound();

  const consent = await getPatientConsentState(patient.id);
  const plainPin = await peekVisitGroupPinFlash(groupId);

  // Order the slips: Doctor / PF first, then Lab & Services.
  const slips = visits
    .map((v) => {
      const lines = (v.test_requests ?? []).map((tr) => {
        const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
        const base = tr.base_price_php ?? svc?.price_php ?? 0;
        const discount = tr.discount_amount_php ?? 0;
        const final = tr.final_price_php ?? base - discount;
        return { id: tr.id, svc, base, discount, final, discountKind: tr.discount_kind };
      });
      const isDoctor = lines.some((l) => l.svc && DOCTOR_KINDS.has(l.svc.kind));
      return { visit: v, lines, isDoctor };
    })
    .sort((a, b) => Number(b.isDoctor) - Number(a.isDoctor));

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/visits/${visits[0]!.id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Visit
        </Link>
        <PrintButton hasFlash={Boolean(plainPin)} />
      </div>

      {slips.map((slip, idx) => {
        const subtotal = slip.lines.reduce((s, l) => s + Number(l.base), 0);
        const totalDiscount = slip.lines.reduce((s, l) => s + Number(l.discount), 0);
        const total = slip.lines.reduce((s, l) => s + Number(l.final), 0);
        const hasSeniorPwdLine = slip.lines.some((l) => l.discountKind === "senior_pwd_20");
        return (
          <article
            key={slip.visit.id}
            className={`rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 print:border-0 print:p-0 ${
              idx > 0 ? "mt-8 print:mt-0 print:break-before-page" : ""
            }`}
          >
            <header className="border-b border-[color:var(--color-brand-bg-mid)] pb-4">
              <p className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
                {SITE.name}
              </p>
              <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                {CONTACT.address.line1}, {CONTACT.address.line2}, {CONTACT.address.city}
              </p>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                {CONTACT.phone.mobile} · {CONTACT.phone.landline} · {CONTACT.email}
              </p>
              <p className="mt-2 inline-block rounded bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                {slip.isDoctor ? "Doctor / Professional Fee" : "Lab & Services"}
              </p>
            </header>

            <div className="grid gap-3 border-b border-[color:var(--color-brand-bg-mid)] py-4 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Patient
                </p>
                <p className="mt-0.5 font-semibold text-[color:var(--color-brand-navy)]">
                  {patient.last_name}, {patient.first_name}
                </p>
                <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                  {patient.drm_id}
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  Data privacy consent: {consent.current ? "on file" : "not on file"}
                </p>
              </div>
              <div className="sm:text-right">
                <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Visit
                </p>
                <p className="mt-0.5 font-semibold">#{slip.visit.visit_number}</p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {new Date(slip.visit.visit_date).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
                </p>
              </div>
            </div>

            <table className="w-full text-sm">
              <thead className="text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="py-3">Code</th>
                  <th className="py-3">Service</th>
                  <th className="py-3 text-right">Price</th>
                  <th className="py-3 text-right">Discount</th>
                  <th className="py-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {slip.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="py-3 font-mono">{l.svc?.code}</td>
                    <td className="py-3">{l.svc?.name}</td>
                    <td className="py-3 text-right">{formatPhp(l.base)}</td>
                    <td className="py-3 text-right">
                      {l.discount > 0 ? `− ${formatPhp(l.discount)}` : "—"}
                    </td>
                    <td className="py-3 text-right">{formatPhp(l.final)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-sm">
                <tr>
                  <td colSpan={4} className="pt-4 text-right text-[color:var(--color-brand-text-soft)]">
                    Subtotal
                  </td>
                  <td className="pt-4 text-right">{formatPhp(subtotal)}</td>
                </tr>
                {totalDiscount > 0 && (
                  <tr>
                    <td colSpan={4} className="pt-1 text-right text-[color:var(--color-brand-text-soft)]">
                      Discount
                      {hasSeniorPwdLine && patient.senior_pwd_id_number && (
                        <span className="ml-2 text-xs">
                          (Senior/PWD ID: {patient.senior_pwd_id_number})
                        </span>
                      )}
                    </td>
                    <td className="pt-1 text-right">− {formatPhp(totalDiscount)}</td>
                  </tr>
                )}
                <tr className="border-t-2 border-[color:var(--color-brand-navy)]">
                  <td colSpan={4} className="py-3 text-right font-bold">
                    Total Due
                  </td>
                  <td className="py-3 text-right font-[family-name:var(--font-heading)] text-xl font-extrabold">
                    {formatPhp(total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </article>
        );
      })}

      {/* One shared Patient Portal Access block for the whole encounter. */}
      <div className="mt-8 rounded-xl border-2 border-dashed border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-5 print:break-before-page">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Patient Portal Access
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">DRM-ID</p>
            <p className="font-mono text-lg font-extrabold text-[color:var(--color-brand-navy)]">
              {patient.drm_id}
            </p>
          </div>
          <div>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">Secure PIN</p>
            {plainPin ? (
              <p className="font-mono text-lg font-extrabold tracking-widest text-[color:var(--color-brand-navy)]">
                {plainPin}
              </p>
            ) : (
              <p className="text-sm text-[color:var(--color-brand-text-soft)]">
                Already viewed — re-issue from admin if needed.
              </p>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Sign in at <strong>{SITE.url.replace(/^https?:\/\//, "")}/portal</strong> to view
          results when ready. One PIN covers both receipts. Valid for 60 days.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck, lint, verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS. After Task B3 is live, create a both-categories visit; you should land on `/staff/visits/group/<id>/receipt` showing two slips (Doctor first) + one PIN block, and Print produces two pages. Verify the PIN shows once and the page works at 390×844.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/group"
git commit -m "feat(visits): combined two-slip group receipt"
```

### Task B6: Single-visit receipt → "Print combined receipt" link

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx`

- [ ] **Step 1: Select `visit_group_id` and add the link**

In the visit query (lines ~22–39), add `visit_group_id` to the selected columns:

```ts
        id, visit_number, visit_date, total_php, visit_group_id,
```

Then in the top action bar (the `print:hidden` div, lines ~67–75), add a combined-receipt link when grouped. Replace:

```tsx
        <PrintButton hasFlash={Boolean(plainPin)} />
```

with:

```tsx
        <div className="flex items-center gap-3">
          {visit.visit_group_id ? (
            <Link
              href={`/staff/visits/group/${visit.visit_group_id}/receipt`}
              className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
            >
              Print combined receipt →
            </Link>
          ) : null}
          <PrintButton hasFlash={Boolean(plainPin)} />
        </div>
```

- [ ] **Step 2: Typecheck, lint, verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Opening a split visit's own receipt shows the "Print combined receipt →" link; a standalone visit does not.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx"
git commit -m "feat(visits): link split-visit receipt to the combined view"
```

### Task B7: Visit-detail sibling cross-link

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx`

- [ ] **Step 1: Load the sibling visit**

In the page's data loading (near the top, after the main `visit` is fetched), add a sibling lookup. Find where the visit row is loaded (the `.from("visits").select(...)` for the detail page) and ensure `visit_group_id` is in its column list (add it if missing). Then add, after the visit is confirmed to exist:

```ts
  let sibling: { id: string; visit_number: string; is_doctor: boolean } | null = null;
  if (visit.visit_group_id) {
    const { data: sibs } = await supabase
      .from("visits")
      .select("id, visit_number, test_requests ( services ( kind ) )")
      .eq("visit_group_id", visit.visit_group_id)
      .neq("id", visit.id);
    const s = sibs?.[0];
    if (s) {
      const isDoctor = (s.test_requests ?? []).some((tr) => {
        const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
        return svc != null && (svc.kind === "doctor_consultation" || svc.kind === "doctor_procedure");
      });
      sibling = { id: s.id, visit_number: s.visit_number, is_doctor: isDoctor };
    }
  }
```

- [ ] **Step 2: Render the cross-link near the visit header**

Add a banner just below the page's visit header (place it wherever the visit number/title is rendered — search for `visit_number` in the JSX). Example:

```tsx
      {sibling ? (
        <p className="mt-2 rounded-lg border border-dashed border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] px-3 py-2 text-xs text-[color:var(--color-brand-navy)]">
          Part of the same patient visit as{" "}
          <Link
            href={`/staff/visits/${sibling.id}`}
            className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            #{sibling.visit_number} — {sibling.is_doctor ? "Doctor / PF" : "Lab & Services"} →
          </Link>
        </p>
      ) : null}
```

(Ensure `Link` is imported in this file; if not, add `import Link from "next/link";`.)

- [ ] **Step 3: Typecheck, lint, verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Both halves of a split encounter show a banner linking to the other; standalone visits show nothing.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx"
git commit -m "feat(visits): cross-link split-visit siblings on detail page"
```

---

## Phase C — "Mark consultation done" (release path so PF accrues)

### Task C1: `markConsultationDoneAction`

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts`

- [ ] **Step 1: Add the action**

Append to the file (after `releaseTestAction`). It releases a consultation line directly (`requested|in_progress → released`), captures `release_medium='other'` (no result delivery), translates the payment/P0034 gate errors, and audits — but does NOT call `notifyResultReleased` (a consultation has no portal result to announce).

```ts
export async function markConsultationDoneAction(
  testRequestId: string,
  visitId: string,
): Promise<ReleaseResult> {
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: "other",
    })
    .eq("id", testRequestId)
    .eq("visit_id", visitId);

  if (error) {
    // Payment gate (visit not paid) or P0034 (consult has no attending
    // physician) → friendly text.
    return { ok: false, error: translatePgError(error) };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "consultation.completed",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { visit_id: visitId },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts"
git commit -m "feat(visits): markConsultationDoneAction releases result-less consults"
```

### Task C2: "Mark consultation done" button

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/visits/[id]/mark-done-button.tsx`

- [ ] **Step 1: Create the client button (modeled on release-button.tsx)**

```tsx
// .../visits/[id]/mark-done-button.tsx
"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { markConsultationDoneAction } from "./actions";

interface Props {
  testRequestId: string;
  visitId: string;
  paid: boolean;
}

export function MarkDoneButton({ testRequestId, visitId, paid }: Props) {
  const [pending, start] = useTransition();
  const disabled = pending || !paid;
  const title = !paid ? "Visit must be paid before completing the consultation" : undefined;

  return (
    <Button
      type="button"
      size="sm"
      disabled={disabled}
      title={title}
      className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
      onClick={() =>
        start(async () => {
          const result = await markConsultationDoneAction(testRequestId, visitId);
          if (!result.ok) alert(result.error);
        })
      }
    >
      {pending ? "Saving…" : "Mark consultation done"}
    </Button>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/mark-done-button.tsx"
git commit -m "feat(visits): mark-consultation-done button"
```

### Task C3: Wire the button into the visit-detail action cell

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx`

- [ ] **Step 1: Pass `kind` to `TestAction`**

Add `kind` to `TestActionProps` (interface at lines ~740–749):

```ts
interface TestActionProps {
  status: string;
  testRequestId: string;
  visitId: string;
  paid: boolean;
  preferredMedium: "physical" | "email" | "viber" | "gcash" | "pickup" | null;
  consentOnFile: boolean;
  gateRequired: boolean;
  hasPdf?: boolean;
  kind: string;
}
```

At the call site (lines ~531–548), pass the service kind. `svc.kind` is already in scope (the row map computes `isConsult = svc.kind === "doctor_consultation"` at ~445). Add:

```tsx
                      <TestAction
                        status={t.status}
                        testRequestId={t.id}
                        visitId={visit.id}
                        paid={isPaid}
                        consentOnFile={consent.current}
                        gateRequired={gateRequired}
                        hasPdf={hasPdfByTrId.get(t.id) === true}
                        kind={svc.kind}
                        preferredMedium={
                          (patient.preferred_release_medium ?? null) as
                            | "physical"
                            | "email"
                            | "viber"
                            | "gcash"
                            | "pickup"
                            | null
                        }
                      />
```

- [ ] **Step 2: Render the mark-done button for consultations**

Import the button at the top of the file:

```ts
import { MarkDoneButton } from "./mark-done-button";
```

In the `TestAction` function, change the `requested`/`in_progress` branch (lines ~777–792) so a `doctor_consultation` line offers the mark-done button instead of "Open in queue" (a consultation never produces a result, so the queue is a dead end for it). Replace:

```tsx
  if (status === "requested" || status === "in_progress") {
    const hint = status === "requested" ? "Awaiting claim" : "Awaiting result";
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </span>
        <Link
          href={`/staff/queue/${testRequestId}`}
          className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          Open in queue →
        </Link>
      </div>
    );
  }
```

with:

```tsx
  if (status === "requested" || status === "in_progress") {
    if (kind === "doctor_consultation") {
      return <MarkDoneButton testRequestId={testRequestId} visitId={visitId} paid={paid} />;
    }
    const hint = status === "requested" ? "Awaiting claim" : "Awaiting result";
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </span>
        <Link
          href={`/staff/queue/${testRequestId}`}
          className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          Open in queue →
        </Link>
      </div>
    );
  }
```

- [ ] **Step 3: Typecheck, lint, verify end-to-end**

Run: `npm run typecheck && npm run lint`
Expected: PASS. In dev: create a visit with a consultation, record payment, then the consultation row shows "Mark consultation done" (disabled until paid). Click it → row flips to "Released ✓". Confirm in the DB that a `doctor_pf_entries` row + journal entry posted (cash visit → account 2110):

```bash
supabase db query "select pf_php, recognition_basis, journal_entry_id from public.doctor_pf_entries order by created_at desc limit 1;"
```
Expected: one row with the consultation's `doctor_pf_php` and `recognition_basis='cash_at_release'` (or `hmo_at_settlement` if the doctor visit had an HMO).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx"
git commit -m "feat(visits): mark-done button for consultation lines"
```

---

## Final verification

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 2: Manual smoke (mobile-first, 390×844)**

Walk these with `npm run dev`:
1. **Both categories →** save creates two visits (two sequential numbers, same hidden group), redirects to the combined receipt (Doctor slip first, Lab second, one PIN block). Print yields two slips.
2. **Two payments →** record a payment on each visit independently; each `payment_status` flips on its own (PF paid while lab still unpaid is representable).
3. **Mark consultation done →** after the doctor visit is paid, "Mark consultation done" releases the consult; `doctor_pf_entries` + JE post (2110 cash / 2160 with doctor HMO).
4. **Doctor-only / Lab-only →** single visit, `visit_group_id` null, the existing single receipt (no combined link).
5. **Manual fee →** consultation total is the typed amount; clinic_fee/doctor_pf default from the physician's arrangement and are editable.
6. **Mark done blocked before payment →** button disabled; forcing it server-side returns the translated payment-gate error.

- [ ] **Step 3: Push the branch & open a PR**

```bash
git push -u origin feat/split-visit-doctor-lab
gh pr create --fill --base main
```

- [ ] **Step 4: Apply migration 0090 to staging/prod**

Per project convention, the direct DB host is IPv6-only/unreachable locally — apply `0090` via the Supabase MCP (`execute_sql`) or the IPv4 pooler, record the `schema_migrations` row, then re-run `npm run db:types:remote` if needed. (See the `drmed-migrations` skill + the remote-DB-ops memory.)

---

## Notes for the implementer

- **Two auth systems, never merge.** Patients are not Supabase-authed; nothing here touches that. The shared PIN works because portal login is per-patient and matches the latest `visit_pins` row.
- **Payment-gating trigger is the source of truth.** Never force `status='released'` with the admin client; the gate fires for `markConsultationDoneAction` exactly as for normal release.
- **Atomicity:** we deliberately use app-code creation with explicit `deleteVisitCascade` rollback rather than a SQL RPC — replicating package decomposition in SQL isn't worth it, and the rollback (delete `test_requests` then the visit; `visit_pins` cascades) prevents orphan visits / dead OR numbers.
- **Don't hardcode prices.** Consultation price is now manual per line; everything else still reads `services`.
- **Verify booking is unaffected (spec §A4).** `/schedule` already hides doctor prices, and reception prices the consultation at the counter. Before merging, grep the appointment→visit path (the staff "+ New appointment" slide-over and any `createVisit`-from-appointment code) to confirm nothing auto-creates a *priced* consultation visit from a booking. If something does, route it through the same manual-fee flow.
- All Server Actions keep the `{ ok: true } | { ok: false, error }` shape.

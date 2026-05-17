# Phase 14 — Package decomposition

**Date:** 2026-05-17
**Status:** design-approved (pending user spec review)
**Supersedes:** none

---

## 1. Goal

When reception orders a `lab_package` service (e.g. EXECUTIVE_PACKAGE_STANDARD ₱5,888), the system shall create one billing header test_request that carries the package price, plus one component test_request for every service in the package's defined composition. Each component routes to its appropriate role queue (medtech for lab, xray_technician for imaging) and is claimed, finalised, and released independently. Patients see the package as a single grouped result in the portal, with both per-component PDFs and a consolidated package PDF available for download.

This replaces the prior behaviour where a package became a single test_request with a mixed `INCLUDED("CBC")` free-text template that no single role could fill in correctly.

## 2. Why this exists

The lab's price list bundles common test combinations as packages (Standard Chemistry, Executive Standard, Diabetic Health Package, etc.). Each package has:

- **A discounted price** (the bundle is cheaper than the sum of standalone components).
- **A defined set of component tests** spanning multiple workstations (chemistry, urinalysis, ECG, X-ray, ultrasound).
- **One billing line item** from the patient's and HMO's perspective.

Pre-Phase-14, a package order produced one test_request. The receptionist saw one line. The medtech opened the test and saw a structured form with rows like `INCLUDED("CBC")` — a free-text summary placeholder for tests not handled by their workstation. Imaging components (ECG, Chest X-Ray) appeared as the same `INCLUDED` rows, but the X-ray technologist never saw the test in their queue because the package's `section='package'` matches no role's filter. Either the medtech had to type free-text summaries for everything (losing structured data and PHI fidelity), or the imaging work went undocumented.

Phase 14 separates billing from work: the header carries billing; components carry work. Each component is a real test_request with its own template, its own queue placement, its own audit trail.

## 3. Locked decisions

The following design questions were answered in brainstorm 2026-05-16 / 2026-05-17:

| # | Question | Decision |
|---|---|---|
| Q1 | Pricing model when a package decomposes | Header + ₱0 components: header carries full package price; components have `final_price_php = 0`. |
| Q2 | Where do component definitions live | New table `package_components(package_service_id, component_service_id, sort_order)`. |
| Q3 | Existing in-flight package test_requests | Leave alone — Phase 14 applies to new orders only. Legacy rows finish via attrition. |
| Q4 | UI at order time | Inline expansion in new-visit form (reception sees components when adding a package) **and** expanded view on visit detail. |
| Q5 | Patient portal display | Consolidated PDF (one download per package) **and** individual component PDFs available on request. Render-on-request via `pdf-lib`; no cache for v1. |
| Q6 | Track package completion timestamp | Yes — add `test_requests.package_completed_at` on the header, set by a trigger when the last component releases (or cancels). Guard against re-set on amendments. |
| Q7 | Mixed-paid release behaviour | Inherits existing 12.2 all-or-nothing visit-level payment gate. Cancelling a test_request decrements `visits.total_php`, which can unblock release if a partial payment now matches the reduced total. |
| Q8 | Consolidated PDF cover page | Yes (premium) — but rendered via a new `'package_summary'` layout in the existing PDF machinery, parallelised with storage downloads to hide its render time. End-to-end target ≤ 3s. |

## 4. Architecture

### 4.1 Schema (migration 0040)

#### Table `package_components`

```sql
create table public.package_components (
  package_service_id   uuid not null references public.services(id) on delete cascade,
  component_service_id uuid not null references public.services(id) on delete restrict,
  sort_order           int  not null default 0,
  created_at           timestamptz not null default now(),
  primary key (package_service_id, component_service_id),
  constraint package_components_no_self_ref check (package_service_id <> component_service_id)
);

create index idx_package_components_pkg
  on public.package_components(package_service_id, sort_order);
```

**Behaviour:**

- `ON DELETE CASCADE` on the package side: if a package service is hard-deleted, its composition goes with it. Services are normally deactivated, not deleted, so this is defence-in-depth.
- `ON DELETE RESTRICT` on the component side: a component service cannot be deleted while any package references it. Forces admin to remove the row from `package_components` first, surfacing the dependency.
- `sort_order` controls the rendering order in the new-visit form, visit detail page, and consolidated PDF.

#### Columns on `test_requests`

```sql
alter table public.test_requests
  add column parent_id            uuid references public.test_requests(id) on delete cascade,
  add column is_package_header    boolean not null default false,
  add column package_completed_at timestamptz;
```

**Behaviour:**

- `parent_id`: NULL for headers and standalone test_requests; populated for components, pointing at the header.
- `is_package_header`: TRUE only on the header. Drives queue filtering, render-time branching (read-only summary instead of structured form), and patient portal grouping.
- `package_completed_at`: set by trigger when all sibling components have reached a terminal state (`released` or `cancelled`). NULL for components and for incomplete packages.

#### CHECK constraint

```sql
alter table public.test_requests
  add constraint test_requests_parent_shape_check check (
    (parent_id is null)
    or
    (parent_id is not null and is_package_header = false)
  );
```

A header cannot have a parent. A component cannot itself be a header.

#### Trigger — `parent_id` references a header

```sql
create or replace function public.fn_test_request_parent_is_header()
returns trigger language plpgsql as $$
declare
  v_parent_is_header boolean;
begin
  if new.parent_id is null then
    return new;
  end if;
  select is_package_header into v_parent_is_header
    from public.test_requests
    where id = new.parent_id;
  if v_parent_is_header is null then
    raise exception 'parent_id % does not exist', new.parent_id;
  end if;
  if v_parent_is_header = false then
    raise exception 'parent_id % must reference an is_package_header=true row', new.parent_id;
  end if;
  return new;
end;
$$;

create trigger tg_test_request_parent_is_header
  before insert or update of parent_id on public.test_requests
  for each row execute function public.fn_test_request_parent_is_header();
```

Prevents components from being chained (component → component) or attached to standalone test_requests. Defends against app-layer bugs.

#### Trigger — header auto-promote on insert

```sql
create or replace function public.fn_header_auto_promote()
returns trigger language plpgsql as $$
begin
  if new.is_package_header = true and new.status = 'in_progress' then
    new.status := 'ready_for_release';
  end if;
  return new;
end;
$$;

create trigger tg_header_auto_promote
  before insert on public.test_requests
  for each row execute function public.fn_header_auto_promote();
```

Headers have no work to claim. They skip from the initial `'in_progress'` directly to `'ready_for_release'` and wait for the existing 12.2 payment-gating trigger to flip them to `'released'`. No fake `signed_off_at` or `result_uploaded_at` timestamps.

#### Trigger — `package_completed_at` on last component release

```sql
create or replace function public.fn_set_package_completed_at()
returns trigger language plpgsql as $$
declare
  v_pending int;
begin
  -- Fire only when a component transitions to a terminal state.
  if new.parent_id is null then return new; end if;
  if new.status not in ('released', 'cancelled') then return new; end if;
  if old.status = new.status then return new; end if;

  -- Are any siblings still in a non-terminal state?
  select count(*) into v_pending
    from public.test_requests
    where parent_id = new.parent_id
      and status not in ('released', 'cancelled')
      and id <> new.id;

  if v_pending = 0 then
    update public.test_requests
      set package_completed_at = now()
      where id = new.parent_id
        and package_completed_at is null
        and status = 'released';
        -- `status = 'released'` guard: if the header was cancelled (cascade-
        -- cancel marked all components cancelled, which fires this trigger),
        -- we do NOT set package_completed_at — that timestamp records
        -- "package fully delivered with results", not "package terminal".
  end if;
  return new;
end;
$$;

create trigger tg_set_package_completed_at
  after update of status on public.test_requests
  for each row execute function public.fn_set_package_completed_at();
```

**Behaviour:**

- Cancelled components count as "complete enough" — otherwise a partial-cancellation package would never reach completion.
- The `IS NULL` guard means subsequent amendments to a component do not shift `package_completed_at`. The timestamp is "first completion", recorded once.

#### Trigger — cascade-cancel components when header cancels

```sql
create or replace function public.fn_cascade_cancel_components()
returns trigger language plpgsql as $$
begin
  if new.is_package_header = false then return new; end if;
  if new.status <> 'cancelled' then return new; end if;
  if old.status = 'cancelled' then return new; end if;

  update public.test_requests
    set status = 'cancelled',
        cancelled_reason = coalesce(cancelled_reason, 'package header cancelled')
    where parent_id = new.id
      and status not in ('released', 'cancelled');
  return new;
end;
$$;

create trigger tg_cascade_cancel_components
  after update of status on public.test_requests
  for each row execute function public.fn_cascade_cancel_components();
```

Cancelling a header cancels every still-claimable component beneath it. Already-released components keep their released state (the result is on file; cancelling the package retroactively is a billing-side action, not a clinical one).

#### Indexes

```sql
create index idx_test_requests_parent
  on public.test_requests(parent_id)
  where parent_id is not null;

create index idx_test_requests_pkg_header
  on public.test_requests(visit_id)
  where is_package_header = true;

create index idx_test_requests_completed
  on public.test_requests(package_completed_at)
  where package_completed_at is not null;
```

Partial indexes — small, only carry rows that matter.

### 4.2 Visit-creation flow

`src/app/(staff)/staff/(dashboard)/visits/new/actions.ts` handles new visit submission. After validation but before the `test_requests.insert(requestRows)` call (currently around lines 198–217), insert package-decomposition logic.

#### Detection signal

`service.kind = 'lab_package'` triggers decomposition. Non-package kinds (`lab_test`, `doctor_consultation`, `doctor_procedure`) follow the existing single-row path.

#### Validation (pre-insert, blocking)

For each `lab_package` in the submission:

1. Query `package_components` for `package_service_id = service.id`. If the result is empty, reject the entire submission with:
   > `Package <name> has no components configured. Contact admin to set up its composition.`
2. Resolve each `component_service_id` to a `services` row. If any component service is `is_active = false`, reject the submission with:
   > `Package <name> references inactive component <code>. Contact admin to update its composition.`

Both checks run inside the existing services lookup; one extra query (`SELECT * FROM package_components JOIN services ON ...`).

#### Insert sequence (within the existing visit-creation transaction)

For each `lab_package` line, after the visit row exists:

1. **Insert header** — one row in `test_requests` with:
   - `service_id` = package service id
   - `is_package_header` = `true`
   - `parent_id` = NULL
   - `status` = `'in_progress'` (the trigger flips it to `'ready_for_release'`)
   - All pricing fields populated normally: `base_price_php`, `discount_kind`, `discount_amount_php`, `final_price_php`, `hmo_provider_id`, `hmo_approval_date`, `hmo_authorization_no`, `hmo_approved_amount_php`, `receptionist_remarks`
   - Capture the inserted `id` for the component inserts.

2. **Insert components** — one row per `package_components` entry, sorted by `sort_order`:
   - `service_id` = component service id
   - `is_package_header` = `false`
   - `parent_id` = header's id (from step 1)
   - `status` = `'in_progress'`
   - `final_price_php` = `0`, `base_price_php` = `0`, `discount_amount_php` = `0`
   - HMO metadata copied from the header: `hmo_provider_id`, `hmo_approval_date`, `hmo_authorization_no` (for traceability — the component is still part of an HMO-authorised order, even if it carries no billing weight)
   - `hmo_approved_amount_php` = `0` (component bears none of the HMO-approved amount)
   - `receptionist_remarks` = NULL (the header carries the order-level remark)

3. **Audit row** — one `package.decomposed` audit entry with metadata:
   ```json
   {
     "visit_id": "<uuid>",
     "package_service_id": "<uuid>",
     "package_code": "EXECUTIVE_PACKAGE_STANDARD",
     "package_name": "Executive Package - Standard",
     "component_count": 12,
     "component_codes": ["CBC_PC", "URINALYSIS", "FBS_RBS", ..., "XRAY_CHEST_PA_LAT_ADULT"]
   }
   ```

#### Standalone services in the same submission

Non-`lab_package` services in the same submission insert via the existing single-row path, alongside the package's decomposition. The visit ends up with: N header rows (one per package) + N×(~10) component rows + M standalone rows.

#### Transaction boundary

The entire flow (visit insert + header inserts + component inserts + audit inserts) wraps in a single Postgres transaction via Supabase's chained inserts. Any single failure rolls back the whole submission. The existing visit-creation action already uses this pattern; we extend it.

### 4.3 Queue routing & visit detail rendering

#### Queue page (`/staff/queue`)

`src/app/(staff)/staff/(dashboard)/queue/page.tsx`. Existing filters: `status` ∈ claimable values AND `services.section` ∈ `sectionsForRole(role)`. Phase 14 adds one clause:

```ts
.eq("is_package_header", false)
```

Headers have no work, never appear in any queue. Defense-in-depth: the claim Server Action also rejects any attempt to claim a `is_package_header = true` row with:
> `Package headers cannot be claimed — they have no work.`

#### Role-section map (`src/lib/auth/role-sections.ts`)

**No change.** Headers are filtered out by the flag, not by section. The existing role lists remain:
- medtech: `chemistry, hematology, immunology, urinalysis, microbiology, send_out`
- xray_technician: `imaging_xray, imaging_ultrasound`
- admin / pathologist: unrestricted

#### Sign-off queue (`/staff/signoff`)

Pathologists today see rows where `signed_off_at IS NULL AND status='result_uploaded'`. Headers never reach `'result_uploaded'` — they sit at `'ready_for_release'` until payment then jump to `'released'`. They're automatically excluded.

#### Visit detail page (`/staff/visits/[id]`)

Renders test_requests grouped by `parent_id`:

```
EXECUTIVE PACKAGE - STANDARD                    ₱5,888  · paid · header
└─ 12 components (0 released)
   • CBC + PC                       medtech    ─ in_progress
   • Urinalysis                     medtech    ─ in_progress
   • FBS/RBS                        medtech    ─ in_progress
   • BUN                            medtech    ─ in_progress
   • Creatinine                     medtech    ─ in_progress
   • Cholesterol                    medtech    ─ in_progress
   • Triglycerides                  medtech    ─ in_progress
   • HDL/LDL/VLDL                   medtech    ─ in_progress
   • SGPT (ALT)                     medtech    ─ in_progress
   • SGOT (AST)                     medtech    ─ in_progress
   • 12-Lead ECG                    xray       ─ in_progress
   • Chest X-Ray PA/LAT (Adult)     xray       ─ in_progress

HBA1C (standalone)                              ₱720   · in_progress · medtech
```

**Render order within visit:** package headers (with their components nested beneath) first, then standalone test_requests.

Each component row is clickable and lands on `/staff/queue/[component_id]` (the existing component page). Each header row is clickable and lands on a read-only summary page (see § 4.3.1).

#### 4.3.1 Header click handling

If a user navigates to `/staff/queue/[header_id]` (from visit detail or direct link), the page detects `is_package_header = true` and renders a read-only **package summary** panel instead of the structured form:

- Header line: package name, status, control no., release timestamp
- List of components with their current status and link to each one's page
- Consolidated PDF download button (if header status = `released`)
- No form, no save buttons, no claim action

The existing `page.tsx` for the queue/claim view branches on `is_package_header` to render this alternative view.

#### 4.3.2 New-visit form inline expansion

In `src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx`, when reception adds a `lab_package` service to the line items, a fetch loads the package's components (server-side, via a new lightweight Server Action `getPackageComponentsAction(packageServiceId)`). Each component renders as a read-only indented row beneath the package:

```
[ Executive Package - Standard ─ ₱5,888 ]   [ Remove ]
   Includes:
     • CBC + PC
     • Urinalysis
     • FBS/RBS
     • BUN
     • Creatinine
     • Cholesterol
     • Triglycerides
     • HDL/LDL/VLDL
     • SGPT (ALT)
     • SGOT (AST)
     • 12-Lead ECG
     • Chest X-Ray PA/LAT (Adult)
```

Components cannot be individually removed or edited at order time. The package is ordered whole. If reception needs a different mix, they don't order the package — they pick standalone tests.

**Initial render optimisation:** the page eager-loads `package_components` for all active `lab_package` services in one query at page render. ~170 rows total across 17 packages = negligible. The fetch-per-package approach is the fallback if that ever balloons.

### 4.4 Patient portal grouping & consolidated PDF

#### Grouping in the portal page

`src/app/(patient)/portal/(authenticated)/page.tsx`. The existing query selects released test_requests for the patient. Phase 14 extends it to also load `parent_id` + `is_package_header`. Client-side grouping:

```ts
interface PortalRow {
  testRequestId: string;
  serviceName: string;
  releasedAt: string;
  storagePath: string;
  parentId: string | null;
  isPackageHeader: boolean;
}

function groupForPortal(rows: PortalRow[]): PortalCard[] {
  const headers = rows.filter((r) => r.isPackageHeader);
  const components = rows.filter((r) => r.parentId != null);
  const standalone = rows.filter((r) => r.parentId == null && !r.isPackageHeader);

  const packageCards: PortalCard[] = headers.map((h) => ({
    type: "package",
    header: h,
    components: components.filter((c) => c.parentId === h.testRequestId),
  }));

  const standaloneCards: PortalCard[] = standalone.map((s) => ({
    type: "standalone",
    test: s,
  }));

  return [...packageCards, ...standaloneCards];
}
```

#### Card display

Each package card shows:

```
EXECUTIVE PACKAGE - STANDARD                         15 May 2026
[ Download package result (PDF) ]    [ ⌃ Show individual results ]
   ↓ when expanded
   • CBC + PC                       [ Download ]
   • Urinalysis                     [ Download ]
   ... etc.
```

**Conditional rendering:**

- Show the package card only if the header is `status = 'released'` (visit paid) AND **at least one component is released**.
- The "Download package result" button is enabled only when **all** non-cancelled components are `released`.
- A tooltip explains "Available when all components are released" until ready.
- Cancelled components are listed below the others in a dimmed style with "Cancelled" instead of a download button. The consolidated PDF skips them.

#### Consolidated PDF endpoint

New Server Action in `src/app/(patient)/portal/(authenticated)/actions.ts`:

```ts
export async function getPackagePdfDownloadUrl(
  headerTestRequestId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
```

Behaviour:

1. Verify patient session via `getPatientSession()`.
2. Load the header test_request via the admin client. Validate:
   - `is_package_header = true`
   - `visit.patient_id = session.patient_id`
   - `status = 'released'`
3. Load all components: `SELECT * FROM test_requests WHERE parent_id = header.id`. Filter to those with `status = 'released'`. If any non-cancelled component is still in progress, return `{ ok: false, error: "Some components in this package are still in progress." }`.
4. **Parallel fetch** of each component's storage_path from the `results` bucket (`admin.storage.from('results').download(path)`).
5. **In parallel** with step 4: render the cover page via the new `'package_summary'` layout (see § 4.4.1).
6. Use `pdf-lib` to concatenate: cover page → each component's pages in `package_components.sort_order` order.
7. Audit-log `result.downloaded` once with `actor_type = 'patient'`, `metadata = { visit_id, header_test_request_id, merged_component_ids: [...], merge_page_count }`.
8. Return the merged PDF as a streaming `Response` from the Server Action. No temporary storage upload — keeps the wire format simple, no cache-invalidation worries, and 5 MB streaming responses are well within Vercel function limits (default 300s timeout, no explicit body-size cap for streamed responses).

**Performance target:** total wall-clock ≤ 3 seconds for a 12-component package (~5 MB merged PDF).

**Dependencies:** `pdf-lib` (new npm dep, ~80 KB gzipped, no native bindings). Adds one entry to `package.json`.

#### 4.4.1 `package_summary` PDF layout

Extends `src/lib/results/pdf-document.tsx`. Today there are 4 layouts (`simple`, `dual_unit`, `multi_section`, `imaging_report`). Add a 5th: `'package_summary'`.

The cover page reuses the existing letterhead + patient grid + section title machinery, then renders a body block listing included tests:

```
[DRMed letterhead]                                      [clinic address]
[Patient detail grid: CONTROL NO, DATE, NAME, etc.]

PACKAGE RESULT SUMMARY
EXECUTIVE PACKAGE - STANDARD

This package includes the following 12 test results:
  1. CBC + PC
  2. Urinalysis
  3. FBS/RBS
  4. BUN
  5. Creatinine
  6. Cholesterol
  7. Triglycerides
  8. HDL/LDL/VLDL
  9. SGPT (ALT)
 10. SGOT (AST)
 11. 12-Lead ECG
 12. Chest X-Ray PA/LAT (Adult)

[Signature block — pathologist / medtech / QC]
```

Implementation: one new `PackageSummaryBody` component in `pdf-document.tsx`, added to the layout switch. Renders the ordered component list. Reuses the same letterhead/patient/signature components.

### 4.5 Add-service-after-visit-creation

If a Server Action exists that lets reception add additional services to an existing visit after it was created (e.g., `addServiceToVisitAction` or similar), the same decomposition logic from § 4.2 must apply there. Implementation step: locate that flow during implementation. If it exists, patch it to call the same decomposition helper. If not, document its absence and move on.

The visit-creation action in `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts` is the only currently-known service-insertion path; if that's the only place, the implementation is single-shot.

### 4.6 Audit

- **Order:** one `package.decomposed` row per package decomposed in a submission (see § 4.2 step 3).
- **Component lifecycle:** standard per-component audit rows (`result.draft_saved`, `result.finalised`, `result.amended`, `result.released`, `result.viewed`, `result.downloaded`) flow unchanged. The audit_log reads naturally when grouped by parent_id (joins through test_requests).
- **Consolidated PDF download:** one `result.downloaded` row per merged-PDF request with `merged_component_ids: [...]` in metadata, distinguishing it from per-component downloads.
- **Cascade-cancel:** the cascade-cancel trigger doesn't emit its own audit row; each component's status change is captured via the existing test_request audit (if any) or relies on the `package.cancelled` audit emitted by whatever cancellation flow triggers the header.

## 5. Edge cases & invariants

### 5.1 Component amendment

A medtech amends a single component (transcription correction, value re-typed, etc.) via the existing structured-amendment flow (commit `e585d22`). The consolidated PDF reflects the amended component automatically next time it is requested (render-on-request). The header's `package_completed_at` is **not** modified — that timestamp records first completion only.

### 5.2 Component cancellation

If a component's sample is rejected or it can't be performed for clinical reasons, the existing test_request cancellation flow applies (status → `'cancelled'` with a reason). Cancellation is independent of the header and other components. The portal shows the cancelled component as dimmed and skips it in the consolidated PDF. The completion trigger treats cancelled components as terminal.

### 5.3 Header cancellation cascade

If the entire package is cancelled (wrong package ordered, patient withdrew, etc.), the header's status is set to `'cancelled'`. The cascade-cancel trigger (§ 4.1) then sets all non-released, non-cancelled components to `'cancelled'` as well. Released components keep their released state — the clinical record stands even if the package was retroactively cancelled.

### 5.4 Missing or inactive components

`package_components` is enforced non-empty at order time (§ 4.2). If admin deactivates a component service later, **already-issued** test_requests retain their references (no cascade). **New** orders for the affected package fail validation with a clear error to reception, who escalates to admin.

### 5.5 Mixed-paid visits (Q7 walkthrough)

Visit: Executive Package Standard ₱5,888 + standalone HBA1C ₱720. Total ₱6,608.

Patient pays ₱5,888 only. `visits.payment_status` = `'partial'`. Existing 12.2 payment-gating trigger blocks all release transitions in this visit (header, components, HBA1C).

HBA1C sample is rejected at draw → reception/medtech cancels HBA1C → existing total_php-recompute trigger drops it from the visit total → total now ₱5,888 = paid → `payment_status` flips to `'paid'` → release proceeds for header + all components.

**Acceptance criterion**: cancelling a test_request must decrement `visits.total_php`. This is presumed-working (12.2 already does it for voids); needs a confirmation smoke during implementation.

### 5.6 Header navigation guard

A user (admin, pathologist, or someone with a deep link) navigates to `/staff/queue/[header_id]`. The page detects `is_package_header = true` and renders the read-only package summary panel (§ 4.3.1). The structured form never renders for headers. The claim Server Action also rejects any attempt to claim a header.

### 5.7 Concurrent reception orders

Two receptionists creating different visits for the same patient at the same time is the existing race condition. Phase 14 doesn't change it — each visit-creation transaction is independent.

Within one visit, the visit-creation flow is single-threaded (one Server Action call). No intra-transaction concurrency to worry about.

### 5.8 HMO claim attribution

The 12.3 HMO AR subledger reads from `test_requests` joined to `payments`. The header carries `hmo_provider_id`, `hmo_authorization_no`, and `hmo_approved_amount_php` — these flow through the existing HMO claim machinery. Components have HMO metadata for traceability but contribute ₱0 to the claim line.

When an HMO submits a claim batch (12.3 admin UI), the header is the line item. If the HMO rejects the package, the rejection applies to the bundle, not to individual components. Components themselves have nothing to claim.

### 5.9 Existing legacy package test_requests

Per Q3, pre-Phase-14 single-row package test_requests stay as-is. The new code paths use `is_package_header = true` as the package indicator; legacy rows have `is_package_header = false` and `parent_id = NULL`, so they look like standalone test_requests to the new code. Their existing templates (with `INCLUDED()` rows) keep working. They flow through to release and disappear from active queues normally.

### 5.10 Result templates for packages

Existing `result_templates` rows for `lab_package` services stay in the database. They serve the legacy in-flight test_requests (§ 5.9). New-Phase-14 headers never render a template because `/staff/queue/[id]` branches on `is_package_header` before consulting the template. No deactivation, no migration.

### 5.11 Receipt template

The existing visit receipt template lists test_requests by `visit_id`. Need to verify (during implementation) that:

- Headers appear (with the package price)
- Components do **not** appear (₱0 lines would confuse patients and HMO billing reps)

Filter: `WHERE parent_id IS NULL`. Standalone test_requests have `parent_id IS NULL`, headers also have `parent_id IS NULL`, components have `parent_id` populated → filtered out.

Acceptance criterion in the implementation plan.

## 6. Migration & seed strategy

### 6.1 Migration `0040_package_decomposition.sql`

Schema: table + columns + check + 4 triggers + 3 indexes (all listed in § 4.1).

Pre-flight checks before applying to prod:
- `0011_accounting_capture.sql` and 12.2's bridge (`0030_*.sql`) are in place — required for the visit total_php recompute trigger that § 5.5 relies on.

### 6.2 Component seed `scripts/seed-package-components.ts`

New script (analogous to existing `seed-result-templates.ts`). Reads from a hardcoded `PACKAGE_COMPONENT_MAP` (extracted from the existing `PACKAGE_PANELS` in `seed-result-templates.ts`):

```ts
const PACKAGE_COMPONENTS: Record<string, string[]> = {
  STANDARD_CHEMISTRY: [
    "FBS_RBS", "BUN", "CREATININE", "BUA_URIC_ACID",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
  ],
  EXECUTIVE_PACKAGE_STANDARD: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "BUN", "CREATININE",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
    "ECG", "XRAY_CHEST_PA_LAT_ADULT",
  ],
  EXECUTIVE_PACKAGE_COMPREHENSIVE: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "BUN", "CREATININE",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
    "HBA1C", "BUA_URIC_ACID",
    "FECALYSIS", "ULTRASOUND_WHOLE_ABDOMEN",
    "ECG", "XRAY_CHEST_PA_LAT_ADULT",
  ],
  // ... etc for all 17 active packages
};
```

For each package:
1. Resolve `package_service_id` via `services.code = key`.
2. For each component code in the array, resolve `component_service_id`.
3. Insert into `package_components` with `sort_order` = array index, ON CONFLICT DO NOTHING (idempotent).
4. If any service code is not found, fail loud (do not silently skip).

Guarded by the existing env-guard (commit `1ef9b7b`); seed run order:

```bash
npm run seed:services
npm run seed:package-components   # NEW
npm run seed:templates
```

The `seed:package-components` runs between services (which creates the rows it references) and templates (which is independent of this).

`package.json` gets a new `"seed:package-components"` script entry.

### 6.3 Existing data

No backfill needed. Pre-Phase-14 package test_requests stay as legacy rows.

## 7. Hard rules

1. **One billing line per package, ₱0 components**. Header carries all pricing; components are accounting-neutral.
2. **`services.kind = 'lab_package'` is the decomposition trigger**. Not section, not name pattern.
3. **Packages must have at least one component to be orderable**. Validation at order time, blocking error otherwise.
4. **Headers never appear in any work queue**. `is_package_header = false` filter on every queue read. Claim Server Action also rejects header claims.
5. **`package_components` is non-recursive**. A component cannot itself be a package (no nested packages). Enforced by app-layer validation; if a future product requires nested packages, a Phase 14.x design adds it.
6. **HMO + discount fields live on the header only**. Components carry HMO metadata for traceability but contribute ₱0 to claims.
7. **Component release is independent**. Released components are visible to the patient as they release; the consolidated PDF waits until all components release.
8. **Cancelling a header cascades to non-released components**. Released components keep their state.
9. **`package_completed_at` records first completion only**. Subsequent amendments do not update it.
10. **Result_templates for package services are not modified**. Legacy in-flight test_requests keep their templates.

## 8. Risks

1. **`pdf-lib` failure on a malformed component PDF.** A corrupted source PDF crashes the merge. Mitigation: wrap each component-PDF load in a try/catch; if one fails, surface "Component X could not be added to the consolidated PDF" instead of failing the whole download. Per-component PDFs remain individually downloadable.

2. **Consolidated PDF render exceeds Vercel function timeout.** Default function timeout is 300s (per the Vercel platform knowledge update); a 12-component package at 5-10MB merged is well under that. Risk surfaces only for very large packages (50+ components, very large embedded images). Mitigation: emit a `package.consolidated_pdf_render_started` audit early; if the function times out, the audit shows the attempt. Patient can retry.

3. **Concurrent visit creation racing on `package_components` reads.** Eventual consistency on reads is fine — the components table changes rarely. The seed is idempotent. No race.

4. **Component template missing at finalise time.** A package component (e.g. CBC_PC) needs its template on file. The seed-templates job runs after seed-services and seed-package-components, so order matters. Document this in `package.json` script order.

5. **HMO claim batching during partial package state.** If only some components of an HMO-authorised package are released, the HMO subledger sees the header is `released` but only some components. The HMO claim is per-header — works correctly. Components don't appear in the claim.

6. **Cascade-cancel firing during a partial release.** If a header is cancelled after one component has already released (e.g. CBC results released, then the patient rescinds the package), the trigger cancels the in-progress components but the released one stays. Acceptable — that result is clinically valid. Refund logic at the visit level handles the money.

## 9. Acceptance criteria

Implementation-time smoke that proves the design works end-to-end:

1. **Order a package** via `/staff/visits/new` → 1 header + N components inserted in one transaction. Audit row present. Components route to correct queues by section.
2. **Header invisible in queues** — medtech queue does not list it; xray_technician queue does not list it.
3. **Component independence** — claim CBC_PC as medtech, claim XRAY_CHEST_PA_LAT_ADULT as xray_technician; both proceed simultaneously.
4. **Header status flow** — header starts `'in_progress'` then immediately `'ready_for_release'` (visible via SQL). Once visit paid, `'released'`.
5. **`package_completed_at` set on last release** — release the last non-cancelled component, observe `package_completed_at` populated on the header. Amend a component afterwards; observe `package_completed_at` unchanged.
6. **Cascade-cancel** — cancel a header; observe all non-released components → `'cancelled'`. Already-released components unchanged.
7. **Header navigation guard** — navigate to `/staff/queue/[header_id]`; read-only summary renders, not the structured form. Claim Server Action rejects.
8. **Visit detail nested render** — header with components indented; standalone test_requests below.
9. **Visit total math** — `visits.total_php` = sum of header prices + standalone prices. Components contribute ₱0.
10. **Patient portal grouping** — package card with `X of Y components released` shown; expanded view shows per-component download buttons; consolidated download disabled until Y = total non-cancelled.
11. **Consolidated PDF** — release all components, click "Download package result"; receive merged PDF with cover page + components in `sort_order`. Audit row `result.downloaded` with `merged_component_ids`.
12. **HMO claim** — HMO claim batch in 12.3 admin lists the header (₱5,888), not components. Verify `hmo_claim_items` (12.3 schema) shows one row per header, zero rows per ₱0 component. Confirm whatever filter the 12.3 batch-create action uses (`final_price_php > 0` or `is_send_out = false` or similar) naturally excludes components.
13. **Receipt** — visit receipt shows header line, no ₱0 component lines.
14. **Mixed-paid release (§ 5.5)** — Executive Package + HBA1C, partial pay (package only), cancel HBA1C, observe release proceeds.

## 10. Out of scope (for Phase 14, deferred to 14.x or later)

- Admin UI for editing `package_components` (edit via SQL or via Supabase Studio for v1).
- Per-test_request payment (today all payment is visit-level; if that ever changes, packages need re-evaluation).
- Consolidated PDF caching (render-on-request is fast enough for v1; cache layer can be added without API change).
- Nested packages (a package containing another package). Not a current product requirement.
- Bulk-finalise-all-my-components action for medtechs (medtech finalises components individually; future quality-of-life feature).
- Notification to patient when consolidated PDF becomes available (today the patient checks the portal; push notification is future).
- "Skip component" UX at order time (e.g., "patient already has a recent CBC"). Today reception cannot remove components from a package; if they want a different mix, they pick standalone services.
- Editable cover page (today the `'package_summary'` layout is hardcoded in `pdf-document.tsx`).

## 11. References

- 12.1 GL foundation: `docs/superpowers/specs/2026-05-11-12.1-gl-foundation-design.md`
- 12.2 Op→GL bridge: `docs/superpowers/specs/2026-05-13-12.2-op-gl-bridge-design.md` — payment-gating trigger
- 12.3 HMO AR subledger: `docs/superpowers/specs/2026-05-13-12.3-hmo-ar-subledger-design.md` — claim attribution
- Phase 13 structured results: `IMPLEMENTATION_PLAN.md` §13 — template machinery
- Structured amendment workflow: commit `e585d22`
- Reference PDF design: commit `8b32266` + `3b353cd`
- DualUnitBody input_type fix (unrelated, prerequisite for legacy packages to render): commit `bfa9dab`

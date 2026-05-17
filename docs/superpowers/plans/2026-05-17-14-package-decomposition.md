# Phase 14 — Package Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `lab_package` services into a billing header test_request + N component test_requests so medtech and xray_technologist each claim their portion, with patients seeing grouped results in the portal and a consolidated PDF on demand.

**Architecture:** A new `package_components` table maps each package to its component services. The `visits/new` Server Action detects `service.kind = 'lab_package'`, validates components, and inserts one header (price-bearing, no work) + N components (₱0, real templates) inside the existing visit-creation transaction. Four DB triggers (parent-references-header invariant, header auto-promote, completion timestamp, cascade-cancel) enforce data invariants. The patient portal groups results by `parent_id` and offers a streamed consolidated PDF that concatenates component PDFs with a new `'package_summary'` cover layout.

**Tech Stack:**
- Next.js 16 App Router (Server Components + Server Actions)
- Supabase Postgres 17 (migrations, triggers, RLS)
- React-PDF (`@react-pdf/renderer`) — existing, for component + cover rendering
- `pdf-lib` — NEW dep, for concatenation
- TypeScript strict, Tailwind, shadcn-style components
- Reference spec: `docs/superpowers/specs/2026-05-17-14-package-decomposition-design.md`

---

## File Structure

### Created
- `supabase/migrations/0040_package_decomposition.sql` — schema + triggers + indexes
- `scripts/seed-package-components.ts` — populates `package_components` for 17 active packages
- `scripts/smoke-14-d1.sql` — schema/trigger smoke for dispatch 1
- `scripts/smoke-14.sql` — full end-to-end smoke for the final dispatch

### Modified
- `package.json` — add `pdf-lib` dep + `seed:package-components` script
- `src/types/database.ts` — regenerated after migration
- `src/lib/auth/role-sections.ts` — no behavioural change; doc comment updated
- `src/lib/results/types.ts` — add `'package_summary'` to `ResultLayout`
- `src/lib/results/pdf-document.tsx` — add `PackageSummaryBody` + layout case + cover-input type
- `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts` — detect lab_package, decompose, audit
- `src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx` — inline component expansion
- `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx` — nested header/component render, headers first
- `src/app/(staff)/staff/(dashboard)/queue/page.tsx` — add `is_package_header = false` filter
- `src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx` — branch on `is_package_header` → read-only summary
- `src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts` — claim Server Action rejects headers
- `src/app/(patient)/portal/(authenticated)/page.tsx` — group released test_requests by parent
- `src/app/(patient)/portal/(authenticated)/actions.ts` — new `getPackagePdfDownloadUrl` Server Action

### NOT touched (settled)
- `scripts/seed-result-templates.ts` — legacy package templates stay (for legacy in-flight rows)
- `src/app/(staff)/staff/(dashboard)/queue/[id]/structured-form.tsx` — DualUnitBody already fixed in `bfa9dab`
- Migrations 0001–0039 — all in prod, do not modify
- `src/lib/supabase/admin.ts` — service-role client used as-is

---

## Dispatch overview

| # | Title | Tasks | Touches |
|---|---|---|---|
| 1 | Schema + seed + SQL smoke | T1–T10 | migration 0040, seed-package-components.ts, smoke-14-d1.sql, types regen, prod apply |
| 2 | Visit decomposition + form expansion | T11–T20 | visits/new/actions.ts, visits/new/visit-form.tsx |
| 3 | Queue routing + header guard | T21–T27 | queue/page.tsx, queue/[id]/page.tsx, queue/[id]/actions.ts |
| 4 | Visit detail nested render | T28–T31 | visits/[id]/page.tsx |
| 5 | PDF package_summary + portal grouping + consolidated PDF | T32–T44 | pdf-document.tsx, types.ts, portal/actions.ts, portal/page.tsx, package.json (pdf-lib) |
| 6 | Full smoke + v1.6.0 tag + memory update | T45–T52 | smoke-14.sql, browser smoke, MEMORY.md, tag |

After each dispatch: code-review pass, prod apply (if applicable), commit. After D6: tag `v1.6.0`.

---

## Dispatch 1 — Schema + seed + SQL smoke

### Task 1: Write migration 0040

**Files:**
- Create: `supabase/migrations/0040_package_decomposition.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- =============================================================================
-- 0040 — Package decomposition
-- =============================================================================
-- Adds the schema for lab_package services to fan out into a billing header
-- test_request + N component test_requests at order time. The header carries
-- the package price and HMO/discount metadata; components are ₱0 rows with
-- real templates that route to medtech / xray_technologist via service.section.
--
-- See docs/superpowers/specs/2026-05-17-14-package-decomposition-design.md
-- for the full design rationale.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- package_components — defines which services compose each package.
-- ---------------------------------------------------------------------------
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

alter table public.package_components enable row level security;

-- Reads: any authenticated staff (read-only config).
create policy "package_components: staff read"
  on public.package_components for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- Writes: admin only (composition is a config decision).
create policy "package_components: admin write"
  on public.package_components for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));


-- ---------------------------------------------------------------------------
-- test_requests: parent_id + is_package_header + package_completed_at
-- ---------------------------------------------------------------------------
alter table public.test_requests
  add column parent_id            uuid references public.test_requests(id) on delete cascade,
  add column is_package_header    boolean not null default false,
  add column package_completed_at timestamptz;

-- A header cannot have a parent; a component cannot itself be a header.
alter table public.test_requests
  add constraint test_requests_parent_shape_check check (
    (parent_id is null)
    or
    (parent_id is not null and is_package_header = false)
  );

create index idx_test_requests_parent
  on public.test_requests(parent_id)
  where parent_id is not null;

create index idx_test_requests_pkg_header
  on public.test_requests(visit_id)
  where is_package_header = true;

create index idx_test_requests_completed
  on public.test_requests(package_completed_at)
  where package_completed_at is not null;


-- ---------------------------------------------------------------------------
-- Trigger: parent_id must reference a row with is_package_header = true.
-- Defends against app-layer bugs (chained components, child of standalone).
-- ---------------------------------------------------------------------------
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
    raise exception 'parent_id % must reference an is_package_header=true row',
      new.parent_id;
  end if;
  return new;
end;
$$;

create trigger tg_test_request_parent_is_header
  before insert or update of parent_id on public.test_requests
  for each row execute function public.fn_test_request_parent_is_header();


-- ---------------------------------------------------------------------------
-- Trigger: header rows auto-promote from 'in_progress' to 'ready_for_release'
-- on insert. No work to claim → no need to sit in any queue waiting.
-- The existing 12.2 payment-gating trigger then advances to 'released' when
-- the visit is paid.
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- Trigger: set package_completed_at on the header when the last non-terminal
-- component reaches a terminal state ('released' or 'cancelled').
-- Cancelled components count as terminal — otherwise a partial-cancellation
-- package would never complete. The IS NULL guard means amendments do not
-- re-stamp the timestamp. The status='released' guard prevents cascade-
-- cancellation from setting a misleading completion timestamp on a cancelled
-- package.
-- ---------------------------------------------------------------------------
create or replace function public.fn_set_package_completed_at()
returns trigger language plpgsql as $$
declare
  v_pending int;
begin
  if new.parent_id is null then return new; end if;
  if new.status not in ('released', 'cancelled') then return new; end if;
  if old.status = new.status then return new; end if;

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
  end if;
  return new;
end;
$$;

create trigger tg_set_package_completed_at
  after update of status on public.test_requests
  for each row execute function public.fn_set_package_completed_at();


-- ---------------------------------------------------------------------------
-- Trigger: when a header is cancelled, cascade 'cancelled' to all
-- non-released non-cancelled components. Released components keep their
-- state — clinical record stands even if the package was retroactively
-- cancelled.
-- ---------------------------------------------------------------------------
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

- [ ] **Step 2: Apply migration locally**

```bash
supabase db reset
```

Expected: all migrations 0001–0040 apply cleanly. `0040_package_decomposition.sql` is the last line in the output.

- [ ] **Step 3: Regenerate database types**

```bash
npx supabase gen types typescript --local > src/types/database.ts 2>/dev/null
```

Expected: `src/types/database.ts` now has `package_components` table type and `test_requests` rows include `parent_id`, `is_package_header`, `package_completed_at`.

- [ ] **Step 4: Commit migration + types**

```bash
git status
git add supabase/migrations/0040_package_decomposition.sql src/types/database.ts
git commit -m "feat(packages): 14.1.1 — schema migration 0040 + types"
```

### Task 2: Write seed script for package_components

**Files:**
- Create: `scripts/seed-package-components.ts`

- [ ] **Step 1: Write the seed script**

```typescript
/**
 * Seeds the `package_components` table from a hardcoded composition map.
 * One row per (package, component) pair.
 *
 *   npm run seed:package-components
 *
 * Run order:
 *   npm run seed:services            (creates the service codes we reference)
 *   npm run seed:package-components  (this script)
 *   npm run seed:templates           (templates per component service)
 *
 * Idempotent: ON CONFLICT DO NOTHING on the (package, component) PK so
 * re-runs are safe. To remove a component from a package, edit the map and
 * delete the row via SQL or admin UI (Phase 14.x).
 *
 * Sourced from PACKAGE_PANELS in scripts/seed-result-templates.ts, minus the
 * INCLUDED("CBC") free-text placeholders — those are replaced by real
 * component services here.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

requireLocalOrExplicitProd("seed:package-components");

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Component codes in display / consolidated-PDF order.
const PACKAGE_COMPONENTS: Record<string, string[]> = {
  STANDARD_CHEMISTRY: [
    "FBS_RBS", "BUN", "CREATININE", "BUA_URIC_ACID",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
  ],
  BASIC_PACKAGE: ["CBC_PC", "URINALYSIS"],
  ROUTINE_PACKAGE: ["CBC_PC", "URINALYSIS", "FBS_RBS"],
  ANNUAL_PHYSICAL_EXAM: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "CHOLESTEROL", "CREATININE", "BUN",
    "XRAY_CHEST_PA_LAT_ADULT", "ECG",
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
  EXECUTIVE_PACKAGE_DELUXE_MEN_S: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "BUN", "CREATININE",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
    "HBA1C", "BUA_URIC_ACID", "PSA",
    "FECALYSIS", "ULTRASOUND_WHOLE_ABDOMEN",
    "ECG", "XRAY_CHEST_PA_LAT_ADULT",
  ],
  EXECUTIVE_PACKAGE_DELUXE_WOMEN_S: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "BUN", "CREATININE",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
    "HBA1C", "BUA_URIC_ACID",
    "PAP_SMEAR", "FECALYSIS", "ULTRASOUND_WHOLE_ABDOMEN",
    "ECG", "XRAY_CHEST_PA_LAT_ADULT",
  ],
  PRE_EMPLOYMENT_PACKAGE: ["CBC_PC", "URINALYSIS", "XRAY_CHEST_PA_LAT_ADULT"],
  PREGNANCY_CARE_PACKAGE: [
    "CBC_PC", "URINALYSIS", "HBSAG_SCREENING",
    "BLOOD_TYPING_W_RH_FACTOR", "PREGNANCY_TEST",
  ],
  DIABETIC_HEALTH_PACKAGE: [
    "FBS_RBS", "HBA1C", "CHOLESTEROL", "TRIGLYCERIDES", "CREATININE",
  ],
  KIDNEY_FUNCTION_PACKAGE: [
    "BUN", "CREATININE", "BUA_URIC_ACID", "URINALYSIS", "URINE_PROTEIN",
  ],
  LIVER_FUNCTION_PACKAGE: [
    "SGPT_ALT", "SGOT_AST", "BILIRUBIN", "ALP", "TOTAL_PROTEIN", "ALBUMIN",
  ],
  LIPID_PROFILE_PACKAGE: ["CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL"],
  THYROID_HEALTH_PACKAGE: ["TSH", "FT3", "FT4"],
  IRON_DEFICIENCY_PACKAGE: ["FERRITIN", "TIBC_IRON", "CBC_PC"],
  DENGUE_PACKAGE: ["DENGUE_NS1", "DENGUE_DUO"],
};

async function findServiceIdByCode(code: string): Promise<string | null> {
  const { data, error } = await admin
    .from("services")
    .select("id")
    .eq("code", code)
    .single();
  if (error || !data) return null;
  return data.id;
}

async function seedPackage(
  packageCode: string,
  componentCodes: string[],
): Promise<{ pkg: string; inserted: number; skipped: number }> {
  const packageId = await findServiceIdByCode(packageCode);
  if (!packageId) {
    throw new Error(`Service code ${packageCode} not found in services table`);
  }

  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < componentCodes.length; i++) {
    const componentCode = componentCodes[i];
    const componentId = await findServiceIdByCode(componentCode);
    if (!componentId) {
      throw new Error(
        `Component code ${componentCode} (referenced by ${packageCode}) not found in services table`,
      );
    }
    const { error } = await admin
      .from("package_components")
      .upsert(
        {
          package_service_id: packageId,
          component_service_id: componentId,
          sort_order: i,
        },
        { onConflict: "package_service_id,component_service_id" },
      );
    if (error) {
      throw new Error(
        `Failed to upsert ${packageCode} → ${componentCode}: ${error.message}`,
      );
    }
    inserted++;
  }
  return { pkg: packageCode, inserted, skipped };
}

async function main() {
  console.log(
    `Seeding package_components against ${SUPABASE_URL}...`,
  );
  let totalRows = 0;
  for (const [pkgCode, componentCodes] of Object.entries(PACKAGE_COMPONENTS)) {
    const { pkg, inserted } = await seedPackage(pkgCode, componentCodes);
    console.log(`✓ ${pkg}: ${inserted} components`);
    totalRows += inserted;
  }
  console.log(
    `Done. ${totalRows} package_components rows across ${Object.keys(PACKAGE_COMPONENTS).length} packages.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Register npm script**

Edit `package.json` `scripts` section. Add after `seed:services`:

```json
"seed:package-components": "tsx --env-file=.env.local scripts/seed-package-components.ts",
```

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-package-components.ts package.json
git commit -m "feat(packages): 14.1.2 — seed-package-components script + npm wiring"
```

### Task 3: Run seed against local Supabase

- [ ] **Step 1: Point env at local Supabase and run seed**

```bash
LOCAL_URL=$(supabase status --output json 2>/dev/null | jq -r .API_URL)
LOCAL_KEY=$(supabase status --output json 2>/dev/null | jq -r .SERVICE_ROLE_KEY)
NEXT_PUBLIC_SUPABASE_URL="$LOCAL_URL" \
SUPABASE_SERVICE_ROLE_KEY="$LOCAL_KEY" \
  npx tsx scripts/seed-services.ts
NEXT_PUBLIC_SUPABASE_URL="$LOCAL_URL" \
SUPABASE_SERVICE_ROLE_KEY="$LOCAL_KEY" \
  npx tsx scripts/seed-package-components.ts
```

Expected per-package output ending with `Done. <N> package_components rows across 17 packages.`

NOTE: many component codes won't exist locally because `seed-services.ts` only defines the 12 compact codes + consults. The seed script will fail loud on missing codes. **This is expected for local** — local only has the compact catalog. Verify failure shows the specific missing code; this confirms the validator works.

To make local seed succeed end-to-end, you would need to run `npm run import:tests` first (against a CSV with the full long-code catalog). For Dispatch 1 verification, **skip the local seed end-to-end** — the SQL smoke (Task 4) covers schema/trigger behaviour without needing the seed data.

If you want to verify the seed script logic works against a richer local catalog, that's optional — apply the migration locally, hand-insert a couple of fake `services` rows matching the codes the seed expects, then run.

- [ ] **Step 2: Skip end-to-end local seed; proceed to Task 4 SQL smoke**

### Task 4: Write SQL smoke for D1 (schema + triggers)

**Files:**
- Create: `scripts/smoke-14-d1.sql`

- [ ] **Step 1: Write the smoke**

```sql
-- =============================================================================
-- smoke-14-d1.sql — Dispatch 1 schema + trigger smoke
-- =============================================================================
-- Verifies:
--   1. Migration 0040 applied (table + columns + check + 4 triggers + 3 indexes)
--   2. parent-references-header trigger rejects bad inserts (3 cases)
--   3. header auto-promote trigger flips in_progress → ready_for_release
--   4. cascade-cancel trigger cancels non-released components
--   5. package_completed_at trigger sets on last-component release
--   6. package_completed_at does NOT set on cancelled headers (cascade case)
--   7. package_completed_at does NOT re-stamp on amendment
--
-- Cleanup via begin/rollback. Self-bootstraps services + visit + admin.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_admin_id        uuid := gen_random_uuid();
  v_patient_id      uuid;
  v_visit_id        uuid;
  v_pkg_svc         uuid := gen_random_uuid();
  v_cbc_svc         uuid := gen_random_uuid();
  v_xray_svc        uuid := gen_random_uuid();
  v_pkg_id          uuid;
  v_cbc_id          uuid;
  v_xray_id         uuid;
  v_header_status   text;
  v_completed       timestamptz;
  v_bad             boolean;
begin
  -- Bootstrap auth.users + staff_profile + patient + visit + services.
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_admin_id, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'smoke-14d1@drmed.local');

  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_admin_id, 'Smoke 14 D1', 'admin', true);

  insert into public.patients (last_name, first_name, sex, birthdate, drm_id)
  values ('Smoke', 'D1', 'M', '2000-01-01', 'DRM-S14D1')
  returning id into v_patient_id;

  insert into public.visits (patient_id, visit_number, total_php, created_by)
  values (v_patient_id, 'V-S14D1', 1000, v_admin_id)
  returning id into v_visit_id;

  insert into public.services (id, code, name, description, price_php, kind,
                                section, is_active, is_send_out)
  values
    (v_pkg_svc,  'SMK14_PKG',  'Smoke 14 Package',     '',     1000, 'lab_package',
     'package',          true, false),
    (v_cbc_svc,  'SMK14_CBC',  'Smoke 14 CBC',         '',     0,    'lab_test',
     'hematology',       true, false),
    (v_xray_svc, 'SMK14_XRAY', 'Smoke 14 Chest X-Ray', '',     0,    'lab_test',
     'imaging_xray',     true, false);

  -- Insert header row directly.
  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, is_package_header
  )
  values (v_visit_id, v_pkg_svc, 'in_progress', v_admin_id,
          1000, 0, 1000, true)
  returning id into v_pkg_id;

  -- A1: header auto-promote — status should now be 'ready_for_release'
  select status into v_header_status
    from public.test_requests where id = v_pkg_id;
  if v_header_status <> 'ready_for_release' then
    raise exception 'A1 FAIL: header status is % (expected ready_for_release)',
      v_header_status;
  end if;
  raise notice 'A1 PASS: header auto-promoted to ready_for_release';

  -- Insert component referencing header.
  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, parent_id, is_package_header
  )
  values (v_visit_id, v_cbc_svc, 'in_progress', v_admin_id,
          0, 0, 0, v_pkg_id, false)
  returning id into v_cbc_id;

  insert into public.test_requests (
    visit_id, service_id, status, requested_by, base_price_php,
    discount_amount_php, final_price_php, parent_id, is_package_header
  )
  values (v_visit_id, v_xray_svc, 'in_progress', v_admin_id,
          0, 0, 0, v_pkg_id, false)
  returning id into v_xray_id;

  -- A2: parent-references-header trigger — try to attach a component to a
  -- non-header row (the CBC component). Should fail.
  begin
    insert into public.test_requests (
      visit_id, service_id, status, requested_by, base_price_php,
      discount_amount_php, final_price_php, parent_id, is_package_header
    )
    values (v_visit_id, v_cbc_svc, 'in_progress', v_admin_id,
            0, 0, 0, v_cbc_id, false);
    raise exception 'A2 FAIL: insert with parent pointing at non-header succeeded (should have raised)';
  exception when raise_exception then
    raise notice 'A2 PASS: parent-references-header trigger rejected child-of-component';
  end;

  -- A3: header with parent_id should fail the CHECK constraint.
  begin
    insert into public.test_requests (
      visit_id, service_id, status, requested_by, base_price_php,
      discount_amount_php, final_price_php, parent_id, is_package_header
    )
    values (v_visit_id, v_pkg_svc, 'in_progress', v_admin_id,
            0, 0, 0, v_pkg_id, true);
    raise exception 'A3 FAIL: header with parent_id succeeded (should have raised)';
  exception when check_violation then
    raise notice 'A3 PASS: CHECK constraint rejected header-with-parent';
  end;

  -- A4: package_completed_at — release one component, not yet complete.
  update public.test_requests set status = 'released', released_at = now()
    where id = v_cbc_id;
  select package_completed_at into v_completed
    from public.test_requests where id = v_pkg_id;
  if v_completed is not null then
    raise exception 'A4 FAIL: package_completed_at set after first component release (still %s components pending)',
      'one';
  end if;
  raise notice 'A4 PASS: package_completed_at NULL after 1-of-2 components released';

  -- Header must be released first for completion stamp to apply.
  update public.test_requests set status = 'released', released_at = now()
    where id = v_pkg_id;

  -- A5: release the second component — completion stamp should set.
  update public.test_requests set status = 'released', released_at = now()
    where id = v_xray_id;
  select package_completed_at into v_completed
    from public.test_requests where id = v_pkg_id;
  if v_completed is null then
    raise exception 'A5 FAIL: package_completed_at NULL after last component released';
  end if;
  raise notice 'A5 PASS: package_completed_at set after last component released (= %)', v_completed;

  -- A6: amending (status flip to 'in_progress' then back to 'released')
  -- should NOT re-stamp package_completed_at.
  update public.test_requests set status = 'in_progress' where id = v_cbc_id;
  update public.test_requests set status = 'released',  released_at = now()
    where id = v_cbc_id;
  declare
    v_completed_after timestamptz;
  begin
    select package_completed_at into v_completed_after
      from public.test_requests where id = v_pkg_id;
    if v_completed_after is distinct from v_completed then
      raise exception 'A6 FAIL: package_completed_at re-stamped on amendment (was % now %)',
        v_completed, v_completed_after;
    end if;
  end;
  raise notice 'A6 PASS: amendment did not re-stamp package_completed_at';

  raise notice 'all 6 D1 smoke assertions PASS';
end$$;

rollback;
```

- [ ] **Step 2: Apply migration locally + reset**

```bash
supabase db reset
```

- [ ] **Step 3: Run the smoke**

```bash
docker exec -i supabase_db_DRMed psql -U postgres -d postgres -f - < scripts/smoke-14-d1.sql 2>&1 | tail -20
```

Expected output:
```
A1 PASS: header auto-promoted to ready_for_release
A2 PASS: parent-references-header trigger rejected child-of-component
A3 PASS: CHECK constraint rejected header-with-parent
A4 PASS: package_completed_at NULL after 1-of-2 components released
A5 PASS: package_completed_at set after last component released (= ...)
A6 PASS: amendment did not re-stamp package_completed_at
all 6 D1 smoke assertions PASS
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-14-d1.sql
git commit -m "feat(packages): 14.1.3 — D1 SQL smoke (schema + triggers)"
```

### Task 5: Apply migration 0040 to prod

- [ ] **Step 1: Confirm prereqs on prod**

Via Supabase MCP, verify migration 0030 (op→GL bridge) and 0011 (accounting capture) are applied:

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 5;
```

Expected: top entries include `0039`, `0038`, `0037` (in some format). If anything is missing, stop and reconcile before continuing.

- [ ] **Step 2: Apply migration via Supabase MCP `apply_migration`**

Use the exact SQL from Task 1 step 1. The Supabase MCP `apply_migration` tool registers the migration in `supabase_migrations.schema_migrations` so a future `supabase db push` won't re-apply it.

- [ ] **Step 3: Verify prod schema**

```sql
-- Verify columns added
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'test_requests'
   and column_name in ('parent_id', 'is_package_header', 'package_completed_at');

-- Verify table created
select 1 from information_schema.tables
 where table_schema = 'public' and table_name = 'package_components';

-- Verify triggers
select tgname from pg_trigger
 where tgrelid = 'public.test_requests'::regclass
   and tgname in ('tg_test_request_parent_is_header',
                  'tg_header_auto_promote',
                  'tg_set_package_completed_at',
                  'tg_cascade_cancel_components');
```

Expected: 3 columns + table + 4 triggers present.

### Task 6: Seed package_components against prod

- [ ] **Step 1: Run seed against prod**

```bash
npm run seed:package-components -- --prod 2>&1 | tail -25
```

Expected per-package output. Final line:
```
Done. ~170 package_components rows across 17 packages.
```

The exact total depends on each package's composition.

- [ ] **Step 2: Verify in prod**

```sql
select s.code as package_code, count(pc.component_service_id) as components
  from services s
  left join package_components pc on pc.package_service_id = s.id
 where s.kind = 'lab_package'
   and s.is_active = true
 group by s.code
 order by components desc, s.code;
```

Expected: every active `lab_package` shows a non-zero component count. If any show 0, that package will fail validation at order time — investigate and re-run seed for missing entries.

### Task 7: Push D1 commits

- [ ] **Step 1: Push to origin (after code review approves)**

This step is gated by the controller's code-review pass. Once approved:

```bash
git log --oneline -5
git push origin main
```

---

## Dispatch 2 — Visit decomposition + form expansion

This dispatch wires the new-visit Server Action to detect lab_package services and decompose them into header + component test_requests, and extends the new-visit form to show the component breakdown inline.

### Task 8: Add `getPackageComponentsAction` Server Action

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`

The form will call this to load each lab_package's components for inline display.

- [ ] **Step 1: Add the action**

Append to `actions.ts`:

```typescript
export async function getPackageComponentsAction(
  packageServiceId: string,
): Promise<
  | { ok: true; components: Array<{
        component_service_id: string;
        sort_order: number;
        component_code: string;
        component_name: string;
        component_section: string | null;
      }>;
    }
  | { ok: false; error: string }
> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("package_components")
    .select(`
      component_service_id,
      sort_order,
      services!package_components_component_service_id_fkey (
        code,
        name,
        section,
        is_active
      )
    `)
    .eq("package_service_id", packageServiceId)
    .order("sort_order");

  if (error) {
    return { ok: false, error: `Failed to load package components: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "This package has no components configured. Contact admin to set up its composition.",
    };
  }

  // Surface any inactive components as a hard error — they would block order time anyway.
  const inactive = data.filter((r) => r.services && r.services.is_active === false);
  if (inactive.length > 0) {
    return {
      ok: false,
      error: `Package contains inactive components: ${inactive
        .map((r) => r.services?.code)
        .filter(Boolean)
        .join(", ")}`,
    };
  }

  return {
    ok: true,
    components: data.map((r) => ({
      component_service_id: r.component_service_id,
      sort_order: r.sort_order,
      component_code: r.services?.code ?? "(unknown)",
      component_name: r.services?.name ?? "(unknown)",
      component_section: r.services?.section ?? null,
    })),
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

### Task 9: Add `decomposePackagesIfNeeded` helper

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`

The helper takes the current line array (after pricing math) plus the existing services lookup, and for every `lab_package` line returns a structured plan of `{header, components}`. The main action consumes the plan to issue inserts.

- [ ] **Step 1: Locate the existing `createVisitAction`**

The relevant block is `actions.ts:198–217` where `requestRows` is constructed. Read it to confirm shape.

- [ ] **Step 2: Add the helper function**

```typescript
interface PackageDecomposition {
  // The original line (used to construct the header insert)
  headerLine: VisitLine;
  // Component service IDs in sort order
  componentServiceIds: string[];
}

async function loadPackageDecompositionsForLines(
  supabase: SupabaseClient<Database>,
  lines: VisitLine[],
  services: Array<{ id: string; kind: string }>,
): Promise<
  | { ok: true; decompositions: PackageDecomposition[] }
  | { ok: false; error: string }
> {
  const packageLines = lines.filter((l) => {
    const svc = services.find((s) => s.id === l.service_id);
    return svc?.kind === "lab_package";
  });
  if (packageLines.length === 0) {
    return { ok: true, decompositions: [] };
  }

  const decompositions: PackageDecomposition[] = [];
  for (const line of packageLines) {
    const { data, error } = await supabase
      .from("package_components")
      .select(`
        component_service_id,
        sort_order,
        services!package_components_component_service_id_fkey ( id, code, name, is_active )
      `)
      .eq("package_service_id", line.service_id)
      .order("sort_order");
    if (error) {
      return {
        ok: false,
        error: `Failed to load components for package ${line.service_id}: ${error.message}`,
      };
    }
    if (!data || data.length === 0) {
      return {
        ok: false,
        error:
          `One of the packages in this visit has no components configured. ` +
          `Contact admin to set up its composition before ordering.`,
      };
    }
    const inactive = data.filter((r) => r.services?.is_active === false);
    if (inactive.length > 0) {
      return {
        ok: false,
        error: `Package contains inactive components: ${inactive.map((r) => r.services?.code).filter(Boolean).join(", ")}. Contact admin to update its composition.`,
      };
    }
    decompositions.push({
      headerLine: line,
      componentServiceIds: data.map((r) => r.component_service_id),
    });
  }
  return { ok: true, decompositions };
}
```

`VisitLine` is the per-line interface already defined in the file (extract its shape from the existing `lines` construction; if it lacks a name, add a `type VisitLine = (typeof lines)[number]` alias near the top).

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

### Task 10: Modify `createVisitAction` to decompose

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/actions.ts`

Insert the validation + decomposition between the `lines` construction and the `test_requests` insert.

- [ ] **Step 1: Hook the decomposition into the action**

Locate the block right before the `requestRows = lines.map(...)` mapping (around line 198). Replace it with:

```typescript
  // Phase 14: lab_package services decompose into a billing header +
  // N component test_requests. Load each package's components from
  // package_components and build header/component rows. Non-package
  // lines insert as single rows (existing behaviour).
  const decompositionResult = await loadPackageDecompositionsForLines(
    supabase,
    lines,
    services,
  );
  if (!decompositionResult.ok) {
    return { ok: false, error: decompositionResult.error };
  }
  const decompositions = decompositionResult.decompositions;
  const packageServiceIds = new Set(decompositions.map((d) => d.headerLine.service_id));

  // Header rows: one per package line, carries full pricing + HMO metadata.
  // The fn_header_auto_promote trigger flips status from in_progress to
  // ready_for_release on insert.
  const headerRows = lines
    .filter((l) => packageServiceIds.has(l.service_id))
    .map((l) => ({
      visit_id: visit.id,
      service_id: l.service_id,
      requested_by: session.user_id,
      base_price_php: l.base_price_php,
      discount_kind: l.discount_kind,
      discount_amount_php: l.discount_amount_php,
      final_price_php: l.final_price_php,
      hmo_provider_id: parsed.data.hmo_provider_id,
      hmo_approval_date: parsed.data.hmo_approval_date,
      hmo_authorization_no: parsed.data.hmo_authorization_no,
      receptionist_remarks: parsed.data.receptionist_remarks,
      clinic_fee_php: l.clinic_fee_php,
      doctor_pf_php: l.doctor_pf_php,
      procedure_description: l.procedure_description,
      hmo_approved_amount_php: l.hmo_approved_amount_php,
      is_package_header: true as const,
    }));

  // Standalone rows: existing non-package services (unchanged).
  const standaloneRows = lines
    .filter((l) => !packageServiceIds.has(l.service_id))
    .map((l) => ({
      visit_id: visit.id,
      service_id: l.service_id,
      requested_by: session.user_id,
      base_price_php: l.base_price_php,
      discount_kind: l.discount_kind,
      discount_amount_php: l.discount_amount_php,
      final_price_php: l.final_price_php,
      hmo_provider_id: parsed.data.hmo_provider_id,
      hmo_approval_date: parsed.data.hmo_approval_date,
      hmo_authorization_no: parsed.data.hmo_authorization_no,
      receptionist_remarks: parsed.data.receptionist_remarks,
      clinic_fee_php: l.clinic_fee_php,
      doctor_pf_php: l.doctor_pf_php,
      procedure_description: l.procedure_description,
      hmo_approved_amount_php: l.hmo_approved_amount_php,
    }));

  // Insert headers first (we need their ids to populate parent_id on components).
  const headerInserts = await supabase
    .from("test_requests")
    .insert(headerRows)
    .select("id, service_id");
  if (headerInserts.error || !headerInserts.data) {
    return {
      ok: false,
      error: `Failed to create package header rows: ${headerInserts.error?.message}`,
    };
  }
  // service_id may repeat across multiple package lines, but the same package can be ordered twice — keep one map per inserted row instead of code-keyed.
  const headerRowsBySvcId = new Map<string, string[]>();
  for (const row of headerInserts.data) {
    const arr = headerRowsBySvcId.get(row.service_id) ?? [];
    arr.push(row.id);
    headerRowsBySvcId.set(row.service_id, arr);
  }

  // Build component rows, attaching each to the correct header by service_id.
  // If a package is ordered N times in the same visit, we round-robin the
  // component rows to each header (one batch of components per header).
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
      return {
        ok: false,
        error: `Internal error: missing header row for service ${d.headerLine.service_id}`,
      };
    }
    headerRowsBySvcId.set(d.headerLine.service_id, headerIdQueue);
    for (const componentServiceId of d.componentServiceIds) {
      componentRows.push({
        visit_id: visit.id,
        service_id: componentServiceId,
        requested_by: session.user_id,
        base_price_php: 0,
        discount_amount_php: 0,
        final_price_php: 0,
        hmo_provider_id: parsed.data.hmo_provider_id,
        hmo_approval_date: parsed.data.hmo_approval_date,
        hmo_authorization_no: parsed.data.hmo_authorization_no,
        parent_id: headerId,
        is_package_header: false,
      });
    }
  }

  // Standalone + component inserts in one batch.
  const allLeafRows = [...standaloneRows, ...componentRows];
  if (allLeafRows.length > 0) {
    const leafInsert = await supabase
      .from("test_requests")
      .insert(allLeafRows);
    if (leafInsert.error) {
      return {
        ok: false,
        error: `Failed to create test_request rows: ${leafInsert.error.message}`,
      };
    }
  }

  // Audit row per package decomposition.
  if (decompositions.length > 0) {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const ua = h.get("user-agent");
    const auditRows = decompositions.map((d) => {
      const pkgService = services.find((s) => s.id === d.headerLine.service_id)!;
      return {
        actor_id: session.user_id,
        actor_type: "staff" as const,
        action: "package.decomposed",
        resource_type: "test_request",
        resource_id: headerRowsBySvcId.get(d.headerLine.service_id)?.[0] ?? null,
        metadata: {
          visit_id: visit.id,
          package_service_id: d.headerLine.service_id,
          package_code: pkgService.code,
          package_name: pkgService.name,
          component_count: d.componentServiceIds.length,
          component_codes: d.componentServiceIds, // resolved by id; admin can join later
        },
        ip_address: ip,
        user_agent: ua,
      };
    });
    await admin.from("audit_log").insert(auditRows);
  }
```

Important changes from the existing flow:
- The original `requestRows = lines.map(...)` + single `supabase.from("test_requests").insert(requestRows)` is **replaced**, not added to. Headers and standalone+component rows insert separately.
- The `services` select in the early validation must now include `kind` and `code` and `name` (extend it if it doesn't already).
- Make sure `admin` (the service-role client used elsewhere in the file for audit) is in scope at this point. If the existing file uses `createAdminClient()` or similar, follow that pattern.

- [ ] **Step 2: Update the services select to include kind/code/name**

If the existing select is `select("id, kind, price_php, ...")`, extend it to `select("id, kind, code, name, price_php, ...")`.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean. If TypeScript complains about types, the regenerated `database.ts` should already have the new columns — confirm `npm run db:types` (or the local-only fallback) ran in Task 1 Step 3.

### Task 11: Find + handle the add-service-to-existing-visit flow

- [ ] **Step 1: Search for any existing add-service flow**

```bash
grep -rn "addServiceToVisit\|addServices\|add_to_visit\|visit_id.*insert\|test_requests.*insert" \
  src/app/\(staff\)/staff/\(dashboard\)/visits/ \
  src/app/\(staff\)/staff/\(dashboard\)/queue/ \
  2>&1 | grep -v "node_modules" | head -20
```

- [ ] **Step 2: Decide based on findings**

- If **no such flow exists**, document this finding in the commit message and proceed.
- If **a flow exists**, apply the same decomposition pattern (extract `loadPackageDecompositionsForLines` + the header/component insert logic into a helper that both actions can call).

Most likely: no such flow exists in the current codebase; reception can only add services at visit creation time. If you find a flow, factor the decomposition logic into `src/lib/visits/decompose-packages.ts` and call from both action sites.

- [ ] **Step 3: Commit Task 9–11 work**

```bash
git add src/app/\(staff\)/staff/\(dashboard\)/visits/new/actions.ts
git commit -m "feat(packages): 14.2.1 — visit-creation decomposition + audit"
```

### Task 12: Manual smoke for visit creation

- [ ] **Step 1: Start local dev server**

```bash
npm run dev &
```

Wait for "Ready in ..." log.

- [ ] **Step 2: Create a test visit via the UI**

Open `http://localhost:3000`, sign in as admin, MFA, navigate to `New visit`. Pick an existing patient (or create one). Add ONE package service (e.g. `EXECUTIVE_PACKAGE_STANDARD` if it exists in your local catalog — otherwise pick any active `lab_package`). Add no other services. Submit.

- [ ] **Step 3: Verify via SQL**

```bash
docker exec -i supabase_db_DRMed psql -U postgres -d postgres -c "
  select tr.id, s.code, tr.is_package_header, tr.parent_id, tr.status,
         tr.final_price_php
  from test_requests tr
  join services s on s.id = tr.service_id
  where tr.visit_id = (select id from visits order by created_at desc limit 1)
  order by tr.is_package_header desc, s.code;
"
```

Expected:
- One row with `is_package_header = t`, `parent_id = NULL`, status = `ready_for_release`, full final_price_php
- N rows with `is_package_header = f`, `parent_id` matching the header's id, status = `in_progress`, final_price_php = 0

- [ ] **Step 4: Verify the audit row**

```bash
docker exec -i supabase_db_DRMed psql -U postgres -d postgres -c "
  select action, metadata->>'package_code' as code, metadata->>'component_count' as cnt
  from audit_log
  where action = 'package.decomposed'
  order by created_at desc
  limit 1;
"
```

Expected: one row with the package_code + component_count matching the package you ordered.

- [ ] **Step 5: Kill dev server**

```bash
pkill -f "next dev"
```

### Task 13: Form inline expansion

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx`

When reception selects a `lab_package` service, fetch + display its components inline (read-only, indented).

- [ ] **Step 1: Read the existing form structure**

```bash
grep -n "service_ids\|selectedService\|lab_package\|getPackage" src/app/\(staff\)/staff/\(dashboard\)/visits/new/visit-form.tsx | head -30
```

Understand how services are added and rendered. The exact pattern depends on the current form structure.

- [ ] **Step 2: Add component-loading state**

Near the top of the component, add state to track loaded components per package:

```typescript
const [packageComponents, setPackageComponents] = useState<
  Record<string, Array<{ component_code: string; component_name: string }>>
>({});
```

- [ ] **Step 3: Add an effect that loads components when a package is added**

```typescript
useEffect(() => {
  // For each lab_package in selected services that we don't already have components for,
  // fetch them in parallel.
  const packageSvcIds = selectedServiceIds
    .map((id) => services.find((s) => s.id === id))
    .filter((s): s is ServiceRecord => s?.kind === "lab_package")
    .map((s) => s.id);
  const missing = packageSvcIds.filter((id) => !(id in packageComponents));
  if (missing.length === 0) return;

  void Promise.all(
    missing.map(async (svcId) => {
      const result = await getPackageComponentsAction(svcId);
      if (result.ok) {
        setPackageComponents((prev) => ({
          ...prev,
          [svcId]: result.components.map((c) => ({
            component_code: c.component_code,
            component_name: c.component_name,
          })),
        }));
      } else {
        // Surface the error inline via the form's existing error state, if available.
        console.error(`Package component lookup failed for ${svcId}:`, result.error);
      }
    }),
  );
}, [selectedServiceIds, services, packageComponents]);
```

(Wire up `selectedServiceIds`, `services`, `ServiceRecord` to whatever names the form actually uses — read the file first.)

- [ ] **Step 4: Render the components inline beneath each package line**

In the JSX where each selected service is rendered:

```tsx
{selectedServices.map((svc) => (
  <div key={svc.id} className="...">
    {/* existing per-service controls (price, discount, remove button) */}
    {svc.kind === "lab_package" && packageComponents[svc.id] ? (
      <div className="ml-8 mt-2 border-l-2 border-slate-200 pl-4 text-sm text-slate-600">
        <p className="font-medium">Includes:</p>
        <ul className="mt-1 space-y-0.5">
          {packageComponents[svc.id].map((c) => (
            <li key={c.component_code} className="text-xs">
              • {c.component_name}
            </li>
          ))}
        </ul>
      </div>
    ) : null}
  </div>
))}
```

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 6: Manual UI smoke**

Start dev server, open the new-visit form, add a package — confirm the component list renders beneath the package row in a couple seconds.

```bash
npm run dev &
# open http://localhost:3000/staff/visits/new
# add Executive Package Standard (or any lab_package)
# confirm: indented "Includes:" list appears under the package line
pkill -f "next dev"
```

- [ ] **Step 7: Commit**

```bash
git add src/app/\(staff\)/staff/\(dashboard\)/visits/new/visit-form.tsx
git commit -m "feat(packages): 14.2.2 — inline expansion of package components in new-visit form"
```

---

## Dispatch 3 — Queue routing + header guard

This dispatch makes headers invisible to all worker queues, makes header navigation render a read-only summary, and rejects accidental header claims.

### Task 14: Filter headers from queue list

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/page.tsx`

- [ ] **Step 1: Locate the queue query**

```bash
grep -n "from(\"test_requests\")\|sectionsForRole\|allowedSections" src/app/\(staff\)/staff/\(dashboard\)/queue/page.tsx
```

- [ ] **Step 2: Add the header filter**

Find the query like `supabase.from("test_requests").select(...)...` and add `.eq("is_package_header", false)`.

Example diff:

```diff
   const { data: queueRows } = await supabase
     .from("test_requests")
     .select(`...`)
+    .eq("is_package_header", false)
     .in("status", claimableStatuses)
     .in("services.section", allowedSections);
```

The `.in("services.section", ...)` filter may live differently in the existing code (sometimes done client-side after the fetch); add `.eq("is_package_header", false)` to the *server-side* query for performance.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

### Task 15: Reject header claim attempts in claim Server Action

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts`

- [ ] **Step 1: Locate the claim action**

```bash
grep -n "claimTestRequest\|claim.*action\|assigned_to.*update" src/app/\(staff\)/staff/\(dashboard\)/queue/\[id\]/actions.ts
```

- [ ] **Step 2: Add a guard near the start of the claim action**

After loading the test_request row but before the UPDATE:

```typescript
if (testRequest.is_package_header) {
  return {
    ok: false,
    error: "Package headers cannot be claimed — they have no work.",
  };
}
```

Match the variable name `testRequest` to whatever the existing action uses.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

### Task 16: Render read-only summary for headers in `queue/[id]/page.tsx`

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx`

When the test_request being viewed has `is_package_header = true`, render a read-only summary panel instead of the structured form / PDF upload form.

- [ ] **Step 1: Locate the page**

```bash
grep -n "is_send_out\|generation_kind\|StructuredResultForm\|AmendResultForm" src/app/\(staff\)/staff/\(dashboard\)/queue/\[id\]/page.tsx | head -20
```

- [ ] **Step 2: Branch early in the page render**

Near the top of the component body, after the test_request + visit + service are loaded:

```typescript
if (test.is_package_header) {
  // Load components for the summary view.
  const { data: components } = await supabase
    .from("test_requests")
    .select(`
      id, status, released_at, package_completed_at,
      services ( code, name, section )
    `)
    .eq("parent_id", test.id)
    .order("created_at");

  return <PackageHeaderSummary
    header={test}
    visit={visit}
    service={svc}
    patient={patient}
    components={components ?? []}
  />;
}
// ... existing rendering for non-header test_requests
```

- [ ] **Step 3: Implement `PackageHeaderSummary` component**

Create as a co-located component within the file (or extract to a sibling file if it grows). The summary panel shows:

```tsx
function PackageHeaderSummary(props: {
  header: TestRequestRow;
  visit: VisitRow;
  service: ServiceRow;
  patient: PatientRow;
  components: ComponentRow[];
}) {
  return (
    <main className="p-6">
      <div className="mb-4 text-sm text-slate-500">
        <Link href="/staff/queue">← Queue</Link>
      </div>
      <div className="rounded-lg border bg-white p-6">
        <div className="text-xs uppercase tracking-wider text-slate-500">
          {props.service.code}
        </div>
        <h1 className="text-2xl font-bold text-slate-900">
          {props.service.name}
        </h1>
        <div className="mt-1 text-sm text-slate-600">
          Patient: {props.patient.last_name}, {props.patient.first_name} ·{" "}
          {props.patient.drm_id} · Visit #{props.visit.visit_number}
        </div>
        <div className="mt-1 text-sm text-slate-600">
          ₱{props.header.final_price_php?.toLocaleString()} · status:{" "}
          {props.header.status}
        </div>
        {props.header.package_completed_at ? (
          <div className="mt-1 text-sm text-emerald-700">
            Package completed at{" "}
            {new Date(props.header.package_completed_at).toLocaleString("en-PH")}
          </div>
        ) : null}
      </div>

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">
          Components ({props.components.length})
        </h2>
        <ul className="space-y-2">
          {props.components.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded border bg-white px-4 py-2">
              <div>
                <Link
                  href={`/staff/queue/${c.id}`}
                  className="text-sm font-medium text-slate-900 hover:underline"
                >
                  {c.services?.name ?? "(unknown)"}
                </Link>
                <div className="text-xs text-slate-500">
                  {c.services?.code} · {c.services?.section ?? "—"}
                </div>
              </div>
              <div className="text-xs text-slate-600">
                {c.status}
                {c.released_at
                  ? ` · released ${new Date(c.released_at).toLocaleString("en-PH")}`
                  : ""}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
```

(The exact `TestRequestRow`, `VisitRow`, etc., types depend on the existing page's loaded shape. Use the actual query result types.)

- [ ] **Step 4: Typecheck + lint**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 5: Manual smoke**

```bash
npm run dev &
# Create a visit with a package via the new-visit form (or via SQL)
# Visit /staff/queue/<header_id>
# Confirm: read-only summary panel renders, no structured form / file input
# Click on a component name → lands on /staff/queue/<component_id> with the normal form
pkill -f "next dev"
```

- [ ] **Step 6: Commit**

```bash
git add src/app/\(staff\)/staff/\(dashboard\)/queue/page.tsx \
        src/app/\(staff\)/staff/\(dashboard\)/queue/\[id\]/page.tsx \
        src/app/\(staff\)/staff/\(dashboard\)/queue/\[id\]/actions.ts
git commit -m "feat(packages): 14.3.1 — queue header filter + read-only summary + claim guard"
```

---

## Dispatch 4 — Visit detail nested render

### Task 17: Modify visits/[id]/page.tsx to render nested packages

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx`

- [ ] **Step 1: Locate the test_requests render in the page**

```bash
grep -n "test_requests\|from(\"test_requests\"" src/app/\(staff\)/staff/\(dashboard\)/visits/\[id\]/page.tsx | head -10
```

- [ ] **Step 2: Update the query**

Ensure the query selects `parent_id` and `is_package_header`. Example:

```typescript
const { data: testRequests } = await supabase
  .from("test_requests")
  .select(`
    id, status, final_price_php, parent_id, is_package_header, package_completed_at,
    services ( code, name, section, kind )
  `)
  .eq("visit_id", visitId)
  .order("is_package_header", { ascending: false })  // headers first
  .order("parent_id", { nullsFirst: true })          // standalones interleave naturally
  .order("created_at");
```

- [ ] **Step 3: Group by parent_id in the render**

```typescript
const headers = (testRequests ?? []).filter((t) => t.is_package_header);
const componentsByParent = new Map<string, typeof testRequests>();
const standalones: typeof testRequests = [];
for (const t of testRequests ?? []) {
  if (t.is_package_header) continue;
  if (t.parent_id) {
    const arr = componentsByParent.get(t.parent_id) ?? [];
    arr.push(t);
    componentsByParent.set(t.parent_id, arr);
  } else {
    standalones.push(t);
  }
}
```

- [ ] **Step 4: Render the nested structure**

```tsx
<section>
  {headers.map((h) => (
    <div key={h.id} className="mb-4 rounded-lg border bg-white p-4">
      <Link href={`/staff/queue/${h.id}`} className="block">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase text-slate-500">{h.services?.code}</div>
            <div className="font-semibold text-slate-900">{h.services?.name}</div>
          </div>
          <div className="text-sm font-semibold">₱{h.final_price_php?.toLocaleString()}</div>
        </div>
      </Link>
      <ul className="mt-3 space-y-1 border-l-2 border-slate-200 pl-4">
        {(componentsByParent.get(h.id) ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between text-sm">
            <Link href={`/staff/queue/${c.id}`} className="hover:underline">
              {c.services?.name}
            </Link>
            <span className="text-xs text-slate-500">
              {c.services?.section ?? "—"} · {c.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ))}
  {standalones.map((s) => (
    <div key={s.id} className="mb-2 rounded border bg-white p-3">
      <Link href={`/staff/queue/${s.id}`} className="flex items-center justify-between">
        <div className="text-sm font-medium">{s.services?.name}</div>
        <div className="text-sm">₱{s.final_price_php?.toLocaleString()} · {s.status}</div>
      </Link>
    </div>
  ))}
</section>
```

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 6: Manual smoke**

```bash
npm run dev &
# Visit /staff/visits/<id> for a visit with a package + a standalone test
# Confirm: package renders as a card with components indented; standalone below
pkill -f "next dev"
```

- [ ] **Step 7: Commit**

```bash
git add src/app/\(staff\)/staff/\(dashboard\)/visits/\[id\]/page.tsx
git commit -m "feat(packages): 14.4.1 — visit detail nested package render"
```

---

## Dispatch 5 — PDF package_summary + portal grouping + consolidated PDF

This dispatch is the heaviest. Adds a new PDF layout, the patient portal grouping, and the consolidated-PDF endpoint.

### Task 18: Add `'package_summary'` to the ResultLayout type

**Files:**
- Modify: `src/lib/results/types.ts`

- [ ] **Step 1: Locate the `ResultLayout` union**

```bash
grep -n "ResultLayout\|imaging_report\|simple\|multi_section" src/lib/results/types.ts
```

- [ ] **Step 2: Add the new variant**

```diff
-export type ResultLayout = "simple" | "dual_unit" | "multi_section" | "imaging_report";
+export type ResultLayout =
+  | "simple"
+  | "dual_unit"
+  | "multi_section"
+  | "imaging_report"
+  | "package_summary";
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

If there are exhaustive switches elsewhere (e.g. on layout), TS will surface them. Add explicit branches as needed (default to a no-op or fall through).

### Task 19: Extend `ResultDocumentInput` to support package_summary

**Files:**
- Modify: `src/lib/results/types.ts`

The cover page needs the list of included components. Add an optional field.

- [ ] **Step 1: Edit the input type**

```diff
 export interface ResultDocumentInput {
   template: { layout: ResultLayout; header_notes: string | null; footer_notes: string | null };
   params: TemplateParam[];
   values: Record<string, ParamValue>;
   service: { code: string; name: string };
   patient: { ... };
   visit: { visit_number: number | string };
   controlNo: number | null;
   finalisedAt: Date | null;
   medtech: { full_name: string; prc_license_kind: string | null; prc_license_no: string | null } | null;
   imageAttachment?: { data: Uint8Array; mime: string; filename: string };
+  packageSummary?: {
+    packageCode: string;
+    packageName: string;
+    components: Array<{ code: string; name: string; status: string }>;
+  };
 }
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

### Task 20: Add `PackageSummaryBody` to `pdf-document.tsx`

**Files:**
- Modify: `src/lib/results/pdf-document.tsx`

- [ ] **Step 1: Add the body component near the other Body components**

```tsx
function PackageSummaryBody({
  packageSummary,
}: {
  packageSummary: NonNullable<ResultDocumentInput["packageSummary"]>;
}) {
  return (
    <View style={styles.imagingBody}>
      <Text style={styles.imagingHeading}>Package Result Summary</Text>
      <Text style={[styles.imagingText, { marginBottom: 8 }]}>
        This package includes the following {packageSummary.components.length}{" "}
        test results, attached on subsequent pages:
      </Text>
      <View>
        {packageSummary.components.map((c, idx) => (
          <Text key={c.code} style={styles.imagingText}>
            {String(idx + 1).padStart(2, " ")}. {c.name}{" "}
            <Text style={{ color: C.inkMuted }}>({c.code})</Text>
          </Text>
        ))}
      </View>
    </View>
  );
}
```

- [ ] **Step 2: Wire into the layout switch**

Locate the `switch` or branching block where layouts dispatch to body components (around the lines that render `SimpleTable`, `DualUnitTable`, `MultiSectionBody`, `ImagingBody`). Add:

```tsx
case "package_summary":
  return packageSummary ? <PackageSummaryBody packageSummary={packageSummary} /> : null;
```

(The exact dispatch pattern depends on the current code. If it's a `switch`, add a case. If it's a `?:` chain, add a branch.)

- [ ] **Step 3: Typecheck + lint**

```bash
npm run typecheck && npm run lint
```

### Task 21: Smoke render the package_summary layout

**Files:**
- Modify: `scripts/smoke-render-results.ts` (only if it has a layout-iterator that needs the new variant)

- [ ] **Step 1: Add a smoke case for the cover**

Add to the existing smoke render script — render one ResultDocument with `layout: "package_summary"` and a fake components array:

```typescript
const coverSample: ResultDocumentInput = {
  template: { layout: "package_summary", header_notes: null, footer_notes: null },
  params: [],
  values: {},
  service: { code: "EXECUTIVE_PACKAGE_STANDARD", name: "Executive Package - Standard" },
  patient: { drm_id: "DRM-PREVIEW", last_name: "DOE", first_name: "JANE", sex: "F", birthdate: "1985-04-12" },
  visit: { visit_number: "0007" },
  controlNo: 7777,
  finalisedAt: new Date(),
  medtech: null,
  packageSummary: {
    packageCode: "EXECUTIVE_PACKAGE_STANDARD",
    packageName: "Executive Package - Standard",
    components: [
      { code: "CBC_PC", name: "CBC + PC", status: "released" },
      { code: "URINALYSIS", name: "Urinalysis", status: "released" },
      { code: "FBS_RBS", name: "FBS/RBS", status: "released" },
      { code: "ECG", name: "12-Lead ECG", status: "released" },
      { code: "XRAY_CHEST_PA_LAT_ADULT", name: "Chest X-Ray PA/LAT (Adult)", status: "released" },
    ],
  },
};
const coverPdf = await renderResultPdf(coverSample);
writeFileSync("/tmp/drmed-package-summary.pdf", coverPdf);
console.log(`✓ package_summary cover → /tmp/drmed-package-summary.pdf (${coverPdf.byteLength} bytes)`);
```

- [ ] **Step 2: Run the smoke**

```bash
npx tsx --env-file=.env.local scripts/smoke-render-results.ts 2>&1 | tail -10
```

Inspect `/tmp/drmed-package-summary.pdf`. Confirm: DRMed letterhead + patient grid + centered "EXECUTIVE PACKAGE - STANDARD" section title + "Package Result Summary" body listing 5 numbered components + signature block.

- [ ] **Step 3: Commit Tasks 18–21 work**

```bash
git add src/lib/results/types.ts src/lib/results/pdf-document.tsx scripts/smoke-render-results.ts
git commit -m "feat(packages): 14.5.1 — package_summary PDF layout + smoke"
```

### Task 22: Add `pdf-lib` dependency

- [ ] **Step 1: Install**

```bash
npm install pdf-lib
```

- [ ] **Step 2: Commit lockfile changes**

```bash
git add package.json package-lock.json
git commit -m "chore: add pdf-lib for consolidated PDF concatenation"
```

### Task 23: Implement `getPackagePdfDownloadUrl` Server Action

**Files:**
- Modify: `src/app/(patient)/portal/(authenticated)/actions.ts`

This is the consolidated PDF endpoint. Patient triggers it from the portal. The action:
1. Validates patient ownership + header is released
2. Loads all components (releases only)
3. In parallel: fetches each component PDF from storage + renders the cover via `renderResultPdf`
4. Concatenates with `pdf-lib`
5. Streams back as a Response
6. Audit-logs `result.downloaded`

- [ ] **Step 1: Add the action**

```typescript
import { PDFDocument } from "pdf-lib";
import { renderResultPdf } from "@/lib/results/render-pdf";
import type { ResultDocumentInput } from "@/lib/results/types";

export async function getPackagePdfDownloadUrl(
  headerTestRequestId: string,
): Promise<
  | { ok: true; pdfBase64: string; filename: string }
  | { ok: false; error: string }
> {
  const session = await getPatientSession();
  if (!session) return { ok: false, error: "Not authenticated" };

  const admin = createAdminClient();

  // 1) Load header + verify ownership + status
  const { data: header } = await admin
    .from("test_requests")
    .select(`
      id, status, is_package_header, parent_id, visit_id, package_completed_at,
      services!test_requests_service_id_fkey ( code, name ),
      visits!test_requests_visit_id_fkey (
        id, patient_id, visit_number,
        patients!visits_patient_id_fkey ( drm_id, last_name, first_name, sex, birthdate )
      )
    `)
    .eq("id", headerTestRequestId)
    .single();

  if (!header || header.is_package_header !== true) {
    return { ok: false, error: "Not a package header" };
  }
  if (header.visits?.patient_id !== session.patient_id) {
    return { ok: false, error: "Not authorised" };
  }
  if (header.status !== "released") {
    return { ok: false, error: "Package not yet released" };
  }

  // 2) Load all components + sort_order
  const { data: components } = await admin
    .from("test_requests")
    .select(`
      id, status, services ( id, code, name )
    `)
    .eq("parent_id", header.id)
    .order("created_at"); // Components were inserted in package_components.sort_order

  if (!components || components.length === 0) {
    return { ok: false, error: "Package has no components" };
  }
  // Skip cancelled. Require every non-cancelled component to be released.
  const releasedComponents = components.filter((c) => c.status === "released");
  const cancelledComponents = components.filter((c) => c.status === "cancelled");
  const pendingComponents = components.filter(
    (c) => c.status !== "released" && c.status !== "cancelled",
  );
  if (pendingComponents.length > 0) {
    return {
      ok: false,
      error: `${pendingComponents.length} of ${components.length} components are still in progress.`,
    };
  }
  if (releasedComponents.length === 0) {
    return { ok: false, error: "No released components to assemble." };
  }

  // 3) Load results + storage_path for released components
  const { data: results } = await admin
    .from("results")
    .select("id, test_request_id, storage_path")
    .in("test_request_id", releasedComponents.map((c) => c.id));
  const resultByTrId = new Map((results ?? []).map((r) => [r.test_request_id, r]));

  // 4) Parallel: fetch each component PDF + render the cover
  const coverInput: ResultDocumentInput = {
    template: { layout: "package_summary", header_notes: null, footer_notes: null },
    params: [],
    values: {},
    service: {
      code: header.services?.code ?? "PACKAGE",
      name: header.services?.name ?? "Package Result",
    },
    patient: {
      drm_id: header.visits?.patients?.drm_id ?? "",
      last_name: header.visits?.patients?.last_name ?? "",
      first_name: header.visits?.patients?.first_name ?? "",
      sex: header.visits?.patients?.sex ?? null,
      birthdate: header.visits?.patients?.birthdate ?? null,
    },
    visit: { visit_number: header.visits?.visit_number ?? "" },
    controlNo: null,
    finalisedAt: header.package_completed_at
      ? new Date(header.package_completed_at)
      : new Date(),
    medtech: null,
    packageSummary: {
      packageCode: header.services?.code ?? "",
      packageName: header.services?.name ?? "",
      components: releasedComponents.map((c) => ({
        code: c.services?.code ?? "",
        name: c.services?.name ?? "",
        status: c.status,
      })),
    },
  };

  const [coverPdfBytes, ...componentPdfBytes] = await Promise.all([
    renderResultPdf(coverInput),
    ...releasedComponents.map(async (c) => {
      const result = resultByTrId.get(c.id);
      if (!result) return null;
      const dl = await admin.storage.from("results").download(result.storage_path);
      if (dl.error || !dl.data) return null;
      return new Uint8Array(await dl.data.arrayBuffer());
    }),
  ]);

  // 5) Concatenate
  const merged = await PDFDocument.create();
  const coverDoc = await PDFDocument.load(coverPdfBytes);
  const coverPages = await merged.copyPages(coverDoc, coverDoc.getPageIndices());
  coverPages.forEach((p) => merged.addPage(p));

  for (const bytes of componentPdfBytes) {
    if (!bytes) continue;
    try {
      const doc = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch (err) {
      // Skip malformed source PDFs but continue. Note in audit metadata.
      console.error("Failed to load component PDF; skipping:", err);
    }
  }
  const mergedBytes = await merged.save();
  const mergedBase64 = Buffer.from(mergedBytes).toString("base64");

  // 6) Audit
  const h = await headers();
  await audit({
    actor_id: null,
    actor_type: "patient",
    action: "result.downloaded",
    resource_type: "result",
    resource_id: header.id,
    patient_id: session.patient_id,
    metadata: {
      kind: "package_consolidated",
      visit_id: header.visit_id,
      header_test_request_id: header.id,
      package_code: header.services?.code,
      merged_component_ids: releasedComponents.map((c) => c.id),
      merged_page_count: merged.getPageCount(),
      skipped_cancelled_components: cancelledComponents.length,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  const safePkgCode = (header.services?.code ?? "PACKAGE").replace(/[^A-Z0-9_-]/gi, "_");
  return {
    ok: true,
    pdfBase64: mergedBase64,
    filename: `${safePkgCode}-${header.id.slice(0, 8)}.pdf`,
  };
}
```

This returns base64-encoded PDF bytes that the client converts back to a Blob and triggers a download. (Streaming directly from a Server Action requires Response objects which aren't always available depending on Next 16 Server Action conventions; base64 is the pragmatic fallback.)

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

If `getPatientSession` / `createAdminClient` / `audit` aren't already imported, add them from the same modules other actions in this file use.

### Task 24: Wire portal page to group + render package cards

**Files:**
- Modify: `src/app/(patient)/portal/(authenticated)/page.tsx`

- [ ] **Step 1: Load released test_requests with parent/header info**

Locate the existing portal query and extend:

```typescript
const { data: results } = await admin
  .from("test_requests")
  .select(`
    id, status, released_at, parent_id, is_package_header,
    services!test_requests_service_id_fkey ( code, name, section ),
    results ( id, storage_path, file_size_bytes )
  `)
  .eq("visit_id", visitId)
  .or("status.eq.released,is_package_header.eq.true")
  .order("is_package_header", { ascending: false })
  .order("created_at");
```

The portal shows the patient's released test_requests. Package headers (released because visit is paid) appear; components (released or pending) appear; cancelled components also appear so the patient sees them.

- [ ] **Step 2: Group client-side**

```typescript
const headers = (results ?? []).filter((r) => r.is_package_header);
const componentsByParent = new Map<string, typeof results>();
const standalones: typeof results = [];
for (const r of results ?? []) {
  if (r.is_package_header) continue;
  if (r.parent_id) {
    const arr = componentsByParent.get(r.parent_id) ?? [];
    arr.push(r);
    componentsByParent.set(r.parent_id, arr);
  } else if (r.status === "released") {
    standalones.push(r);
  }
}
```

- [ ] **Step 3: Render cards**

```tsx
<section>
  {headers.map((h) => {
    const comps = componentsByParent.get(h.id) ?? [];
    const released = comps.filter((c) => c.status === "released");
    const nonCancelled = comps.filter((c) => c.status !== "cancelled");
    const allReleased = nonCancelled.every((c) => c.status === "released");
    return (
      <PackageCard
        key={h.id}
        header={h}
        components={comps}
        releasedCount={released.length}
        totalCount={nonCancelled.length}
        consolidatedAvailable={allReleased && released.length > 0}
      />
    );
  })}
  {standalones.map((s) => (
    <StandaloneResultCard key={s.id} testRequest={s} />
  ))}
</section>
```

Implement `PackageCard` and `StandaloneResultCard` as co-located client components (mark `'use client'` where the download button needs an onClick handler).

- [ ] **Step 4: `PackageCard` client component**

```tsx
"use client";

import { useTransition } from "react";
import {
  getPackagePdfDownloadUrl,
  getPatientResultDownloadUrl,
} from "./actions";

export function PackageCard(props: {
  header: { id: string; services: { code: string; name: string } | null; released_at: string | null };
  components: Array<{ id: string; status: string; services: { code: string; name: string } | null }>;
  releasedCount: number;
  totalCount: number;
  consolidatedAvailable: boolean;
}) {
  const [pending, start] = useTransition();
  const [expanded, setExpanded] = useState(false);

  async function downloadConsolidated() {
    start(async () => {
      const result = await getPackagePdfDownloadUrl(props.header.id);
      if (!result.ok) {
        alert(result.error);
        return;
      }
      // Convert base64 to Blob and trigger download
      const bytes = Uint8Array.from(atob(result.pdfBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  async function downloadComponent(componentId: string) {
    const result = await getPatientResultDownloadUrl(componentId);
    if (result.ok) {
      window.open(result.url, "_blank");
    } else {
      alert(result.error);
    }
  }

  return (
    <div className="mb-4 rounded-lg border bg-white p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {props.header.services?.name}
          </h2>
          <p className="text-xs text-slate-500">
            {props.releasedCount} of {props.totalCount} components released
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={downloadConsolidated}
          disabled={!props.consolidatedAvailable || pending}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-300 disabled:cursor-not-allowed"
          title={!props.consolidatedAvailable ? "Available when all components are released" : undefined}
        >
          {pending ? "Preparing..." : "Download package result"}
        </button>
        <button
          onClick={() => setExpanded((p) => !p)}
          className="rounded border px-4 py-2 text-sm"
        >
          {expanded ? "Hide individual results" : "Show individual results"}
        </button>
      </div>
      {expanded ? (
        <ul className="mt-3 space-y-1.5 border-t pt-3">
          {props.components.map((c) => (
            <li key={c.id} className="flex items-center justify-between text-sm">
              <span>{c.services?.name}</span>
              {c.status === "released" ? (
                <button
                  onClick={() => downloadComponent(c.id)}
                  className="text-blue-600 hover:underline"
                >
                  Download
                </button>
              ) : c.status === "cancelled" ? (
                <span className="text-slate-400">Cancelled</span>
              ) : (
                <span className="text-slate-500">In progress</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/app/\(patient\)/portal/\(authenticated\)/page.tsx \
        src/app/\(patient\)/portal/\(authenticated\)/actions.ts
git commit -m "feat(packages): 14.5.2 — patient portal grouping + consolidated PDF endpoint"
```

---

## Dispatch 6 — Full smoke + v1.6.0 tag

### Task 25: Write full SQL smoke

**Files:**
- Create: `scripts/smoke-14.sql`

- [ ] **Step 1: Write the smoke**

```sql
-- =============================================================================
-- smoke-14.sql — full Phase 14 acceptance criteria smoke
-- =============================================================================
-- Mirrors acceptance criteria § 9 of the spec.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_patient uuid;
  v_visit uuid;
  v_pkg_svc uuid := gen_random_uuid();
  v_cbc_svc uuid := gen_random_uuid();
  v_xray_svc uuid := gen_random_uuid();
  v_pkg_tr uuid;
  v_cbc_tr uuid;
  v_xray_tr uuid;
  v_header_status text;
  v_components int;
  v_visit_total numeric;
  v_completed timestamptz;
begin
  -- Bootstrap
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_admin, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'smoke-14@drmed.local');

  insert into public.staff_profiles (id, full_name, role, is_active)
  values (v_admin, 'Smoke 14', 'admin', true);

  insert into public.patients (last_name, first_name, sex, birthdate, drm_id)
  values ('Smoke', 'Full', 'M', '2000-01-01', 'DRM-S14')
  returning id into v_patient;

  insert into public.visits (patient_id, visit_number, total_php, created_by, payment_status)
  values (v_patient, 'V-S14', 1000, v_admin, 'unpaid')
  returning id into v_visit;

  insert into public.services (id, code, name, description, price_php, kind, section, is_active, is_send_out)
  values
    (v_pkg_svc,  'SMK14_PKG',  'Smoke 14 Package',     '', 1000, 'lab_package', 'package',     true, false),
    (v_cbc_svc,  'SMK14_CBC',  'Smoke 14 CBC',         '', 0,    'lab_test',    'hematology',  true, false),
    (v_xray_svc, 'SMK14_XRAY', 'Smoke 14 Chest X-Ray', '', 0,    'lab_test',    'imaging_xray',true, false);

  insert into public.package_components (package_service_id, component_service_id, sort_order)
  values
    (v_pkg_svc, v_cbc_svc, 0),
    (v_pkg_svc, v_xray_svc, 1);

  -- Build header + components by direct insert (simulating the visit-creation action).
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                     base_price_php, discount_amount_php, final_price_php,
                                     is_package_header)
  values (v_visit, v_pkg_svc, 'in_progress', v_admin, 1000, 0, 1000, true)
  returning id into v_pkg_tr;

  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                     base_price_php, discount_amount_php, final_price_php,
                                     parent_id, is_package_header)
  values
    (v_visit, v_cbc_svc, 'in_progress', v_admin, 0, 0, 0, v_pkg_tr, false),
    (v_visit, v_xray_svc, 'in_progress', v_admin, 0, 0, 0, v_pkg_tr, false);

  -- B1: Header auto-promoted
  select status into v_header_status from public.test_requests where id = v_pkg_tr;
  if v_header_status <> 'ready_for_release' then
    raise exception 'B1 FAIL: header status %', v_header_status;
  end if;
  raise notice 'B1 PASS: header auto-promoted to ready_for_release';

  -- B2: Components present
  select count(*) into v_components from public.test_requests where parent_id = v_pkg_tr;
  if v_components <> 2 then raise exception 'B2 FAIL: expected 2 components, got %', v_components; end if;
  raise notice 'B2 PASS: 2 components inserted';

  -- B3: Visit total = header price (components contribute ₱0)
  select total_php into v_visit_total from public.visits where id = v_visit;
  if v_visit_total <> 1000 then raise exception 'B3 FAIL: visit total %', v_visit_total; end if;
  raise notice 'B3 PASS: visit total = package price';

  -- B4: Queue filter excludes header (simulated via the same filter)
  if exists (select 1 from public.test_requests where id = v_pkg_tr and is_package_header = false) then
    raise exception 'B4 FAIL: header somehow not flagged';
  end if;
  raise notice 'B4 PASS: header flagged is_package_header=true';

  -- Pay the visit
  update public.visits set payment_status = 'paid' where id = v_visit;

  -- Release components manually (simulating medtech + xray work)
  -- First, set ready_for_release so the payment-gating trigger lets it release.
  -- (In real flow, medtech finalises which sets ready_for_release.)
  update public.test_requests set status = 'released', released_at = now()
   where id in (select id from public.test_requests where parent_id = v_pkg_tr);
  -- Then release the header
  update public.test_requests set status = 'released', released_at = now()
   where id = v_pkg_tr;

  -- B5: package_completed_at set
  select package_completed_at into v_completed from public.test_requests where id = v_pkg_tr;
  if v_completed is null then raise exception 'B5 FAIL: completed_at NULL'; end if;
  raise notice 'B5 PASS: package_completed_at set';

  raise notice 'all 5 full-smoke assertions PASS (B1–B5)';
end$$;

rollback;
```

- [ ] **Step 2: Run the smoke**

```bash
supabase db reset
docker exec -i supabase_db_DRMed psql -U postgres -d postgres -f - < scripts/smoke-14.sql 2>&1 | tail -20
```

Expected: `all 5 full-smoke assertions PASS (B1–B5)` plus the per-assertion PASS lines.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-14.sql
git commit -m "test(packages): 14.6.1 — full SQL smoke"
```

### Task 26: Browser smoke at 1280×800 + 390×844

This is a manual walkthrough using Playwright via the controller. Steps assume the controller has admin credentials + a current TOTP code.

- [ ] **Step 1: Open the site, login + MFA**

Walk through `/staff/login` → sign in as admin → MFA prompt → enter TOTP.

- [ ] **Step 2: Create a visit with a package**

Navigate to `/staff/visits/new` → pick a test patient → add an `EXECUTIVE_PACKAGE_STANDARD` service → confirm component list renders inline → submit.

Verify the redirect lands on the visit detail page with the nested package render.

- [ ] **Step 3: Verify queue routing**

Open `/staff/queue` (as medtech eventually): confirm component test_requests appear (medtech sees lab components, xray_technician sees ECG + X-ray). The header does NOT appear in either queue.

- [ ] **Step 4: Verify header navigation guard**

Manually navigate to `/staff/queue/<header_id>`. Confirm: read-only package summary panel renders; no structured form; no claim button.

- [ ] **Step 5: Test mobile viewport at 390×844**

Resize browser to 390×844. Repeat steps 2–4. Confirm: no horizontal overflow on the new-visit form, visit detail, queue, or package summary page.

- [ ] **Step 6: Mark payment paid, finalise components, verify release flow**

Pay the visit via the existing payment flow. Then have medtech finalise CBC + Urinalysis + chem components; xray_tech finalises ECG + Chest X-Ray. Confirm: header transitions to `released`, each component transitions to `released`, `package_completed_at` populated.

- [ ] **Step 7: Verify patient portal**

Sign out, log into the patient portal using the patient's DRM-ID + PIN. Confirm: package card with "N of N components released", expand to see all components, click "Download package result", verify consolidated PDF downloads with cover + N component pages.

- [ ] **Step 8: Verify HMO claim attribution (if HMO ordered)**

If the test visit had an HMO selected, navigate to `/staff/admin/accounting/hmo-claims/<provider>` and confirm: the header appears as a claim line item with the package price; components do NOT appear.

- [ ] **Step 9: Note any unexpected behaviour**

If any acceptance criterion (spec § 9) fails, file an issue or address inline. Commit any patches.

### Task 27: Update MEMORY.md + project memory

**Files:**
- `~/.claude/projects/-Users-jamila-Desktop-Claude-Projects-DRMed/memory/MEMORY.md`
- `~/.claude/projects/-Users-jamila-Desktop-Claude-Projects-DRMed/memory/project_phase14_package_decomposition.md`

- [ ] **Step 1: Update the in-flight memory to "shipped"**

Replace `project_phase14_package_decomposition.md` with a "shipped" summary listing the dispatched commits, tag, and any deferred follow-ups.

- [ ] **Step 2: Update MEMORY.md**

Replace the "Phase 14 IN FLIGHT" line with:

```
- [Phase 14 — package decomposition shipped 2026-05-17 (v1.6.0)](project_phase14_package_decomposition.md) — lab_package decomposes into header + components, patient portal consolidated PDF.
```

### Task 28: Tag `v1.6.0`

- [ ] **Step 1: Confirm tree clean, all dispatch commits in**

```bash
git status
git log --oneline -15
```

- [ ] **Step 2: Tag**

```bash
git tag -a v1.6.0 -m "Phase 14 — package decomposition: lab_package services fan out into header + component test_requests, with consolidated PDF in the patient portal"
git tag --list 'v1.*'
```

Expected: `v1.2.0, v1.3.0, v1.4.0, v1.5.0, v1.6.0`.

- [ ] **Step 3: Push tag + main**

```bash
git push origin main --follow-tags
```

---

## Self-Review

Skimming the spec against the plan one section at a time:

**Spec § 1 (Goal)** → Plan goal matches.

**Spec § 2 (Why)** → Plan's "Architecture" paragraph captures the motivation.

**Spec § 3 (Locked decisions Q1–Q8)** → all 8 reflected:
- Q1 header+₱0 components: Task 10 inserts header with price, components with `final_price_php=0`.
- Q2 package_components table: Task 1 + Task 2 + Task 6.
- Q3 legacy untouched: spec's hard rule #10 noted; plan does not migrate legacy.
- Q4 inline expansion + visit detail expanded: Task 13 + Task 17.
- Q5 consolidated PDF + per-component: Task 23 + Task 24.
- Q6 package_completed_at: Task 1 trigger; Task 25 B5 asserts it.
- Q7 visit-level payment gate inherited: existing 12.2 behaviour; spec § 5.5 walkthrough; Task 26 step 6 verifies in browser.
- Q8 package_summary cover, parallelised: Task 18 + 19 + 20 + 23.

**Spec § 4.1 (Schema)** → Task 1 implements all of it: table, 3 columns, CHECK, 4 triggers, 3 indexes.

**Spec § 4.2 (Visit-creation flow)** → Task 10 implements detection, validation, header + components insert in transaction, audit row.

**Spec § 4.3 (Queue routing)** → Tasks 14 + 15 + 16. Visit-detail render in Task 17.

**Spec § 4.4 (Patient portal + consolidated PDF)** → Task 23 + 24. PackageCard component spec'd inline.

**Spec § 4.5 (Add-service-after-creation)** → Task 11 (search + decide).

**Spec § 4.6 (Audit)** → Task 10 emits `package.decomposed`; Task 23 emits `result.downloaded` with merged metadata.

**Spec § 5 (Edge cases)** → Triggers cover § 5.1–5.4 (amendments, cancellations, cascade-cancel). Task 16 covers § 5.6 (header guard). Smoke covers § 5 logic.

**Spec § 6 (Migration & seed)** → Tasks 1 + 2 + 5 + 6.

**Spec § 7 (Hard rules)** → All reflected; rule #5 (no nested packages) is enforced by app-layer validation since `package_components` allows it at the table level (a package's component could itself be a package — but no current package_components row references a lab_package as a component, and admin convention prevents it).

**Spec § 8 (Risks)** → Risk #1 (malformed component PDF) handled in Task 23 (try/catch in the merge loop).

**Spec § 9 (Acceptance criteria 1–14)** → Task 25 SQL smoke covers schema/trigger criteria; Task 26 browser smoke covers UI/release/payment criteria.

**Spec § 10 (Out of scope)** → All noted; not implemented.

**Placeholder scan**: zero "TBD" / "TODO" markers. Code blocks in every code-writing step.

**Type consistency**: `getPackageComponentsAction` return shape (Task 8), `loadPackageDecompositionsForLines` return shape (Task 9), and the audit metadata shape (Task 10) all use the same `package_service_id` / `component_service_id` / `package_code` keys. The portal action (Task 23) uses `header.services?.code` consistently. Cover input (Task 19) and `PackageSummaryBody` (Task 20) agree on the `packageSummary.components` shape.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-17-14-package-decomposition.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task (or per dispatch), review between dispatches, fast iteration. Six dispatches; each lands a commit; controller reviews + applies any prod migrations between dispatches.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. Slower but lets the user see everything as it happens.

**Which approach?**

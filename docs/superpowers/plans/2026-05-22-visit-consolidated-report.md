# Visit-consolidated reports + embedded signatures — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the visit-consolidated chemistry report + embedded-signature work described in spec `docs/superpowers/specs/2026-05-22-visit-consolidated-report-design.md`. After this plan: (a) any combination of chemistry tests on a single visit produces one 13-row consolidated PDF with one control number; (b) every DRMed-generated result PDF carries a real signature image for the performing professional plus an auto-included consultant pathologist signature.

**Architecture:** One new migration `0051_consolidated_reports_and_signatures.sql` introduces `report_groups`, the `result_test_requests` junction, `results` deltas (drop `test_request_id`, add `report_group_id` + `finalised_by_staff_id`), `staff_profiles` deltas (`signature_path`, `signature_uploaded_at`, nullable `auth_user_id`), updated triggers (walk the junction), and updated RLS. A second migration `0052_signatures_bucket.sql` provisions the private Storage bucket. New seed scripts insert Chemistry services + template + Mariano/Vicencio staff_profiles + upload signature PNGs. Renderer (`src/lib/results/pdf-document.tsx`) gains image-embedding support and resolves the consultant pathologist / radiologist / cardiologist via env-var staff IDs. Medtech queue page (`src/app/(staff)/staff/(dashboard)/queue/page.tsx`) groups chemistry test_requests by `(visit_id, report_group_id)`; a new route handles the consolidated form. Patient portal label resolves to the report-group name when present.

**Tech Stack:** Next.js 16 (App Router), Supabase (Postgres + private Storage bucket + service-role client), TypeScript strict, `@react-pdf/renderer` for PDFs, Zod, Tailwind, React 19, Playwright for UI smoke. Conventions from `CLAUDE.md` and `AGENTS.md`.

---

## File structure

### Create — migrations, seeds, smokes, scripts

```
supabase/migrations/0051_consolidated_reports_and_signatures.sql
supabase/migrations/0052_signatures_bucket.sql
supabase/migrations/0053_chemistry_seed.sql
scripts/seed-signatures.ts
scripts/smoke-chemistry-consolidated.sql
scripts/smoke-chemistry-consolidated.ts
scripts/seed/signatures/.gitkeep
```

### Create — Server Actions + UI routes

```
src/lib/actions/results/finalise-consolidated.ts
src/lib/results/signatures.ts                                  -- new: image loading + env-var resolver
src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx
src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/consolidated-form.tsx
src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/actions.ts
```

### Modify

```
src/lib/results/types.ts                  -- ResultDocumentInput gains reportGroup + signatures
src/lib/results/pdf-document.tsx          -- embed signature images; render group title; new SignatureBlock
src/lib/results/loaders.ts                -- load by results.id walking junction + group-level template
src/lib/results/preview-data.ts           -- preview support for group-level templates
src/app/(staff)/staff/(dashboard)/queue/page.tsx               -- group by (visit_id, report_group_id)
src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts        -- claim grouped
src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx          -- redirect grouped to consolidated route
src/app/(patient)/portal/results/page.tsx                      -- label resolution
.env.example                                                    -- three CONSULTANT_*_STAFF_ID vars
.gitignore                                                      -- scripts/seed/signatures/*.png
src/types/database.ts                                           -- regen after migrations
```

### Touchpoints (no code changes — referenced)

```
src/lib/supabase/admin.ts            -- createAdminClient()
src/lib/auth/require-staff.ts        -- requireActiveStaff()
src/lib/audit/log.ts                 -- audit()
src/lib/results/render-pdf.ts        -- renderResultPdf() — input shape changes via types
```

---

## Reference

- **Design spec:** `docs/superpowers/specs/2026-05-22-visit-consolidated-report-design.md` (authoritative)
- **Existing structured-results schema:** `supabase/migrations/0007_result_templates_and_values.sql` (templates + params + values)
- **Existing result-flip triggers:** `supabase/migrations/0001_init.sql` (initial) + `0008_structured_results_drafts.sql` (override)
- **PRC license editor pattern:** `src/app/(staff)/staff/(dashboard)/admin/users/[id]/edit/` (precedent for staff_profiles edits)
- **Storage bucket pattern:** `supabase/migrations/0017_physician_photos_bucket.sql` + `0045_payslip_bucket.sql` (precedents)
- **Smoke script pattern:** `scripts/smoke-14.sql` (lab_package), `scripts/smoke-12.4.sql` (AP)

---

## Pre-flight (one-time, user-driven) — RESOLVED

1. **Prices** — verified 2026-05-22: all chemistry services already exist with prices in the live DB (`FBS_RBS` ₱180, `BUN` ₱195, `CREATININE` ₱195, `BUA_URIC_ACID` ₱195, `TRIGLYCERIDES` ₱340, `CHOLESTEROL` ₱195, `HDL_LDL_VLDL` ₱380, `SGPT_ALT` ₱250, `SGOT_AST` ₱250, `HBA1C` ₱785, `LIPID_PROFILE` ₱875, `LIPID_PROFILE_PACKAGE` ₱875). No INSERTs needed in the seed migration.
2. **Six signature PNGs** — placed at `scripts/seed/signatures/{rillo,romeral,dylim,tagayuna,mariano,vicencio}.png` (2026-05-22).
3. **Env-vars** — `CONSULTANT_PATHOLOGIST_STAFF_ID`, `CONSULTANT_RADIOLOGIST_STAFF_ID`, `CONSULTANT_CARDIOLOGIST_STAFF_ID`. Task 3 Step 8 captures the staff_ids after the seed script writes them and the user populates `.env.local` + Vercel envs.

## Actual chemistry service inventory (verified against live DB, 2026-05-22)

| Service code | Maps to template rows | Notes |
|---|---|---|
| `FBS_RBS` | FBS | Single service for FBS or RBS; row labelled "FBS". |
| `BUN` | BUN | |
| `CREATININE` | Creatinine | Code is `CREATININE`, not `CREA` (which is `is_active=false`). |
| `BUA_URIC_ACID` | Uric Acid | Code is `BUA_URIC_ACID`, not `BUA`. |
| `TRIGLYCERIDES` | Triglycerides | Sold individually. |
| `CHOLESTEROL` | Cholesterol | Sold individually. |
| `HDL_LDL_VLDL` | HDL, LDL, VLDL | **One service → three rows.** |
| `SGPT_ALT` | SGPT (ALT) | Code is `SGPT_ALT`, not `SGPT`. |
| `SGOT_AST` | SGOT (AST) | Code is `SGOT_AST`, not `SGOT`. |
| `HBA1C` | HBA1C | |
| `LIPID_PROFILE` (lab_test) | Triglycerides, Cholesterol, HDL, LDL, VLDL | One service → 5 rows. Bundled lipid line. |
| `LIPID_PROFILE_PACKAGE` (lab_package) | — (decomposes) | Phase 14 fans out at order time into 3 components: CHOLESTEROL, TRIGLYCERIDES, HDL_LDL_VLDL. The package header itself doesn't carry chemistry rows; the components do. |

The 12 active services above all currently have their own active per-service result_template (verified). These templates get `is_active = false` in the migration, replaced by one Chemistry consolidated template.

Deprecated chemistry codes that exist `is_active=false` and must NOT be touched: `FBS`, `CREA`, `SGOT`, `SGPT`, `LIPID`.

---

## Task 1 — Schema migration foundation

**Files:**
- Create: `supabase/migrations/0051_consolidated_reports_and_signatures.sql`
- Create: `scripts/smoke-chemistry-consolidated.sql`
- Modify: `src/types/database.ts` (regen)

This task introduces the data model from spec §5 without yet seeding any chemistry rows. After this task, the junction exists, every existing `results` row has a corresponding junction row, the old `results.test_request_id` column is gone, and triggers / RLS walk the new path. Nothing user-visible changes yet.

**Pre-resolved facts** (verified against live DB 2026-05-22, no need to re-check):
- `staff_profiles` has no `auth_user_id` column; `staff_profiles.id` IS the auth.users.id (FK with on delete cascade). Migration just adds `signature_path` + `signature_uploaded_at`.
- All `results` rows in the live DB have a non-null `test_request_id`, so the backfill is straightforward.
- The current result-flip trigger is `public.flip_test_request_on_result` from migration `0008_structured_results_drafts.sql` — replace it in this migration.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/0051_consolidated_reports_and_signatures.sql`:

```sql
-- =============================================================================
-- 0051_consolidated_reports_and_signatures.sql
-- =============================================================================
-- Visit-consolidated reports + embedded signatures schema.
-- See docs/superpowers/specs/2026-05-22-visit-consolidated-report-design.md
-- for the design rationale.
--
-- Sequence (all in one transaction so RLS / triggers stay consistent):
--   1.  report_groups table + indexes
--   2.  services.report_group_id
--   3.  result_templates.report_group_id, nullable service_id, XOR check
--   4.  result_test_requests junction + indexes
--   5.  Backfill junction from results.test_request_id
--   6.  results.report_group_id, results.finalised_by_staff_id, drop test_request_id
--   7.  staff_profiles.signature_path, signature_uploaded_at
--   8.  Update result-flip triggers (0001 + 0008 overrides) to walk junction
--   9.  Update RLS policies on result_values to walk junction
--  10.  RLS on result_test_requests + report_groups
-- =============================================================================

-- ----- 1. report_groups ------------------------------------------------------

create table public.report_groups (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.report_groups enable row level security;

create policy "report_groups: staff read"
  on public.report_groups for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "report_groups: admin manage"
  on public.report_groups for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- ----- 2. services.report_group_id ------------------------------------------

alter table public.services
  add column report_group_id uuid references public.report_groups(id);

create index idx_services_report_group on public.services(report_group_id)
  where report_group_id is not null;

-- ----- 3. result_templates: group target ------------------------------------

alter table public.result_templates
  alter column service_id drop not null,
  add column report_group_id uuid references public.report_groups(id),
  add constraint result_templates_target_xor
    check (
      (service_id is not null and report_group_id is null) or
      (service_id is null and report_group_id is not null)
    );

create unique index uq_result_templates_report_group
  on public.result_templates(report_group_id)
  where report_group_id is not null;

-- ----- 4. result_test_requests junction -------------------------------------

create table public.result_test_requests (
  result_id        uuid not null references public.results(id) on delete cascade,
  test_request_id  uuid not null references public.test_requests(id) on delete restrict,
  created_at       timestamptz not null default now(),
  primary key (result_id, test_request_id)
);

-- Each test_request is reachable from at most one results row (preserves the
-- 1:1 invariant from the test_request side).
create unique index uq_result_test_requests_test_request
  on public.result_test_requests(test_request_id);

alter table public.result_test_requests enable row level security;

create policy "result_test_requests: staff read"
  on public.result_test_requests for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "result_test_requests: admin manage"
  on public.result_test_requests for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- ----- 5. Backfill junction --------------------------------------------------

insert into public.result_test_requests (result_id, test_request_id)
select id, test_request_id from public.results
where test_request_id is not null;

-- ----- 6. results deltas -----------------------------------------------------

alter table public.results
  add column report_group_id uuid references public.report_groups(id),
  add column finalised_by_staff_id uuid references public.staff_profiles(id),
  drop column test_request_id;

create index idx_results_report_group on public.results(report_group_id)
  where report_group_id is not null;

create index idx_results_finalised_by on public.results(finalised_by_staff_id);

-- ----- 7. staff_profiles deltas ---------------------------------------------
-- Note: staff_profiles.id IS auth.users.id (FK on delete cascade). There's no
-- separate auth_user_id column. Non-login consultants (Mariano, Vicencio,
-- Tagayuna if needed) get auth.users + staff_profiles rows created in
-- Task 3's seed-signatures.ts.

alter table public.staff_profiles
  add column signature_path text,
  add column signature_uploaded_at timestamptz;

-- ----- 8. Update result-flip triggers ---------------------------------------

-- The 0008 override is the active version; replace it. Walks the junction
-- and updates every linked test_request.
create or replace function public.flip_test_request_on_result()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_test_request_id   uuid;
  v_requires_signoff  boolean;
begin
  for v_test_request_id in
    select test_request_id
    from public.result_test_requests
    where result_id = new.id
  loop
    select coalesce(s.requires_signoff, false)
      into v_requires_signoff
    from public.test_requests tr
    join public.services s on s.id = tr.service_id
    where tr.id = v_test_request_id;

    update public.test_requests
       set status = case
         when v_requires_signoff then 'result_uploaded'
         else 'ready_for_release'
       end
     where id = v_test_request_id
       and status = 'in_progress';
  end loop;
  return new;
end;
$$;

-- ----- 9. Update result_values RLS to walk junction -------------------------

drop policy if exists "result_values: medtech write own claimed test" on public.result_values;
drop policy if exists "result_values: medtech update own claimed test" on public.result_values;
drop policy if exists "result_values: read by owning medtech + pathologist + admin" on public.result_values;

create policy "result_values: medtech write own claimed test"
  on public.result_values for insert to authenticated
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  );

create policy "result_values: medtech update own claimed test"
  on public.result_values for update to authenticated
  using (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  )
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  );

create policy "result_values: read by owning medtech + pathologist + admin"
  on public.result_values for select to authenticated
  using (
    public.has_role(array['pathologist', 'admin'])
    or exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and tr.assigned_to = auth.uid()
        and public.has_role(array['medtech'])
    )
  );
```

- [ ] **Step 2: Write the failing migration smoke**

Create `scripts/smoke-chemistry-consolidated.sql` with stage S0 only (more stages added in Task 2 and Task 7). For now, the smoke just verifies the schema exists:

```sql
-- =============================================================================
-- smoke-chemistry-consolidated.sql — S0: schema sanity
-- =============================================================================
\set ON_ERROR_STOP on

begin;

do $$
declare
  v_report_groups_exists  boolean;
  v_junction_exists       boolean;
  v_results_has_group     boolean;
  v_results_has_test_req  boolean;
  v_staff_has_sig         boolean;
begin
  select exists(select 1 from information_schema.tables
                where table_schema='public' and table_name='report_groups')
    into v_report_groups_exists;
  if not v_report_groups_exists then
    raise exception 'S0: report_groups table missing';
  end if;

  select exists(select 1 from information_schema.tables
                where table_schema='public' and table_name='result_test_requests')
    into v_junction_exists;
  if not v_junction_exists then
    raise exception 'S0: result_test_requests junction missing';
  end if;

  select exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='results'
                  and column_name='report_group_id')
    into v_results_has_group;
  if not v_results_has_group then
    raise exception 'S0: results.report_group_id column missing';
  end if;

  select exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='results'
                  and column_name='test_request_id')
    into v_results_has_test_req;
  if v_results_has_test_req then
    raise exception 'S0: results.test_request_id still present (should be dropped)';
  end if;

  select exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='staff_profiles'
                  and column_name='signature_path')
    into v_staff_has_sig;
  if not v_staff_has_sig then
    raise exception 'S0: staff_profiles.signature_path missing';
  end if;

  raise notice 'S0 schema sanity OK';
end $$;

rollback;
```

- [ ] **Step 3: Apply the migration to remote Supabase**

Apply via the Supabase MCP `apply_migration` tool (project_id `qhptbmafrosgibooelpp`, name `0051_consolidated_reports_and_signatures`, query = the SQL from Step 1).

Local `supabase db reset` is NOT used here — this project ships migrations directly to remote per CLAUDE.md, and the migration's backfill step depends on real data.

If the migration fails because backfill produces a `null` `test_request_id` row in the junction, investigate: there should be no orphan `results` rows. Fix at the data level, not by relaxing the migration. If the `flip_test_request_on_result` function name doesn't match what's currently installed (e.g., the 0008 override used a different name), update the `create or replace function` line accordingly — the goal is to replace the active trigger function with one that walks the junction.

- [ ] **Step 4: Run smoke against the post-migration DB — should pass**

Use the Supabase MCP `execute_sql` tool to run the smoke. Since `execute_sql` doesn't support multi-statement scripts with `do $$ ... $$` blocks the same way `psql` does, run each S0 assertion as a single statement, OR run the full smoke via a single `do $$ ... raise notice ... end $$;` block as one call.

Expected: `NOTICE: S0 schema sanity OK` (no exception raised).

- [ ] **Step 5: Regenerate types**

```bash
npm run db:types:remote
```

This regenerates `src/types/database.ts` from the remote DB. Expected: gains `report_groups` row type, `result_test_requests` row type, `report_group_id` / `finalised_by_staff_id` on `results`, `signature_path` / `signature_uploaded_at` on `staff_profiles`, drops `test_request_id` from `results`.

If `npm run db:types:remote` requires an env var (`SUPABASE_DB_URL`) that isn't set, fall back to using the Supabase CLI directly: `supabase gen types typescript --project-id qhptbmafrosgibooelpp > src/types/database.ts`.

- [ ] **Step 6: Find and fix every TypeScript reference to the dropped column**

```bash
npm run typecheck 2>&1 | grep "test_request_id"
```

Every match must be addressed. The most common patterns:

- Queries that did `.select('test_request_id')` on results now need to walk through `result_test_requests`. Update them to `.select('*, result_test_requests(test_request_id, test_requests(...))')`. Specific files to expect: `src/lib/results/loaders.ts`, `src/app/(staff)/staff/(dashboard)/queue/**`, `src/app/(patient)/portal/results/**`.
- For each match, edit the query and any downstream code that destructured `.test_request_id` to instead read `result_test_requests[0].test_request_id` (or iterate when grouped reports exist).

Re-run `npm run typecheck` until it's clean.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0051_consolidated_reports_and_signatures.sql \
        scripts/smoke-chemistry-consolidated.sql \
        src/types/database.ts \
        src/lib/results/loaders.ts \
        $(git diff --name-only | grep -v '^supabase/\|^scripts/\|^src/types/')
git commit -m "$(cat <<'EOF'
feat(results): junction table + report_groups schema (12.5 D1)

Introduces report_groups, result_test_requests junction, results
deltas (drop test_request_id, add report_group_id +
finalised_by_staff_id), staff_profiles signature columns, and updates
the result-flip trigger plus result_values RLS to walk the junction.
No chemistry data seeded yet — that's D2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Chemistry consolidated template seed

**Files:**
- Create: `supabase/migrations/0053_chemistry_seed.sql`
- Modify: `scripts/smoke-chemistry-consolidated.sql` (append S1)

This task seeds the Chemistry `report_group`, maps all 12 active chemistry services to the group, deactivates per-service Chemistry-overlapping templates, and inserts the consolidated 13-row template with SI + conventional ranges and gender-specific overrides.

No service inserts needed — all chemistry services already exist in the DB (verified pre-flight).

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/0053_chemistry_seed.sql`:

```sql
-- =============================================================================
-- 0053_chemistry_seed.sql
-- =============================================================================
-- Chemistry consolidated form seed.
--
-- 1. Insert the CHEMISTRY report_group.
-- 2. Map 12 active chemistry services to the group:
--      FBS_RBS, BUN, CREATININE, BUA_URIC_ACID, TRIGLYCERIDES, CHOLESTEROL,
--      HDL_LDL_VLDL, SGPT_ALT, SGOT_AST, HBA1C, LIPID_PROFILE,
--      LIPID_PROFILE_PACKAGE.
-- 3. Deactivate the per-service Chemistry-overlapping templates for those
--    12 services (replaced by one consolidated template keyed by group).
-- 4. Insert the 13-row consolidated dual_unit template + 14 param rows
--    (Creatinine and Uric Acid have gender-specific overrides → 2 rows each).
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- ----- 1. Chemistry report group --------------------------------------------

insert into public.report_groups (code, name)
values ('CHEMISTRY', 'Chemistry')
on conflict (code) do nothing;

-- ----- 2. Map active chemistry services to the group ------------------------
-- All 12 codes verified active in live DB 2026-05-22.

update public.services
   set report_group_id = (select id from public.report_groups where code='CHEMISTRY')
 where code in (
   'FBS_RBS', 'BUN', 'CREATININE', 'BUA_URIC_ACID',
   'TRIGLYCERIDES', 'CHOLESTEROL', 'HDL_LDL_VLDL',
   'SGPT_ALT', 'SGOT_AST', 'HBA1C',
   'LIPID_PROFILE', 'LIPID_PROFILE_PACKAGE'
 );

-- ----- 3. Deactivate per-service Chemistry-overlapping templates ------------
-- All 12 active services currently have their own per-service template; those
-- are replaced by the single consolidated template inserted below.

update public.result_templates
   set is_active = false
 where service_id in (
   select id from public.services
    where code in (
      'FBS_RBS', 'BUN', 'CREATININE', 'BUA_URIC_ACID',
      'TRIGLYCERIDES', 'CHOLESTEROL', 'HDL_LDL_VLDL',
      'SGPT_ALT', 'SGOT_AST', 'HBA1C',
      'LIPID_PROFILE', 'LIPID_PROFILE_PACKAGE'
    )
 );

-- ----- 4. Chemistry consolidated template -----------------------------------

with new_tpl as (
  insert into public.result_templates (service_id, report_group_id, layout,
                                       header_notes, footer_notes, is_active)
  values (
    null,
    (select id from public.report_groups where code='CHEMISTRY'),
    'dual_unit',
    null,
    null,
    true
  )
  returning id
)
insert into public.result_template_params
  (template_id, sort_order, section, is_section_header, parameter_name,
   input_type, unit_si, unit_conv,
   ref_low_si, ref_high_si, ref_low_conv, ref_high_conv,
   gender, si_to_conv_factor, allowed_values, abnormal_values, placeholder)
select t.id, x.sort_order, null, false, x.parameter_name,
       'numeric', x.unit_si, x.unit_conv,
       x.ref_low_si, x.ref_high_si, x.ref_low_conv, x.ref_high_conv,
       x.gender, x.si_to_conv_factor, null, null, null
  from new_tpl t
  cross join (values
    -- (sort_order, parameter_name, unit_si, unit_conv,
    --  ref_low_si, ref_high_si, ref_low_conv, ref_high_conv,
    --  gender, si_to_conv_factor)
    (10,  'FBS',           'mmol/L', 'mg/dL', 4.1::numeric,   5.9::numeric,
                                              73.87::numeric, 106.31::numeric,
                                              null::text,     18.0182::numeric),
    (20,  'BUN',           'mmol/L', 'mg/dL', 2.1::numeric,   7.1::numeric,
                                              5.88::numeric,  19.89::numeric,
                                              null::text,     2.8::numeric),
    (30,  'Creatinine',    'umol/L', 'mg/dL', 45::numeric,    84::numeric,
                                              0.51::numeric,  0.95::numeric,
                                              'F'::text,      0.0113::numeric),
    (31,  'Creatinine',    'umol/L', 'mg/dL', 59::numeric,    104::numeric,
                                              0.67::numeric,  1.18::numeric,
                                              'M'::text,      0.0113::numeric),
    (40,  'Uric Acid',     'umol/L', 'mg/dL', 142::numeric,   339::numeric,
                                              2.38::numeric,  5.7::numeric,
                                              'F'::text,      0.01681::numeric),
    (41,  'Uric Acid',     'umol/L', 'mg/dL', 202.3::numeric, 416.5::numeric,
                                              3.4::numeric,   6.99::numeric,
                                              'M'::text,      0.01681::numeric),
    (50,  'Triglycerides', 'mmol/L', 'mg/dL', 0::numeric,     1.7::numeric,
                                              0::numeric,     150.44::numeric,
                                              null::text,     88.5::numeric),
    (60,  'Cholesterol',   'mmol/L', 'mg/dL', 0::numeric,     5.2::numeric,
                                              0::numeric,     200::numeric,
                                              null::text,     38.6::numeric),
    (70,  'HDL',           'mmol/L', 'mg/dL', 0.78::numeric,  2.2::numeric,
                                              30::numeric,    85::numeric,
                                              null::text,     38.46::numeric),
    (80,  'LDL',           'mmol/L', 'mg/dL', 0::numeric,     3.3::numeric,
                                              0::numeric,     127.41::numeric,
                                              null::text,     38.6::numeric),
    (90,  'VLDL',          'mmol/L', 'mg/dL', 0::numeric,     0.78::numeric,
                                              0::numeric,     30::numeric,
                                              null::text,     38.46::numeric),
    (100, 'SGPT (ALT)',    'U/L',    'U/L',   0::numeric,     41::numeric,
                                              0::numeric,     41::numeric,
                                              null::text,     1::numeric),
    (110, 'SGOT (AST)',    'U/L',    'U/L',   0::numeric,     37::numeric,
                                              0::numeric,     37::numeric,
                                              null::text,     1::numeric),
    (120, 'HBA1C',         '%',      '%',     4.5::numeric,   6.5::numeric,
                                              4.5::numeric,   6.5::numeric,
                                              null::text,     1::numeric)
  ) as x(sort_order, parameter_name, unit_si, unit_conv,
         ref_low_si, ref_high_si, ref_low_conv, ref_high_conv,
         gender, si_to_conv_factor);

commit;
```

- [ ] **Step 2: Append S1 smoke**

Edit `scripts/smoke-chemistry-consolidated.sql`. Replace the closing `rollback;` with the following appended block, then close with `rollback;` again:

```sql
-- =============================================================================
-- S1: Chemistry seed sanity
-- =============================================================================
do $$
declare
  v_group_id   uuid;
  v_tpl_id     uuid;
  v_param_cnt  int;
  v_svc_cnt    int;
begin
  select id into v_group_id
    from public.report_groups
   where code = 'CHEMISTRY';
  if v_group_id is null then
    raise exception 'S1: CHEMISTRY report_group missing';
  end if;

  select id into v_tpl_id
    from public.result_templates
   where report_group_id = v_group_id and is_active;
  if v_tpl_id is null then
    raise exception 'S1: active Chemistry template missing';
  end if;

  select count(*) into v_param_cnt
    from public.result_template_params
   where template_id = v_tpl_id;
  if v_param_cnt <> 14 then
    raise exception 'S1: expected 14 Chemistry params (12 + 2 gender Creatinine/UricAcid), got %', v_param_cnt;
  end if;

  select count(*) into v_svc_cnt
    from public.services
   where report_group_id = v_group_id and is_active;
  if v_svc_cnt < 11 then
    raise exception 'S1: expected ≥11 active Chemistry services, got %', v_svc_cnt;
  end if;

  raise notice 'S1 chemistry seed OK (% params, % services)', v_param_cnt, v_svc_cnt;
end $$;
```

(The param count of 14 covers 12 single-gender params + 2 gender-split params for Creatinine and Uric Acid.)

- [ ] **Step 3: Apply migration locally**

```bash
supabase db reset
```

Expected: all migrations 0001 through 0053 apply cleanly.

- [ ] **Step 4: Run smoke — expect S0 + S1 to pass**

```bash
psql "$SUPABASE_DB_URL" -f scripts/smoke-chemistry-consolidated.sql
```

Expected:
```
NOTICE:  S0 schema sanity OK
NOTICE:  S1 chemistry seed OK (14 params, 12 services)
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0053_chemistry_seed.sql scripts/smoke-chemistry-consolidated.sql
git commit -m "$(cat <<'EOF'
feat(results): chemistry consolidated template + group mapping (12.5 D2)

Seeds the CHEMISTRY report_group, the 13-row consolidated template
with SI + conventional ranges and gender-specific Creatinine/Uric
Acid overrides, and maps the 12 active chemistry services to the
group (FBS_RBS, BUN, CREATININE, BUA_URIC_ACID, TRIGLYCERIDES,
CHOLESTEROL, HDL_LDL_VLDL, SGPT_ALT, SGOT_AST, HBA1C, LIPID_PROFILE,
LIPID_PROFILE_PACKAGE). Deactivates the 12 per-service templates
they previously used.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Signatures bucket + seed script + consultant staff_profiles

**Files:**
- Create: `supabase/migrations/0052_signatures_bucket.sql`
- Create: `scripts/seed-signatures.ts`
- Create: `scripts/seed/signatures/.gitkeep`
- Modify: `.gitignore`

Migration `0052` is filed between `0051` and `0053` numerically so the bucket exists before any code references it. Re-applying via `supabase db reset` runs them in lexical order — fine.

- [ ] **Step 1: Bucket migration**

Create `supabase/migrations/0052_signatures_bucket.sql`:

```sql
-- =============================================================================
-- 0052_signatures_bucket.sql
-- =============================================================================
-- Private Storage bucket for staff signature PNGs. Read access is
-- service-role-only; the PDF renderer fetches bytes via the admin client.
-- Authenticated users have no access — there's no signed-URL or public
-- pathway. The signature is embedded into the rendered PDF and never served
-- as a standalone resource.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('signatures', 'signatures', false)
on conflict (id) do nothing;

-- Deny-all to authenticated; service-role bypasses RLS by design.
create policy "signatures: deny all to authenticated read"
  on storage.objects for select to authenticated
  using (bucket_id <> 'signatures');

create policy "signatures: deny all to authenticated write"
  on storage.objects for insert to authenticated
  with check (bucket_id <> 'signatures');

create policy "signatures: deny all to authenticated update"
  on storage.objects for update to authenticated
  using (bucket_id <> 'signatures');

create policy "signatures: deny all to authenticated delete"
  on storage.objects for delete to authenticated
  using (bucket_id <> 'signatures');
```

Note: these policies are negative — they explicitly carve out signatures from any other broad authenticated policies the project may have. If the existing `storage.objects` policies are already strict (deny by default), the `signatures` bucket simply gets no policy of its own and remains service-role-only. Verify by reading existing `payslip_bucket` migration (`0045`) and matching its pattern; copy that approach if the deny-by-default invariant already holds.

- [ ] **Step 2: Seed-signatures script**

Create `scripts/seed-signatures.ts`:

```typescript
// Usage: npm run seed:signatures
//   Reads PNG files from scripts/seed/signatures/ (excluded from git),
//   uploads each to the private 'signatures' bucket, and updates the
//   matching staff_profiles row with the bucket path.
//
// The script also creates staff_profiles rows for Mariano (radiologist) and
// Vicencio (cardiologist) on first run — they're not active DRMed staff but
// their PRC + signature metadata must exist for the renderer.
//
// Filenames in scripts/seed/signatures/ map to staff_profiles full names via
// the manifest below. Adjust if you've named the files differently.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createAdminClient } from "../src/lib/supabase/admin";

const SIG_DIR = join(process.cwd(), "scripts", "seed", "signatures");

// (filename, full_name, prc_license_no, prc_license_kind)
// Filenames intentionally use a stable short slug — the user is expected to
// rename their downloaded PNGs to match these.
const MANIFEST = [
  {
    filename: "rillo.png",
    full_name: "JELOME SUZETTE RILLO",
    role: "medtech",
    prc_license_no: "0063443",
    prc_license_kind: "RMT",
  },
  {
    filename: "romeral.png",
    full_name: "PRINCESS MARA ROMERAL",
    role: "medtech",
    prc_license_no: "0139409",
    prc_license_kind: "RMT",
  },
  {
    filename: "dylim.png",
    full_name: "FREYA MARY JILLIANNE DYLIM",
    role: "medtech",
    prc_license_no: "0069135",
    prc_license_kind: "RMT",
  },
  {
    filename: "tagayuna.png",
    full_name: "PEDRITO Y. TAGAYUNA, MD, FPSP",
    role: "pathologist",
    prc_license_no: "0089935",
    prc_license_kind: "MD",
  },
  {
    filename: "mariano.png",
    full_name: "DANIEL JOHN F. MARIANO, MD, FPCR, FUSP, FCTMRISP, FDBISP",
    role: null,  // not an interactive DRMed staff role; render-only
    prc_license_no: "0098739",
    prc_license_kind: "MD",
  },
  {
    filename: "vicencio.png",
    full_name: "ROBERT ALAIN VICENCIO, MD",
    role: null,
    prc_license_no: "0087903",
    prc_license_kind: "MD",
  },
] as const;

async function main() {
  const supabase = createAdminClient();

  for (const entry of MANIFEST) {
    const localPath = join(SIG_DIR, entry.filename);
    if (!existsSync(localPath)) {
      console.error(`Missing PNG: ${localPath}`);
      console.error("Place the file in scripts/seed/signatures/ and re-run.");
      process.exit(1);
    }
    const bytes = readFileSync(localPath);
    const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 12);

    // Look up or create staff_profile by full_name (case-insensitive).
    const { data: existing, error: lookupErr } = await supabase
      .from("staff_profiles")
      .select("id, signature_path")
      .ilike("full_name", entry.full_name)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;

    let staffId: string;
    if (existing) {
      staffId = existing.id;
      // Patch PRC info in case the row pre-dates the PRC editor.
      await supabase
        .from("staff_profiles")
        .update({
          prc_license_no: entry.prc_license_no,
          prc_license_kind: entry.prc_license_kind,
        })
        .eq("id", staffId);
    } else {
      const { data: created, error: createErr } = await supabase
        .from("staff_profiles")
        .insert({
          full_name: entry.full_name,
          role: entry.role,
          auth_user_id: null,
          prc_license_no: entry.prc_license_no,
          prc_license_kind: entry.prc_license_kind,
          is_active: true,
        })
        .select("id")
        .single();
      if (createErr) throw createErr;
      staffId = created.id;
    }

    const bucketPath = `${staffId}/${sha}.png`;
    const { error: uploadErr } = await supabase.storage
      .from("signatures")
      .upload(bucketPath, bytes, {
        contentType: "image/png",
        upsert: true,
      });
    if (uploadErr) throw uploadErr;

    const { error: updateErr } = await supabase
      .from("staff_profiles")
      .update({
        signature_path: bucketPath,
        signature_uploaded_at: new Date().toISOString(),
      })
      .eq("id", staffId);
    if (updateErr) throw updateErr;

    console.log(`✓ ${entry.full_name} → ${bucketPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add npm script**

Edit `package.json` to add a script. Find the existing `"seed:..."` block and append:

```json
"seed:signatures": "tsx scripts/seed-signatures.ts",
```

- [ ] **Step 4: Gitignore + placeholder**

```bash
mkdir -p scripts/seed/signatures
touch scripts/seed/signatures/.gitkeep
```

Append to `.gitignore`:

```
scripts/seed/signatures/*.png
scripts/seed/signatures/*.jpg
```

- [ ] **Step 5: Apply bucket migration**

```bash
supabase db reset
```

Expected: 0052 applies cleanly. Bucket exists in local Storage UI.

- [ ] **Step 6: User places PNGs in `scripts/seed/signatures/`**

Pause. The agent asks:

> "Please drop the six signature PNG files into `scripts/seed/signatures/` with these exact filenames: `rillo.png`, `romeral.png`, `dylim.png`, `tagayuna.png`, `mariano.png`, `vicencio.png`. Reply 'ready' when done."

- [ ] **Step 7: Run the seed**

```bash
npm run seed:signatures
```

Expected: six `✓ <name> → <staff_id>/<sha>.png` lines and exit 0.

- [ ] **Step 8: Capture staff_ids for env vars**

```bash
psql "$SUPABASE_DB_URL" -At -c "
  select prc_license_no, id from public.staff_profiles
   where prc_license_no in ('0089935','0098739','0087903')
   order by prc_license_no;
"
```

Expected: three rows. Tell the user:

> "Add to `.env.local` (and Vercel preview + production):
> ```
> CONSULTANT_PATHOLOGIST_STAFF_ID=<id for 0089935 Tagayuna>
> CONSULTANT_RADIOLOGIST_STAFF_ID=<id for 0098739 Mariano>
> CONSULTANT_CARDIOLOGIST_STAFF_ID=<id for 0087903 Vicencio>
> ```"

- [ ] **Step 9: Update `.env.example`**

Append to `.env.example`:

```
# Consultant staff IDs for auto-included signatures on rendered result PDFs.
# Required in production + preview. Values are staff_profiles.id UUIDs.
CONSULTANT_PATHOLOGIST_STAFF_ID=
CONSULTANT_RADIOLOGIST_STAFF_ID=
CONSULTANT_CARDIOLOGIST_STAFF_ID=
```

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/0052_signatures_bucket.sql \
        scripts/seed-signatures.ts \
        scripts/seed/signatures/.gitkeep \
        .gitignore .env.example package.json
git commit -m "$(cat <<'EOF'
feat(results): signatures bucket + seed script (12.5 D3)

Private Supabase Storage bucket plus a tsx seed script that uploads
six staff signature PNGs (3 medtechs, 1 pathologist, 1 radiologist,
1 cardiologist) and writes the bucket path onto staff_profiles. PNGs
themselves are gitignored. Adds CONSULTANT_*_STAFF_ID env vars to
.env.example.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Renderer: signature image embedding

**Files:**
- Create: `src/lib/results/signatures.ts`
- Modify: `src/lib/results/pdf-document.tsx`
- Modify: `src/lib/results/types.ts`
- Modify: `src/lib/results/loaders.ts`

This task changes the rendered PDF footer to embed real PNG signatures plus the auto-included consultant pathologist column. The chemistry consolidated template isn't yet rendered as one PDF (that's Task 5); existing per-service templates render with new signatures immediately.

- [ ] **Step 1: New signature helper module**

Create `src/lib/results/signatures.ts`:

```typescript
// Server-only signature image loader.
//
// Resolves the consultant staff IDs from env vars, fetches each
// staff_profiles row, downloads the PNG bytes from the private
// 'signatures' bucket via the admin client, and returns a typed payload
// for embedding into the PDF. Throws on any misconfiguration (missing
// env var, missing staff_profile, missing signature_path) — render
// must fail-fast rather than ship a PDF with a missing signature.

import { createAdminClient } from "@/lib/supabase/admin";

export interface SignatureBlockData {
  full_name: string;
  prc_license_no: string | null;
  prc_license_kind: string | null;
  png_bytes: Buffer | null;
}

const REQUIRED_ENV = [
  "CONSULTANT_PATHOLOGIST_STAFF_ID",
  "CONSULTANT_RADIOLOGIST_STAFF_ID",
  "CONSULTANT_CARDIOLOGIST_STAFF_ID",
] as const;

function requireEnv(key: (typeof REQUIRED_ENV)[number]): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(
      `${key} env var is required for result PDF rendering — see .env.example.`,
    );
  }
  return v;
}

export async function loadConsultantSignatures(): Promise<{
  pathologist: SignatureBlockData;
  radiologist: SignatureBlockData;
  cardiologist: SignatureBlockData;
}> {
  const ids = {
    pathologist: requireEnv("CONSULTANT_PATHOLOGIST_STAFF_ID"),
    radiologist: requireEnv("CONSULTANT_RADIOLOGIST_STAFF_ID"),
    cardiologist: requireEnv("CONSULTANT_CARDIOLOGIST_STAFF_ID"),
  };
  return {
    pathologist: await loadSignatureForStaff(ids.pathologist),
    radiologist: await loadSignatureForStaff(ids.radiologist),
    cardiologist: await loadSignatureForStaff(ids.cardiologist),
  };
}

export async function loadSignatureForStaff(
  staffId: string,
): Promise<SignatureBlockData> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("staff_profiles")
    .select("full_name, prc_license_no, prc_license_kind, signature_path")
    .eq("id", staffId)
    .single();
  if (error) {
    throw new Error(
      `Failed to load staff_profile ${staffId} for signature: ${error.message}`,
    );
  }

  let png_bytes: Buffer | null = null;
  if (data.signature_path) {
    const { data: file, error: dlErr } = await admin.storage
      .from("signatures")
      .download(data.signature_path);
    if (dlErr) {
      throw new Error(
        `Failed to download signature ${data.signature_path}: ${dlErr.message}`,
      );
    }
    png_bytes = Buffer.from(await file.arrayBuffer());
  }

  return {
    full_name: data.full_name,
    prc_license_no: data.prc_license_no,
    prc_license_kind: data.prc_license_kind,
    png_bytes,
  };
}
```

- [ ] **Step 2: Extend `ResultDocumentInput` type**

Edit `src/lib/results/types.ts`. Locate the `ResultDocumentInput` interface and add:

```typescript
export interface ResultDocumentInput {
  // ...existing fields...

  /**
   * Performing professional whose signature appears in the second column.
   * For lab tests this is the medtech who finalised. For X-ray and
   * ultrasound this is the consultant radiologist (auto-included from env).
   * For ECG it's the consultant cardiologist.
   *
   * Replaces the legacy `medtech` field below — keep `medtech` populated
   * for backwards compat with one render path that hasn't migrated yet,
   * but new render paths use `performer`.
   */
  performer: {
    full_name: string;
    prc_license_no: string | null;
    prc_license_kind: string | null;
    png_bytes: Buffer | null;
  } | null;

  /**
   * Always rendered in the first column on every DRMed-generated PDF.
   * Auto-included via CONSULTANT_PATHOLOGIST_STAFF_ID env var.
   */
  consultantPathologist: {
    full_name: string;
    prc_license_no: string | null;
    prc_license_kind: string | null;
    png_bytes: Buffer | null;
  };
}
```

(The legacy `medtech` field remains on the interface for backwards compatibility; callers gradually switch to `performer`.)

- [ ] **Step 3: Rewrite `SignatureBlock` in `pdf-document.tsx`**

Edit `src/lib/results/pdf-document.tsx`. Replace the existing `SignatureBlock` and `SignatureColumn` functions (lines 545–600) with:

```tsx
function SignatureColumn({
  data,
  defaultRole,
}: {
  data: ResultDocumentInput["performer"] | ResultDocumentInput["consultantPathologist"] | null;
  defaultRole: string;
}) {
  const name = data?.full_name ?? "—";
  const license = data?.prc_license_no
    ? `PRC License No. ${data.prc_license_no}`
    : "PRC License No. —";
  const role = roleLabel(data?.prc_license_kind, defaultRole);
  return (
    <View style={styles.signatureCol}>
      {data?.png_bytes ? (
        // eslint-disable-next-line jsx-a11y/alt-text
        <Image src={data.png_bytes} style={styles.signatureImage} />
      ) : (
        <View style={{ height: 32 }} />
      )}
      <View style={styles.signatureNameRow}>
        <Text style={styles.signatureName}>{name}</Text>
      </View>
      <View style={styles.signatureUnderline} />
      <Text style={styles.signatureRole}>{role}</Text>
      <Text style={styles.signatureLicense}>{license}</Text>
    </View>
  );
}

function roleLabel(
  kind: string | null | undefined,
  fallback: string,
): string {
  if (kind === "RMT") return "Medical Technologist";
  if (kind === "RT") return "Radiologic Technologist";
  if (kind === "MD") return fallback;
  return fallback;
}

function SignatureBlock({
  performer,
  consultantPathologist,
}: {
  performer: ResultDocumentInput["performer"];
  consultantPathologist: ResultDocumentInput["consultantPathologist"];
}) {
  return (
    <View style={styles.signatureBlock}>
      <SignatureColumn
        data={consultantPathologist}
        defaultRole="Pathologist"
      />
      <SignatureColumn
        data={performer}
        defaultRole={
          performer?.prc_license_kind === "MD"
            ? "Consultant"
            : "Medical Technologist"
        }
      />
    </View>
  );
}
```

Add a new style entry inside the `StyleSheet.create(...)` block (find the `signatureBlock` style and add `signatureImage` right after the `signatureLicense` entry):

```typescript
signatureImage: {
  width: 110,
  height: 32,
  objectFit: "contain",
  marginBottom: -4,
  alignSelf: "center",
},
```

(The QC column is removed — spec §8.4 only calls for two columns. Removing it keeps the footer width sensible.)

Update the `signatureBlock` style to `justifyContent: "space-around"` (was `"space-between"`) so the two columns flank the page centre instead of hugging the edges.

- [ ] **Step 4: Wire the new fields through `ResultDocument`**

In the same file, edit the top-level `ResultDocument` function (around line 1268) to pass the new props:

```tsx
<SignatureBlock
  performer={input.performer}
  consultantPathologist={input.consultantPathologist}
/>
```

Replace the old `<SignatureBlock medtech={input.medtech} />` line.

- [ ] **Step 5: Update the three inline `ResultDocumentInput` builders**

`ResultDocumentInput` is built inline in three places — not in `loaders.ts`. The locations:

1. `src/app/(staff)/staff/(dashboard)/admin/result-templates/preview/[service_id]/route.ts` (~line 57)
2. `src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts` (~lines 485 and 1315)
3. `src/app/(patient)/portal/(authenticated)/actions.ts` (~line 226)

Add a small helper to centralise performer + consultant-pathologist resolution. Add a new function to `src/lib/results/signatures.ts`:

```typescript
import type { Database } from "@/types/database";
type ServiceRow = { code: string; kind: string | null };

/**
 * Resolves the "performer" signature column for a given service or report
 * group. For imaging (X-ray, ultrasound) the consultant radiologist signs.
 * For ECG the consultant cardiologist signs. For everything else (lab),
 * the staff member identified by finalisedByStaffId signs.
 *
 * Returns `null` if there's no finaliser yet (e.g. preview-route render
 * before encoding). Callers fall back to a typed-name-only column.
 */
export async function resolvePerformer(args: {
  service: ServiceRow | null;
  finalisedByStaffId: string | null;
}): Promise<SignatureBlockData | null> {
  const code = args.service?.code ?? "";
  const kind = args.service?.kind ?? "";
  const consultants = await loadConsultantSignatures();

  if (/^XRAY|^US|^ULTRASOUND/i.test(code) || kind === "imaging") {
    return consultants.radiologist;
  }
  if (/^ECG/i.test(code)) {
    return consultants.cardiologist;
  }
  if (args.finalisedByStaffId) {
    return await loadSignatureForStaff(args.finalisedByStaffId);
  }
  return null;
}
```

Then, in each of the three call sites, after fetching the existing data needed to construct the input, add:

```typescript
import { loadConsultantSignatures, resolvePerformer } from "@/lib/results/signatures";

// inside the function, after `service` and `medtech` are resolved:
const consultants = await loadConsultantSignatures();
const performer = await resolvePerformer({
  service: service ? { code: service.code, kind: service.kind ?? null } : null,
  finalisedByStaffId:
    /* in the queue actions: the results.finalised_by_staff_id you just inserted;
       in the preview route: null;
       in the portal cover-page action: results.finalised_by_staff_id from the
       fetched results row. */
});

// then in the ResultDocumentInput literal, add the two fields:
const docInput: ResultDocumentInput = {
  // ...existing fields...
  performer,
  consultantPathologist: consultants.pathologist,
  // keep `medtech` populated as before for compatibility
};
```

For the preview route specifically (`route.ts:57`), pass `finalisedByStaffId: null` — the preview shows the signature columns blank-ready.

For the queue actions (`actions.ts:485` and `:1315`), add `results.finalised_by_staff_id` to the select projection on the results table and pass it through.

For the portal cover-page action (`actions.ts:226`), the portal already reads the released results row; add `finalised_by_staff_id` to its select and pass it through.

- [ ] **Step 6: Render smoke**

Update `scripts/smoke-render-results.ts` to assert the consultant pathologist's PRC number is present in the rendered PDF bytes. Append at the end of the existing main function (the script already loops over `SERVICE_CODES` and renders each):

```typescript
// Assert that every rendered PDF carries the consultant pathologist's PRC.
// (PRC 0089935 = TAGAYUNA, set via CONSULTANT_PATHOLOGIST_STAFF_ID.)
for (const code of SERVICE_CODES) {
  const buf = renderedBuffers.get(code);
  if (!buf) continue;
  const text = buf.toString("latin1");
  if (!text.includes("0089935")) {
    throw new Error(
      `Rendered ${code} PDF missing consultant pathologist PRC 0089935`,
    );
  }
}
console.log("✓ consultant pathologist signature present on all rendered PDFs");
```

(`renderedBuffers` is a `Map<code, Buffer>` populated earlier in the script. If the existing script doesn't keep buffers around, capture each one in a local map before the smoke assertions.)

- [ ] **Step 7: Run renderer + smoke**

```bash
npm run smoke:results
```

Expected: existing render smoke passes (no regression) and the new signature assertion is reachable.

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: clean. Loaders, the PDF document, and any caller of `ResultDocumentInput` must compile against the new shape.

- [ ] **Step 9: Commit**

```bash
git add src/lib/results/signatures.ts \
        src/lib/results/pdf-document.tsx \
        src/lib/results/types.ts \
        src/lib/results/loaders.ts \
        scripts/smoke-render-results.ts
git commit -m "$(cat <<'EOF'
feat(results): embed signature images on rendered PDFs (12.5 D4)

Adds a signature loader that resolves CONSULTANT_*_STAFF_ID env vars,
fetches PNGs from the private signatures bucket, and embeds them
into the PDF footer. Rewrites SignatureBlock to a two-column layout
(consultant pathologist + performer). Performer is the radiologist
for imaging, cardiologist for ECG, or the finalising medtech for lab
tests. Loaders.ts populates the new performer + consultantPathologist
fields on ResultDocumentInput.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Renderer: group-level templates + Chemistry rendering

**Files:**
- Modify: `src/lib/results/types.ts`
- Modify: `src/lib/results/pdf-document.tsx`
- Modify: `src/lib/results/loaders.ts`
- Modify: `src/lib/results/preview-data.ts`

After this task, a `results` row whose `report_group_id` is non-null renders the consolidated chemistry form (13-row dual-unit layout, blank rows for un-ordered tests, group name as title).

- [ ] **Step 1: Add `reportGroup` to `ResultDocumentInput`**

Edit `src/lib/results/types.ts`. Where `service` is declared on `ResultDocumentInput`, mark it optional and add a sibling:

```typescript
export interface ResultDocumentInput {
  // ...existing fields...

  /**
   * Set when the results row covers multiple test_requests of the same
   * report_group (e.g. Chemistry). Mutually exclusive with `service`.
   */
  reportGroup?: {
    code: string;     // e.g. 'CHEMISTRY'
    name: string;     // e.g. 'Chemistry'
    /** Display chips for the actually-ordered tests on this visit. */
    orderedTests: Array<{ code: string; name: string }>;
  };

  /**
   * Single-service results keep this populated as today. Grouped results
   * leave it undefined and use `reportGroup` instead.
   */
  service?: ResultDocumentInput["service"];
}
```

(Find the existing `service` field; change `service:` to `service?:`. If TypeScript flags any non-null callsite, add `if (input.service)` guards as you go — Step 3 also touches the renderer.)

- [ ] **Step 2: New `loadResultDocumentInput` helper in `loaders.ts`**

`ResultDocumentInput` is currently built inline in three places (preview route, queue actions, portal cover action). The consolidated form (Task 6) needs the same logic for grouped results, so introduce a shared helper. Append to `src/lib/results/loaders.ts`:

```typescript
import { createAdminClient } from "@/lib/supabase/admin";
import { loadConsultantSignatures, resolvePerformer } from "./signatures";
import type {
  ResultDocumentInput,
  ResultLayout,
} from "./types";

/**
 * Builds a complete ResultDocumentInput for a given results.id. Handles
 * both single-service results (results.report_group_id is null) and
 * consolidated group results (results.report_group_id is set).
 *
 * Used by:
 *   - finaliseConsolidatedReport (the new consolidated-form action)
 *   - any future caller that needs a one-stop render-input loader
 *
 * The three existing inline builders (preview route, queue actions,
 * portal cover action) are NOT replaced by this helper in this plan —
 * that's a follow-up DRY refactor.
 */
export async function loadResultDocumentInput(
  resultId: string,
): Promise<ResultDocumentInput> {
  const admin = createAdminClient();

  const { data: results, error: rErr } = await admin
    .from("results")
    .select(
      "id, control_no, finalised_at, finalised_by_staff_id, report_group_id",
    )
    .eq("id", resultId)
    .single();
  if (rErr || !results) {
    throw new Error(`loadResultDocumentInput: results ${resultId} not found`);
  }

  // Junction → test_requests → services → visits → patients
  const { data: linked, error: lErr } = await admin
    .from("result_test_requests")
    .select(
      "test_requests!inner(id, visit_id, service_id, " +
        "services!inner(id, code, name, kind, report_group_id), " +
        "visits!inner(id, visit_number, " +
          "patients!inner(drm_id, last_name, first_name, sex, birthdate)))",
    )
    .eq("result_id", resultId);
  if (lErr || !linked || linked.length === 0) {
    throw new Error(
      `loadResultDocumentInput: no junction rows for results ${resultId}`,
    );
  }

  // All linked test_requests share the same visit + patient.
  const first = linked[0].test_requests;
  const patient = first.visits.patients;
  const visit = first.visits;

  // Template: keyed by report_group_id when grouped, else by service_id.
  const templateMatch = results.report_group_id
    ? { report_group_id: results.report_group_id, is_active: true }
    : { service_id: first.services.id, is_active: true };
  const { data: template, error: tErr } = await admin
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes")
    .match(templateMatch)
    .single();
  if (tErr || !template) {
    throw new Error(
      `loadResultDocumentInput: no active template for results ${resultId}`,
    );
  }

  const params = await loadTemplateParams(admin, template.id);

  const { data: valueRows } = await admin
    .from("result_values")
    .select(
      "parameter_id, numeric_value_si, numeric_value_conv, text_value, " +
        "select_value, flag, is_blank",
    )
    .eq("result_id", resultId);

  const values: ResultDocumentInput["values"] = {};
  for (const v of valueRows ?? []) {
    values[v.parameter_id] = {
      numeric_value_si: v.numeric_value_si,
      numeric_value_conv: v.numeric_value_conv,
      text_value: v.text_value,
      select_value: v.select_value,
      flag: v.flag as "H" | "L" | "A" | null,
      is_blank: v.is_blank,
    };
  }

  // Group payload (only when grouped)
  let reportGroup: ResultDocumentInput["reportGroup"] | undefined;
  if (results.report_group_id) {
    const { data: group } = await admin
      .from("report_groups")
      .select("code, name")
      .eq("id", results.report_group_id)
      .single();
    reportGroup = {
      code: group?.code ?? "",
      name: group?.name ?? "",
      orderedTests: linked.map((l) => ({
        code: l.test_requests.services.code,
        name: l.test_requests.services.name,
      })),
    };
  }

  // Signatures
  const consultants = await loadConsultantSignatures();
  const performer = await resolvePerformer({
    service: {
      code: first.services.code,
      kind: first.services.kind ?? null,
    },
    finalisedByStaffId: results.finalised_by_staff_id,
  });

  return {
    template: {
      layout: template.layout as ResultLayout,
      header_notes: template.header_notes,
      footer_notes: template.footer_notes,
    },
    params,
    values,
    service: reportGroup
      ? undefined
      : { code: first.services.code, name: first.services.name },
    reportGroup,
    patient: {
      drm_id: patient.drm_id,
      last_name: patient.last_name,
      first_name: patient.first_name,
      sex: patient.sex as "F" | "M" | null,
      birthdate: patient.birthdate,
    },
    visit: { visit_number: visit.visit_number },
    controlNo: results.control_no,
    finalisedAt: results.finalised_at ? new Date(results.finalised_at) : null,
    performer,
    consultantPathologist: consultants.pathologist,
    medtech: performer
      ? {
          full_name: performer.full_name,
          prc_license_kind: performer.prc_license_kind,
          prc_license_no: performer.prc_license_no,
        }
      : null,
  };
}
```

(The existing inline builders are left alone — they each already have file-specific bespoke logic, e.g. imaging attachments in the queue action. Folding them into `loadResultDocumentInput` is a sensible follow-up but out of scope.)

- [ ] **Step 3: Rendering: use group name when present**

Edit `src/lib/results/pdf-document.tsx`. Update `SectionTitle` to accept either a service or a report group:

```tsx
function SectionTitle({
  service,
  reportGroup,
}: {
  service?: ResultDocumentInput["service"];
  reportGroup?: ResultDocumentInput["reportGroup"];
}) {
  const title = reportGroup
    ? reportGroup.name.toUpperCase()
    : service?.name.toUpperCase() ?? "";
  const code = reportGroup
    ? reportGroup.code
    : service?.code ?? "";
  return (
    <View>
      <View style={[styles.hr, styles.navyRule]} />
      <View style={styles.sectionTitleBand}>
        <Text style={styles.testTitle}>{title}</Text>
        <Text style={styles.testCode}>{code}</Text>
      </View>
      <View style={[styles.hr, styles.navyRule, { marginTop: 0 }]} />
      {reportGroup && reportGroup.orderedTests.length > 0 ? (
        <Text style={styles.headerNotes}>
          Ordered: {reportGroup.orderedTests.map((t) => t.name).join(", ")}
        </Text>
      ) : null}
    </View>
  );
}
```

Update the `<SectionTitle>` call inside `ResultDocument` to pass both:

```tsx
<SectionTitle service={input.service} reportGroup={input.reportGroup} />
```

Update the `Document` `title=` prop to handle both:

```tsx
<Document
  title={`${input.reportGroup?.name ?? input.service?.name ?? "Result"} — ${input.patient.last_name}, ${input.patient.first_name}`}
  author={SITE.name}
>
```

- [ ] **Step 4: Preview-data: guard against group templates**

The admin preview route at `src/app/(staff)/staff/(dashboard)/admin/result-templates/preview/[service_id]/route.ts` keys off `service_id`. Group templates have `service_id = null`, so the existing preview route can't reach them. That's acceptable for this plan — the preview admin route stays service-only, and the Chemistry template is verified via the medtech form + the `smoke:chemistry` render smoke instead.

Edit `src/lib/results/preview-data.ts`. Locate the function that builds the preview input. Add a single guard at the top to fail clearly if a caller ever points it at a group template (defensive — prevents a silent rendering mismatch later):

```typescript
if (template.report_group_id != null) {
  throw new Error(
    `Preview route does not support group-level templates yet. Template ${template.id} is keyed by report_group_id; use the medtech encoding flow to preview.`,
  );
}
```

No new route. Adding a group-template preview UI is a follow-up.

- [ ] **Step 5: Render-only smoke for the Chemistry consolidated form**

Create `scripts/smoke-chemistry-consolidated.ts` (companion to the .sql smoke). This script bootstraps its own fixture via the admin client, renders, asserts, then cleans up:

```typescript
// scripts/smoke-chemistry-consolidated.ts
//
// Bootstraps a paid visit with FBS + Lipid + HBA1C ordered, creates the
// consolidated results row + junction + values, renders the PDF, and
// asserts the rendered bytes contain the group title, the ordered-tests
// chip, and the consultant pathologist's PRC. Cleans up after itself.

import { createAdminClient } from "../src/lib/supabase/admin";
import { loadResultDocumentInput } from "../src/lib/results/loaders";
import { renderResultPdf } from "../src/lib/results/render-pdf";

const SMOKE_DRM_ID = "SMK-25-RENDER";

async function bootstrap() {
  const admin = createAdminClient();

  // Patient + paid visit
  await admin.from("patients").delete().eq("drm_id", SMOKE_DRM_ID); // idempotent
  const { data: patient } = await admin
    .from("patients")
    .insert({
      drm_id: SMOKE_DRM_ID,
      last_name: "RenderSmoke",
      first_name: "Patient",
      sex: "F",
      birthdate: "1985-01-01",
    })
    .select("id")
    .single();
  const { data: visit } = await admin
    .from("visits")
    .insert({
      patient_id: patient!.id,
      visit_number: "V-SMK-REND",
      total_php: 0,
      paid_php: 0,
      payment_status: "paid",
    })
    .select("id")
    .single();

  // Three chemistry test_requests
  const { data: services } = await admin
    .from("services")
    .select("id, code")
    .in("code", ["FBS_RBS", "LIPID_PROFILE", "HBA1C"]);
  const trIds: string[] = [];
  for (const svc of services ?? []) {
    const { data: tr } = await admin
      .from("test_requests")
      .insert({
        visit_id: visit!.id,
        service_id: svc.id,
        status: "in_progress",
      })
      .select("id")
      .single();
    trIds.push(tr!.id);
  }

  // Results row + junction
  const { data: group } = await admin
    .from("report_groups")
    .select("id")
    .eq("code", "CHEMISTRY")
    .single();
  const { data: result } = await admin
    .from("results")
    .insert({
      report_group_id: group!.id,
      generation_kind: "structured",
      finalised_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  await admin.from("result_test_requests").insert(
    trIds.map((trid) => ({ result_id: result!.id, test_request_id: trid })),
  );

  // 7 values
  const { data: params } = await admin
    .from("result_template_params")
    .select("id, parameter_name, result_templates!inner(report_group_id)")
    .eq("result_templates.report_group_id", group!.id)
    .in("parameter_name", [
      "FBS", "Triglycerides", "Cholesterol", "HDL", "LDL", "VLDL", "HBA1C",
    ]);
  await admin.from("result_values").insert(
    (params ?? []).map((p) => ({
      result_id: result!.id,
      parameter_id: p.id,
      numeric_value_si: 5.4,
      is_blank: false,
    })),
  );

  return { resultId: result!.id, patientId: patient!.id };
}

async function cleanup(patientId: string) {
  const admin = createAdminClient();
  // Cascades: result_test_requests → results → result_values via FK
  // on-delete-cascade. Patient delete cascades to visit and test_requests.
  await admin.from("patients").delete().eq("id", patientId);
}

async function main() {
  const { resultId, patientId } = await bootstrap();
  try {
    const input = await loadResultDocumentInput(resultId);
    const buf = await renderResultPdf(input);
    const text = buf.toString("latin1");

    if (!text.includes("CHEMISTRY")) {
      throw new Error("S5: rendered Chemistry PDF missing group title");
    }
    if (!text.includes("0089935")) {
      throw new Error("S5: rendered Chemistry PDF missing consultant PRC");
    }
    console.log("✓ S5 chemistry render OK");

    // S6: env-var fail-fast
    const orig = process.env.CONSULTANT_PATHOLOGIST_STAFF_ID;
    delete process.env.CONSULTANT_PATHOLOGIST_STAFF_ID;
    let threw = false;
    try {
      await loadResultDocumentInput(resultId);
    } catch (err) {
      threw =
        err instanceof Error &&
        err.message.includes("CONSULTANT_PATHOLOGIST_STAFF_ID");
    } finally {
      if (orig) process.env.CONSULTANT_PATHOLOGIST_STAFF_ID = orig;
    }
    if (!threw) {
      throw new Error("S6: loader did not fail-fast on missing env var");
    }
    console.log("✓ S6 env-var fail-fast OK");
  } finally {
    await cleanup(patientId);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Add to `package.json`:
```json
"smoke:chemistry": "tsx scripts/smoke-chemistry-consolidated.ts"
```

Run:
```bash
npm run smoke:chemistry
```

Expected: two `✓` lines, exit 0.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: clean. Every consumer of `ResultDocumentInput` either provides `service` (single-test) or `reportGroup` (consolidated).

- [ ] **Step 7: Commit**

```bash
git add src/lib/results/types.ts \
        src/lib/results/pdf-document.tsx \
        src/lib/results/loaders.ts \
        src/lib/results/preview-data.ts \
        scripts/smoke-chemistry-consolidated.ts \
        package.json
git commit -m "$(cat <<'EOF'
feat(results): group-level templates + Chemistry render (12.5 D5)

ResultDocumentInput gains an optional reportGroup payload that
replaces `service` when the result covers multiple test_requests.
SectionTitle renders the group name + an 'Ordered:' chip listing the
actually-ordered tests. Loaders walk the junction and resolve the
group template by report_group_id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — Medtech queue grouping + consolidated form

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/queue/page.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/[id]/actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/consolidated-form.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/actions.ts`
- Create: `src/lib/actions/results/finalise-consolidated.ts`

After this task, the medtech queue shows one card per (visit_id, report_group_id) for grouped services; clicking the card opens the 13-row Chemistry form; Finalise produces one `results` row + N junction rows + M `result_values` rows + the rendered PDF.

- [ ] **Step 1: Update queue listing to group chemistry tests**

Edit `src/app/(staff)/staff/(dashboard)/queue/page.tsx`. Locate the query that fetches test_requests for the queue view. Replace with:

```typescript
const { data: rows, error } = await supabase
  .from("test_requests")
  .select(`
    id, status, assigned_to, created_at, visit_id,
    services!inner(id, code, name, kind, report_group_id,
                   report_groups(code, name)),
    visits!inner(visit_number, patient_id,
                 patients(drm_id, last_name, first_name))
  `)
  .in("status", ["requested", "in_progress", "result_uploaded"])
  .order("created_at", { ascending: true });
if (error) throw error;
```

After fetching, fold rows into a `QueueCard[]` shape on the server before passing to the client component:

```typescript
type QueueCard =
  | {
      kind: "single";
      testRequestId: string;
      label: string;          // service.name
      visit: { id: string; number: string; patient: string };
      status: string;
      claimedBy: string | null;
    }
  | {
      kind: "grouped";
      visitId: string;
      groupId: string;
      groupCode: string;
      label: string;          // e.g. "Chemistry (3 tests)"
      orderedTests: Array<{ code: string; name: string }>;
      visit: { id: string; number: string; patient: string };
      // Aggregate status: the "earliest" status across linked rows.
      status: string;
      claimedBy: string | null;
    };

const cards: QueueCard[] = [];
const groupedAccumulator = new Map<string, QueueCard & { kind: "grouped" }>();

for (const r of rows ?? []) {
  if (r.services.report_group_id) {
    const key = `${r.visit_id}|${r.services.report_group_id}`;
    const existing = groupedAccumulator.get(key);
    const tests = { code: r.services.code, name: r.services.name };
    if (existing) {
      existing.orderedTests.push(tests);
      existing.label = `${r.services.report_groups.name} (${existing.orderedTests.length} tests)`;
      // status precedence: in_progress > requested > result_uploaded
      if (statusRank(r.status) < statusRank(existing.status)) {
        existing.status = r.status;
      }
    } else {
      groupedAccumulator.set(key, {
        kind: "grouped",
        visitId: r.visit_id,
        groupId: r.services.report_group_id,
        groupCode: r.services.report_groups.code,
        label: `${r.services.report_groups.name} (1 test)`,
        orderedTests: [tests],
        visit: {
          id: r.visit_id,
          number: r.visits.visit_number,
          patient: `${r.visits.patients.last_name}, ${r.visits.patients.first_name}`,
        },
        status: r.status,
        claimedBy: r.assigned_to,
      });
    }
  } else {
    cards.push({
      kind: "single",
      testRequestId: r.id,
      label: r.services.name,
      visit: {
        id: r.visit_id,
        number: r.visits.visit_number,
        patient: `${r.visits.patients.last_name}, ${r.visits.patients.first_name}`,
      },
      status: r.status,
      claimedBy: r.assigned_to,
    });
  }
}
cards.push(...groupedAccumulator.values());
cards.sort((a, b) => a.visit.number.localeCompare(b.visit.number));

function statusRank(s: string): number {
  return s === "requested" ? 0 : s === "in_progress" ? 1 : 2;
}
```

Render grouped cards with a different href: `/staff/queue/consolidated/${card.visitId}/${card.groupId}`. Single cards keep the existing `/staff/queue/${card.testRequestId}` href.

- [ ] **Step 2: Redirect grouped single-test access**

Edit `src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx`. At the top of the page-render function, after fetching the test_request:

```typescript
// If this test_request belongs to a report_group, redirect to the
// consolidated form route — the per-test page isn't reachable for
// grouped services.
const { data: svc } = await supabase
  .from("services")
  .select("report_group_id")
  .eq("id", testRequest.service_id)
  .single();
if (svc?.report_group_id) {
  redirect(
    `/staff/queue/consolidated/${testRequest.visit_id}/${svc.report_group_id}`,
  );
}
```

(Add `import { redirect } from "next/navigation";` at the top if not present.)

- [ ] **Step 3: Consolidated form route — server page**

Create `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { ConsolidatedForm } from "./consolidated-form";

export default async function ConsolidatedQueuePage({
  params,
}: {
  params: Promise<{ visitId: string; groupId: string }>;
}) {
  const { visitId, groupId } = await params;
  const { staffProfile } = await requireActiveStaff();

  const supabase = await createClient();

  // Load the group + template + params.
  const { data: group } = await supabase
    .from("report_groups")
    .select("id, code, name")
    .eq("id", groupId)
    .single();
  if (!group) redirect("/staff/queue");

  const { data: template } = await supabase
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes, result_template_params(*)")
    .eq("report_group_id", groupId)
    .eq("is_active", true)
    .single();
  if (!template) redirect("/staff/queue");

  // Load the visit's test_requests in this group.
  const { data: requests } = await supabase
    .from("test_requests")
    .select(`
      id, status, assigned_to,
      services!inner(id, code, name, report_group_id),
      visits!inner(id, patient_id,
                   patients(drm_id, last_name, first_name, sex, birthdate))
    `)
    .eq("visit_id", visitId)
    .eq("services.report_group_id", groupId);
  if (!requests || requests.length === 0) redirect("/staff/queue");

  return (
    <ConsolidatedForm
      group={group}
      template={template}
      visit={requests[0].visits}
      orderedServiceCodes={requests.map((r) => r.services.code)}
      testRequestIds={requests.map((r) => r.id)}
      claimedBy={requests[0].assigned_to}
      myStaffId={staffProfile.id}
    />
  );
}
```

- [ ] **Step 4: Consolidated form — client UI**

Create `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/consolidated-form.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimConsolidated, finaliseConsolidated } from "./actions";

interface Props {
  group: { id: string; code: string; name: string };
  template: {
    id: string;
    layout: string;
    result_template_params: Array<{
      id: string;
      sort_order: number;
      parameter_name: string;
      input_type: string;
      unit_si: string | null;
      unit_conv: string | null;
      gender: "F" | "M" | null;
      si_to_conv_factor: number | null;
    }>;
  };
  visit: {
    id: string;
    patient_id: string;
    patients: {
      drm_id: string;
      last_name: string;
      first_name: string;
      sex: "F" | "M" | null;
      birthdate: string | null;
    };
  };
  orderedServiceCodes: string[];
  testRequestIds: string[];
  claimedBy: string | null;
  myStaffId: string;
}

// Map service code → which template-param parameter_names it covers.
// Verified against live DB 2026-05-22; uses actual active service codes.
// `HDL_LDL_VLDL` is a single service that fans out into three rows.
// `LIPID_PROFILE` is a single service that fans out into all five lipid rows.
// `LIPID_PROFILE_PACKAGE` decomposes at order time into CHOLESTEROL +
//   TRIGLYCERIDES + HDL_LDL_VLDL components, so no direct mapping needed.
const SERVICE_TO_PARAMS: Record<string, string[]> = {
  FBS_RBS: ["FBS"],
  BUN: ["BUN"],
  CREATININE: ["Creatinine"],
  BUA_URIC_ACID: ["Uric Acid"],
  TRIGLYCERIDES: ["Triglycerides"],
  CHOLESTEROL: ["Cholesterol"],
  HDL_LDL_VLDL: ["HDL", "LDL", "VLDL"],
  SGPT_ALT: ["SGPT (ALT)"],
  SGOT_AST: ["SGOT (AST)"],
  HBA1C: ["HBA1C"],
  LIPID_PROFILE: ["Triglycerides", "Cholesterol", "HDL", "LDL", "VLDL"],
};

export function ConsolidatedForm(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Build the enabled-params set from the ordered service codes.
  const enabledParamNames = new Set<string>(
    props.orderedServiceCodes.flatMap((c) => SERVICE_TO_PARAMS[c] ?? []),
  );

  // Filter params by gender for the patient.
  const params = props.template.result_template_params
    .filter((p) => !p.gender || p.gender === props.visit.patients.sex)
    .sort((a, b) => a.sort_order - b.sort_order);

  const [values, setValues] = useState<Record<string, { si: string; conv: string }>>({});

  function updateSi(paramId: string, factor: number | null, raw: string) {
    setValues((prev) => {
      const si = raw;
      const numeric = parseFloat(raw);
      const conv = factor && !Number.isNaN(numeric)
        ? (numeric * factor).toFixed(2)
        : prev[paramId]?.conv ?? "";
      return { ...prev, [paramId]: { si, conv } };
    });
  }

  function updateConv(paramId: string, factor: number | null, raw: string) {
    setValues((prev) => {
      const conv = raw;
      const numeric = parseFloat(raw);
      const si = factor && factor !== 0 && !Number.isNaN(numeric)
        ? (numeric / factor).toFixed(4)
        : prev[paramId]?.si ?? "";
      return { ...prev, [paramId]: { si, conv } };
    });
  }

  function isClaimedByMe() {
    return props.claimedBy === props.myStaffId;
  }

  function handleClaim() {
    setError(null);
    startTransition(async () => {
      const res = await claimConsolidated({
        testRequestIds: props.testRequestIds,
      });
      if (!res.ok) setError(res.error);
      router.refresh();
    });
  }

  function handleFinalise() {
    setError(null);
    const payload = params
      .filter((p) => enabledParamNames.has(p.parameter_name))
      .map((p) => ({
        parameter_id: p.id,
        numeric_value_si: values[p.id]?.si
          ? parseFloat(values[p.id].si)
          : null,
        numeric_value_conv: values[p.id]?.conv
          ? parseFloat(values[p.id].conv)
          : null,
      }))
      .filter((row) => row.numeric_value_si != null || row.numeric_value_conv != null);

    startTransition(async () => {
      const res = await finaliseConsolidated({
        visitId: props.visit.id,
        groupId: props.group.id,
        testRequestIds: props.testRequestIds,
        values: payload,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/staff/queue`);
    });
  }

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">
        {props.group.name} — {props.visit.patients.last_name},{" "}
        {props.visit.patients.first_name} ({props.visit.patients.drm_id})
      </h1>
      <p className="text-sm text-muted-foreground">
        Ordered: {props.orderedServiceCodes.join(", ")}
      </p>

      {!isClaimedByMe() ? (
        <button
          onClick={handleClaim}
          disabled={pending}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          {pending ? "Claiming…" : "Claim this report"}
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleFinalise();
          }}
          className="space-y-2"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted">
                <th className="p-1 text-left">Test</th>
                <th className="p-1 text-right">SI Result</th>
                <th className="p-1 text-left">SI Unit</th>
                <th className="p-1 text-right">Conv Result</th>
                <th className="p-1 text-left">Conv Unit</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => {
                const enabled = enabledParamNames.has(p.parameter_name);
                return (
                  <tr
                    key={p.id}
                    className={enabled ? "" : "opacity-40"}
                  >
                    <td className="p-1">{p.parameter_name}</td>
                    <td className="p-1">
                      <input
                        type="number"
                        step="0.01"
                        disabled={!enabled || pending}
                        value={values[p.id]?.si ?? ""}
                        onChange={(e) =>
                          updateSi(p.id, p.si_to_conv_factor, e.target.value)
                        }
                        className="w-20 rounded border px-1 text-right"
                      />
                    </td>
                    <td className="p-1">{p.unit_si}</td>
                    <td className="p-1">
                      <input
                        type="number"
                        step="0.01"
                        disabled={!enabled || pending}
                        value={values[p.id]?.conv ?? ""}
                        onChange={(e) =>
                          updateConv(p.id, p.si_to_conv_factor, e.target.value)
                        }
                        className="w-20 rounded border px-1 text-right"
                      />
                    </td>
                    <td className="p-1">{p.unit_conv}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {error ? (
            <p className="rounded border border-destructive p-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            {pending ? "Finalising…" : "Finalise + release"}
          </button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Server actions for the consolidated route**

Create `src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/actions.ts`:

```typescript
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { finaliseConsolidatedReport } from "@/lib/actions/results/finalise-consolidated";

const ClaimSchema = z.object({
  testRequestIds: z.array(z.string().uuid()).min(1),
});

export async function claimConsolidated(input: unknown) {
  try {
    const { testRequestIds } = ClaimSchema.parse(input);
    const { staffProfile } = await requireActiveStaff();
    const supabase = await createClient();

    const { error } = await supabase
      .from("test_requests")
      .update({
        assigned_to: staffProfile.auth_user_id,
        status: "in_progress",
      })
      .in("id", testRequestIds)
      .in("status", ["requested", "in_progress"]);
    if (error) {
      return { ok: false as const, error: translatePgError(error) };
    }

    const { ip, ua } = await ipAndAgent();
    await audit({
      action: "test_request.claim",
      details: { test_request_ids: testRequestIds, grouped: true },
      ip,
      ua,
      staffId: staffProfile.id,
    });

    revalidatePath("/staff/queue");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
}

const FinaliseSchema = z.object({
  visitId: z.string().uuid(),
  groupId: z.string().uuid(),
  testRequestIds: z.array(z.string().uuid()).min(1),
  values: z.array(
    z.object({
      parameter_id: z.string().uuid(),
      numeric_value_si: z.number().nullable(),
      numeric_value_conv: z.number().nullable(),
    }),
  ),
});

export async function finaliseConsolidated(input: unknown) {
  try {
    const parsed = FinaliseSchema.parse(input);
    return await finaliseConsolidatedReport(parsed);
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
}
```

- [ ] **Step 6: Core finalise function**

Create `src/lib/actions/results/finalise-consolidated.ts`:

```typescript
"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { renderResultPdf } from "@/lib/results/render-pdf";
import { loadResultDocumentInput } from "@/lib/results/loaders";

export interface FinaliseInput {
  visitId: string;
  groupId: string;
  testRequestIds: string[];
  values: Array<{
    parameter_id: string;
    numeric_value_si: number | null;
    numeric_value_conv: number | null;
  }>;
}

export async function finaliseConsolidatedReport(input: FinaliseInput) {
  const { staffProfile } = await requireActiveStaff();
  const admin = createAdminClient();

  // 1) Create results row (structured + group-keyed)
  const { data: resultsRow, error: rErr } = await admin
    .from("results")
    .insert({
      report_group_id: input.groupId,
      finalised_by_staff_id: staffProfile.id,
      generation_kind: "structured",
      finalised_at: new Date().toISOString(),
    })
    .select("id, control_no")
    .single();
  if (rErr) return { ok: false as const, error: translatePgError(rErr) };

  // 2) Junction rows
  const { error: jErr } = await admin
    .from("result_test_requests")
    .insert(
      input.testRequestIds.map((trid) => ({
        result_id: resultsRow.id,
        test_request_id: trid,
      })),
    );
  if (jErr) return { ok: false as const, error: translatePgError(jErr) };

  // 3) Values
  if (input.values.length > 0) {
    const { error: vErr } = await admin.from("result_values").insert(
      input.values.map((v) => ({
        result_id: resultsRow.id,
        parameter_id: v.parameter_id,
        numeric_value_si: v.numeric_value_si,
        numeric_value_conv: v.numeric_value_conv,
        is_blank: false,
      })),
    );
    if (vErr) return { ok: false as const, error: translatePgError(vErr) };
  }

  // 4) Release each linked test_request (payment-gating trigger fires here)
  const { error: relErr } = await admin
    .from("test_requests")
    .update({ status: "released" })
    .in("id", input.testRequestIds);
  if (relErr) return { ok: false as const, error: translatePgError(relErr) };

  // 5) Render + store PDF
  const docInput = await loadResultDocumentInput(resultsRow.id);
  const pdfBuf = await renderResultPdf(docInput);
  const pdfPath = `${resultsRow.id}.pdf`;
  const { error: upErr } = await admin.storage
    .from("results")
    .upload(pdfPath, pdfBuf, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (upErr) return { ok: false as const, error: translatePgError(upErr) };

  await admin
    .from("results")
    .update({ pdf_path: pdfPath })
    .eq("id", resultsRow.id);

  // 6) Audit
  const { ip, ua } = await ipAndAgent();
  await audit({
    action: "result.finalised",
    details: {
      result_id: resultsRow.id,
      test_request_ids: input.testRequestIds,
      report_group_id: input.groupId,
    },
    ip,
    ua,
    staffId: staffProfile.id,
  });
  await audit({
    action: "result.released",
    details: {
      result_id: resultsRow.id,
      test_request_ids: input.testRequestIds,
    },
    ip,
    ua,
    staffId: staffProfile.id,
  });

  return { ok: true as const, data: { result_id: resultsRow.id } };
}
```

- [ ] **Step 7: Manual UI smoke**

```bash
npm run dev
```

In a browser, log in as a medtech, navigate to `/staff/queue`. Confirm:
- Any chemistry test_requests appear as one "Chemistry (N tests)" card.
- Clicking the card lands on `/staff/queue/consolidated/<visitId>/<groupId>`.
- The form shows 13 rows; un-ordered rows are greyed out and disabled.
- "Claim this report" works; reload shows the form in encode mode.
- Filling SI auto-fills the conventional column via the factor.
- "Finalise + release" succeeds for a paid visit; bounces with a clear error for an unpaid visit.

Use the existing test fixtures (DRM-ID with a paid chemistry visit) — if none exists, create one via `scripts/seed-test-data.ts`.

- [ ] **Step 8: Typecheck + lint**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 9: Commit**

```bash
git add src/app/\(staff\)/staff/\(dashboard\)/queue \
        src/lib/actions/results/finalise-consolidated.ts
git commit -m "$(cat <<'EOF'
feat(queue): consolidated chemistry form + grouped queue cards (12.5 D6)

Medtech queue now folds chemistry test_requests into one card per
(visit, report_group). Clicking opens a 13-row consolidated form with
greyed-out un-ordered rows and SI⇄conventional auto-conversion via
si_to_conv_factor. Finalise inserts one results row + N junction rows
+ M result_values, then releases all linked test_requests inside the
payment-gating trigger and stores the rendered PDF.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 — Patient portal label + end-to-end smoke + Playwright

**Files:**
- Modify: `src/app/(patient)/portal/results/page.tsx`
- Modify: `scripts/smoke-chemistry-consolidated.sql` (append S2–S6)
- Create: `tests/playwright/chemistry-consolidated.spec.ts`

This task closes out the consolidated reports flow with patient-portal labelling, the full smoke suite from spec §15, and a 390×844 mobile smoke.

- [ ] **Step 1: Patient portal label resolution**

Edit `src/app/(patient)/portal/results/page.tsx`. Locate the query that lists `results` for the patient. Update to include both the junction-linked single test_request's service name and the report_group name:

```typescript
const { data: rows } = await supabase
  .from("results")
  .select(`
    id, finalised_at, control_no, pdf_path, report_group_id,
    report_groups(name),
    result_test_requests(test_requests(services(name)))
  `)
  .order("finalised_at", { ascending: false });
```

In the JSX, derive the label:

```tsx
function labelForResult(row: typeof rows[number]): { primary: string; sub: string | null } {
  if (row.report_groups?.name) {
    const tests = (row.result_test_requests ?? [])
      .map((j) => j.test_requests?.services?.name)
      .filter(Boolean);
    return { primary: row.report_groups.name, sub: tests.join(", ") };
  }
  const single = row.result_test_requests?.[0]?.test_requests?.services?.name;
  return { primary: single ?? "Result", sub: null };
}
```

Use `labelForResult(row)` in the card render.

- [ ] **Step 2: Append S2–S6 smoke stages**

Replace the closing `rollback;` of `scripts/smoke-chemistry-consolidated.sql` with the following appended stages, then close with `rollback;`:

```sql
-- =============================================================================
-- S2: end-to-end finalise + release on a paid chemistry visit
-- =============================================================================
do $$
declare
  v_admin_id    uuid := gen_random_uuid();
  v_patient_id  uuid;
  v_visit_id    uuid;
  v_fbs_id      uuid;
  v_lipid_id    uuid;
  v_hba1c_id    uuid;
  v_result_id   uuid;
  v_junction_n  int;
  v_value_n     int;
  v_released_n  int;
begin
  -- Bootstrap auth.users + admin staff
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_admin_id, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'smoke-admin@drmed.test');
  insert into public.staff_profiles (auth_user_id, full_name, role, is_active)
  values (v_admin_id, 'Smoke Admin', 'admin', true);

  -- Patient + paid visit
  insert into public.patients (drm_id, last_name, first_name, sex, birthdate)
  values ('SMK-25-001', 'Smoke', 'Patient', 'F', '1985-01-01')
  returning id into v_patient_id;

  insert into public.visits (patient_id, visit_number, total_php, paid_php, payment_status)
  values (v_patient_id, 'V-SMK-001', 0, 0, 'paid')
  returning id into v_visit_id;

  -- Three chemistry test_requests on the visit
  insert into public.test_requests (visit_id, service_id, status, assigned_to)
  select v_visit_id, s.id, 'in_progress', v_admin_id
    from public.services s where s.code = 'FBS_RBS' returning id into v_fbs_id;
  insert into public.test_requests (visit_id, service_id, status, assigned_to)
  select v_visit_id, s.id, 'in_progress', v_admin_id
    from public.services s where s.code = 'LIPID_PROFILE' returning id into v_lipid_id;
  insert into public.test_requests (visit_id, service_id, status, assigned_to)
  select v_visit_id, s.id, 'in_progress', v_admin_id
    from public.services s where s.code = 'HBA1C' returning id into v_hba1c_id;

  -- One results row + 3 junction rows
  insert into public.results
    (report_group_id, finalised_by_staff_id, generation_kind, finalised_at)
  select rg.id,
         (select id from public.staff_profiles where auth_user_id = v_admin_id),
         'structured', now()
    from public.report_groups rg where rg.code = 'CHEMISTRY'
  returning id into v_result_id;

  insert into public.result_test_requests (result_id, test_request_id)
  values (v_result_id, v_fbs_id), (v_result_id, v_lipid_id), (v_result_id, v_hba1c_id);

  -- 7 result_values (FBS=1, Lipid=5, HBA1C=1)
  insert into public.result_values (result_id, parameter_id, numeric_value_si)
  select v_result_id, p.id, 5.4
    from public.result_template_params p
    join public.result_templates t on t.id = p.template_id
    join public.report_groups rg on rg.id = t.report_group_id and rg.code='CHEMISTRY'
   where p.parameter_name in
     ('FBS','Triglycerides','Cholesterol','HDL','LDL','VLDL','HBA1C');

  select count(*) into v_junction_n
    from public.result_test_requests where result_id = v_result_id;
  if v_junction_n <> 3 then
    raise exception 'S2: expected 3 junction rows, got %', v_junction_n;
  end if;

  select count(*) into v_value_n
    from public.result_values where result_id = v_result_id;
  if v_value_n <> 7 then
    raise exception 'S2: expected 7 result_values rows, got %', v_value_n;
  end if;

  -- Release: the result-flip trigger already set status to ready_for_release
  -- on insert into result_values. Now move them to 'released'.
  update public.test_requests
     set status = 'released'
   where id in (v_fbs_id, v_lipid_id, v_hba1c_id);

  select count(*) into v_released_n
    from public.test_requests
   where id in (v_fbs_id, v_lipid_id, v_hba1c_id)
     and status = 'released';
  if v_released_n <> 3 then
    raise exception 'S2: expected all 3 test_requests released, got %', v_released_n;
  end if;

  raise notice 'S2 end-to-end OK (% junction, % values, % released)',
               v_junction_n, v_value_n, v_released_n;
end $$;

-- =============================================================================
-- S3: payment-gating trigger blocks release on unpaid visit
-- =============================================================================
do $$
declare
  v_admin_id    uuid := gen_random_uuid();
  v_patient_id  uuid;
  v_visit_id    uuid;
  v_fbs_req     uuid;
  v_caught      boolean := false;
begin
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_admin_id, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'smoke-s3@drmed.test');
  insert into public.staff_profiles (auth_user_id, full_name, role, is_active)
  values (v_admin_id, 'Smoke S3', 'admin', true);

  insert into public.patients (drm_id, last_name, first_name, sex, birthdate)
  values ('SMK-25-S3', 'S3', 'Patient', 'F', '1985-01-01')
  returning id into v_patient_id;

  -- Unpaid visit
  insert into public.visits (patient_id, visit_number, total_php, paid_php, payment_status)
  values (v_patient_id, 'V-SMK-S3', 100, 0, 'unpaid')
  returning id into v_visit_id;

  insert into public.test_requests (visit_id, service_id, status)
  select v_visit_id, s.id, 'ready_for_release'
    from public.services s where s.code = 'FBS_RBS' returning id into v_fbs_req;

  begin
    update public.test_requests set status='released' where id = v_fbs_req;
  exception when sqlstate 'P0030' then
    v_caught := true;
  end;

  if not v_caught then
    raise exception 'S3: expected P0030 payment-gating exception, got none';
  end if;
  raise notice 'S3 payment gating OK';
end $$;

-- =============================================================================
-- S4: RLS — medtechs reading shared result_values
-- =============================================================================
do $$
declare
  v_a   uuid := gen_random_uuid();
  v_b   uuid := gen_random_uuid();
  v_patient uuid;
  v_visit   uuid;
  v_fbs     uuid;
  v_lipid   uuid;
  v_result  uuid;
  v_param   uuid;
  v_can_a   boolean;
  v_can_b   boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email) values
    (v_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-mt-a@drmed.test'),
    (v_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-mt-b@drmed.test');
  insert into public.staff_profiles (auth_user_id, full_name, role, is_active) values
    (v_a, 'MT A', 'medtech', true),
    (v_b, 'MT B', 'medtech', true);

  insert into public.patients (drm_id, last_name, first_name, sex, birthdate)
  values ('SMK-25-S4', 'S4', 'Patient', 'F', '1985-01-01') returning id into v_patient;
  insert into public.visits (patient_id, visit_number, paid_php, total_php, payment_status)
  values (v_patient, 'V-SMK-S4', 0, 0, 'paid') returning id into v_visit;

  -- MT A claims FBS, MT B claims Lipid
  insert into public.test_requests (visit_id, service_id, status, assigned_to)
  select v_visit, s.id, 'in_progress', v_a from public.services s where s.code='FBS_RBS'
  returning id into v_fbs;
  insert into public.test_requests (visit_id, service_id, status, assigned_to)
  select v_visit, s.id, 'in_progress', v_b from public.services s where s.code='LIPID_PROFILE'
  returning id into v_lipid;

  insert into public.results (report_group_id, generation_kind, finalised_at)
  select id, 'structured', now() from public.report_groups where code='CHEMISTRY'
  returning id into v_result;

  insert into public.result_test_requests values (v_result, v_fbs), (v_result, v_lipid);

  select id into v_param
    from public.result_template_params p
    join public.result_templates t on t.id=p.template_id
    join public.report_groups r on r.id=t.report_group_id and r.code='CHEMISTRY'
   where p.parameter_name='FBS' limit 1;

  insert into public.result_values (result_id, parameter_id, numeric_value_si)
  values (v_result, v_param, 5.4);

  -- MT A and MT B should both see the row (shared report).
  set local role authenticated;
  set local request.jwt.claim.sub = v_a;
  select exists(select 1 from public.result_values where result_id = v_result)
    into v_can_a;
  set local request.jwt.claim.sub = v_b;
  select exists(select 1 from public.result_values where result_id = v_result)
    into v_can_b;
  reset role;

  if not v_can_a or not v_can_b then
    raise exception 'S4: both medtechs should see shared result_values (a=%, b=%)',
                    v_can_a, v_can_b;
  end if;
  raise notice 'S4 RLS shared ownership OK';
end $$;

-- =============================================================================
-- S5: signatures presence (DB-side only — render assertions in .ts smoke)
-- =============================================================================
do $$
declare
  v_n_sigs int;
begin
  select count(*) into v_n_sigs
    from public.staff_profiles
   where signature_path is not null
     and prc_license_no in ('0063443','0139409','0069135','0089935','0098739','0087903');
  if v_n_sigs <> 6 then
    raise exception 'S5: expected 6 staff_profiles with signature_path, got %', v_n_sigs;
  end if;
  raise notice 'S5 signatures present OK';
end $$;

-- =============================================================================
-- S6: env-var fail-fast — DB cannot test this; placeholder for .ts smoke.
-- =============================================================================
do $$ begin raise notice 'S6 must run from .ts smoke (env-var fail-fast)'; end $$;
```

- [ ] **Step 3: Run full smoke**

```bash
psql "$SUPABASE_DB_URL" -f scripts/smoke-chemistry-consolidated.sql
```

Expected: all six NOTICE lines (S0 through S6). Any RAISE EXCEPTION halts the run and points at the assertion that failed.

- [ ] **Step 4: Re-run the chemistry render + env-var fail-fast smoke**

The `.ts` smoke already covers S5 (render content) and S6 (env-var fail-fast) — it was added in Task 5 Step 5. Re-run as a regression check now that the patient portal label has landed:

```bash
npm run smoke:chemistry
```

Expected: both `✓ S5` and `✓ S6` lines, exit 0.

- [ ] **Step 5: Playwright UI smoke at 390×844**

Create `tests/playwright/chemistry-consolidated.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("medtech can finalise a consolidated chemistry form (mobile)", async ({ page }) => {
  // Pre-seeded fixture: a medtech account 'smoke-mt@drmed.test' and a paid
  // visit with FBS + Lipid + HBA1C in 'in_progress'. Use the existing
  // scripts/seed-test-data.ts to bootstrap if not yet present.

  await page.goto("/staff/login");
  await page.fill('input[name="email"]', "smoke-mt@drmed.test");
  await page.fill('input[name="password"]', process.env.SMOKE_MT_PASSWORD!);
  await page.click('button[type="submit"]');

  await page.waitForURL("**/staff/queue");
  const card = page.getByText(/Chemistry \(3 tests\)/);
  await expect(card).toBeVisible();
  await card.click();

  await page.waitForURL(/\/staff\/queue\/consolidated\//);
  await expect(page.getByRole("heading", { name: /Chemistry/i })).toBeVisible();

  // Greyed rows: BUN, Creatinine, Uric Acid, SGPT, SGOT (since not ordered).
  const bunInput = page.locator('input').filter({ hasText: /BUN/ });
  await expect(bunInput).toBeDisabled();

  await page.click("text=Claim this report");
  await page.waitForLoadState("networkidle");

  // Fill FBS row
  const fbsRow = page.locator("tr", { hasText: "FBS" });
  await fbsRow.locator("input").first().fill("5.4");

  // Fill all five lipid rows
  for (const name of ["Triglycerides", "Cholesterol", "HDL", "LDL", "VLDL"]) {
    const row = page.locator("tr", { hasText: name });
    await row.locator("input").first().fill("1.5");
  }

  // Fill HBA1C
  await page.locator("tr", { hasText: "HBA1C" }).locator("input").first().fill("5.7");

  await page.click("text=Finalise + release");
  await page.waitForURL("**/staff/queue");

  // Card should no longer be present (all released)
  await expect(page.getByText(/Chemistry \(3 tests\)/)).toHaveCount(0);
});
```

Run:

```bash
npx playwright test chemistry-consolidated
```

Expected: green.

- [ ] **Step 6: README env-var inventory update**

Edit `README.md`. Find the env-var inventory section and add:

```
| CONSULTANT_PATHOLOGIST_STAFF_ID | staff_profiles.id of the consultant pathologist; auto-included on every rendered result PDF |
| CONSULTANT_RADIOLOGIST_STAFF_ID | staff_profiles.id of the consultant radiologist; performer signature on imaging PDFs |
| CONSULTANT_CARDIOLOGIST_STAFF_ID | staff_profiles.id of the consultant cardiologist; performer signature on ECG PDFs |
```

- [ ] **Step 7: Final typecheck + lint + smoke run**

```bash
npm run typecheck && npm run lint && \
psql "$SUPABASE_DB_URL" -f scripts/smoke-chemistry-consolidated.sql && \
npm run smoke:chemistry && \
npm run smoke:results
```

All four steps green.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(patient\)/portal/results/page.tsx \
        scripts/smoke-chemistry-consolidated.sql \
        scripts/smoke-chemistry-consolidated.ts \
        tests/playwright/chemistry-consolidated.spec.ts \
        README.md
git commit -m "$(cat <<'EOF'
feat(results): patient portal label + full smoke suite (12.5 D7)

Patient portal lists consolidated chemistry as one card labelled
"Chemistry" with the ordered tests as a sub-line. Adds S2-S6 SQL
smokes (end-to-end finalise, payment gating, RLS shared ownership,
signature presence) and a 390x844 Playwright smoke covering the
medtech consolidated form on mobile. README env-var inventory adds
the three CONSULTANT_*_STAFF_ID entries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Tag the release**

```bash
git tag -a v1.10.0 -m "12.5 visit-consolidated reports + embedded signatures"
git push origin main --tags
```

(Adjust the version per the project's tagging convention — `v1.10.0` follows the v1.9.0 of 12.4 AP.)

---

## Self-review

After this plan ran, the spec's seven sections are covered:

- §5 (data model) → Task 1 + a portion of Task 3 (staff_profiles deltas, in the same migration).
- §6 (service inventory) + §7 (Chemistry template) → Task 2.
- §8 (signatures) → Tasks 3 and 4.
- §9 (medtech UI) → Task 6.
- §10 (patient portal) → Task 7 Step 1.
- §11 (reception UI) → no change (per spec).
- §12 (audit logging) → Task 6 `finaliseConsolidatedReport` Step 6 (audit events).
- §13 (seed scripts) → Tasks 2 and 3.
- §14 (cutover) → user-driven; agent reminds user before applying migration 0051.
- §15 (smoke tests) → Tasks 1, 2, 4, 5, 7.
- §16 (dispatches) → seven Tasks above mirror D1–D7.

**Open questions from spec §18:**

- (1) Lipid pricing: plan implements (a) — LIPID stays as a single service. If user picks (b) later, that's a follow-up plan (split into 5 services, deactivate LIPID).
- (2) BUN/BUA/HBA1C prices: pre-flight; agent blocks Task 2 Step 3 on user input.
- (3) RBS as separate service: plan does not add RBS. If needed later, a follow-up migration.
- (4) Local path for signature PNGs: pinned at `scripts/seed/signatures/<filename>.png`.
- (5) Deploy window: user-driven; agent reminds before pushing migration.
- (6) X-ray and ECG signature workflow change: plan implements per spec — radiologist/cardiologist auto-included on imaging/ECG PDFs.

**Risks called out:**

- Task 1 Step 8 (TypeScript references to dropped `test_request_id` column) may surface more places than the inventory expects. Agent iterates `npm run typecheck` until clean before committing.
- Task 6 Step 4 client form uses `SERVICE_TO_PARAMS` hardcoded mapping; a follow-up could move this into the DB (`services.template_param_codes`) so adding a new chemistry service doesn't require a code edit. Out of scope for this plan.

---
name: drmed-result-templates
description: Use when working on DRMed lab result templates, structured result entry, or the PDF rendering pipeline. Trigger whenever the user mentions result template, lab result, lab report, lab result PDF, lab report PDF, test result, result_templates, result_template_params, result_template_param_ranges, result_values, structured form, structured result entry, pathologist sign-off, requires_signoff, ready_for_release, result PDF, render PDF, renderResultPdf, renderOne, loadTemplateParams, buildPreviewValues, ResultDocument, pdf-document, @react-pdf/renderer, @pdf-lib/fontkit, smoke render, smoke:results, lab result, CBC, urinalysis, ROUTINE_PACKAGE, FBS, LIPID_PROFILE, age-banded ranges, reference ranges, abnormal_values, flag computation, compute_result_flag, critical alerts, dual unit, SI conversion, package summary, or any of the staff dashboard routes under /staff/(dashboard)/queue, /staff/(dashboard)/admin/result-templates, /staff/(dashboard)/signoff. Don't make Claude rediscover the 4-layout pipeline from scratch.
---

# DRMed result templates & PDF render pipeline

## What this is

The lab-result PDF generation stack — from the per-service template definition down to the rendered PDF a patient downloads. There are **4 layouts** (`simple` / `dual_unit` / `multi_section` / `imaging_report`) and ~70 seeded service templates. Rarely touched, but every piece of the pipeline matters when it is. Pathologist sign-off is a separate flow gated by `services.requires_signoff`.

## Architecture at a glance

```
supabase/migrations/
├── 0007_result_templates_and_values.sql   ← schema (templates, params, values)
├── 0009_result_param_age_bands.sql        ← age-banded range overrides
└── 0010_drop_compute_result_flag_trigger.sql ← moved flag computation to app (see below)

src/lib/results/
├── loaders.ts              ← loadTemplateParams() — fetches params + age-banded ranges
├── preview-data.ts         ← buildPreviewValues() — synthesizes demo values for admin preview
├── render-pdf.ts           ← renderResultPdf() — wraps @react-pdf/renderer renderToBuffer
├── pdf-document.tsx        ← Server Component, ~37KB. The full layout engine.
└── types.ts                ← ResultLayout, ParamValue, TemplateParam, EffectiveRange, ResultDocumentInput

src/app/(staff)/staff/(dashboard)/
├── queue/page.tsx                      ← medtech entry: test list
├── queue/[id]/page.tsx                 ← detail: form + status + requires_signoff badge
├── queue/[id]/structured-form.tsx      ← form UI for structured entry + finalize
├── admin/result-templates/             ← admin CRUD for templates
├── admin/result-templates/preview/[service_id]/route.ts ← admin preview endpoint
└── signoff/page.tsx                    ← pathologist sign-off (placeholder, queued)

scripts/
└── smoke-render-results.ts             ← npm run smoke:results — render 3 archetypes + package summary
```

## Schema

| Table | Purpose |
|---|---|
| `result_templates` | One per service. `(id, service_id [unique FK], layout, header_notes, footer_notes, is_active, created_at, updated_at)`. Layout ∈ `simple` \| `dual_unit` \| `multi_section` \| `imaging_report`. |
| `result_template_params` | Rows = printable parameters. `(id, template_id, sort_order, section, is_section_header, parameter_name, input_type, unit_si, unit_conv, ref_low_si/high_si, ref_low_conv/high_conv, gender, si_to_conv_factor, allowed_values[], abnormal_values[], placeholder)`. `input_type` ∈ `numeric` \| `free_text` \| `select`. |
| `result_template_param_ranges` (migration `0009_result_param_age_bands.sql`) | Age-banded overrides. `(parameter_id, age_min_months, age_max_months, gender, band_label, ref_low_si/high_si, ...)`. Falls back to `result_template_params` defaults when no row matches. |
| `result_values` | Per-result entry. `(id, result_id, parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank, created_at, updated_at)`. `flag ∈ H` (high) \| `L` (low) \| `A` (abnormal) \| `null`. **Computed in TypeScript** via `pickRangeForPatient` inside `finaliseStructuredAction` and written explicitly on upsert. The original DB trigger was dropped in `0010_drop_compute_result_flag_trigger.sql` because age-banded ranges need patient context (age + sex) that's awkward to join in plpgsql. |

## Render pipeline

| File | Function |
|---|---|
| `loaders.ts` (`loadTemplateParams`) | Query `result_template_params` by `template_id` ordered by `sort_order`. Query all `result_template_param_ranges` for those param IDs. Map ranges into a per-param lookup. Return `TemplateParam[]` with `ranges: ParamRange[]` populated. |
| `preview-data.ts` (`buildPreviewValues`) | For each non-header param: numeric → midpoint (every 5th forced high); select → first allowed value (every 3rd forced abnormal); free_text → `placeholder` or `(sample text)`. **Mirrors trigger logic** so preview matches finalized PDFs. |
| `render-pdf.ts` (`renderResultPdf`) | Calls `renderToBuffer(ResultDocument(input))` → returns `Buffer`. |
| `pdf-document.tsx` | The `Document` tree. Switches on `layout` to render the right structure. Handles units, flags, blank rows, package summary cover, image attachments. |

## The `renderOne()` function

Defined in `scripts/smoke-render-results.ts` (lines ~32–86). Pattern:

```ts
async function renderOne(code: string) {
  // 1. Fetch service by code (CBC_PC, ROUTINE_PACKAGE, URINALYSIS)
  // 2. Fetch result_templates row for that service
  // 3. loadTemplateParams(admin, tpl.id)
  // 4. buildPreviewValues(params)
  // 5. Assemble ResultDocumentInput (mock patient/medtech/control_no)
  // 6. renderResultPdf(input) → Buffer
  // 7. writeFileSync(/tmp/drmed-result-{layout}.pdf)
}
```

Loop in `main()` covers the 3 service codes plus a `package_summary` cover.

## `npm run smoke:results`

Runs `scripts/smoke-render-results.ts`. Renders to `/tmp/drmed-result-{layout}.pdf`. **Re-run after:**

- Template-layout edits in `pdf-document.tsx`
- `result_templates` schema changes
- Age-band range edits in `result_template_param_ranges`
- Flag-threshold changes (`abnormal_values`, ref ranges)
- React-PDF library bumps
- Before pushing to production to verify no regression

## Pathologist sign-off

`services.requires_signoff` boolean (default `false`) added in `0001_init.sql`. Effect:

- Medtech finishes test → status moves to `result_uploaded` (instead of `ready_for_release`)
- Pathologist must sign off → status moves to `ready_for_release`
- Then reception/release flow handles `released` (gated by payment trigger)

UI state today:
- Medtech queue detail page (`queue/[id]/page.tsx`) shows "Awaiting pathologist sign-off" badge when `requires_signoff=true`
- Admin can toggle the flag per service via `/staff/services` form
- `/staff/(dashboard)/signoff/page.tsx` is a placeholder — full sign-off UI is queued

## How to add a new template

1. Add a row to `result_templates` for the service (pick a `layout`)
2. Add `result_template_params` rows (one per printable parameter) with `sort_order`, units, ref ranges, abnormal values
3. (Optional) Add `result_template_param_ranges` rows for age/gender-banded overrides
4. Update `seed-result-templates.ts` if you want this template to ship with fresh installs
5. **Run `npm run smoke:results`** — eyeball the rendered PDF
6. If the parameter shape doesn't fit any of the 4 layouts, you're either misusing a layout or need a new one (5th layout = significant work in `pdf-document.tsx`)

## How to add a new layout

1. Add the layout value to the `result_templates.layout` CHECK constraint (new migration)
2. Add a `case` branch in `pdf-document.tsx`'s layout switch
3. Add representative service to `smoke-render-results.ts` `SERVICE_CODES`
4. Run smoke + open PDF
5. Document the new layout's intent in the schema comment

## Hard rules

- **Missing values use `is_blank=true` explicitly** — don't omit the row, or PDF layout shifts. `is_blank=true` renders as `—` in all layouts.
- **Flag computation runs server-side in TypeScript** (`finaliseStructuredAction` + `pickRangeForPatient`), written explicitly on upsert. The original `compute_result_flag` DB trigger was dropped in `0010`. Don't reintroduce a DB trigger — the picker needs joined patient context that's clean in TS, messy in plpgsql. Use the same `pickRangeForPatient` helper everywhere (form, finalise, preview) so flags don't drift.
- **Dual-unit `si_to_conv_factor`** auto-fills conventional from SI when set. If user enters only conventional, it back-converts or compares against conventional ranges. Don't manually duplicate values.
- **Age-band fallback**: `result_template_param_ranges` overrides default `ref_low_si/high_si` when patient age/sex matches. No match → fall back to defaults. Don't query both and merge client-side; the loader handles it.
- **Imaging attachments**: JPEG / PNG / WebP / PDF only. HEIC/HEIF are not supported by `@react-pdf/renderer` without server-side conversion.
- **`@react-pdf/renderer` typings predate React 19** — `render-pdf.ts` casts through `unknown`. Don't try to "fix" the cast; it's load-bearing.
- **Critical-value alerts**: numeric values crossing `critical_low_si / critical_high_si` thresholds insert `critical_alerts` rows. If a parameter shouldn't trigger alerts, leave the critical thresholds NULL.
- **`filterParamsForPatient`** hides gender-specific rows that don't match patient sex. Don't bypass it on the assumption "we'll filter in UI" — the trigger and the PDF render both consume the unfiltered list otherwise.

## When this skill should NOT trigger

- Generic database migrations that don't touch result templates — use the `drmed-migrations` skill.
- Auth / RLS work — use the `drmed-rls-and-auth` skill.
- Patient portal result-download UI (not template) — separate flow in `src/app/(patient)/portal/results/`.
- Lab pricing / quote tools — `services` table writes, but no template involvement.
- Imaging report routes that don't involve PDF rendering.

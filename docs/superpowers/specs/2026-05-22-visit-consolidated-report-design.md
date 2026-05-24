# Visit-consolidated reports + embedded signatures — design

**Status:** Draft for review · 2026-05-22
**Owner:** ianjamila
**Project codename:** 12.5 (or 13.x — pick a number when planning)

## 1. Background

Today every `test_request` produces its own `results` row and its own
printed PDF (1:1 via `results.test_request_id`). The lab's actual paper
workflow consolidates multiple chemistry tests onto one
fixed-layout form (13 rows: FBS, BUN, Creatinine, Uric Acid,
Triglycerides, Cholesterol, HDL, LDL, VLDL, SGPT, SGOT, HBA1C — RBS
substitutes for FBS when ordered). Tests that weren't ordered stay
blank on the printed form. One control number, one PDF, one release
event.

Additionally, the lab puts a wet-ink-style signature image on every
printed report (medtech, radiologist, or cardiologist depending on
modality) and an auto-included consultant pathologist signature on
every DRMed-generated PDF. DRMed today prints typed names and PRC
text only — no embedded image.

This spec covers both, because they share one PDF-renderer pass.

## 2. Goals

1. When a visit has any combination of services in a "report group"
   (initially just Chemistry), produce **one** consolidated PDF
   with **one** control number, listing the group's full fixed
   parameter set with un-ordered rows left blank.
2. Embed a signature image for the performing professional plus the
   consultant pathologist on every DRMed-generated result PDF.
3. Keep current behavior for non-grouped services (CBC, Urinalysis,
   X-ray, ECG, send-outs) — one form per service — with the only
   change being embedded signature images instead of typed names.

## 3. Non-goals

- An admin UI for managing report groups (SQL migration only).
- An admin UI for uploading signature images (seed script only).
- Per-test partial release within a consolidated form (all-or-nothing).
- Pathologist sign-off workflow on chemistry (none required).
- Modifying send-out PDFs (they come from partner labs as-is).
- Backfilling old released chemistry results into the new shape
  (historical results keep their existing per-test PDFs).

## 4. Recap of decisions

| # | Decision |
|---|---|
| Q1 | Build report-group abstraction; seed only Chemistry. |
| Q2 | Bundle consolidated reports + signature embedding in one project. |
| Q3 | Release is **all-or-nothing** on the consolidated form — all linked test_requests release in one transaction once the medtech finalises. |
| Q4 | No pathologist sign-off workflow on chemistry. |
| Q5 | Consultant pathologist signature auto-renders on **every** PDF DRMed generates (not send-outs). |
| Q6 | Use the six signature PNGs the user provided; no upload UI; seed script reads them from a local path; signature files **not checked into git**. |
| Q7 | Consultant pathologist / radiologist / cardiologist identified by env-var staff_id constants. |
| Q-architecture | Approach 1: junction table `result_test_requests`; one `results` row per consolidated report. |
| Q-lipid | LIPID is subsumed by the Chemistry group — its 5 sub-rows (Trig/Chol/HDL/LDL/VLDL) become regular Chemistry rows. |

## 5. Data model

### 5.1 New table: `report_groups`

```sql
create table public.report_groups (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,            -- 'CHEMISTRY'
  name        text not null,                   -- 'Chemistry'
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
```

One seeded row: `('CHEMISTRY', 'Chemistry')`. Adding more groups
later is a SQL migration.

### 5.2 `services` delta

```sql
alter table public.services
  add column report_group_id uuid references public.report_groups(id);
create index idx_services_report_group on public.services(report_group_id)
  where report_group_id is not null;
```

Chemistry services point at the Chemistry group; non-grouped services
stay `null`.

### 5.3 `result_templates` delta

The Chemistry template attaches to the **group**, not to a single
service. So:

```sql
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
```

The existing service-level unique on `service_id` is preserved (it
was already unique; just nullable now).

### 5.4 New junction: `result_test_requests`

```sql
create table public.result_test_requests (
  result_id        uuid not null references public.results(id) on delete cascade,
  test_request_id  uuid not null references public.test_requests(id) on delete restrict,
  primary key (result_id, test_request_id)
);
create unique index uq_result_test_requests_test_request
  on public.result_test_requests(test_request_id);
```

One `results` row → many `test_requests`. Per the partial unique
index, each test_request is reachable from at most one results row
(preserves the 1:1 from the other side).

### 5.5 `results` delta

```sql
-- backfill first
insert into public.result_test_requests (result_id, test_request_id)
select id, test_request_id from public.results
where test_request_id is not null;

alter table public.results
  add column report_group_id uuid references public.report_groups(id),
  drop column test_request_id;
```

`results.report_group_id` is non-null when the results row covers a
consolidated form; null when it covers a single test (current
behavior preserved by setting it null for all non-grouped reports).

### 5.6 Trigger updates

Two existing triggers touch the 1:1 path:

- `0001_init.sql` — `on results insert` flips
  `test_requests.status` from `in_progress` to `result_uploaded` (or
  `ready_for_release` when no signoff is needed).
- `0008_structured_results_drafts.sql` — same trigger updated for
  structured-entry flow.

Both update only the row whose `test_request_id` matched. After this
spec, both update **all** test_requests in `result_test_requests`
for the inserted `results.id`.

Payment-gating trigger on `test_requests.status='released'` is
**unchanged** — it fires per row. When the medtech finalises a
chemistry consolidated form, the server-action releases all linked
test_requests in one transaction; each row hits the trigger
independently and each must individually pass payment-gating.

### 5.7 RLS

`result_values` policies that currently walk
`result_id → results.test_request_id → test_requests` now walk
`result_id → result_test_requests → test_requests`. Same intent, one
extra join. The medtech "owns" a result_values row if **any** linked
test_request has `assigned_to = auth.uid()`.

`result_test_requests` itself gets RLS:
- read: staff with role in (reception, medtech, pathologist, admin)
- write: admin + server-action only (service-role bypasses)

`report_groups`: read for all staff roles; admin-only write
(matches the `result_templates` pattern).

### 5.8 Decision: drop `results.test_request_id` in the same migration

Cleaner. Migration is reversible if needed. No two-stage drop.

## 6. Service inventory (Chemistry group)

The Chemistry consolidated form has 13 canonical rows. For each row
we need a `services` row mapped to `report_group_id = CHEMISTRY`. The
seed migration must:

| Row | Existing service code | Status |
|---|---|---|
| FBS / RBS | `FBS` (and the template `FBS_RBS` covers both) | Existing — add `report_group_id`. May need a separate `RBS` service if à la carte RBS is sold. |
| BUN | — | **Create** new service `BUN` |
| Creatinine | `CREA` | Existing — add `report_group_id` |
| Uric Acid | — | **Create** new service `BUA` (Blood Uric Acid) |
| Triglycerides | — | Currently only sold as part of `LIPID` — see below |
| Cholesterol | — | Currently only sold as part of `LIPID` — see below |
| HDL | — | Currently only sold as part of `LIPID` — see below |
| LDL | — | Currently only sold as part of `LIPID` — see below |
| VLDL | — | Currently only sold as part of `LIPID` — see below |
| SGPT (ALT) | `SGPT` | Existing — add `report_group_id` |
| SGOT (AST) | `SGOT` | Existing — add `report_group_id` |
| HBA1C | — | **Create** new service `HBA1C` |

**Lipid handling.** Two options on the table; spec picks (a):

(a) Keep `LIPID` as the only purchasable lipid line item (bundle
priced); it maps to the Chemistry group. When ordered, it counts as
5 rows on the consolidated form. The 5 lipid sub-rows are not sold
à la carte. Simplest; matches current pricing.

(b) Split `LIPID` into 5 individual services (TRIG, CHOL, HDL, LDL,
VLDL). Allows à la carte ordering of any single lipid value. More
work and a pricing decision.

Recommend (a) unless the lab actually sells individual lipid items.

Old `LIPID` result_template (separate per-service template with 5
rows) gets `is_active = false` — its parameters fold into the
Chemistry template instead.

**Status of new services.** BUN, BUA, HBA1C: prices need to be set
by the user before seeding the migration. Spec marks these as
"price = TBD by user during implementation."

## 7. The Chemistry result_template

One row in `result_templates`:
- `service_id = null`
- `report_group_id = CHEMISTRY.id`
- `layout = 'dual_unit'`
- One `result_template_params` row per Chemistry test, with SI +
  conventional ranges + gender-specific overrides where applicable.
  Ranges and gender-overrides copied from the reference Google Sheet
  (already captured in this conversation).

Existing per-service templates for `FBS_RBS`, `CREATININE`,
`SGPT_ALT`, `SGOT_AST`, `LIPID_PROFILE` are deactivated
(`is_active = false`) in the same migration. They stay in the table
for historical results that reference them.

## 8. Signature storage and rendering

### 8.1 `staff_profiles` delta

```sql
alter table public.staff_profiles
  add column signature_path text,
  add column signature_uploaded_at timestamptz;
```

`signature_path` is the Supabase Storage path inside the
`signatures` bucket (e.g., `signatures/<staff_id>.png`). Null if no
signature has been uploaded yet.

### 8.2 Supabase Storage bucket

- Bucket name: `signatures`
- **Private** (not public). No public URLs, no signed URLs ever
  given to clients.
- Read access: service-role only. Renderer (Server Action) fetches
  bytes via the admin client.
- Storage policies: deny all to authenticated; service-role bypasses
  by design.

### 8.3 Render pipeline

The renderer (already uses pdf-lib for the consolidated PDF in
Phase 14) gets a small helper:

```ts
async function embedSignature(staffId: string, pdfDoc: PDFDocument): Promise<PDFImage | null>
```

Fetches the staff's `signature_path` from `staff_profiles`,
downloads bytes from Storage via the admin client, returns an
embedded image. Caches per-render (the consultant pathologist's
signature is embedded once per render even if multiple sections
need it). Returns `null` when the staff has no signature on file —
renderer falls back to typed-name-only block (existing behavior).

### 8.4 Who signs which form

| Form category | Performing signature | Consultant signature |
|---|---|---|
| Chemistry (consolidated) | Medtech who finalised | Pathologist (Tagayuna) |
| CBC, Urinalysis, Hematology, structured lab | Medtech who finalised | Pathologist (Tagayuna) |
| X-ray (any) | Radiologist (Mariano) | Pathologist (Tagayuna) |
| Ultrasound | Radiologist (Mariano) | Pathologist (Tagayuna) |
| ECG | Cardiologist (Vicencio) | Pathologist (Tagayuna) |
| Send-out (uploaded PDF) | Untouched | Untouched |

"Medtech who finalised" = the staff_profile whose user clicked
**Finalise** on the consolidated form. Stored on `results` as a new
column `finalised_by_staff_id`.

The radiologist and cardiologist are static (pulled from env-var
staff_ids, not from `test_requests.assigned_to`). Same pattern as the
pathologist.

### 8.5 Env vars

```
CONSULTANT_PATHOLOGIST_STAFF_ID=<tagayuna's staff_profiles.id>
CONSULTANT_RADIOLOGIST_STAFF_ID=<mariano's staff_profiles.id>
CONSULTANT_CARDIOLOGIST_STAFF_ID=<vicencio's staff_profiles.id>
```

All three are required in production. The render path throws a
typed error and refuses to finalise if any is missing or points at a
non-existent staff_profile — fail-fast rather than ship a PDF
without a signature.

Added to `.env.example` and `README.md` env-var inventory.

### 8.6 New staff_profiles rows

Mariano and Vicencio aren't current DRMed staff. The seed script
creates them as soft-active staff_profiles with no Supabase Auth user
attached (`auth_user_id = null`). They never log in — they exist only
to provide signature metadata for the renderer.

Implication: the staff_profiles table must allow `auth_user_id` to
be nullable. Check current schema — if it's already nullable, no
change. If not, add a migration step. (Existing soft-delete migration
from d159e5b is a recent precedent for relaxing constraints on
staff_profiles.)

Their `prc_license_no` and `prc_license_kind` fields are populated
(`MD` for both).

## 9. Medtech UI

### 9.1 Queue grouping

The medtech queue today shows one row per `test_request`. After this
spec, chemistry test_requests are grouped: one card per
(visit_id, report_group_id) tuple, labelled e.g. "Chemistry — DRM-ID
2025-0123, 5 tests".

Implementation: queue page query joins through
`services.report_group_id`. Group-by visit + report_group when non-null,
fall through to per-test for non-grouped services. Sort order is
the earliest `test_request.created_at` in the group.

Claiming a card claims all chemistry test_requests in the group for
that visit (`assigned_to = auth.uid()` on each). The card label
shows which 5 of 13 are actually ordered.

### 9.2 Encoding form

Opening a Chemistry card opens the full 13-row consolidated form.
Only the rows whose service is actually ordered on the visit are
**enabled**; the others are visibly greyed out and not editable.
Finalise creates one `results` row + **N** `result_test_requests`
links (one per ordered chemistry service on the visit) + **M**
`result_values` rows (one per enabled parameter that the medtech
filled — blanks are not stored).

The greyed rows are still printed on the PDF as the parameter name +
blank value cell (matching the reference sheet's visual layout).

### 9.3 Finalise → release

Pressing Finalise on the consolidated form:
1. Inserts `results` row with `report_group_id = CHEMISTRY`,
   `generation_kind = 'structured'`, `finalised_at = now()`,
   `finalised_by_staff_id = <signed-in medtech>`.
2. Inserts one `result_test_requests` row per ordered chemistry
   test on the visit.
3. Inserts one `result_values` row per filled parameter.
4. Trigger flips each linked test_request to `result_uploaded` or
   `ready_for_release` (chemistry = no signoff → `ready_for_release`).
5. Server-action transitions each test_request to `released` in the
   same transaction. The payment-gating trigger fires per row; if
   the visit is unpaid, the entire transaction rolls back with the
   same user-facing message the reception team already sees today.
6. Renderer generates the consolidated PDF and stores it under
   `results.pdf_path`.

If payment-gating blocks: the medtech sees "This visit isn't paid
yet — please ask reception to take payment, then try again." Nothing
is saved.

## 10. Patient portal

Today the portal lists one card per `results` row, and reads the
linked test_request's service name for the card label via the
`results.test_request_id` FK. After this spec the join goes through
`result_test_requests`. Two label paths:

- For grouped reports (`results.report_group_id` non-null): the
  report group's name ("Chemistry"). Sub-line lists the actual
  ordered tests (e.g., "FBS, Lipid Profile, HbA1c").
- For ungrouped reports: the single linked test_request's service
  name (unchanged from today, just resolved via the junction).

The PDF download endpoint stays the same; it returns one PDF per
`results.id`. Audit logging on download already keys by
`results.id`, so no change.

## 11. Reception UI

**No changes.** Reception still books individual services with
individual prices. The consolidation is purely a downstream rendering
concern.

## 12. Audit logging

New / changed events:

- `result.finalised` — one event per consolidated form (or per
  single-test results row); payload includes `results.id` and the
  array of linked `test_request_ids`. Replaces N per-test "result
  uploaded" events for grouped reports.
- `result.released` — same pattern (one event for the whole
  consolidated release).
- `result.viewed` / `result.downloaded` — keyed by `results.id`
  (unchanged shape).

## 13. Seed scripts

### 13.1 `scripts/seed-signatures.ts`

Reads PNGs from a local directory (default
`scripts/seed/signatures/`), uploads to the private `signatures`
bucket using the admin client, updates each `staff_profiles.signature_path`.

Idempotent: re-running with the same files no-ops (uses
content-hash check before reupload). Logs uploaded staff names.

Adds `scripts/seed/signatures/` to `.gitignore` so the PNGs never
land in source control.

### 13.2 Migration script: Chemistry seed

Single migration `00XX_chemistry_consolidated_form.sql` does the
whole thing in order:
1. Create `report_groups` table + seed Chemistry row.
2. Add `services.report_group_id`.
3. Add `result_templates.report_group_id` + nullable `service_id` +
   XOR check.
4. Create `result_test_requests` junction.
5. Backfill junction from `results.test_request_id`.
6. Drop `results.test_request_id`; add `results.report_group_id`,
   `results.finalised_by_staff_id`.
7. Insert new chemistry services (BUN, BUA, HBA1C) — prices set by
   user before commit.
8. Update existing chemistry services (FBS, CREA, SGPT, SGOT, LIPID)
   to set `report_group_id`.
9. Deactivate per-service Chemistry-overlapping result_templates
   (`FBS_RBS`, `CREATININE`, `SGPT_ALT`, `SGOT_AST`, `LIPID_PROFILE`)
   via `is_active = false`.
10. Insert the Chemistry consolidated `result_templates` row +
    `result_template_params` rows for the 13 parameters with their
    ranges/gender overrides.
11. Add `staff_profiles.signature_path`,
    `staff_profiles.signature_uploaded_at`.
12. Relax `staff_profiles.auth_user_id` to nullable if the current
    schema still has a `not null` constraint (verify in the
    implementing migration; add the `alter column ... drop not null`
    only if needed).
13. Insert staff_profiles rows for Mariano + Vicencio.
14. Update existing trigger functions to walk the junction.
15. Update RLS policies on `result_values` to walk the junction.
16. Add RLS policies on `result_test_requests` and `report_groups`.

After migration: run `npm run db:types` and `scripts/seed-signatures.ts`.

## 14. Cutover and in-flight work

Risk: at deploy time, in-flight chemistry test_requests may be in
`in_progress` with the medtech expecting the per-test UI.

Mitigation: deploy during the lab's daily-close lull (after EOD cash
reconciliation). The migration backfills `result_test_requests` so
any chemistry test that already has a `results` row keeps its 1:1
shape. Test_requests in earlier statuses (`requested`, `in_progress`,
`result_uploaded`) get re-routed to the new UI on next page load —
the medtech sees them grouped instead of individual. No data loss.

Smoke before deploy:
- Open a chemistry test_request in `in_progress` from a fixture
  visit. Confirm it shows up grouped after the migration.
- Confirm an existing released chemistry result still renders its
  old PDF.

## 15. Smoke tests

New script `scripts/smoke-chemistry-consolidated.sql` (mirrors the
12.A / 14 pattern):

1. **S1 — order ≥2 chemistry items, finalise, single PDF.**
   Create a paid visit with FBS + Lipid + HBA1C (= 3 ordered
   services covering 7 of the 13 chemistry params). Run the
   medtech server-action to finalise. Assert one `results` row,
   three junction rows, seven `result_values` rows, one PDF file
   written.
2. **S2 — order 1 chemistry item.** Create a paid visit with just
   FBS. Same path. Assert single `results` row, one junction row,
   one PDF — but rendered with the same 13-row layout (the other 12
   rows blank).
3. **S3 — payment gating.** Create an unpaid visit with chemistry.
   Try to finalise. Assert P0030 trigger fires; nothing inserted.
4. **S4 — RLS, medtech ownership.** Medtech A claims half of a
   visit's chemistry; medtech B claims the other half. Confirm both
   can read each other's `result_values` (because the result is
   shared) and that release uses whoever clicks Finalise as
   `finalised_by_staff_id`.
5. **S5 — signatures.** Render a Chemistry PDF. Assert the embedded
   medtech signature image bytes are present and the consultant
   pathologist signature is present. Render an X-ray PDF. Assert
   radiologist signature is present. Render an ECG PDF. Assert
   cardiologist signature is present.
6. **S6 — env-var fail-fast.** Unset
   `CONSULTANT_PATHOLOGIST_STAFF_ID`. Try to finalise any result.
   Assert a typed error fires; no PDF written.

Plus a Playwright UI smoke at 390×844 confirming the medtech queue
shows one Chemistry card and the form's 13 rows render correctly with
greyed-out unordered rows.

## 16. Migration sequence and dispatches

This is large enough to plan as multiple sub-dispatches once
writing-plans takes over. Provisional dispatch list:

- **D1** — Migration + types regen + RLS + trigger updates.
- **D2** — `scripts/seed-signatures.ts` + bucket creation.
- **D3** — Renderer: signature embedding for all existing templates
  (CBC, Urinalysis, X-ray, ECG, send-out untouched).
- **D4** — Chemistry consolidated template + renderer support for
  group-level templates.
- **D5** — Medtech UI: queue grouping + consolidated form page +
  finalise action.
- **D6** — Patient portal label update + smoke 1–5.
- **D7** — Env-var fail-fast + smoke 6 + Playwright UI smoke.

Each ends with a passing smoke and a Conventional Commit.

## 17. Out of scope (explicit)

- Admin UI to manage report_groups or membership.
- Admin UI to upload signatures.
- Backfill of already-released chemistry results into consolidated
  shape.
- Per-test partial release within a consolidated form.
- Multiple consultant pathologists / radiologists / cardiologists.
- Lipid-as-individual-services pricing change (recommend deferring
  unless the lab actually sells lipid à la carte).

## 18. Open questions for the user

1. **Lipid pricing.** Spec assumes (a) — keep LIPID as a single
   purchasable bundle that maps to the Chemistry group. Confirm or
   switch to (b) — split into 5 individual services.
2. **New service prices.** BUN, BUA (Uric Acid), HBA1C: need PHP
   prices before the migration can be committed.
3. **RBS as separate service?** Today only `FBS` exists as a
   service; the template was `FBS_RBS`. Should we add a separate
   `RBS` service for à-la-carte random blood sugar, or treat it as a
   reception-side override on `FBS` (same row, different label on
   the printed form)?
4. **Local path for signature PNGs during seeding.** Default is
   `scripts/seed/signatures/<staff_id>.png` — confirm or override.
5. **Migration deploy window.** Confirm we deploy after EOD cash
   reconciliation, when chemistry queue is typically empty.
6. **X-ray and ECG signature workflow change.** Today X-ray PDFs
   are finalised by an `xray_technician`-role user; today's ECG PDF
   render may or may not already carry an MD signature. After this
   spec, both PDFs get the consultant radiologist (Mariano) or
   cardiologist (Vicencio) signature plus the consultant pathologist
   — auto-included regardless of who actually claimed the
   test_request. Confirm this is the desired behavior (it follows
   directly from Q5=C, but worth flagging since it changes who's
   visibly responsible on the printed PDF).

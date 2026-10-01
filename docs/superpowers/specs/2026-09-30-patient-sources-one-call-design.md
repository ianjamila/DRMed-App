# Patient Sources — one call per page view (Sheet Sync extra (b))

Status: **design approved in brainstorm 2026-09-30** (option A — one combined call; option B
snapshot table rejected: staleness + a new writer/invalidation path for no need). Migration
**0206** (claimed). Branch `feat/patient-sources-report`, worktree `.worktrees/ps-report-bundle`,
off origin/main `9cb84443`.

## 1. Problem

`/staff/marketing/patients` makes 8 identity-dependent RPC calls per view — summary, series ×4
(chart grain, this period by channel, previous period by channel, new-per-day), revenue,
overlaps, referrers — plus 2 ad-spend calls. Each identity-dependent call re-runs
`_patient_sources_identities()` (which itself runs `_patient_sources_encounters()`); summary and
served-mode series run the encounters again; revenue and overlaps each build
`_ps_revenue_lines()`. A series response over 1,000 rows is paged with `.range()`, re-running the
whole function per page.

Prod, 2026-09-30 (app-only data, sync paused; read-only, rolled back): identity core **185 ms**
(6,885 identities), encounters 63 ms (14,260), summary 250 ms, series day/served 260 ms (1,147
rows → 2 pages), series day/new 177 ms. One page view ≈ **2 s of database time**. The calls run
as separate statements, so a sync run finishing mid-load can make the cards disagree.

Prototype (same conditions): building the identity + encounter lists once as composite arrays
= **260 ms**; sections over the arrays = **15–45 ms** each with identical row counts
(1,147 / 809).

## 2. Goals / non-goals

Goals
- Identity core, encounters and revenue lines built **once** per page view; every card reads one
  snapshot (one statement).
- **No number changes**: every existing RPC returns exactly what it returns today.
- Each section's rule lives in exactly one SQL definition.
- The CSV export gets the same benefit (one call, no paging).

Non-goals
- The people page / people CSV (`patient_sources_people`) — stays as is.
- The identity core rules (`_patient_sources_identities`, `_patient_sources_encounters`,
  `_ps_survivors`, `_ps_revenue_lines`) — bodies unchanged.
- A snapshot/cache table; "numbers as of" UI; Phase 5 email (separate PR, will read the new call).

## 3. Database (migration 0206)

### 3.1 Row types
- `public._ps_identity` — composite matching `_patient_sources_identities()` columns
  (identity, confirmed, survivor_id, loose_key, first_date, basis, is_returning, channel,
  referrer_raw).
- `public._ps_encounter` — matching `_patient_sources_encounters()` (identity, survivor_id,
  loose_key, service_date, source).
- `public._ps_revenue_line` — matching `_ps_revenue_lines()` output.
- A post-condition asserts each type's attribute names/types equal the producing function's
  result columns (so a later change to the core that forgets the type aborts the deploy).
- `USAGE` on the types revoked from `public, anon` where Postgres allows; the types carry no data.

### 3.2 Section helpers (internal)
One `language sql stable set search_path = ''` function per section, taking arrays, **no gate**
(callers gate), `revoke all … from public, anon, authenticated, service_role`:

| helper | inputs | body = today's body of |
|---|---|---|
| `_ps_sec_summary(ids, enc, from, to)` | identities, encounters | `patient_sources_summary` (0199) |
| `_ps_sec_series(ids, enc, from, to, grain, mode)` | identities, encounters | `patient_sources_series` (0199) |
| `_ps_sec_revenue(ids, lines)` | identities, revenue lines | `patient_sources_revenue` (0189) |
| `_ps_sec_overlaps(lines)` | revenue lines | `patient_sources_overlaps` (0189) |
| `_ps_sec_referrers(ids, from, to, limit)` | identities | `patient_sources_referrers` (0193) |

Bodies are copied verbatim with `public._patient_sources_identities()` →
`unnest(p_ids)`, `public._patient_sources_encounters()` → `unnest(p_enc)`,
`public._ps_revenue_lines(p_from, p_to)` → `unnest(p_lines)`. Input validation that the RPCs do
today (grain/mode 22023, `_ps_check_period`, `_ps_assert_mirror_mode`) stays in the callers, in
the same order, so the same error wins for the same bad input.

`_ps_sec_series` keeps the `order by 1, 2`; wrappers keep their existing `order by` so PostgREST
`.order()` paging is unaffected.

### 3.3 Existing RPCs become wrappers
`patient_sources_summary`, `_series`, `_revenue`, `_overlaps`, `_referrers`: identical
signature, return columns, `security definer`, `search_path = ''`, gate, validation order and
ACLs (summary + series: `has_role(admin) OR coalesce((select auth.role()), '') = 'service_role'`,
EXECUTE authenticated + service_role; revenue/overlaps/referrers: `has_role(admin)` only,
EXECUTE as today). Each builds only the arrays it needs, once, then `return query select * from
public._ps_sec_…(…)`. 0199's post-condition text (`coalesce((select auth.role()), '') =
'service_role'`) must still match summary + series.

### 3.4 New `patient_sources_report`
```
patient_sources_report(p_from date, p_to date, p_grain text, p_mode text,
                       p_prev_from date default null, p_prev_to date default null)
returns jsonb   -- stable, security definer, search_path = ''
```
- Gate: `has_role(admin) OR coalesce((select auth.role()), '') = 'service_role'` (the coalesce is
  load-bearing: without it a no-claims session fails open). Deliberate: this lets the server key
  read revenue/overlaps/referrers through the report, which the single RPCs keep admin-only —
  the server key already bypasses RLS everywhere; Phase 5 needs it. EXECUTE: authenticated,
  service_role; revoked from public, anon.
- Validation, in order: gate → `_ps_assert_mirror_mode()` → `_ps_check_period(p_from, p_to)` →
  grain/mode (same messages + 22023) → previous period: both null = no comparison; exactly one
  null = 22023; both set = `_ps_check_period(p_prev_from, p_prev_to)`.
- Builds once: `v_ids` (identities), `v_enc` (encounters), `v_lines`
  (`_ps_revenue_lines(p_from, p_to)`).
- Returns
  ```
  { "summary":   {…one row, same keys as patient_sources_summary…},
    "series":    [ {bucket_start, channel, confirmed, unconfirmed}… ]   -- p_grain, p_mode
    "current":   [ … ]   -- grain 'period', p_mode
    "previous":  [ … ] | null   -- grain 'period', p_mode over the previous period
    "new_by_day":[ … ]   -- grain 'day', mode 'new'
    "revenue":   [ {channel, confirmed_php, unconfirmed_php}… ],
    "overlaps":  [ {patient_id, drm_id, service_date, app_php, sheet_php}… ],
    "referrers": [ {doctor_label, new_confirmed, new_unconfirmed}… ] }  -- limit 20
  ```
  Arrays keep each RPC's `order by`. Numerics are emitted as JSON numbers (`numeric(14,2)`
  values unchanged). The previous-period series uses the same `v_ids`/`v_enc` (the core does not
  depend on the period).
- Size bound: 400-day period × ~20 channels ≈ 8k series rows ≈ well under 2 MB.

### 3.5 Post-conditions (abort deploy)
anon cannot execute any of the six public functions; authenticated can execute the six;
service_role can execute summary, series, report; the five section helpers not executable by
anon/authenticated/service_role; every gate string present; the three types match
their producers (3.1).

## 4. App

- `src/lib/marketing/patient-sources.server.ts` gains `loadPatientSourcesReport(supabase,
  { from, to, grain, mode, prev: {from,to} | null })` → `ReportResult<PatientSourcesReport>` with
  sections typed as today's `SummaryRow`, `SeriesRow[]`, `RevenueRow[]`, `OverlapRow[]`,
  `ReferrerRow[]` (a parser in `patient-sources.ts` validates shape and coerces numbers; a
  malformed reply is an error, not a crash). Errors go through `classifyReportError` unchanged.
  The RPC name appears only in this file (`patient-sources-surfaces.test.ts` updated).
- `marketing/patients/page.tsx`: `Promise.all([loadPatientSourcesReport(...), loadAdSpendTotals,
  loadAdSpendCoverage])`. When `prev.from < PATIENT_SOURCES_MIN_DATE` pass `prev: null`. Report
  failure → the existing summary-failure alert (same message). Section components receive the
  same props as today; the `truncated` flag for series stays (false from the report; the
  export cap still applies — see CSV).
- `api/admin/reports/patient-sources.csv/route.ts`: one `loadPatientSourcesReport` call (prev
  null); `summary` + `series` from it; `REPORT_EXPORT_MAX_ROWS` cap + truncated flag applied to
  the series exactly as `pageAll` does today; status codes unchanged (403 forbidden, 500 else).
- Unchanged callers: Booking Sources (`marketing/sources/page.tsx`, summary), admin dashboard
  tile (`loadNewPatientsToday`, series), people page + people CSV.

## 5. Tests and proofs

DB (`scripts/patient-sources-db-proof.ts`, isolated stack, seeded non-empty data —
assert the seed yields non-zero rows for every section before comparing):
1. **Before/after equivalence**: on the stack at current main head (0204), record outputs of the five
   RPCs over a grid (≥3 periods incl. one at 2023-12-01 and one 400 days long; grains day/week/
   month/period; modes new/served); apply 0206; re-run; every row equal.
2. **Report = wrappers**: every section of `patient_sources_report` equals the matching RPC,
   with prev null and prev set; `previous` is null iff prev null.
3. **Gate matrix** for report (and unchanged for the five): anon refused; authenticated
   non-admin 42501; admin viewing-as reception 42501; admin OK; service_role OK; no JWT claims
   42501.
4. **Validation**: bad grain/mode, period > 400 days, start before 2023-12-01, half a previous
   period, bad previous period → 22023 with today's messages.
5. **Controls must bite** (edit, re-run, expect FAIL): drop a section from the report jsonb;
   feed `current` the wrong mode; remove the coalesce in the report gate; change one helper's
   filter. **Re-point existing controls A–L** whose edits target 0189/0193/0199 section bodies
   to the live 0206 definitions (a control editing a superseded body proves nothing); controls
   on the untouched core stay where they are.
6. Existing proofs stay green: patient-sources, sheet-sync.

App (vitest): report parser (well-formed, missing section, wrong types, null previous);
page makes exactly one report call and no other identity RPC; CSV route (success, forbidden,
error, truncation); surfaces test.

Prod (read-only, `begin … rollback`, service_role claims) before merge: time
`patient_sources_report` vs the 8 calls; record in the PR.

Gate: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, db proofs above;
`npm run db:types` from an isolated stack (new RPC in `src/types/database.ts`).

## 6. Rollout and docs

- One PR. Also adds **0203, 0204 and 0206** to the CLAUDE.md migration ledger; guide version
  bump at merge time (after merging main); guide content: no staff-visible change except that
  the page's numbers now always agree — add one sentence to the Patient Sources section.
- `supabase db push` (dry run first; user approves the prompt) right before merge from this
  worktree on current main; verify by object (ledger 0206, report ACLs, helpers closed, types
  exist, wrappers' gate text); user OK → merge → Vercel production deploy READY.
- 0206 is additive + `create or replace` of the five RPCs with identical signatures: the live app
  keeps working if the push lands before the deploy.

## 7. Follow-ups (not in this PR)
- Phase 5 weekly email + dashboard trend read `patient_sources_report` with the service key.
- "Numbers as of HH:MM" line on the page.
- People page built from the same arrays.

# CLAUDE.md

@AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repo is **shipped (v1.0.0 in production)**. The full feature scope
from `IMPLEMENTATION_PLAN.md` is live; later phases (9, 13, 14) extend
it. Treat `IMPLEMENTATION_PLAN.md` as **historical reference**, not a
build-from-scratch script — the app exists, touch existing code rather
than rebuilding sections.

Key reference artifacts:

- `RELEASE_NOTES.md` — what's actually shipped, per release
- `IMPLEMENTATION_PLAN.md` — original phase plan (historical; cross-check before relying on it)
- `README.md` — operational setup
- `.env.example` — env-var inventory
- `docs/superpowers/specs/` and `docs/superpowers/audits/` — design specs and audits for
  every post-1.0 programme (partner revisions, release lifecycle, group templates, EOD
  denomination count…). Read the spec before re-deriving a design decision.

Migration ledger: **prod head = 0132**, repo↔prod in sync (2026-09-02). There is ONE
Supabase project (= prod, ref `qhptbmafrosgibooelpp`); there is no staging project — the
local stack is staging.

## Domain skills — consult these before re-exploring

There are `drmed-*` Agent skills that already map the tricky subsystems. They
auto-trigger on relevant keywords, but check the matching one first rather than
rediscovering a surface from scratch:

- **drmed-migrations** — schema changes, Supabase migrations, RLS policy + audit-row + payment-gating + function-ACL checklist, applying to prod, P-code registry.
- **drmed-payments** — the whole money flow: pricing (discounts, doctor fees), payments, the release + lab-queue payment gates, voids, soft-delete of unpaid entries, cash drawer / EOD denomination count, HMO, PF payouts, the GL bridge.
- **drmed-result-templates** — lab result templates, the consolidated chemistry group template, structured result entry, lab queue / results archive worklists, the PDF render pipeline, sign-off / release.
- **drmed-rls-and-auth** — staff vs patient auth, the portal patient client (JWT claim → RLS), audit logging, MFA, signed URLs, rate-limit buckets, function ACLs, RA 10173 — the most compliance-sensitive surface.
- **drmed-staff-ui** — staff-portal "chrome": sidebar nav config, the shared `SectionTabs`, page headers + filter chips, dashboard cards, printable slips.
- **drmed-booking-and-intake** — appointments/booking/registration: the shared booking core (`src/lib/appointments/{timing,create}.ts`, `src/lib/patients/resolve.ts`), public `/schedule`, staff "+ New appointment" slide-over, `/register` self-reg + reception QR poster.

The `drmed-*` skills are git-tracked under `.claude/skills/` — update the matching skill in
the same PR that moves a file it cites. The other folders under `.claude/skills/` (ads,
copywriting, seo…) and `.agents/` are an **untracked third-party marketing skill pack**, not
project documentation.

## Project at a glance

`drmed.ph` is a unified Next.js 16 + Supabase app serving three surfaces from one codebase and one domain:

1. **Marketing site** (`/`) — public, SEO-optimized
2. **Patient portal** (`/portal/*`) — patients view/download released lab results
3. **Staff portal** (`/staff/*`) — reception, medtechs, pathologists, admins

Compliance target: **Philippine Data Privacy Act (RA 10173)**. Locale: en-PH, Asia/Manila, PHP currency.

## Common commands

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run vitest unit tests once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run db:types` | Regenerate `src/types/database.ts` from the local Supabase project — run after every migration that changes columns/RPCs |
| `npm run db:types:remote` | Same, against the live DB via `SUPABASE_DB_URL` — **currently unusable** (`SUPABASE_DB_URL` is commented out in `.env.local`; no password on file) |
| `npm run db:diff -- <name>` | Generate a new migration from local schema changes |
| `npm run db:reset` | Reset local Supabase to migrations + `supabase/seed.sql` (destroys local data) |
| `supabase db push` | Apply migrations to the linked remote project — **the user runs this** (`! cd ~/Claude/DRMed && /opt/homebrew/bin/supabase db push`); Claude-run pushes and MCP DDL are blocked by the auto-mode classifier |
| `supabase start` | Run a local Supabase stack (needs Docker) — the only "staging" |
| `npm run seed:test` / `seed:services` / `seed:physicians` / `seed:hmo` / `seed:templates` / `seed:signatures` / etc. | Idempotent seed scripts — target the **local** stack by default (see below) |
| `npm run smoke:results` / `smoke:chemistry` / `smoke:dashboards` | Render-pipeline / consolidated-chemistry / dashboard smoke tests |

There is **no PR-triggered CI** — `.github/workflows/` holds only the scheduled
`db-backup.yml`. The Vercel preview build is the only automated gate, so run
`npm test && npm run typecheck && npm run lint` locally before pushing. Vercel deploys
`main` automatically: **a migration must be on prod before its app PR merges.**

### `scripts/` runners target LOCAL by default — this is load-bearing

Everything under `scripts/` builds a service-role client (RLS bypassed). They
read `.env.development.local` via `scripts/lib/load-env.ts`, **not**
`.env.local` — every `.env.local` in this repo points at the production
project, so the old `--env-file=.env.local` default meant `npm run
seed:services` rewrote the live price list and `npm run dedup:patients
-- --commit` merged real patients.

- Local run: `npm run seed:services` — nothing extra, works from any worktree
  (the loader falls back to the main checkout's `.env.development.local`).
- Deliberate remote run: `SEED_ALLOW_PROD=1 npm run seed:services` or
  `npm run seed:services -- --prod`.
- `requireLocalOrExplicitProd()` independently refuses any non-local
  `NEXT_PUBLIC_SUPABASE_URL` **or** `SUPABASE_DB_URL` without that opt-in, and
  prints host + project ref + what the script writes before proceeding.

When adding a script that touches the database: `import "./lib/load-env"` first,
then call `requireLocalOrExplicitProd("<npm script name>", { writes: "…" })`
**before the client is built** — not just before the `--commit` path, since a
dry-run that reads live rows is still a live read. `npm test` enforces this:
`scripts/lib/guard-coverage.test.ts` walks each runner's module graph and fails
when a service-role client is reachable before the guard.

Every runner with a `--commit` mode additionally requires `--confirm=<target>`,
where `<target>` is `local` or the Supabase project ref — never a fixed
passphrase. Reuse `requireTargetConfirmation()` from `scripts/lib/env-guard.ts`
rather than inventing another confirm flag; the dry-run branch should print
`expectedConfirmToken()` so the operator can copy it.

Unit tests run on **vitest** (`npm test` / `npm run test:watch`). Single
file: `npx vitest run src/lib/appointments/timing.test.ts`. Single test by
name: `npx vitest run -t "reuses an existing patient"`. Coverage is the pure
logic only (no DB / no RSC) — modules under test must not `import "server-only"`.
`*.test.tsx` is also picked up, for the few *client* components worth asserting
markup on (e.g. the staff sidebar's collapsed-by-default sections): render them
with `react-dom/server`'s `renderToStaticMarkup` and stub their browser hooks —
still no DOM, still no RSC. The smoke scripts above still cover the render
pipeline + integration paths.

## Architecture — the things that aren't obvious from file structure

### Two auth systems, never merge them

This is the single most important invariant in the codebase:

- **Staff** authenticate via **Supabase Auth** (email + password, optional TOTP). Sessions are managed by Supabase. Middleware additionally verifies an active `staff_profiles` row.
- **Patients** do **NOT** have Supabase Auth accounts. They authenticate with **DRM-ID + receipt PIN** (8-char, bcrypt-hashed, scoped to a visit, 60-day expiry). Sessions are short-lived signed JWTs (HS256, `PATIENT_SESSION_SECRET`) in `HttpOnly` `Secure` `SameSite=Strict` cookies named `drmed_patient_session`.

Because patients aren't Postgres-authenticated, the portal bridges to RLS with a **patient-scoped client** (`src/lib/supabase/patient.ts`, `createPatientClient(patientId)`, migration 0114): it mints a 5-minute anon-role JWT carrying a `patient_id` claim (signed with `SUPABASE_JWT_SECRET`), and `current_patient_id()` reads that claim inside every patient RLS policy. **Every portal read uses this client** — `src/lib/portal/portal-scoping.test.ts` fails if a portal file imports the admin client without being allowlisted. The older `set_patient_context()` function still exists but nothing calls it. RLS is the source of truth for access, not application code.

Never use Supabase Auth for patients, and never grant patients direct storage access — they only get 5-minute signed URLs (`src/lib/storage/signed-url.ts`) from a Server Action that audit-logs the access.

### Payment-gating is enforced in the database

A Postgres trigger on `test_requests` blocks any transition to `status = 'released'` unless the parent `visits.payment_status = 'paid'`. The UI also enforces this, but **the trigger is the source of truth**. Never bypass it; never use the service-role client to short-circuit it.

Other DB-side automation to be aware of (details and P-codes in the `drmed-migrations` / `drmed-payments` skills):
- `payments` insert (and void, 0111) recalculates `visits.paid_php` and `visits.payment_status`; `'waived'` is preserved.
- Linking a result to a test (insert on `result_test_requests`) auto-flips `test_requests.status` from `in_progress` → `result_uploaded` (or `ready_for_release` when no pathologist sign-off is configured). For structured results the same flip also happens when `results.finalised_at` transitions from NULL → not-NULL.
- Release also fires the GL bridge (`bridge_test_request_released`: revenue JE + doctor PF accrual; P0034 when a PF-carrying doctor line has no attending physician) and the consent gate (`enforce_consent_before_release`, ships OFF).
- **Soft delete (0125):** `visits` and `test_requests` carry `deleted_at/by/reason`; guard triggers P0042–P0046 decide deletability (only `unpaid`) and block payments/status changes on deleted visits. **Every read of those tables filters `deleted_at is null`.**
- Package headers (0040) auto-promote to `ready_for_release`; components are ₱0 rows with `parent_id`. Multi-row inserts list headers before components.
- The statutory Senior/PWD discount row is locked at 20% (P0047, 0128); the EOD denomination breakdown must tie to the counted total (P0048, 0132).
- Every `raise exception` with a `P00NN` code needs a translation in `src/lib/accounting/pg-errors.ts` (in use: P0001–P0034, P0040–P0048; next free P0049).

### Three Supabase clients with strict separation

- `src/lib/supabase/client.ts` — browser client (anon key)
- `src/lib/supabase/server.ts` — server-component client with cookie handling via `@supabase/ssr`
- `src/lib/supabase/admin.ts` — service-role client. Bypasses RLS. **Server-only.** Only imported by Server Actions, Route Handlers, and Edge Functions. Never import this from a client component or anywhere that ships to the browser. Never import it at module scope from `src/lib/results/` (it breaks `smoke:results` under tsx — lazy-import inside the function instead).
- `src/lib/supabase/patient.ts` — the fourth client: patient-scoped anon JWT for portal reads (see above).

Prefer the RLS-scoped server client for staff reads and exports; reach for the admin client only for audit writes, storage, and RPCs that are service_role-only by design. **SQL functions in `public` default to service_role-only since 0119** — grant `authenticated`/`anon` explicitly only when a JWT genuinely calls one, and check what 0118 left before restating grants on a re-created function.

### Audit logging is mandatory

Every write action in the staff portal, every patient result view/download, every PIN attempt (success and failure), every payment record, every deletion/restore (with a reason), and **every print or export that discloses patient data** (receipts, slips, count sheets, CSVs — `*_printed` / `*_viewed` / `*.exported` actions) **must** insert an `audit_log` row. RA 10173 compliance depends on this. Audit-log inserts happen via the service-role client from server code.

### Server Components by default

Use Server Components for reads. Use Server Actions for writes. Mark client components with `'use client'` only when interactivity demands it. All Supabase calls are typed against the generated `Database` type in `src/types/database.ts`.

### Server Action return shape

All Server Actions return `{ ok: true, data } | { ok: false, error }`. User-facing errors are short and actionable; technical details go to Sentry (Phase 8). Never expose stack traces.

## Hard rules (from `IMPLEMENTATION_PLAN.md` — "What NOT to do")

- Do **NOT** use Supabase Auth for patients — they auth via DRM-ID + PIN.
- Do **NOT** expose `SUPABASE_SERVICE_ROLE_KEY` client-side. Only `src/lib/supabase/admin.ts` may read it.
- Do **NOT** skip RLS — it is the single source of truth for access. Don't paper over RLS failures by reaching for the service-role client.
- Do **NOT** log plain PINs anywhere, ever. Only the bcrypt hash is stored; the plain PIN is returned exactly once when reception creates the visit, for the printed receipt.
- Do **NOT** hardcode service prices in the frontend — always read from the `services` table.
- Do **NOT** add a "Backend API Base" field to the staff login. It's a leftover from a scrapped multi-backend design — the plan calls it out explicitly.

## Where things live

| Concern | Location |
|---|---|
| Staff auth gates (`requireSignedInStaff`, `requireActiveStaff`, `requireAdminStaff`) | `src/lib/auth/require-staff.ts`, `require-admin.ts` |
| Role → lab sections (`sectionsForRole`; `[]` means NO access, never "no filter") | `src/lib/auth/role-sections.ts` |
| Patient auth gate + PIN handling | `src/lib/auth/require-patient.ts`, `pin.ts`, `patient-session.ts` |
| Four Supabase clients (browser / server / admin / patient) | `src/lib/supabase/{client,server,admin,patient}.ts` |
| Patient storage signed URLs (single service-role choke point) | `src/lib/storage/signed-url.ts` |
| Audit-log writer — call from every write action | `src/lib/audit/log.ts` (`audit()`) |
| Server Action helpers (`ipAndAgent`, `firstIssue`) | `src/lib/server/action-helpers.ts` |
| PG error → user-facing message translator | `src/lib/accounting/pg-errors.ts` (`translatePgError`) |
| Manila/PHT date helpers (`todayManilaISODate`, `isISODate`, `shiftISODate`, `manilaRangeUtc`, `friendlyManilaDate`) | `src/lib/dates/manila.ts` |
| Rate-limit checker (per-bucket) | `src/lib/rate-limit/check.ts` |
| Pure visit-domain rules (classification, deletability, lab payment gate, receipt policy, doctor-fee split, visit # search) | `src/lib/visits/{classification,deletion,lab-gate,receipt-policy,consultation-fee,visit-number-filter}.ts` |
| Discount arithmetic (form preview AND server recompute) | `src/lib/pricing/discounts.ts` |
| Shared visit actions (queue delete/restore, PIN re-issue) | `src/lib/actions/visits/{queue-deletion,reissue-pin}.ts` |
| Cash denominations, amount-in-words, PF labels | `src/lib/accounting/{cash-denominations,amount-in-words,pf-labels}.ts` |
| CSV escaping (one copy) | `src/lib/csv/escape.ts` |
| Results-archive tab config, template drift checks | `src/lib/results/{status-filter,template-health}.ts` |
| Shared staff components (page header, section tabs, nav config, delete dialog, no-receipt notice, PIN re-issue button) | `src/components/staff/` |
| Migrations (sequential numbering) | `supabase/migrations/` |
| Script env guard (local by default, `--prod` opt-in, `--confirm=<target>`) | `scripts/lib/{load-env,env-guard}.ts` |

## Out of scope (by design)

- Patient self-service password reset — patients must visit reception for a new PIN (reception can re-issue and print a portal-access slip).
- External PHIC / HMO claims integration. HMO claims and AR are tracked internally under `/staff/admin/accounting/{hmo-claims,patient-ar}`; nothing is submitted electronically.
- Doctor-facing logins / PF statements — doctors are not auth users; they sign a printed acknowledgment slip instead.

## Cross-cutting rules learned the hard way

- **Dates:** the DB runs in UTC and the clinic in Asia/Manila. Every date filter is a half-open Manila window from `manilaRangeUtc` (`gte` start, `lt` next day) — never a naive `${d}T00:00:00` / `T23:59:59` string (read as UTC, 8 hours early). DB `date` defaults use `(now() at time zone 'Asia/Manila')::date`, never `current_date`.
- **PostgREST limits:** aggregates are disabled (`PGRST123`) and a bare select caps at 1000 rows — real aggregates need a SQL function (`visits_classification_summary` is the model); exports chunk with `.range()`. Multi-row inserts NULL-fill keys missing from some rows (not column defaults) — send a uniform key set.
- **Soft delete:** filter `deleted_at is null` on `visits` / `test_requests` in every read surface (queues, results, dashboards, receipts, exports, portal, sheet export). Deletability is `payment_status = 'unpaid'` only.
- **Role sections:** `sectionsForRole(role) === []` is a deny. The lab queue once treated it as "no filter" and showed reception every section.
- **Exports** run under the RLS-scoped server client with an admin gate, a row ceiling, and an audit row — never the service-role client.
- **Print surfaces** each append a named `@page` + `@media print` block at the tail of `src/app/globals.css`; two print PRs in flight always conflict there and the resolution is keep both.
- **`<input pattern>`** is compiled with the RegExp `v` flag — a bare trailing `-` in a class makes the whole pattern silently ignored; write `[a-z0-9\-]+`.
- **A repo-wide guard must cover read paths too**, not only `--commit` branches (a dry-run that reads prod PII is still a disclosure).

## Conventions

- **TypeScript strict mode on.** No `any` without a comment explaining why.
- **Naming:** routes kebab-case, DB columns snake_case, TS variables camelCase, types/components PascalCase, route files kebab-case, component files PascalCase.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Each phase ends with a tagged release (`v0.1.0` after Phase 1, etc.).
- **Plain language by audience.** Reception-facing pages (cash drawer, pay doctors, new visit) use everyday words — humanize raw enum codes shown to users (`petty_cash` → "Petty cash") and avoid accounting jargon (Opening float → "Starting cash", Variance → "Difference"). Bookkeeper/accounting pages (journal, AP, financial statements) keep load-bearing terms (debit/credit, BIR codes, "Pending HMO settlement") and add a plain hint rather than renaming — renaming would be wrong. When unsure which audience a screen serves, ask. (See the `drmed-staff-ui` skill.)

## Schema changes — order of operations

1. Create the migration locally: `npm run db:diff -- <name>` (or hand-write it for function/trigger/policy changes — the diff is noisy for those). Next number = last file + 1; `git fetch` first, parallel sessions have taken numbers before.
2. Replay on a fresh local stack: `supabase start && npm run db:reset` — the full history must apply to an empty DB (data migrations guard, never `raise`, on missing rows).
3. `npm test && npm run typecheck && npm run lint`; add a `pg-errors.ts` translation for every new P-code; restate function ACLs explicitly (see `drmed-migrations`).
4. Open the PR. The Vercel preview build fails if the migration hasn't been applied to the linked project.
5. Apply to prod **before merging**: ask the user to run `! cd ~/Claude/DRMed && /opt/homebrew/bin/supabase db push` (it stamps the ledger with the real `00NN` version). If MCP `execute_sql` is used instead, wrap in `begin; … commit;` and insert the `schema_migrations` row by hand; never MCP `apply_migration` (timestamp version → `db push` re-applies it).
6. Verify on prod (ledger head, objects, grants), merge, confirm the Vercel production deploy landed — merge ≠ deploy.
7. Regenerate types: `npm run db:types` (empty diff for CHECK/trigger/function-only changes is expected).

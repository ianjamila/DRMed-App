# CLAUDE.md

@AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repo is currently in the **planning stage** — no source code exists yet. The active artifacts are:

- `README.md` — user-facing setup instructions (assumes the app has been scaffolded)
- `IMPLEMENTATION_PLAN.md` — the source of truth for what to build, structured as 8 sequential phases
- `.env.example` — full env-var inventory
- `Assets/` — design reference screenshots for the three portals

**Always read `IMPLEMENTATION_PLAN.md` before starting work.** Execute one phase at a time and stop at each phase's verification checklist before proceeding. Do not skip ahead — later phases assume earlier phases' invariants (RLS policies, audit logging, payment-gating trigger) are already in place.

## Project at a glance

`drmed.ph` is a unified Next.js 15 + Supabase app serving three surfaces from one codebase and one domain:

1. **Marketing site** (`/`) — public, SEO-optimized
2. **Patient portal** (`/portal/*`) — patients view/download released lab results
3. **Staff portal** (`/staff/*`) — reception, medtechs, pathologists, admins

Compliance target: **Philippine Data Privacy Act (RA 10173)**. Locale: en-PH, Asia/Manila, PHP currency.

## Common commands (post-scaffolding)

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:types` | Regenerate `src/types/database.ts` from the linked Supabase project — run after every migration |
| `npm run db:diff` | `supabase db diff -f <name>` — generate a new migration from local schema changes |
| `npm run db:reset` | Reset local Supabase to migrations (destroys local data) |
| `supabase db push` | Apply migrations to the linked remote Supabase project |
| `supabase start` | Run a local Supabase stack for testing migrations |

There is no test runner specified in the plan yet. If you add one, document the single-test command here.

## Architecture — the things that aren't obvious from file structure

### Two auth systems, never merge them

This is the single most important invariant in the codebase:

- **Staff** authenticate via **Supabase Auth** (email + password, optional TOTP). Sessions are managed by Supabase. Middleware additionally verifies an active `staff_profiles` row.
- **Patients** do **NOT** have Supabase Auth accounts. They authenticate with **DRM-ID + receipt PIN** (8-char, bcrypt-hashed, scoped to a visit, 60-day expiry). Sessions are short-lived signed JWTs (HS256, `PATIENT_SESSION_SECRET`) in `HttpOnly` `Secure` `SameSite=Strict` cookies named `drmed_patient_session`.

Because patients aren't Postgres-authenticated, the patient portal bridges to RLS via a Postgres function `set_patient_context(patient_id uuid)` that sets `app.current_patient_id`. RLS policies for patient queries read `current_setting('app.current_patient_id')`. The server **must** call this function at the start of every patient request — RLS is the source of truth for access, not application code.

Never use Supabase Auth for patients, and never grant patients direct storage access — they only get 5-minute signed URLs from a Server Action that audit-logs the access.

### Payment-gating is enforced in the database

A Postgres trigger on `test_requests` blocks any transition to `status = 'released'` unless the parent `visits.payment_status = 'paid'`. The UI also enforces this, but **the trigger is the source of truth**. Never bypass it; never use the service-role client to short-circuit it.

Other DB-side automation to be aware of:
- `payments` insert recalculates `visits.paid_php` and `visits.payment_status`.
- `results` insert auto-flips `test_requests.status` from `in_progress` → `result_uploaded` (or `ready_for_release` when no pathologist sign-off is configured for the service).

### Three Supabase clients with strict separation

- `src/lib/supabase/client.ts` — browser client (anon key)
- `src/lib/supabase/server.ts` — server-component client with cookie handling via `@supabase/ssr`
- `src/lib/supabase/admin.ts` — service-role client. Bypasses RLS. **Server-only.** Only imported by Server Actions, Route Handlers, and Edge Functions. Never import this from a client component or anywhere that ships to the browser.

### Audit logging is mandatory

Every write action in the staff portal, every patient result view/download, every PIN attempt (success and failure), and every payment record **must** insert an `audit_log` row. RA 10173 compliance depends on this. Audit-log inserts happen via the service-role client from server code.

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

## Decisions deferred (revisit before Phase 5)

- MFA for staff (TOTP via Supabase Auth; required for `admin`, optional for others initially)
- Pathologist sign-off (`services.requires_signoff` column, default off)
- PIN expiry policy (60 days default; admin can extend per visit)
- Patient self-service password reset is **out of scope** — patients must visit reception for a new PIN.
- PHIC / HMO billing integration is out of scope.

## Conventions

- **TypeScript strict mode on.** No `any` without a comment explaining why.
- **Naming:** routes kebab-case, DB columns snake_case, TS variables camelCase, types/components PascalCase, route files kebab-case, component files PascalCase.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Each phase ends with a tagged release (`v0.1.0` after Phase 1, etc.).

## Schema changes — order of operations

1. Create the migration locally: `supabase db diff -f <name>` (writes to `supabase/migrations/`).
2. Test against a local Supabase instance: `supabase start`, then verify.
3. Open a PR — preview will fail if the migration hasn't been applied to the linked project.
4. Apply to staging Supabase, verify, then production via `supabase db push`.
5. Regenerate types: `npm run db:types`.

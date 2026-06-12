---
name: drmed-migrations
description: Use when working on DRMed database schema changes, Supabase migrations, RLS policies, audit-log obligations, payment-gating trigger considerations, or the migration workflow. Trigger whenever the user mentions migration, new migration, schema change, new table, alter table, alter schema, drop table, drop column, regenerate types, regen types, db:diff, db:types, db:types:remote, db:reset, supabase db push, supabase db reset, supabase migrations, RLS policy, row-level security policy, has_role, current_patient_id, set_patient_context, payment gating trigger, enforce_payment_before_release, audit_log table, audit-log obligation, SECURITY DEFINER, seed script, seed:test, seed:services, seed:templates, smoke:results, or the 89+ files under supabase/migrations/. Also trigger when adding any new table — the skill carries the RLS-template + audit-row + payment-gating checklist. Don't make Claude reconstruct the per-table checklist from scratch.
---

# DRMed migrations & schema workflow

## What this is

89+ sequential migrations under `supabase/migrations/`, zero-padded numeric naming (`0001_init.sql` → `0089_patient_consent_self_registration.sql`). Note the numbering has gaps (e.g. 0056–0058 never existed) — that's fine, both repo and remote skip them identically; gaps are NOT drift. Every schema change has a fixed workflow + a per-table checklist (RLS + audit + payment-gating consideration). Get the checklist wrong and you create either a compliance gap or a query that returns empty silently.

## File structure

```
supabase/migrations/
├── 0001_init.sql                       ← core schema + set_patient_context + payment-gating trigger + has_role + audit_log
├── 0002_function_search_path.sql
├── 0003_patients_pre_registered.sql
├── ...
├── 0007_result_templates_and_values.sql
├── 0009_result_param_age_bands.sql
├── ...
├── 0030_op_gl_bridge.sql
├── ...
└── 0049_ap_subledger_behavior.sql

scripts/
├── seed-test-users.ts                  ← 5 staff users + 1 test patient
├── seed-services.ts                    ← baseline service catalog
├── seed-closures.ts                    ← PH public holidays into clinic_closures
├── seed-package-components.ts          ← package → component map
├── seed-result-templates.ts            ← ~70 lab test templates + params
├── seed-hmo-providers.ts               ← 11 HMO roster
├── seed-physicians.ts                  ← physician roster + recurring schedules
├── import-test-list.ts                 ← ~150-test price list from CSV
├── populate-test-descriptions.ts       ← patient-facing clinical descriptions
└── smoke-render-results.ts             ← render-pipeline smoke test
```

## Standard workflow

```
1. npm run db:diff -- <name>          → writes supabase/migrations/<n+1>_<name>.sql
2. supabase start && supabase db reset → verify against fresh local DB
3. supabase db push                    → apply to linked remote
4. npm run db:types                    → regenerate src/types/database.ts
```

| Script | What it does |
|---|---|
| `npm run db:types` / `db:types:local` | `supabase gen types typescript --local > src/types/database.ts` |
| `npm run db:types:remote` | Same, against remote via `SUPABASE_DB_URL` (requires `.env.local`) |
| `npm run db:diff -- <name>` | `supabase db diff -f <name>` — creates a diff migration |
| `npm run db:reset` | `supabase db reset` — local reset to migrations (destroys local data) |

## Applying a migration to the REMOTE DB from this machine (IPv6 gotcha)

`supabase db push --db-url "$SUPABASE_DB_URL"` **fails from this dev machine.** The
`.env.local` `SUPABASE_DB_URL` points at the direct host `db.<ref>.supabase.co:5432`,
which is **IPv6-only**, and the local network has no IPv6 route:
`dial tcp [2406:...]:5432: connect: no route to host`. Local `supabase db reset` /
push against the local stack (`127.0.0.1:54322`) are unaffected — this is remote-only.
Two ways around it:

- **Supabase MCP (preferred here)** — runs over the HTTPS Management API, no Postgres
  socket, so IPv6 is irrelevant. Use `execute_sql` to run the DDL, then record the
  migration yourself so the sequential history stays in sync with the repo:
  ```sql
  insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('00NN', '<name_without_numeric_prefix>', array['<stmt1>;','<stmt2>;']);
  ```
  Avoid the MCP `apply_migration` for this — it records a *timestamp* version, not the
  `00NN` convention, which leaves an orphan row vs the repo file. DRMed prod project ref:
  `qhptbmafrosgibooelpp` (the other project on the org, `zzcbzeivzfwwmotzlkqw`, is
  Eaglewatch — don't touch it). Confirm only the intended migration is pending first
  via `list_migrations`.
- **IPv4 session pooler** — rebuild the URL as
  `postgresql://postgres.<ref>:<pw>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
  and pass that to `supabase db push`.

There is **one** DRMed remote (= prod); there is no separate staging Supabase project,
so "test on staging first" in practice means the **local stack**.

## Per-new-table checklist (read EVERY time)

1. **RLS** — enable it: `alter table public.<table> enable row level security;`
2. **Staff access policy** — add at minimum a staff-role policy (template below)
3. **Patient access policy** — if patient-readable, add a `current_patient_id()`-scoped policy
4. **Audit obligation** — does any write to this table need an `audit_log` row from the calling Server Action? (Almost always yes for patient-data tables.)
5. **Payment-gating** — does this table represent a billable artifact (result, test request)? Check whether `enforce_payment_before_release()` already covers it or whether a new trigger is needed.
6. **Indexes** — at minimum index FKs that policies join on (e.g., `patient_id`, `visit_id`)
7. **Migration order** — does this table depend on another that may not yet exist? Re-check existing migrations.

## RLS policy templates the skill carries

**Staff full access:**
```sql
create policy "<table>: staff full"
  on public.<table>
  using (public.has_role(array['reception','medtech','pathologist','admin']));
```

**Patient self-select (via current_patient_id):**
```sql
create policy "<table>: patient self"
  on public.<table> for select to anon, authenticated
  using (patient_id = public.current_patient_id());
```

**Release-gated patient access (results pattern):**
```sql
create policy "<table>: patient released only"
  on public.<table> for select to anon, authenticated
  using (
    test_request_id in (
      select tr.id from public.test_requests tr
      join public.visits v on v.id = tr.visit_id
      where tr.status = 'released'
        and v.patient_id = public.current_patient_id()
    )
  );
```

**Admin-only read (sensitive audit/log tables):**
```sql
create policy "<table>: admin select"
  on public.<table> for select
  using (public.has_role(array['admin']));
```

## Critical DB anchors (all in `0001_init.sql`)

| Object | Purpose |
|---|---|
| `set_patient_context(p_patient_id uuid)` | Sets transaction-local `app.current_patient_id`. Called by server code before patient queries. |
| `current_patient_id()` | Reader used inside RLS policies |
| `has_role(text[])` | `SECURITY DEFINER` helper that checks `staff_profiles.role`. Used in nearly every staff RLS policy. |
| `enforce_payment_before_release()` | BEFORE UPDATE trigger on `test_requests`. Raises exception if `NEW.status='released'` and `visit.payment_status ∉ ('paid','waived')`. |
| `trg_test_requests_payment_gate` | The trigger that wires the function above |
| `audit_log` table | `(id bigserial, actor_id, actor_type, patient_id, action, resource_type, metadata jsonb, ip_address, user_agent, created_at)`. Append-only. Admin-read RLS. |

## Audit logging is app-side, not trigger-driven

`audit_log` rows are inserted by server actions (via `audit()` from `src/lib/audit/log.ts`) — not by database triggers. Reason: capturing the actor reliably from inside Postgres is fragile when patients aren't `auth.users`. The skill `drmed-rls-and-auth` covers the `audit()` call pattern in detail.

## Common migration gotchas

- **Migration order matters.** Services must exist before seeding `package_components`. Packages before `result_templates`.
- **Idempotent seeds** — all seed scripts use upsert-on-key so re-runs are safe.
- **`SECURITY DEFINER` for helpers** — `has_role`, `current_patient_id`, and several CoA / role resolvers use SECURITY DEFINER to bypass RLS internally. Use the same pattern for new helpers that policies depend on.
- **Never hardcode prices** in frontend — always read from `services` table; pricing sync to Google Sheets is Phase 7+.
- **Never put plain PINs in any migration.** Only the bcrypt hash is stored in `visit_pins`. The plain PIN is generated in app code, returned exactly once, and never re-derivable.
- **Regenerate types** after every applied migration. Stale `src/types/database.ts` makes new columns invisible to TS and queries silently return undefined for them. (Pure CHECK-constraint or trigger-only changes don't alter generated column types, so `db:types` is a no-op for them — don't be alarmed by an empty diff.)
- **Widening a CHECK constraint?** Postgres stores `check (col in ('a','b'))` as `check (col = ANY (ARRAY['a','b']))`, so a `DO`-block that finds the constraint by matching its definition text for `in (` will NOT match and silently fail to drop it. Drop it by its auto-generated name instead — a column-level inline check is named `<table>_<col>_check` (consistent across environments since it came from the same migration) — with `drop constraint if exists`, then re-add the widened check. Example: 0089 widened `patient_consents.method` to add `'self_registration'`.
- **Unit tests exist now.** The repo uses **vitest** (`npm test`) for pure logic — e.g. `lib/appointments/timing.ts`, `lib/patients/resolve.ts`, the validation schemas. Modules under test must NOT `import "server-only"` (vitest can't load it); keep the pure decision logic separate from the DB-touching orchestration so it stays testable. After a schema change that affects tested logic, run `npm test`.

## Hard rules

- **Every new table gets RLS enabled + at least one policy.** Supabase defaults to "no access" with RLS off → leaks via service-role; with RLS on but no policy → queries return empty. Either way is wrong.
- **Patient-data tables need a `current_patient_id()`-scoped policy.** Never rely on application code alone — RLS is the source of truth.
- **Adding a status enum value to `test_requests.status`?** Re-check `enforce_payment_before_release()` — it currently lists `'released'` as gated. New values may need gating too.
- **All seed scripts must be idempotent.** Use `on conflict` or upsert-by-key.
- **Never edit a migration file after it's been pushed to remote.** Add a new migration to fix mistakes.
- **Never bypass the local-test step.** `supabase db reset` against a fresh local instance catches most foreign-key and constraint errors before they hit prod.

## When this skill should NOT trigger

- App-code-only changes (TSX, Server Actions, lib helpers) that don't touch the schema — use the relevant domain skill.
- Auth flow / RLS policy review work that isn't a new migration — use the `drmed-rls-and-auth` skill (which carries the same RLS templates).
- Lab result template additions — use the `drmed-result-templates` skill (which handles the `result_templates` / `result_template_params` / `result_values` extension flow).
- Read-only data exploration / ad-hoc queries — use `data:sql-queries` or `data:write-query`.

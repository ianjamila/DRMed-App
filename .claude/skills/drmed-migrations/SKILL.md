---
name: drmed-migrations
description: Use when working on DRMed database schema changes, Supabase migrations, RLS policies, audit-log obligations, payment-gating trigger considerations, function grants/ACLs, applying a migration to prod, or the migration workflow. Trigger whenever the user mentions migration, new migration, schema change, new table, alter table, alter schema, drop table, drop column, regenerate types, regen types, db:diff, db:types, db:types:remote, db:reset, supabase db push, supabase db reset, supabase migrations, schema_migrations, apply_migration, execute_sql, RLS policy, row-level security policy, has_role, current_patient_id, payment gating trigger, enforce_payment_before_release, audit_log table, audit-log obligation, SECURITY DEFINER, grant execute, revoke execute, anon-executable, function ACL, default privileges, rls_auto_enable, ensure_rls, P00xx error code, translatePgError, pg-errors, seed script, seed:test, seed:services, seed:templates, seed.sql, smoke:results, or the files under supabase/migrations/ (0001 → 0149, with gaps). Also trigger when adding any new table, trigger, or function — the skill carries the RLS-template + audit-row + payment-gating + ACL checklist. Don't make Claude reconstruct the per-table checklist from scratch.
---

# DRMed migrations & schema workflow

## What this is

Sequential migrations under `supabase/migrations/`, zero-padded numeric naming (`0001_init.sql` → `0149_ap_cash_bill_payment_drawer_link.sql`). The numbering has gaps (0056–0058 never existed) — that's fine, repo and remote skip them identically; gaps are NOT drift. **Prod ledger head = 0156 (2026-09-24, #200); 0155 (#203) was pushed after it with `db push --include-all`. 0157 (`online_booking_staff_alert`) is in flight on `feat/online-booking-alert`; next unused 0158.** When a sibling branch's higher number is already on prod, `db push` fails with `LegacyDbPushMissingLocalError` and suggests `migration repair --status reverted` — never run that; copy the sibling's migration file in untracked, `--dry-run --include-all` (must list only yours), push, delete the copy. Every schema change has a fixed workflow + a per-table checklist (RLS + audit + payment-gating + function ACL). Get the checklist wrong and you create either a compliance gap, an anon-callable RPC, or a query that returns empty silently.

## Landmark migrations (where the load-bearing objects live)

```
supabase/migrations/
├── 0001_init.sql                        ← core schema, has_role, current_patient_id, payment-gating trigger, audit_log
├── 0007/0009/0010                       ← result templates, age bands, flag computation moved to app
├── 0011_accounting_capture.sql          ← hmo_providers, payments.method widened (+hmo/bpi/maybank), discount_kind CHECK (replaced by 0128)
├── 0030_op_gl_bridge.sql                ← bridge_test_request_released (release → revenue JE); superseded bodies in 0064/0091/0109/0131
├── 0040_package_decomposition.sql       ← package headers + tg_test_request_parent_is_header (headers auto-promote to ready_for_release)
├── 0043_eod_cash_reconciliation.sql     ← cash_shifts, eod_close_records, eod_cash_adjustments, cash_drawer_state
├── 0044_payroll.sql                     ← payroll + employee_leave_balance (authz fixed in 0123)
├── 0048/0049                            ← AP subledger schema + behaviour
├── 0053_chemistry_seed.sql              ← ONE consolidated CHEMISTRY group template (per-service chemistry templates deactivated)
├── 0064_pf_cogs_schema.sql              ← doctor PF accrual / disbursement, COGS send-out
├── 0086–0089                            ← patient_consents ledger, consent_settings, enforce_consent_before_release
├── 0090_split_visit_and_consult_anchor  ← visit_group_id (split encounters), CONSULT anchor service row
├── 0109_package_release_lifecycle       ← current bridge_test_request_released body (P0034 attending-physician guard)
├── 0110_undo_release / 0111_payment_void_recalc
├── 0112/0113_booking_*                  ← appointments_insert_slot_guarded + resolve_patient_guarded RPCs (service_role only)
├── 0114_portal_rls_enforcement.sql      ← current_patient_id() reads GUC OR the patient_id JWT claim; portal policies
├── 0118_security_definer_revoke_anon    ← classify-then-revoke: only has_role/is_staff/staff_role stay anon-executable
├── 0119_function_default_privileges     ← new functions in public default to postgres + service_role ONLY
├── 0120–0122                            ← report_group_service_params, template param guardrails (P0041), activation audit
├── 0124_rls_auto_enable_codify.sql      ← ensure_rls event trigger: RLS auto-enabled on every new public table
├── 0125_queue_entry_soft_delete.sql     ← deleted_at/by/reason on visits + test_requests, guard triggers P0042–P0046
├── 0126_visits_classification_summary   ← SQL aggregate for the Visits archive (PostgREST has no aggregates)
├── 0127_manila_date_defaults.sql        ← last current_date defaults replaced by (now() at time zone 'Asia/Manila')::date
├── 0128_discount_types.sql              ← admin-managed discount catalog, statutory guard P0047, one-statutory index
├── 0129_physician_fee_defaults.sql      ← physicians.default_consultation_fee_php + clinic_cut_php
├── 0131_zero_pf_release_exemption.sql   ← P0034 now only fires when coalesce(doctor_pf_php,0) > 0
├── 0132_eod_denomination_count.sql      ← eod_close_records.counted_denominations jsonb, P0048 guard, cash_drawer_state re-created
├── 0133_hmo_release_gate.sql            ← enforce_payment_before_release now passes an HMO-billed visit; ACL back to postgres + service_role
├── 0134_harden_0043_report_views.sql    ← the two 0043 admin-report views: security_invoker = on + revoke anon (authenticated KEEPS its grant — the CSV routes read them via the RLS client)
├── 0135_harden_hmo_and_inventory_views.sql ← the four v_hmo_* views + v_inventory_balances: security_invoker = on + revoke anon AND authenticated. Closed a LIVE anon-readable disclosure (2,031 rows / 292 named patients + their tests). 0134's "the last views still running as their owner" was wrong.
├── 0145_till_cash_single_write_path.sql ← M1: cash out of the till has ONE write path. P0049 guard blocks source_kind='petty_cash' journal entries outright (that enum value is retired — till expenses now reach the GL as source_kind='cash_adjustment' via the eod_cash_adjustments bridge), and drops the now-dead reverse_petty_cash_entry (0102). No backfill: prod had ZERO petty_cash JEs and an empty eod_cash_adjustments/eod_close_records when it landed.
├── 0149_ap_cash_bill_payment_drawer_link.sql ← the THIRD cash door: an AP bill paid out of 1010 now writes its own eod_cash_adjustments row (kind='bill_payment' + bill_payment_id, the gift-code biconditional shape) from an AFTER INSERT trigger on bill_payments — covering BOTH doors into that table, ap_create_bill_payment_with_allocations AND ap_create_bill_paid_on_entry. The row posts NO JE (bridge_cash_adjustment_insert early-returns; ap_bill_payment_bridge already credited 1010 — remove the early return and it is credited twice) and cannot be voided from the drawer (P0052); the void mirrors from bill_payments.voided_at. P0051 covers no-active-shift / no-recording-staff. cash_drawer_state re-created to count the kind as a payout. No backfill: all 75 prod rows are one 2026-05-28 import batch on days that were never closed or counted.
└── 0150_patients_without_consent_report.sql ← v_patients_without_consent: the consent worklist as a FINISHED row set (candidates + visit_count + last_visit_at) so PostgREST sorts, counts and pages server-side. The report was making ~42 round trips and shipping 21,136 rows to render 10 — the SQL itself was never slow (18.5 ms for the whole aggregate), so measure with explain(analyze) before reaching for an index. security_invoker + authenticated-only SELECT (revoke all first; a column revoke is a no-op under a table grant). No new index — 0143's idx_visits_patient_last_visit covers it. No P-code (raises nothing). patients has NO deleted_at column; visits.visit_date is already a Manila calendar date, never cast it to timestamptz.

0152_cash_journal_descriptions.sql       ← readable cash-adjustment JE descriptions; same posting body/ACL as 0149. 0151 was reserved on perf/rls-initplan-realtime; this independent migration does not include or require that RLS change.
0153_booking_settings.sql                ← the online-booking pause singleton (admin switch; service-role reads, one staff-read policy).
0157_online_booking_staff_alert.sql      ← adds the `online_booking` key to Email Alerts: re-creates `staff_alert_settings_key_check` with 4 keys + seeds the row. `staff-alerts.test.ts` pins STAFF_ALERT_KEYS to the LAST definition of that CHECK across migrations ≥0155.
0155_staff_alert_recipients.sql          ← Admin Tools › Email Alerts: `staff_alert_settings` (on/off per staff alert, 3 seeded keys pinned by `staff-alerts.test.ts`) + `staff_alert_recipients` (per-staff override XOR extra address, `subscribed` switch); admin-only RLS; senders read via `resolveStaffAlertRecipients` (service role). No staff row = the alert's role default from `staff-alerts.ts`. Replaced the `CONTACT_ALERT_EMAILS` env var.
0154_website_messages_inbox.sql          ← drops the never-used `inquiries` (refuses if rows appear); `contact_messages` becomes the Website Messages inbox (status/kind/staff_notes/linked_appointment_id/attribution; P0053 immutability trigger; anon access REVOKED — 0004’s `with check (true)` anon INSERT policy let anyone skip the form’s honeypot + rate limit; reception/admin SELECT + UPDATE, no JWT DELETE); `appointments.source` + `attribution` backfilled from `appointment.booked` audit rows; `appointments_insert_slot_guarded` re-created to insert both (ACL restated service_role-only); `contact_message_replies` = append-only reply log (reception/admin SELECT + INSERT as themselves — `sent_by = (select auth.uid())` — no UPDATE/DELETE). CHECK lists pinned by `website-messages-schema.test.ts`; seed.sql carries the matching re-revoke.
0156_contact_message_form_location.sql   ← `contact_messages.form_location` (`home` | `contact`, NULL = received before 0156 → "Not recorded"): which copy of the public contact form sent it. Set by `submitContactMessage` from a hidden field checked against `CONTACT_FORM_LOCATIONS` (unknown → NULL, never rejected); `ContactForm` takes a REQUIRED `location` prop so a new embed must pick one. Re-creates the P0053 guard with the column added. Shown in the inbox, the message page, the staff alert email and Booking Sources.
0157_resolve_patient_referral_source.sql ← `resolve_patient_guarded` re-created (same signature, lock and service_role-only ACL, restated) to insert `referral_source` from `p_fields` on a NEW patient — through a `referral_sources` lookup so an unknown id is NULL, not an FK error — and still never write a matched row. Feeds "How did you hear about us?" on /schedule + /register. Pinned by `resolve-referral-migration.test.ts`.

supabase/seed.sql                        ← post-`db reset` grants (tables + sequences ONLY, never routines) + named re-revokes (0134, 0135, 0136, 0148, 0150, 0154 — `seed-grant-parity.test.ts` fails when a migration revoke is not mirrored)
scripts/lib/                             ← load-env.ts, env-guard.ts (+ guard-coverage.test.ts) — every runner is guarded
scripts/                                 ← seed-*.ts, import-*.ts, smoke-*.ts, plus subdirs history-import/, clinical-backfill/,
                                           clinical-enrich/, patient-dedup/, books-recon/, ops-daily/, seed/, smoke/
```

## Standard workflow

```
1. npm run db:diff -- <name>          → writes supabase/migrations/<n+1>_<name>.sql (hand-write instead when it's a function/trigger/policy change — diff output for those is noisy)
2. supabase start && supabase db reset → full replay on a fresh local DB (this is the ONLY "staging"; there is no staging project)
3. npm test / typecheck / lint         → no PR-triggered CI exists (.github/workflows has only db-backup.yml); Vercel preview is the only gate
4. Apply to prod (see below) BEFORE merging the PR — the Vercel production deploy of merged app code must never run ahead of its migration
5. npm run db:types                    → regenerate src/types/database.ts (CHECK/trigger/function-only changes produce an empty diff — expected)
```

| Script | What it does |
|---|---|
| `npm run db:types` / `db:types:local` | `supabase gen types typescript --local > src/types/database.ts` |
| `npm run db:types:remote` | Same against remote via `SUPABASE_DB_URL` — **currently unusable**: `SUPABASE_DB_URL` is commented out in `.env.local` (no password on file). Hand-extend `database.ts` for a new RPC if you can't run local. |
| `npm run db:diff -- <name>` | `supabase db diff -f <name>` |
| `npm run db:reset` | `supabase db reset` — replays all migrations + `supabase/seed.sql` (destroys local data) |
| `npm run seed:*` | Idempotent seeds, target the LOCAL stack by default (`scripts/lib/load-env.ts`); `--prod` / `SEED_ALLOW_PROD=1` for a deliberate remote run |

## Applying a migration to PROD from this machine

Three facts shape this:

1. **`supabase db push --db-url` fails here** — `SUPABASE_DB_URL` (when set) points at `db.<ref>.supabase.co:5432`, which is IPv6-only and this network has no IPv6 route. The linked-project form (`supabase db push`, keyring password) works from the main checkout; from a worktree, copy `supabase/.temp/{project-ref,linked-project.json,pooler-url}` from the main checkout first.
2. **The auto-mode classifier blocks Claude-run `db push` AND DDL through MCP `execute_sql` against prod** (inconsistently — some read-only `execute_sql` also gets blocked). The working pattern is to ask the user to run it themselves: `! cd ~/Claude/DRMed && /opt/homebrew/bin/supabase db push` — `db push` stamps the ledger with the real `00NN` version, so no correction is needed.
3. **If MCP does go through:** use `execute_sql` with the full DDL wrapped in `begin; … commit;` plus a hand-written ledger row — `insert into supabase_migrations.schema_migrations (version, name, statements) values ('00NN', '<name_without_prefix>', array['…']);`. **Never use MCP `apply_migration`** — it stamps a *timestamp* version, which `db push` then treats as unapplied and re-runs; if it was used, fix the ledger row afterwards. Dry-run idiom: send `begin; <migration>; <probe selects>;` with NO commit — the wrapper discards the open transaction (verify non-persistence before trusting it).

DRMed prod project ref: `qhptbmafrosgibooelpp` (the org's other project `zzcbzeivzfwwmotzlkqw` is Eaglewatch — never touch it). Confirm only the intended migration is pending via `list_migrations` first, and `git fetch` + re-check the ledger immediately before applying — parallel sessions have taken a migration number within minutes before.

## Per-new-table checklist (read EVERY time)

1. **RLS** — `alter table public.<table> enable row level security;` (0124's `ensure_rls` event trigger does this automatically for new public tables, but write it anyway so the migration is self-describing and replays identically).
2. **Staff access policy** — at minimum a staff-role policy (template below). RLS on with no policy = every query returns empty, silently.
3. **Patient access policy** — if patient-readable, a `current_patient_id()`-scoped policy (the portal now really enforces these — see `drmed-rls-and-auth`).
4. **Audit obligation** — does any write to this table need an `audit_log` row from the calling Server Action? (Almost always yes for patient-data tables.)
5. **Payment-gating** — is this a billable artifact? Check whether `enforce_payment_before_release()` already covers it.
6. **Soft-delete awareness** — if rows hang off `visits` or `test_requests`, every read of them must filter `deleted_at is null` on the parent (0125). Mirror the existing queries.
7. **Manila dates** — a `date` column default is `(now() at time zone 'Asia/Manila')::date`, never `current_date` (the DB runs in UTC; 0127 removed the last two offenders).
8. **Indexes** — at minimum FKs that policies join on (`patient_id`, `visit_id`).
9. **Migration order** — dependencies on tables/seed rows that may not exist yet on a fresh replay (`services` is never literally empty on replay — 0090 inserts the `CONSULT` anchor — but data migrations must not `raise` on an empty DB; 0116 did and broke `db reset` until #119).

## Per-new-function checklist (0118/0119 made this mandatory)

- **New functions in `public` default to postgres + service_role ONLY** (0119). If the browser/staff JWT genuinely calls it, add `grant execute on function … to authenticated` (and `anon` only for public-site reads) explicitly. Most RPCs are called from the service-role admin client and need nothing.
- **`create or replace function` on an EXISTING function keeps its current ACL** — check what 0118 left it as before restating grants. 0132 nearly re-granted `authenticated` on `cash_drawer_state` (which reads every payment for a date) because the spec assumed the 0043 grant still stood. Restate the post-0118 ACL explicitly in the migration.
- **`revoke … from public` alone is NOT enough on hosted Supabase** — it also grants EXECUTE to anon/authenticated directly; revoke those by name too. Local lacks those default grants, so local tests MASK the gap.
- **Revoking EXECUTE on a trigger function does not break the trigger** (privilege is checked at `create trigger` time). A SECURITY INVOKER function that nest-calls a SECURITY DEFINER helper DOES need the caller to hold EXECUTE — that's why `eod_lock_check` / `employee_leave_balance` keep `authenticated`.
- **`has_role` / `is_staff` / `staff_role` / `current_patient_id` MUST stay anon-executable** — 123 RLS policies reference `has_role`; revoking makes them RAISE instead of filter.
- **Custom error codes** — every `raise exception … using errcode = 'P00NN'` needs a translation in `src/lib/accounting/pg-errors.ts`. Codes in use: P0001–P0035, P0040–P0053. **Next free code: P0054.** (P0053 = what a website message’s sender wrote cannot be edited — 0154’s `contact_messages_guard_immutable`, re-created by 0156 to cover `form_location`; P0050 = an HMO-claimed visit line cannot be soft-deleted — 0147, PR #174; P0051 = an AP cash bill payment cannot reach the drawer, no active shift or no recording staff; P0052 = that drawer row is owned by its AP payment and can only be voided/edited there — both 0149.) **Claim your code against the OPEN BRANCHES, not just `main`** — #174 and this PR both took P0050 on the same afternoon, and the loser only found out because a local `db reset` from another worktree renumbered the shared stack underneath it. `src/lib/accounting/pg-error-coverage.test.ts` fails the build on a code raised in SQL with no `pg-errors.ts` case, so the registry can no longer drift; its `DEAD_CODES` allowlist is for raise sites a later migration DROPPED (P0037–P0039, killed with `reverse_petty_cash_entry` in 0145) and may only shrink. A BEFORE trigger runs before column CHECK constraints, so if your guard could blow up on malformed input (e.g. `jsonb_each` on a scalar), claim that case yourself and raise a P-code — a raw 22023 has no translation.

## RLS policy templates the skill carries

**Always wrap a helper call as `(select fn(...))`.** `has_role`, `is_staff`, `staff_role`
and `current_patient_id` are all STABLE, but STABLE does not make the planner call them
once — written bare in a policy they are evaluated PER ROW. Wrapping makes it an InitPlan,
evaluated once per query. Migration 0150 targets this pattern; the Visits page baseline
is 2,733 ms and the target is <150 ms (post-migration timing is still to be measured).
`src/lib/supabase/rls-initplan.test.ts` fails on a new policy that reverts to the bare form.

Note the Supabase performance advisor does NOT catch this. Its `auth_rls_initplan` lint
only sees direct `auth.*()` calls, not a helper like `has_role()` that wraps `auth.uid()`
one level down — it reported 10 when the real number was 130.

**Staff full access:**
```sql
create policy "<table>: staff full"
  on public.<table>
  using ((select public.has_role(array['reception','medtech','pathologist','admin'])));
```

**Patient self-select (via current_patient_id):**
```sql
create policy "<table>: patient self"
  on public.<table> for select to anon, authenticated
  using (patient_id = (select public.current_patient_id()));
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
        and v.patient_id = (select public.current_patient_id())
    )
  );
```

**Admin-only read (sensitive audit/log tables):**
```sql
create policy "<table>: admin select"
  on public.<table> for select
  using ((select public.has_role(array['admin'])));
```

**Write-only-via-service-role tables** (`audit_log`, `patient_consents`): RLS enabled, a read policy if needed, NO insert policy — writes come from the admin client only.

## Critical DB anchors

| Object | Purpose |
|---|---|
| `current_patient_id()` (0001, body in 0114) | Reads `app.current_patient_id` GUC **or** the `patient_id` claim of the request JWT. The portal mints a 5-minute anon JWT carrying that claim (`src/lib/supabase/patient.ts`), so patient policies enforce per query. `set_patient_context()` still exists but no app code calls it. |
| `has_role(text[])` / `is_staff()` / `staff_role()` | SECURITY DEFINER helpers over `staff_profiles`. Used in nearly every staff policy. Stay anon-executable. |
| `enforce_payment_before_release()` → `trg_test_requests_payment_gate` | BEFORE UPDATE on `test_requests`; raises (`check_violation`, 23514) if `NEW.status='released'` and the visit's money is not settled. Since **0133** settled means `payment_status ∈ ('paid','waived')` **or** `hmo_provider_id is not null` — an HMO patient never pays at the counter, and the release is what books the receivable. Source of truth for release; mirrored (not duplicated) in `src/lib/visits/money-settled.ts`, whose unit test pins this SQL text. "Mark consultation/procedure done" writes `status='released'`, so it hits the same trigger. |
| `enforce_consent_before_release()` (0086/0088) | Same transition, blocks when `consent_settings.gate_required` and the patient has no current consent. Ships OFF. |
| `bridge_test_request_released()` (current body 0109 + 0131) | Release → revenue JE + doctor PF accrual. P0034 (attending physician required) fires only for lines with PF > 0. |
| `tg_test_request_parent_is_header` (0040) | Validates package components against their header; sees same-statement rows in array order, so multi-row inserts must list headers before components. Headers auto-promote to `ready_for_release`. |
| 0125 guards: `enforce_deletable_visit` / `enforce_deletable_test_request` / `enforce_no_payment_on_deleted_visit` / `enforce_no_status_change_on_deleted_visit` / `fn_queue_delete_cascade` | Soft-delete lifecycle: P0042 not-unpaid, P0043 released, P0044 package component, P0045 payment on deleted visit, P0046 status change on deleted visit; header↔component cascade on delete and restore. |
| `guard_statutory_discount()` + `discount_types_one_statutory_idx` (0128) | Senior/PWD row locked at 20% (P0047); at most one statutory row even via REST. |
| `eod_close_denominations_check()` + `cash_denomination_total_php()` (0132) | P0048: unknown slug / non-integer / negative / total-mismatch. Skips NULL (legacy closes). |
| `visits_classification_summary()` (0126) | SQL aggregate for the Visits archive — PostgREST aggregates are disabled (`PGRST123`) and a bare select caps at 1000 rows, so real aggregates need a function. |
| `audit_log` | `(id bigserial, actor_id, actor_type, patient_id, action, resource_type, resource_id, metadata jsonb, ip_address, user_agent, created_at)`. Append-only. Admin-read RLS. |

## Audit logging is app-side, not trigger-driven

`audit_log` rows are inserted by server actions (`audit()` from `src/lib/audit/log.ts`) — not by triggers (the actor isn't reliably known inside Postgres when patients aren't `auth.users`). Exceptions that DO audit in SQL: template param deletes/activation flips (0121/0122, via `session_user`). See `drmed-rls-and-auth` for the call pattern.

## Common migration gotchas

- **Never edit a migration after it's on prod.** Fix forward with a new one.
- **Widening a CHECK constraint?** Postgres stores `check (col in ('a','b'))` as `= ANY (ARRAY[...])`, so matching the definition text for `in (` silently fails. Drop by the auto-generated name (`<table>_<col>_check`) with `if exists`, then re-add.
- **`create or replace` a function that older migrations also define** — copy the LATEST body (grep all files for the name; `bridge_test_request_released` has 10 definitions) and change only the lines you mean to.
- **Replay on empty DB** is part of the audit — `db reset` must complete. Data migrations guard with `if exists` / `if found`, never `raise` on a missing row.
- **Local vs prod ACL shapes differ** (fresh local functions have NULL ACLs; prod has explicit grants). Verify grants on both when a migration touches them.
- **Local stack after `db reset`**: `supabase/seed.sql` re-grants tables + sequences to anon/authenticated/service_role. Never extend it to routines — that undoes 0118.
- **`create or replace view` SILENTLY DROPS `security_invoker`.** The WITH clause replaces the view's options, it does not merge — omit it and the view reverts to running with its OWNER's rights, base-table RLS stops applying, nothing errors and no test fails. Verified on PG 17; it is how a real Supabase disclosure happened (supabase/supabase#35823, definition copied from the Dashboard, which drops the clause). **Every redefinition of a hardened view MUST restate `with (security_invoker = on)`.** The seven views hardened by 0134/0135 are pinned by `src/lib/supabase/hardened-views.test.ts`, which fails the build on a later redefinition that omits it — when you harden a new view, add it to that test's `HARDENED` map in the same migration, or nothing guards it.
- **A migration that REVOKES a table/view grant must add a matching re-revoke to the tail of `seed.sql`.** `grant all on all tables in schema public` covers VIEWS too, so the blanket grant silently hands the privilege straight back on the next `db reset`. Prod never runs `seed.sql` (`db push` ignores it), so without the carve-out local and prod disagree on exactly the grant the migration exists to remove — and the local replay "passes" while proving nothing. 0134 is the worked example; revoke by name, same classify-don't-blanket rule as 0118.
- **Types**: pure CHECK/trigger/function changes leave `database.ts` unchanged — an empty `db:types` diff is not a failure. A new RPC does need it (or a hand edit, see above).
- **Unit tests**: pure logic runs on vitest (`npm test`, ~885 tests). `cash-denominations.parity.test.ts` is the model for "a table exists in TS and SQL" — it parses the migration text and asserts they agree. Modules under test must not `import "server-only"`.
- **Never put plain PINs in any migration.** Only bcrypt hashes live in `visit_pins`.
- **Never hardcode prices** — read `services`.

## Hard rules

- **Every new table gets RLS enabled + at least one policy.** RLS off leaks via service-role; RLS on with no policy returns empty. Both are wrong.
- **Patient-data tables need a `current_patient_id()`-scoped policy.** The portal enforces these for real since 0114.
- **New functions need explicit grants only if a JWT calls them; re-created functions keep their ACL — check 0118 first.**
- **Every P-code gets a `pg-errors.ts` translation** in the same PR.
- **Adding a `test_requests.status` value?** Re-check `enforce_payment_before_release()`, `enforce_consent_before_release()`, and the 0125 guards.
- **All seed scripts must be idempotent** and go through `scripts/lib/load-env.ts` + `requireLocalOrExplicitProd()` before the first query (`guard-coverage.test.ts` enforces it).
- **Migration on prod before the app PR merges.** Vercel deploys main automatically; the code must never outrun the schema.
- **Never bypass the local replay step.**

## When this skill should NOT trigger

- App-code-only changes (TSX, Server Actions, lib helpers) that don't touch the schema — use the relevant domain skill.
- Auth flow / RLS review that isn't a new migration — `drmed-rls-and-auth` (same templates, plus the patient-client bridge).
- Lab result template additions — `drmed-result-templates`.
- Read-only prod data questions — Supabase MCP `execute_sql` with a plain `select` (may still be classifier-blocked; fall back to asking the user to run it).

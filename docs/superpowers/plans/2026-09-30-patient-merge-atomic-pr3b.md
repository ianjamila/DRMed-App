# Patient merge / undo-merge as atomic database functions (PR 3b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app-side, multi-statement patient merge and undo-merge (admin page + dedup CLI) with two atomic, service_role-only SQL functions owned by a private role, adding consent re-sync, before/after snapshots, chain flattening, an explicit CLI actor, and — in a follow-up PR — merge-marker enforcement.

**Architecture:** Migration **0196** adds the private role `patient_merge_writer`, `merge_patients_guarded` and `undo_patient_merge_guarded` (SECURITY DEFINER, owned by that role, locked in 0184's global order result-membership → patient → row), a consent-cache fold helper, ledger columns, and a narrow rollback guard. The server actions and the dedup CLI become thin RPC callers; the rollback/step-runner code is deleted. Migration **0197** (Part B, separate PR after the 3b deploy is verified) refuses every `merged_into_id`/`merged_at` change outside the merge functions.

**Tech Stack:** Postgres 17 (Supabase local stack, plpgsql), Next.js 16 server actions, TypeScript, vitest, `pg` two-connection proofs, Playwright CLI for the browser smoke.

**Spec:** `docs/superpowers/specs/2026-09-30-patient-merge-atomic-design.md` (read it first — every "R1…R8 / R1'…R5'" reference below points into its revision tables). Parent spec: `docs/superpowers/specs/2026-09-24-patient-delete-design.md`.

---

## Ground rules for every task (read once)

- Worktree: `/Users/jamila/Claude/DRMed/.worktrees/patient-merge-atomic`, branch `feat/patient-merge-atomic`. Run every command from there. Never `cd` to the main checkout.
- **Claimed numbers:** migration **0196** (this PR), **0197** (Part B), error codes **P0078** (actor not an active admin), **P0079** (merge/undo refused — message passes through), **P0080** (merge marker changed outside the merge functions). Do not claim more without the controller.
- **Shared local Supabase stack** (`127.0.0.1:54322`) serves every worktree. **Never** run `supabase db reset`, `supabase stop` or `npm run db:reset` against it. Apply migration files with `psql -f`. `psql` lives at `/opt/homebrew/opt/libpq/bin/psql`; set `export PSQL=/opt/homebrew/opt/libpq/bin/psql DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Commands that reach localhost need the sandbox disabled.
- zsh: never name a variable `path`; no `python3 - <<` heredocs; quote globs.
- Smoke SQL files run inside `begin … rollback` and leave nothing behind; they refuse to run on a DB with > 5000 patients.
- Commits: Conventional Commits, each ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. The post-commit hook prints a harmless `graphify` "Killed: 9" line — ignore it.
- Gates before any push: `npm test && npm run typecheck && npm run lint`.
- SQL written in Tasks 2–5 is reviewed by an **Opus** reviewer (controller dispatches); everything else uses Sonnet.

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/0196_patient_merge_atomic.sql` | create | role, grants/policies, ledger columns, consent helper, rollback guard, the two functions, ownership/ACLs, post-conditions |
| `supabase/tests/0196_patient_merge_atomic_smoke.sql` | create | single-connection smoke s1–s12 |
| `scripts/merge-concurrency-proof.ts` | create | two-connection forced races M1–M9 + `--control` mutant |
| `src/lib/patients/merge-fields.ts` | create | `MERGE_FILL_FIELDS`, `MERGE_MOVED_TABLES`, labels (pure) |
| `src/lib/patients/merge-result.ts` (+ `.test.ts`) | create | parse RPC jsonb, `undoableState`, `undoReportLines` (pure) |
| `src/lib/patients/merge-migration.test.ts` | create | pins 0196's structure (text-only) |
| `src/lib/patients/patient-fk-inventory.test.ts` | create | every `patients` FK is moved or listed as deliberately not moved |
| `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts` | rewrite merge/undo/recent | thin RPC callers + email + notification audit |
| `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.merge.test.ts` | create | action ↔ RPC wiring, error mapping, email audit |
| `…/patient-merge/merge-client.tsx`, `page.tsx` | modify | result copy (filled fields, re-chained, undo hint), fix "cannot be undone" text |
| `…/patient-merge/candidates/candidates-client.tsx`, `page.tsx` | modify | undo report, undoable reason, badges, pager |
| `scripts/patient-dedup/engine.ts` (+ `engine.args.test.ts`) | modify | `--actor=<uuid>`, RPC call, P0058 skip |
| `src/lib/accounting/pg-errors.ts` | modify | P0078–P0080 |
| `src/lib/patients/write-guards.test.ts`, `src/lib/patients/query-surfaces.test.ts` | modify | writer-RPC list + exemptions, surface notes |
| `src/lib/patients/{merge-steps,undo-merge-steps}.ts` (+ tests), `…/patient-merge/actions.rollback.test.ts`, `…/patient-merge/actions.tables.test.ts` | delete | superseded |
| `supabase/tests/0167_patient_soft_delete_smoke.sql`, `supabase/tests/0184_patient_lifecycle_locks_smoke.sql`, `scripts/patient-sources-db-proof.ts` | modify | marker fixtures go through the writer role and set both columns |
| `src/types/database.ts` | modify | new columns + functions (only our hunks) |
| `docs/drmed-user-guide.html`, `.claude/skills/drmed-migrations/SKILL.md`, `CLAUDE.md`, `package.json` | modify | docs, P-code registry, private-role list, npm script |
| Part B: `supabase/migrations/0197_merge_marker_enforcement.sql`, `supabase/tests/0197_merge_marker_enforcement_smoke.sql`, `src/lib/patients/merge-marker-migration.test.ts` | create | follow-up PR |

---

### Task 0: Baseline, local stack state, controller notes

**Files:** none in the repo (controller notes live outside it).

- [ ] **Step 1: Confirm the branch and that main has not moved under us**

```bash
cd /Users/jamila/Claude/DRMed/.worktrees/patient-merge-atomic
git fetch -q origin && git log --oneline -1 origin/main && git status --short | head
```
Expected: clean tree; if `origin/main` is ahead of `6d2ecfe0`, rebase now (`git rebase origin/main`) — only docs commits exist on the branch so far.

- [ ] **Step 2: Record the local stack state (read-only)**

```bash
export PSQL=/opt/homebrew/opt/libpq/bin/psql DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
$PSQL $DB -Atc "select count(*) from pg_trigger where tgname='a_lifecycle_guard'"          # expect 16 (0184 present)
$PSQL $DB -Atc "select count(*) from information_schema.columns where table_name='sheet_patient_links' and column_name='held_patient_id'"  # 0 = 0193 missing
$PSQL $DB -Atc "select count(*) from pg_proc where proname in ('merge_patients_guarded','undo_patient_merge_guarded')"  # expect 0
```
(run with the sandbox disabled).

- [ ] **Step 3: Apply 0193 locally if it is missing** (it is on main and on prod; applying it never resets anything; ask the controller first if Step 2 shows it present)

```bash
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0193_sync_review_gaps.sql > /tmp/0193.log 2>&1; echo exit=$?
```
Expected: `exit=0`.

- [ ] **Step 4: Baseline gates** — `npm test 2>&1 | tail -5`, `npm run typecheck`, `npm run lint 2>&1 | tail -3`. Record the test count in the controller notes. A known flake: `amend-form.test.tsx "a refused replace…"` under full-suite load (passes alone).

- [ ] **Step 5: Controller notes** — the controller creates `/Users/jamila/Claude/DRMed/.worktrees/patient-merge-atomic.controller-notes.md` (outside the repo) and logs every decision, review finding and deviation there.

---

### Task 1: Pure constants + the 0196 pinning test (red)

**Files:**
- Create: `src/lib/patients/merge-fields.ts`
- Create: `src/lib/patients/merge-migration.test.ts`

- [ ] **Step 1: Write `merge-fields.ts`**

```ts
// src/lib/patients/merge-fields.ts
// The single TypeScript copy of what a patient merge touches (0196). The SQL
// functions merge_patients_guarded / undo_patient_merge_guarded hold the
// authoritative lists; merge-migration.test.ts pins these constants to the
// migration text so the UI labels and the FK inventory cannot drift from it.
// Pure: imported by client components, server actions and tests.

// Fields a merge copies from the merged-in record onto the kept record when
// the kept record's value is NULL or blank. Never overwrites. Birthdate joined
// the admin merge in 0196 (the dedup CLI always filled it).
export const MERGE_FILL_FIELDS = ["middle_name", "sex", "phone", "email", "address", "birthdate"] as const;
export type MergeFillField = (typeof MERGE_FILL_FIELDS)[number];

export const MERGE_FILL_LABELS: Record<MergeFillField, string> = {
  middle_name: "middle name",
  sex: "sex",
  phone: "phone",
  email: "email",
  address: "address",
  birthdate: "birthdate",
};

// Tables whose patient_id a merge moves, in the order the SQL moves them
// (visits before critical_alerts: 0184's alert-matches-its-test check).
export const MERGE_MOVED_TABLES = [
  "visits",
  "appointments",
  "audit_log",
  "critical_alerts",
  "patient_consents",
  "appointment_attachments",
] as const;
export type MergeMovedTable = (typeof MERGE_MOVED_TABLES)[number];

export const MERGE_MOVED_LABELS: Record<MergeMovedTable, { one: string; many: string }> = {
  visits: { one: "visit", many: "visits" },
  appointments: { one: "appointment", many: "appointments" },
  audit_log: { one: "audit row", many: "audit rows" },
  critical_alerts: { one: "critical alert", many: "critical alerts" },
  patient_consents: { one: "consent record", many: "consent records" },
  appointment_attachments: { one: "lab-request form", many: "lab-request forms" },
};

export function isMergeFillField(f: string): f is MergeFillField {
  return (MERGE_FILL_FIELDS as readonly string[]).includes(f);
}

// The undo window, enforced in SQL (undo_patient_merge_guarded) — this copy
// only drives the page's own filter and wording.
export const MERGE_UNDO_WINDOW_DAYS = 30;

// Rows per page on the Recently merged list. Lives here, not in the
// "use server" actions file: a server-action module may export only async
// functions.
export const RECENT_MERGES_PAGE_SIZE = 25;
```

- [ ] **Step 2: Write the failing pinning test**

```ts
// src/lib/patients/merge-migration.test.ts
// Reads migration 0196 as text, without a database (same approach as
// src/lib/auth/view-as-migration.test.ts). Pins what could drift silently:
// ownership/ACL of the two merge functions, the private role's attributes,
// the lock order, the moved-table order, the fill-field list, and that every
// raise carries a registered errcode. The behaviour itself is proven by
// supabase/tests/0196_patient_merge_atomic_smoke.sql and
// scripts/merge-concurrency-proof.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MERGE_FILL_FIELDS, MERGE_MOVED_TABLES } from "./merge-fields";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0196_patient_merge_atomic.sql"), "utf8");

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} not defined`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf("as $$", start);
  const end = sql.indexOf("$$;", bodyStart + 5);
  return sql.slice(start, end);
}

const MERGE = fnBody("merge_patients_guarded");
const UNDO = fnBody("undo_patient_merge_guarded");

describe("0196_patient_merge_atomic.sql", () => {
  it("creates the private role NOLOGIN/NOINHERIT/NOBYPASSRLS and grants it only to postgres", () => {
    expect(sql).toContain("create role patient_merge_writer nologin noinherit nobypassrls");
    expect(sql).toContain("alter role patient_merge_writer nologin noinherit nobypassrls");
    expect(sql).toContain("grant patient_merge_writer to postgres with inherit true, set true");
    expect(sql).toContain("revoke patient_merge_writer from anon, authenticated, service_role, authenticator");
  });

  it.each([
    ["merge_patients_guarded", "uuid, uuid, uuid, jsonb"],
    ["undo_patient_merge_guarded", "uuid, uuid, jsonb"],
  ])("%s is SECURITY DEFINER, pinned search_path, owned by the writer, service_role-only", (name, sig) => {
    const body = fnBody(name);
    expect(body).toMatch(/security definer/);
    expect(body).toContain("set search_path = pg_catalog, public, pg_temp");
    expect(sql).toContain(`alter function public.${name}(${sig}) owner to patient_merge_writer`);
    expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated`);
    expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role`);
    expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to [^;]*(anon|authenticated)`));
  });

  it("wraps the ownership transfer in a transient CREATE grant", () => {
    const grant = sql.indexOf("grant create on schema public to patient_merge_writer");
    const revoke = sql.indexOf("revoke create on schema public from patient_merge_writer");
    const alter = sql.indexOf("alter function public.merge_patients_guarded");
    expect(grant).toBeGreaterThan(-1);
    expect(alter).toBeGreaterThan(grant);
    expect(revoke).toBeGreaterThan(alter);
  });

  it("grants the writer EXECUTE on exactly the helpers the functions call", () => {
    for (const fn of [
      "lifecycle_lock(uuid[], boolean)",
      "lifecycle_lock_results(uuid[], boolean)",
      "recompute_patient_consent_cache(uuid)",
    ]) {
      expect(sql).toContain(`grant execute on function public.${fn} to patient_merge_writer`);
    }
  });

  it.each([["merge", MERGE], ["undo", UNDO]])("%s locks membership → patient → row (all present)", (_n, body) => {
    const results = body.indexOf("public.lifecycle_lock_results(");
    const patients = body.indexOf("public.lifecycle_lock(");
    const rows = body.indexOf("for no key update");
    expect(results).toBeGreaterThan(0);
    expect(patients).toBeGreaterThan(results);
    expect(rows).toBeGreaterThan(patients);
  });

  it("merge moves the six tables in MERGE_MOVED_TABLES order", () => {
    const positions = MERGE_MOVED_TABLES.map((t) => MERGE.indexOf(`update public.${t} `));
    for (const p of positions) expect(p).toBeGreaterThan(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it.each([["merge", MERGE], ["undo", UNDO]])("%s fill list equals MERGE_FILL_FIELDS", (_n, body) => {
    const m = body.match(/k_fill constant text\[\] := array\[([^\]]+)\]/);
    expect(m, "k_fill missing").not.toBeNull();
    const fields = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(fields).toEqual([...MERGE_FILL_FIELDS]);
  });

  it("every raise in the migration carries an errcode (P0058/P0072/P0078/P0079/P0080) outside post-condition blocks", () => {
    const withoutAsserts = sql.replace(/do \$assert\$[\s\S]*?\$assert\$;/g, "");
    const raises = withoutAsserts.match(/raise exception[\s\S]*?;/g) ?? [];
    expect(raises.length).toBeGreaterThan(10);
    for (const r of raises) expect(r).toMatch(/errcode = 'P00(58|72|78|79|80)'/);
  });

  it("the consent trigger delegates to the fold helper (one copy of the rule)", () => {
    const sync = fnBody("sync_patient_consent_state");
    expect(sync).toContain("perform public.recompute_patient_consent_cache(new.patient_id)");
  });

  it("ships the rollback guard on patients.merged_into_id", () => {
    expect(sql).toContain("create trigger trg_patients_live_merge_guard");
    expect(sql).toMatch(/before update of merged_into_id on public\.patients/);
  });
});
```

- [ ] **Step 3: Run it — expect failure**

Run: `npx vitest run src/lib/patients/merge-migration.test.ts`
Expected: FAIL — `ENOENT … 0196_patient_merge_atomic.sql`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/patients/merge-fields.ts src/lib/patients/merge-migration.test.ts
git commit -m "test(patients): pin 0196 merge migration structure (red)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 2: 0196 foundation — role, ledger, privileges, consent fold, rollback guard (+ smoke s2, s11)

**Files:**
- Create: `supabase/migrations/0196_patient_merge_atomic.sql` (sections 1–5; Tasks 3–5 append 6–9)
- Create: `supabase/tests/0196_patient_merge_atomic_smoke.sql` (header, fixture, helpers, s2, s11)

**Why these privileges (spec "Private role" + R3):** the role is NOBYPASSRLS, so every table it reads or writes needs a table grant **and** a role-scoped policy. Every trigger that fires on the touched tables was enumerated from `pg_trigger` on 2026-09-30: all SECURITY DEFINER triggers (`a_lifecycle_guard`, `trg_patient_consents_sync`, `tg_release_headers_on_visit_paid`, `trg_visits_*_guard`, `trg_visits_repeat_flag`, `audit_log_stamp_view_as`) run as their owner; the SECURITY INVOKER ones (`trg_patients_lifecycle_guard`, `trg_patients_normalise_email/phone`, `trg_patients_referral_origin`, `trg_*_updated_at`, `trg_patient_consents_signer_name`) only rewrite `NEW` and read nothing, so they need no extra grant. Column UPDATE privileges cover only the columns the functions put in a `SET` list — columns rewritten by BEFORE triggers (`updated_at`, `row_version`, `phone_normalized`) are not privilege-checked.

- [ ] **Step 1: Write the smoke skeleton with s2 and s11 (they fail: nothing exists yet)**

Create `supabase/tests/0196_patient_merge_atomic_smoke.sql`:

```sql
-- =============================================================================
-- 0196_patient_merge_atomic_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after 0196 is applied:
--   /opt/homebrew/opt/libpq/bin/psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0196_patient_merge_atomic_smoke.sql
--
-- BEGIN … ROLLBACK; leaves no rows behind. Single connection — the two-session
-- races live in scripts/merge-concurrency-proof.ts. Both functions are always
-- called AS service_role (the real caller), never as postgres. Sections:
--   s1  catalog: role, owners, ACLs, helper grants, policies, ledger columns
--   s2  consent fold (recompute_patient_consent_cache) + the insert trigger
--   s3  merge: every move, ledger, fill before/after, chain flatten, consent,
--       alert DRM-ID re-stamp, repeat flag, audit row, return value
--   s4  merge refusals (actor, pair, context, inactive records)
--   s5  merge is all-or-nothing (forced late failure)
--   s6  undo v2: moves back, later rows stay, post-merge alerts follow their
--       visit, edited field kept, chain restored, consent, audit, report
--   s7  undo refusals: double undo, 30-day boundary, kept record merged/deleted,
--       split result, actor
--   s8  legacy ledger rows (written by the pre-3b app)
--   s9  interrupted legacy undo completed by the function
--   s10 attachment booking groups (empty, walk-in-only, split owners)
--   s11 0196 rollback guard; ordinary edits and delete/restore unaffected
-- =============================================================================

begin;

do $guard$
begin
  if (select count(*) from public.patients) > 5000 then
    raise exception 'refusing: % patients looks like prod — this test is LOCAL ONLY',
      (select count(*) from public.patients);
  end if;
end
$guard$;

-- --- Shared fixture -----------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000196', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mg-admin@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000196', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mg-reception@example.test', '', now(), now(), now()),
  ('a3000000-0000-4000-8000-000000000196', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mg-old-admin@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active)
values
  ('a0000000-0000-4000-8000-000000000196', 'MG Admin', 'admin', true),
  ('a1000000-0000-4000-8000-000000000196', 'MG Reception', 'reception', true),
  ('a3000000-0000-4000-8000-000000000196', 'MG Former Admin', 'admin', false);

insert into public.services (id, code, name, price_php, kind)
values ('c0000000-0000-4000-8000-000000000196', 'MG-LAB', 'MG smoke lab test', 1000, 'lab_test');

create temp table mg_fix (k text primary key, v uuid);
insert into mg_fix (k, v)
  select 'tpl', id from (
    insert into public.result_templates (service_id, layout)
    values ('c0000000-0000-4000-8000-000000000196', 'simple') returning id) t;
insert into mg_fix (k, v)
  select 'prm', id from (
    insert into public.result_template_params (template_id, sort_order, parameter_name, input_type)
    values ((select v from mg_fix where k = 'tpl'), 1, 'MG param', 'numeric') returning id) t;

-- --- Helpers (pg_temp: vanish with the session) ---------------------------------
create function pg_temp.admin() returns uuid language sql as
  $f$ select 'a0000000-0000-4000-8000-000000000196'::uuid $f$;

create function pg_temp.mk_patient(tag text, phone text default null, email text default null,
                                   bdate date default '1990-01-01') returns uuid language sql as $f$
  insert into public.patients (drm_id, first_name, last_name, birthdate, phone, email)
  values ('DRM-MG' || tag, 'Smoke', 'Mg' || tag, bdate, phone, email)
  returning id;
$f$;

create function pg_temp.mk_visit(p uuid) returns uuid language sql as $f$
  insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php)
  values ('V-MG-' || substr(md5(random()::text), 1, 10), p, 'unpaid', 0, 0)
  returning id;
$f$;

create function pg_temp.mk_line(v uuid, status text default 'in_progress') returns uuid language sql as $f$
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, parent_id, is_package_header)
  values (v, 'c0000000-0000-4000-8000-000000000196', status, 'a0000000-0000-4000-8000-000000000196',
          0, 0, null, false)
  returning id;
$f$;

-- A structured result linked to the given tests (one or more).
create function pg_temp.mk_result(lines uuid[]) returns uuid language plpgsql as $f$
declare r uuid; l uuid;
begin
  insert into public.results (generation_kind, uploaded_by)
  values ('structured', 'a0000000-0000-4000-8000-000000000196') returning id into r;
  foreach l in array lines loop
    insert into public.result_test_requests (result_id, test_request_id) values (r, l);
  end loop;
  return r;
end $f$;

create function pg_temp.mk_alert(r uuid, line uuid, p uuid) returns uuid language sql as $f$
  insert into public.critical_alerts (result_id, test_request_id, parameter_id, direction, parameter_name,
                                      patient_id, patient_drm_id)
  values (r, line, (select v from mg_fix where k = 'prm'), 'high', 'MG param', p,
          (select drm_id from public.patients where id = p))
  returning id;
$f$;

create function pg_temp.grant_consent(p uuid, scope text default 'full') returns void language sql as $f$
  insert into public.patient_consents (patient_id, event_type, method, notice_version, signatory,
                                       actor_kind, consent_scope)
  values (p, 'granted', 'paper_wet_signature', 'v1', 'self', 'staff', scope);
$f$;

create function pg_temp.withdraw_consent(p uuid) returns void language sql as $f$
  insert into public.patient_consents (patient_id, event_type, reason, actor_kind, created_by)
  values (p, 'withdrawn', 'smoke', 'staff', 'a0000000-0000-4000-8000-000000000196');
$f$;

create function pg_temp.mk_appt(p uuid, grp uuid) returns uuid language sql as $f$
  insert into public.appointments (patient_id, status, scheduled_at, booking_group_id)
  values (p, 'confirmed', now() + interval '3 days', grp)
  returning id;
$f$;

create function pg_temp.mk_walkin_appt(grp uuid) returns uuid language sql as $f$
  insert into public.appointments (patient_id, walk_in_name, walk_in_phone, status, scheduled_at, booking_group_id)
  values (null, 'MG Walk-in', '09170000000', 'confirmed', now() + interval '3 days', grp)
  returning id;
$f$;

create function pg_temp.mk_attach(p uuid, grp uuid) returns uuid language sql as $f$
  insert into public.appointment_attachments (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes)
  values (grp, p, 'lab-request-forms/mg-' || gen_random_uuid() || '.pdf', 'mg.pdf', 'application/pdf', 10)
  returning id;
$f$;

create function pg_temp.mk_audit(p uuid) returns bigint language sql as $f$
  insert into public.audit_log (actor_type, action, patient_id) values ('system', 'mg.smoke', p) returning id;
$f$;

-- Marks src merged into keep the way a fixture must from now on: through the
-- private writer role, setting BOTH columns (0197 refuses anything else).
create function pg_temp.mark_merged(src uuid, keep uuid) returns void language plpgsql as $f$
begin
  set local role patient_merge_writer;
  update public.patients set merged_into_id = keep, merged_at = now() where id = src;
  reset role;
end $f$;

-- Deletes a patient without the blocker check (same mechanism as 0184's smoke).
create function pg_temp.kill(p uuid) returns void language plpgsql as $f$
begin
  set local role patient_lifecycle_writer;
  update public.patients
     set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000196', delete_reason = 'test_record'
   where id = p;
  reset role;
end $f$;

create function pg_temp.merge(keep uuid, src uuid,
                              actor uuid default 'a0000000-0000-4000-8000-000000000196',
                              ctx jsonb default '{"source":"admin","ip":"127.0.0.1","user_agent":"smoke"}')
returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  set local role service_role;
  r := public.merge_patients_guarded(keep, src, actor, ctx);
  reset role;
  return r;
end $f$;

create function pg_temp.undo(mid uuid, actor uuid default 'a0000000-0000-4000-8000-000000000196')
returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  set local role service_role;
  r := public.undo_patient_merge_guarded(mid, actor, '{"ip":"127.0.0.1","user_agent":"smoke"}'::jsonb);
  reset role;
  return r;
end $f$;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception '0196 % FAILED: got [%], want [%]', label, got, want;
  end if;
  raise notice '0196 % OK', label;
end $f$;

-- Runs sql as postgres; returns the SQLSTATE it raised, or 'ok'.
create function pg_temp.state_of(sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute sql;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- Runs sql as role r; returns the SQLSTATE it raised, or 'ok'. The exception
-- block's subtransaction rollback also reverts the SET LOCAL ROLE.
create function pg_temp.state_as(r text, sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute format('set local role %I', r);
  execute sql;
  reset role;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- The five cached consent columns as one comparable string.
create function pg_temp.consent5(p uuid) returns text language sql as $f$
  select consent_current::text || '|' || coalesce(consent_signed_at::text, '') || '|' ||
         coalesce(consent_withdrawn_at::text, '') || '|' || coalesce(consent_method, '') || '|' ||
         coalesce(consent_notice_version, '')
    from public.patients where id = p;
$f$;

-- s2 ---------------------------------------------------------------------------
do $s2$
declare
  p uuid; q uuid; w uuid; z uuid; c text; rv bigint;
begin
  p := pg_temp.mk_patient('S2A');
  perform pg_temp.expect('s2.1 no events → false + four NULLs', pg_temp.consent5(p), 'false||||');
  perform public.recompute_patient_consent_cache(p);
  perform pg_temp.expect('s2.2 recompute with no events', pg_temp.consent5(p), 'false||||');

  perform pg_temp.grant_consent(p);
  c := pg_temp.consent5(p);
  perform pg_temp.expect('s2.3 full grant (trigger) → current, method, version',
    split_part(c, '|', 1) || '|' || split_part(c, '|', 4) || '|' || split_part(c, '|', 5),
    'true|paper_wet_signature|v1');

  perform pg_temp.withdraw_consent(p);
  c := pg_temp.consent5(p);
  perform pg_temp.expect('s2.4 withdrawal: false, withdrawn stamped, grant fields carried',
    split_part(c, '|', 1) || '|' || (split_part(c, '|', 2) <> '')::text || '|' ||
    (split_part(c, '|', 3) <> '')::text || '|' || split_part(c, '|', 4),
    'false|true|true|paper_wet_signature');

  q := pg_temp.mk_patient('S2B');
  perform pg_temp.grant_consent(q, 'booking_contact_only');
  perform pg_temp.expect('s2.5 booking-only grant → false + four NULLs', pg_temp.consent5(q), 'false||||');

  w := pg_temp.mk_patient('S2C');
  perform pg_temp.grant_consent(w);
  perform pg_temp.grant_consent(w, 'booking_contact_only');
  perform pg_temp.withdraw_consent(w);
  c := pg_temp.consent5(w);
  perform pg_temp.expect('s2.6 full → booking-only → withdraw: grant fields cleared, withdrawn stamped',
    split_part(c, '|', 1) || '|' || split_part(c, '|', 2) || '|' || (split_part(c, '|', 3) <> '')::text || '|' ||
    split_part(c, '|', 4), 'false||true|');

  -- the helper reproduces exactly what the trigger built, and a no-op recompute
  -- does not touch the row (row_version unchanged)
  c := pg_temp.consent5(w);
  select row_version into rv from public.patients where id = w;
  perform public.recompute_patient_consent_cache(w);
  perform pg_temp.expect('s2.7 recompute = trigger state', pg_temp.consent5(w), c);
  perform pg_temp.expect('s2.8 no-op recompute leaves row_version',
    (select row_version from public.patients where id = w)::text, rv::text);

  -- moving events by UPDATE does NOT fire the trigger (why merge must re-sync):
  -- p's grant + withdrawal move to z, which had no events.
  z := pg_temp.mk_patient('S2D');
  update public.patient_consents set patient_id = z where patient_id = p;
  perform pg_temp.expect('s2.9 control: after an UPDATE move both caches are stale',
    (pg_temp.consent5(z) = 'false||||' and split_part(pg_temp.consent5(p), '|', 3) <> '')::text, 'true');
  perform public.recompute_patient_consent_cache(z);
  perform public.recompute_patient_consent_cache(p);
  c := pg_temp.consent5(z);
  perform pg_temp.expect('s2.10 recompute after the move: z withdrawn with grant fields, p cleared',
    split_part(c, '|', 1) || '|' || (split_part(c, '|', 3) <> '')::text || '|' || split_part(c, '|', 4) || '|' ||
    pg_temp.consent5(p), 'false|true|paper_wet_signature|false||||');
end
$s2$;

-- s11 --------------------------------------------------------------------------
do $s11$
declare
  k uuid; s uuid; lk uuid; ls uuid; f uuid;
begin
  k := pg_temp.mk_patient('S11K');
  s := pg_temp.mk_patient('S11S');
  perform pg_temp.mark_merged(s, k);
  insert into public.patient_merges (keep_id, source_id, snapshot_version, moved)
  values (k, s, 2, '{}'::jsonb);

  perform pg_temp.expect('s11.1 service_role cannot clear a live v2 merge marker',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s)),
    'P0080');
  perform pg_temp.expect('s11.2 postgres cannot either',
    pg_temp.state_of(format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s)),
    'P0080');
  perform pg_temp.expect('s11.3 service_role cannot re-point it',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = %L where id = %L', pg_temp.mk_patient('S11X'), s)),
    'P0080');
  perform pg_temp.expect('s11.4 the writer role can (it is how undo clears it)',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s)),
    'ok');
  perform pg_temp.expect('s11.5 the writer''s change landed (state_as commits on success)',
    coalesce((select merged_into_id from public.patients where id = s)::text, 'null'), 'null');
  perform pg_temp.mark_merged(s, k);

  -- a LEGACY live ledger row (pre-3b app) is not protected: the old app keeps working
  lk := pg_temp.mk_patient('S11LK');
  ls := pg_temp.mk_patient('S11LS');
  perform pg_temp.mark_merged(ls, lk);
  insert into public.patient_merges (keep_id, source_id, moved, filled_from_source)
  values (lk, ls, '{}'::jsonb, '{}');
  perform pg_temp.expect('s11.6 legacy live merge marker can still be cleared by service_role (old app undo)',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', ls)),
    'ok');

  -- ordinary edits and delete/restore are unaffected
  perform pg_temp.expect('s11.7 staff edit of an active patient',
    pg_temp.state_as('service_role', format('update public.patients set phone = %L where id = %L', '09171234567', k)),
    'ok');
  f := pg_temp.mk_patient('S11F');
  perform pg_temp.expect('s11.8 delete_patient still works',
    pg_temp.state_as('service_role', format(
      'select public.delete_patient(%L, %L, null, %L, null)', f, 'test_record', pg_temp.admin())), 'ok');
  perform pg_temp.expect('s11.9 restore_patient still works',
    pg_temp.state_as('service_role', format('select public.restore_patient(%L, %L, null)', f, pg_temp.admin())), 'ok');
end
$s11$;

rollback;
```

- [ ] **Step 2: Run the smoke — expect failure**

```bash
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/0196_patient_merge_atomic_smoke.sql 2>&1 | tail -5
```
Expected: an error creating `pg_temp.mark_merged`'s role switch or `s2.2` failing with `function public.recompute_patient_consent_cache(uuid) does not exist`.

- [ ] **Step 3: Write migration sections 1–5**

Create `supabase/migrations/0196_patient_merge_atomic.sql`:

```sql
-- =============================================================================
-- 0196_patient_merge_atomic.sql — patient-delete rollout PR 3b
-- =============================================================================
-- Merge and undo-merge become two atomic, service_role-only functions owned by
-- the private role patient_merge_writer, replacing the app-side multi-statement
-- merge (admin page + dedup CLI) and its hand-built rollback runner.
-- Spec: docs/superpowers/specs/2026-09-30-patient-merge-atomic-design.md
--
--   (1) private role patient_merge_writer (0167 pattern)
--   (2) patient_merges: snapshot_version, fill_snapshot, rechained, context,
--       undo_report; one live merge per source
--   (3) table privileges + role-scoped RLS policies
--   (4) consent cache: recompute_patient_consent_cache() folds the events in
--       seq order; sync_patient_consent_state() delegates to it
--   (5) rollback guard: a live version-2 merge's marker only changes through
--       the writer (so an app rolled back to pre-3b cannot run its old undo)
--   (6) merge_patients_guarded
--   (7) undo_patient_merge_guarded
--   (8) ownership + ACLs
--   (9) post-conditions (incl. consent fold = cache for every patient)
--
-- Error codes: P0058 (inactive/missing record, message passes through),
-- P0072 (records changed while waiting — retried once by every caller),
-- P0078 (actor not an active admin), P0079 (merge/undo refused — message
-- passes through), P0080 (merge marker changed outside the merge functions).
-- Merge-marker enforcement for EVERY writer ships separately in 0197, after
-- the app that calls these functions is deployed.
-- =============================================================================

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) Private role. Restated every run (idempotent).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'patient_merge_writer') then
    create role patient_merge_writer nologin noinherit nobypassrls;
  end if;
end
$$;
alter role patient_merge_writer nologin noinherit nobypassrls;
-- INHERIT lets postgres re-run create-or-replace on the functions this role
-- owns; SET lets local fixtures act as it. No runtime role may assume it.
grant patient_merge_writer to postgres with inherit true, set true;
revoke patient_merge_writer from anon, authenticated, service_role, authenticator;
grant usage on schema public to patient_merge_writer;

-- ---------------------------------------------------------------------------
-- (2) Ledger. Legacy rows (written by the pre-3b app) keep snapshot_version
-- NULL; every row the new function writes is version 2.
-- ---------------------------------------------------------------------------
alter table public.patient_merges
  add column if not exists snapshot_version smallint,
  add column if not exists fill_snapshot jsonb,
  add column if not exists rechained uuid[] not null default '{}',
  add column if not exists context jsonb,
  add column if not exists undo_report jsonb;
alter table public.patient_merges drop constraint if exists patient_merges_snapshot_version_check;
alter table public.patient_merges add constraint patient_merges_snapshot_version_check
  check (snapshot_version is null or snapshot_version = 2);
create unique index if not exists uq_patient_merges_live_source
  on public.patient_merges (source_id) where undone_at is null;

-- ---------------------------------------------------------------------------
-- (3) Privileges. NOBYPASSRLS: every table needs a grant AND a policy.
-- patient_merges and patient_consents were RLS-on/no-policy tables (0151's
-- list, 0202's service_role-only ACL). The policies below name ONLY this
-- NOLOGIN role, which nothing but the two merge functions runs as; anon and
-- authenticated still hold no privilege on either table (0202's invariant,
-- re-checked by the 0196 smoke s1.11).
-- ---------------------------------------------------------------------------
grant select on public.patients, public.visits, public.appointments, public.audit_log,
                public.critical_alerts, public.patient_consents, public.appointment_attachments,
                public.test_requests, public.result_test_requests, public.staff_profiles,
                public.patient_merges
  to patient_merge_writer;
grant update (middle_name, sex, phone, email, address, birthdate, is_repeat_patient,
              merged_into_id, merged_at)
  on public.patients to patient_merge_writer;
grant update (patient_id) on public.visits, public.appointments, public.audit_log,
                             public.patient_consents, public.appointment_attachments
  to patient_merge_writer;
grant update (patient_id, patient_drm_id) on public.critical_alerts to patient_merge_writer;
grant insert on public.audit_log to patient_merge_writer;
grant usage on sequence public.audit_log_id_seq to patient_merge_writer;
grant insert, update on public.patient_merges to patient_merge_writer;

do $$
declare
  t text;
begin
  foreach t in array array['patients', 'visits', 'appointments', 'audit_log', 'critical_alerts',
                           'patient_consents', 'appointment_attachments', 'test_requests',
                           'result_test_requests', 'staff_profiles', 'patient_merges'] loop
    execute format('drop policy if exists %I on public.%I', t || ': merge writer select', t);
    execute format('create policy %I on public.%I for select to patient_merge_writer using (true)',
                   t || ': merge writer select', t);
  end loop;
  foreach t in array array['patients', 'visits', 'appointments', 'audit_log', 'critical_alerts',
                           'patient_consents', 'appointment_attachments', 'patient_merges'] loop
    execute format('drop policy if exists %I on public.%I', t || ': merge writer update', t);
    execute format('create policy %I on public.%I for update to patient_merge_writer using (true) with check (true)',
                   t || ': merge writer update', t);
  end loop;
end
$$;

drop policy if exists "audit_log: merge writer insert" on public.audit_log;
create policy "audit_log: merge writer insert" on public.audit_log
  for insert to patient_merge_writer
  with check (action in ('patient.merged', 'patient.merge.undone'));
drop policy if exists "patient_merges: merge writer insert" on public.patient_merges;
create policy "patient_merges: merge writer insert" on public.patient_merges
  for insert to patient_merge_writer with check (true);

-- ---------------------------------------------------------------------------
-- (4) Consent cache. 0086's trigger fires AFTER INSERT only, so moving events
-- by UPDATE (merge / undo) never re-synced either patient. The fold below is
-- 0162's three transitions applied to every event in seq order — equal to what
-- the incremental trigger produced, since seq is insertion order (proved for
-- every patient in section 9). Owned by postgres; the writer gets EXECUTE.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_patient_consent_cache(p_patient_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e        record;
  v_cur    boolean := false;
  v_signed timestamptz;
  v_wd     timestamptz;
  v_method text;
  v_nv     text;
begin
  for e in
    select c.event_type, c.consent_scope, c.created_at, c.method, c.notice_version
      from public.patient_consents c
     where c.patient_id = p_patient_id
     order by c.seq
  loop
    if e.event_type = 'granted' and e.consent_scope = 'full' then
      v_cur := true; v_signed := e.created_at; v_wd := null; v_method := e.method; v_nv := e.notice_version;
    elsif e.event_type = 'granted' then
      -- booking-only grant: as if never consented (0162)
      v_cur := false; v_signed := null; v_wd := null; v_method := null; v_nv := null;
    else
      -- withdrawal: signed/method/version stay as the historical grant (0162)
      v_cur := false; v_wd := e.created_at;
    end if;
  end loop;

  update public.patients p
     set consent_current = v_cur,
         consent_signed_at = v_signed,
         consent_withdrawn_at = v_wd,
         consent_method = v_method,
         consent_notice_version = v_nv
   where p.id = p_patient_id
     and (p.consent_current, p.consent_signed_at, p.consent_withdrawn_at, p.consent_method, p.consent_notice_version)
         is distinct from (v_cur, v_signed, v_wd, v_method, v_nv);
end;
$$;

revoke all on function public.recompute_patient_consent_cache(uuid) from public, anon, authenticated, service_role;
grant execute on function public.recompute_patient_consent_cache(uuid) to patient_merge_writer;

create or replace function public.sync_patient_consent_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.recompute_patient_consent_cache(new.patient_id);
  return null;
end;
$$;

revoke execute on function public.sync_patient_consent_state() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (5) Rollback guard (spec R7). A live version-2 merge records chain
-- re-parenting and fill snapshots the pre-3b app's Undo would ignore. If the
-- app is ever rolled back, that Undo's FIRST statement is clearing the
-- source's marker — refused here, so it stops with nothing changed. Old-app
-- merges and undos of legacy rows are untouched. 0197 later enforces the
-- marker for every writer.
-- ---------------------------------------------------------------------------
create or replace function public.patient_has_live_v2_merge(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.patient_merges m
     where m.source_id = p_patient_id and m.undone_at is null and m.snapshot_version = 2
  );
$$;

revoke all on function public.patient_has_live_v2_merge(uuid) from public, anon, authenticated, service_role;
grant execute on function public.patient_has_live_v2_merge(uuid) to authenticated, service_role;

-- SECURITY INVOKER: current_user is the role actually writing.
create or replace function public.guard_live_merge_marker()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.merged_into_id is distinct from old.merged_into_id
     and current_user <> 'patient_merge_writer'
     and public.patient_has_live_v2_merge(old.id) then
    raise exception '% was merged in Admin Tools — undo it there', old.drm_id
      using errcode = 'P0080';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_live_merge_marker() from public, anon, authenticated, service_role;

drop trigger if exists trg_patients_live_merge_guard on public.patients;
create trigger trg_patients_live_merge_guard
  before update of merged_into_id on public.patients
  for each row execute function public.guard_live_merge_marker();
```

- [ ] **Step 4: Apply locally and run the smoke — s2 and s11 pass except where they need the functions**

```bash
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0196_patient_merge_atomic.sql > /tmp/0196.log 2>&1; echo exit=$?
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/0196_patient_merge_atomic_smoke.sql 2>&1 | grep -E "OK|FAILED|ERROR" | tail -25
```
Expected: `exit=0`; every `s2.*` and `s11.*` line `OK`; no `FAILED`/`ERROR`. (s11.8 needs `delete_patient` — present since 0167/0184.)

- [ ] **Step 5: Re-run the migration a second time** — `exit=0` again (idempotence is required: later tasks re-apply the whole file).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0196_patient_merge_atomic.sql supabase/tests/0196_patient_merge_atomic_smoke.sql
git commit -m "feat(db): 0196 foundation — merge writer role, ledger columns, consent fold, rollback guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: `merge_patients_guarded` (+ smoke s3, s4, s5)

**Files:**
- Modify: `supabase/migrations/0196_patient_merge_atomic.sql` (append section 6)
- Modify: `supabase/tests/0196_patient_merge_atomic_smoke.sql` (insert s3–s5 **before the final `rollback;`**)

**Lock order (spec step 2, R5):** 0184's global order is result membership → patient → row. The function reads the chain set `C` and the affected result set `R` with plain statements, takes `lifecycle_lock_results(R, false)` (shared), then `lifecycle_lock(keep ∪ source ∪ C, true)` (exclusive, sorted by hash — the helper sorts), then row locks `for no key update` in UUID order, then re-reads `C` and `R`: a changed chain, or a result outside the locked set, raises **P0072** (the caller retries once in a fresh transaction). The alert move's own trigger then re-takes those membership locks re-entrantly.

- [ ] **Step 1: Add smoke s3–s5 (insert before the final `rollback;`)**

```sql
-- s3 ---------------------------------------------------------------------------
do $s3$
declare
  k uuid; s uuid; t uuid; vk uuid; vs1 uuid; vs2 uuid; ls1 uuid; ls2 uuid; r1 uuid; al uuid;
  ap uuid; att uuid; au bigint; grp uuid := gen_random_uuid();
  res jsonb; m public.patient_merges%rowtype; kp public.patients%rowtype; sp public.patients%rowtype;
  run uuid; k2 uuid; s2 uuid; res2 jsonb;
begin
  k := pg_temp.mk_patient('S3K');
  update public.patients set address = '   ', sex = 'female' where id = k;   -- blank address counts as missing
  s := pg_temp.mk_patient('S3S', '09171112222', 'mg-s3s@example.test');
  update public.patients set address = 'MG street', middle_name = 'Q', sex = 'male' where id = s;
  t := pg_temp.mk_patient('S3T');
  perform pg_temp.mark_merged(t, s);                                          -- an older tombstone of s

  vk := pg_temp.mk_visit(k);
  vs1 := pg_temp.mk_visit(s);
  vs2 := pg_temp.mk_visit(s);
  ls1 := pg_temp.mk_line(vs1);
  ls2 := pg_temp.mk_line(vs2);
  r1 := pg_temp.mk_result(array[ls1]);
  al := pg_temp.mk_alert(r1, ls1, s);
  ap := pg_temp.mk_appt(s, grp);
  att := pg_temp.mk_attach(s, grp);
  au := pg_temp.mk_audit(s);
  perform pg_temp.grant_consent(s);

  res := pg_temp.merge(k, s);
  select * into m from public.patient_merges where id = (res->>'merge_id')::uuid;
  select * into kp from public.patients where id = k;
  select * into sp from public.patients where id = s;

  perform pg_temp.expect('s3.1 nothing left on the source',
    ((select count(*) from public.visits where patient_id = s) + (select count(*) from public.appointments where patient_id = s)
     + (select count(*) from public.audit_log where patient_id = s) + (select count(*) from public.critical_alerts where patient_id = s)
     + (select count(*) from public.patient_consents where patient_id = s)
     + (select count(*) from public.appointment_attachments where patient_id = s))::text, '0');
  perform pg_temp.expect('s3.2 ledger records the exact moved ids',
    (m.moved->'visits' @> to_jsonb(array[vs1, vs2]) and jsonb_array_length(m.moved->'visits') = 2
     and m.moved->'appointments' = to_jsonb(array[ap]) and m.moved->'critical_alerts' = to_jsonb(array[al])
     and m.moved->'appointment_attachments' = to_jsonb(array[att]) and m.moved->'audit_log' @> to_jsonb(array[au])
     and jsonb_array_length(m.moved->'patient_consents') = 1)::text, 'true');
  perform pg_temp.expect('s3.3 returned counts = ledger lengths',
    (res->'moved' = jsonb_build_object(
       'visits', jsonb_array_length(m.moved->'visits'), 'appointments', jsonb_array_length(m.moved->'appointments'),
       'audit_log', jsonb_array_length(m.moved->'audit_log'), 'critical_alerts', jsonb_array_length(m.moved->'critical_alerts'),
       'patient_consents', jsonb_array_length(m.moved->'patient_consents'),
       'appointment_attachments', jsonb_array_length(m.moved->'appointment_attachments')))::text, 'true');
  perform pg_temp.expect('s3.4 keep''s own visit untouched', (select patient_id from public.visits where id = vk)::text, k::text);
  perform pg_temp.expect('s3.5 moved alert re-stamped with the kept DRM-ID',
    (select patient_drm_id from public.critical_alerts where id = al), 'DRM-MGS3K');
  perform pg_temp.expect('s3.6 fill: phone, email, address (blank), middle name copied; sex kept',
    concat_ws('|', kp.phone, kp.email, kp.address, kp.middle_name, kp.sex),
    '09171112222|mg-s3s@example.test|MG street|Q|female');
  perform pg_temp.expect('s3.7 filled_from_source',
    (select string_agg(x, ',' order by x) from unnest(m.filled_from_source) x), 'address,email,middle_name,phone');
  perform pg_temp.expect('s3.8 fill snapshot before/after',
    (m.fill_snapshot->'address'->>'before') || '|' || (m.fill_snapshot->'address'->>'after') || '|' ||
    coalesce(m.fill_snapshot->'phone'->>'before', 'null') || '|' || (m.fill_snapshot->'phone'->>'after'),
    '   |MG street|null|09171112222');
  perform pg_temp.expect('s3.9 phone_normalized recomputed on keep', (kp.phone_normalized is not null)::text, 'true');
  perform pg_temp.expect('s3.10 chain flattened + recorded',
    (select merged_into_id from public.patients where id = t)::text || '|' || m.rechained::text, k::text || '|{' || t::text || '}');
  perform pg_temp.expect('s3.11 source tombstoned', (sp.merged_into_id = k and sp.merged_at is not null)::text, 'true');
  perform pg_temp.expect('s3.12 consent re-synced on both',
    kp.consent_current::text || '|' || pg_temp.consent5(s), 'true|false||||');
  perform pg_temp.expect('s3.13 repeat flag set on keep', kp.is_repeat_patient::text, 'true');
  perform pg_temp.expect('s3.14 ledger header',
    concat_ws('|', m.snapshot_version, m.merged_by, m.context->>'source', m.undone_at),
    '2|' || pg_temp.admin() || '|admin');
  perform pg_temp.expect('s3.15 audit row written in the same transaction',
    (select count(*) from public.audit_log a
      where a.action = 'patient.merged' and a.patient_id = k and a.actor_id = pg_temp.admin()
        and a.metadata->>'merge_id' = m.id::text and a.ip_address = '127.0.0.1'::inet
        and a.user_agent = 'smoke')::text, '1');
  perform pg_temp.expect('s3.16 return value names both records',
    (res->>'kept_drm_id') || '|' || (res->>'merged_drm_id') || '|' || (res->>'rechained'), 'DRM-MGS3K|DRM-MGS3S|1');
  perform pg_temp.expect('s3.17 writes to the tombstone are refused afterwards (0184 guard)',
    pg_temp.state_of(format('select pg_temp.mk_visit(%L)', s)), 'P0058');

  -- dedup CLI context + birthdate fill (only legacy-import records may lack one)
  insert into public.legacy_import_runs (source, dry_run) values ('mg-smoke', true) returning id into run;
  insert into public.patients (drm_id, first_name, last_name, birthdate, legacy_import_run_id)
  values ('DRM-MGS3K2', 'Smoke', 'MgS3K2', null, run) returning id into k2;
  s2 := pg_temp.mk_patient('S3S2', null, null, '1985-05-05');
  res2 := pg_temp.merge(k2, s2, pg_temp.admin(), '{"source":"dedup-cli","tier":"exact_dup"}'::jsonb);
  perform pg_temp.expect('s3.18 birthdate filled + CLI context recorded',
    (select birthdate::text from public.patients where id = k2) || '|' ||
    (select context->>'source' || ',' || (context->>'tier') from public.patient_merges where id = (res2->>'merge_id')::uuid) || '|' ||
    (select a.metadata->>'tier' from public.audit_log a where a.action = 'patient.merged' and a.patient_id = k2),
    '1985-05-05|dedup-cli,exact_dup|exact_dup');
end
$s3$;

-- s4 ---------------------------------------------------------------------------
do $s4$
declare
  k uuid; s uuid; d uuid; x uuid; y uuid;
  sig constant text := 'public.merge_patients_guarded(uuid, uuid, uuid, jsonb)';
begin
  k := pg_temp.mk_patient('S4K');
  s := pg_temp.mk_patient('S4S');
  perform pg_temp.mk_visit(s);

  perform pg_temp.expect('s4.1 reception actor refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L, %L)', k, s, 'a1000000-0000-4000-8000-000000000196')), 'P0078');
  perform pg_temp.expect('s4.2 inactive admin refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L, %L)', k, s, 'a3000000-0000-4000-8000-000000000196')), 'P0078');
  perform pg_temp.expect('s4.3 NULL actor refused (no NULL-actor path)',
    pg_temp.state_as('service_role', format('select public.merge_patients_guarded(%L, %L, null, null)', k, s)), 'P0078');
  perform pg_temp.expect('s4.4 same record twice refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, k)), 'P0079');
  perform pg_temp.expect('s4.5 NULL keep refused',
    pg_temp.state_as('service_role', format('select public.merge_patients_guarded(null, %L, %L, null)', s, pg_temp.admin())), 'P0079');
  perform pg_temp.expect('s4.6 unknown context key refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L, %L, %L)', k, s, pg_temp.admin(), '{"sneaky":1}')), 'P0079');
  perform pg_temp.expect('s4.7 unknown context source refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L, %L, %L)', k, s, pg_temp.admin(), '{"source":"cron"}')), 'P0079');

  d := pg_temp.mk_patient('S4D');
  perform pg_temp.kill(d);
  perform pg_temp.expect('s4.8 deleted keep refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', d, s)), 'P0058');
  perform pg_temp.expect('s4.9 deleted source refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, d)), 'P0058');
  x := pg_temp.mk_patient('S4X');
  y := pg_temp.mk_patient('S4Y');
  perform pg_temp.mark_merged(x, y);
  perform pg_temp.expect('s4.10 already-merged source refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, x)), 'P0058');
  perform pg_temp.expect('s4.11 tombstone as keep refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', x, s)), 'P0058');
  perform pg_temp.expect('s4.12 missing record refused',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, gen_random_uuid())), 'P0058');

  perform pg_temp.expect('s4.13 nothing changed by the refusals',
    ((select count(*) from public.visits where patient_id = s) = 1
     and (select merged_into_id from public.patients where id = s) is null
     and not exists (select 1 from public.patient_merges where keep_id = k or source_id = s))::text, 'true');

  perform pg_temp.expect('s4.14 anon cannot execute', has_function_privilege('anon', sig, 'execute')::text, 'false');
  perform pg_temp.expect('s4.15 authenticated cannot execute', has_function_privilege('authenticated', sig, 'execute')::text, 'false');
  perform pg_temp.expect('s4.16 service_role can', has_function_privilege('service_role', sig, 'execute')::text, 'true');
  perform pg_temp.expect('s4.17 authenticated call is denied (42501)',
    pg_temp.state_as('authenticated', format('select public.merge_patients_guarded(%L, %L, %L, null)', k, s, pg_temp.admin())), '42501');
end
$s4$;

-- s5 ---------------------------------------------------------------------------
-- A failure in the LAST write (the ledger insert) must leave both records
-- exactly as they were: no partial merge exists any more.
create function public.mg_smoke_boom() returns trigger language plpgsql as $f$
begin
  raise exception 'forced failure' using errcode = 'XX000';
end $f$;

do $s5$
declare
  k uuid; s uuid; t uuid; vs uuid; ls uuid; r uuid; al uuid; grp uuid := gen_random_uuid();
  before_k text; before_s text;
begin
  k := pg_temp.mk_patient('S5K');
  s := pg_temp.mk_patient('S5S', '09175550000');
  t := pg_temp.mk_patient('S5T');
  perform pg_temp.mark_merged(t, s);
  vs := pg_temp.mk_visit(s);
  ls := pg_temp.mk_line(vs);
  r := pg_temp.mk_result(array[ls]);
  al := pg_temp.mk_alert(r, ls, s);
  perform pg_temp.mk_appt(s, grp);
  perform pg_temp.mk_attach(s, grp);
  perform pg_temp.grant_consent(s);
  select to_jsonb(p) - 'updated_at' - 'row_version' into before_k from public.patients p where id = k;
  select to_jsonb(p) - 'updated_at' - 'row_version' into before_s from public.patients p where id = s;

  execute format('create trigger mg_smoke_boom before insert on public.patient_merges for each row '
                 'when (new.keep_id = %L) execute function public.mg_smoke_boom()', k);
  perform pg_temp.expect('s5.1 forced failure in the ledger insert surfaces',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, s)), 'XX000');
  drop trigger mg_smoke_boom on public.patient_merges;

  perform pg_temp.expect('s5.2 both records unchanged',
    ((select to_jsonb(p) - 'updated_at' - 'row_version' from public.patients p where id = k)::text = before_k
     and (select to_jsonb(p) - 'updated_at' - 'row_version' from public.patients p where id = s)::text = before_s)::text, 'true');
  perform pg_temp.expect('s5.3 every child row still on the source, chain intact',
    ((select patient_id from public.visits where id = vs) = s
     and (select patient_id || '|' || patient_drm_id from public.critical_alerts where id = al) = s || '|DRM-MGS5S'
     and (select count(*) from public.appointments where patient_id = s) = 1
     and (select count(*) from public.appointment_attachments where patient_id = s) = 1
     and (select count(*) from public.patient_consents where patient_id = s) = 1
     and (select merged_into_id from public.patients where id = t) = s)::text, 'true');
  perform pg_temp.expect('s5.4 no audit row, no ledger row',
    ((select count(*) from public.audit_log where action = 'patient.merged' and patient_id = k)
     + (select count(*) from public.patient_merges where keep_id = k))::text, '0');
  perform pg_temp.expect('s5.5 the same merge then succeeds',
    pg_temp.state_of(format('select pg_temp.merge(%L, %L)', k, s)), 'ok');
end
$s5$;
```

- [ ] **Step 2: Run the smoke — expect s3 to fail** with `function public.merge_patients_guarded(uuid, uuid, uuid, jsonb) does not exist`.

- [ ] **Step 3: Append section 6 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- (6) merge_patients_guarded — one transaction. Refusals: P0078 (actor),
-- P0079 (pair / context), P0058 (inactive or missing record), P0072 (the
-- chain or the affected results changed while waiting — the caller retries
-- once). Anything else aborts the whole merge; there is no partial merge.
-- ---------------------------------------------------------------------------
create or replace function public.merge_patients_guarded(
  p_keep uuid, p_source uuid, p_actor uuid, p_context jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k_fill constant text[] := array['middle_name', 'sex', 'phone', 'email', 'address', 'birthdate'];
  v_ip        inet;
  v_ctx       jsonb;
  v_chain     uuid[];
  v_chain2    uuid[];
  v_results   uuid[];
  v_results2  uuid[];
  v_keep      public.patients%rowtype;
  v_source    public.patients%rowtype;
  v_visits    uuid[];
  v_appts     uuid[];
  v_audit     bigint[];
  v_alerts    uuid[];
  v_consents  uuid[];
  v_attach    uuid[];
  v_counts    jsonb;
  v_kj        jsonb;
  v_sj        jsonb;
  v_after     jsonb;
  v_filled    text[] := '{}';
  v_fill      jsonb := '{}'::jsonb;
  v_rechained uuid[];
  v_merge_id  uuid;
  f           text;
begin
  -- (1) Validate.
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can merge patient records' using errcode = 'P0078';
  end if;
  if p_keep is null or p_source is null or p_keep = p_source then
    raise exception 'pick two different patient records to merge' using errcode = 'P0079';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent', 'source', 'tier'))
       or coalesce(p_context->>'source', 'admin') not in ('admin', 'candidates', 'dedup-cli')
       or length(coalesce(p_context->>'tier', '')) > 40
     ) then
    raise exception 'unexpected merge context' using errcode = 'P0079';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;
  v_ctx := jsonb_strip_nulls(jsonb_build_object(
    'source', coalesce(p_context->>'source', 'admin'),
    'tier', nullif(p_context->>'tier', '')));

  -- (2) Lock: result membership → patients → rows, then re-resolve.
  select coalesce(array_agg(p.id order by p.id), '{}') into v_chain
    from public.patients p where p.merged_into_id = p_source;
  select coalesce(array_agg(distinct x.r order by x.r), '{}') into v_results
    from (
      select rtr.result_id as r
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
        join public.visits v on v.id = t.visit_id
       where v.patient_id = p_source
      union
      select ca.result_id from public.critical_alerts ca where ca.patient_id = p_source
    ) x;

  perform public.lifecycle_lock_results(v_results, false);
  perform public.lifecycle_lock(array[p_keep, p_source] || v_chain, true);
  perform 1 from public.patients p
    where p.id = any(array[p_keep, p_source] || v_chain)
    order by p.id
    for no key update;

  select coalesce(array_agg(p.id order by p.id), '{}') into v_chain2
    from public.patients p where p.merged_into_id = p_source;
  select coalesce(array_agg(distinct x.r order by x.r), '{}') into v_results2
    from (
      select rtr.result_id as r
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
        join public.visits v on v.id = t.visit_id
       where v.patient_id = p_source
      union
      select ca.result_id from public.critical_alerts ca where ca.patient_id = p_source
    ) x;
  if v_chain2 is distinct from v_chain or not (v_results2 <@ v_results) then
    raise exception 'the patient records changed while the merge was waiting — try again'
      using errcode = 'P0072';
  end if;

  -- (3) Both records exist and are active.
  select * into v_keep from public.patients where id = p_keep;
  if not found then
    raise exception 'the patient record to keep was not found' using errcode = 'P0058';
  end if;
  select * into v_source from public.patients where id = p_source;
  if not found then
    raise exception 'the patient record to merge in was not found' using errcode = 'P0058';
  end if;
  if v_keep.deleted_at is not null or v_source.deleted_at is not null then
    raise exception '% is deleted — restore it from Admin Tools › Deleted Patients before merging',
      case when v_keep.deleted_at is not null then v_keep.drm_id else v_source.drm_id end
      using errcode = 'P0058';
  end if;
  if v_keep.merged_into_id is not null or v_source.merged_into_id is not null then
    raise exception '% has already been merged into another record — refresh and try again',
      case when v_keep.merged_into_id is not null then v_keep.drm_id else v_source.drm_id end
      using errcode = 'P0058';
  end if;

  -- (4) Move, in this order (visits before critical_alerts: 0184's
  -- alert-matches-its-test check). Each UPDATE fires a_lifecycle_guard, whose
  -- exclusive locks on old ∪ new are already held.
  with m as (update public.visits set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_visits from m;
  with m as (update public.appointments set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_appts from m;
  with m as (update public.audit_log set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_audit from m;
  -- patient_drm_id is the copy three staff surfaces print; an open alert must
  -- not send staff to a retired DRM-ID.
  with m as (update public.critical_alerts set patient_id = p_keep, patient_drm_id = v_keep.drm_id
              where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_alerts from m;
  with m as (update public.patient_consents set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_consents from m;
  with m as (update public.appointment_attachments set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_attach from m;

  v_counts := jsonb_build_object(
    'visits', cardinality(v_visits), 'appointments', cardinality(v_appts),
    'audit_log', cardinality(v_audit), 'critical_alerts', cardinality(v_alerts),
    'patient_consents', cardinality(v_consents), 'appointment_attachments', cardinality(v_attach));

  -- (5) Consent cache for both — the source BEFORE it becomes a tombstone.
  perform public.recompute_patient_consent_cache(p_source);
  perform public.recompute_patient_consent_cache(p_keep);

  -- The repeat flag is set on visit INSERT only; the kept record may now
  -- have several visits. Set-only, like the trigger.
  update public.patients set is_repeat_patient = true
   where id = p_keep and not is_repeat_patient
     and (select count(*) from public.visits v where v.patient_id = p_keep) > 1;

  -- (6) Fill NULL/blank fields on keep from source; never overwrite.
  select to_jsonb(p) into v_kj from public.patients p where p.id = p_keep;
  v_sj := to_jsonb(v_source);
  foreach f in array k_fill loop
    if nullif(btrim(coalesce(v_kj->>f, '')), '') is null
       and nullif(btrim(coalesce(v_sj->>f, '')), '') is not null then
      v_filled := v_filled || f;
    end if;
  end loop;
  if cardinality(v_filled) > 0 then
    update public.patients p set
      middle_name = case when 'middle_name' = any(v_filled) then v_source.middle_name else p.middle_name end,
      sex         = case when 'sex' = any(v_filled) then v_source.sex else p.sex end,
      phone       = case when 'phone' = any(v_filled) then v_source.phone else p.phone end,
      email       = case when 'email' = any(v_filled) then v_source.email else p.email end,
      address     = case when 'address' = any(v_filled) then v_source.address else p.address end,
      birthdate   = case when 'birthdate' = any(v_filled) then v_source.birthdate else p.birthdate end
     where p.id = p_keep;
    -- "after" is what the row holds once its normalising triggers ran.
    select to_jsonb(p) into v_after from public.patients p where p.id = p_keep;
    foreach f in array v_filled loop
      v_fill := v_fill || jsonb_build_object(f, jsonb_build_object('before', v_kj->f, 'after', v_after->f));
    end loop;
  end if;

  -- (7) Flatten the chain: older tombstones of the source now point at keep.
  with c as (update public.patients set merged_into_id = p_keep where merged_into_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_rechained from c;

  -- (8) Tombstone the source.
  update public.patients set merged_into_id = p_keep, merged_at = now() where id = p_source;

  -- (9) Ledger (version 2).
  insert into public.patient_merges (keep_id, source_id, merged_by, moved, filled_from_source,
                                     snapshot_version, fill_snapshot, rechained, context)
  values (p_keep, p_source, p_actor,
          jsonb_build_object(
            'visits', to_jsonb(v_visits), 'appointments', to_jsonb(v_appts),
            'audit_log', to_jsonb(v_audit), 'critical_alerts', to_jsonb(v_alerts),
            'patient_consents', to_jsonb(v_consents), 'appointment_attachments', to_jsonb(v_attach)),
          v_filled, 2, v_fill, v_rechained, v_ctx)
  returning id into v_merge_id;

  -- (10) Audit, same transaction.
  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', p_keep, 'patient.merged', 'patient', p_keep,
          jsonb_build_object(
            'merge_id', v_merge_id, 'kept_drm_id', v_keep.drm_id, 'merged_drm_id', v_source.drm_id,
            'merged_patient_id', p_source, 'moved', v_counts, 'filled_from_source', to_jsonb(v_filled),
            'rechained', cardinality(v_rechained)) || v_ctx,
          v_ip, left(nullif(p_context->>'user_agent', ''), 512));

  return jsonb_build_object(
    'merge_id', v_merge_id, 'keep_id', p_keep, 'source_id', p_source,
    'kept_drm_id', v_keep.drm_id, 'merged_drm_id', v_source.drm_id,
    'moved', v_counts, 'filled', to_jsonb(v_filled), 'rechained', cardinality(v_rechained));
end;
$$;
```

- [ ] **Step 4: Apply + run the smoke**

```bash
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0196_patient_merge_atomic.sql > /tmp/0196.log 2>&1; echo exit=$?
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/0196_patient_merge_atomic_smoke.sql 2>&1 | grep -E "OK|FAILED|ERROR" | tail -60
```
Expected: `exit=0`; s2, s3, s4, s5, s11 all `OK`. **Note:** until Task 5 transfers ownership, the function runs as postgres, so a missing grant will not show yet — Task 5 re-runs everything under the real owner.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0196_patient_merge_atomic.sql supabase/tests/0196_patient_merge_atomic_smoke.sql
git commit -m "feat(db): 0196 merge_patients_guarded — atomic merge with snapshots, consent re-sync, chain flattening

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: `undo_patient_merge_guarded` (+ smoke s6–s10)

**Files:**
- Modify: `supabase/migrations/0196_patient_merge_atomic.sql` (append section 7)
- Modify: `supabase/tests/0196_patient_merge_atomic_smoke.sql` (add two helpers after `pg_temp.consent5`; add s6–s10 before the final `rollback;`)

**Rules implemented (spec "undo" steps 1–11, R1, R2, R6, R1', R4', R5'):**
- Result scope `R` = results linked to a test on **any** visit recorded in `moved.visits` (whoever owns it now), ∪ `result_id` of every alert on keep or source whose test is on one of those visits. Locked shared **before** the patient locks; re-resolved after → P0072.
- Refusals (P0079): already undone; `now() - merged_at >= 30 days`; keep merged or deleted; source deleted; source not this merge's tombstone — except a **legacy** row whose source marker is already NULL (an interrupted old-app undo), which is completed; a result in `R` that would link tests of more than one patient after the undo.
- Recorded rows move back only while still on keep (`visits`, `appointments`, `audit_log`, `patient_consents`). Alerts follow their test's visit (recorded or not, re-stamped with the source's DRM-ID). Attachments: unrecorded ones move only on positive evidence (≥1 appointment with a patient in their booking group, all on source); recorded ones move when the group has no such evidence or all of it is on source.
- Fill revert: v2 → a field goes back to `before` only while keep still holds `after`; legacy (source still a tombstone) → cleared only while keep equals the source's value; interrupted legacy resume → nothing reverted, all reported.

- [ ] **Step 1: Add two fixture helpers** (after `pg_temp.consent5` in the smoke file)

```sql
-- The pre-3b app's merge, statement by statement (for LEGACY ledger rows):
-- moves the six tables, copies phone/email if keep lacks them, tombstones the
-- source (through the writer, so the fixture also works under 0197) and writes
-- a ledger row with NO snapshot_version.
create function pg_temp.legacy_merge(k uuid, s uuid) returns uuid language plpgsql as $f$
declare
  mv jsonb := '{}'::jsonb; x jsonb; filled text[] := '{}'; kp public.patients%rowtype; sp public.patients%rowtype; mid uuid;
begin
  select * into kp from public.patients where id = k;
  select * into sp from public.patients where id = s;
  with u as (update public.visits set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('visits', x);
  with u as (update public.appointments set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('appointments', x);
  with u as (update public.audit_log set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('audit_log', x);
  with u as (update public.critical_alerts set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('critical_alerts', x);
  with u as (update public.patient_consents set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('patient_consents', x);
  with u as (update public.appointment_attachments set patient_id = k where patient_id = s returning id)
    select coalesce(jsonb_agg(id), '[]') into x from u;  mv := mv || jsonb_build_object('appointment_attachments', x);
  if kp.phone is null and sp.phone is not null then
    update public.patients set phone = sp.phone where id = k; filled := filled || 'phone'::text;
  end if;
  if kp.email is null and sp.email is not null then
    update public.patients set email = sp.email where id = k; filled := filled || 'email'::text;
  end if;
  perform pg_temp.mark_merged(s, k);
  insert into public.patient_merges (keep_id, source_id, merged_by, moved, filled_from_source)
  values (k, s, 'a0000000-0000-4000-8000-000000000196', mv, filled) returning id into mid;
  return mid;
end $f$;

-- Runs one statement as the writer role (fixtures that emulate an old-app
-- undo that stopped part-way; 0197-proof).
create function pg_temp.as_writer(sql text) returns void language plpgsql as $f$
begin
  set local role patient_merge_writer;
  execute sql;
  reset role;
end $f$;
```

- [ ] **Step 2: Add s6–s10 (before the final `rollback;`)**

```sql
-- s6 ---------------------------------------------------------------------------
do $s6$
declare
  k uuid; s uuid; t uuid; vk uuid; vs1 uuid; vs2 uuid; ls1 uuid; ls2 uuid; r1 uuid; r2 uuid;
  al uuid; al2 uuid; ap uuid; att uuid; au bigint; grp uuid := gen_random_uuid();
  vnew uuid; apnew uuid; mid uuid; rep jsonb; m public.patient_merges%rowtype; c text;
begin
  k := pg_temp.mk_patient('S6K');
  s := pg_temp.mk_patient('S6S', '09176660000', 'mg-s6s@example.test');
  update public.patients set address = 'S6 street' where id = s;
  t := pg_temp.mk_patient('S6T');
  perform pg_temp.mark_merged(t, s);
  vk := pg_temp.mk_visit(k);
  vs1 := pg_temp.mk_visit(s);
  vs2 := pg_temp.mk_visit(s);
  ls1 := pg_temp.mk_line(vs1);
  r1 := pg_temp.mk_result(array[ls1]);
  al := pg_temp.mk_alert(r1, ls1, s);
  ap := pg_temp.mk_appt(s, grp);
  att := pg_temp.mk_attach(s, grp);
  au := pg_temp.mk_audit(s);
  perform pg_temp.grant_consent(s);

  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;

  -- work done on the kept record after the merge
  update public.patients set phone = '09179990000' where id = k;       -- edited a filled field
  vnew := pg_temp.mk_visit(k);
  apnew := pg_temp.mk_appt(k, gen_random_uuid());
  perform pg_temp.withdraw_consent(k);
  ls2 := pg_temp.mk_line(vs2);                                        -- a moved visit gets a new result + alert
  r2 := pg_temp.mk_result(array[ls2]);
  al2 := pg_temp.mk_alert(r2, ls2, k);

  rep := pg_temp.undo(mid);
  select * into m from public.patient_merges where id = mid;

  perform pg_temp.expect('s6.1 recorded visits back; keep''s old and new visits stay',
    ((select patient_id from public.visits where id = vs1) = s and (select patient_id from public.visits where id = vs2) = s
     and (select patient_id from public.visits where id = vk) = k and (select patient_id from public.visits where id = vnew) = k)::text, 'true');
  perform pg_temp.expect('s6.2 appointment, upload, audit row, consent back; later rows stay',
    ((select patient_id from public.appointments where id = ap) = s and (select patient_id from public.appointments where id = apnew) = k
     and (select patient_id from public.appointment_attachments where id = att) = s
     and (select patient_id from public.audit_log where id = au) = s
     and (select count(*) from public.patient_consents where patient_id = s and event_type = 'granted') = 1
     and (select count(*) from public.patient_consents where patient_id = k and event_type = 'withdrawn') = 1)::text, 'true');
  perform pg_temp.expect('s6.3 both alerts follow their visit (incl. the one created after the merge), re-stamped',
    (select string_agg(patient_id::text || ':' || patient_drm_id, ',' order by created_at, id)
       from public.critical_alerts where id in (al, al2)),
    s::text || ':DRM-MGS6S,' || s::text || ':DRM-MGS6S');
  perform pg_temp.expect('s6.4 edited phone kept; untouched email + address reverted',
    concat_ws('|', (select phone from public.patients where id = k),
                   coalesce((select email from public.patients where id = k), 'null'),
                   coalesce((select address from public.patients where id = k), 'null')),
    '09179990000|null|null');
  perform pg_temp.expect('s6.5 report: kept vs reverted fields',
    (rep->'kept_fields')::text || '|' ||
    (select string_agg(x, ',' order by x) from jsonb_array_elements_text(rep->'reverted_fields') x),
    '["phone"]|address,email');
  perform pg_temp.expect('s6.6 chain restored', (select merged_into_id from public.patients where id = t)::text, s::text);
  perform pg_temp.expect('s6.7 source active again',
    ((select merged_into_id is null and merged_at is null from public.patients where id = s))::text, 'true');
  c := pg_temp.consent5(k);
  perform pg_temp.expect('s6.8 consent re-synced: source granted, keep withdrawn-only',
    split_part(pg_temp.consent5(s), '|', 1) || '|' || split_part(c, '|', 1) || '|' ||
    (split_part(c, '|', 3) <> '')::text || '|' || split_part(c, '|', 2), 'true|false|true|');
  perform pg_temp.expect('s6.9 ledger marked undone with the report',
    (m.undone_at is not null and m.undone_by = pg_temp.admin() and m.undo_report = rep)::text, 'true');
  perform pg_temp.expect('s6.10 audit row',
    (select count(*) from public.audit_log a where a.action = 'patient.merge.undone' and a.patient_id = k
       and a.resource_id = s and a.metadata->>'merge_id' = mid::text)::text, '1');
  perform pg_temp.expect('s6.11 report counts; nothing recorded left on keep',
    (rep->'moved_back'->>'visits') || '|' || (rep->'moved_back'->>'critical_alerts') || '|' ||
    (select sum(jsonb_array_length(v))::text from jsonb_each(rep->'left_on_keep') e(k2, v)) || '|' ||
    (rep->>'resumed_interrupted_undo'),
    '2|2|0|false');
  perform pg_temp.expect('s6.12 the source takes writes again', pg_temp.state_of(format('select pg_temp.mk_visit(%L)', s)), 'ok');
end
$s6$;

-- s7 ---------------------------------------------------------------------------
do $s7$
declare
  k uuid; s uuid; mid uuid; k2 uuid; s2 uuid; mid2 uuid; k3 uuid; s3 uuid; z3 uuid; mid3 uuid;
  k4 uuid; s4 uuid; mid4 uuid; k5 uuid; s5 uuid; vs5 uuid; vk5 uuid; mid5 uuid; k6 uuid; s6 uuid; mid6 uuid;
  sig constant text := 'public.undo_patient_merge_guarded(uuid, uuid, jsonb)';
begin
  k := pg_temp.mk_patient('S7K'); s := pg_temp.mk_patient('S7S'); perform pg_temp.mk_visit(s);
  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;
  perform pg_temp.undo(mid);
  perform pg_temp.expect('s7.1 double undo refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid)), 'P0079');

  -- 30-day boundary (now() is the transaction start, so the arithmetic is exact)
  k2 := pg_temp.mk_patient('S7K2'); s2 := pg_temp.mk_patient('S7S2');
  mid2 := (pg_temp.merge(k2, s2)->>'merge_id')::uuid;
  update public.patient_merges set merged_at = now() - interval '30 days' where id = mid2;
  perform pg_temp.expect('s7.2 exactly 30 days refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid2)), 'P0079');
  update public.patient_merges set merged_at = now() - interval '30 days 1 second' where id = mid2;
  perform pg_temp.expect('s7.3 30 days + 1s refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid2)), 'P0079');
  update public.patient_merges set merged_at = now() - interval '29 days 23 hours 59 minutes 59 seconds' where id = mid2;
  perform pg_temp.expect('s7.4 29d 23h 59m 59s allowed', pg_temp.state_of(format('select pg_temp.undo(%L)', mid2)), 'ok');

  -- kept record since merged into a third record
  k3 := pg_temp.mk_patient('S7K3'); s3 := pg_temp.mk_patient('S7S3'); z3 := pg_temp.mk_patient('S7Z3');
  mid3 := (pg_temp.merge(k3, s3)->>'merge_id')::uuid;
  perform pg_temp.merge(z3, k3);
  perform pg_temp.expect('s7.5 keep merged elsewhere refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid3)), 'P0079');

  -- kept record since deleted
  k4 := pg_temp.mk_patient('S7K4'); s4 := pg_temp.mk_patient('S7S4');
  mid4 := (pg_temp.merge(k4, s4)->>'merge_id')::uuid;
  perform pg_temp.kill(k4);
  perform pg_temp.expect('s7.6 keep deleted refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid4)), 'P0079');

  -- a result made after the merge that combines a moved visit's test with one of keep's own
  k5 := pg_temp.mk_patient('S7K5'); s5 := pg_temp.mk_patient('S7S5');
  vs5 := pg_temp.mk_visit(s5);
  mid5 := (pg_temp.merge(k5, s5)->>'merge_id')::uuid;
  vk5 := pg_temp.mk_visit(k5);
  perform pg_temp.mk_result(array[pg_temp.mk_line(vs5), pg_temp.mk_line(vk5)]);
  perform pg_temp.expect('s7.7 split result refused', pg_temp.state_of(format('select pg_temp.undo(%L)', mid5)), 'P0079');
  perform pg_temp.expect('s7.8 nothing changed by the refusal',
    ((select patient_id from public.visits where id = vs5) = k5
     and (select merged_into_id from public.patients where id = s5) = k5
     and (select undone_at from public.patient_merges where id = mid5) is null)::text, 'true');

  k6 := pg_temp.mk_patient('S7K6'); s6 := pg_temp.mk_patient('S7S6');
  mid6 := (pg_temp.merge(k6, s6)->>'merge_id')::uuid;
  perform pg_temp.expect('s7.9 reception actor refused',
    pg_temp.state_of(format('select pg_temp.undo(%L, %L)', mid6, 'a1000000-0000-4000-8000-000000000196')), 'P0078');
  perform pg_temp.expect('s7.10 NULL actor refused',
    pg_temp.state_as('service_role', format('select public.undo_patient_merge_guarded(%L, null, null)', mid6)), 'P0078');
  perform pg_temp.expect('s7.11 unknown merge refused', pg_temp.state_of(format('select pg_temp.undo(%L)', gen_random_uuid())), 'P0079');
  perform pg_temp.expect('s7.12 bad context refused',
    pg_temp.state_as('service_role', format('select public.undo_patient_merge_guarded(%L, %L, %L)', mid6, pg_temp.admin(), '{"x":1}')), 'P0079');
  perform pg_temp.expect('s7.13 anon/authenticated cannot execute; service_role can',
    has_function_privilege('anon', sig, 'execute')::text || has_function_privilege('authenticated', sig, 'execute')::text
    || has_function_privilege('service_role', sig, 'execute')::text, 'falsefalsetrue');
end
$s7$;

-- s8 ---------------------------------------------------------------------------
do $s8$
declare k uuid; s uuid; vs uuid; mid uuid; rep jsonb;
begin
  k := pg_temp.mk_patient('S8K');
  s := pg_temp.mk_patient('S8S', '09178880000', 'mg-s8s@example.test');
  vs := pg_temp.mk_visit(s);
  mid := pg_temp.legacy_merge(k, s);
  update public.patients set email = 'mg-s8-edited@example.test' where id = k;   -- edited after the merge
  rep := pg_temp.undo(mid);
  perform pg_temp.expect('s8.1 legacy undo moves the recorded visit back', (select patient_id from public.visits where id = vs)::text, s::text);
  perform pg_temp.expect('s8.2 legacy fill: phone (still = source) cleared, edited email kept',
    coalesce((select phone from public.patients where id = k), 'null') || '|' || (select email from public.patients where id = k)
    || '|' || (rep->'kept_fields')::text, 'null|mg-s8-edited@example.test|["email"]');
  perform pg_temp.expect('s8.3 ledger undone; not a resume',
    ((select undone_at is not null from public.patient_merges where id = mid) and (rep->>'resumed_interrupted_undo') = 'false')::text, 'true');
end
$s8$;

-- s9 ---------------------------------------------------------------------------
do $s9$
declare
  k uuid; s uuid; vs1 uuid; vs2 uuid; ls1 uuid; r1 uuid; al uuid; ap uuid; mid uuid; rep jsonb;
  k2 uuid; s2 uuid; vs3 uuid; vk2 uuid; mid2 uuid;
begin
  k := pg_temp.mk_patient('S9K');
  s := pg_temp.mk_patient('S9S', '09179990001');
  vs1 := pg_temp.mk_visit(s); vs2 := pg_temp.mk_visit(s);
  ls1 := pg_temp.mk_line(vs1); r1 := pg_temp.mk_result(array[ls1]); al := pg_temp.mk_alert(r1, ls1, s);
  ap := pg_temp.mk_appt(s, gen_random_uuid());
  mid := pg_temp.legacy_merge(k, s);
  -- the old action cleared the marker, moved visits back … and stopped
  perform pg_temp.as_writer(format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s));
  perform pg_temp.as_writer(format('update public.visits set patient_id = %L where id in (%L, %L)', s, vs1, vs2));
  -- meanwhile both records were corrected to the same new phone
  update public.patients set phone = '09170001111' where id in (k, s);

  rep := pg_temp.undo(mid);
  perform pg_temp.expect('s9.1 completes an interrupted legacy undo', rep->>'resumed_interrupted_undo', 'true');
  perform pg_temp.expect('s9.2 the rest moves back; the alert follows its visit',
    ((select patient_id from public.appointments where id = ap) = s
     and (select patient_id from public.critical_alerts where id = al) = s)::text, 'true');
  perform pg_temp.expect('s9.3 no fill reverted on a resume; all reported',
    (select phone from public.patients where id = k) || '|' || (rep->'kept_fields')::text || '|' || (rep->'reverted_fields')::text,
    '09170001111|["phone"]|[]');

  -- a result already split by the interrupted undo is refused, nothing changed
  k2 := pg_temp.mk_patient('S9K2'); s2 := pg_temp.mk_patient('S9S2');
  vs3 := pg_temp.mk_visit(s2);
  mid2 := pg_temp.legacy_merge(k2, s2);
  vk2 := pg_temp.mk_visit(k2);
  perform pg_temp.mk_result(array[pg_temp.mk_line(vs3), pg_temp.mk_line(vk2)]);      -- both on k2: allowed
  perform pg_temp.as_writer(format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s2));
  perform pg_temp.as_writer(format('update public.visits set patient_id = %L where id = %L', s2, vs3));  -- now split
  perform pg_temp.expect('s9.4 resume refuses an already-split result', pg_temp.state_of(format('select pg_temp.undo(%L)', mid2)), 'P0079');
  perform pg_temp.expect('s9.5 ledger still live', ((select undone_at from public.patient_merges where id = mid2) is null)::text, 'true');
end
$s9$;

-- s10 --------------------------------------------------------------------------
do $s10$
declare
  k uuid; s uuid; mid uuid; rep jsonb;
  g_empty uuid := gen_random_uuid(); g_walk uuid := gen_random_uuid(); g_split uuid := gen_random_uuid();
  g_follow uuid := gen_random_uuid();
  a_empty uuid; a_walk uuid; a_split uuid; a_orphan uuid; a_follow uuid;
begin
  k := pg_temp.mk_patient('S10K'); s := pg_temp.mk_patient('S10S');
  a_empty := pg_temp.mk_attach(s, g_empty);                          -- recorded, empty group
  perform pg_temp.mk_walkin_appt(g_walk);
  a_walk := pg_temp.mk_attach(s, g_walk);                            -- recorded, walk-in-only group
  perform pg_temp.mk_appt(s, g_split);
  a_split := pg_temp.mk_attach(s, g_split);                          -- recorded; keep books into the group later
  a_orphan := pg_temp.mk_attach(k, gen_random_uuid());               -- keep's own orphan upload
  perform pg_temp.mk_appt(s, g_follow);                              -- source booking, upload arrives after the merge
  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;
  perform pg_temp.mk_appt(k, g_split);
  a_follow := pg_temp.mk_attach(k, g_follow);

  rep := pg_temp.undo(mid);
  perform pg_temp.expect('s10.1 recorded, empty group → back',
    (select patient_id from public.appointment_attachments where id = a_empty)::text, s::text);
  perform pg_temp.expect('s10.2 recorded, walk-in-only group → back',
    (select patient_id from public.appointment_attachments where id = a_walk)::text, s::text);
  perform pg_temp.expect('s10.3 recorded, group now has keep''s booking → stays, reported',
    (select patient_id from public.appointment_attachments where id = a_split)::text || '|' ||
    (rep->'left_on_keep'->'appointment_attachments' @> to_jsonb(array[a_split]))::text, k::text || '|true');
  perform pg_temp.expect('s10.4 keep''s own orphan upload never taken',
    (select patient_id from public.appointment_attachments where id = a_orphan)::text, k::text);
  perform pg_temp.expect('s10.5 unrecorded upload follows its booking back',
    (select patient_id from public.appointment_attachments where id = a_follow)::text, s::text);
end
$s10$;
```

- [ ] **Step 3: Run — expect s6 to fail** (`function public.undo_patient_merge_guarded(uuid, uuid, jsonb) does not exist`).

- [ ] **Step 4: Append section 7 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- (7) undo_patient_merge_guarded — one transaction. Refusals: P0078 (actor),
-- P0079 (not undoable — message passes through), P0072 (the affected results
-- changed while waiting — retried once by the caller).
-- ---------------------------------------------------------------------------
create or replace function public.undo_patient_merge_guarded(
  p_merge_id uuid, p_actor uuid, p_context jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k_fill constant text[] := array['middle_name', 'sex', 'phone', 'email', 'address', 'birthdate'];
  v_ip          inet;
  m             public.patient_merges%rowtype;
  v_legacy      boolean;
  v_resume      boolean := false;
  v_keep        public.patients%rowtype;
  v_source      public.patients%rowtype;
  v_mv_visits   uuid[];
  v_mv_appts    uuid[];
  v_mv_audit    bigint[];
  v_mv_alerts   uuid[];
  v_mv_consents uuid[];
  v_mv_attach   uuid[];
  v_results     uuid[];
  v_results2    uuid[];
  v_split       uuid;
  v_b_visits    uuid[];
  v_b_appts     uuid[];
  v_b_audit     bigint[];
  v_b_alerts    uuid[];
  v_b_consents  uuid[];
  v_b_attach    uuid[];
  v_kj          jsonb;
  v_sj          jsonb;
  v_revert      text[] := '{}';
  v_kept        text[] := '{}';
  v_before      jsonb := '{}'::jsonb;
  v_rechained   uuid[];
  v_left        jsonb;
  v_report      jsonb;
  f             text;
begin
  -- (1) Validate.
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can undo a merge' using errcode = 'P0078';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))
     ) then
    raise exception 'unexpected undo context' using errcode = 'P0079';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  -- (2) The ledger row (plain read; re-read under lock below).
  select * into m from public.patient_merges where id = p_merge_id;
  if not found then
    raise exception 'merge record not found' using errcode = 'P0079';
  end if;
  v_legacy := m.snapshot_version is null;
  v_mv_visits   := array(select x::uuid   from jsonb_array_elements_text(coalesce(m.moved->'visits', '[]'::jsonb)) x);
  v_mv_appts    := array(select x::uuid   from jsonb_array_elements_text(coalesce(m.moved->'appointments', '[]'::jsonb)) x);
  v_mv_audit    := array(select x::bigint from jsonb_array_elements_text(coalesce(m.moved->'audit_log', '[]'::jsonb)) x);
  v_mv_alerts   := array(select x::uuid   from jsonb_array_elements_text(coalesce(m.moved->'critical_alerts', '[]'::jsonb)) x);
  v_mv_consents := array(select x::uuid   from jsonb_array_elements_text(coalesce(m.moved->'patient_consents', '[]'::jsonb)) x);
  v_mv_attach   := array(select x::uuid   from jsonb_array_elements_text(coalesce(m.moved->'appointment_attachments', '[]'::jsonb)) x);

  -- (3) Lock: result membership over the COMPLETE undo scope (every recorded
  -- visit, whoever owns it now, and every alert on keep or source for their
  -- tests) → patients → ledger row → patient rows; then re-resolve.
  select coalesce(array_agg(distinct x.r order by x.r), '{}') into v_results
    from (
      select rtr.result_id as r
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
       where t.visit_id = any(v_mv_visits)
      union
      select ca.result_id
        from public.critical_alerts ca
        join public.test_requests t on t.id = ca.test_request_id
       where t.visit_id = any(v_mv_visits) and ca.patient_id in (m.keep_id, m.source_id)
    ) x;

  perform public.lifecycle_lock_results(v_results, false);
  perform public.lifecycle_lock(array[m.keep_id, m.source_id] || m.rechained, true);
  select * into m from public.patient_merges where id = p_merge_id for update;
  perform 1 from public.patients p
    where p.id = any(array[m.keep_id, m.source_id] || m.rechained)
    order by p.id
    for no key update;

  select coalesce(array_agg(distinct x.r order by x.r), '{}') into v_results2
    from (
      select rtr.result_id as r
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
       where t.visit_id = any(v_mv_visits)
      union
      select ca.result_id
        from public.critical_alerts ca
        join public.test_requests t on t.id = ca.test_request_id
       where t.visit_id = any(v_mv_visits) and ca.patient_id in (m.keep_id, m.source_id)
    ) x;
  if not (v_results2 <@ v_results) then
    raise exception 'the patient records changed while the undo was waiting — try again'
      using errcode = 'P0072';
  end if;

  -- (4) Refusals.
  if m.undone_at is not null then
    raise exception 'this merge was already undone' using errcode = 'P0079';
  end if;
  if now() - m.merged_at >= interval '30 days' then
    raise exception 'merges can only be undone within 30 days' using errcode = 'P0079';
  end if;
  select * into v_keep from public.patients where id = m.keep_id;
  select * into v_source from public.patients where id = m.source_id;
  if v_keep.merged_into_id is not null then
    raise exception 'the kept record % has since been merged into another record — undo that merge first', v_keep.drm_id
      using errcode = 'P0079';
  end if;
  if v_keep.deleted_at is not null then
    raise exception 'the kept record % has since been deleted — restore it first', v_keep.drm_id
      using errcode = 'P0079';
  end if;
  if v_source.deleted_at is not null then
    raise exception 'the merged-in record % has since been deleted — restore it first', v_source.drm_id
      using errcode = 'P0079';
  end if;
  if v_source.merged_into_id = m.keep_id then
    null;
  elsif v_source.merged_into_id is null and v_legacy then
    v_resume := true;   -- the pre-3b app cleared the marker first and stopped part-way
  else
    raise exception '% is no longer merged into %, so this merge cannot be undone', v_source.drm_id, v_keep.drm_id
      using errcode = 'P0079';
  end if;

  -- Split-result refusal: after the undo, every affected result must still
  -- link tests of exactly one patient.
  select x.result_id into v_split
    from (
      select rtr.result_id,
             count(distinct case when v.patient_id = m.keep_id and v.id = any(v_mv_visits)
                                 then m.source_id else v.patient_id end) as owners
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
        join public.visits v on v.id = t.visit_id
       where rtr.result_id = any(v_results2)
       group by rtr.result_id
    ) x
   where x.owners > 1
   limit 1;
  if v_split is not null then
    raise exception 'a lab result made after the merge combines tests from both records — correct that result before undoing'
      using errcode = 'P0079', detail = v_split::text;
  end if;

  -- (5) Clear the source's marker FIRST: the source is active again, so
  -- 0184's guards accept every move below without a bypass.
  if not v_resume then
    update public.patients set merged_into_id = null, merged_at = null where id = m.source_id;
  end if;

  -- (6) Move back. Recorded rows only while still on keep.
  with b as (update public.visits set patient_id = m.source_id
              where id = any(v_mv_visits) and patient_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_b_visits from b;
  with b as (update public.appointments set patient_id = m.source_id
              where id = any(v_mv_appts) and patient_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_b_appts from b;
  with b as (update public.audit_log set patient_id = m.source_id
              where id = any(v_mv_audit) and patient_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_b_audit from b;
  -- Alerts follow their test's visit, recorded or not (created, acknowledged
  -- or withdrawn after the merge), re-stamped with the source's DRM-ID.
  with b as (update public.critical_alerts ca
                set patient_id = m.source_id, patient_drm_id = v_source.drm_id
               from public.test_requests t
               join public.visits v on v.id = t.visit_id
              where ca.test_request_id = t.id and ca.patient_id = m.keep_id and v.patient_id = m.source_id
             returning ca.id)
  select coalesce(array_agg(id order by id), '{}') into v_b_alerts from b;
  with b as (update public.patient_consents set patient_id = m.source_id
              where id = any(v_mv_consents) and patient_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_b_consents from b;
  -- Attachments: evidence = the booking group's appointments that name a
  -- patient. Unrecorded uploads move only on positive evidence; recorded ones
  -- also move when the group has no evidence at all (empty / walk-in only).
  with b as (
    update public.appointment_attachments aa set patient_id = m.source_id
     where aa.patient_id = m.keep_id
       and (
         (exists (select 1 from public.appointments ap
                   where ap.booking_group_id = aa.booking_group_id and ap.patient_id is not null)
          and not exists (select 1 from public.appointments ap
                           where ap.booking_group_id = aa.booking_group_id and ap.patient_id is not null
                             and ap.patient_id <> m.source_id))
         or (aa.id = any(v_mv_attach)
             and not exists (select 1 from public.appointments ap
                              where ap.booking_group_id = aa.booking_group_id and ap.patient_id is not null))
       )
    returning aa.id)
  select coalesce(array_agg(id order by id), '{}') into v_b_attach from b;

  -- (7) Revert the fill.
  select to_jsonb(p) into v_kj from public.patients p where p.id = m.keep_id;
  select to_jsonb(p) into v_sj from public.patients p where p.id = m.source_id;
  if v_resume then
    v_kept := coalesce(m.filled_from_source, '{}');
  elsif not v_legacy then
    for f in select jsonb_object_keys(coalesce(m.fill_snapshot, '{}'::jsonb)) loop
      if f = any(k_fill) and (v_kj->f) = (m.fill_snapshot->f->'after') then
        v_revert := v_revert || f;
        v_before := v_before || jsonb_build_object(f, m.fill_snapshot->f->'before');
      else
        v_kept := v_kept || f;
      end if;
    end loop;
  else
    foreach f in array coalesce(m.filled_from_source, '{}'::text[]) loop
      if f = any(k_fill) and jsonb_typeof(v_kj->f) is distinct from 'null' and (v_kj->f) = (v_sj->f) then
        v_revert := v_revert || f;
        v_before := v_before || jsonb_build_object(f, null);
      else
        v_kept := v_kept || f;
      end if;
    end loop;
  end if;
  if cardinality(v_revert) > 0 then
    update public.patients p set
      middle_name = case when 'middle_name' = any(v_revert) then v_before->>'middle_name' else p.middle_name end,
      sex         = case when 'sex' = any(v_revert) then v_before->>'sex' else p.sex end,
      phone       = case when 'phone' = any(v_revert) then v_before->>'phone' else p.phone end,
      email       = case when 'email' = any(v_revert) then v_before->>'email' else p.email end,
      address     = case when 'address' = any(v_revert) then v_before->>'address' else p.address end,
      birthdate   = case when 'birthdate' = any(v_revert) then (v_before->>'birthdate')::date else p.birthdate end
     where p.id = m.keep_id;
  end if;

  -- (8) Restore the chain.
  with c as (update public.patients set merged_into_id = m.source_id
              where id = any(m.rechained) and merged_into_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_rechained from c;

  -- (9) Consent cache for both.
  perform public.recompute_patient_consent_cache(m.source_id);
  perform public.recompute_patient_consent_cache(m.keep_id);

  -- (10) Report + ledger + audit.
  v_left := jsonb_build_object(
    'visits', to_jsonb(array(select id from public.visits where id = any(v_mv_visits) and patient_id = m.keep_id order by id)),
    'appointments', to_jsonb(array(select id from public.appointments where id = any(v_mv_appts) and patient_id = m.keep_id order by id)),
    'audit_log', to_jsonb(array(select id from public.audit_log where id = any(v_mv_audit) and patient_id = m.keep_id order by id)),
    'critical_alerts', to_jsonb(array(select id from public.critical_alerts where id = any(v_mv_alerts) and patient_id = m.keep_id order by id)),
    'patient_consents', to_jsonb(array(select id from public.patient_consents where id = any(v_mv_consents) and patient_id = m.keep_id order by id)),
    'appointment_attachments', to_jsonb(array(select id from public.appointment_attachments where id = any(v_mv_attach) and patient_id = m.keep_id order by id)));
  v_report := jsonb_build_object(
    'merge_id', m.id, 'keep_id', m.keep_id, 'source_id', m.source_id,
    'kept_drm_id', v_keep.drm_id, 'source_drm_id', v_source.drm_id,
    'resumed_interrupted_undo', v_resume,
    'moved_back', jsonb_build_object(
      'visits', cardinality(v_b_visits), 'appointments', cardinality(v_b_appts),
      'audit_log', cardinality(v_b_audit), 'critical_alerts', cardinality(v_b_alerts),
      'patient_consents', cardinality(v_b_consents), 'appointment_attachments', cardinality(v_b_attach)),
    'left_on_keep', v_left,
    'kept_fields', to_jsonb(v_kept),
    'reverted_fields', to_jsonb(v_revert),
    'rechained_back', cardinality(v_rechained));

  update public.patient_merges
     set undone_at = now(), undone_by = p_actor, undo_report = v_report
   where id = m.id;

  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', m.keep_id, 'patient.merge.undone', 'patient', m.source_id,
          v_report, v_ip, left(nullif(p_context->>'user_agent', ''), 512));

  return v_report;
end;
$$;
```

- [ ] **Step 5: Apply + run the smoke** (same two commands as Task 3 Step 4). Expected: s2–s11 all `OK`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0196_patient_merge_atomic.sql supabase/tests/0196_patient_merge_atomic_smoke.sql
git commit -m "feat(db): 0196 undo_patient_merge_guarded — atomic undo that keeps later edits, follows dependents, completes legacy undos

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 5: Ownership, ACLs, post-conditions — then prove everything under the real owner (+ smoke s1)

**Files:**
- Modify: `supabase/migrations/0196_patient_merge_atomic.sql` (append sections 8–9)
- Modify: `supabase/tests/0196_patient_merge_atomic_smoke.sql` (s1 right after the helpers, before s2)

- [ ] **Step 1: Add s1 (after the helper definitions, before `-- s2`)**

```sql
-- s1 ---------------------------------------------------------------------------
do $s1$
begin
  perform pg_temp.expect('s1.1 writer role is NOLOGIN NOINHERIT NOBYPASSRLS',
    (select rolcanlogin::text || rolinherit::text || rolbypassrls::text from pg_roles where rolname = 'patient_merge_writer'),
    'falsefalsefalse');
  perform pg_temp.expect('s1.2 only postgres is a member',
    (select string_agg(distinct r.rolname, ',') from pg_auth_members am join pg_roles r on r.oid = am.member
      where am.roleid = 'patient_merge_writer'::regrole), 'postgres');
  perform pg_temp.expect('s1.3 no runtime role can assume the writer',
    pg_has_role('authenticator', 'patient_merge_writer', 'member')::text || pg_has_role('service_role', 'patient_merge_writer', 'member')::text
    || pg_has_role('authenticated', 'patient_merge_writer', 'member')::text || pg_has_role('anon', 'patient_merge_writer', 'member')::text,
    'falsefalsefalsefalse');
  perform pg_temp.expect('s1.4 both functions: owner, definer, pinned search_path',
    (select string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' ||
                       array_to_string(p.proconfig, ';'), ',' order by p.proname)
       from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('merge_patients_guarded', 'undo_patient_merge_guarded')),
    'merge_patients_guarded:patient_merge_writer:true:search_path=pg_catalog, public, pg_temp,'
    || 'undo_patient_merge_guarded:patient_merge_writer:true:search_path=pg_catalog, public, pg_temp');
  perform pg_temp.expect('s1.5 writer may call exactly the helpers it needs',
    has_function_privilege('patient_merge_writer', 'public.lifecycle_lock(uuid[], boolean)', 'execute')::text
    || has_function_privilege('patient_merge_writer', 'public.lifecycle_lock_results(uuid[], boolean)', 'execute')::text
    || has_function_privilege('patient_merge_writer', 'public.recompute_patient_consent_cache(uuid)', 'execute')::text
    || has_function_privilege('patient_merge_writer', 'public.lifecycle_lock_and_assert(uuid[], boolean)', 'execute')::text,
    'truetruetruefalse');
  perform pg_temp.expect('s1.6 runtime roles cannot call the consent helper',
    has_function_privilege('service_role', 'public.recompute_patient_consent_cache(uuid)', 'execute')::text
    || has_function_privilege('authenticated', 'public.recompute_patient_consent_cache(uuid)', 'execute')::text
    || has_function_privilege('anon', 'public.recompute_patient_consent_cache(uuid)', 'execute')::text,
    'falsefalsefalse');
  perform pg_temp.expect('s1.7 writer has no CREATE on public',
    has_schema_privilege('patient_merge_writer', 'public', 'create')::text, 'false');
  perform pg_temp.expect('s1.8 ledger columns + live-source index',
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'patient_merges'
      and column_name in ('snapshot_version', 'fill_snapshot', 'rechained', 'context', 'undo_report'))::text || '|' ||
    (select count(*) from pg_indexes where indexname = 'uq_patient_merges_live_source')::text, '5|1');
  perform pg_temp.expect('s1.9 rollback guard trigger enabled',
    (select tgenabled::text from pg_trigger where tgname = 'trg_patients_live_merge_guard'), 'O');
  perform pg_temp.expect('s1.11 0202 still holds: merge-ledger/consent policies name only the writer; anon/authenticated hold nothing',
    ((select bool_and(p.polroles = array['patient_merge_writer'::regrole::oid])
        from pg_policy p where p.polrelid in ('public.patient_merges'::regclass, 'public.patient_consents'::regclass))
     and not has_table_privilege('anon', 'public.patient_merges', 'SELECT')
     and not has_table_privilege('authenticated', 'public.patient_merges', 'SELECT')
     and not has_table_privilege('anon', 'public.patient_consents', 'SELECT')
     and not has_table_privilege('authenticated', 'public.patient_consents', 'SELECT'))::text, 'true');
  perform pg_temp.expect('s1.10 writer cannot change deletion columns (0167 guard)',
    pg_temp.state_as('patient_merge_writer', format(
      'update public.patients set deleted_at = now() where id = %L', pg_temp.mk_patient('S1D'))), '42501');
end
$s1$;
```
(s1.10 is `42501` because the writer has no column privilege on `deleted_at` at all — it never reaches the trigger. If Postgres reports `P0057` instead, the column grant is too broad: fix the grant, not the test.)

- [ ] **Step 2: Append sections 8–9 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- (8) Ownership + ACLs. PG17: the new owner needs CREATE on the schema at
-- transfer time — granted for these two statements only.
-- ---------------------------------------------------------------------------
grant create on schema public to patient_merge_writer;
alter function public.merge_patients_guarded(uuid, uuid, uuid, jsonb) owner to patient_merge_writer;
alter function public.undo_patient_merge_guarded(uuid, uuid, jsonb) owner to patient_merge_writer;
revoke create on schema public from patient_merge_writer;

revoke all on function public.merge_patients_guarded(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.undo_patient_merge_guarded(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_patients_guarded(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.undo_patient_merge_guarded(uuid, uuid, jsonb) to service_role;

-- 0184 revoked EXECUTE on its helpers from every role; a role granted TO
-- postgres does not inherit postgres's rights, so the writer needs its own.
grant execute on function public.lifecycle_lock(uuid[], boolean) to patient_merge_writer;
grant execute on function public.lifecycle_lock_results(uuid[], boolean) to patient_merge_writer;

-- ---------------------------------------------------------------------------
-- (9) Post-conditions. A failure aborts the push; nothing is half-applied.
-- ---------------------------------------------------------------------------
do $assert$
declare
  n int;
begin
  if exists (select 1 from pg_roles where rolname = 'patient_merge_writer'
               and (rolcanlogin or rolinherit or rolbypassrls or rolsuper)) then
    raise exception '0196: patient_merge_writer must be NOLOGIN NOINHERIT NOBYPASSRLS';
  end if;
  if exists (select 1 from pg_auth_members am join pg_roles r on r.oid = am.member
              where am.roleid = 'patient_merge_writer'::regrole and r.rolname <> 'postgres') then
    raise exception '0196: patient_merge_writer is granted to a role other than postgres';
  end if;
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('merge_patients_guarded', 'undo_patient_merge_guarded')
                and (pg_get_userbyid(p.proowner) <> 'patient_merge_writer' or not p.prosecdef)) then
    raise exception '0196: merge functions must be SECURITY DEFINER owned by patient_merge_writer';
  end if;
  if has_function_privilege('anon', 'public.merge_patients_guarded(uuid, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.merge_patients_guarded(uuid, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.undo_patient_merge_guarded(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.undo_patient_merge_guarded(uuid, uuid, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.merge_patients_guarded(uuid, uuid, uuid, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.undo_patient_merge_guarded(uuid, uuid, jsonb)', 'execute') then
    raise exception '0196: merge functions must be EXECUTE service_role only';
  end if;
  if has_schema_privilege('patient_merge_writer', 'public', 'create') then
    raise exception '0196: patient_merge_writer kept CREATE on public';
  end if;
  if not has_function_privilege('patient_merge_writer', 'public.lifecycle_lock(uuid[], boolean)', 'execute')
     or not has_function_privilege('patient_merge_writer', 'public.lifecycle_lock_results(uuid[], boolean)', 'execute')
     or not has_function_privilege('patient_merge_writer', 'public.recompute_patient_consent_cache(uuid)', 'execute') then
    raise exception '0196: patient_merge_writer is missing a helper EXECUTE grant';
  end if;
  if has_function_privilege('service_role', 'public.recompute_patient_consent_cache(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.recompute_patient_consent_cache(uuid)', 'execute')
     or has_function_privilege('anon', 'public.recompute_patient_consent_cache(uuid)', 'execute') then
    raise exception '0196: recompute_patient_consent_cache must not be callable by runtime roles';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_patients_live_merge_guard' and tgenabled = 'O') then
    raise exception '0196: trg_patients_live_merge_guard missing or disabled';
  end if;

  -- The consent fold must reproduce every patient's cached state (spec R4):
  -- if it did not, re-running it on a merge would silently rewrite consent.
  with recursive ev as (
    select c.patient_id, c.event_type, c.consent_scope, c.created_at, c.method, c.notice_version,
           row_number() over (partition by c.patient_id order by c.seq) as rn
      from public.patient_consents c
  ), f as (
    select p.id as pid, 0::bigint as rn, false as cur, null::timestamptz as signed,
           null::timestamptz as wd, null::text as meth, null::text as nv
      from public.patients p
    union all
    select f.pid, e.rn,
           (e.event_type = 'granted' and e.consent_scope = 'full'),
           case when e.event_type = 'granted' and e.consent_scope = 'full' then e.created_at
                when e.event_type = 'granted' then null else f.signed end,
           case when e.event_type = 'granted' then null else e.created_at end,
           case when e.event_type = 'granted' and e.consent_scope = 'full' then e.method
                when e.event_type = 'granted' then null else f.meth end,
           case when e.event_type = 'granted' and e.consent_scope = 'full' then e.notice_version
                when e.event_type = 'granted' then null else f.nv end
      from f join ev e on e.patient_id = f.pid and e.rn = f.rn + 1
  ), last as (
    select distinct on (pid) * from f order by pid, rn desc
  )
  select count(*) into n
    from last l join public.patients p on p.id = l.pid
   where (l.cur, l.signed, l.wd, l.meth, l.nv)
         is distinct from (p.consent_current, p.consent_signed_at, p.consent_withdrawn_at,
                           p.consent_method, p.consent_notice_version);
  if n > 0 then
    raise exception '0196: % patient(s) have a consent cache that differs from their event history', n;
  end if;
end
$assert$;

reset lock_timeout;
```

- [ ] **Step 3: Apply, then run the WHOLE smoke** — this is the first run where both functions execute as `patient_merge_writer` (NOBYPASSRLS, only its own grants), so any missing privilege or policy fails here.

```bash
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0196_patient_merge_atomic.sql > /tmp/0196.log 2>&1; echo exit=$?
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/0196_patient_merge_atomic_smoke.sql > /tmp/0196-smoke.log 2>&1; echo exit=$?
grep -c " OK" /tmp/0196-smoke.log; grep -E "FAILED|ERROR" /tmp/0196-smoke.log | head
```
Expected: both `exit=0`, no `FAILED`/`ERROR`. A `permission denied for table|column|function …` or `new row violates row-level security policy` here means a grant or policy is missing from section 3/8 — add exactly that grant (never widen to a blanket grant), re-apply, re-run. Record every addition in the controller notes.

- [ ] **Step 4: Real `authenticator` login cannot assume the role** (out-of-band proof; the smoke's `pg_has_role` checks cannot prove it because the smoke connects as postgres)

```bash
docker exec -e PGPASSWORD=postgres supabase_db_DRMed psql -h 127.0.0.1 -U authenticator -d postgres \
  -c "set role service_role; set role patient_merge_writer;" 2>&1 | tail -2
```
Expected: `ERROR:  permission denied to set role "patient_merge_writer"`. Paste the output into the controller notes.

- [ ] **Step 5: `npx vitest run src/lib/patients/merge-migration.test.ts`** — Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0196_patient_merge_atomic.sql supabase/tests/0196_patient_merge_atomic_smoke.sql
git commit -m "feat(db): 0196 ownership, ACLs and post-conditions; smoke s1 under the real owner

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7 (controller): Opus SQL review gate.** Dispatch an **Opus** reviewer over `git diff origin/main -- supabase/` with the spec, the parent spec's "PR 3 revision" section and 0184's lock helpers as context. Focus: lock order vs every 0184 writer, deadlock/P0072 paths, privilege minimality, split-result and dependent-row logic, legacy/resume branches, anything the smoke does not exercise. Fix every Critical/Important finding (with a smoke assertion that fails before the fix) before Task 6.

---

### Task 6: Regenerate DB types (our hunks only)

**Files:** Modify `src/types/database.ts`

- [ ] **Step 1:** `npm run db:types` — the local stack is shared, so the generated file may also contain other sessions' in-flight objects.
- [ ] **Step 2:** `git diff --stat src/types/database.ts && git diff src/types/database.ts | grep '^[+-] ' | head -80`. Keep ONLY hunks for: `patient_merges` (new columns `context`, `fill_snapshot`, `rechained`, `snapshot_version`, `undo_report` in Row/Insert/Update), `merge_patients_guarded`, `undo_patient_merge_guarded`, `recompute_patient_consent_cache`, `patient_has_live_v2_merge`. Revert every other hunk with `git checkout -p src/types/database.ts` (answer `n` to keep, `y` to discard) — hunks for objects from 0193/0195 or other branches must not ride along.
- [ ] **Step 3:** `npm run typecheck` — Expected: PASS.
- [ ] **Step 4: Commit** — `git add src/types/database.ts && git commit -m "chore(types): 0196 merge functions and ledger columns" …` (with the Co-Authored-By trailer).

---

### Task 7: Error translations P0078–P0080

**Files:** Modify `src/lib/accounting/pg-errors.ts` (after the `P0077` case, before `default:`)

- [ ] **Step 1: Run the coverage test first** — `npx vitest run src/lib/accounting/pg-error-coverage.test.ts`. Expected: FAIL naming P0078, P0079, P0080 (raised in 0196 with no translation).

- [ ] **Step 2: Add the cases**

```ts
    // 0196 merge_patients_guarded / undo_patient_merge_guarded: the actor is
    // not an active admin.
    case "P0078":
      return "Only an active admin can merge patient records or undo a merge.";
    // 0196: the merge or undo was refused. The SQL words each reason for an
    // admin (already undone, past 30 days, the kept record merged or deleted
    // since, a result now combining tests from both records…) — pass it
    // through, like P0073.
    case "P0079":
      return err.message
        ? `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}.`
        : "This merge can't be done or undone right now. Refresh and try again.";
    // 0196 (live version-2 merges) / 0197 (every merge): the merge marker
    // changed outside merge_patients_guarded / undo_patient_merge_guarded.
    case "P0080":
      return "Patient records can only be merged or un-merged from Admin Tools › Merge Duplicate Patients.";
```

- [ ] **Step 3:** `npx vitest run src/lib/accounting/` — Expected: PASS.
- [ ] **Step 4: Commit** — `git add src/lib/accounting/pg-errors.ts && git commit -m "feat(errors): translate P0078–P0080 (patient merge)" …`.

---
### Task 8: Pure result parsing + undoability rules (`merge-result.ts`)

**Files:**
- Create: `src/lib/patients/merge-result.ts`
- Create: `src/lib/patients/merge-result.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/patients/merge-result.test.ts
import { describe, expect, it } from "vitest";
import {
  fieldList,
  movedSummary,
  parseMergeRpcResult,
  parseUndoRpcResult,
  undoableState,
  undoReportLines,
  type UndoReport,
} from "./merge-result";

const ZERO = { visits: 0, appointments: 0, audit_log: 0, critical_alerts: 0, patient_consents: 0, appointment_attachments: 0 };
const EMPTY_LEFT = { visits: [], appointments: [], audit_log: [], critical_alerts: [], patient_consents: [], appointment_attachments: [] };
const K = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const DAY = 86_400_000;

describe("parseMergeRpcResult", () => {
  it("parses the function's jsonb", () => {
    const r = parseMergeRpcResult({
      merge_id: "m1", keep_id: K, source_id: S, kept_drm_id: "DRM-0001", merged_drm_id: "DRM-0002",
      moved: { ...ZERO, visits: 2 }, filled: ["phone"], rechained: 1,
    });
    expect(r).toEqual({
      mergeId: "m1", keepId: K, sourceId: S, keptDrmId: "DRM-0001", mergedDrmId: "DRM-0002",
      moved: { ...ZERO, visits: 2 }, filled: ["phone"], rechained: 1,
    });
  });
  it.each([null, "x", {}, { merge_id: "m1" }, { merge_id: "m1", keep_id: K, source_id: S, kept_drm_id: "a", merged_drm_id: "b", moved: { visits: "2" }, filled: [], rechained: 0 }])(
    "rejects malformed input %#",
    (bad) => expect(parseMergeRpcResult(bad)).toBeNull(),
  );
});

describe("parseUndoRpcResult", () => {
  it("parses the undo report", () => {
    const r = parseUndoRpcResult({
      merge_id: "m1", keep_id: K, source_id: S, kept_drm_id: "DRM-0001", source_drm_id: "DRM-0002",
      resumed_interrupted_undo: false, moved_back: { ...ZERO, visits: 1 },
      left_on_keep: { ...EMPTY_LEFT, critical_alerts: ["a1"] }, kept_fields: ["phone"], reverted_fields: ["email"],
      rechained_back: 0,
    });
    expect(r?.leftOnKeep.critical_alerts).toEqual(["a1"]);
    expect(r?.keptFields).toEqual(["phone"]);
    expect(r?.movedBack.visits).toBe(1);
  });
  it("rejects a report missing left_on_keep", () => {
    expect(parseUndoRpcResult({ merge_id: "m1" })).toBeNull();
  });
});

describe("movedSummary / fieldList", () => {
  it("skips zeros and pluralises", () => {
    expect(movedSummary({ ...ZERO, visits: 2, appointments: 1 })).toBe("2 visits, 1 appointment");
    expect(movedSummary(ZERO)).toBe("nothing");
  });
  it("joins field labels in plain words", () => {
    expect(fieldList(["phone"])).toBe("phone");
    expect(fieldList(["phone", "email", "middle_name"])).toBe("phone, email and middle name");
  });
});

describe("undoReportLines", () => {
  const base: UndoReport = {
    mergeId: "m1", keepId: K, sourceId: S, keptDrmId: "DRM-0001", sourceDrmId: "DRM-0002",
    resumedInterruptedUndo: false, movedBack: { ...ZERO, visits: 2 }, leftOnKeep: EMPTY_LEFT,
    keptFields: [], revertedFields: ["email"], rechainedBack: 0,
  };
  it("plain undo", () => {
    expect(undoReportLines(base)).toEqual(["Moved back to DRM-0002: 2 visits."]);
  });
  it("kept fields, rows left on keep, chain", () => {
    expect(
      undoReportLines({ ...base, keptFields: ["phone"], leftOnKeep: { ...EMPTY_LEFT, visits: ["v1"] }, rechainedBack: 1 }),
    ).toEqual([
      "Moved back to DRM-0002: 2 visits.",
      "Kept on DRM-0001 because they were edited after the merge: phone.",
      "1 record stayed on DRM-0001 because it changed after the merge.",
      "1 older merged record points at DRM-0002 again.",
    ]);
  });
  it("resumed interrupted undo", () => {
    expect(undoReportLines({ ...base, resumedInterruptedUndo: true, keptFields: ["phone"] })).toEqual([
      "Moved back to DRM-0002: 2 visits.",
      "This finished an earlier undo that had stopped part-way.",
      "Not reverted — the earlier undo was interrupted, so check by hand: phone.",
    ]);
  });
});

describe("undoableState", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const row = (over: Partial<Parameters<typeof undoableState>[0]> = {}) => ({
    keepId: K, legacy: false, mergedAt: new Date(now - DAY).toISOString(),
    keep: { merged_into_id: null, deleted_at: null }, source: { merged_into_id: K, deleted_at: null }, ...over,
  });
  it("undoable", () => expect(undoableState(row(), now)).toEqual({ undoable: true, interrupted: false, reason: null }));
  it("exactly 30 days is past the window", () =>
    expect(undoableState(row({ mergedAt: new Date(now - 30 * DAY).toISOString() }), now).undoable).toBe(false));
  it("keep merged elsewhere", () =>
    expect(undoableState(row({ keep: { merged_into_id: "x", deleted_at: null } }), now).reason).toMatch(/undo that merge first/));
  it("keep deleted", () =>
    expect(undoableState(row({ keep: { merged_into_id: null, deleted_at: "2026-09-30" } }), now).reason).toMatch(/restore it first/));
  it("source deleted", () =>
    expect(undoableState(row({ source: { merged_into_id: null, deleted_at: "2026-09-30" } }), now).reason).toMatch(/merged-in record has since been deleted/));
  it("legacy row with an interrupted undo stays undoable", () =>
    expect(undoableState(row({ legacy: true, source: { merged_into_id: null, deleted_at: null } }), now)).toEqual({
      undoable: true, interrupted: true, reason: null,
    }));
  it("v2 row whose source is no longer the tombstone", () =>
    expect(undoableState(row({ source: { merged_into_id: null, deleted_at: null } }), now).undoable).toBe(false));
  it("missing records", () => expect(undoableState(row({ keep: null }), now).undoable).toBe(false));
});
```

- [ ] **Step 2:** `npx vitest run src/lib/patients/merge-result.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/patients/merge-result.ts
// Pure helpers around the 0196 merge functions: parse their jsonb results,
// word them for an admin, and decide whether a ledger row can be undone.
// undoableState mirrors undo_patient_merge_guarded's own refusals so the
// page can grey out Undo with the same reason — the SQL stays authoritative.
import {
  MERGE_FILL_LABELS,
  MERGE_MOVED_LABELS,
  MERGE_MOVED_TABLES,
  MERGE_UNDO_WINDOW_DAYS,
  isMergeFillField,
  type MergeMovedTable,
} from "./merge-fields";

export type MovedCounts = Record<MergeMovedTable, number>;

export interface MergeSummary {
  mergeId: string;
  keepId: string;
  sourceId: string;
  keptDrmId: string;
  mergedDrmId: string;
  moved: MovedCounts;
  filled: string[];
  rechained: number;
}

export interface UndoReport {
  mergeId: string;
  keepId: string;
  sourceId: string;
  keptDrmId: string;
  sourceDrmId: string;
  resumedInterruptedUndo: boolean;
  movedBack: MovedCounts;
  leftOnKeep: Record<MergeMovedTable, string[]>;
  keptFields: string[];
  revertedFields: string[];
  rechainedBack: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function strArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number") ? v.map(String) : null;
}
function counts(v: unknown): MovedCounts | null {
  if (!isObj(v)) return null;
  const out = {} as MovedCounts;
  for (const t of MERGE_MOVED_TABLES) {
    const n = v[t];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    out[t] = n;
  }
  return out;
}

export function parseMergeRpcResult(data: unknown): MergeSummary | null {
  if (!isObj(data)) return null;
  const mergeId = str(data.merge_id);
  const keepId = str(data.keep_id);
  const sourceId = str(data.source_id);
  const keptDrmId = str(data.kept_drm_id);
  const mergedDrmId = str(data.merged_drm_id);
  const moved = counts(data.moved);
  const filled = strArray(data.filled);
  const rechained = typeof data.rechained === "number" ? data.rechained : null;
  if (!mergeId || !keepId || !sourceId || !keptDrmId || !mergedDrmId || !moved || !filled || rechained === null) return null;
  return { mergeId, keepId, sourceId, keptDrmId, mergedDrmId, moved, filled, rechained };
}

export function parseUndoRpcResult(data: unknown): UndoReport | null {
  if (!isObj(data) || !isObj(data.left_on_keep)) return null;
  const leftOnKeep = {} as Record<MergeMovedTable, string[]>;
  for (const t of MERGE_MOVED_TABLES) {
    const ids = strArray(data.left_on_keep[t]);
    if (!ids) return null;
    leftOnKeep[t] = ids;
  }
  const mergeId = str(data.merge_id);
  const keepId = str(data.keep_id);
  const sourceId = str(data.source_id);
  const keptDrmId = str(data.kept_drm_id);
  const sourceDrmId = str(data.source_drm_id);
  const movedBack = counts(data.moved_back);
  const keptFields = strArray(data.kept_fields);
  const revertedFields = strArray(data.reverted_fields);
  const rechainedBack = typeof data.rechained_back === "number" ? data.rechained_back : null;
  if (!mergeId || !keepId || !sourceId || !keptDrmId || !sourceDrmId || !movedBack || !keptFields || !revertedFields
      || rechainedBack === null || typeof data.resumed_interrupted_undo !== "boolean") {
    return null;
  }
  return {
    mergeId, keepId, sourceId, keptDrmId, sourceDrmId,
    resumedInterruptedUndo: data.resumed_interrupted_undo,
    movedBack, leftOnKeep, keptFields, revertedFields, rechainedBack,
  };
}

export function movedSummary(moved: MovedCounts): string {
  const parts = MERGE_MOVED_TABLES.filter((t) => moved[t] > 0).map(
    (t) => `${moved[t]} ${moved[t] === 1 ? MERGE_MOVED_LABELS[t].one : MERGE_MOVED_LABELS[t].many}`,
  );
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

export function fieldList(fields: string[]): string {
  const words = fields.map((f) => (isMergeFillField(f) ? MERGE_FILL_LABELS[f] : f));
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function undoReportLines(r: UndoReport): string[] {
  const lines = [`Moved back to ${r.sourceDrmId}: ${movedSummary(r.movedBack)}.`];
  if (r.resumedInterruptedUndo) lines.push("This finished an earlier undo that had stopped part-way.");
  if (r.keptFields.length > 0) {
    lines.push(
      r.resumedInterruptedUndo
        ? `Not reverted — the earlier undo was interrupted, so check by hand: ${fieldList(r.keptFields)}.`
        : `Kept on ${r.keptDrmId} because they were edited after the merge: ${fieldList(r.keptFields)}.`,
    );
  }
  const left = MERGE_MOVED_TABLES.reduce((n, t) => n + r.leftOnKeep[t].length, 0);
  if (left > 0) {
    lines.push(
      left === 1
        ? `1 record stayed on ${r.keptDrmId} because it changed after the merge.`
        : `${left} records stayed on ${r.keptDrmId} because they changed after the merge.`,
    );
  }
  if (r.rechainedBack > 0) {
    lines.push(
      r.rechainedBack === 1
        ? `1 older merged record points at ${r.sourceDrmId} again.`
        : `${r.rechainedBack} older merged records point at ${r.sourceDrmId} again.`,
    );
  }
  return lines;
}

interface LifecycleCols {
  merged_into_id: string | null;
  deleted_at: string | null;
}

export function undoableState(
  row: { keepId: string; legacy: boolean; mergedAt: string; keep: LifecycleCols | null; source: LifecycleCols | null },
  nowMs: number,
): { undoable: boolean; interrupted: boolean; reason: string | null } {
  const no = (reason: string) => ({ undoable: false, interrupted: false, reason });
  if (nowMs - Date.parse(row.mergedAt) >= MERGE_UNDO_WINDOW_DAYS * 86_400_000) {
    return no(`Past the ${MERGE_UNDO_WINDOW_DAYS}-day undo window.`);
  }
  if (!row.keep || !row.source) return no("One of the two records could not be found.");
  if (row.keep.merged_into_id) {
    return no("The kept record has since been merged into another record — undo that merge first.");
  }
  if (row.keep.deleted_at) return no("The kept record has since been deleted — restore it first.");
  if (row.source.deleted_at) return no("The merged-in record has since been deleted — restore it first.");
  if (row.source.merged_into_id === row.keepId) return { undoable: true, interrupted: false, reason: null };
  if (row.source.merged_into_id === null && row.legacy) return { undoable: true, interrupted: true, reason: null };
  return no("The merged-in record is no longer merged into the kept record.");
}
```

- [ ] **Step 4:** `npx vitest run src/lib/patients/merge-result.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/lib/patients/merge-result.ts src/lib/patients/merge-result.test.ts && git commit -m "feat(patients): pure merge/undo result parsing and undoability rules" …`.

---

### Task 9: Server actions become thin RPC callers

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.merge.test.ts`
- Delete: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.rollback.test.ts`

- [ ] **Step 1: Write the failing wiring test**

```ts
// src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.merge.test.ts
// Wiring only: the merge and undo themselves are proven in SQL
// (supabase/tests/0196_patient_merge_atomic_smoke.sql, scripts/merge-concurrency-proof.ts).
// Pins that the actions send the right RPC arguments, retry once on a lock
// race, translate refusals, never touch a table directly, and record the
// notice email in its own audit row.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const K = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";

const fx = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: [] as { data: unknown; error: { code?: string; message: string } | null }[],
  fromCalls: [] as string[],
  audits: [] as Record<string, unknown>[],
  emails: [] as Record<string, unknown>[],
  recipient: { kind: "active", patient: { email: "ana@example.com" } } as Record<string, unknown>,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: "203.0.113.9", ua: "vitest" }) }));
vi.mock("@/lib/auth/require-admin", () => ({
  requireAdminStaff: async () => ({ user_id: "admin-1", email: "", full_name: "Admin", role: "admin" }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));
vi.mock("@/lib/notifications/email", () => ({
  sendEmail: async (e: Record<string, unknown>) => {
    fx.emails.push(e);
    return { ok: true, id: "email-1" };
  },
}));
vi.mock("@/lib/notifications/active-patient-recipient", () => ({ checkPatientRecipient: async () => fx.recipient }));
vi.mock("@/lib/notifications/inactive-recipient-audit", () => ({ auditSkippedInactiveRecipient: async () => {} }));
vi.mock("@/lib/notifications/branded-email", () => ({
  renderEmailShell: () => "", emailParagraph: () => "", emailHighlight: () => "", escapeHtml: (s: string) => s,
}));
vi.mock("@/lib/patients/active", () => ({ activePatients: (q: unknown) => q }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      fx.rpcCalls.push({ fn, args });
      return fx.rpcResults.shift() ?? { data: null, error: { message: "no scripted result" } };
    },
    from: (table: string) => {
      fx.fromCalls.push(table);
      // Only the notice email's first-name read may touch a table.
      const q = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: { first_name: "Ana" }, error: null }),
      };
      return q;
    },
  }),
}));

import { mergePatientsAction, undoMergeAction } from "./actions";

const MERGED = {
  merge_id: M, keep_id: K, source_id: S, kept_drm_id: "DRM-0001", merged_drm_id: "DRM-0002",
  moved: { visits: 2, appointments: 1, audit_log: 3, critical_alerts: 0, patient_consents: 1, appointment_attachments: 0 },
  filled: ["phone"], rechained: 0,
};

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  fx.rpcCalls = []; fx.rpcResults = []; fx.fromCalls = []; fx.audits = []; fx.emails = [];
  fx.recipient = { kind: "active", patient: { email: "ana@example.com" } };
});

describe("mergePatientsAction", () => {
  it("calls merge_patients_guarded once with actor + context and returns the summary", async () => {
    fx.rpcResults.push({ data: MERGED, error: null });
    const res = await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(fx.rpcCalls).toEqual([{
      fn: "merge_patients_guarded",
      args: { p_keep: K, p_source: S, p_actor: "admin-1", p_context: { ip: "203.0.113.9", user_agent: "vitest", source: "admin" } },
    }]);
    expect(res).toMatchObject({ ok: true, kept_drm_id: "DRM-0001", merged_drm_id: "DRM-0002", filled: ["phone"], rechained: 0 });
    expect(fx.fromCalls.filter((t) => t !== "patients")).toEqual([]);
  });

  it("marks a candidates-page merge with source=candidates", async () => {
    fx.rpcResults.push({ data: MERGED, error: null });
    await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE", origin: "candidates" }));
    expect((fx.rpcCalls[0]!.args.p_context as Record<string, unknown>).source).toBe("candidates");
  });

  it("retries exactly once on a lock race (P0072), then succeeds", async () => {
    fx.rpcResults.push({ data: null, error: { code: "P0072", message: "changed" } }, { data: MERGED, error: null });
    const res = await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(fx.rpcCalls).toHaveLength(2);
    expect(res.ok).toBe(true);
  });

  it("translates a refusal and sends nothing", async () => {
    fx.rpcResults.push({ data: null, error: { code: "P0058", message: "DRM-0002 is deleted — restore it first" } });
    const res = await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(res).toEqual({ ok: false, error: "DRM-0002 is deleted — restore it first" });
    expect(fx.emails).toEqual([]);
    expect(fx.audits).toEqual([]);
  });

  it("refuses without calling the database when the confirmation or pair is wrong", async () => {
    expect((await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "merge" }))).ok).toBe(false);
    expect((await mergePatientsAction(null, form({ keep_id: K, source_id: K, confirm: "MERGE" }))).ok).toBe(false);
    expect(fx.rpcCalls).toEqual([]);
  });

  it("emails the kept record and records the notice in its own audit row", async () => {
    fx.rpcResults.push({ data: MERGED, error: null });
    await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(fx.emails).toHaveLength(1);
    expect(fx.emails[0]!.to).toBe("ana@example.com");
    expect(fx.audits).toEqual([expect.objectContaining({
      action: "patient.merge.notified", patient_id: K, resource_id: K, actor_id: "admin-1",
      metadata: expect.objectContaining({ merge_id: M, recipient: "active" }),
    })]);
  });

  it("does not email an inactive kept record but still audits the skip", async () => {
    fx.recipient = { kind: "inactive", reason: "deleted" };
    fx.rpcResults.push({ data: MERGED, error: null });
    await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(fx.emails).toEqual([]);
    expect(fx.audits[0]).toMatchObject({ action: "patient.merge.notified", metadata: expect.objectContaining({ recipient: "inactive" }) });
  });
});

describe("undoMergeAction", () => {
  const REPORT = {
    merge_id: M, keep_id: K, source_id: S, kept_drm_id: "DRM-0001", source_drm_id: "DRM-0002",
    resumed_interrupted_undo: false,
    moved_back: { visits: 2, appointments: 0, audit_log: 0, critical_alerts: 0, patient_consents: 0, appointment_attachments: 0 },
    left_on_keep: { visits: [], appointments: [], audit_log: [], critical_alerts: [], patient_consents: [], appointment_attachments: [] },
    kept_fields: ["phone"], reverted_fields: [], rechained_back: 0,
  };

  it("calls undo_patient_merge_guarded and returns the plain-language report", async () => {
    fx.rpcResults.push({ data: REPORT, error: null });
    const res = await undoMergeAction(null, form({ merge_id: M }));
    expect(fx.rpcCalls).toEqual([{
      fn: "undo_patient_merge_guarded",
      args: { p_merge_id: M, p_actor: "admin-1", p_context: { ip: "203.0.113.9", user_agent: "vitest" } },
    }]);
    expect(res).toEqual({
      ok: true,
      lines: ["Moved back to DRM-0002: 2 visits.", "Kept on DRM-0001 because they were edited after the merge: phone."],
    });
    expect(fx.fromCalls).toEqual([]);
  });

  it("translates a refusal (P0079 passes the SQL's words through)", async () => {
    fx.rpcResults.push({ data: null, error: { code: "P0079", message: "merges can only be undone within 30 days" } });
    expect(await undoMergeAction(null, form({ merge_id: M }))).toEqual({
      ok: false, error: "Merges can only be undone within 30 days.",
    });
  });

  it("rejects a malformed id without calling the database", async () => {
    expect((await undoMergeAction(null, form({ merge_id: "nope" }))).ok).toBe(false);
    expect(fx.rpcCalls).toEqual([]);
  });
});
```

- [ ] **Step 2:** `npx vitest run "src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.merge.test.ts"` — Expected: FAIL (the current action calls `.from(...)` on every table, has no `filled`, and `undoMergeAction` returns `{ ok: true }`).

- [ ] **Step 3: Rewrite `actions.ts`.** Keep `LookupResult`, `PatientPreview`, `LookupSchema`, `previewByDrmId` and `lookupPatientForMergeAction` **exactly as they are** (lines 1–146 today, minus the imports this step replaces). Replace everything from the `MergeResult` type through the end of the file, and the import block, with:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { activePatients } from "@/lib/patients/active";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { MERGE_UNDO_WINDOW_DAYS, RECENT_MERGES_PAGE_SIZE } from "@/lib/patients/merge-fields";
import {
  parseMergeRpcResult,
  parseUndoRpcResult,
  undoableState,
  undoReportLines,
  type MovedCounts,
} from "@/lib/patients/merge-result";
import { sendEmail } from "@/lib/notifications/email";
import { checkPatientRecipient } from "@/lib/notifications/active-patient-recipient";
import { auditSkippedInactiveRecipient } from "@/lib/notifications/inactive-recipient-audit";
import {
  renderEmailShell,
  emailParagraph,
  emailHighlight,
  escapeHtml,
} from "@/lib/notifications/branded-email";

// … LookupResult, PatientPreview, LookupSchema, previewByDrmId,
//   lookupPatientForMergeAction unchanged …

export type MergeResult =
  | {
      ok: true;
      merge_id: string;
      kept_drm_id: string;
      merged_drm_id: string;
      moved: MovedCounts;
      filled: string[];
      rechained: number;
    }
  | { ok: false; error: string };

const MergeSchema = z.object({
  keep_id: z.string().uuid(),
  source_id: z.string().uuid(),
  confirm: z.literal("MERGE", { message: "Type MERGE to confirm." }),
});

// The whole merge — every move, the fill, chain flattening, the tombstone,
// the undo ledger and the patient.merged audit row — is ONE transaction in
// merge_patients_guarded (0196). Nothing to roll back here: a refusal or a
// failure changed nothing. A lock race (P0072/40P01/40001) rolled back whole,
// so one retry is safe (withLifecycleRetry).
export async function mergePatientsAction(
  _prev: MergeResult | null,
  formData: FormData,
): Promise<MergeResult> {
  const session = await requireAdminStaff();
  const parsed = MergeSchema.safeParse({
    keep_id: formData.get("keep_id"),
    source_id: formData.get("source_id"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const { keep_id, source_id } = parsed.data;
  if (keep_id === source_id) return { ok: false, error: "Pick two different patients." };
  const origin = formData.get("origin") === "candidates" ? "candidates" : "admin";

  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();
  const { data, error } = await withLifecycleRetry(() =>
    admin.rpc("merge_patients_guarded", {
      p_keep: keep_id,
      p_source: source_id,
      p_actor: session.user_id,
      p_context: { ip, user_agent: ua, source: origin },
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };
  const merged = parseMergeRpcResult(data);
  if (!merged) {
    await reportError({ scope: "mergePatientsAction:result", error: new Error("unparseable merge result"), metadata: { keep_id, source_id } });
    return { ok: false, error: "The records were merged, but the result could not be read. Refresh the page." };
  }

  await notifyKeptPatient(admin, merged.mergeId, keep_id, merged.keptDrmId, session.user_id, ip, ua);

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/admin/patient-merge/candidates");
  revalidatePath("/staff/patients");
  return {
    ok: true,
    merge_id: merged.mergeId,
    kept_drm_id: merged.keptDrmId,
    merged_drm_id: merged.mergedDrmId,
    moved: merged.moved,
    filled: merged.filled,
    rechained: merged.rechained,
  };
}

// M2: tell the kept patient their records were combined. Runs AFTER the merge
// committed, so its outcome gets its own audit row (the patient.merged row
// was written inside the transaction, before any email existed). Fresh
// recipient check (0167): the kept record must still be active, and its
// on-file email — already carrying any merge fill — is the address of record.
async function notifyKeptPatient(
  admin: ReturnType<typeof createAdminClient>,
  mergeId: string,
  keepId: string,
  keptDrmId: string,
  actorId: string,
  ip: string | null,
  ua: string | null,
): Promise<void> {
  const recipient = await checkPatientRecipient(admin, keepId);
  if (recipient.kind === "inactive") {
    await auditSkippedInactiveRecipient({
      sender: "patient-merge",
      patientId: keepId,
      reason: recipient.reason,
      resourceType: "patient",
      resourceId: keepId,
    });
  }
  const to = recipient.kind === "active" ? (recipient.patient.email ?? null) : null;
  let firstName = "there";
  if (to) {
    // History read (never filtered): the name on the record we just merged into.
    const { data: row } = await admin.from("patients").select("first_name").eq("id", keepId).maybeSingle();
    if (row?.first_name) firstName = row.first_name;
  }
  const email = to
    ? await sendEmail({
        to,
        subject: "Your DRMed records were combined",
        text: `Hi ${firstName},\n\nWe combined two DRMed records that belonged to you into one. From now on, use this DRM-ID: ${keptDrmId}, together with the Secure PIN printed on your most recent receipt, to view your results online.\n\n— DRMed Clinic and Laboratory`,
        html: renderEmailShell({
          heading: "Your DRMed patient ID",
          contentHtml:
            emailParagraph(`Hi <b>${escapeHtml(firstName)}</b>,`) +
            emailParagraph("We combined two DRMed records that belonged to you into one. From now on, use this patient ID:") +
            emailHighlight("Your DRM-ID", keptDrmId) +
            emailParagraph("Sign in with the Secure PIN printed on your most recent receipt to view your results online."),
        }),
      })
    : null;

  await audit({
    actor_id: actorId,
    actor_type: "staff",
    patient_id: keepId,
    action: "patient.merge.notified",
    resource_type: "patient",
    resource_id: keepId,
    metadata: {
      merge_id: mergeId,
      recipient: recipient.kind,
      email: !email
        ? { ok: false, skipped: true, reason: "no on-file email" }
        : email.ok
          ? { ok: true, id: email.id, to }
          : email.kind === "skipped"
            ? { ok: false, skipped: true, reason: email.reason }
            : { ok: false, error: email.error, to },
    },
    ip_address: ip,
    user_agent: ua,
  });
}

export interface RecentMerge {
  id: string;
  keep_id: string;
  source_id: string;
  keep_drm_id: string | null;
  source_drm_id: string | null;
  keep_deleted_at: string | null;
  keep_merged_into_id: string | null;
  merged_at: string;
  legacy: boolean;
  undoable: boolean;
  interrupted: boolean;
  blocked_reason: string | null;
}

// Every live merge inside the undo window, paged with a total order
// (merged_at desc, id desc) — a dedup CLI batch can exceed any fixed cap.
export async function loadRecentMerges(page = 1): Promise<{ rows: RecentMerge[]; total: number; page: number }> {
  await requireAdminStaff();
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - MERGE_UNDO_WINDOW_DAYS * 86_400_000).toISOString();
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const from = (safePage - 1) * RECENT_MERGES_PAGE_SIZE;
  const { data, count } = await admin
    .from("patient_merges")
    .select("id, keep_id, source_id, merged_at, snapshot_version", { count: "exact" })
    .is("undone_at", null)
    .gte("merged_at", cutoff)
    .order("merged_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + RECENT_MERGES_PAGE_SIZE - 1);
  if (!data) return { rows: [], total: 0, page: safePage };
  const ids = Array.from(new Set(data.flatMap((m) => [m.keep_id, m.source_id])));
  // History (never filtered): a merge stays listed even if a record has since
  // been deleted or merged again — the row explains why Undo is unavailable.
  const { data: pts } = await admin
    .from("patients")
    .select("id, drm_id, deleted_at, merged_into_id")
    .in("id", ids);
  const byId = new Map((pts ?? []).map((p) => [p.id, p]));
  const now = Date.now();
  const rows = data.map((m) => {
    const keep = byId.get(m.keep_id) ?? null;
    const source = byId.get(m.source_id) ?? null;
    const legacy = m.snapshot_version === null;
    const state = undoableState({ keepId: m.keep_id, legacy, mergedAt: m.merged_at, keep, source }, now);
    return {
      id: m.id,
      keep_id: m.keep_id,
      source_id: m.source_id,
      keep_drm_id: keep?.drm_id ?? null,
      source_drm_id: source?.drm_id ?? null,
      keep_deleted_at: keep?.deleted_at ?? null,
      keep_merged_into_id: keep?.merged_into_id ?? null,
      merged_at: m.merged_at,
      legacy,
      undoable: state.undoable,
      interrupted: state.interrupted,
      blocked_reason: state.reason,
    };
  });
  return { rows, total: count ?? rows.length, page: safePage };
}

export type UndoResult = { ok: true; lines: string[] } | { ok: false; error: string };

// One transaction in undo_patient_merge_guarded (0196): it refuses (P0079,
// in words for an admin) rather than half-undoing, keeps fields edited since
// the merge, moves back only what is still on the kept record, and completes
// an undo the pre-3b app left half-done.
export async function undoMergeAction(
  _prev: UndoResult | null,
  formData: FormData,
): Promise<UndoResult> {
  const session = await requireAdminStaff();
  const mergeId = z.string().uuid().safeParse(formData.get("merge_id"));
  if (!mergeId.success) return { ok: false, error: "Invalid merge id." };

  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();
  const { data, error } = await withLifecycleRetry(() =>
    admin.rpc("undo_patient_merge_guarded", {
      p_merge_id: mergeId.data,
      p_actor: session.user_id,
      p_context: { ip, user_agent: ua },
    }),
  );
  if (error) return { ok: false, error: translatePgError(error) };
  const report = parseUndoRpcResult(data);
  if (!report) {
    await reportError({ scope: "undoMergeAction:result", error: new Error("unparseable undo report"), metadata: { merge_id: mergeId.data } });
    return { ok: false, error: "The merge was undone, but the report could not be read. Refresh the page." };
  }

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/admin/patient-merge/candidates");
  revalidatePath("/staff/patients");
  return { ok: true, lines: undoReportLines(report) };
}

// One-click merge from the candidates report (ids already known + admin-confirmed
// in the UI). keep_id is the OLDER record by default.
export async function mergeCandidateAction(
  _prev: MergeResult | null,
  formData: FormData,
): Promise<MergeResult> {
  const fd = new FormData();
  fd.set("keep_id", String(formData.get("keep_id") ?? ""));
  fd.set("source_id", String(formData.get("source_id") ?? ""));
  fd.set("confirm", "MERGE");
  fd.set("origin", "candidates");
  return mergePatientsAction(null, fd);
}
```

Notes for the implementer: the old file imported `headers` from `next/headers` for IP/UA — `ipAndAgent()` replaces it. `activePatients` is still used by `previewByDrmId`. The first-name read in `notifyKeptPatient` is the only direct table read left in the merge path; `query-surfaces.test.ts` (Task 11) records it as a history read.

- [ ] **Step 4:** `npx vitest run "src/app/(staff)/staff/(dashboard)/admin/patient-merge/"` — Expected: the new test PASSES; `actions.rollback.test.ts` and `actions.tables.test.ts` FAIL (they pin the deleted runner). Delete the rollback test now: `git rm "src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.rollback.test.ts"` (`actions.tables.test.ts` is replaced in Task 11).

- [ ] **Step 5:** `npm run typecheck` — fix any caller of the old `RecentMerge`/`UndoResult` shapes in the UI files (Task 10 rewrites them; if typecheck fails only there, proceed to Task 10 before committing and commit both together).

- [ ] **Step 6: Commit**

```bash
git add -A "src/app/(staff)/staff/(dashboard)/admin/patient-merge/"
git commit -m "feat(patient-merge): merge and undo are single RPC calls; notice email audited separately

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 10: Merge and candidates pages show what actually happened

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/merge-client.tsx` (the `ConfirmMerge` component)
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/page.tsx` (intro paragraph)
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/candidates-client.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/page.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/candidates-client.test.tsx`

- [ ] **Step 1: Failing markup test for the Recently merged list** (renderToStaticMarkup, the repo's `*.test.tsx` pattern; stub `useActionState`)

```tsx
// src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/candidates-client.test.tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, useActionState: (_fn: unknown, init: unknown) => [init, () => undefined, false] };
});
vi.mock("../actions", () => ({ mergeCandidateAction: vi.fn(), undoMergeAction: vi.fn() }));

import { CandidatesClient } from "./candidates-client";
import type { RecentMerge } from "../actions";

const row = (over: Partial<RecentMerge>): RecentMerge => ({
  id: "m1", keep_id: "k1", source_id: "s1", keep_drm_id: "DRM-0001", source_drm_id: "DRM-0002",
  keep_deleted_at: null, keep_merged_into_id: null, merged_at: "2026-09-30T06:40:47Z", legacy: false,
  undoable: true, interrupted: false, blocked_reason: null, ...over,
});

describe("Recently merged list", () => {
  it("offers Undo on an undoable merge", () => {
    const html = renderToStaticMarkup(<CandidatesClient pairs={[]} recent={[row({})]} />);
    expect(html).toContain("DRM-0002 → DRM-0001");
    expect(html).toContain(">Undo<");
  });
  it("explains why Undo is unavailable and badges a deleted kept record", () => {
    const html = renderToStaticMarkup(
      <CandidatesClient pairs={[]} recent={[row({ undoable: false, keep_deleted_at: "2026-09-30T08:00:00Z",
        blocked_reason: "The kept record has since been deleted — restore it first." })]} />,
    );
    expect(html).not.toContain(">Undo<");
    expect(html).toContain("The kept record has since been deleted — restore it first.");
    expect(html).toContain("Deleted record");
  });
  it("labels an interrupted undo as needing to be finished", () => {
    const html = renderToStaticMarkup(<CandidatesClient pairs={[]} recent={[row({ legacy: true, interrupted: true })]} />);
    expect(html).toContain("Undo was interrupted — finish it");
    expect(html).toContain(">Finish undo<");
  });
});
```

- [ ] **Step 2:** `npx vitest run "src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/candidates-client.test.tsx"` — Expected: FAIL (no blocked reason, no badge, no "Finish undo").

- [ ] **Step 3: `candidates-client.tsx` — replace `UndoButton`, the `CandidatesClient` recent section, and the imports**

```tsx
// imports (replace the actions import line and add two)
import { mergeCandidateAction, undoMergeAction, type MergeResult, type UndoResult, type RecentMerge } from "../actions";
import { manilaDate } from "@/lib/dates/manila";
import { InactivePatientBadge } from "@/components/staff/inactive-patient-badge";
```

```tsx
function UndoButton({ merge }: { merge: RecentMerge }) {
  const [state, action, pending] = useActionState<UndoResult | null, FormData>(undoMergeAction, null);
  if (state?.ok) {
    return (
      <div className="text-xs text-green-700" role="status">
        <p className="font-semibold">Undone ✓</p>
        <ul className="mt-1 list-disc pl-4">
          {state.lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </div>
    );
  }
  const label = merge.interrupted ? "Finish undo" : "Undo";
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(merge.interrupted ? "Finish the undo of this merge?" : "Undo this merge?")) e.preventDefault();
      }}
    >
      <input type="hidden" name="merge_id" value={merge.id} />
      <button disabled={pending} className="text-xs font-semibold text-cyan-700 hover:underline disabled:opacity-50">
        {pending ? "Undoing…" : label}
      </button>
      {state && !state.ok && <span className="ml-2 text-xs text-red-600" role="alert">{state.error}</span>}
    </form>
  );
}
```

```tsx
// inside CandidatesClient, replace the whole `{recent.length > 0 && (…)}` block
      {recent.length > 0 && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-bold">Recently merged (undo within 30 days)</h2>
          <ul className="divide-y">
            {recent.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-4 py-2 text-sm">
                <div>
                  <span>
                    {m.source_drm_id ?? "—"} → {m.keep_drm_id ?? "—"}
                    <InactivePatientBadge deletedAt={m.keep_deleted_at} mergedIntoId={m.keep_merged_into_id} />
                    <span className="text-slate-400"> · {manilaDate(m.merged_at)}</span>
                  </span>
                  {m.interrupted && (
                    <p className="text-xs text-amber-700">Undo was interrupted — finish it.</p>
                  )}
                  {!m.undoable && m.blocked_reason && (
                    <p className="text-xs text-slate-500">{m.blocked_reason}</p>
                  )}
                </div>
                {m.undoable && <UndoButton merge={m} />}
              </li>
            ))}
          </ul>
        </div>
      )}
```

(`recent` stays `RecentMerge[]`; paging is rendered by the page below the client.)

- [ ] **Step 4: `candidates/page.tsx` — read `mpage`, render a pager**

```tsx
import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCandidatePairs } from "@/lib/patients/find-duplicates";
import { RECENT_MERGES_PAGE_SIZE } from "@/lib/patients/merge-fields";
import { PaginationRangeLabel, pagerControlClass } from "@/components/staff/list-pagination";
import { loadRecentMerges } from "../actions";
import { CandidatesClient } from "./candidates-client";

export const metadata = { title: "Possible duplicate patients" };
export const dynamic = "force-dynamic";

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string; mpage?: string }>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;
  const minTier = sp.tier === "weak" ? "weak" : "probable";
  const mpage = Math.max(1, Number.parseInt(sp.mpage ?? "1", 10) || 1);
  const admin = createAdminClient();
  const [pairs, recent] = await Promise.all([
    loadCandidatePairs(admin, { minTier }),
    loadRecentMerges(mpage),
  ]);
  const pageCount = Math.max(1, Math.ceil(recent.total / RECENT_MERGES_PAGE_SIZE));
  const hrefFor = (p: number) => {
    const q = new URLSearchParams();
    if (minTier === "weak") q.set("tier", "weak");
    if (p > 1) q.set("mpage", String(p));
    const s = q.toString();
    return `/staff/admin/patient-merge/candidates${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      {/* … header and tier links unchanged … */}

      <CandidatesClient pairs={pairs} recent={recent.rows} />

      {recent.total > RECENT_MERGES_PAGE_SIZE && (
        <nav aria-label="Recently merged pages" className="flex items-center justify-between gap-3">
          <PaginationRangeLabel page={recent.page} size={RECENT_MERGES_PAGE_SIZE} total={recent.total} noun="merge" />
          <div className="flex gap-2">
            {recent.page > 1 ? <Link href={hrefFor(recent.page - 1)} className={pagerControlClass}>Previous</Link> : null}
            {recent.page < pageCount ? <Link href={hrefFor(recent.page + 1)} className={pagerControlClass}>Next</Link> : null}
          </div>
        </nav>
      )}
    </div>
  );
}
```
Keep the existing header `<div>` and the Probable+/Include weak links exactly as they are; the tier links do not carry `mpage` (changing the tier resets the merge page — intended).

- [ ] **Step 5: `merge-client.tsx` — success block and the wrong "cannot be undone" text**

Add `import { fieldList, movedSummary } from "@/lib/patients/merge-result";` and `import Link from "next/link";` (if not already imported). Replace the `if (state?.ok) { … }` block with:

```tsx
  if (state?.ok) {
    return (
      <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-5" role="status">
        <h2 className="font-heading text-lg font-extrabold text-emerald-900">Merge complete</h2>
        <p className="mt-2 text-sm text-emerald-900">
          {state.merged_drm_id} merged into {state.kept_drm_id}. Moved {movedSummary(state.moved)}.
        </p>
        {state.filled.length > 0 ? (
          <p className="mt-1 text-sm text-emerald-900">
            Copied onto {state.kept_drm_id} because it had none: {fieldList(state.filled)}.
          </p>
        ) : null}
        {state.rechained > 0 ? (
          <p className="mt-1 text-sm text-emerald-900">
            {state.rechained === 1
              ? `1 record previously merged into ${state.merged_drm_id} now points at ${state.kept_drm_id}.`
              : `${state.rechained} records previously merged into ${state.merged_drm_id} now point at ${state.kept_drm_id}.`}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-emerald-900">
          The merged-in record stays on file, pointing at {state.kept_drm_id}. You can undo this within 30 days from{" "}
          <Link href="/staff/admin/patient-merge/candidates" className="font-semibold underline">
            Possible duplicates › Recently merged
          </Link>.
        </p>
      </section>
    );
  }
```

And replace the paragraph under "Confirm merge" (the one saying "This cannot be undone…") with:

```tsx
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        Type <span className="font-mono font-bold">MERGE</span> to confirm. Everything moves in one step — if
        anything is in the way, nothing changes. You can undo a merge within 30 days; details the kept record was
        missing (middle name, sex, phone, email, address, birthdate) are copied from the merged-in record.
      </p>
```

- [ ] **Step 6: `page.tsx` intro paragraph** — replace its text with:

```tsx
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          When a patient ends up with two records (a typo in the email, a name variation…), move their visits,
          appointments, results, consent records and lab-request uploads onto one record. The other record stays on
          file pointing at the one you keep, so its old DRM-ID and the audit trail still resolve. Undo is available
          for 30 days.
        </p>
```

- [ ] **Step 7:** `npx vitest run "src/app/(staff)/staff/(dashboard)/admin/patient-merge/" && npm run typecheck` — Expected: PASS.

- [ ] **Step 8: Commit** — `git add -A "src/app/(staff)/staff/(dashboard)/admin/patient-merge/" && git commit -m "feat(patient-merge): show filled fields, undo report, why Undo is unavailable; page all recent merges" …`.

---
### Task 11: Delete the step runners; FK inventory; write-guard + surface registries

**Files:**
- Delete: `src/lib/patients/merge-steps.ts`, `src/lib/patients/merge-steps.test.ts`, `src/lib/patients/undo-merge-steps.ts`, `src/lib/patients/undo-merge-steps.test.ts`, `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.tables.test.ts`
- Create: `src/lib/patients/patient-fk-inventory.test.ts`
- Modify: `src/lib/patients/write-guards.test.ts` (KNOWN_WRITER_RPCS + EXEMPT entries around lines 49–65 and 136–141)
- Modify: `src/lib/patients/query-surfaces.test.ts` (the two `mixed` entries around lines 80–81)

- [ ] **Step 1: Write the FK inventory test.** It replaces `actions.tables.test.ts` (which kept three hand-maintained table lists in lockstep): there is now one list, in SQL, pinned to `MERGE_MOVED_TABLES` by Task 1's test — this test makes sure no new `patients` FK appears without a decision.

```ts
// src/lib/patients/patient-fk-inventory.test.ts
// Every foreign key to public.patients anywhere in supabase/migrations/ must be
// either MOVED by a merge (merge_patients_guarded, 0196 — the same list as
// MERGE_MOVED_TABLES) or listed below as deliberately NOT moved, with why. A
// new FK fails this test until someone decides — the gap the old three-list
// actions.tables.test.ts guarded, now against the schema itself.
// The parser's output was checked against the live catalog on 2026-09-30:
//   select conrelid::regclass, a.attname from pg_constraint c join pg_attribute a
//     on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
//    where c.confrelid = 'public.patients'::regclass and c.contype = 'f';
// (13 rows, identical to FOUND below).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MERGE_MOVED_TABLES } from "./merge-fields";

const NOT_MOVED: Record<string, string> = {
  "patients.merged_into_id": "The merge marker itself — written by the merge, never re-pointed as history.",
  "patient_merges.keep_id": "The undo ledger names both records; moving it would erase what was merged.",
  "patient_merges.source_id": "Same as keep_id.",
  "sheet_patient_links.patient_id":
    "Sheet Sync identity link. The sync treats a merged target as stale and re-plans (0193); moving it would bypass the sync's own identity matching.",
  "patient_acquisition_facts.patient_id":
    "Patient Sources fact row. The report follows merged_into_id chains itself (_ps_survivors, 0189).",
  "sheet_customer_rows.patient_id": "Raw Sheet Sync mirror row — what the sheet row resolved to at the time; history.",
  "sheet_encounter_lines.patient_id": "Raw Sheet Sync mirror row — history; Patient Sources follows the chain.",
};

function scanPatientFks(): Set<string> {
  const dir = join(process.cwd(), "supabase/migrations");
  const found = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
    const re = /references\s+(?:public\.)?patients\s*(?:\(\s*id\s*\))?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      const before = sql.slice(0, m.index);
      const line = sql.slice(before.lastIndexOf("\n") + 1, m.index);
      const tables = [
        ...before.matchAll(
          /(?:create\s+table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?)(?:public\.)?"?(\w+)"?/gi,
        ),
      ];
      const table = tables.at(-1)?.[1] ?? "?";
      const fk = line.match(/foreign\s+key\s*\(\s*(\w+)\s*\)/i);
      const col = fk?.[1] ?? line.match(/^\s*(?:add\s+column\s+(?:if\s+not\s+exists\s+)?)?(\w+)\s+uuid/i)?.[1] ?? "?";
      found.add(`${table}.${col}`);
    }
  }
  return found;
}

const FOUND = scanPatientFks();
const MOVED = new Set(MERGE_MOVED_TABLES.map((t) => `${t}.patient_id`));

describe("foreign keys to public.patients", () => {
  it("the parser resolves every FK to a table.column", () => {
    for (const k of FOUND) expect(k, k).not.toMatch(/\?/);
  });
  it("every FK is either moved by a merge or deliberately not moved", () => {
    const unclassified = [...FOUND].filter((k) => !MOVED.has(k) && !(k in NOT_MOVED));
    expect(unclassified, "new FK to patients — add it to 0196's moves or to NOT_MOVED with a reason").toEqual([]);
  });
  it("every classified FK still exists (no stale entries)", () => {
    for (const k of [...MOVED, ...Object.keys(NOT_MOVED)]) expect(FOUND.has(k), k).toBe(true);
  });
  it("matches the 13 FKs in the live catalog (2026-09-30)", () => {
    expect(FOUND.size).toBe(13);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/lib/patients/patient-fk-inventory.test.ts` — Expected: PASS (the parser was prototyped against the repo on 2026-09-30 and found exactly the 13 catalog FKs). If it fails, fix the parser, never the expected list — re-run the catalog query in the header to confirm.

- [ ] **Step 3: Delete the superseded files**

```bash
git rm src/lib/patients/merge-steps.ts src/lib/patients/merge-steps.test.ts \
       src/lib/patients/undo-merge-steps.ts src/lib/patients/undo-merge-steps.test.ts \
       "src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.tables.test.ts"
grep -rn "merge-steps\|undo-merge-steps\|MERGE_MOVE_TABLES\|UNDO_MERGE_TABLES" src scripts | head
```
Expected: no matches in `src`/`scripts` (docs and the 0184 smoke comment are handled in Tasks 13 and 15).

- [ ] **Step 4: `write-guards.test.ts`** — add to `KNOWN_WRITER_RPCS`, after `"restore_patient",`:

```ts
  // 0196: the merge / undo-merge functions ARE the lifecycle change (the
  // merge marker); each refuses an inactive record itself (P0058/P0079)
  // under exclusive lifecycle locks. See their EXEMPT entries below.
  "merge_patients_guarded",
  "undo_patient_merge_guarded",
```

and replace the three merge EXEMPT entries (`…:mergePatientsAction`, `…:undoMergeAction`, `…:revertFillFields`) with:

```ts
  [`src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts:mergePatientsAction`]:
    "merge_patients_guarded (0196) IS the merge — it locks both records exclusively and refuses a deleted, merged or missing one (P0058) inside the same transaction, so an app-level active-patient guard here would be circular and racy.",
  [`src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts:undoMergeAction`]:
    "undo_patient_merge_guarded (0196) IS the undo — it refuses (P0079) a kept record that is deleted or merged elsewhere, under the same locks; the source is inactive by definition until the undo clears its marker.",
```

- [ ] **Step 5: `query-surfaces.test.ts`** — update the two `mixed` entries' `why`:

```ts
  [`src/${S}/admin/patient-merge/actions.ts`]: { meaning: "mixed", why: "Preview/lookup reads are active; the recent-merges list and the notice email's first-name read are history; merge and undo themselves run in SQL (0196)." },
  "scripts/patient-dedup/engine.ts": { meaning: "mixed", why: "loadRows is active; each merge is one merge_patients_guarded call that re-checks both records under lock (0196)." },
```

- [ ] **Step 6:** `npx vitest run src/lib/patients/ "src/app/(staff)/staff/(dashboard)/admin/patient-merge/"` — Expected: PASS. If `write-guards.test.ts` flags the dedup engine (it scans `src` plus listed lib dirs, not `scripts/`, so it should not), follow its message.

- [ ] **Step 7: Commit** — `git add -A src && git commit -m "refactor(patients): drop the merge/undo step runners; inventory every patients FK" …`.

---

### Task 12: Dedup CLI — explicit admin actor, one RPC per merge

**Files:**
- Create: `scripts/patient-dedup/lib/args.ts`, `scripts/patient-dedup/lib/args.test.ts`
- Modify: `scripts/patient-dedup/engine.ts`

- [ ] **Step 1: Failing args test**

```ts
// scripts/patient-dedup/lib/args.test.ts
import { describe, expect, it } from "vitest";
import { parseDedupArgs } from "./args";

const ADMIN = "a0000000-0000-4000-8000-000000000196";

describe("parseDedupArgs", () => {
  it("dry-run needs no actor", () => {
    expect(parseDedupArgs([])).toEqual({ commit: false, actor: null });
  });
  it("--commit requires --actor", () => {
    expect(() => parseDedupArgs(["--commit"])).toThrow(/--actor=<admin staff id>/);
  });
  it("accepts --actor=<uuid> and --actor <uuid>", () => {
    expect(parseDedupArgs(["--commit", `--actor=${ADMIN}`])).toEqual({ commit: true, actor: ADMIN });
    expect(parseDedupArgs(["--commit", "--actor", ADMIN])).toEqual({ commit: true, actor: ADMIN });
  });
  it("rejects a malformed actor", () => {
    expect(() => parseDedupArgs(["--commit", "--actor=admin"])).toThrow(/UUID/);
    expect(() => parseDedupArgs(["--commit", "--actor"])).toThrow(/UUID/);
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/patient-dedup/lib/args.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `args.ts`**

```ts
// scripts/patient-dedup/lib/args.ts
// Pure CLI argument parsing for `npm run dedup:patients` (kept out of
// engine.ts so tests don't import the env loader or a database client).
// Since 0196 every merge is recorded against a named, ACTIVE admin — the SQL
// function refuses anything else (P0078) — so --commit requires --actor.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DedupArgs {
  commit: boolean;
  actor: string | null;
}

export function parseDedupArgs(argv: readonly string[]): DedupArgs {
  const commit = argv.includes("--commit");
  const eq = argv.find((a) => a.startsWith("--actor="));
  const at = argv.indexOf("--actor");
  const raw = eq !== undefined ? eq.slice("--actor=".length) : at >= 0 ? (argv[at + 1] ?? "") : null;
  if (raw !== null && !UUID_RE.test(raw)) {
    throw new Error("--actor must be an admin's staff id (a UUID, from Admin Tools › Staff).");
  }
  if (commit && raw === null) {
    throw new Error("--commit needs --actor=<admin staff id>: every merge is recorded against an active admin.");
  }
  return { commit, actor: raw };
}
```

- [ ] **Step 4: Rewire `engine.ts`**

1. Imports: add `import { parseDedupArgs, type DedupArgs } from "./lib/args";` and `import { withLifecycleRetry } from "../../src/lib/patients/lifecycle-retry";`. Delete the local `interface Args` and `parseArgs()`; export a thin wrapper so existing callers keep working:

```ts
export function parseArgs(): DedupArgs {
  try {
    return parseDedupArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
```

2. In `run()`, the dry-run hint becomes:

```ts
    console.log(
      `\nDry-run. To commit against this target:\n` +
        `  npm run dedup:patients -- --commit --actor=<admin staff id> ${CONFIRM_FLAG}=${expectedConfirmToken()}` +
        `${process.argv.includes("--prod") ? " --prod" : ""}\n` +
        `\n${CONFIRM_FLAG} names the database above — it changes with the target.\n` +
        `--actor is recorded on every merge (audit log + undo ledger); it must be an active admin.\n`,
    );
```

and the commit call becomes `await commitMerges(admin, plans, args.actor!);` (non-null: `parseDedupArgs` guarantees an actor whenever `commit` is true).

3. Replace `FK_TABLES`, `FILL_FIELDS` and the whole `mergeOne` body, and `commitMerges`, with:

```ts
// One merge = one merge_patients_guarded call (0196): every move, the fill,
// chain flattening, the tombstone, the undo ledger and the audit row commit
// together or not at all, recorded against `actor`. CLI merges are therefore
// undoable from Admin Tools › Possible duplicates for 30 days.
export async function mergeOne(
  admin: SupabaseClient<Database>,
  canonical: PatientRow,
  source: PatientRow,
  tier: string,
  actor: string,
): Promise<"merged" | "skipped"> {
  const { error } = await withLifecycleRetry(() =>
    admin.rpc("merge_patients_guarded", {
      p_keep: canonical.id,
      p_source: source.id,
      p_actor: actor,
      p_context: { source: "dedup-cli", tier },
    }),
  );
  if (!error) return "merged";
  // P0058: either record is no longer active — already merged by an earlier
  // run of this plan, or deleted since the CSV was built. Re-run safe.
  if (error.code === "P0058") {
    console.log(`skip: ${source.drm_id} → ${canonical.drm_id}: ${error.message}`);
    return "skipped";
  }
  throw new Error(`merge ${source.drm_id} → ${canonical.drm_id}: ${error.message}`);
}

async function commitMerges(admin: SupabaseClient<Database>, plans: ClusterPlan[], actor: string): Promise<void> {
  let merged = 0;
  let skipped = 0;
  for (const plan of plans) {
    for (const m of plan.auto) {
      if ((await mergeOne(admin, plan.canonical, m.row, m.tier, actor)) === "merged") merged++;
      else skipped++;
    }
  }
  console.log(`\nCommitted ${merged} merge(s), skipped ${skipped}. Review pile left untouched (manual via admin UI).`);
}
```

4. Update the `requireLocalOrExplicitProd` `writes:` text for `--commit` to: `"MERGES patient records through merge_patients_guarded (moves visits/appointments/results/consents/uploads, writes the undo ledger)"`.

- [ ] **Step 5:** `npx vitest run scripts/ && npm run typecheck` — Expected: PASS (`guard-coverage.test.ts` still sees the guard before `adminClient()`; `tier` values from `plan.ts` are ≤ 40 characters).

- [ ] **Step 6: Local dry-run + commit smoke** (local stack only)

```bash
npm run -s dedup:patients 2>&1 | tail -6                       # dry-run: hint mentions --actor
npm run -s dedup:patients -- --commit --confirm=local 2>&1 | tail -2   # refused: needs --actor (exit 2)
```
Expected: the hint prints `--actor=<admin staff id>`; the second command prints the `--commit needs --actor` message. (Do not run a real `--commit` against the shared stack; the SQL path is proven by smoke s3.18.)

- [ ] **Step 7: Commit** — `git add scripts/patient-dedup && git commit -m "feat(dedup): --actor is required to commit; each merge is one merge_patients_guarded call" …`.

---

### Task 13: Merge-marker fixtures go through the writer role (0197-proof)

**Files:**
- Modify: `supabase/tests/0167_patient_soft_delete_smoke.sql`
- Modify: `supabase/tests/0184_patient_lifecycle_locks_smoke.sql`
- Modify: `scripts/patient-sources-db-proof.ts`

Every fixture that writes `merged_into_id` directly would fail once 0197 lands. Route them through `patient_merge_writer` now and always set **both** `merged_into_id` and `merged_at` (0197's transition rule).

- [ ] **Step 1: 0167 smoke** — add after `pg_temp.state_of` (line ~109):

```sql
-- 0196: merge markers are written through the private merge writer, both
-- columns together (0197 refuses anything else).
create function pg_temp.mark_merged(src uuid, keep uuid) returns void language plpgsql as $f$
begin
  set local role patient_merge_writer;
  update public.patients set merged_into_id = keep, merged_at = now() where id = src;
  reset role;
end $f$;
```

Then replace each positive fixture write (read ±10 lines first to confirm each is a fixture, not an assertion):
- line ~811 `update public.patients set merged_into_id = q, merged_at = now() where id = m;` → `perform pg_temp.mark_merged(m, q);`
- line ~961 and ~1031 `update public.patients set merged_into_id = keep, merged_at = now() where id = merged;` → `perform pg_temp.mark_merged(merged, keep);`
- line ~1124 `… where id = merged_src;` → `perform pg_temp.mark_merged(merged_src, keep);`
- line ~212 is an **assertion** (a direct marker write on a DELETED patient must be refused with P0058) — leave it unchanged; 0167's guard fires before both marker guards (`trg_patients_lifecycle_guard` sorts before `trg_patients_live_merge_guard` and 0197's `trg_patients_merge_marker_guard`).

- [ ] **Step 2: 0184 smoke**
- Helper at line ~116: make `pg_temp.merge_into` plpgsql through the writer:

```sql
create function pg_temp.merge_into(src uuid, keep uuid) returns void language plpgsql as $f$
begin
  set local role patient_merge_writer;
  update public.patients set merged_into_id = keep, merged_at = now() where id = src;
  reset role;
end $f$;
```
- Add a role-aware state helper after `pg_temp.state_of`:

```sql
create function pg_temp.state_as(r text, sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute format('set local role %I', r);
  execute sql;
  reset role;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;
```
- Line ~2110 (inside the nested BEGIN/EXCEPTION block of s15.5b) `update public.patients set merged_into_id = null, merged_at = null where id = src_pt;` → wrap: `set local role patient_merge_writer;` before it and `reset role;` after it.
- Line ~2151 (s15.6) `pg_temp.state_of(format($q$update public.patients set merged_into_id = null, merged_at = null where id = %L$q$, src_pt))` → `pg_temp.state_as('patient_merge_writer', format($q$update public.patients set merged_into_id = null, merged_at = null where id = %L$q$, src_pt))`.
- s15 header comment + the `-- NEW order: undoMergeSteps()'s actual sequence` comment: say the order now lives in `undo_patient_merge_guarded` (0196) and this section still proves why marker-first is required.

- [ ] **Step 3: `scripts/patient-sources-db-proof.ts`** — add right after the `q` helper (line ~187–195):

```ts
  // 0196/0197: merge markers are written through the private merge writer,
  // both columns together (0197 refuses anything else). Session-level SET ROLE
  // (not SET LOCAL, which is a no-op outside a transaction block), undone
  // right after the one statement.
  async function markMerged(srcId: string, keepId: string): Promise<void> {
    await q(`set role patient_merge_writer`);
    await q(`update public.patients set merged_into_id = $1, merged_at = now() where id = $2`, [keepId, srcId]);
    await q(`reset role`);
  }
```
and replace the eight writes (param order is `[keep, src]`):
`q(\`update public.patients set merged_into_id = $1 where id = $2\`, [bId, aId])` → `markMerged(aId, bId)`; `[sId, mId]` → `markMerged(mId, sId)`; `[i1Id, a1Id]` → `markMerged(a1Id, i1Id)`; `[i3Id, i2Id]` → `markMerged(i2Id, i3Id)`; `[bId, aId]` (line ~966) → `markMerged(aId, bId)`; `[xId, yId]` → `markMerged(yId, xId)`; lines ~1350 and ~1370 — check which client they use (a second `db2` client is created at line ~1328): if they call `q`, use `markMerged`; if they call `db2.query`, write the same three statements on `db2` (`set role patient_merge_writer` / the update with both columns / `reset role`).

- [ ] **Step 4: Run all three** (local stack; 0196 applied)

```bash
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/0167_patient_soft_delete_smoke.sql > /tmp/0167.log 2>&1; echo exit=$?; grep -c FAILED /tmp/0167.log
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/0184_patient_lifecycle_locks_smoke.sql > /tmp/0184.log 2>&1; echo exit=$?; grep -c FAILED /tmp/0184.log
npm run -s patient-sources:db-proof > /tmp/ps-proof.log 2>&1; echo exit=$?; tail -3 /tmp/ps-proof.log
```
Expected: three `exit=0`, `0` FAILED lines. (`patient-sources:db-proof` needs 0189/0193 locally — Task 0 applied 0193.) If the 0184 smoke fails on the known main issue (`sheet_mirror_staging` RLS in the 0151 smoke — not this file) record it and move on; any other failure is ours.

- [ ] **Step 5: Commit** — `git add supabase/tests scripts/patient-sources-db-proof.ts && git commit -m "test: merge-marker fixtures go through patient_merge_writer, both columns" …`.

---
### Task 14: Two-session concurrency proof (`npm run merge:concurrency-proof`)

**Files:**
- Create: `scripts/merge-concurrency-proof.ts`
- Modify: `package.json` (`"merge:concurrency-proof": "tsx scripts/merge-concurrency-proof.ts"` next to `panel-claim:concurrency-proof`)

Model: `scripts/smoke-lifecycle-locks.ts` (connect / waitingOn / stateOf / stillWaiting / race / cleanup shapes are copied from it) and `scripts/panel-claim-concurrency-proof.ts` (`--control` mutant). Every forced race asserts **that the second party waited, on what, and what it got**; the free race (M7) asserts the invariant only.

- [ ] **Step 1: Write the script**

```ts
/**
 * merge:concurrency-proof — two-session proof for the atomic patient merge
 * and undo-merge (0196: merge_patients_guarded / undo_patient_merge_guarded).
 *
 * LOCAL ONLY. Commits its own tagged fixtures (two connections cannot see each
 * other's uncommitted rows), runs each race with two real connections, and
 * removes everything in `finally` — then proves nothing tagged is left. Never
 * touches rows it did not mint (the local stack is shared).
 *
 *   M1a visit insert on the source first  → merge waits, then moves the visit
 *   M1b merge first                       → the visit insert waits, then P0058
 *   M2  delete_patient(keep) first        → merge waits, then P0058
 *   M3  two merges of one source          → second waits, then P0058
 *   M4  A→B racing B→C                    → P0072, retry re-parents A to C
 *   M5  result link on the source first   → merge waits, P0072, retry succeeds
 *   M5b merge first                       → the link waits, then P0072/P0058
 *   M6  result link spanning both records → undo waits, P0072, retry refuses (split)
 *   M7  row-first visit edit vs merge     → free race ×20, both converge with one retry
 *   M8  double undo                       → second waits, then P0079
 *   M9  undo vs an edit of a filled field → undo waits on the row, keeps the edit
 *
 * --control: copies merge_patients_guarded into the throwaway schema
 * merge_proof_ctl with its lock statements removed (never touching public),
 * and passes only if M1b FAILS against the copy — the proof can fail.
 *
 * Run: npm run merge:concurrency-proof [-- --control]   (local stack, 0196 applied)
 */
import "./lib/load-env";
import { requireLocalOrExplicitProd, hostOf, isLocalHost } from "./lib/env-guard";
import { randomUUID } from "node:crypto";
import pg from "pg";

requireLocalOrExplicitProd("merge:concurrency-proof", {
  writes:
    "creates and then removes temporary staff, patients, visits, lines, results, merges and their audit rows; --control also creates and drops the schema merge_proof_ctl",
});

const DB_URL = process.env.MERGE_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!isLocalHost(hostOf(DB_URL))) {
  console.error("merge:concurrency-proof takes real locks and writes fixtures — it runs against the LOCAL stack only.");
  process.exit(1);
}
const CONTROL = process.argv.includes("--control");

const ADMIN = randomUUID();
const SERVICE = randomUUID();
const TAG = `MGP${Date.now().toString(36).toUpperCase()}`;
const made = { patients: [] as string[], results: [] as string[] };
let seq = 0;
let TEMPLATE: string | null = null;

type Client = pg.Client & { pid: number };
const results: { name: string; ok: boolean; detail: string }[] = [];

async function connect(): Promise<Client> {
  const c = new pg.Client({ connectionString: DB_URL }) as Client;
  await c.connect();
  await c.query("set lock_timeout = '15s'");
  c.pid = (await c.query("select pg_backend_pid() as pid")).rows[0].pid as number;
  return c;
}

async function waitingOn(s: Client, c: Client): Promise<string> {
  const { rows } = await s.query(
    `select case when locktype = 'advisory' and classid = (hashtext('patient_lifecycle'))::oid then 'lifecycle'
                 when locktype = 'advisory' and classid = (hashtext('result_membership'))::oid then 'membership'
                 when locktype in ('transactionid', 'tuple') then 'row'
                 else locktype end as what
       from pg_locks where pid = $1 and not granted limit 1`,
    [c.pid],
  );
  return rows[0]?.what ?? "none";
}

async function stateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? `error: ${(e as Error).message}`;
  }
}

async function stillWaiting(p: Promise<unknown>, ms = 400): Promise<boolean> {
  const pending = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  return winner === pending;
}

function expectEq(label: string, got: unknown, want: unknown) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function race(name: string, fn: (a: Client, b: Client, s: Client) => Promise<void>) {
  const a = await connect();
  const b = await connect();
  const s = await connect();
  try {
    await fn(a, b, s);
    results.push({ name, ok: true, detail: "" });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
  } finally {
    for (const c of [a, b]) await c.query("rollback").catch(() => undefined);
    await Promise.all([a.end(), b.end(), s.end()]);
  }
}

// --- fixtures (committed through the supervisor connection) -------------------
async function patient(s: pg.Client, label: string, phone: string | null = null): Promise<string> {
  seq++;
  const { rows } = await s.query(
    `insert into public.patients (drm_id, first_name, last_name, birthdate, phone)
     values ($1, 'Proof', $2, '1990-01-01', $3) returning id`,
    [`DRM-${TAG}${seq}`, `${label}${seq}`, phone],
  );
  made.patients.push(rows[0].id);
  return rows[0].id as string;
}
const visitSql = `insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php)
                  values ($1, $2, 'unpaid', 0, 0) returning id`;
async function visit(c: pg.Client, p: string): Promise<string> {
  return (await c.query(visitSql, [`V-${TAG}-${++seq}`, p])).rows[0].id as string;
}
async function line(c: pg.Client, v: string): Promise<string> {
  const { rows } = await c.query(
    `insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php, parent_id, is_package_header)
     values ($1, $2, 'in_progress', $3, 0, 0, null, false) returning id`,
    [v, SERVICE, ADMIN],
  );
  return rows[0].id as string;
}
async function result(c: pg.Client, lines: string[]): Promise<string> {
  const r = (await c.query(
    `insert into public.results (generation_kind, uploaded_by) values ('structured', $1) returning id`, [ADMIN],
  )).rows[0].id as string;
  made.results.push(r);
  for (const l of lines) await c.query(`insert into public.result_test_requests (result_id, test_request_id) values ($1, $2)`, [r, l]);
  return r;
}
async function asService(c: pg.Client) {
  await c.query("set local role service_role");
}
function mergeQ(c: pg.Client, keep: string, src: string, fn = "public.merge_patients_guarded") {
  return c.query(`select ${fn}($1, $2, $3, $4::jsonb) as r`, [keep, src, ADMIN, JSON.stringify({ source: "admin" })]);
}
function undoQ(c: pg.Client, mergeId: string) {
  return c.query(`select public.undo_patient_merge_guarded($1, $2, null) as r`, [mergeId, ADMIN]);
}
async function mergeCommitted(s: pg.Client, keep: string, src: string): Promise<string> {
  await s.query("begin");
  await asService(s);
  const { rows } = await mergeQ(s, keep, src);
  await s.query("commit");
  return rows[0].r.merge_id as string;
}
async function ownerOf(s: pg.Client, table: string, id: string): Promise<string | null> {
  return ((await s.query(`select patient_id from public.${table} where id = $1`, [id])).rows[0]?.patient_id ?? null) as string | null;
}
async function markerOf(s: pg.Client, p: string): Promise<string | null> {
  return ((await s.query(`select merged_into_id from public.patients where id = $1`, [p])).rows[0]?.merged_into_id ?? null) as string | null;
}
/** One transaction on `c`, retried ONCE on P0072/40P01/40001 — the app's withLifecycleRetry. */
async function withRetry(c: Client, fn: (c: Client) => Promise<unknown>): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await c.query("begin");
    const st = await stateOf(fn(c));
    await c.query(st === "ok" ? "commit" : "rollback");
    if (st === "ok" || !["P0072", "40P01", "40001"].includes(st) || attempt === 1) return st;
  }
  return "unreachable";
}

async function seed(s: pg.Client) {
  await s.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), now())`,
    [ADMIN, `${TAG.toLowerCase()}-admin@example.test`],
  );
  await s.query(`insert into public.staff_profiles (id, full_name, role, is_active) values ($1, 'Merge Proof Admin', 'admin', true)`, [ADMIN]);
  await s.query(`insert into public.services (id, code, name, price_php, kind) values ($1, $2, 'Merge proof lab', 100, 'lab_test')`, [SERVICE, `${TAG}-LAB`]);
  TEMPLATE = (await s.query(`insert into public.result_templates (service_id, layout) values ($1, 'simple') returning id`, [SERVICE])).rows[0].id;
}

async function cleanup(s: pg.Client) {
  const ids = made.patients;
  await s.query("begin");
  // Local-only teardown of rows this run minted: replica mode skips the
  // lifecycle guards (some fixtures end deleted) and per-row RI ordering.
  await s.query("set local session_replication_role = replica");
  if (ids.length > 0) {
    await s.query(`delete from public.critical_alerts where patient_id = any($1::uuid[])`, [ids]);
    await s.query(
      `delete from public.result_test_requests where test_request_id in
         (select tr.id from public.test_requests tr join public.visits v on v.id = tr.visit_id where v.patient_id = any($1::uuid[]))`,
      [ids],
    );
  }
  if (made.results.length > 0) await s.query(`delete from public.results where id = any($1::uuid[])`, [made.results]);
  if (ids.length > 0) {
    for (const sql of [
      `delete from public.test_requests where visit_id in (select id from public.visits where patient_id = any($1::uuid[]))`,
      `delete from public.visits where patient_id = any($1::uuid[])`,
      `delete from public.appointments where patient_id = any($1::uuid[])`,
      `delete from public.patient_consents where patient_id = any($1::uuid[])`,
      `delete from public.appointment_attachments where patient_id = any($1::uuid[])`,
      `delete from public.patient_merges where keep_id = any($1::uuid[]) or source_id = any($1::uuid[])`,
      `delete from public.audit_log where patient_id = any($1::uuid[])`,
      `delete from public.patients where id = any($1::uuid[])`,
    ]) await s.query(sql, [ids]);
  }
  await s.query(`delete from public.audit_log where actor_id = $1`, [ADMIN]);
  if (TEMPLATE) {
    await s.query(`delete from public.result_template_params where template_id = $1`, [TEMPLATE]);
    await s.query(`delete from public.result_templates where id = $1`, [TEMPLATE]);
  }
  await s.query(`delete from public.services where id = $1`, [SERVICE]);
  await s.query(`delete from public.staff_profiles where id = $1`, [ADMIN]);
  await s.query(`delete from auth.users where id = $1`, [ADMIN]);
  await s.query("commit");
  if (CONTROL) await s.query("drop schema if exists merge_proof_ctl cascade");
  const { rows } = await s.query(`select count(*)::int as n from public.patients where drm_id like $1`, [`DRM-${TAG}%`]);
  if (rows[0].n !== 0) throw new Error(`cleanup left ${rows[0].n} tagged patients behind`);
}

/** merge_patients_guarded with every lock statement removed, in a throwaway schema. */
async function makeMutant(s: pg.Client): Promise<string> {
  const { rows } = await s.query(
    `select pg_get_functiondef('public.merge_patients_guarded(uuid, uuid, uuid, jsonb)'::regprocedure) as d`,
  );
  let d = rows[0].d as string;
  d = d.replace(/CREATE OR REPLACE FUNCTION public\.merge_patients_guarded/i, "CREATE OR REPLACE FUNCTION merge_proof_ctl.merge_patients_guarded");
  d = d
    .replace(/perform public\.lifecycle_lock_results\([^;]*;/g, "")
    .replace(/perform public\.lifecycle_lock\([^;]*;/g, "")
    .replace(/perform 1 from public\.patients p[\s\S]*?for no key update;/g, "");
  if (/lifecycle_lock|for no key update/i.test(d) || !/merge_proof_ctl\./.test(d)) {
    throw new Error("mutant: the function text changed shape — update makeMutant's patterns");
  }
  await s.query("create schema if not exists merge_proof_ctl");
  await s.query(d);
  return "merge_proof_ctl.merge_patients_guarded";
}

/** M1b's body, parameterised by the merge function so --control can run it against the mutant. */
async function m1b(a: Client, b: Client, s: Client, fn: string) {
  const k = await patient(s, "K");
  const src = await patient(s, "S");
  await visit(s, src);
  await b.query("begin");
  if (fn.startsWith("public.")) await asService(b);
  await mergeQ(b, k, src, fn);
  await a.query("begin");
  const p = stateOf(a.query(visitSql, [`V-${TAG}-${++seq}`, src]));
  expectEq("the visit insert waits for the merge", await stillWaiting(p), true);
  expectEq("…on the lifecycle lock", await waitingOn(s, a), "lifecycle");
  await b.query("commit");
  expectEq("the insert is refused once the source is a tombstone", await p, "P0058");
  await a.query("rollback");
  const { rows } = await s.query(`select count(*)::int as n from public.visits where patient_id = $1`, [src]);
  expectEq("nothing is stranded on the tombstone", rows[0].n, 0);
}

async function main() {
  const s = await connect();
  try {
    await seed(s);

    await race("M1a visit insert on the source first → merge waits, then moves it", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      await a.query("begin");
      const v = (await a.query(visitSql, [`V-${TAG}-${++seq}`, src])).rows[0].id as string;
      await b.query("begin");
      await asService(b);
      const p = stateOf(mergeQ(b, k, src));
      expectEq("merge waits", await stillWaiting(p), true);
      expectEq("…on the lifecycle lock", await waitingOn(sv, b), "lifecycle");
      await a.query("commit");
      expectEq("merge then succeeds", await p, "ok");
      await b.query("commit");
      expectEq("the new visit moved to keep", await ownerOf(sv, "visits", v), k);
      expectEq("source is a tombstone", await markerOf(sv, src), k);
    });

    await race("M1b merge first → a visit insert on the source waits, then P0058", (a, b, sv) =>
      m1b(a, b, sv, "public.merge_patients_guarded"));

    await race("M2 delete_patient(keep) first → merge waits, then P0058", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      const v = await visit(sv, src);
      await a.query("begin");
      await asService(a);
      await a.query(`select public.delete_patient($1, 'test_record', null, $2, null)`, [k, ADMIN]);
      await b.query("begin");
      await asService(b);
      const p = stateOf(mergeQ(b, k, src));
      expectEq("merge waits", await stillWaiting(p), true);
      expectEq("…on the lifecycle lock", await waitingOn(sv, b), "lifecycle");
      await a.query("commit");
      expectEq("merge refused: keep is deleted", await p, "P0058");
      await b.query("rollback");
      expectEq("source untouched", `${await ownerOf(sv, "visits", v)}|${await markerOf(sv, src)}`, `${src}|null`);
    });

    await race("M3 two merges of one source → the second waits, then P0058", async (a, b, sv) => {
      const k1 = await patient(sv, "K1");
      const k2 = await patient(sv, "K2");
      const src = await patient(sv, "S");
      const v = await visit(sv, src);
      await a.query("begin");
      await asService(a);
      await mergeQ(a, k1, src);
      await b.query("begin");
      await asService(b);
      const p = stateOf(mergeQ(b, k2, src));
      expectEq("second merge waits", await stillWaiting(p), true);
      await a.query("commit");
      expectEq("second merge refused", await p, "P0058");
      await b.query("rollback");
      expectEq("source merged into k1 only, visit on k1", `${await markerOf(sv, src)}|${await ownerOf(sv, "visits", v)}`, `${k1}|${k1}`);
    });

    await race("M4 A→B racing B→C → P0072, the retry re-parents A to C", async (a, b, sv) => {
      const x = await patient(sv, "X");
      const bb = await patient(sv, "B");
      const c = await patient(sv, "C");
      const vx = await visit(sv, x);
      const vb = await visit(sv, bb);
      await a.query("begin");
      await asService(a);
      await mergeQ(a, bb, x);
      await b.query("begin");
      await asService(b);
      const first = stateOf(mergeQ(b, c, bb));
      expectEq("B→C waits", await stillWaiting(first), true);
      expectEq("…on the lifecycle lock", await waitingOn(sv, b), "lifecycle");
      await a.query("commit");
      expectEq("first attempt sees the chain change", await first, "P0072");
      await b.query("rollback");
      expectEq("the retry succeeds", await withRetry(b, async (cl) => { await asService(cl); await mergeQ(cl, c, bb); }), "ok");
      expectEq("chain flattened: X→C, B→C",
        `${await markerOf(sv, x)}|${await markerOf(sv, bb)}`, `${c}|${c}`);
      expectEq("every visit on C", `${await ownerOf(sv, "visits", vx)}|${await ownerOf(sv, "visits", vb)}`, `${c}|${c}`);
    });

    await race("M5 result link on the source first → merge waits, P0072, retry succeeds", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      const v = await visit(sv, src);
      const l = await line(sv, v);
      await a.query("begin");
      const r = await result(a, [l]);
      await b.query("begin");
      await asService(b);
      const first = stateOf(mergeQ(b, k, src));
      expectEq("merge waits", await stillWaiting(first), true);
      await a.query("commit");
      expectEq("the new result is outside the locked set → P0072", await first, "P0072");
      await b.query("rollback");
      expectEq("the retry succeeds", await withRetry(b, async (cl) => { await asService(cl); await mergeQ(cl, k, src); }), "ok");
      expectEq("the linked visit moved with its result", await ownerOf(sv, "visits", v), k);
      const { rows } = await sv.query(`select count(*)::int as n from public.result_test_requests where result_id = $1`, [r]);
      expectEq("the result still links its test", rows[0].n, 1);
    });

    await race("M5b merge first → a result link on the source waits, then P0072/P0058", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      const v = await visit(sv, src);
      const l = await line(sv, v);
      await b.query("begin");
      await asService(b);
      await mergeQ(b, k, src);
      await a.query("begin");
      const p = stateOf(result(a, [l]));
      expectEq("the link waits", await stillWaiting(p), true);
      await b.query("commit");
      const st = await p;
      expectEq("the link is refused with a retryable/inactive code", st === "P0072" || st === "P0058", true);
      await a.query("rollback");
      expectEq("the app's retry then links it on keep", await withRetry(a, (cl) => result(cl, [l])), "ok");
      expectEq("the visit is on keep", await ownerOf(sv, "visits", v), k);
    });

    await race("M6 a result spanning both records → undo waits, P0072, retry refuses (split)", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      const vs = await visit(sv, src);
      const mid = await mergeCommitted(sv, k, src);
      const vk = await visit(sv, k);
      const ls = await line(sv, vs);
      const lk = await line(sv, vk);
      await a.query("begin");
      await result(a, [ls, lk]);
      await b.query("begin");
      await asService(b);
      const first = stateOf(undoQ(b, mid));
      expectEq("undo waits", await stillWaiting(first), true);
      await a.query("commit");
      expectEq("first attempt: P0072", await first, "P0072");
      await b.query("rollback");
      expectEq("retry: refused as a split result", await withRetry(b, async (cl) => { await asService(cl); await undoQ(cl, mid); }), "P0079");
      expectEq("nothing changed", `${await ownerOf(sv, "visits", vs)}|${await markerOf(sv, src)}`, `${k}|${k}`);
    });

    await race("M7 row-first visit edit vs merge — free race ×20, both converge", async (a, b, sv) => {
      let retried = 0;
      for (let i = 0; i < 20; i++) {
        const k = await patient(sv, "K");
        const src = await patient(sv, "S");
        const v = await visit(sv, src);
        const [ra, rb] = await Promise.all([
          withRetry(a, (cl) => cl.query(`update public.visits set notes = $1 where id = $2`, [`round ${i}`, v])),
          withRetry(b, async (cl) => { await asService(cl); await mergeQ(cl, k, src); }),
        ]);
        expectEq(`round ${i}: edit converged`, ra, "ok");
        expectEq(`round ${i}: merge converged`, rb, "ok");
        const { rows } = await sv.query(`select patient_id, notes from public.visits where id = $1`, [v]);
        expectEq(`round ${i}: visit on keep with the edit`, `${rows[0].patient_id}|${rows[0].notes}`, `${k}|round ${i}`);
        expectEq(`round ${i}: source merged`, await markerOf(sv, src), k);
        if (ra !== "ok" || rb !== "ok") retried++;
      }
      console.log(`  (M7: ${retried}/20 rounds needed the retry)`);
    });

    await race("M8 double undo → the second waits, then P0079", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S");
      await visit(sv, src);
      const mid = await mergeCommitted(sv, k, src);
      await a.query("begin");
      await asService(a);
      await undoQ(a, mid);
      await b.query("begin");
      await asService(b);
      const p = stateOf(undoQ(b, mid));
      expectEq("second undo waits", await stillWaiting(p), true);
      await a.query("commit");
      expectEq("second undo refused", await p, "P0079");
    });

    await race("M9 undo vs an edit of a filled field → undo waits on the row, keeps the edit", async (a, b, sv) => {
      const k = await patient(sv, "K");
      const src = await patient(sv, "S", "09170000001");
      const mid = await mergeCommitted(sv, k, src);                // fills k.phone
      await a.query("begin");
      await a.query(`update public.patients set phone = '09170000009' where id = $1`, [k]);
      await b.query("begin");
      await asService(b);
      const p = undoQ(b, mid);
      const st = stateOf(p);
      expectEq("undo waits", await stillWaiting(st), true);
      expectEq("…on the patient row", await waitingOn(sv, b), "row");
      await a.query("commit");
      expectEq("undo succeeds", await st, "ok");
      const report = (await p).rows[0].r as { kept_fields: string[] };
      await b.query("commit");
      expectEq("the edited phone is kept and reported",
        `${((await sv.query(`select phone from public.patients where id = $1`, [k])).rows[0].phone)}|${report.kept_fields.join(",")}`,
        "09170000009|phone");
    });

    if (CONTROL) {
      const fn = await makeMutant(s);
      await race("CONTROL M1b against the lock-free mutant must FAIL", async (a, b, sv) => {
        let broke = false;
        try {
          await m1b(a, b, sv, fn);
        } catch {
          broke = true;
        }
        expectEq("the proof catches a merge without locks", broke, true);
      });
    }
  } finally {
    await cleanup(s).catch((e) => console.error("cleanup failed:", (e as Error).message));
    await s.end();
  }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} races passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
```

- [ ] **Step 2: Add the npm script** in `package.json`: `"merge:concurrency-proof": "tsx scripts/merge-concurrency-proof.ts",` (after `panel-claim:concurrency-proof`).

- [ ] **Step 3: Run** (local stack, 0196 applied; sandbox disabled)

```bash
npm run -s merge:concurrency-proof -- --control > /tmp/merge-proof.log 2>&1; echo exit=$?; tail -16 /tmp/merge-proof.log
```
Expected: `exit=0`, `12/12 races passed` (11 + CONTROL). Run it twice more; the forced races must pass every time. If a forced race reports a different wait (`none`), the interleaving was not reached — fix the scenario so it waits deterministically; never loosen the assertion. A race whose outcome contradicts the spec is a SQL bug: fix 0196 first (with a smoke assertion), then re-run.

- [ ] **Step 4:** `npx vitest run scripts/lib/guard-coverage.test.ts` — Expected: PASS (the guard runs before any client).

- [ ] **Step 5: Commit** — `git add scripts/merge-concurrency-proof.ts package.json && git commit -m "test(db): two-session concurrency proof for atomic merge/undo, with a lock-free control" …`.

---
### Task 15: Documentation in the same PR

**Files:**
- Modify: `docs/drmed-user-guide.html` (entry "Merge Duplicate Patients", ~line 1119; version at ~line 250 and footer ~line 1352)
- Modify: `.claude/skills/drmed-migrations/SKILL.md` (P-code registry ~line 125; "Private-role write pattern" ~lines 127–167)
- Modify: `CLAUDE.md` ("Where things live" row that cites `undo-merge-steps`; the P-code list in "Payment-gating…" bullets; the "Patient lifecycle lock (0184)" bullet)
- Modify: `docs/superpowers/specs/2026-09-30-patient-merge-atomic-design.md` (0197 section — drop the consent-column exception)

- [ ] **Step 1: User guide.** Replace the Merge Duplicate Patients entry text (keep its markup) with:

> *Possible duplicate patients* lists likely pairs (Probable+ or Include weak). **Merge into DRM-…** moves every visit, appointment, result, consent record and lab-request upload to the surviving record in one step — if anything is in the way, nothing changes and the page says why. Details the kept record is missing (middle name, sex, phone, email, address, birthdate) are copied from the merged-in record; older records already merged into the merged-in one now point at the surviving record too. **Recently merged** lists every merge from the last 30 days: **Undo** puts back what the merge moved, keeps any detail edited on the kept record since (and says which), and leaves anything added to the kept record after the merge where it is. When Undo is not available the row says why — the kept record was merged again or deleted, or a lab result made since combines tests from both records. For a pair the detector missed, **Manual merge by DRM-ID →** opens a separate form that takes **Keep this patient** and **Merge in this patient** and asks you to type `MERGE`.

**Do not bump the version or date now** — CLAUDE.md (2026-09-30): content changes in the PR, the version/date bump (header line, footer, and the CLAUDE.md bullet) only at merge time after merging `main` into the branch (Task 18 Step 5b).

- [ ] **Step 2: `drmed-migrations` skill.**
  - P-code registry: add `P0078` (merge/undo actor not an active admin, 0196), `P0079` (merge/undo refused — message passes through, 0196), `P0080` (merge marker changed outside the merge functions — 0196 for live v2 merges, 0197 for all).
  - "Private-role write pattern": add `patient_merge_writer` (0196: owns `merge_patients_guarded` / `undo_patient_merge_guarded`) beside `patient_lifecycle_writer`, plus two lessons: **(a)** a private role granted *to* postgres gets none of postgres's rights — list and grant EXECUTE on every helper the owned functions call directly (0184 revokes its helpers from every role); trigger functions need no grant (checked at CREATE TRIGGER). **(b)** A NOBYPASSRLS owner needs a table grant *and* a role-scoped policy on every table it reads or writes; column UPDATE grants cover only the columns in a `SET` list. And the fixture rule: **write `merged_into_id` only through `patient_merge_writer`, both columns together** (0197 refuses anything else) — a future bulk data fix on `patients` must skip merged rows (0197 refuses other-column changes on them, like 0167 does for deleted rows).

- [ ] **Step 3: CLAUDE.md.**
  - "Where things live": replace `undo-merge step order` / `undo-merge-steps` in the lifecycle-retry row with a new row: `| Patient merge / undo-merge (0196): one SQL transaction each — merge_patients_guarded / undo_patient_merge_guarded (owned by patient_merge_writer, service_role-only); the TS side only parses and words the result | src/lib/patients/{merge-fields,merge-result}.ts, admin/patient-merge/actions.ts; proofs supabase/tests/0196_patient_merge_atomic_smoke.sql + npm run merge:concurrency-proof |`
  - P-code list ("in use on main: … P0077 …"): append `P0078–P0080, 0196: P0078 merge/undo actor is not an active admin, P0079 merge/undo refused (the SQL's reason passes through), P0080 merge marker changed outside the merge functions`.
  - "Patient lifecycle lock (0184)" bullet: add one sentence — `Merge and undo-merge run in SQL (0196) under exclusive locks on both records and every older tombstone, membership → patient → row; never write merged_into_id directly (0196 refuses it on a live v2 merge, 0197 everywhere).`
  - Common commands table: add `| npm run merge:concurrency-proof | Two-session races for the atomic merge/undo (0196) — 11 forced/free races + a lock-free control (--control). Local stack only |`.
  - **Do not** edit the migration-ledger line here (Task 19 does, after merge).

- [ ] **Step 4: Spec touch-up.** In the spec's "0197" section replace "except bookkeeping (`updated_at`, `row_version`) and the consent-cache columns when written by the writer" with "except bookkeeping (`updated_at`, `row_version`) — no consent exception is needed: the merge re-syncs the source before tombstoning it, and undo clears the marker before re-syncing".

- [ ] **Step 5: Commit** — `git add docs CLAUDE.md .claude/skills/drmed-migrations/SKILL.md && git commit -m "docs: atomic merge/undo in the user guide, CLAUDE.md and the migrations skill" …`.

---

### Task 16: Full verification (evidence before any claim)

- [ ] **Step 1: Rebase on current main and re-check numbers** — `git fetch -q origin && git rebase origin/main`; then from the main checkout `npm run -s claim -- list | tail -5` and `git ls-tree --name-only origin/main supabase/migrations/ | tail -3`. If main now holds a migration ≥ 0196 that is not ours, stop and tell the controller. If 0195 (session 2) landed on main, apply it locally with `psql -f` only if it is not already present.
- [ ] **Step 2: Static gates** — `npm test 2>&1 | tail -4; npm run typecheck; npm run lint 2>&1 | tail -3`. Expected: all green (the known `amend-form.test.tsx` flake passes alone). Record counts.
- [ ] **Step 3: Shared-stack DB proofs** — re-apply 0196 (`psql -f`, exit 0), then run: `0196` smoke, `0184` smoke, `0167` smoke, `0151` smoke (fixed on main by #267 — must pass now), `npm run smoke:locks`, `npm run merge:concurrency-proof -- --control`, `npm run patient-sources:db-proof`. Expected: all pass (0151 and 0183 smokes have known shared-stack issues that are not ours — do not count them as ours, but do record them).
- [ ] **Step 4: Isolated fresh replay** (NEVER reset the shared stack):

```bash
R=/private/tmp/claude-501/-Users-jamila/b66c7e3e-922b-4cbf-84c1-8e3632019348/scratchpad/replay
rm -rf $R && mkdir -p $R/supabase
cp -R supabase/migrations supabase/seed.sql supabase/config.toml $R/supabase/
cd $R && sed -i '' -e 's/^project_id = .*/project_id = "DRMed_replay3"/' \
  -e 's/5432\([0-9]\)/5632\1/g' supabase/config.toml && grep -n "port\|project_id" supabase/config.toml | head -20
supabase start --workdir $R > $R/start.log 2>&1; echo exit=$?
```
Use the same Postgres image the shared stack runs (`docker ps --format '{{.Image}}' | grep supabase/postgres | head -1`; 17.6.1.106/.111 segfault on denied-function calls — never those). Then run every smoke from Step 3 against `postgresql://postgres:postgres@127.0.0.1:56322/postgres` (`MERGE_PROOF_DB_URL`, `SMOKE_LOCKS_DB_URL` for the scripts), plus the order-equivalence check: dump `pg_get_functiondef` for `merge_patients_guarded`, `undo_patient_merge_guarded`, `recompute_patient_consent_cache`, `sync_patient_consent_state`, `guard_live_merge_marker`, `patient_has_live_v2_merge` and every 0184-owned function from both stacks and `diff` them (expected: identical). Finally `supabase stop --workdir $R --no-backup` — this stops ONLY the replay project; confirm with `docker ps | grep DRMed_replay3` (none) and `docker ps | grep supabase_db_DRMed` (still running).
- [ ] **Step 5: Mutation pass** (each must make a named check fail; revert each immediately): (a) delete `perform public.lifecycle_lock(` in merge → concurrency M1b fails; (b) drop the split-result check → smoke s7.7 fails; (c) move-back without `and patient_id = m.keep_id` → s6.1 fails (vnew moved); (d) remove `patient_drm_id = …` from the merge alert move → s3.5 fails; (e) drop `grant execute … lifecycle_lock` to the writer → s1.5/whole smoke fails; (f) remove the consent recompute from undo → s6.8 fails. Record each in the controller notes.
- [ ] **Step 6: Final whole-branch review (Sonnet)** of `git diff origin/main` against the spec; fix Critical/Important findings; re-run Steps 2–3 for anything touched.

---

### Task 17: Browser smoke (local dev, Playwright CLI)

Use the Playwright MCP / `playwright-cli` per the global rules (text first — snapshots/`evaluate`; at most two screenshots). Local dev server on port **4000** is the only localhost OAuth callback; sign in as Test Admin (`admin@drmed.ph`) as in PR 3a, or use the cookie-injection recipe from memory if OAuth will not complete.

- [ ] **Step 1:** Start the dev server from this worktree (`PORT=4000 npm run dev`), with `SUPABASE_JWT_SECRET` from `supabase status -o env`.
- [ ] **Step 2:** Seed two local test patients with a visit each (a short SQL snippet via `psql`, tagged `DRM-BRS…`; delete them at the end).
- [ ] **Step 3:** Manual merge by DRM-ID → "Merge complete" shows moved counts, the copied fields, and the Recently merged link. Check the audit page shows `patient.merged` and `patient.merge.notified`.
- [ ] **Step 4:** Possible duplicates › Recently merged → the row shows **Undo**; click Undo → "Undone ✓" with the report lines.
- [ ] **Step 5:** Merge again, delete the kept record (Admin › Patients › Delete), reload Recently merged → the row shows "Deleted record" and the reason, no Undo button. Restore it → Undo is back.
- [ ] **Step 6:** Error path: merge a pair where one record was deleted in another tab → the page shows the translated P0058 message, nothing changed.
- [ ] **Step 7:** Clean up the seeded rows (as `postgres` with `session_replication_role = replica`, only `DRM-BRS%` rows) and record the evidence in the controller notes.

---

### Task 18: PR, push 0196, owner OK, merge, deploy

- [ ] **Step 1:** Push the branch and open the PR (`gh pr create`), body: what changed (plain words first), the migration, proofs run with counts, the deploy order and the rollback note (app rollback past 3b needs a merge freeze — spec "Deploy order"), and the attribution line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 2: Cutover check on prod (read-only, Supabase MCP `execute_sql`)** — (a) every live ledger row's source still points at its keep, or is an interrupted legacy undo:

```sql
select m.id, m.merged_at, m.snapshot_version, s.merged_into_id = m.keep_id as tombstone_ok, s.merged_into_id is null as interrupted
  from patient_merges m join patients s on s.id = m.source_id where m.undone_at is null;
```
(b) the consent fold = cache query from 0196 section 9 returns 0 mismatches; (c) `select version from supabase_migrations.schema_migrations order by version desc limit 5` — confirm 0195's state and that nothing ≥ 0196 exists; (d) `pg_stat_activity` has no long idle-in-transaction sessions.
- [ ] **Step 3: Hand the user the push command** (Claude's `supabase db push` is blocked by the auto-mode classifier). From this worktree, with `supabase/.temp/{project-ref,linked-project.json,pooler-url}` copied from the main checkout:

```
! cd /Users/jamila/Claude/DRMed/.worktrees/patient-merge-atomic && supabase db push --dry-run && supabase db push
```
If the CLI reports `LegacyDbPushMissingLocalError` for a migration applied on prod but not in this tree (e.g. session 2's 0195 pushed ahead of its merge), copy that file in **untracked**, push, then remove it — never `migration repair`. The dry-run must list **only 0196**.
- [ ] **Step 4: Verify on prod by object** (read-only): role attributes + membership; both functions' owner/secdef/ACL (`has_function_privilege` for anon/authenticated/service_role); the writer's helper EXECUTE grants; `patient_merges` new columns + `uq_patient_merges_live_source`; `trg_patients_live_merge_guard` enabled; `sync_patient_consent_state` body contains `recompute_patient_consent_cache`; ledger head `0196`.
- [ ] **Step 5b: Guide version at merge time** — merge `origin/main` into the branch, then bump `docs/drmed-user-guide.html` version + date (header line and footer; append `0196` to the footer's migration list) and the CLAUDE.md guide bullet to the next number after main's; commit; re-run `npm test` for the docs tests.
- [ ] **Step 5: Owner OK** — summarise for the owner (plain words) and ask for the go-ahead to merge. Do not merge without it.
- [ ] **Step 6: Merge** with the exact full head SHA (`gh pr merge <n> --squash --match-head-commit <full sha>` — a short SHA gives a misleading "Head branch was modified"), then confirm the Vercel **Production** deployment for the merge commit is **Ready** (`gh api repos/:owner/:repo/deployments` / Vercel status) — merge ≠ deploy.
- [ ] **Step 7: Re-run the cutover query (a)** after the deploy is Ready; reconcile anything unexpected by hand.

---

### Task 19: Post-merge docs (small PR, right after the deploy is Ready)

- [ ] **Step 1:** Branch `docs/ledger-0196` off the new main.
- [ ] **Step 2:** `CLAUDE.md` migration-ledger line: prod head = **0196** (`patient_merge_atomic`, #<PR>) with the verification facts from Task 18 Step 4, keeping the existing history after it (and 0195 as session 2 left it).
- [ ] **Step 3:** User guide: only if main moved the version after Task 18 Step 5b, re-align the header/footer/CLAUDE.md bullet (the footer must name 0196).
- [ ] **Step 4:** PR, owner OK, merge, confirm the deploy is Ready.

---

## Part B — 0197 merge-marker enforcement (separate PR, only after 3b's deploy is verified)

### Task B1: Branch, pin test (red)

- [ ] **Step 1:** `git fetch -q origin && git worktree add .worktrees/merge-marker-enforcement -b feat/merge-marker-enforcement origin/main` (from the main checkout); work there. Migration number **0197** is already claimed for this.
- [ ] **Step 2: Failing pin test** `src/lib/patients/merge-marker-migration.test.ts`:

```ts
// Reads migration 0197 as text. Pins: a SECURITY INVOKER guard keyed on
// current_user = 'patient_merge_writer'; the three legal transitions; the
// merged-row edit refusal; INSERT refusal; errcodes P0080/P0058 only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0197_merge_marker_enforcement.sql"), "utf8");

describe("0197_merge_marker_enforcement.sql", () => {
  it("installs an invoker guard on patients for insert and update", () => {
    expect(sql).toMatch(/create or replace function public\.enforce_merge_marker\(\)[\s\S]*security invoker/);
    expect(sql).toContain("create trigger trg_patients_merge_marker_guard");
    expect(sql).toMatch(/before insert or update on public\.patients/);
    expect(sql).toContain("current_user <> 'patient_merge_writer'");
  });
  it("every raise outside post-conditions carries P0080 or P0058", () => {
    const body = sql.replace(/do \$assert\$[\s\S]*?\$assert\$;/g, "");
    const raises = body.match(/raise exception[\s\S]*?;/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(6);
    for (const r of raises) expect(r).toMatch(/errcode = 'P00(80|58)'/);
  });
  it("revokes the guard function from runtime roles", () => {
    expect(sql).toContain("revoke all on function public.enforce_merge_marker() from public, anon, authenticated, service_role");
  });
});
```
Run it — Expected: FAIL (file missing).

### Task B2: 0197 migration + smoke

- [ ] **Step 1: Smoke first** `supabase/tests/0197_merge_marker_enforcement_smoke.sql` — same header/guard/`begin … rollback` shape and the same helper set as the 0196 smoke (copy `mk_patient`, `mk_visit`, `mark_merged`, `merge`, `undo`, `expect`, `state_of`, `state_as`, the fixture staff rows with suffix `…000000000197`), with:

```sql
do $b$
declare k uuid; s uuid; t uuid; x uuid; mid uuid;
begin
  k := pg_temp.mk_patient('B1K'); s := pg_temp.mk_patient('B1S'); x := pg_temp.mk_patient('B1X');
  perform pg_temp.expect('b1 service_role cannot set a merge marker',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = %L, merged_at = now() where id = %L', k, s)), 'P0080');
  perform pg_temp.expect('b2 postgres cannot either',
    pg_temp.state_of(format('update public.patients set merged_into_id = %L, merged_at = now() where id = %L', k, s)), 'P0080');
  perform pg_temp.expect('b3 a patient cannot be created already merged',
    pg_temp.state_of(format($q$insert into public.patients (drm_id, first_name, last_name, birthdate, merged_into_id, merged_at) values ('DRM-B1Z', 'Z', 'Z', '1990-01-01', %L, now())$q$, k)), 'P0080');
  perform pg_temp.expect('b4 writer: marker without merged_at refused',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = %L where id = %L', k, s)), 'P0080');
  perform pg_temp.expect('b5 writer: merged_at alone refused',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_at = now() where id = %L', s)), 'P0080');
  perform pg_temp.expect('b6 lifecycle writer cannot set markers',
    (pg_temp.state_as('patient_lifecycle_writer', format('update public.patients set merged_into_id = %L, merged_at = now() where id = %L', k, s))
      in ('42501', 'P0080'))::text, 'true');
  perform pg_temp.mk_visit(s);
  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;
  perform pg_temp.expect('b7 the merge function still works', (select merged_into_id from public.patients where id = s)::text, k::text);
  perform pg_temp.expect('b8 editing a merged record is refused',
    pg_temp.state_as('service_role', format('update public.patients set phone = %L where id = %L', '09170000000', s)), 'P0058');
  perform pg_temp.expect('b9 a bookkeeping-only touch of a merged record is allowed',
    pg_temp.state_as('service_role', format('update public.patients set updated_at = now() where id = %L', s)), 'ok');
  perform pg_temp.expect('b10 service_role cannot un-merge directly',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s)), 'P0080');
  perform pg_temp.undo(mid);
  perform pg_temp.expect('b11 the undo function still works', coalesce((select merged_into_id from public.patients where id = s)::text, 'null'), 'null');
  -- chain re-parent by the writer keeps merged_at
  t := pg_temp.mk_patient('B1T');
  perform pg_temp.mark_merged(t, s);
  perform pg_temp.expect('b12 writer re-parent (merged_at unchanged) allowed',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = %L where id = %L', x, t)), 'ok');
  perform pg_temp.kill(x);
  perform pg_temp.expect('b13 a deleted record cannot be merged, even by the writer',
    (pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = %L, merged_at = now() where id = %L', k, x))
      in ('P0080', '23514'))::text, 'true');
end $b$;
```
(`pg_temp.kill` is the 0196 smoke's helper — copy it too. b13 accepts 23514 because `patients_not_deleted_and_merged` would also refuse it.)

- [ ] **Step 2: The migration** `supabase/migrations/0197_merge_marker_enforcement.sql`:

```sql
-- =============================================================================
-- 0197_merge_marker_enforcement.sql — patient-delete rollout PR 3b follow-up
-- =============================================================================
-- Merge markers (patients.merged_into_id / merged_at) now change ONLY through
-- merge_patients_guarded / undo_patient_merge_guarded (0196), which run as the
-- private role patient_merge_writer. Shipped separately, after the app that
-- calls those functions was deployed and verified (spec deploy order).
-- Legal transitions, for the writer only:
--   merge     (null, null) -> (X, t)   on a row that is not deleted
--   undo      (X, t)       -> (null, null)
--   re-parent (X, t)       -> (Y, t)   (chain flattening / restore)
-- A merged row refuses every other change except bookkeeping (P0058, like
-- 0167 does for deleted rows). INSERT of an already-merged row is refused.
-- This migration SUPERSEDES 0196's narrower rollback guard (section 5): this
-- trigger covers every merged_into_id/merged_at change, writer or not, so
-- 0196's guard_live_merge_marker + patient_has_live_v2_merge become redundant.
-- Rollback: drop trigger trg_patients_merge_marker_guard (app unaffected);
-- reverting 0197 = re-run 0196 section 5 to restore the narrower guard.
-- =============================================================================

set lock_timeout = '5s';

-- Superseded by the trigger below (Opus SQL review fix round 1, F8).
drop trigger if exists trg_patients_live_merge_guard on public.patients;
drop function if exists public.guard_live_merge_marker();
drop function if exists public.patient_has_live_v2_merge(uuid);

create or replace function public.enforce_merge_marker()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k_marker constant text[] := array['merged_into_id', 'merged_at', 'updated_at', 'row_version'];
  k_bookkeeping constant text[] := array['updated_at', 'row_version'];
begin
  if tg_op = 'INSERT' then
    if new.merged_into_id is not null or new.merged_at is not null then
      raise exception 'a patient record cannot be created already merged' using errcode = 'P0080';
    end if;
    return new;
  end if;

  if (new.merged_into_id, new.merged_at) is distinct from (old.merged_into_id, old.merged_at) then
    if current_user <> 'patient_merge_writer' then
      raise exception 'patient % can only be merged or un-merged from Admin Tools', old.drm_id
        using errcode = 'P0080';
    end if;
    if (to_jsonb(new) - k_marker) is distinct from (to_jsonb(old) - k_marker) then
      raise exception 'a merge or un-merge cannot change any other field in the same statement'
        using errcode = 'P0080';
    end if;
    if old.merged_into_id is null and new.merged_into_id is not null then
      if old.merged_at is not null or new.merged_at is null or new.deleted_at is not null then
        raise exception 'a merge sets both merge fields on an active record' using errcode = 'P0080';
      end if;
    elsif old.merged_into_id is not null and new.merged_into_id is null then
      if new.merged_at is not null then
        raise exception 'an un-merge clears both merge fields' using errcode = 'P0080';
      end if;
    elsif old.merged_into_id is not null and new.merged_into_id is not null then
      if new.merged_at is distinct from old.merged_at then
        raise exception 're-pointing a merged record keeps its merge time' using errcode = 'P0080';
      end if;
    else
      raise exception 'merged_at cannot change without a merge' using errcode = 'P0080';
    end if;
    return new;
  end if;

  if old.merged_into_id is not null
     and (to_jsonb(new) - k_bookkeeping) is distinct from (to_jsonb(old) - k_bookkeeping) then
    raise exception 'patient % was merged into another record — edit that record instead', old.drm_id
      using errcode = 'P0058';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_merge_marker() from public, anon, authenticated, service_role;

drop trigger if exists trg_patients_merge_marker_guard on public.patients;
create trigger trg_patients_merge_marker_guard
  before insert or update on public.patients
  for each row execute function public.enforce_merge_marker();

do $assert$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_patients_merge_marker_guard' and tgenabled = 'O') then
    raise exception '0197: trg_patients_merge_marker_guard missing or disabled';
  end if;
  if exists (select 1 from public.patients where (merged_into_id is null) <> (merged_at is null)) then
    raise exception '0197: existing rows have only one of merged_into_id / merged_at set — reconcile first';
  end if;
end
$assert$;

reset lock_timeout;
```

- [ ] **Step 3:** Check nothing else writes markers or edits merged rows: `grep -rn "merged_into_id\s*=" supabase/migrations/0[2-9]*.sql scripts src --include='*.sql' --include='*.ts' | grep -iv "is null\|is not null\|where\|and p\.\|select"` and `grep -n "merged_into_id" supabase/seed.sql`. Anything found → route through the writer or explain in the controller notes.
- [ ] **Step 4:** Apply locally (`psql -f`), run the 0197 smoke, then **re-run** the 0196, 0184 and 0167 smokes, `npm run merge:concurrency-proof -- --control`, `npm run smoke:locks` and `npm run patient-sources:db-proof` — all must still pass (Task 13 made the fixtures 0197-proof). Pin test PASS. `pg-errors.ts` needs no change (P0080 exists).
- [ ] **Step 5:** Opus review of the SQL; isolated replay (Task 16 Step 4 recipe) through 0197; gates.
- [ ] **Step 6:** Docs: `drmed-migrations` skill (0197 live rule), CLAUDE.md ledger line after merge, user guide footer migration list + version.

### Task B3: Ship 0197

- [ ] **Step 1:** Prod pre-check (read-only): `select count(*) from patients where (merged_into_id is null) <> (merged_at is null)` = 0.
- [ ] **Step 2:** PR; hand the user `! cd /Users/jamila/Claude/DRMed/.worktrees/merge-marker-enforcement && supabase db push --dry-run && supabase db push` (dry-run lists only 0197).
- [ ] **Step 3:** Verify by object (trigger enabled, function invoker, ACL), then a read-only probe is not possible on prod — rely on the smoke. Owner OK → merge (full SHA) → Production deploy Ready.
- [ ] **Step 4:** Update memory `drmed-patient-delete.md` (3b + 0197 closed) and the index line.

---

## Self-review (done while writing)

- Spec coverage: role + privileges (T2, T5), ledger (T2), consent fold + trigger (T2, s2), rollback guard (T2, s11), merge steps 1–11 (T3, s3–s5), undo steps 1–11 incl. R1/R2/R6/R1'/R4'/R5' (T4, s6–s10), ownership/ACL/post-conditions + fold gate (T5, s1), P-codes (T7), app callers + notice audit (T9), UI incl. badge/pager/reasons (T10), deletions + FK inventory (T11), CLI actor (T12), fixtures 0197-proof (T13), concurrency proofs M1–M9 + control (T14), docs (T15), replay + mutations (T16), browser smoke (T17), cutover + push + deploy (T18), post-merge ledger/guide (T19), 0197 (Part B).
- Known non-goals (spec "Out of scope"): merge history panel on the profile, deep-link from duplicates, audit-page rendering of merge metadata, keep/source swap — offer to the owner after merge.

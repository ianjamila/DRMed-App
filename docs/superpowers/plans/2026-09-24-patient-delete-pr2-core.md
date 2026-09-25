# Patient delete — PR 2: core soft delete, restore, active-patient rule, portal/notification cut-off — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use **Sonnet** for task subagents; Tasks 2–7 (SQL guard, blockers, RPCs, RLS helper) warrant **Opus** review.

**Goal:** Admins can delete a patient record (reason + red button, blocked while anything is open) and restore it from Admin Tools › Deleted Patients. Nothing is erased. Deleted and merged records disappear from every directory, picker, matching path, the patient portal and patient notifications, while visits, receipts, payments and reports keep working.

**Architecture:** One migration (**0167**) adds four lifecycle columns to `patients`, a private NOLOGIN role `patient_lifecycle_writer` that owns the only two functions allowed to change them (`delete_patient` / `restore_patient`), a SECURITY INVOKER guard trigger that enforces that by `current_user`, a SQL blocker evaluator (`patient_delete_blockers`) and kept-count helper, an active-only `current_patient_id()` (cuts off portal RLS for old JWTs), and active-only views (`v_patients_directory`, `v_patient_dedup_candidate_pairs`, `v_patients_without_consent`) plus an admin-only inclusive view (`v_patients_directory_admin`). The app gets one active-patient rule (`src/lib/patients/active.ts`) applied to every directory/matching query and pinned by an AST inventory test, an active-session portal gate, an active-recipient check before every patient email/SMS, app-level refusal on every write path for an inactive patient, the delete dialog, history banners, and the Deleted Patients page.

**Tech Stack:** Postgres 17 (Supabase local stack on OrbStack, `supabase_db_DRMed`), psql smoke tests in `supabase/tests/`, Next.js 16 server actions/components, vitest, sonner, Playwright MCP for the browser smoke.

**Spec:** `docs/superpowers/specs/2026-09-24-patient-delete-design.md` — rollout item 2. Out of scope here (later PRs): the shared lock protocol on child tables + child-table DB activity guards + transactional visit-creation/merge RPCs (PR 3); Show-deleted toggle, duplicates-page Delete, Possible-duplicates panel (PR 4).

---

## Facts established 2026-09-24 (read-only research; re-check at Task 0)

**Numbers.** Migration **0167** (re-checked 2026-09-24 evening after a renumbering round): 0159 `fix/retire-send-out-accrual`, 0160 on prod (`queue_claim_remarks`), 0161 `feat/payment-edit` (renaming from 0160), 0162 `feat/consent-extras`, 0163 on prod (`drm_id_width`), **0164 + 0166** `fix/retire-send-out-accrual`, **0170** `sheet-sync`, **0171** on prod + main (#220: `v_patients_directory` → authenticated SELECT only, mirrored in `seed.sql`, pinned by `patients-directory-grants.test.ts` — 0167 must not widen it); 0165 deliberately left free by that round, so this PR stays clear of it. A lower number pushed after a higher one needs `supabase db push --include-all`. P-codes (fixed by agreement between sessions, 2026-09-24): P0054 `feat/payment-edit`; **P0057–P0061 this PR**; P0062–P0064 `sheet-sync`; P0055–P0056 left unused. This PR takes **P0057–P0061**:

| Code | Meaning |
|---|---|
| P0057 | unauthorized lifecycle write (guard, non-admin actor) |
| P0058 | inactive patient (missing / deleted / merged target; edit of a deleted row) |
| P0059 | open blockers (JSON list in `DETAIL`) |
| P0060 | invalid deletion metadata (reason / note / context) |
| P0061 | invalid restore state (not deleted, or merged) |

**Schema.**
- `patients` (0001 + 0003/0011/0022/0025/0054/0055/0086/0105): no `deleted_at` today. `merged_into_id`/`merged_at` (0025) with `patients_no_self_merge`. Triggers: `trg_patients_updated_at` (BEFORE UPDATE), `trg_patients_normalise_email` / `_phone` (BEFORE INSERT OR UPDATE OF email/phone). Two other functions UPDATE patients: `maintain_repeat_patient_flag` (visits AFTER INSERT, 0011) and the consent sync (`patient_consents` insert, 0086/0087) — the new guard will therefore also refuse a new visit or consent event on a **deleted** patient at the database (good; the app refuses first with a friendlier message).
- RLS on `patients`: `"patients: staff full"` (FOR ALL to authenticated, 0151) and `"patients: patient self select"` (anon, authenticated; `id = (select current_patient_id())`). `postgres` owns the table and there is no FORCE RLS, so a postgres-owned SECURITY DEFINER function reads it without recursion.
- `staff_profiles`: `role in ('reception','medtech','pathologist','admin','xray_technician')`, `is_active`, `deleted_at` (0050).
- `audit_log`: bigserial → `public.audit_log_id_seq`; RLS on, admin SELECT policy only; `ip_address inet`.
- `current_patient_id()` (0114): plain SQL, STABLE, invoker, `search_path 'public'`; reads `app.current_patient_id` GUC or the JWT `patient_id` claim. Used by 8 tables' patient policies.
- `resolve_patient_guarded` (0158): SECURITY DEFINER, identity advisory lock, exact (lower(email), last_name, birthdate) match with **no** merged/deleted filter; service_role-only.
- `v_patients_directory` (0143 on main; 0162 on `feat/consent-extras` appends `consent_current, consent_signed_at`) — no active predicate, no revokes. `v_patient_dedup_candidate_pairs` (0106) — `active` CTE filters merged only, no grants. `v_patients_without_consent` (0150) — merged only; revoke all + grant select to authenticated (mirrored in `seed.sql`). Neither of the first two is in `hardened-views.test.ts`.
- Appointments: statuses `pending_callback, confirmed, arrived, cancelled, no_show, completed`; `scheduled_at` NULL only for `pending_callback` (0019); `patient_id` nullable (walk-ins).
- `test_requests.status`: `requested, in_progress, result_uploaded, ready_for_release, released, cancelled`; package headers `is_package_header`, components `parent_id`. Payment gate + GL bridge fire on **UPDATE** only, so smoke fixtures may INSERT lines directly at any status.
- `payments`: no patient_id (via `visit_id`); `method` includes `hmo` and may be NULL; void = `voided_at`.
- HMO (0034): `hmo_claim_items(test_request_id, batch_id, billed/paid/patient_billed/written_off_amount_php, batch_voided)`, one live item per line (`idx_hmo_claim_items_one_active_per_tr`), `hmo_claim_batches(status incl. 'voided', voided_at)`, `hmo_payment_allocations(payment_id, item_id, amount_php, voided_at)`, `hmo_claim_resolutions(destination patient_bill|write_off)`. House "open claim" = `not batch_voided` (0147). Unresolved = `billed − paid − patient_billed − written_off`.
- Local stack: PG 17, `postgres` is **not** superuser and **has** CREATEROLE — same as hosted. In PG16+, `ALTER … OWNER TO r` needs SET on `r`, and re-running `CREATE OR REPLACE` on an `r`-owned function needs INHERIT on `r`.

**App.**
- `requirePatientProfile()` (`src/lib/auth/require-patient.ts`) follows the merge chain (lines 49–58) — to be removed. The 5 portal actions in `src/app/(patient)/portal/(authenticated)/actions.ts`, `src/lib/actions/consent/portal-accept.ts` and the portal branch of `src/app/(marketing)/schedule/actions.ts` call bare `getPatientSession()`. Layout/page/book/data-export go through `requirePatientProfile()`. No `middleware.ts` exists.
- Portal login (`src/app/(patient)/portal/login/actions.ts`): patient lookup by DRM-ID with no activity filter; cookie minted after PIN success.
- Senders: `notify-released.ts`, `notify-released-bulk.ts`, `notify-appointment-booked.ts`, `notify-appointment-reminder.ts` (+ cron `src/app/api/cron/appointment-reminders/route.ts`), `/register` (2 existing-patient sends + welcome), `/find-my-id`, merge confirmation in `admin/patient-merge/actions.ts`. All send via `sendEmail`/`sendSms` in `src/lib/notifications/{email,sms}.ts`.
- 61 `.from("patients")` sites (41 src, 20 scripts). Six filter merged-only, most filter nothing. No patient query inventory test exists; `src/lib/visits/query-surfaces.test.ts` is the model.
- UI: `ConfirmDialog` lives at `admin/payroll/runs/[id]/_components/confirm-dialog.tsx` with one importer (`run-review-client.tsx`); no `confirmDisabled` prop. Sonner is mounted in the staff dashboard layout; no code uses `toast(..., { action })` yet. Only **visit detail** and **receipt** are per-record history pages with a patients embed — results and appointments are list pages, so they get a row badge instead of a banner.
- `requireAdminStaff()` redirects non-admins (never returns an error value). Server actions return `{ ok: true, data } | { ok: false, error }`.

## File map

**Database**
- Create `supabase/migrations/0167_patient_soft_delete.sql` — the whole DB change, built section by section (Tasks 2–9). Written to be **re-runnable** on the local stack during development (`if not exists`, `drop … if exists`, `create or replace`).
- Create `supabase/tests/0167_patient_soft_delete_smoke.sql` — LOCAL ONLY, `begin … rollback`, one `do` block per section, each with a negative control.
- Modify `supabase/seed.sql` — mirror the view revokes.
- Modify `src/types/database.ts` — regenerated, trimmed to this migration's objects.

**Pure libs (vitest)**
- Create `src/lib/patients/active.ts` (+ `active.test.ts`) — the active rule, `activePatients(q)`, inactive messages.
- Create `src/lib/patients/deletion.ts` (+ `deletion.test.ts`) — reasons, schema, blocker/kept-count parsing, pins against 0167.
- Create `src/lib/patients/query-surfaces.test.ts` — AST inventory of every `.from("patients")` in `src/` and `scripts/`.
- Create `src/lib/patients/active-views.test.ts` — pins the SQL predicates in 0167.
- Create `src/lib/notifications/active-patient-recipient.ts` (+ test) — the recipient decision + loader.
- Modify `src/lib/accounting/pg-errors.ts` — P0057–P0061.
- Modify `src/lib/supabase/hardened-views.test.ts` — register the four views.

**Server-only helpers / actions**
- Create `src/lib/patients/require-active.ts` — `assertPatientActive`, `assertVisitPatientActive`, `assertVisitsPatientsActive`, `assertTestRequestsPatientsActive`.
- Create `src/lib/patients/lifecycle-display.ts` — loads banner data for a patient.
- Create `src/lib/actions/patients/lifecycle.ts` — `previewPatientDeleteAction`, `deletePatientAction`, `restorePatientAction`.
- Modify `src/lib/auth/require-patient.ts` — `getActivePatientSession()`, no merge chain.

**UI**
- Move `admin/payroll/runs/[id]/_components/confirm-dialog.tsx` → `src/components/staff/confirm-dialog.tsx` (+ `confirmDisabled`).
- Create `src/components/staff/patient-delete-button.tsx`, `restore-patient-button.tsx`, `patient-lifecycle-banner.tsx`, `inactive-patient-badge.tsx`.
- Create `src/app/(staff)/staff/(dashboard)/admin/deleted-patients/page.tsx`, `src/app/api/admin/reports/deleted-patients.csv/route.ts`, `src/lib/reports/deleted-patients.ts`.
- Modify patient page, edit page, visit page, receipt, results archive, appointments list, nav config, route names.

**Docs**
- `docs/drmed-user-guide.html`, `CLAUDE.md` (ledger + P-codes), `.claude/skills/drmed-{migrations,rls-and-auth,booking-and-intake,payments,staff-ui}/SKILL.md`.

## Conventions every task follows

- Paths under `staff/` mean `src/app/(staff)/staff/(dashboard)/`.
- Apply the migration to the local stack (re-runnable):
  `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 < supabase/migrations/0167_patient_soft_delete.sql`
- Run the smoke test:
  `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/0167_patient_soft_delete_smoke.sql 2>&1 | grep -E "NOTICE|ERROR" | tail -40`
- The local stack is **shared by every worktree**. Never `supabase db reset` without the check in Task 31 (Step 3). Never run a fixture against prod (no MCP `execute_sql` fixtures).
- Every smoke section appends a `do $sN$ … $sN$;` block **before the file's final `rollback;`**, raises `notice '0167 sN.k OK: …'` per assertion, and asserts "should have failed" OUTSIDE the `begin … exception` block (see the NOTE ON SHAPE in `0147_hmo_claim_delete_guard_smoke.sql`).
- Unit tests: `npx vitest run <file>`. Gates before every commit touching TS: `npm run typecheck && npx vitest run <changed tests>`; full `npm test && npm run lint` at Tasks 17, 23, 31.
- Commits: Conventional Commits, end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Nothing is pushed until Task 33.

---

### Task 0: Preconditions and coordination

**Files:** none (git + GitHub only).

- [ ] **Step 1: PR 1 must be merged and deployed.**

```bash
export PATH="/opt/homebrew/bin:$PATH"; cd /Users/jamila/Claude/DRMed/.worktrees/patient-delete
gh pr view 216 --json state,mergedAt,mergeCommit --jq '{state,mergedAt,sha:.mergeCommit.oid}'
gh api repos/:owner/:repo/deployments --jq '[.[] | select(.environment=="Production")][0] | {sha, created_at}'
```
Expected: `state: MERGED` and the latest Production deployment's `sha` equals (or descends from) the merge commit. If #216 is still OPEN, **stop and ask the owner to merge it** — DRMed merges are done by the owner. Do not continue on an unmerged PR 1.

- [ ] **Step 2: Rebase the branch onto current main.** The branch holds only local spec/plan commits.

```bash
git fetch -q origin && git rebase origin/main && git log --oneline -8
```
Expected: the six `docs(spec)`/`docs(plan)` commits plus this plan on top of `origin/main`, which contains `0163_drm_id_width.sql`.

- [ ] **Step 3: Re-check the migration number and P-codes against every branch.** Since 2026-09-24 DRMed records claims atomically in `~/Claude/DRMed/.claims/` (`npm run -s claim -- list`, shipped with #215; before rebasing onto a main that has it, run it from `~/Claude/DRMed/.worktrees/consent-extras`). 0167 and P0057–P0061 are already claimed for `feat/patient-delete`; confirm they still are, then run the branch scan below as a second check.

```bash
for b in $(git branch -a --format='%(refname:short)' | grep -v dependabot); do f=$(git ls-tree --name-only $b supabase/migrations/ 2>/dev/null | tail -1); case "$f" in *016[0-9]_*|*017[0-9]_*) echo "$b: $f";; esac; done | sort -u
git grep -hoE "P00[5-9][0-9]" $(git branch -a --format='%(refname:short)' | grep -v dependabot) -- supabase src 2>/dev/null | sed 's/.*://' | sort | uniq -c
```
Expected: nothing above 0163 except what this plan knows about; P-codes match the agreed split (P0054 payment-edit, P0057–P0061 ours, P0062–P0064 sheet-sync). If 0167 or any of P0057–P0061 is taken, pick the next free values and replace them throughout this plan before writing code.

- [ ] **Step 4: Coordinate `v_patients_directory` with `feat/consent-extras` (#215, migration 0162).**

```bash
gh pr view 215 --json state,mergedAt --jq '{state,mergedAt}'
```
0167 re-creates the view with 0162's column list **plus** the active predicate, so it works whether or not 0162 has been applied (the two consent columns already exist on `patients`). The hazard is ordering on prod: if 0162 were pushed **after** 0167 it would silently drop the predicate. Post this comment on #215 (it is the owner's repo; the comment is the same kind left on #213):

```bash
gh pr comment 215 --body "Heads-up from feat/patient-delete (PR 2, migration 0167): 0167 re-creates v_patients_directory with 0162's columns plus \`where p.deleted_at is null and p.merged_into_id is null\`. Please push 0162 to prod BEFORE 0167 (it is lower-numbered, so a normal db push does this). If 0162 ever has to be re-applied after 0167, add the same predicate to 0162's view first, or the patient list will show deleted and merged records again."
```

- [ ] **Step 5: Link files for the later `db push`, and confirm the local stack.**

```bash
mkdir -p supabase/.temp && cp /Users/jamila/Claude/DRMed/supabase/.temp/{project-ref,linked-project.json,pooler-url} supabase/.temp/ 2>&1 | tail -2
/opt/homebrew/bin/supabase status 2>&1 | grep -E "DB URL|API URL"
docker exec supabase_db_DRMed psql -U postgres -d postgres -Atc "select max(version) from supabase_migrations.schema_migrations; select rolsuper, rolcreaterole from pg_roles where rolname='postgres';"
```
Expected: a DB URL on `127.0.0.1:54322`; `f|t` for postgres. Note the local ledger head (another worktree may have applied a later branch — that's fine, 0167 is additive; just don't reset it).

- [ ] **Step 6: Install deps if the worktree has none.** `test -d node_modules || npm ci`

---

### Task 1: Spike — prove the private-role mechanics on PG 17 (throwaway, not committed)

The whole authorization design rests on four behaviours. Prove them in a rolled-back transaction before writing the migration.

**Files:** none committed. Scratch file: `/private/tmp/claude-501/-Users-jamila/0315dc6e-9b0d-4c92-ac0d-c8157a2c45cb/scratchpad/role-spike.sql`.

- [ ] **Step 1: Write the spike.**

```sql
-- role-spike.sql — LOCAL ONLY, everything rolled back except the role itself (roles are cluster-level).
begin;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'spike_writer') then
    create role spike_writer nologin noinherit nobypassrls;
  end if;
end $$;
-- (1) postgres (non-superuser, CREATEROLE) can grant itself SET + INHERIT on a role it created.
grant spike_writer to postgres with inherit true, set true;

create table public.spike_t (id int primary key, secret text);
alter table public.spike_t enable row level security;
grant select, update (secret) on public.spike_t to spike_writer;
create policy spike_sel on public.spike_t for select to spike_writer using (true);
create policy spike_upd on public.spike_t for update to spike_writer using (true) with check (true);
insert into public.spike_t values (1, 'a');

create function public.spike_guard() returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp as $g$
begin
  if new.secret is distinct from old.secret and current_user <> 'spike_writer' then
    raise exception 'blocked for %', current_user using errcode = 'P0057';
  end if;
  return new;
end $g$;
create trigger spike_guard before update on public.spike_t for each row execute function public.spike_guard();

create function public.spike_write(v text) returns text language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $w$
begin
  update public.spike_t set secret = v where id = 1;
  return current_user;
end $w$;
-- (2) postgres can hand ownership to the private role.
alter function public.spike_write(text) owner to spike_writer;
-- (3) re-running create or replace on it still works (needs INHERIT).
create or replace function public.spike_write(v text) returns text language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $w$
begin
  update public.spike_t set secret = v where id = 1;
  return current_user;
end $w$;
revoke all on function public.spike_write(text) from public, anon, authenticated;
grant execute on function public.spike_write(text) to service_role;

set local role service_role;
select public.spike_write('b') as ran_as;                      -- expect: spike_writer
do $t$ begin
  begin
    update public.spike_t set secret = 'c' where id = 1;       -- expect: P0057 (service_role bypasses RLS, not the guard)
    raise notice 'SPIKE FAIL: service_role direct update allowed';
  exception when sqlstate 'P0057' then raise notice 'SPIKE OK: direct update blocked';
  end;
  begin
    execute 'set role spike_writer';                           -- expect: 42501
    raise notice 'SPIKE FAIL: service_role assumed the private role';
  exception when insufficient_privilege then raise notice 'SPIKE OK: cannot assume private role';
  end;
end $t$;
reset role;
select secret from public.spike_t;                             -- expect: b
rollback;
revoke spike_writer from postgres;
drop role spike_writer;
```

- [ ] **Step 2: Run it.**

Run: `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 < /private/tmp/claude-501/-Users-jamila/0315dc6e-9b0d-4c92-ac0d-c8157a2c45cb/scratchpad/role-spike.sql`
Expected: `ran_as = spike_writer`, both `SPIKE OK` notices, final `secret = b`, no errors.

- [ ] **Step 3: Decide.** If all four behaviours hold, continue. If (1) or (2) fails with a permission error, **stop and report to the controller** with the exact error — the fallback (owner-held `SECURITY DEFINER` + a signed session token) is a spec change the owner must approve. Do not improvise a GUC bypass (the spec forbids it).

---

### Task 2: Lifecycle columns, private role and the patient guard

**Files:**
- Create: `supabase/migrations/0167_patient_soft_delete.sql`
- Create: `supabase/tests/0167_patient_soft_delete_smoke.sql`

- [ ] **Step 1: Write the smoke-test skeleton + section 1 (failing).**

```sql
-- =============================================================================
-- 0167_patient_soft_delete_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after 0167 is applied:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/0167_patient_soft_delete_smoke.sql
--
-- Runs inside BEGIN … ROLLBACK and leaves no rows behind. Mints its own staff,
-- services, HMO provider and patients. Each section proves its guard with a
-- negative control. Sections:
--   s1  columns, row checks, the patient guard (who may write lifecycle fields)
--   s2  patient_kept_counts
--   s3  blockers: appointments, clinical work, non-HMO money
--   s4  blockers: HMO patient share, claims, unbilled, reconciliation
--   s5  delete_patient / restore_patient, audit, ACLs
--   s6  current_patient_id() and portal RLS
--   s7  views
--   s8  resolve_patient_guarded
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
  ('a0000000-0000-4000-8000-000000000167', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pd-admin@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000167', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pd-reception@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000167', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pd-inactive-admin@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active)
values
  ('a0000000-0000-4000-8000-000000000167', 'PD Admin', 'admin', true),
  ('a1000000-0000-4000-8000-000000000167', 'PD Reception', 'reception', true),
  ('a2000000-0000-4000-8000-000000000167', 'PD Former Admin', 'admin', false);

insert into public.services (id, code, name, price_php, kind)
values
  ('c0000000-0000-4000-8000-000000000167', 'PD-LAB', 'PD smoke lab test', 1000, 'lab_test'),
  ('c1000000-0000-4000-8000-000000000167', 'PD-CONSULT', 'PD smoke consult', 500, 'doctor_consultation');

insert into public.hmo_providers (id, name)
values ('b0000000-0000-4000-8000-000000000167', 'PD Smoke HMO');

-- Helpers (pg_temp: vanish with the session).
create function pg_temp.mk_patient(tag text) returns uuid language sql as $f$
  insert into public.patients (drm_id, first_name, last_name, birthdate, email)
  values ('DRM-PD' || tag, 'Smoke', 'Pd' || tag, '1990-01-01', 'pd' || lower(tag) || '@example.test')
  returning id;
$f$;

create function pg_temp.mk_visit(p uuid, hmo boolean, status text, total numeric, paid numeric)
returns uuid language sql as $f$
  insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php, hmo_provider_id)
  values ('V-PD-' || substr(md5(random()::text), 1, 10), p, status, total, paid,
          case when hmo then 'b0000000-0000-4000-8000-000000000167'::uuid end)
  returning id;
$f$;

create function pg_temp.mk_line(v uuid, status text, final numeric, approved numeric,
                                parent uuid default null, svc uuid default 'c0000000-0000-4000-8000-000000000167',
                                header boolean default false)
returns uuid language sql as $f$
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, hmo_approved_amount_php,
                                    parent_id, is_package_header)
  values (v, svc, status, 'a0000000-0000-4000-8000-000000000167', final, final, approved,
          parent, header)
  returning id;
$f$;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception '0167 % FAILED: got [%], want [%]', label, got, want;
  end if;
  raise notice '0167 % OK', label;
end $f$;

-- Runs sql; returns the SQLSTATE it raised, or 'ok'.
create function pg_temp.state_of(sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute sql;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- 0119 strips PUBLIC EXECUTE from every function postgres creates, temp ones
-- included, so without this a helper called after `set local role …`
-- fails with "permission denied for function". Re-run after adding helpers.
do $grant$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', f);
  end loop;
end
$grant$;

-- --- s1: columns, row checks, patient guard -----------------------------------
do $s1$
declare
  p uuid := pg_temp.mk_patient('S1A');
  q uuid := pg_temp.mk_patient('S1B');
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000167';
begin
  -- 1. INSERT carrying any deletion field is refused, whoever inserts.
  perform pg_temp.expect('s1.1 insert with deleted_at',
    pg_temp.state_of(format($q$insert into public.patients (drm_id, first_name, last_name, birthdate, deleted_at)
                             values ('DRM-PDS1X','a','b','1990-01-01', now())$q$)), 'P0057');
  perform pg_temp.expect('s1.2 insert with delete_note only',
    pg_temp.state_of(format($q$insert into public.patients (drm_id, first_name, last_name, birthdate, delete_note)
                             values ('DRM-PDS1Y','a','b','1990-01-01', 'x')$q$)), 'P0057');

  -- 2. A direct lifecycle UPDATE is refused for postgres, service_role and authenticated.
  perform pg_temp.expect('s1.3 postgres direct delete',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L,
                             delete_reason = 'duplicate' where id = %L$q$, k_admin, p)), 'P0057');
  set local role service_role;
  perform pg_temp.expect('s1.4 service_role direct delete',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L,
                             delete_reason = 'duplicate' where id = %L$q$, k_admin, p)), 'P0057');
  -- An arbitrary GUC changes nothing (the spec forbids a GUC bypass).
  perform set_config('app.patient_lifecycle', 'on', true);
  perform pg_temp.expect('s1.5 GUC does not authorize',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L,
                             delete_reason = 'duplicate' where id = %L$q$, k_admin, p)), 'P0057');
  -- The runtime roles cannot become the private role.
  perform pg_temp.expect('s1.6 service_role cannot set role',
    pg_temp.state_of('set role patient_lifecycle_writer'), '42501');
  reset role;
  set local role authenticated;
  perform pg_temp.expect('s1.7 authenticated cannot set role',
    pg_temp.state_of('set role patient_lifecycle_writer'), '42501');
  reset role;

  -- 3. Row checks hold even for the private role (independent protection).
  set local role patient_lifecycle_writer;
  perform pg_temp.expect('s1.8 deleted without actor',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), delete_reason = 'duplicate' where id = %L$q$, p)), '23514');
  perform pg_temp.expect('s1.9 bad reason',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'oops' where id = %L$q$, k_admin, p)), '23514');
  perform pg_temp.expect('s1.10 other without note',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'other' where id = %L$q$, k_admin, p)), '23514');
  perform pg_temp.expect('s1.11 untrimmed note',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'other', delete_note = ' x' where id = %L$q$, k_admin, p)), '23514');
  perform pg_temp.expect('s1.12 501-char note',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'other', delete_note = %L where id = %L$q$, k_admin, repeat('x', 501), p)), '23514');
  -- The writer may not change anything else in the same statement. Its
  -- column-level UPDATE grant stops this before the guard does (the guard's
  -- own "no other field" rule is the second line, for a future wider grant).
  perform pg_temp.expect('s1.13 writer cannot edit other fields',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'duplicate', first_name = 'Changed' where id = %L$q$, k_admin, p)), '42501');
  -- CONTROL: a valid write by the writer succeeds, so the refusals above are the guard, not a broken setup.
  perform pg_temp.expect('s1.14 CONTROL writer valid delete',
    pg_temp.state_of(format($q$update public.patients set deleted_at = now(), deleted_by = %L, delete_reason = 'duplicate' where id = %L$q$, k_admin, p)), 'ok');
  reset role;

  -- 4. A deleted row is read-only to everyone except a restore.
  perform pg_temp.expect('s1.15 edit deleted row (postgres)',
    pg_temp.state_of(format($q$update public.patients set first_name = 'X' where id = %L$q$, p)), 'P0058');
  set local role service_role;
  perform pg_temp.expect('s1.16 edit deleted row (service_role)',
    pg_temp.state_of(format($q$update public.patients set phone = '09170000000' where id = %L$q$, p)), 'P0058');
  reset role;
  -- A no-op update (e.g. the repeat-patient flag already true) is not a change.
  perform pg_temp.expect('s1.17 no-op update on deleted row',
    pg_temp.state_of(format($q$update public.patients set first_name = first_name where id = %L$q$, p)), 'ok');
  -- Deleted AND merged is impossible.
  perform pg_temp.expect('s1.18 merge a deleted row',
    pg_temp.state_of(format($q$update public.patients set merged_into_id = %L, merged_at = now() where id = %L$q$, q, p)), 'P0058');
  -- CONTROL: the same edit on an ACTIVE row succeeds.
  perform pg_temp.expect('s1.19 CONTROL edit active row',
    pg_temp.state_of(format($q$update public.patients set first_name = 'X' where id = %L$q$, q)), 'ok');

  -- 5. Restore (writer, all four cleared) is allowed.
  set local role patient_lifecycle_writer;
  perform pg_temp.expect('s1.20 writer restore',
    pg_temp.state_of(format($q$update public.patients set deleted_at = null, deleted_by = null, delete_reason = null, delete_note = null where id = %L$q$, p)), 'ok');
  reset role;

  -- 6. Structure: private role has no runtime members, guard is invoker, trigger enabled.
  perform pg_temp.expect('s1.21 no runtime membership',
    (select count(*)::text from pg_auth_members m
       join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
      where r.rolname = 'patient_lifecycle_writer'
        and u.rolname in ('authenticator', 'anon', 'authenticated', 'service_role')), '0');
  perform pg_temp.expect('s1.22 role attributes',
    (select format('%s/%s/%s', rolcanlogin, rolinherit, rolbypassrls) from pg_roles
      where rolname = 'patient_lifecycle_writer'), 'false/false/false');
  perform pg_temp.expect('s1.23 guard is invoker',
    (select prosecdef::text from pg_proc where proname = 'enforce_patient_lifecycle'), 'false');
  perform pg_temp.expect('s1.24 trigger enabled',
    (select tgenabled::text from pg_trigger where tgname = 'trg_patients_lifecycle_guard'), 'O');
end
$s1$;

rollback;
```

- [ ] **Step 2: Run it — expect failure.** Run the smoke command (Conventions).
Expected: s1.1 fails with `got [ok] … want [P0057]` or `role "patient_lifecycle_writer" does not exist` — either proves the test runs and fails.

- [ ] **Step 3: Write migration section 1.**

```sql
-- =============================================================================
-- 0167_patient_soft_delete.sql — patient soft delete, restore, active-patient rule
-- =============================================================================
-- Spec: docs/superpowers/specs/2026-09-24-patient-delete-design.md (rollout PR 2).
--
-- Admins may delete a patient record, with a reason, only while nothing is open
-- (appointments, unfinished work, unpaid money, open HMO claims). Nothing is
-- removed: the row gains deleted_at/by/reason/note and disappears from the
-- directory, pickers, matching, the portal and patient notifications; visits,
-- payments, results and reports keep it. Restore clears the four fields.
--
-- Who may change the lifecycle fields: ONLY delete_patient/restore_patient,
-- owned by the private NOLOGIN role patient_lifecycle_writer and checked by a
-- SECURITY INVOKER trigger on current_user. No GUC, JWT or service-role UPDATE
-- can set them (0125's guards validate transitions; they authorize nothing).
--
-- Written to be re-runnable during local development: every object is created
-- with if-not-exists / drop-if-exists / create-or-replace.
--
-- P-codes: P0057 unauthorized lifecycle write, P0058 inactive patient,
-- P0059 open blockers (JSON in DETAIL), P0060 invalid deletion metadata,
-- P0061 invalid restore state. Translations: src/lib/accounting/pg-errors.ts.
--
-- ORDER ON PROD: 0162 (feat/consent-extras) must be applied BEFORE this file —
-- it re-creates v_patients_directory without the active predicate.

-- ---------------------------------------------------------------------------
-- (1) The private writer role.
-- ---------------------------------------------------------------------------
do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'patient_lifecycle_writer') then
    create role patient_lifecycle_writer nologin noinherit nobypassrls;
  end if;
end
$role$;

-- The migration owner needs SET to hand function ownership over (PG16+) and
-- INHERIT to re-run create-or-replace on those functions in later migrations.
-- postgres already owns every table this role can touch, so inheriting its
-- narrower privileges grants postgres nothing new. No runtime role is ever a
-- member (asserted by the smoke test).
grant patient_lifecycle_writer to postgres with inherit true, set true;
revoke patient_lifecycle_writer from anon, authenticated, service_role;

grant usage on schema public to patient_lifecycle_writer;

-- ---------------------------------------------------------------------------
-- (2) Lifecycle columns and row checks.
-- ---------------------------------------------------------------------------
alter table public.patients
  add column if not exists deleted_at    timestamptz,
  add column if not exists deleted_by    uuid,
  add column if not exists delete_reason text,
  add column if not exists delete_note   text;

comment on column public.patients.deleted_at is
  'Soft delete (0167). Set only by delete_patient(); cleared only by restore_patient().';
comment on column public.patients.delete_reason is
  'duplicate | test_record | patient_request | other (other requires delete_note).';

-- Restrictive: deleting a staff profile must never erase who deleted a patient.
alter table public.patients drop constraint if exists patients_deleted_by_fkey;
alter table public.patients
  add constraint patients_deleted_by_fkey
  foreign key (deleted_by) references public.staff_profiles(id) on delete restrict;

alter table public.patients drop constraint if exists patients_deletion_fields_check;
alter table public.patients
  add constraint patients_deletion_fields_check check (
    (deleted_at is null and deleted_by is null and delete_reason is null and delete_note is null)
    or (
      deleted_at is not null
      and deleted_by is not null
      and delete_reason in ('duplicate', 'test_record', 'patient_request', 'other')
      and (delete_note is null
           or (delete_note = btrim(delete_note) and length(delete_note) between 1 and 500))
      and (delete_reason <> 'other' or delete_note is not null)
    )
  );

alter table public.patients drop constraint if exists patients_not_deleted_and_merged;
alter table public.patients
  add constraint patients_not_deleted_and_merged
  check (deleted_at is null or merged_into_id is null);

-- Active-directory reads and the Deleted Patients list.
create index if not exists idx_patients_active
  on public.patients (id)
  where deleted_at is null and merged_into_id is null;
create index if not exists idx_patients_deleted
  on public.patients (deleted_at desc, id)
  where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- (3) What the writer role may touch — nothing else.
-- ---------------------------------------------------------------------------
grant select on public.patients to patient_lifecycle_writer;
grant update (deleted_at, deleted_by, delete_reason, delete_note)
  on public.patients to patient_lifecycle_writer;
grant select on public.staff_profiles to patient_lifecycle_writer;
grant insert on public.audit_log to patient_lifecycle_writer;
grant usage on sequence public.audit_log_id_seq to patient_lifecycle_writer;

drop policy if exists "patients: lifecycle writer select" on public.patients;
create policy "patients: lifecycle writer select" on public.patients
  for select to patient_lifecycle_writer using (true);
drop policy if exists "patients: lifecycle writer update" on public.patients;
create policy "patients: lifecycle writer update" on public.patients
  for update to patient_lifecycle_writer using (true) with check (true);
drop policy if exists "staff_profiles: lifecycle writer select" on public.staff_profiles;
create policy "staff_profiles: lifecycle writer select" on public.staff_profiles
  for select to patient_lifecycle_writer using (true);
drop policy if exists "audit_log: lifecycle writer insert" on public.audit_log;
create policy "audit_log: lifecycle writer insert" on public.audit_log
  for insert to patient_lifecycle_writer
  with check (action in ('patient.deleted', 'patient.restored'));

-- ---------------------------------------------------------------------------
-- (4) The guard. SECURITY INVOKER so current_user is the role actually
-- writing — the delete/restore functions run as patient_lifecycle_writer.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_patient_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k_bookkeeping constant text[] :=
    array['deleted_at', 'deleted_by', 'delete_reason', 'delete_note', 'updated_at'];
  v_lifecycle_changed boolean;
  v_other_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is not null or new.deleted_by is not null
       or new.delete_reason is not null or new.delete_note is not null then
      raise exception 'a patient record cannot be created already deleted'
        using errcode = 'P0057';
    end if;
    return new;
  end if;

  v_lifecycle_changed :=
    (new.deleted_at, new.deleted_by, new.delete_reason, new.delete_note)
      is distinct from (old.deleted_at, old.deleted_by, old.delete_reason, old.delete_note);
  v_other_changed := (to_jsonb(new) - k_bookkeeping) is distinct from (to_jsonb(old) - k_bookkeeping);

  if v_lifecycle_changed then
    if current_user <> 'patient_lifecycle_writer' then
      raise exception 'only delete_patient / restore_patient can delete or restore a patient'
        using errcode = 'P0057';
    end if;
    if v_other_changed then
      raise exception 'deleting or restoring a patient cannot change any other field'
        using errcode = 'P0057';
    end if;
    return new;
  end if;

  if old.deleted_at is not null and v_other_changed then
    raise exception 'patient % is deleted — restore the record before changing it', old.drm_id
      using errcode = 'P0058';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_patient_lifecycle() from public, anon, authenticated, service_role;

drop trigger if exists trg_patients_lifecycle_guard on public.patients;
create trigger trg_patients_lifecycle_guard
  before insert or update on public.patients
  for each row execute function public.enforce_patient_lifecycle();
```

- [ ] **Step 4: Apply and run.** Apply the migration, then the smoke test (Conventions).
Expected: `0167 s1.1 OK` … `0167 s1.24 OK`, then `ROLLBACK`.

- [ ] **Step 5: Re-apply the migration once more** to prove it is re-runnable. Expected: no error.

- [ ] **Step 6: Commit.**

```bash
git add supabase/migrations/0167_patient_soft_delete.sql supabase/tests/0167_patient_soft_delete_smoke.sql
git commit -m "feat(db): patient lifecycle columns, private writer role and guard (0167, part 1)"
```

---

### Task 3: `patient_kept_counts`

**Files:** Modify migration + smoke test.

- [ ] **Step 1: Append smoke section s2 (failing).**

```sql
-- --- s2: patient_kept_counts ----------------------------------------------------
do $s2$
declare
  p uuid := pg_temp.mk_patient('S2A');
  empty uuid := pg_temp.mk_patient('S2B');
  v1 uuid; v2 uuid;
  got text;
begin
  v1 := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  v2 := pg_temp.mk_visit(p, false, 'unpaid', 0, 0);
  -- A queue-deleted visit is not "on file" for the patient page, so it is not counted.
  update public.visits set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000167',
         delete_reason = 'smoke' where id = v2;
  insert into public.payments (visit_id, amount_php, method, received_by)
  values (v1, 600, 'gcash', 'a0000000-0000-4000-8000-000000000167'),
         (v1, 400, 'gcash', 'a0000000-0000-4000-8000-000000000167');
  insert into public.appointments (patient_id, scheduled_at, status)
  values (p, now() - interval '30 days', 'completed'), (p, now() - interval '20 days', 'cancelled');
  insert into public.patient_consents (patient_id, event_type, method, notice_version, signatory, actor_kind)
  values (p, 'granted', 'paper_wet_signature', 'v1', 'self', 'staff');

  select format('%s/%s/%s/%s', visits, payments, appointments, consents) into got
    from public.patient_kept_counts(array[p]) where patient_id = p;
  perform pg_temp.expect('s2.1 counts', got, '1/2/2/1');

  select format('%s/%s/%s/%s', visits, payments, appointments, consents) into got
    from public.patient_kept_counts(array[empty]) where patient_id = empty;
  perform pg_temp.expect('s2.2 zero counts', got, '0/0/0/0');

  perform pg_temp.expect('s2.3 one row per id, unknown ids ignored',
    (select count(*)::text from public.patient_kept_counts(array[p, empty, gen_random_uuid()])), '2');

  set local role authenticated;
  perform pg_temp.expect('s2.4 authenticated cannot call',
    pg_temp.state_of(format('select * from public.patient_kept_counts(array[%L]::uuid[])', p)), '42501');
  reset role;
end
$s2$;
```
If a `patient_consents` CHECK rejects the insert, open `0086_patient_consent.sql` and supply exactly the fields its grant-shape check requires — do not weaken the assertion.

- [ ] **Step 2: Run — expect `function public.patient_kept_counts(uuid[]) does not exist`.**

- [ ] **Step 3: Append migration section 5.**

```sql
-- ---------------------------------------------------------------------------
-- (5) Kept history — what stays on file. Display enrichment only: the delete
-- dialog, the audit row, the Deleted Patients page. Counts what the patient
-- page shows (live visits, non-voided payments on them) plus every
-- appointment and consent event. SECURITY DEFINER so the service-only consent
-- ledger (0086) is counted rather than silently read as zero through RLS.
-- ---------------------------------------------------------------------------
create or replace function public.patient_kept_counts(p_patient_ids uuid[])
returns table (patient_id uuid, visits bigint, payments bigint, appointments bigint, consents bigint)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    p.id,
    (select count(*) from public.visits v
      where v.patient_id = p.id and v.deleted_at is null),
    (select count(*) from public.payments pay
       join public.visits v on v.id = pay.visit_id
      where v.patient_id = p.id and v.deleted_at is null and pay.voided_at is null),
    (select count(*) from public.appointments a where a.patient_id = p.id),
    (select count(*) from public.patient_consents c where c.patient_id = p.id)
  from public.patients p
  where p.id = any(p_patient_ids)
  order by p.id;
$$;

revoke all on function public.patient_kept_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.patient_kept_counts(uuid[]) to service_role, patient_lifecycle_writer;
```

- [ ] **Step 4: Apply + run.** Expected: `s2.1`–`s2.4 OK`.

- [ ] **Step 5: Commit.** `git commit -am "feat(db): patient_kept_counts (0167, part 2)"`

---
### Task 4: Blockers — appointments, clinical work, non-HMO money

The SQL evaluator is the only authority. The dialog reads it; `delete_patient` re-runs it under lock. Built in two tasks: this one creates the function with the non-HMO rules, Task 5 adds the HMO rules to the same function.

**Files:** Modify migration + smoke test.

- [ ] **Step 1: Append smoke section s3 (failing).** The `kinds` helper lives here, not in the shared fixture: SQL functions are validated when created, and `patient_delete_blockers` only exists from this task on.

```sql
-- --- s3: blockers — appointments, clinical, non-HMO money -----------------------
-- Sorted, comma-joined blocker kinds for a patient ('' when deletable).
create function pg_temp.kinds(p uuid) returns text language sql as $f$
  select coalesce(string_agg(b->>'kind', ',' order by b->>'kind'), '')
  from jsonb_array_elements(public.patient_delete_blockers(p)) b;
$f$;
grant execute on function pg_temp.kinds(uuid) to public;

do $s3$
declare
  k_today timestamptz := date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  p uuid; v uuid; h uuid;
begin
  -- Deletable baseline: no rows at all.
  p := pg_temp.mk_patient('S3A');
  perform pg_temp.expect('s3.1 empty patient deletable', pg_temp.kinds(p), '');

  -- Appointments: every status, dated/undated callback, today vs yesterday.
  p := pg_temp.mk_patient('S3B');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, null, 'pending_callback');
  perform pg_temp.expect('s3.2 undated callback blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3C');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, now() - interval '40 days', 'pending_callback');
  perform pg_temp.expect('s3.3 past-dated callback still blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3D');
  -- One minute after Manila midnight today: earlier than "now" for most of the day, still blocks.
  insert into public.appointments (patient_id, scheduled_at, status) values (p, k_today + interval '1 minute', 'confirmed');
  perform pg_temp.expect('s3.4 confirmed earlier today blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3E');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, k_today + interval '1 minute', 'arrived');
  perform pg_temp.expect('s3.5 arrived today blocks', pg_temp.kinds(p), 'appointment');
  p := pg_temp.mk_patient('S3F');
  -- CONTROL for s3.4: one minute BEFORE Manila midnight (yesterday in Manila, "today" in UTC for 8 hours).
  insert into public.appointments (patient_id, scheduled_at, status) values (p, k_today - interval '1 minute', 'confirmed');
  perform pg_temp.expect('s3.6 CONTROL confirmed yesterday (Manila) does not block', pg_temp.kinds(p), '');
  p := pg_temp.mk_patient('S3G');
  insert into public.appointments (patient_id, scheduled_at, status)
  values (p, now() + interval '3 days', 'cancelled'), (p, now() + interval '3 days', 'no_show'),
         (p, now() + interval '3 days', 'completed');
  perform pg_temp.expect('s3.7 cancelled/no_show/completed never block', pg_temp.kinds(p), '');
  p := pg_temp.mk_patient('S3H');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, now() + interval '5 days', 'confirmed');
  perform pg_temp.expect('s3.8 future confirmed blocks', pg_temp.kinds(p), 'appointment');

  -- Clinical: each open status blocks; released/cancelled do not.
  p := pg_temp.mk_patient('S3I');
  v := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  perform pg_temp.mk_line(v, 'requested', 1000, null);
  perform pg_temp.expect('s3.9 requested blocks (even on a paid visit)', pg_temp.kinds(p), 'clinical');
  update public.test_requests set status = 'in_progress' where visit_id = v;
  perform pg_temp.expect('s3.10 in_progress blocks', pg_temp.kinds(p), 'clinical');
  update public.test_requests set status = 'result_uploaded' where visit_id = v;
  perform pg_temp.expect('s3.11 result_uploaded blocks', pg_temp.kinds(p), 'clinical');
  update public.test_requests set status = 'ready_for_release' where visit_id = v;
  perform pg_temp.expect('s3.12 ready_for_release blocks', pg_temp.kinds(p), 'clinical');
  p := pg_temp.mk_patient('S3J');
  v := pg_temp.mk_visit(p, false, 'paid', 1500, 1500);
  perform pg_temp.mk_line(v, 'released', 1000, null);
  perform pg_temp.mk_line(v, 'cancelled', 500, null);
  perform pg_temp.expect('s3.13 CONTROL released + cancelled, paid: deletable', pg_temp.kinds(p), '');
  -- A doctor consultation is a bill line like any other.
  p := pg_temp.mk_patient('S3K');
  v := pg_temp.mk_visit(p, false, 'paid', 500, 500);
  perform pg_temp.mk_line(v, 'requested', 500, null, null, 'c1000000-0000-4000-8000-000000000164');
  perform pg_temp.expect('s3.14 open doctor line blocks', pg_temp.kinds(p), 'clinical');
  -- Package: an open header blocks; a released header with released components does not.
  p := pg_temp.mk_patient('S3L');
  v := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  h := pg_temp.mk_line(v, 'released', 1000, null, null, 'c0000000-0000-4000-8000-000000000164', true);
  perform pg_temp.mk_line(v, 'in_progress', 0, null, h);
  perform pg_temp.expect('s3.15 open package component blocks', pg_temp.kinds(p), 'clinical');
  -- Empty intake: a live visit with no live lines.
  p := pg_temp.mk_patient('S3M');
  v := pg_temp.mk_visit(p, false, 'unpaid', 0, 0);
  perform pg_temp.expect('s3.16 empty visit blocks (and its ₱0 unpaid status does too)',
    pg_temp.kinds(p), 'balance,empty_visit');
  -- Independently deleted rows do not block.
  p := pg_temp.mk_patient('S3N');
  v := pg_temp.mk_visit(p, false, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'requested', 1000, null);
  update public.visits set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000164',
         delete_reason = 'smoke' where id = v;
  perform pg_temp.expect('s3.17 queue-deleted visit (and its orphan line) do not block', pg_temp.kinds(p), '');

  -- Non-HMO money.
  p := pg_temp.mk_patient('S3O');
  v := pg_temp.mk_visit(p, false, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'released', 1000, null);
  perform pg_temp.expect('s3.18 unpaid blocks', pg_temp.kinds(p), 'balance');
  update public.visits set payment_status = 'partial', paid_php = 400 where id = v;
  perform pg_temp.expect('s3.19 partial blocks', pg_temp.kinds(p), 'balance');
  perform pg_temp.expect('s3.20 amount is the balance',
    (select b->>'amount_php' from jsonb_array_elements(public.patient_delete_blockers(p)) b), '600.00');
  update public.visits set payment_status = 'waived' where id = v;
  perform pg_temp.expect('s3.21 waived does not block', pg_temp.kinds(p), '');
  update public.visits set payment_status = 'paid', paid_php = 1000 where id = v;
  perform pg_temp.expect('s3.22 paid does not block', pg_temp.kinds(p), '');

  -- Shape: every blocker carries the six keys; links point at staff pages.
  p := pg_temp.mk_patient('S3P');
  insert into public.appointments (patient_id, scheduled_at, status) values (p, null, 'pending_callback');
  v := pg_temp.mk_visit(p, false, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'requested', 1000, null);
  perform pg_temp.expect('s3.23 keys',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(public.patient_delete_blockers(p)->0) k),
    'amount_php,href,kind,label,resource_id,visit_id');
  perform pg_temp.expect('s3.24 appointment first, deterministic order',
    (select string_agg(b->>'kind', ',') from jsonb_array_elements(public.patient_delete_blockers(p)) b),
    'appointment,clinical,balance');
  perform pg_temp.expect('s3.25 hrefs are staff routes',
    (select bool_and(b->>'href' like '/staff/%')::text from jsonb_array_elements(public.patient_delete_blockers(p)) b),
    'true');
end
$s3$;
```

- [ ] **Step 2: Run — expect `function public.patient_delete_blockers(uuid) does not exist`** (raised by the `create function pg_temp.kinds` line).

- [ ] **Step 3: Append migration section 6 (the whole function, including the HMO CTEs Task 5 tests).** Writing it once avoids a second, diverging definition; Task 5 only adds tests.

```sql
-- ---------------------------------------------------------------------------
-- (6) What stops a deletion. The single authority: the delete dialog shows
-- this list and delete_patient() re-runs it under the patient lock.
-- Returns a deterministic JSON array of
--   {kind, resource_id, visit_id, label, amount_php, href}
-- deduplicated by (kind, resource_id). kinds (pinned in deletion.test.ts):
--   appointment, clinical, empty_visit, balance, hmo_patient_share,
--   hmo_reconciliation, hmo_claim, hmo_unbilled
-- Owner-approved rules: docs/superpowers/specs/2026-09-24-patient-delete-design.md
-- "Blockers: exact database rules". Money in SQL numeric, never float.
-- VOLATILE: each call reads a fresh READ COMMITTED snapshot after the caller's lock.
-- ---------------------------------------------------------------------------
create or replace function public.patient_delete_blockers(p_patient_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
with
bounds as (
  -- Today's Manila midnight as an instant. Not now(): an appointment earlier
  -- today still blocks. Not current_date: that is the UTC day.
  select date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila' as manila_today
),
pat as (
  select p.drm_id from public.patients p where p.id = p_patient_id
),
live_visits as (
  select v.id, v.visit_number, v.payment_status, v.total_php, v.paid_php,
         v.hmo_provider_id, v.created_at
    from public.visits v
   where v.patient_id = p_patient_id
     and v.deleted_at is null
),
-- Billable lines of live HMO visits: package headers and plain lines, never
-- components (a package is priced on its header), never cancelled lines.
hmo_lines as (
  select tr.id as tr_id, v.id as visit_id, v.visit_number, v.payment_status,
         tr.final_price_php, tr.hmo_approved_amount_php,
         ci.id as item_id, ci.billed_amount_php, ci.patient_billed_amount_php
    from live_visits v
    join public.test_requests tr on tr.visit_id = v.id
    -- At most one live claim item per line (idx_hmo_claim_items_one_active_per_tr).
    left join public.hmo_claim_items ci
      on ci.test_request_id = tr.id and not ci.batch_voided
   where v.hmo_provider_id is not null
     and tr.deleted_at is null
     and tr.parent_id is null
     and tr.status <> 'cancelled'
),
-- Every live claim item on ANY line of this patient, deleted or not: a
-- receivable must never drop out through an operational filter (0147).
claim_items as (
  select ci.id, ci.batch_id, ci.billed_amount_php, ci.paid_amount_php,
         ci.patient_billed_amount_php, ci.written_off_amount_php,
         ci.billed_amount_php - ci.paid_amount_php - ci.patient_billed_amount_php
           - ci.written_off_amount_php as unresolved,
         tr.visit_id, v.visit_number,
         b.status as batch_status, b.voided_at as batch_voided_at
    from public.hmo_claim_items ci
    join public.test_requests tr on tr.id = ci.test_request_id
    join public.visits v on v.id = tr.visit_id
    join public.hmo_claim_batches b on b.id = ci.batch_id
   where v.patient_id = p_patient_id
     and not ci.batch_voided
),
recon as (
  -- (a) An HMO line whose money cannot be worked out: no price snapshot,
  -- coverage never captured (NULL is unknown, not zero), or a claim that
  -- disagrees with the approval.
  select 'hmo_reconciliation'::text as kind, l.tr_id as resource_id, l.visit_id,
         case
           when l.final_price_php is null
             then 'Visit ' || l.visit_number || ': a line has no price on file'
           when l.item_id is null
             then 'Visit ' || l.visit_number || ': HMO coverage was never recorded for a line'
           else 'Visit ' || l.visit_number || ': the HMO claim amount does not match the approved amount'
         end as label,
         null::numeric as amount_php,
         '/staff/visits/' || l.visit_id as href
    from hmo_lines l
   where l.final_price_php is null
      or (l.item_id is null and l.hmo_approved_amount_php is null and l.final_price_php > 0)
      or (l.item_id is not null and l.hmo_approved_amount_php is not null
          and l.billed_amount_php <> l.hmo_approved_amount_php)
  union all
  -- (b) A live claim line on a batch that says it is voided.
  select 'hmo_reconciliation'::text, c.id, c.visit_id,
         'Visit ' || c.visit_number || ': a claim line is still active on a voided batch',
         null::numeric, '/staff/admin/accounting/hmo-claims/batches/' || c.batch_id
    from claim_items c
   where c.batch_voided_at is not null or c.batch_status = 'voided'
  union all
  -- (c) A live allocation pointing at a voided payment or another visit's payment.
  select 'hmo_reconciliation'::text, al.id, c.visit_id,
         'Visit ' || c.visit_number || ': an HMO payment allocation points at a voided or mismatched payment',
         al.amount_php, '/staff/admin/accounting/hmo-claims/batches/' || c.batch_id
    from public.hmo_payment_allocations al
    join claim_items c on c.id = al.item_id
    join public.payments pay on pay.id = al.payment_id
   where al.voided_at is null
     and (pay.voided_at is not null or pay.visit_id <> c.visit_id)
  union all
  -- (d) An insurer payment (method 'hmo') whose live allocations do not add
  -- up to it — a half-recorded settlement is not proof of a settled claim.
  select 'hmo_reconciliation'::text, pay.id, pay.visit_id,
         'Visit ' || v.visit_number || ': an HMO payment is not fully matched to claim lines',
         pay.amount_php, '/staff/visits/' || pay.visit_id
    from public.payments pay
    join public.visits v on v.id = pay.visit_id
   where v.patient_id = p_patient_id
     and pay.method = 'hmo'
     and pay.voided_at is null
     and pay.amount_php <> coalesce((
       select sum(al.amount_php) from public.hmo_payment_allocations al
        where al.payment_id = pay.id and al.voided_at is null), 0)
),
-- Patient principal per live HMO visit whose lines are all computable:
--   sum(max(price − insurer coverage, 0))   [skipped when the visit is waived]
-- + sum(claim amounts transferred to the patient)   [waiver never clears these]
-- Coverage = the live claim's billed amount once billed, else the explicit
-- approved amount (explicit 0 = no insurer share).
share as (
  select l.visit_id,
         sum(case when l.payment_status = 'waived' then 0
                  else greatest(l.final_price_php
                                - coalesce(l.billed_amount_php, l.hmo_approved_amount_php), 0)
             end)
         + sum(coalesce(l.patient_billed_amount_php, 0)) as principal
    from hmo_lines l
   where not exists (
     select 1 from recon r where r.visit_id = l.visit_id and r.resource_id = l.tr_id
   )
   group by l.visit_id
),
-- The patient's own payments on that visit. Insurer settlements (method 'hmo')
-- are already counted once, through the claim's paid amount.
patient_paid as (
  select pay.visit_id, sum(pay.amount_php) as paid
    from public.payments pay
   where pay.visit_id in (select s.visit_id from share s)
     and pay.voided_at is null
     and pay.method is distinct from 'hmo'
   group by pay.visit_id
),
blockers as (
  select 1 as rank, 'appointment'::text as kind, a.id as resource_id, null::uuid as visit_id,
         case when a.status = 'pending_callback'
           then 'Callback request'
                || coalesce(' for ' || to_char(a.scheduled_at at time zone 'Asia/Manila', 'FMMon FMDD, YYYY'), '')
                || ' is still open'
           else initcap(a.status) || ' appointment on '
                || to_char(a.scheduled_at at time zone 'Asia/Manila', 'FMMon FMDD, YYYY FMHH12:MI AM')
         end as label,
         null::numeric as amount_php,
         '/staff/appointments?q=' || (select drm_id from pat) as href,
         coalesce(a.scheduled_at, a.created_at) as sort_at
    from public.appointments a
   cross join bounds b
   where a.patient_id = p_patient_id
     and (a.status = 'pending_callback'
          or (a.status in ('confirmed', 'arrived') and a.scheduled_at >= b.manila_today))
  union all
  select 2, 'clinical'::text, tr.id, v.id,
         coalesce(s.name, 'A line') || ' on visit ' || v.visit_number || ' is '
           || replace(tr.status, '_', ' '),
         null::numeric, '/staff/visits/' || v.id, tr.requested_at
    from live_visits v
    join public.test_requests tr on tr.visit_id = v.id
    left join public.services s on s.id = tr.service_id
   where tr.deleted_at is null
     and tr.status not in ('released', 'cancelled')
  union all
  select 2, 'empty_visit'::text, v.id, v.id,
         'Visit ' || v.visit_number || ' has nothing on it yet — finish it or remove it from the queue',
         null::numeric, '/staff/visits/' || v.id, v.created_at
    from live_visits v
   where not exists (
     select 1 from public.test_requests tr where tr.visit_id = v.id and tr.deleted_at is null
   )
  union all
  select 3, 'balance'::text, v.id, v.id,
         'Visit ' || v.visit_number || ' is ' || v.payment_status || ': ₱'
           || to_char(greatest(v.total_php - v.paid_php, 0), 'FM999,999,990.00') || ' unpaid',
         greatest(v.total_php - v.paid_php, 0), '/staff/visits/' || v.id, v.created_at
    from live_visits v
   where v.hmo_provider_id is null
     and v.payment_status in ('unpaid', 'partial')
  union all
  select 3, 'hmo_patient_share'::text, s.visit_id, s.visit_id,
         'Visit ' || v.visit_number || ': the patient''s share of ₱'
           || to_char(s.principal - coalesce(pp.paid, 0), 'FM999,999,990.00') || ' is unpaid',
         s.principal - coalesce(pp.paid, 0), '/staff/visits/' || s.visit_id, v.created_at
    from share s
    join live_visits v on v.id = s.visit_id
    left join patient_paid pp on pp.visit_id = s.visit_id
   where s.principal - coalesce(pp.paid, 0) > 0
  union all
  select 4, r.kind, r.resource_id, r.visit_id, r.label, r.amount_php, r.href, null::timestamptz
    from recon r
  union all
  select 5, 'hmo_claim'::text, c.id, c.visit_id,
         'Visit ' || c.visit_number || ': ₱' || to_char(c.unresolved, 'FM999,999,990.00')
           || ' of an HMO claim is not settled',
         c.unresolved, '/staff/admin/accounting/hmo-claims/batches/' || c.batch_id, null::timestamptz
    from claim_items c
   where c.unresolved > 0
  union all
  select 5, 'hmo_unbilled'::text, l.tr_id, l.visit_id,
         'Visit ' || l.visit_number || ': ₱' || to_char(l.hmo_approved_amount_php, 'FM999,999,990.00')
           || ' of approved HMO coverage has not been claimed',
         l.hmo_approved_amount_php, '/staff/visits/' || l.visit_id, null::timestamptz
    from hmo_lines l
   where l.item_id is null
     and coalesce(l.hmo_approved_amount_php, 0) > 0
),
deduped as (
  select distinct on (kind, resource_id) *
    from blockers
   order by kind, resource_id, rank
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'kind', kind, 'resource_id', resource_id, 'visit_id', visit_id,
      'label', label, 'amount_php', amount_php, 'href', href)
    order by rank, sort_at nulls last, kind, resource_id),
  '[]'::jsonb)
from deduped;
$$;

revoke all on function public.patient_delete_blockers(uuid) from public, anon, authenticated;
grant execute on function public.patient_delete_blockers(uuid) to service_role, patient_lifecycle_writer;
```

Note on `share`: only lines with a reconciliation problem are excluded from the arithmetic; a visit with one bad line still shows both its reconciliation blocker and the share of its good lines. `amount_php` in s3.20 renders as `600.00` because `total_php`/`paid_php` are `numeric(10,2)`.

- [ ] **Step 4: Apply + run.** Expected: `s3.1`–`s3.25 OK`.
If s3.16 fails because inserting a ₱0 unpaid visit is refused by a trigger, give the visit `total_php = 100` and keep the assertion.

- [ ] **Step 5: Mutation check (proves the tests bite).** Temporarily change `a.scheduled_at >= b.manila_today` to `a.scheduled_at >= now()` in the migration, re-apply, run: s3.4 and s3.5 must FAIL. Change `'released', 'cancelled'` to `'released', 'cancelled', 'ready_for_release'`: s3.12 must FAIL. Revert both, re-apply, run green.

- [ ] **Step 6: Commit.** `git commit -am "feat(db): patient_delete_blockers — appointments, clinical, money (0167, part 3)"`

---

### Task 5: Blockers — HMO patient share, claims, unbilled coverage, reconciliation (tests)

**Files:** Modify smoke test (the function already has these rules).

- [ ] **Step 1: Append smoke section s4.**

```sql
-- --- s4: blockers — HMO --------------------------------------------------------
do $s4$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000164';
  k_hmo   constant uuid := 'b0000000-0000-4000-8000-000000000164';
  p uuid; v uuid; l uuid; l2 uuid; h uuid; bt uuid; it uuid; pay uuid;
  amt text;
begin
  -- Helper-local: a batch per scenario.
  -- 1. Released HMO line, approved 800 of 1000, claim billed 800 and fully paid,
  --    co-pay 200 paid by the patient → deletable even though the visit stays 'unpaid' (0133).
  p := pg_temp.mk_patient('S4A');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 800);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php)
  values (bt, l, 800, 800);
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 200, 'gcash', k_admin);
  perform pg_temp.expect('s4.1 settled claim + paid co-pay: deletable despite stale unpaid', pg_temp.kinds(p), '');

  -- 2. Same, co-pay NOT paid → patient share blocks with the exact amount.
  p := pg_temp.mk_patient('S4B');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 800);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php)
  values (bt, l, 800, 800);
  perform pg_temp.expect('s4.2 unpaid co-pay blocks', pg_temp.kinds(p), 'hmo_patient_share');
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.3 co-pay amount', amt, '200.00');
  -- Partial co-pay payment leaves the rest.
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 150, 'gcash', k_admin);
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.4 partial co-pay', amt, '50.00');
  -- A voided patient payment does not count.
  update public.payments set voided_at = now(), voided_by = k_admin, void_reason = 'smoke'
   where visit_id = v and amount_php = 150;
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b;
  perform pg_temp.expect('s4.5 voided payment ignored', amt, '200.00');
  -- Waiver clears the original co-pay.
  update public.visits set payment_status = 'waived' where id = v;
  perform pg_temp.expect('s4.6 waived clears co-pay', pg_temp.kinds(p), '');

  -- 3. Claim still pending (nothing paid) → unsettled claim blocks.
  p := pg_temp.mk_patient('S4C');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'submitted') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bt, l, 1000);
  perform pg_temp.expect('s4.7 pending claim blocks', pg_temp.kinds(p), 'hmo_claim');
  -- Rejected/draft labels are not settlement.
  update public.hmo_claim_batches set status = 'rejected' where id = bt;
  perform pg_temp.expect('s4.8 rejected batch still blocks', pg_temp.kinds(p), 'hmo_claim');
  -- Written off in full → settled.
  update public.hmo_claim_items set written_off_amount_php = 1000 where batch_id = bt;
  perform pg_temp.expect('s4.9 full write-off settles', pg_temp.kinds(p), '');

  -- 4. Transfer to patient: claim resolved, but the patient now owes it.
  p := pg_temp.mk_patient('S4D');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'partial_paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php,
                                      patient_billed_amount_php)
  values (bt, l, 1000, 700, 300);
  perform pg_temp.expect('s4.10 transfer to patient blocks as patient share', pg_temp.kinds(p), 'hmo_patient_share');
  -- Waiver does NOT clear a later claim-to-patient transfer.
  update public.visits set payment_status = 'waived' where id = v;
  perform pg_temp.expect('s4.11 waiver keeps the transfer', pg_temp.kinds(p), 'hmo_patient_share');
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 300, 'gcash', k_admin);
  perform pg_temp.expect('s4.12 transfer paid: deletable', pg_temp.kinds(p), '');

  -- 5. Approved coverage never claimed → unbilled.
  p := pg_temp.mk_patient('S4E');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'released', 1000, 1000);
  perform pg_temp.expect('s4.13 approved, unclaimed blocks', pg_temp.kinds(p), 'hmo_unbilled');
  -- Explicit zero coverage = patient pays all; nothing to claim.
  p := pg_temp.mk_patient('S4F');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'released', 1000, 0);
  perform pg_temp.expect('s4.14 zero coverage: patient share only', pg_temp.kinds(p), 'hmo_patient_share');
  -- NULL coverage on a priced line is unknown, not zero.
  p := pg_temp.mk_patient('S4G');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  perform pg_temp.mk_line(v, 'released', 1000, null);
  perform pg_temp.expect('s4.15 NULL coverage needs reconciliation', pg_temp.kinds(p), 'hmo_reconciliation');

  -- 6. Voided batch: the claim is gone, the line is unbilled again.
  p := pg_temp.mk_patient('S4H');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status, voided_at, voided_by, void_reason)
  values (k_hmo, 'voided', now(), k_admin, 'smoke') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, batch_voided)
  values (bt, l, 1000, true);
  perform pg_temp.expect('s4.16 voided batch: unbilled again', pg_temp.kinds(p), 'hmo_unbilled');
  -- A live item on a voided batch is a reconciliation problem.
  update public.hmo_claim_items set batch_voided = false where batch_id = bt;
  perform pg_temp.expect('s4.17 live item on voided batch',
    pg_temp.kinds(p), 'hmo_claim,hmo_reconciliation');

  -- 7. Claim disagrees with approval.
  p := pg_temp.mk_patient('S4I');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 800);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php)
  values (bt, l, 900, 900);
  perform pg_temp.expect('s4.18 claim ≠ approval', pg_temp.kinds(p), 'hmo_reconciliation');

  -- 8. Package: components never counted twice (give one a price on purpose).
  p := pg_temp.mk_patient('S4J');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  h := pg_temp.mk_line(v, 'released', 1000, 800, null, 'c0000000-0000-4000-8000-000000000164', true);
  update public.test_requests set status = 'released' where id = h and status <> 'released';
  perform pg_temp.mk_line(v, 'released', 100, 100, h);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php, paid_amount_php)
  values (bt, h, 800, 800);
  select b->>'amount_php' into amt from jsonb_array_elements(public.patient_delete_blockers(p)) b
   where b->>'kind' = 'hmo_patient_share';
  perform pg_temp.expect('s4.19 package share uses the header only', amt, '200.00');

  -- 9. Claim on a line that was (wrongly) queue-deleted still blocks.
  p := pg_temp.mk_patient('S4K');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'submitted') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bt, l, 1000);
  -- Bypass 0147's P0050 the way history might have (direct column write as postgres in a test only).
  alter table public.test_requests disable trigger trg_test_requests_deletable_guard;
  update public.test_requests set deleted_at = now(), deleted_by = k_admin, delete_reason = 'smoke' where id = l;
  alter table public.test_requests enable trigger trg_test_requests_deletable_guard;
  perform pg_temp.expect('s4.20 claim on deleted line still blocks', pg_temp.kinds(p), 'hmo_claim');

  -- 10. Insurer payment not fully allocated → reconciliation; allocations count once.
  p := pg_temp.mk_patient('S4L');
  v := pg_temp.mk_visit(p, true, 'unpaid', 1000, 0);
  l := pg_temp.mk_line(v, 'released', 1000, 1000);
  insert into public.hmo_claim_batches (provider_id, status) values (k_hmo, 'paid') returning id into bt;
  insert into public.hmo_claim_items (batch_id, test_request_id, billed_amount_php) values (bt, l, 1000)
  returning id into it;
  insert into public.payments (visit_id, amount_php, method, received_by) values (v, 1000, 'hmo', k_admin)
  returning id into pay;
  perform pg_temp.expect('s4.21 unallocated insurer payment',
    pg_temp.kinds(p), 'hmo_claim,hmo_reconciliation');
  insert into public.hmo_payment_allocations (payment_id, item_id, amount_php) values (pay, it, 1000);
  -- The allocation trigger recomputes paid_amount_php = 1000: claim settled, payment matched,
  -- and the 'hmo' payment is NOT counted again as a patient payment.
  perform pg_temp.expect('s4.22 fully allocated: deletable', pg_temp.kinds(p), '');
  -- Voiding the insurer payment (cascade voids the allocation) reopens the claim.
  update public.payments set voided_at = now(), voided_by = k_admin, void_reason = 'smoke' where id = pay;
  perform pg_temp.expect('s4.23 voided settlement reopens the claim', pg_temp.kinds(p), 'hmo_claim');
end
$s4$;
```
Fixture mechanics: if a trigger overwrites an inserted `paid_amount_php`/`patient_billed_amount_php`/`written_off_amount_php` (0034 recomputes them from allocations/resolutions), create the matching `hmo_payment_allocations` (paired with a `method='hmo'` payment on the same visit) or `hmo_claim_resolutions` row instead of setting the column. If a payment insert needs cash-drawer or GL setup, keep `method = 'gcash'` and copy the minimal fixture from `supabase/tests/0030_op_gl_bridge_smoke.sql`. Change fixtures, never the expected kinds/amounts — those are the owner's rules. If `mk_line(..., header => true)` auto-promotes the header to `ready_for_release` (`tg_header_auto_promote`), the explicit `update … set status = 'released'` in s4.19 runs on an HMO visit, which the payment gate allows; if the GL bridge demands setup, assert s4.19 on the `hmo_patient_share` amount only (it already filters by kind).

- [ ] **Step 2: Run.** Expected `s4.1`–`s4.23 OK`. Any failure is either a fixture mechanic (fix the fixture) or a rule bug in section 6 (fix the SQL, re-apply). Do not edit an expected value without re-reading the spec's HMO rules.

- [ ] **Step 3: Mutation check.** Replace `pay.method is distinct from 'hmo'` with `true` → s4.22 must FAIL (insurer money double-counted as patient money). Remove `and not ci.batch_voided` from `hmo_lines` → s4.16 must FAIL. Revert, re-apply, green.

- [ ] **Step 4: Commit.** `git commit -am "test(db): HMO blocker matrix for patient delete (0167)"`

---

### Task 6: `delete_patient` / `restore_patient`, audit in the same transaction

**Files:** Modify migration + smoke test.

- [ ] **Step 1: Append smoke section s5 (failing).**

```sql
-- --- s5: delete_patient / restore_patient ---------------------------------------
do $s5$
declare
  k_admin     constant uuid := 'a0000000-0000-4000-8000-000000000164';
  k_reception constant uuid := 'a1000000-0000-4000-8000-000000000164';
  k_former    constant uuid := 'a2000000-0000-4000-8000-000000000164';
  ctx jsonb := '{"ip":"203.0.113.9","user_agent":"smoke"}';
  p uuid; q uuid; m uuid; v uuid; res jsonb; st text;
begin
  p := pg_temp.mk_patient('S5A');
  v := pg_temp.mk_visit(p, false, 'paid', 1000, 1000);
  perform pg_temp.mk_line(v, 'released', 1000, null);

  set local role service_role;
  -- Actor checks.
  perform pg_temp.expect('s5.1 reception actor refused',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_reception, ctx)), 'P0057');
  perform pg_temp.expect('s5.2 inactive admin refused',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_former, ctx)), 'P0057');
  perform pg_temp.expect('s5.3 null actor refused',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', null, %L)$q$, p, ctx)), 'P0057');
  -- Metadata checks.
  perform pg_temp.expect('s5.4 bad reason',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'nope', '', %L, %L)$q$, p, k_admin, ctx)), 'P0060');
  perform pg_temp.expect('s5.5 other without note',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'other', '   ', %L, %L)$q$, p, k_admin, ctx)), 'P0060');
  perform pg_temp.expect('s5.6 note too long',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'other', %L, %L, %L)$q$, p, repeat('x', 501), k_admin, ctx)), 'P0060');
  perform pg_temp.expect('s5.7 unexpected context key',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, '{"ip":"1.2.3.4","actor":"x"}')$q$, p, k_admin)), 'P0060');
  -- Target checks.
  perform pg_temp.expect('s5.8 missing patient',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, gen_random_uuid(), k_admin, ctx)), 'P0058');
  reset role;

  -- Success: returns id, drm_id and kept counts; row + audit written together.
  set local role service_role;
  res := public.delete_patient(p, 'other', '  typo in birthdate  ', k_admin, ctx);
  reset role;
  perform pg_temp.expect('s5.9 result drm_id', res->>'drm_id', 'DRM-PDS5A');
  perform pg_temp.expect('s5.10 result kept visits', res->'kept'->>'visits', '1');
  perform pg_temp.expect('s5.11 row stamped',
    (select format('%s|%s|%s', deleted_by, delete_reason, delete_note) from public.patients where id = p),
    format('%s|other|typo in birthdate', k_admin));
  perform pg_temp.expect('s5.12 audit row',
    (select format('%s|%s|%s|%s|%s', actor_id, actor_type, action, metadata->>'reason', host(ip_address))
       from public.audit_log where patient_id = p and action = 'patient.deleted'),
    format('%s|staff|patient.deleted|other|203.0.113.9', k_admin));
  perform pg_temp.expect('s5.13 audit carries kept counts',
    (select metadata->'kept'->>'visits' from public.audit_log where patient_id = p and action = 'patient.deleted'), '1');

  -- Deleting again / deleting a merged row.
  set local role service_role;
  perform pg_temp.expect('s5.14 already deleted',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_admin, ctx)), 'P0058');
  reset role;
  q := pg_temp.mk_patient('S5B');
  m := pg_temp.mk_patient('S5C');
  update public.patients set merged_into_id = q, merged_at = now() where id = m;
  set local role service_role;
  perform pg_temp.expect('s5.15 merged row cannot be deleted',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, m, k_admin, ctx)), 'P0058');
  perform pg_temp.expect('s5.16 merged row cannot be restored',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, m, k_admin, ctx)), 'P0061');
  perform pg_temp.expect('s5.17 active row cannot be restored',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, q, k_admin, ctx)), 'P0061');
  perform pg_temp.expect('s5.18 reception cannot restore',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, p, k_reception, ctx)), 'P0057');
  reset role;

  -- Blockers refuse with P0059 and the JSON list in DETAIL.
  q := pg_temp.mk_patient('S5D');
  insert into public.appointments (patient_id, scheduled_at, status) values (q, null, 'pending_callback');
  set local role service_role;
  begin
    perform public.delete_patient(q, 'duplicate', '', k_admin, ctx);
    st := 'ok';
  exception when others then
    get stacked diagnostics st = returned_sqlstate, res = pg_exception_detail;
  end;
  reset role;
  perform pg_temp.expect('s5.19 blocked with P0059', st, 'P0059');
  perform pg_temp.expect('s5.20 DETAIL is the blocker JSON', (res->0->>'kind'), 'appointment');
  perform pg_temp.expect('s5.21 blocked patient untouched',
    (select (deleted_at is null)::text from public.patients where id = q), 'true');

  -- Restore round-trip keeps the DRM-ID.
  set local role service_role;
  res := public.restore_patient(p, k_admin, ctx);
  reset role;
  perform pg_temp.expect('s5.22 restored', (select (deleted_at is null and delete_reason is null)::text
                                             from public.patients where id = p), 'true');
  perform pg_temp.expect('s5.23 same DRM-ID', (select drm_id from public.patients where id = p), 'DRM-PDS5A');
  perform pg_temp.expect('s5.24 restore audit', (select metadata->>'previous_reason' from public.audit_log
                                                   where patient_id = p and action = 'patient.restored'), 'other');

  -- Audit failure rolls the change back (no double-log, no silent success).
  revoke insert on public.audit_log from patient_lifecycle_writer;
  set local role service_role;
  perform pg_temp.expect('s5.25 audit failure aborts',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_admin, ctx)), '42501');
  reset role;
  grant insert on public.audit_log to patient_lifecycle_writer;
  perform pg_temp.expect('s5.26 CONTROL row unchanged after audit failure',
    (select (deleted_at is null)::text from public.patients where id = p), 'true');

  -- ACLs and structure.
  set local role authenticated;
  perform pg_temp.expect('s5.27 authenticated cannot delete',
    pg_temp.state_of(format($q$select public.delete_patient(%L, 'duplicate', '', %L, %L)$q$, p, k_admin, ctx)), '42501');
  reset role;
  set local role anon;
  perform pg_temp.expect('s5.28 anon cannot restore',
    pg_temp.state_of(format($q$select public.restore_patient(%L, %L, %L)$q$, p, k_admin, ctx)), '42501');
  reset role;
  perform pg_temp.expect('s5.29 owners',
    (select string_agg(p2.proname || '=' || r.rolname, ',' order by p2.proname)
       from pg_proc p2 join pg_roles r on r.oid = p2.proowner
      where p2.proname in ('delete_patient', 'restore_patient', 'patient_delete_blockers', 'patient_kept_counts')),
    'delete_patient=patient_lifecycle_writer,patient_delete_blockers=postgres,patient_kept_counts=postgres,restore_patient=patient_lifecycle_writer');
  perform pg_temp.expect('s5.30 pinned search_path',
    (select bool_and(p2.proconfig @> array['search_path=pg_catalog, public, pg_temp'])::text
       from pg_proc p2 where p2.proname in ('delete_patient', 'restore_patient', 'patient_delete_blockers',
                                            'patient_kept_counts', 'enforce_patient_lifecycle')),
    'true');
end
$s5$;
```

- [ ] **Step 2: Run — expect `function public.delete_patient(...) does not exist`.**

- [ ] **Step 3: Append migration section 7.**

```sql
-- ---------------------------------------------------------------------------
-- (7) Delete and restore. Owned by patient_lifecycle_writer (the guard's only
-- accepted current_user). service_role-only EXECUTE; the server action passes
-- the admin's id from requireAdminStaff(), never from form input, and the
-- request IP/UA as p_context (only those two keys). The audit row is written
-- here, inside the same transaction: if it fails, nothing changes.
-- Lock protocol (shared with PR 3's writers): transaction advisory lock on
-- (hashtext('patient_lifecycle'), hashtext(id)), then FOR UPDATE on the row,
-- then a fresh read of blockers.
-- ---------------------------------------------------------------------------
create or replace function public.delete_patient(
  p_patient_id uuid, p_reason text, p_note text, p_actor uuid, p_context jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_ip       inet;
  v_patient  record;
  v_blockers jsonb;
  v_kept     jsonb;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can delete a patient record' using errcode = 'P0057';
  end if;

  if p_reason is null or p_reason not in ('duplicate', 'test_record', 'patient_request', 'other') then
    raise exception 'choose a reason: duplicate, test record, requested by patient, or other'
      using errcode = 'P0060';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'add a note when the reason is Other' using errcode = 'P0060';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'the note can be at most 500 characters' using errcode = 'P0060';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))
     ) then
    raise exception 'unexpected audit context' using errcode = 'P0060';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext(p_patient_id::text));
  select p.id, p.drm_id, p.deleted_at, p.merged_into_id into v_patient
    from public.patients p where p.id = p_patient_id
     for update;
  if not found or v_patient.deleted_at is not null or v_patient.merged_into_id is not null then
    raise exception 'this patient record is not active (already deleted, merged or missing)'
      using errcode = 'P0058';
  end if;

  v_blockers := public.patient_delete_blockers(p_patient_id);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'this patient still has open items' using
      errcode = 'P0059', detail = v_blockers::text;
  end if;

  select to_jsonb(k) - 'patient_id' into v_kept
    from public.patient_kept_counts(array[p_patient_id]) k;

  update public.patients
     set deleted_at = now(), deleted_by = p_actor, delete_reason = p_reason, delete_note = v_note
   where id = p_patient_id;

  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', p_patient_id, 'patient.deleted', 'patient', p_patient_id,
          jsonb_build_object('drm_id', v_patient.drm_id, 'reason', p_reason, 'note', v_note, 'kept', v_kept),
          v_ip, nullif(p_context->>'user_agent', ''));

  return jsonb_build_object('patient_id', p_patient_id, 'drm_id', v_patient.drm_id, 'kept', v_kept);
end;
$$;

create or replace function public.restore_patient(p_patient_id uuid, p_actor uuid, p_context jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ip      inet;
  v_patient record;
  v_kept    jsonb;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can restore a patient record' using errcode = 'P0057';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))
     ) then
    raise exception 'unexpected audit context' using errcode = 'P0060';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext(p_patient_id::text));
  select p.id, p.drm_id, p.deleted_at, p.delete_reason, p.delete_note, p.merged_into_id into v_patient
    from public.patients p where p.id = p_patient_id
     for update;
  if not found then
    raise exception 'patient record not found' using errcode = 'P0058';
  end if;
  if v_patient.deleted_at is null or v_patient.merged_into_id is not null then
    raise exception 'this patient record is not deleted, so there is nothing to restore'
      using errcode = 'P0061';
  end if;

  select to_jsonb(k) - 'patient_id' into v_kept
    from public.patient_kept_counts(array[p_patient_id]) k;

  update public.patients
     set deleted_at = null, deleted_by = null, delete_reason = null, delete_note = null
   where id = p_patient_id;

  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', p_patient_id, 'patient.restored', 'patient', p_patient_id,
          jsonb_build_object('drm_id', v_patient.drm_id,
                             'previous_reason', v_patient.delete_reason,
                             'previous_note', v_patient.delete_note,
                             'deleted_at', v_patient.deleted_at,
                             'kept', v_kept),
          v_ip, nullif(p_context->>'user_agent', ''));

  return jsonb_build_object('patient_id', p_patient_id, 'drm_id', v_patient.drm_id, 'kept', v_kept);
end;
$$;

alter function public.delete_patient(uuid, text, text, uuid, jsonb) owner to patient_lifecycle_writer;
alter function public.restore_patient(uuid, uuid, jsonb) owner to patient_lifecycle_writer;

revoke all on function public.delete_patient(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.restore_patient(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.delete_patient(uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.restore_patient(uuid, uuid, jsonb) to service_role;
```

- [ ] **Step 4: Apply + run.** Expected: `s5.1`–`s5.30 OK`. (s5.25 expects `42501`: the INSERT privilege is revoked, so the RLS policy never gets a say.)

- [ ] **Step 5: Mutation check.** Move the `insert into public.audit_log` in `delete_patient` into a `begin … exception when others then null; end;` block, re-apply, run: s5.25 must FAIL. Revert, re-apply, green.

- [ ] **Step 6: Commit.** `git commit -am "feat(db): delete_patient / restore_patient under the private writer role (0167, part 4)"`

---

### Task 7: `current_patient_id()` returns only an active patient (portal RLS cut-off)

**Files:** Modify migration + smoke test.

- [ ] **Step 1: Append smoke section s6 (failing).**

```sql
-- --- s6: current_patient_id() and portal RLS ------------------------------------
do $s6$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000164';
  p uuid := pg_temp.mk_patient('S6A');
  keep uuid := pg_temp.mk_patient('S6B');
  merged uuid := pg_temp.mk_patient('S6C');
  v uuid;
begin
  v := pg_temp.mk_visit(p, false, 'paid', 0, 0);
  update public.patients set merged_into_id = keep, merged_at = now() where id = merged;

  -- The portal client is an anon JWT carrying patient_id (createPatientClient).
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', p)::text, true);
  perform pg_temp.expect('s6.1 active: own row visible', (select count(*)::text from public.patients), '1');
  perform pg_temp.expect('s6.2 active: own visit visible', (select count(*)::text from public.visits), '1');
  reset role;

  set local role service_role;
  perform public.delete_patient(p, 'test_record', '', k_admin, '{}'::jsonb);
  reset role;

  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', p)::text, true);
  perform pg_temp.expect('s6.3 deleted: helper returns null', coalesce(public.current_patient_id()::text, 'null'), 'null');
  perform pg_temp.expect('s6.4 deleted: own row hidden', (select count(*)::text from public.patients), '0');
  perform pg_temp.expect('s6.5 deleted: visits hidden', (select count(*)::text from public.visits), '0');
  -- Merged: no chain following.
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', merged)::text, true);
  perform pg_temp.expect('s6.6 merged: nothing visible', (select count(*)::text from public.patients), '0');
  -- CONTROL: the surviving record still works.
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', keep)::text, true);
  perform pg_temp.expect('s6.7 CONTROL keep visible', (select count(*)::text from public.patients), '1');
  reset role;

  -- Restore honours still-valid tokens again.
  set local role service_role;
  perform public.restore_patient(p, k_admin, '{}'::jsonb);
  reset role;
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon', 'patient_id', p)::text, true);
  perform pg_temp.expect('s6.8 restored: visible again', (select count(*)::text from public.patients), '1');
  reset role;

  -- Staff history is untouched: an admin JWT still reads the deleted row.
  set local role service_role;
  perform public.delete_patient(p, 'test_record', '', k_admin, '{}'::jsonb);
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', k_admin)::text, true);
  perform pg_temp.expect('s6.9 staff still read the deleted record',
    (select count(*)::text from public.patients where id = p), '1');
  reset role;

  perform pg_temp.expect('s6.10 helper is definer, pinned',
    (select format('%s|%s', prosecdef, proconfig) from pg_proc where proname = 'current_patient_id'),
    'true|{"search_path=pg_catalog, public, pg_temp"}');
  perform pg_temp.expect('s6.11 helper anon-executable',
    has_function_privilege('anon', 'public.current_patient_id()', 'execute')::text, 'true');
end
$s6$;
```
`auth.uid()` reads `request.jwt.claims ->> 'sub'`; if `has_role` needs `request.jwt.claim.sub` on this stack instead, set both.

- [ ] **Step 2: Run — expect s6.3 to FAIL** (`got [<uuid>] want [null]`).

- [ ] **Step 3: Append migration section 8.**

```sql
-- ---------------------------------------------------------------------------
-- (8) The portal identity helper returns a patient ONLY while that record is
-- active. Every patient RLS policy (0114/0151) calls it, so an already-issued
-- portal JWT for a deleted or merged record reads nothing — without touching
-- staff policies. No merge-following. SECURITY DEFINER owned by the migration
-- owner, which owns patients and is not subject to its RLS (no FORCE), so the
-- lookup cannot recurse into "patients: patient self select". Takes no
-- argument, so it cannot be used to probe arbitrary ids.
-- ---------------------------------------------------------------------------
create or replace function public.current_patient_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p.id
    from public.patients p
   where p.id = coalesce(
           nullif(current_setting('app.current_patient_id', true), '')::uuid,
           nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'patient_id', '')::uuid)
     and p.deleted_at is null
     and p.merged_into_id is null;
$$;

-- Must stay executable by every role whose policies call it (drmed-migrations).
revoke all on function public.current_patient_id() from public;
grant execute on function public.current_patient_id() to anon, authenticated, service_role;
```

- [ ] **Step 4: Apply + run.** Expected `s6.1`–`s6.11 OK`.

- [ ] **Step 5: Commit.** `git commit -am "feat(db): current_patient_id() only returns an active patient (0167, part 5)"`

---
### Task 8: Active-only views + the admin-only inclusive view

**Files:**
- Modify: migration, smoke test, `supabase/seed.sql`, `src/lib/supabase/hardened-views.test.ts`

- [ ] **Step 1: Confirm the consumers before changing ACLs.**

Run: `grep -rln "v_patient_dedup_candidate_pairs\|v_patients_directory\|v_patients_without_consent" src scripts | grep -v database.ts`
Expected: `patients/page.tsx` (RLS client → keeps authenticated SELECT), `src/lib/patients/find-duplicates.ts` (admin client → the dedup view can go service_role-only), `src/lib/reports/patients-without-consent.ts`. If anything else reads the dedup view with a non-admin client, keep `authenticated` on it and note why in the migration comment.

- [ ] **Step 2: Append smoke section s7 (failing).**

```sql
-- --- s7: views -----------------------------------------------------------------
do $s7$
declare
  k_admin     constant uuid := 'a0000000-0000-4000-8000-000000000164';
  k_reception constant uuid := 'a1000000-0000-4000-8000-000000000164';
  live uuid := pg_temp.mk_patient('S7A');
  gone uuid := pg_temp.mk_patient('S7B');
  keep uuid := pg_temp.mk_patient('S7C');
  merged uuid := pg_temp.mk_patient('S7D');
begin
  -- gone and live share an email so they would pair in the dedup view.
  update public.patients set email = 'pds7a@example.test' where id = gone;
  update public.patients set merged_into_id = keep, merged_at = now() where id = merged;
  set local role service_role;
  perform public.delete_patient(gone, 'duplicate', '', k_admin, '{}'::jsonb);
  reset role;

  -- Directory: only active rows.
  perform pg_temp.expect('s7.1 directory hides deleted and merged',
    (select string_agg(drm_id, ',' order by drm_id) from public.v_patients_directory
      where drm_id like 'DRM-PDS7%'), 'DRM-PDS7A,DRM-PDS7C');
  -- Consent worklist: only active rows.
  perform pg_temp.expect('s7.2 without-consent hides deleted and merged',
    (select string_agg(drm_id, ',' order by drm_id) from public.v_patients_without_consent
      where drm_id like 'DRM-PDS7%'), 'DRM-PDS7A,DRM-PDS7C');
  -- Dedup pairs: a deleted row never pairs.
  perform pg_temp.expect('s7.3 dedup ignores deleted',
    (select count(*)::text from public.v_patient_dedup_candidate_pairs
      where id_a in (live, gone) or id_b in (live, gone)), '0');

  -- Admin inclusive view: deleted included, merged excluded, admin only.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', k_admin)::text, true);
  perform pg_temp.expect('s7.4 admin sees deleted + active, not merged',
    (select string_agg(drm_id || ':' || (deleted_at is not null)::text, ',' order by drm_id)
       from public.v_patients_directory_admin where drm_id like 'DRM-PDS7%'),
    'DRM-PDS7A:false,DRM-PDS7B:true,DRM-PDS7C:false');
  perform pg_temp.expect('s7.5 admin view carries the actor name',
    (select deleted_by_name from public.v_patients_directory_admin where id = gone), 'PD Admin');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', k_reception)::text, true);
  perform pg_temp.expect('s7.6 reception gets no rows from the admin view',
    (select count(*)::text from public.v_patients_directory_admin), '0');
  -- CONTROL: reception still reads the active directory.
  perform pg_temp.expect('s7.7 CONTROL reception reads the directory',
    (select count(*)::text from public.v_patients_directory where id = live), '1');
  reset role;

  -- ACLs and reloptions.
  perform pg_temp.expect('s7.8 anon has no SELECT on any patient view',
    (select string_agg(v || '=' || has_table_privilege('anon', 'public.' || v, 'select')::text, ',' order by v)
       from unnest(array['v_patients_directory', 'v_patients_directory_admin',
                         'v_patient_dedup_candidate_pairs', 'v_patients_without_consent']) v),
    'v_patient_dedup_candidate_pairs=false,v_patients_directory=false,v_patients_directory_admin=false,v_patients_without_consent=false');
  perform pg_temp.expect('s7.9 dedup view is service_role-only',
    format('%s/%s', has_table_privilege('authenticated', 'public.v_patient_dedup_candidate_pairs', 'select'),
                    has_table_privilege('service_role', 'public.v_patient_dedup_candidate_pairs', 'select')),
    'false/true');
  perform pg_temp.expect('s7.10 admin view: authenticated only',
    format('%s/%s', has_table_privilege('authenticated', 'public.v_patients_directory_admin', 'select'),
                    has_table_privilege('service_role', 'public.v_patients_directory_admin', 'select')),
    'true/false');
  perform pg_temp.expect('s7.11 every patient view is security_invoker',
    (select bool_and(c.reloptions @> array['security_invoker=true'])::text from pg_class c
      where c.oid in ('public.v_patients_directory'::regclass, 'public.v_patients_directory_admin'::regclass,
                      'public.v_patient_dedup_candidate_pairs'::regclass, 'public.v_patients_without_consent'::regclass)),
    'true');
end
$s7$;
```
Note for s7.8–s7.10 on the shared local stack: `seed.sql`'s blanket grants run only on `db reset`, so after a plain re-apply the ACL assertions reflect the migration. Task 31's reset re-checks them with `seed.sql` in effect.

- [ ] **Step 3: Run — expect s7.1 to FAIL** (deleted/merged rows visible).

- [ ] **Step 4: Append migration section 9.**

```sql
-- ---------------------------------------------------------------------------
-- (9) Views. One active rule for every directory surface: not deleted, not
-- merged (merged tombstones used to leak into the staff list). History reads
-- (visits, receipts, reports) join patients directly and are NOT filtered.
-- create or replace view REPLACES reloptions, so security_invoker is restated
-- on every one (hardened-views.test.ts). Grants survive a replace; they are
-- restated anyway, after revoking the blanket defaults.
-- ---------------------------------------------------------------------------

-- Patients list. Column list = 0162's (consent columns LAST); this file only
-- adds the WHERE. 0162 must reach prod before this migration.
create or replace view public.v_patients_directory
with (security_invoker = true) as
  select
    p.id,
    p.drm_id,
    p.first_name,
    p.middle_name,
    p.last_name,
    p.phone,
    p.email,
    p.pre_registered,
    p.created_at,
    p.referral_source,
    rs.label                       as referral_source_label,
    lv.last_visit_date,
    p.consent_current,
    p.consent_signed_at
  from public.patients p
  left join public.referral_sources rs
    on rs.id = p.referral_source
  left join lateral (
    select max(v.visit_date) as last_visit_date
    from public.visits v
    where v.patient_id = p.id
      and v.deleted_at is null      -- soft delete: never count a deleted visit
  ) lv on true
  where p.deleted_at is null
    and p.merged_into_id is null;

comment on view public.v_patients_directory is
  'Patients list: ACTIVE patients only (not deleted, not merged — 0167), with referral-source label, last visit date and consent status. security_invoker — RLS on patients/visits still applies.';

-- ACL as 0171 left it (authenticated SELECT only); restated, never widened.
revoke all on public.v_patients_directory from public, anon, authenticated;
grant select on public.v_patients_directory to authenticated;

-- Admin-only inclusive source: the same directory plus deleted rows and who
-- deleted them. Merged rows stay out. Non-admins get zero rows (not an error)
-- because of the has_role predicate; service_role gets no grant — read it with
-- the RLS staff client after requireAdminStaff().
create or replace view public.v_patients_directory_admin
with (security_invoker = true) as
  select
    p.id,
    p.drm_id,
    p.first_name,
    p.middle_name,
    p.last_name,
    p.phone,
    p.email,
    p.pre_registered,
    p.created_at,
    p.referral_source,
    rs.label                       as referral_source_label,
    lv.last_visit_date,
    p.consent_current,
    p.consent_signed_at,
    p.deleted_at,
    p.deleted_by,
    sp.full_name                   as deleted_by_name,
    p.delete_reason,
    p.delete_note
  from public.patients p
  left join public.referral_sources rs
    on rs.id = p.referral_source
  left join public.staff_profiles sp
    on sp.id = p.deleted_by
  left join lateral (
    select max(v.visit_date) as last_visit_date
    from public.visits v
    where v.patient_id = p.id
      and v.deleted_at is null
  ) lv on true
  where p.merged_into_id is null
    and (select public.has_role(array['admin']));

comment on view public.v_patients_directory_admin is
  'Admin-only patients source that INCLUDES deleted records (Admin Tools › Deleted Patients; PR 4 Show deleted). Excludes merged. Zero rows for non-admins. security_invoker.';

revoke all on public.v_patients_directory_admin from public, anon, authenticated, service_role;
grant select on public.v_patients_directory_admin to authenticated;

-- Duplicate candidates: both sides active. Every caller uses the admin client.
create or replace view public.v_patient_dedup_candidate_pairs
with (security_invoker = true) as
with active as (
  select id, drm_id, first_name, last_name, middle_name, birthdate, email,
         phone_normalized, address, sex,
         (legacy_import_run_id is not null) as is_legacy, created_at
  from public.patients
  where merged_into_id is null
    and deleted_at is null
),
pairs as (
  select a.id as id_a, b.id as id_b
  from active a join active b
    on a.id < b.id and a.email is not null and a.email = b.email
  union
  select a.id, b.id
  from active a join active b
    on a.id < b.id and a.phone_normalized is not null
       and a.phone_normalized = b.phone_normalized
  union
  select a.id, b.id
  from active a join active b
    on a.id < b.id and a.birthdate is not null and a.birthdate = b.birthdate
       and lower(trim(a.last_name)) = lower(trim(b.last_name))
)
select
  p.id_a, p.id_b,
  a.drm_id as a_drm_id, a.first_name as a_first_name, a.last_name as a_last_name,
  a.middle_name as a_middle_name, a.birthdate as a_birthdate, a.email as a_email,
  a.phone_normalized as a_phone_normalized, a.address as a_address, a.sex as a_sex,
  a.is_legacy as a_is_legacy, a.created_at as a_created_at,
  b.drm_id as b_drm_id, b.first_name as b_first_name, b.last_name as b_last_name,
  b.middle_name as b_middle_name, b.birthdate as b_birthdate, b.email as b_email,
  b.phone_normalized as b_phone_normalized, b.address as b_address, b.sex as b_sex,
  b.is_legacy as b_is_legacy, b.created_at as b_created_at
from pairs p
join active a on a.id = p.id_a
join active b on b.id = p.id_b;

revoke all on public.v_patient_dedup_candidate_pairs from public, anon, authenticated;
grant select on public.v_patient_dedup_candidate_pairs to service_role;

-- Consent worklist: body of 0150, plus the deleted_at predicate.
create or replace view public.v_patients_without_consent
with (security_invoker = true) as
select
  p.id,
  p.drm_id,
  p.first_name,
  p.last_name,
  p.phone,
  p.email,
  p.pre_registered,
  nullif(concat_ws(', ', n.last_name, n.first_name), '') as patient_name,
  (case when coalesce(p.phone, '') <> '' then 1 else 0 end
   + case when coalesce(p.email, '') <> '' then 1 else 0 end) as contact_score,
  coalesce(v.visit_count, 0::bigint) as visit_count,
  v.last_visit_at
from public.patients p
cross join lateral (
  select
    nullif(btrim(p.last_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') as last_name,
    nullif(btrim(p.first_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') as first_name
) n
left join (
  select
    patient_id,
    count(*) as visit_count,
    max(visit_date) as last_visit_at
  from public.visits
  where deleted_at is null
  group by patient_id
) v on v.patient_id = p.id
where p.consent_current = false
  and p.merged_into_id is null
  and p.deleted_at is null;

comment on view public.v_patients_without_consent is
  'Active patients (not merged, not deleted — 0167) lacking current consent, with live visit count and last Manila visit date. Invoker RLS; shared by the admin report and CSV.';

revoke all on public.v_patients_without_consent from public, anon, authenticated;
grant select on public.v_patients_without_consent to authenticated;
```
Before pasting the consent view, diff its body against `supabase/migrations/0150_patients_without_consent_report.sql` — the only change must be the added `and p.deleted_at is null` and the comment. If 0162 or a later migration on main has redefined it, start from that body instead.

- [ ] **Step 5: Mirror the revokes in `supabase/seed.sql`.** Append after the 0155 block:

```sql
-- 0167: patient views (the directory view's mirror already exists from 0171 —
-- do not duplicate it). The dedup view is service_role-only; the admin
-- inclusive view is authenticated-only (its WHERE limits it to admins).
revoke all on public.v_patients_directory_admin from public, anon, authenticated, service_role;
grant select on public.v_patients_directory_admin to authenticated;
revoke all on public.v_patient_dedup_candidate_pairs from public, anon, authenticated;
grant select on public.v_patient_dedup_candidate_pairs to service_role;
```

- [ ] **Step 6: Register the views in `src/lib/supabase/hardened-views.test.ts`.** Add to `HARDENED` (keep an existing `v_patients_directory: "0162"` entry if 0162 already added one — it still guards every later redefinition, including this one):

```ts
  v_patients_directory: "0167",
  v_patients_directory_admin: "0167",
  v_patient_dedup_candidate_pairs: "0167",
```
and add the three names, in sorted position, to the pinned list in `"pins the set of views under guard"`.

Run: `npx vitest run src/lib/supabase/hardened-views.test.ts`
Expected: PASS.

- [ ] **Step 7: Apply + run the smoke test.** Expected `s7.1`–`s7.11 OK`.

- [ ] **Step 8: Commit.**

```bash
git add supabase/migrations/0167_patient_soft_delete.sql supabase/tests/0167_patient_soft_delete_smoke.sql supabase/seed.sql src/lib/supabase/hardened-views.test.ts
git commit -m "feat(db): active-only patient views + admin inclusive directory (0167, part 6)"
```

---

### Task 9: `resolve_patient_guarded` matches only active patients

A deleted identity that books or registers again gets a **fresh** record (owner decision 5). The identity advisory lock (0158) stays first; the full lifecycle-lock re-read is PR 3.

**Files:** Modify migration + smoke test.

- [ ] **Step 1: Append smoke section s8 (failing).**

```sql
-- --- s8: resolve_patient_guarded -------------------------------------------------
do $s8$
declare
  k_admin constant uuid := 'a0000000-0000-4000-8000-000000000164';
  fields jsonb := '{"first_name":"Res","last_name":"Olve","birthdate":"1991-02-06","email":"pds8@example.test"}';
  first_id uuid; r record; r2 record; merged_src uuid; keep uuid;
begin
  set local role service_role;
  select * into r from public.resolve_patient_guarded('pds8@example.test', 'Olve', '1991-02-06', fields);
  first_id := r.id;
  select * into r from public.resolve_patient_guarded('PDS8@example.test', 'Olve', '1991-02-06', fields);
  reset role;
  perform pg_temp.expect('s8.1 CONTROL active identity is reused', format('%s/%s', r.id = first_id, r.reused), 'true/true');

  set local role service_role;
  perform public.delete_patient(first_id, 'test_record', '', k_admin, '{}'::jsonb);
  select * into r from public.resolve_patient_guarded('pds8@example.test', 'Olve', '1991-02-06', fields);
  select * into r2 from public.resolve_patient_guarded('pds8@example.test', 'Olve', '1991-02-06', fields);
  reset role;
  perform pg_temp.expect('s8.2 deleted identity gets a fresh record', format('%s/%s', r.id <> first_id, r.reused), 'true/false');
  perform pg_temp.expect('s8.3 the fresh record is then reused', format('%s/%s', r2.id = r.id, r2.reused), 'true/true');
  perform pg_temp.expect('s8.4 the deleted record keeps its DRM-ID and state',
    (select (deleted_at is not null)::text from public.patients where id = first_id), 'true');

  -- Merged: never matched either.
  keep := pg_temp.mk_patient('S8K');
  merged_src := r.id;
  update public.patients set merged_into_id = keep, merged_at = now() where id = merged_src;
  set local role service_role;
  select * into r from public.resolve_patient_guarded('pds8@example.test', 'Olve', '1991-02-06', fields);
  reset role;
  perform pg_temp.expect('s8.5 merged identity is not reused', format('%s/%s', r.id <> merged_src, r.reused), 'true/false');

  perform pg_temp.expect('s8.6 still service_role-only',
    format('%s/%s', has_function_privilege('anon', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute'),
                    has_function_privilege('authenticated', 'public.resolve_patient_guarded(text,text,date,jsonb)', 'execute')),
    'false/false');
end
$s8$;
```

- [ ] **Step 2: Run — expect s8.2 to FAIL** (`true/true` reuse of the deleted row).

- [ ] **Step 3: Append migration section 10.** Start from the latest body (0158) — verify with `grep -l "function public.resolve_patient_guarded" supabase/migrations/*.sql | tail -1` that nothing newer than 0158 redefined it; if something did, start from that body.

```sql
-- ---------------------------------------------------------------------------
-- (10) Booking/registration identity match: ACTIVE rows only. A deleted or
-- merged identity booking again gets a fresh DRM-ID (owner decision); staff
-- can restore + merge if it was the same person. Body = 0158 plus the two
-- predicates; the identity lock stays first. PR 3 adds the lifecycle lock and
-- the post-lock re-read.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_patient_guarded(
  p_email text, p_last_name text, p_birthdate date, p_fields jsonb
)
returns table (id uuid, drm_id text, reused boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v record;
begin
  perform pg_advisory_xact_lock(
    hashtext('patient_resolve:' || lower(p_email) || ':' || lower(p_last_name) || ':' || p_birthdate::text)
  );
  select p.id, p.drm_id into v
    from public.patients p
   where p.email = lower(p_email) and p.last_name = p_last_name and p.birthdate = p_birthdate
     and p.deleted_at is null
     and p.merged_into_id is null
   limit 1;
  if found then
    return query select v.id, v.drm_id, true;
    return;
  end if;
  return query
  insert into public.patients (
    first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered,
    referral_source
  ) values (
    p_fields->>'first_name', p_fields->>'last_name', nullif(p_fields->>'middle_name',''),
    (p_fields->>'birthdate')::date,
    nullif(p_fields->>'sex',''),
    nullif(p_fields->>'phone',''), lower(p_email), nullif(p_fields->>'address',''),
    true,
    (select rs.id from public.referral_sources rs where rs.id = nullif(p_fields->>'referral_source',''))
  ) returning patients.id, patients.drm_id, false;
end;
$$;

revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
revoke execute on function public.resolve_patient_guarded(text, text, date, jsonb) from anon, authenticated;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;
```

- [ ] **Step 4: Check no other SQL function is a directory/matching path.**

Run: `grep -ln "from public.patients" supabase/migrations/*.sql | xargs grep -l "create or replace function" | tail -20`
For each function whose LATEST definition selects from `patients` to find/match a patient (not a trigger on a known row, not a report), add the two predicates in this migration the same way. Expected: only `resolve_patient_guarded` qualifies; `src/lib/patients/resolve-referral-migration.test.ts` may pin 0158's text — if it reads "the latest migration defining resolve_patient_guarded", update its expectations to 0167 and keep its referral-source assertions.

- [ ] **Step 5: Apply + run.** Expected `s8.1`–`s8.6 OK`. Run `npx vitest run src/lib/patients` — expected PASS.

- [ ] **Step 6: Commit.** `git commit -am "feat(db): booking identity match skips deleted and merged records (0167, part 7)"`

---

### Task 10: P-code translations, generated types, SQL pins

**Files:**
- Modify: `src/lib/accounting/pg-errors.ts`, `src/types/database.ts`, `CLAUDE.md`
- Create: `src/lib/patients/active-views.test.ts`

- [ ] **Step 1: Run the coverage guard — expect FAIL.**

Run: `npx vitest run src/lib/accounting/pg-error-coverage.test.ts`
Expected: FAIL listing P0057, P0058, P0059, P0060, P0061 as raised in 0167 with no translation.

- [ ] **Step 2: Add the translations** in `src/lib/accounting/pg-errors.ts`, after the last `case` before `default:` (P0053 on main; P0054 after #213 lands — keep numeric order):

```ts
    // Patient delete/restore (0167). The SQL messages are written for staff;
    // P0059's DETAIL carries the blocker list, which the delete action parses
    // separately (src/lib/patients/deletion.ts).
    case "P0057":
      return "Only an admin can delete or restore a patient record.";
    case "P0058":
      return err.message ?? "This patient record is deleted or merged. Restore it first.";
    case "P0059":
      return "This patient still has open items. Close them first, then delete.";
    case "P0060":
      return err.message ?? "Choose a reason, and add a note (up to 500 characters) when the reason is Other.";
    case "P0061":
      return "This patient record is not deleted, so there is nothing to restore.";
```

- [ ] **Step 3: Run the guard — expect PASS.** `npx vitest run src/lib/accounting/pg-error-coverage.test.ts`

- [ ] **Step 4: Write the SQL pin test** `src/lib/patients/active-views.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Pins the active-patient rule in SQL. The TypeScript inventory
// (query-surfaces.test.ts) cannot see views or functions, so this reads the
// LATEST migration that defines each object and requires both predicates.
// A later migration that re-creates one of these without them — the exact
// way 0162 would drop them if re-applied after 0167 — fails here.

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

/** Body of the latest `create [or replace] (view|function) public.<name>` statement. */
function latestDefinition(kind: "view" | "function", name: string): { file: string; body: string } {
  const head = new RegExp(`create\\s+(or\\s+replace\\s+)?${kind}\\s+public\\.${name}\\b`, "i");
  for (const file of [...files].reverse()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const m = head.exec(sql);
    if (!m) continue;
    // Views end at the first ';' after the head; functions at the closing $$ ;.
    const rest = sql.slice(m.index);
    const end = kind === "view" ? rest.indexOf(";") : rest.search(/\$\$\s*;/);
    return { file, body: rest.slice(0, end === -1 ? undefined : end) };
  }
  throw new Error(`no migration defines ${kind} ${name}`);
}

// Each view also filters VISITS on deleted_at, so an unqualified
// "deleted_at is null" would match even with the patient predicate gone.
// Check the patients-side text specifically.
const PATIENT_SIDE: Record<string, (body: string) => string> = {
  v_patients_directory: (b) => b,
  v_patients_without_consent: (b) => b,
  // The predicates live in the `active` CTE (unqualified, from public.patients).
  v_patient_dedup_candidate_pairs: (b) => b.slice(b.indexOf("active as ("), b.indexOf("pairs as (")),
};
const PREDICATES: Record<string, [RegExp, RegExp]> = {
  v_patients_directory: [/p\.deleted_at\s+is\s+null/i, /p\.merged_into_id\s+is\s+null/i],
  v_patients_without_consent: [/p\.deleted_at\s+is\s+null/i, /p\.merged_into_id\s+is\s+null/i],
  v_patient_dedup_candidate_pairs: [/deleted_at\s+is\s+null/i, /merged_into_id\s+is\s+null/i],
};

describe("SQL directory surfaces apply the active-patient rule", () => {
  for (const view of Object.keys(PREDICATES)) {
    it(`${view} excludes deleted and merged patients`, () => {
      const { file, body } = latestDefinition("view", view);
      const side = PATIENT_SIDE[view]!(body);
      const [deleted, merged] = PREDICATES[view]!;
      expect(side, `${file} redefines ${view}`).toMatch(deleted);
      expect(side, `${file} redefines ${view}`).toMatch(merged);
    });
  }

  it("the admin inclusive view keeps deleted rows, drops merged rows, and is admin-gated", () => {
    const { body } = latestDefinition("view", "v_patients_directory_admin");
    expect(body).not.toMatch(/p\.deleted_at\s+is\s+null/i);
    expect(body).toMatch(/p\.merged_into_id\s+is\s+null/i);
    expect(body).toMatch(/has_role\(\s*array\['admin'\]\s*\)/i);
  });

  it("resolve_patient_guarded matches active patients only", () => {
    const { body } = latestDefinition("function", "resolve_patient_guarded");
    expect(body).toMatch(/p\.deleted_at\s+is\s+null/i);
    expect(body).toMatch(/p\.merged_into_id\s+is\s+null/i);
  });

  it("current_patient_id returns only an active patient", () => {
    const { body } = latestDefinition("function", "current_patient_id");
    expect(body).toMatch(/security\s+definer/i);
    expect(body).toMatch(/deleted_at\s+is\s+null/i);
    expect(body).toMatch(/merged_into_id\s+is\s+null/i);
  });
});
```

Run: `npx vitest run src/lib/patients/active-views.test.ts` — Expected: PASS. **Mutation check:** delete `and p.deleted_at is null` from the directory view in 0167, re-run: the `v_patients_directory` case must FAIL; delete `and deleted_at is null` from the dedup view's `active` CTE: its case must FAIL. Revert both.

- [ ] **Step 5: Regenerate types — and keep only this migration's changes.** The local stack is shared, so it may carry other branches' objects.

```bash
npm run db:types
git diff --stat src/types/database.ts
git diff src/types/database.ts | grep -E "^[+-]" | grep -vE "deleted_at|deleted_by|delete_reason|delete_note|deleted_by_name|delete_patient|restore_patient|patient_delete_blockers|patient_kept_counts|v_patients_directory_admin|patients_deleted_by_fkey|current_patient_id|^\+\+\+|^---" | head -40
```
Every remaining hunk that belongs to another branch's migration (e.g. 0162's `source_form`, payment-edit's `correct_payment`) must be reverted by hand (`git checkout -p src/types/database.ts`). Expected additions: the four `patients` columns in Row/Insert/Update, the `patients_deleted_by_fkey` relationship, the `v_patients_directory_admin` view, and `Functions` entries for `delete_patient`, `restore_patient`, `patient_delete_blockers`, `patient_kept_counts`.

- [ ] **Step 6: Typecheck.** `npm run typecheck` — Expected: PASS.

- [ ] **Step 7: Update `CLAUDE.md`.** In the "Payment-gating" bullet list, change the P-code sentence to `(in use: P0001–P0034, P0040–P0054, P0057–P0061; P0055–P0056 unused; P0062–P0064 claimed by feat/sheet-sync)`. In the migration-ledger paragraph add: `**0167** (\`patient_soft_delete\`, PR 2 of the patient-delete rollout) is in flight on \`feat/patient-delete\`; it must be pushed AFTER 0162 and right before its PR merges.`

- [ ] **Step 8: Run the whole smoke test once more, then commit.**

```bash
git add src/lib/accounting/pg-errors.ts src/types/database.ts src/lib/patients/active-views.test.ts CLAUDE.md
git commit -m "feat(patients): P0057–P0061 translations, 0167 types, SQL active-rule pins"
```

---
### Task 11: The active-patient rule (`src/lib/patients/active.ts`)

**Files:**
- Create: `src/lib/patients/active.ts`, `src/lib/patients/active.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest";
import {
  activePatients,
  inactivePatientError,
  isActivePatient,
  firstInactivePatient,
  type PatientLifecycle,
} from "./active";

const active: PatientLifecycle = { drm_id: "DRM-0001", deleted_at: null, merged_into_id: null };
const deleted: PatientLifecycle = { drm_id: "DRM-0002", deleted_at: "2026-09-24T01:00:00Z", merged_into_id: null };
const merged: PatientLifecycle = { drm_id: "DRM-0003", deleted_at: null, merged_into_id: "keep-id" };

describe("activePatients", () => {
  it("adds exactly the two lifecycle filters and returns the same builder", () => {
    const calls: [string, unknown][] = [];
    const builder = {
      is(column: string, value: unknown) {
        calls.push([column, value]);
        return builder;
      },
    };
    expect(activePatients(builder)).toBe(builder);
    expect(calls).toEqual([
      ["deleted_at", null],
      ["merged_into_id", null],
    ]);
  });
});

describe("isActivePatient", () => {
  it("is true only when neither deleted nor merged", () => {
    expect(isActivePatient(active)).toBe(true);
    expect(isActivePatient(deleted)).toBe(false);
    expect(isActivePatient(merged)).toBe(false);
    expect(isActivePatient(null)).toBe(false);
  });
});

describe("inactivePatientError", () => {
  it("names the DRM-ID and the way back", () => {
    expect(inactivePatientError(deleted)).toBe(
      "DRM-0002 was deleted. An admin can restore it from Admin Tools › Deleted Patients before anything else is done on it.",
    );
    expect(inactivePatientError(merged)).toBe(
      "DRM-0003 was merged into another record. Open the surviving record instead.",
    );
    expect(inactivePatientError(null)).toBe("We couldn't find that patient. Search again.");
  });
});

describe("firstInactivePatient", () => {
  it("returns the first inactive row, or null when all are active", () => {
    expect(firstInactivePatient([active, merged, deleted])).toBe(merged);
    expect(firstInactivePatient([active])).toBeNull();
    expect(firstInactivePatient([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module './active'`). `npx vitest run src/lib/patients/active.test.ts`

- [ ] **Step 3: Implement.**

```ts
// The one active-patient rule (0167): a patient record is ACTIVE when it is
// neither soft-deleted nor merged into another record. Every directory,
// picker and matching query applies it; history lookups (visits, receipts,
// payments, reports, audit) deliberately do not. The SQL side of the same
// rule lives in the 0167 views and functions (active-views.test.ts), and
// src/lib/patients/query-surfaces.test.ts classifies every patients read.
//
// Pure — no server-only import — so it is unit-testable and usable from
// scripts.

export interface PatientLifecycle {
  drm_id: string;
  deleted_at: string | null;
  merged_into_id: string | null;
}

/** The select fragment a lifecycle check needs. */
export const PATIENT_LIFECYCLE_COLUMNS = "drm_id, deleted_at, merged_into_id";

interface IsFilterable {
  is(column: string, value: null): unknown;
}

/**
 * Restrict a `patients` query to active records. Wrap the builder DIRECTLY —
 * `activePatients(db.from("patients").select(...))` — so the inventory test
 * can see it at the call site. Only for the `patients` table; the 0167 views
 * already apply the rule in SQL and have no lifecycle columns.
 */
export function activePatients<Q>(query: Q): Q {
  const withDeleted = (query as unknown as IsFilterable).is("deleted_at", null);
  return (withDeleted as IsFilterable).is("merged_into_id", null) as Q;
}

export function isActivePatient(p: PatientLifecycle | null | undefined): boolean {
  return !!p && p.deleted_at === null && p.merged_into_id === null;
}

export function firstInactivePatient<T extends PatientLifecycle>(rows: readonly T[]): T | null {
  return rows.find((r) => !isActivePatient(r)) ?? null;
}

/** Staff-facing refusal for a write aimed at an inactive (or missing) record. */
export function inactivePatientError(p: PatientLifecycle | null | undefined): string {
  if (!p) return "We couldn't find that patient. Search again.";
  if (p.merged_into_id !== null) {
    return `${p.drm_id} was merged into another record. Open the surviving record instead.`;
  }
  return `${p.drm_id} was deleted. An admin can restore it from Admin Tools › Deleted Patients before anything else is done on it.`;
}
```

- [ ] **Step 4: Run — expect PASS.** Then `npm run typecheck`.

- [ ] **Step 5: Commit.** `git add src/lib/patients/active.ts src/lib/patients/active.test.ts && git commit -m "feat(patients): one active-patient rule helper"`

---

### Task 12: Deletion rules in TypeScript (`src/lib/patients/deletion.ts`)

**Files:**
- Create: `src/lib/patients/deletion.ts`, `src/lib/patients/deletion.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKER_KINDS,
  BLOCKER_GROUP_LABEL,
  DELETE_REASONS,
  DELETE_REASON_LABEL,
  DeletePatientSchema,
  groupBlockers,
  keptSummary,
  parseBlockerDetail,
  parseBlockers,
  parseKeptCounts,
  parseLifecycleResult,
} from "./deletion";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0167_patient_soft_delete.sql"),
  "utf8",
);

const uuid = "11111111-1111-4111-8111-111111111111";

describe("DeletePatientSchema", () => {
  it("accepts each reason, trimming the note", () => {
    for (const reason of DELETE_REASONS) {
      const r = DeletePatientSchema.safeParse({ patientId: uuid, reason, note: "  why  " });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.note).toBe("why");
    }
  });
  it("turns a blank note into undefined", () => {
    const r = DeletePatientSchema.safeParse({ patientId: uuid, reason: "duplicate", note: "   " });
    expect(r.success && r.data.note).toBe(undefined);
  });
  it("requires a note for Other", () => {
    const r = DeletePatientSchema.safeParse({ patientId: uuid, reason: "other", note: " " });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("Add a note when the reason is Other.");
  });
  it("caps the note at 500 characters", () => {
    expect(DeletePatientSchema.safeParse({ patientId: uuid, reason: "other", note: "x".repeat(500) }).success).toBe(true);
    expect(DeletePatientSchema.safeParse({ patientId: uuid, reason: "other", note: "x".repeat(501) }).success).toBe(false);
  });
  it("rejects an unknown reason and a non-uuid id", () => {
    expect(DeletePatientSchema.safeParse({ patientId: uuid, reason: "oops" }).success).toBe(false);
    expect(DeletePatientSchema.safeParse({ patientId: "DRM-0001", reason: "duplicate" }).success).toBe(false);
  });
});

describe("pinned to migration 0167", () => {
  it("uses the same four reasons as the row check", () => {
    const m = /delete_reason in \(([^)]*)\)/.exec(MIGRATION);
    const sqlReasons = m![1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect([...DELETE_REASONS].sort()).toEqual(sqlReasons.sort());
    expect(Object.keys(DELETE_REASON_LABEL).sort()).toEqual([...DELETE_REASONS].sort());
  });
  it("knows every blocker kind the SQL can emit", () => {
    const sqlKinds = [...MIGRATION.matchAll(/'([a-z_]+)'::text(?: as kind)?,/g)]
      .map((m) => m[1]!)
      .filter((k) => (BLOCKER_KINDS as readonly string[]).includes(k) || /^(appointment|clinical|empty_visit|balance|hmo_)/.test(k));
    expect(new Set(sqlKinds)).toEqual(new Set(BLOCKER_KINDS));
    expect(Object.keys(BLOCKER_GROUP_LABEL).sort()).toEqual([...BLOCKER_KINDS].sort());
  });
});

describe("parseBlockers", () => {
  it("keeps valid rows and turns amounts into numbers", () => {
    const rows = parseBlockers([
      { kind: "balance", resource_id: uuid, visit_id: uuid, label: "Visit 0001 is unpaid", amount_php: "600.00", href: "/staff/visits/x" },
      { kind: "appointment", resource_id: uuid, visit_id: null, label: "Callback", amount_php: null, href: null },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amount_php).toBe(600);
    expect(rows[1]!.amount_php).toBeNull();
  });
  it("keeps an unknown kind rather than dropping a blocker", () => {
    const rows = parseBlockers([{ kind: "future_kind", resource_id: uuid, visit_id: null, label: "x", amount_php: null, href: null }]);
    expect(rows[0]!.kind).toBe("future_kind");
  });
  it("returns [] for junk", () => {
    expect(parseBlockers(null)).toEqual([]);
    expect(parseBlockers("nope")).toEqual([]);
  });
});

describe("parseBlockerDetail", () => {
  it("reads the JSON the SQL puts in DETAIL", () => {
    const detail = JSON.stringify([{ kind: "clinical", resource_id: uuid, visit_id: uuid, label: "CBC is requested", amount_php: null, href: "/staff/visits/v" }]);
    expect(parseBlockerDetail(detail)[0]!.label).toBe("CBC is requested");
  });
  it("never throws", () => {
    expect(parseBlockerDetail("{not json")).toEqual([]);
    expect(parseBlockerDetail(undefined)).toEqual([]);
  });
});

describe("groupBlockers", () => {
  it("groups by kind in first-seen order", () => {
    const g = groupBlockers(parseBlockers([
      { kind: "appointment", resource_id: "a", visit_id: null, label: "A", amount_php: null, href: null },
      { kind: "clinical", resource_id: "b", visit_id: null, label: "B", amount_php: null, href: null },
      { kind: "appointment", resource_id: "c", visit_id: null, label: "C", amount_php: null, href: null },
    ]));
    expect(g.map((x) => [x.kind, x.items.length])).toEqual([["appointment", 2], ["clinical", 1]]);
    expect(g[0]!.title).toBe("Open appointments");
  });
});

describe("kept counts", () => {
  it("parses the RPC row and pluralises", () => {
    const k = parseKeptCounts({ visits: 2, payments: 1, appointments: 0, consents: 3 });
    expect(keptSummary(k)).toBe("2 visits, 1 payment, 0 appointments, 3 consent records");
  });
  it("defaults missing numbers to zero", () => {
    expect(parseKeptCounts(null)).toEqual({ visits: 0, payments: 0, appointments: 0, consents: 0 });
  });
});

describe("parseLifecycleResult", () => {
  it("reads the delete/restore return value", () => {
    expect(parseLifecycleResult({ patient_id: uuid, drm_id: "DRM-1234", kept: { visits: 1 } })).toEqual({
      patientId: uuid,
      drmId: "DRM-1234",
    });
    expect(parseLifecycleResult(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/lib/patients/deletion.test.ts`

- [ ] **Step 3: Implement.**

```ts
import { z } from "zod";

// Patient delete/restore rules shared by the dialog, the server actions and
// the Deleted Patients page (0167). The SQL is the authority: this module
// validates input before it reaches delete_patient() and parses what comes
// back. deletion.test.ts pins the reasons and blocker kinds to 0167.

export const DELETE_REASONS = ["duplicate", "test_record", "patient_request", "other"] as const;
export type DeleteReason = (typeof DELETE_REASONS)[number];

export const DELETE_REASON_LABEL: Record<DeleteReason, string> = {
  duplicate: "Duplicate record",
  test_record: "Test record",
  patient_request: "Requested by the patient",
  other: "Other",
};

export function deleteReasonLabel(reason: string | null | undefined): string {
  return (DELETE_REASON_LABEL as Record<string, string>)[reason ?? ""] ?? "Unknown reason";
}

export const DELETE_NOTE_MAX = 500;

export const DeletePatientSchema = z
  .object({
    patientId: z.string().uuid("We couldn't find that patient."),
    reason: z.enum(DELETE_REASONS, { message: "Choose a reason." }),
    note: z
      .string()
      .trim()
      .max(DELETE_NOTE_MAX, `The note can be at most ${DELETE_NOTE_MAX} characters.`)
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .superRefine((d, ctx) => {
    if (d.reason === "other" && !d.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Add a note when the reason is Other." });
    }
  });
export type DeletePatientInput = z.input<typeof DeletePatientSchema>;

export const BLOCKER_KINDS = [
  "appointment",
  "clinical",
  "empty_visit",
  "balance",
  "hmo_patient_share",
  "hmo_reconciliation",
  "hmo_claim",
  "hmo_unbilled",
] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export const BLOCKER_GROUP_LABEL: Record<BlockerKind, string> = {
  appointment: "Open appointments",
  clinical: "Unfinished tests and consultations",
  empty_visit: "Visits with nothing on them",
  balance: "Unpaid balances",
  hmo_patient_share: "Unpaid patient share (HMO)",
  hmo_reconciliation: "HMO records to reconcile first",
  hmo_claim: "HMO claims not yet settled",
  hmo_unbilled: "HMO coverage not yet claimed",
};

export interface DeleteBlocker {
  kind: string;
  resource_id: string;
  visit_id: string | null;
  label: string;
  amount_php: number | null;
  href: string | null;
}

const BlockerRow = z.object({
  kind: z.string(),
  resource_id: z.string(),
  visit_id: z.string().nullable(),
  label: z.string(),
  amount_php: z.union([z.number(), z.string(), z.null()]),
  href: z.string().nullable(),
});

export function parseBlockers(raw: unknown): DeleteBlocker[] {
  const parsed = z.array(BlockerRow).safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((b) => ({
    ...b,
    amount_php: b.amount_php === null ? null : Number(b.amount_php),
  }));
}

/** P0059 carries the blocker list as JSON in the error DETAIL. */
export function parseBlockerDetail(details: string | null | undefined): DeleteBlocker[] {
  if (!details) return [];
  try {
    return parseBlockers(JSON.parse(details));
  } catch {
    return [];
  }
}

export interface BlockerGroup {
  kind: string;
  title: string;
  items: DeleteBlocker[];
}

/** Group for display, keeping the SQL's order (first-seen kind first). */
export function groupBlockers(blockers: readonly DeleteBlocker[]): BlockerGroup[] {
  const groups = new Map<string, BlockerGroup>();
  for (const b of blockers) {
    let g = groups.get(b.kind);
    if (!g) {
      g = {
        kind: b.kind,
        title: (BLOCKER_GROUP_LABEL as Record<string, string>)[b.kind] ?? "Other open items",
        items: [],
      };
      groups.set(b.kind, g);
    }
    g.items.push(b);
  }
  return [...groups.values()];
}

export interface KeptCounts {
  visits: number;
  payments: number;
  appointments: number;
  consents: number;
}

export function parseKeptCounts(raw: unknown): KeptCounts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
  return { visits: n(r.visits), payments: n(r.payments), appointments: n(r.appointments), consents: n(r.consents) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function keptSummary(k: KeptCounts): string {
  return [
    plural(k.visits, "visit", "visits"),
    plural(k.payments, "payment", "payments"),
    plural(k.appointments, "appointment", "appointments"),
    plural(k.consents, "consent record", "consent records"),
  ].join(", ");
}

/** delete_patient / restore_patient return {patient_id, drm_id, kept}. */
export function parseLifecycleResult(raw: unknown): { patientId: string; drmId: string } | null {
  const r = raw as { patient_id?: unknown; drm_id?: unknown } | null;
  if (!r || typeof r.patient_id !== "string" || typeof r.drm_id !== "string") return null;
  return { patientId: r.patient_id, drmId: r.drm_id };
}
```

- [ ] **Step 4: Run — expect PASS.** If the "knows every blocker kind" regex over-matches other `'x'::text,` literals in 0167, tighten it to the `blockers` CTE: slice `MIGRATION` between `blockers as (` and `deduped as (` first. The assertion itself must stay a set equality.

- [ ] **Step 5: Commit.** `git add src/lib/patients/deletion.ts src/lib/patients/deletion.test.ts && git commit -m "feat(patients): deletion reasons, blocker parsing, kept counts"`

---

### Task 13: Server-side write guards (`src/lib/patients/require-active.ts`)

Every write action aimed at a patient (directly or through a visit, line, payment, appointment or claim) calls one of these first. PR 3 adds the database twin; until then these are the enforcement for non-racing writes, and the patient guard trigger already refuses any edit of a deleted `patients` row.

**Files:**
- Create: `src/lib/patients/require-active.ts`, `src/lib/patients/require-active.test.ts`

- [ ] **Step 1: Write the failing test** (pure core only — the loaders are thin).

```ts
import { describe, expect, it } from "vitest";
import { activeCheck } from "./require-active-core";

describe("activeCheck", () => {
  it("passes when every patient is active and walk-ins (no id) are ignored", () => {
    expect(activeCheck([{ drm_id: "DRM-1", deleted_at: null, merged_into_id: null }], 1)).toEqual({ ok: true });
    expect(activeCheck([], 0)).toEqual({ ok: true });
  });
  it("refuses with the first inactive DRM-ID", () => {
    const r = activeCheck(
      [
        { drm_id: "DRM-1", deleted_at: null, merged_into_id: null },
        { drm_id: "DRM-2", deleted_at: "2026-09-24T00:00:00Z", merged_into_id: null },
      ],
      2,
    );
    expect(r).toEqual({
      ok: false,
      error: "DRM-2 was deleted. An admin can restore it from Admin Tools › Deleted Patients before anything else is done on it.",
    });
  });
  it("refuses when an id did not resolve to a row", () => {
    expect(activeCheck([], 1)).toEqual({ ok: false, error: "We couldn't find that patient. Search again." });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement the pure core** `src/lib/patients/require-active-core.ts`:

```ts
import { firstInactivePatient, inactivePatientError, type PatientLifecycle } from "./active";

export type ActiveCheck = { ok: true } | { ok: false; error: string };

/**
 * `rows` = the lifecycle rows found for the distinct patient ids a write
 * touches; `expected` = how many distinct ids there were. A missing row is a
 * refusal (the id was wrong or the row is gone), never a pass.
 */
export function activeCheck(rows: readonly PatientLifecycle[], expected: number): ActiveCheck {
  const bad = firstInactivePatient(rows);
  if (bad) return { ok: false, error: inactivePatientError(bad) };
  if (rows.length < expected) return { ok: false, error: inactivePatientError(null) };
  return { ok: true };
}
```

- [ ] **Step 4: Implement the loaders** `src/lib/patients/require-active.ts`:

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { PATIENT_LIFECYCLE_COLUMNS, type PatientLifecycle } from "./active";
import { activeCheck, type ActiveCheck } from "./require-active-core";

// App-level refusal of writes aimed at an inactive (deleted or merged)
// patient — spec "History pages keep working": history stays readable, but
// nothing new is done on it until an admin restores the record. Pass the
// admin client: the check must see the lifecycle columns whatever the
// caller's RLS. Each helper resolves its rows to DISTINCT patient ids, then
// checks them in one query. Walk-in appointments (patient_id NULL) pass.
//
// PR 3 adds the database twin (child-table activity guards under the shared
// lifecycle lock); these stay as the friendly first line.

type Db = SupabaseClient<Database>;
export type { ActiveCheck };

const CHUNK = 200;
const uniq = (ids: readonly (string | null | undefined)[]) =>
  [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];

async function lifecycleRows(db: Db, patientIds: string[]): Promise<PatientLifecycle[] | null> {
  const out: PatientLifecycle[] = [];
  for (let i = 0; i < patientIds.length; i += CHUNK) {
    const { data, error } = await db
      .from("patients")
      .select(`id, ${PATIENT_LIFECYCLE_COLUMNS}`)
      .in("id", patientIds.slice(i, i + CHUNK));
    if (error) return null;
    out.push(...((data ?? []) as unknown as PatientLifecycle[]));
  }
  return out;
}

const LOOKUP_FAILED: ActiveCheck = { ok: false, error: "Could not check the patient record. Try again." };

export async function assertPatientsActive(db: Db, patientIds: readonly (string | null | undefined)[]): Promise<ActiveCheck> {
  const ids = uniq(patientIds);
  if (ids.length === 0) return { ok: true };
  const rows = await lifecycleRows(db, ids);
  return rows ? activeCheck(rows, ids.length) : LOOKUP_FAILED;
}

export function assertPatientActive(db: Db, patientId: string): Promise<ActiveCheck> {
  return assertPatientsActive(db, [patientId]);
}

export async function assertVisitsPatientsActive(db: Db, visitIds: readonly string[]): Promise<ActiveCheck> {
  const ids = uniq(visitIds);
  if (ids.length === 0) return { ok: true };
  const { data, error } = await db.from("visits").select("patient_id").in("id", ids);
  if (error) return LOOKUP_FAILED;
  return assertPatientsActive(db, (data ?? []).map((v) => v.patient_id));
}

export function assertVisitPatientActive(db: Db, visitId: string): Promise<ActiveCheck> {
  return assertVisitsPatientsActive(db, [visitId]);
}

export async function assertTestRequestsPatientsActive(db: Db, testRequestIds: readonly string[]): Promise<ActiveCheck> {
  const ids = uniq(testRequestIds);
  if (ids.length === 0) return { ok: true };
  const { data, error } = await db.from("test_requests").select("visit_id").in("id", ids);
  if (error) return LOOKUP_FAILED;
  return assertVisitsPatientsActive(db, (data ?? []).map((t) => t.visit_id));
}

export async function assertPaymentPatientActive(db: Db, paymentId: string): Promise<ActiveCheck> {
  const { data, error } = await db.from("payments").select("visit_id").eq("id", paymentId).maybeSingle();
  if (error) return LOOKUP_FAILED;
  return data ? assertVisitPatientActive(db, data.visit_id) : { ok: true };
}

export async function assertAppointmentsPatientsActive(db: Db, appointmentIds: readonly string[]): Promise<ActiveCheck> {
  const ids = uniq(appointmentIds);
  if (ids.length === 0) return { ok: true };
  const { data, error } = await db.from("appointments").select("patient_id").in("id", ids);
  if (error) return LOOKUP_FAILED;
  return assertPatientsActive(db, (data ?? []).map((a) => a.patient_id));
}

export async function assertClaimItemsPatientsActive(db: Db, itemIds: readonly string[]): Promise<ActiveCheck> {
  const ids = uniq(itemIds);
  if (ids.length === 0) return { ok: true };
  const { data, error } = await db.from("hmo_claim_items").select("test_request_id").in("id", ids);
  if (error) return LOOKUP_FAILED;
  return assertTestRequestsPatientsActive(db, (data ?? []).map((i) => i.test_request_id));
}

export async function assertBatchPatientsActive(db: Db, batchId: string): Promise<ActiveCheck> {
  const { data, error } = await db.from("hmo_claim_items").select("test_request_id").eq("batch_id", batchId);
  if (error) return LOOKUP_FAILED;
  return assertTestRequestsPatientsActive(db, (data ?? []).map((i) => i.test_request_id));
}

export async function assertResolutionPatientActive(db: Db, resolutionId: string): Promise<ActiveCheck> {
  const { data, error } = await db.from("hmo_claim_resolutions").select("item_id").eq("id", resolutionId).maybeSingle();
  if (error) return LOOKUP_FAILED;
  return data ? assertClaimItemsPatientsActive(db, [data.item_id]) : { ok: true };
}
```
Point the test at the core (`./require-active-core`); `require-active.ts` imports `server-only` and is covered by typecheck + the browser smoke.

- [ ] **Step 5: Run the test + typecheck — expect PASS.** Fix any `visits`/`test_requests` read that `src/lib/visits/query-surfaces.test.ts` now flags: classify `lib/patients/require-active.ts` in its `LIFECYCLES` map as `{ lifecycle: "any", why: "Resolves a visit/line to its patient to refuse writes on an inactive patient; a deleted visit's patient must still be found." }` and in `SURFACES` as `{ meaning: "all", why: "Resolves bill lines to their patient; every kind of line counts." }`. Run `npx vitest run src/lib/visits/query-surfaces.test.ts`.

- [ ] **Step 6: Commit.** `git add src/lib/patients/require-active* src/lib/visits/query-surfaces.test.ts && git commit -m "feat(patients): server-side guards refusing writes on inactive patients"`

---

### Task 14: Patient query inventory test (fails first — Tasks 15–17 make it pass)

Mirrors `src/lib/visits/query-surfaces.test.ts`: every `.from("patients")` READ in `src/` and `scripts/` is classified, and the classification is enforced at the chain level.

**Files:**
- Create: `src/lib/patients/query-surfaces.test.ts`

- [ ] **Step 1: Write the test.**

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

// Every READ of the `patients` table, in src/ and scripts/, declares what it
// means (spec 2026-09-24-patient-delete-design.md, "One shared active patient
// rule"):
//
//   active    — a directory, picker, matching or authentication read. Must
//               exclude deleted AND merged records, by wrapping the builder in
//               activePatients(...) or chaining .is("deleted_at", null) and
//               .is("merged_into_id", null) on the same chain.
//   history   — reads a record named by history (a visit's patient, an audit
//               row, a portal export). Must NOT filter, or deleted and merged
//               records vanish from history. This is the "future blanket
//               filter cannot hide history" guard.
//   lifecycle — reads a record in order to DECIDE on its lifecycle (the write
//               guards, the delete dialog, fixture lookups). Must select both
//               deleted_at and merged_into_id.
//   mixed     — a file with more than one of the above; every chain is still
//               checked against "not unfiltered-and-unexplained" below.
//
// SQL views/functions are pinned separately in active-views.test.ts.

const ROOT = process.cwd();
const DIRS = [join(ROOT, "src"), join(ROOT, "scripts")];

type Meaning = "active" | "history" | "lifecycle" | "mixed";
interface Surface {
  meaning: Meaning;
  why: string;
}

const S = "app/(staff)/staff/(dashboard)";

const SURFACES: Record<string, Surface> = {
  // --- active: directory / pickers / matching / authentication -------------
  [`src/${S}/appointments/new-appointment-actions.ts`]: { meaning: "active", why: "Staff booking: patient search and the submitted existing-patient id." },
  [`src/${S}/appointments/actions.ts`]: { meaning: "active", why: "Attach-patient picks an existing record; an inactive one reads as not found." },
  [`src/${S}/visits/new/page.tsx`]: { meaning: "active", why: "New-visit picker and ?patient_id= preselection." },
  [`src/${S}/admin/settings/consent-gate/page.tsx`]: { meaning: "active", why: "Worklist count of active patients without consent." },
  [`src/${S}/marketing/sources/page.tsx`]: { meaning: "active", why: "New-patient acquisition count counts active records only." },
  "src/app/(patient)/portal/login/actions.ts": { meaning: "active", why: "PIN login authenticates active records only, before PIN work and again before the cookie." },
  "src/app/(marketing)/find-my-id/actions.ts": { meaning: "active", why: "DRM-ID recovery answers for active records only." },
  "src/app/(marketing)/schedule/actions.ts": { meaning: "active", why: "Public lookup and the submitted existing-patient id." },
  "src/lib/patients/find-duplicates.ts": { meaning: "active", why: "Duplicate candidates are active records only." },
  "src/lib/auth/require-patient.ts": { meaning: "active", why: "getActivePatientSession — portal access for active records only, no merge chain." },
  "scripts/clinical-backfill/engine.ts": { meaning: "active", why: "Backfill patient index and token-reuse map match active records only." },
  "scripts/clinical-backfill/followups/worksheet.ts": { meaning: "active", why: "Worksheet candidates are active records only." },

  // --- history: never filtered ---------------------------------------------
  [`src/${S}/patients/[id]/page.tsx`]: { meaning: "history", why: "The record page stays reachable for deleted/merged records (banner + read-only)." },
  [`src/${S}/patients/[id]/consent/print/page.tsx`]: { meaning: "history", why: "Printing a signed consent form of any record." },
  [`src/${S}/patients/[id]/edit-actions.ts`]: { meaning: "history", why: "Reads consent_current of a target already proven active by assertPatientActive." },
  [`src/${S}/audit/page.tsx`]: { meaning: "history", why: "Audit enrichment must keep deleted and merged names." },
  [`src/${S}/queue/[id]/actions.ts`]: { meaning: "history", why: "Demographics of an existing result's patient; writes are guarded separately." },
  "src/app/(patient)/portal/(authenticated)/data-export/route.ts": { meaning: "history", why: "RA 10173 export of the signed-in (already active-checked) patient's own record." },
  "src/components/staff/notification-bell.tsx": { meaning: "history", why: "Names the patient of a past staff event." },
  "src/lib/appointments/booking-alert.ts": { meaning: "history", why: "Names the patient of a booking that already happened." },
  "src/lib/consent/gate.ts": { meaning: "history", why: "Resolves the actual visit's consent state, never a directory lookup." },
  "src/lib/emails-log/query.ts": { meaning: "history", why: "Email history must still find deleted and merged identities." },

  // --- lifecycle: reads the state to decide ----------------------------------
  [`src/${S}/patients/[id]/edit/page.tsx`]: { meaning: "lifecycle", why: "The edit route refuses inactive records before rendering a form." },
  "src/lib/patients/require-active.ts": { meaning: "lifecycle", why: "The write guards." },
  "src/lib/patients/lifecycle-display.ts": { meaning: "lifecycle", why: "Banner data for deleted/merged records." },
  "src/lib/actions/patients/lifecycle.ts": { meaning: "lifecycle", why: "Delete dialog preview of the target record." },
  "src/lib/notifications/active-patient-recipient.ts": { meaning: "lifecycle", why: "Final recipient check before every patient email/SMS." },
  "scripts/seed-test-users.ts": { meaning: "lifecycle", why: "Fixture lookup refuses a DRM-ID held by an inactive record." },
  "scripts/seed-sample-results.ts": { meaning: "lifecycle", why: "Fixture lookup refuses a DRM-ID held by an inactive record." },
  "scripts/seed-screenshot-data.ts": { meaning: "lifecycle", why: "Fixture lookup refuses a DRM-ID held by an inactive record." },
  "scripts/smoke-chemistry-consolidated.ts": { meaning: "lifecycle", why: "Fixture lookup refuses a DRM-ID held by an inactive record." },

  // --- mixed ----------------------------------------------------------------
  [`src/${S}/admin/patient-merge/actions.ts`]: { meaning: "mixed", why: "Preview/candidates are active; merge and undo load lifecycle; the recent-merges list is history." },
  "scripts/patient-dedup/engine.ts": { meaning: "mixed", why: "loadRows is active; mergeOne re-reads lifecycle before writing." },
};

const isCheckable = (p: string) =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\.d\.ts$/.test(p);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isCheckable(full)) out.push(full);
  }
  return out;
}
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

interface Chain {
  file: string;
  line: number;
  methods: string[];
  isArgs: [string | null, string | null][]; // .is(col, value) pairs
  selectText: string;
  wrappedActive: boolean;
  isWrite: boolean;
}

const WRITE = new Set(["insert", "update", "delete", "upsert"]);

function scanSource(text: string, full: string): Chain[] {
  if (!text.includes('"patients"')) return [];
  const src = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true,
    full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const consts = new Map<string, string>();
  const collectConsts = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
        && (ts.isStringLiteralLike(n.initializer))) consts.set(n.name.text, n.initializer.text);
    n.forEachChild(collectConsts);
  };
  collectConsts(src);
  const lit = (a: ts.Node | undefined): string | null => {
    if (!a) return null;
    if (ts.isStringLiteralLike(a)) return a.text;
    if (ts.isTemplateExpression(a)) return a.getText(src);
    if (ts.isIdentifier(a)) return consts.get(a.text) ?? null;
    if (a.kind === ts.SyntaxKind.NullKeyword) return "null";
    return null;
  };
  const out: Chain[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "from" && lit(node.arguments[0]) === "patients") {
      const methods = ["from"];
      const isArgs: [string | null, string | null][] = [];
      let selectText = "";
      let current: ts.Node = node;
      for (;;) {
        const access = current.parent;
        if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== current) break;
        const call = access.parent;
        if (!call || !ts.isCallExpression(call) || call.expression !== access) break;
        const m = access.name.text;
        methods.push(m);
        if (m === "is") isArgs.push([lit(call.arguments[0]), lit(call.arguments[1])]);
        if (m === "select") selectText += " " + (lit(call.arguments[0]) ?? "");
        current = call;
      }
      const parent = current.parent;
      const wrappedActive = !!parent && ts.isCallExpression(parent)
        && ts.isIdentifier(parent.expression) && parent.expression.text === "activePatients";
      // A wrapped chain continues after activePatients(...): collect those links too.
      if (wrappedActive) {
        let cur: ts.Node = parent;
        for (;;) {
          const access = cur.parent;
          if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== cur) break;
          const call = access.parent;
          if (!call || !ts.isCallExpression(call) || call.expression !== access) break;
          methods.push(access.name.text);
          cur = call;
        }
      }
      out.push({
        file: rel(full),
        line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
        methods, isArgs, selectText, wrappedActive,
        isWrite: methods.some((m) => WRITE.has(m)),
      });
    }
    node.forEachChild(visit);
  };
  visit(src);
  return out;
}

const chains = DIRS.flatMap((d) => walk(d)).flatMap((f) => scanSource(readFileSync(f, "utf8"), f));
const reads = chains.filter((c) => !c.isWrite);

const isActiveFiltered = (c: Chain) =>
  c.wrappedActive ||
  (c.isArgs.some(([col, v]) => col === "deleted_at" && v === "null") &&
   c.isArgs.some(([col, v]) => col === "merged_into_id" && v === "null"));
const readsLifecycle = (c: Chain) => /\bdeleted_at\b/.test(c.selectText) && /\bmerged_into_id\b/.test(c.selectText)
  || /PATIENT_LIFECYCLE_COLUMNS/.test(c.selectText);
const at = (c: Chain) => `${c.file}:${c.line}`;

describe("patients reads declare the active rule", () => {
  it("finds patients reads to scan (guards a broken walk)", () => {
    expect(reads.length).toBeGreaterThan(30);
  });

  it("classifies every file that reads patients", () => {
    const unclassified = [...new Set(reads.map((c) => c.file))].filter((f) => !SURFACES[f]).sort();
    expect(unclassified, "Add each file to SURFACES with a meaning and a why (see the header).").toEqual([]);
  });

  it("has no stale SURFACES entries", () => {
    const files = new Set(reads.map((c) => c.file));
    expect(Object.keys(SURFACES).filter((f) => !files.has(f))).toEqual([]);
  });

  it("filters every active read", () => {
    const bad = reads.filter((c) => SURFACES[c.file]?.meaning === "active" && !isActiveFiltered(c)).map(at);
    expect(bad, "Wrap the builder in activePatients(...) — directly, not via a later reassignment.").toEqual([]);
  });

  it("never filters a history read", () => {
    const bad = reads.filter((c) => SURFACES[c.file]?.meaning === "history" && isActiveFiltered(c)).map(at);
    expect(bad, "History must keep deleted and merged records visible.").toEqual([]);
  });

  it("selects the lifecycle columns on every lifecycle read", () => {
    const bad = reads.filter((c) => SURFACES[c.file]?.meaning === "lifecycle" && !readsLifecycle(c)).map(at);
    expect(bad).toEqual([]);
  });

  it("leaves no unexplained chain in a mixed file", () => {
    // In a mixed file every read is either active-filtered or selects the
    // lifecycle columns (a history read in a mixed file selects them too, so
    // it can show the record's state and so this rule stays per-chain).
    const bad = reads.filter((c) => SURFACES[c.file]?.meaning === "mixed"
      && !isActiveFiltered(c) && !readsLifecycle(c)).map(at);
    expect(bad).toEqual([]);
  });

  it("scanner polarity: a .not(deleted_at) chain is not active", () => {
    const [c] = scanSource(`db.from("patients").select("id").not("deleted_at", "is", null).is("merged_into_id", null)`, "x.ts");
    expect(isActiveFiltered(c!)).toBe(false);
    const [w] = scanSource(`activePatients(db.from("patients").select("id")).eq("id", x)`, "y.ts");
    expect(isActiveFiltered(w!)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/lib/patients/query-surfaces.test.ts`
Expected failures: "filters every active read" (most active files are unfiltered), "selects the lifecycle columns", "stale SURFACES entries" (files created in later tasks: `lifecycle-display.ts`, `lifecycle.ts`, `active-patient-recipient.ts`). Keep going — Tasks 15–17, 18–20, 24 and 26 turn each red line green. In a mixed file, a history read satisfies the rule by selecting `deleted_at, merged_into_id` (Task 15 Step 6 does this for the recent-merges lookup).

- [ ] **Step 3: Commit the red test** (the branch is local; this documents the target).

```bash
git add src/lib/patients/query-surfaces.test.ts
git commit -m "test(patients): inventory of every patients read (red until the active rule lands)"
```

---

### Task 15: Apply the active rule — staff pickers, matching and worklists

**Files:** Modify (paths under `staff/`):
- `appointments/new-appointment-actions.ts` (search L251–256, existing-id L83)
- `appointments/actions.ts` (`attachPatientToAppointmentAction`, L337–346)
- `visits/new/page.tsx` (preselection L48–51, `PatientPicker` L176–181)
- `admin/settings/consent-gate/page.tsx` (L22–27)
- `marketing/sources/page.tsx` (L76–82)
- `src/lib/patients/find-duplicates.ts` (`findCandidatesForInput`)
- `admin/patient-merge/actions.ts` (preview L58–97, merge L142–158, undo L387–397, merge-email)

For each site, import `import { activePatients } from "@/lib/patients/active";` and wrap the builder directly. Keep every other filter, order and limit exactly as it is.

- [ ] **Step 1: Staff booking.** In `new-appointment-actions.ts`:

```ts
// existing-patient resolution (was: admin.from("patients").select("id, drm_id, email").eq("id", …))
const { data: row } = await activePatients(admin.from("patients").select("id, drm_id, email"))
  .eq("id", data.patient.patient_id)
  .maybeSingle();
```
```ts
// searchPatientsAction
let query = activePatients(
  supabase
    .from("patients")
    .select("id, drm_id, first_name, last_name, phone, email, birthdate, pre_registered"),
)
  .order("created_at", { ascending: false })
  .limit(25);
```
The existing "not found" message for a missing id now also covers an inactive one — that is intended (no disclosure of lifecycle state to reception here; the record page shows it).

- [ ] **Step 2: Attach patient.** In `appointments/actions.ts`:

```ts
const { data: row } = await activePatients(admin.from("patients").select("id, drm_id"))
  .eq("id", parsed.data.patient_id)
  .maybeSingle();
if (!row) return { ok: false, error: "We couldn't find that patient. Search again." };
```

- [ ] **Step 3: New visit page.**

```ts
// preselection
activePatients(supabase.from("patients").select("id, drm_id, first_name, last_name")).eq("id", patient_id).maybeSingle(),
```
```ts
// PatientPicker
let q = activePatients(supabase.from("patients").select("id, drm_id, first_name, last_name, phone"))
  .order("created_at", { ascending: false })
  .limit(PICKER_LIMIT);
```

- [ ] **Step 4: Worklists.** consent-gate:

```ts
const { count } = await activePatients(
  admin.from("patients").select("id", { count: "exact", head: true }),
).eq("consent_current", false);
```
marketing sources (inside the `fetchAllRows` fetcher):

```ts
let q = activePatients(supabase.from("patients").select("id, referral_source, created_at"));
```
Acquisition is the only count that changes here; appointment/contact totals on that page stay as they are (spec).

- [ ] **Step 5: Duplicate finder.** In `findCandidatesForInput`:

```ts
const { data, error } = await activePatients(
  admin
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, birthdate, email, phone_normalized, address, sex, legacy_import_run_id, created_at",
    ),
)
  .or(clauses.join(","))
  .limit(50);
```
(`.is("merged_into_id", null)` is replaced by the helper, which applies it too.) `loadCandidatePairs*` needs no change — the 0167 view does it.

- [ ] **Step 6: Merge.** In `admin/patient-merge/actions.ts`:
  - `previewByDrmId`: wrap with `activePatients(...)` so a deleted or merged DRM-ID previews as "not found".
  - `mergePatientsAction`: add `deleted_at` to the select (`"id, drm_id, first_name, last_name, middle_name, sex, phone, email, address, merged_into_id, deleted_at"`), and replace the merged check with:

```ts
if (keep.merged_into_id || source.merged_into_id) {
  return { ok: false, error: "One of the patients has already been merged. Refresh and try again." };
}
if (keep.deleted_at || source.deleted_at) {
  return {
    ok: false,
    error: "One of the patients is deleted. Restore it from Admin Tools › Deleted Patients before merging.",
  };
}
```
  - `undoMergeAction`: select `"merged_into_id, deleted_at"` for the keep row and add, after the cascade check:

```ts
if (keepRow?.deleted_at) {
  return { ok: false, error: "Can't undo: the kept patient has since been deleted. Restore it first." };
}
```
  and read the source row (`"deleted_at, merged_into_id"`) — if it is deleted (impossible today because of the 0167 check `patients_not_deleted_and_merged`, but cheap), refuse the same way.
  - The recent-merges DRM-ID lookup stays unfiltered (history) but adds `deleted_at, merged_into_id` to its select, and the recent-merges list shows `<InactivePatientBadge>` (Task 26) next to a kept record that has since been deleted — the Undo button is refused for it anyway.

- [ ] **Step 7: Run.** `npx vitest run src/lib/patients/query-surfaces.test.ts src/lib/patients` and `npm run typecheck`.
Expected: the staff files above no longer appear in "filters every active read". Merge tests in `src/app/**/patient-merge/*.test.ts` (if any) still pass.

- [ ] **Step 8: Commit.** `git commit -am "feat(patients): staff pickers, matching and worklists use the active rule"`

---

### Task 16: Apply the active rule — public booking, registration, DRM-ID recovery

**Files:** `src/app/(marketing)/schedule/actions.ts`, `src/app/(marketing)/find-my-id/actions.ts`, `src/app/(marketing)/register/actions.ts` (no direct query — covered by `resolvePatient` (0167) and `findCandidatesForInput` (Task 15); nothing to change here beyond Task 21's send gate).

- [ ] **Step 1: `/schedule` lookup** (`lookupPatientAction`):

```ts
const { data: row } = await activePatients(admin.from("patients").select("id, drm_id, first_name, last_name"))
  .eq("drm_id", drmId)
  .ilike("last_name", parsed.data.last_name)
  .maybeSingle();
```
The public response for an inactive record is the existing "We couldn't find a patient with that DRM-ID…" — generic by design (never disclose deletion). The audit row's action stays `patient.lookup.no_match`.

- [ ] **Step 2: `/schedule` submitted existing id** (inside `resolveThunk`):

```ts
const { data: row } = await activePatients(admin.from("patients").select("id, drm_id, email"))
  .eq("id", data.patient_id)
  .maybeSingle();
if (!row) return { ok: false, error: "We couldn't find that patient. Please look up again." };
```
This covers both the public existing-patient path and the portal path (whose id comes from the session — Tasks 18–19 gate the session itself). Never silently switch to a different patient id.

- [ ] **Step 3: `/find-my-id`:**

```ts
const { data: match } = await activePatients(admin.from("patients").select("id, drm_id, first_name"))
  .eq("email", email)
  .eq("last_name", last_name)
  .eq("birthdate", birthdate)
  .limit(1)
  .maybeSingle();
```
The public response stays the generic one whether or not a record matched.

- [ ] **Step 4: Run** the inventory test + typecheck. **Commit:** `git commit -am "feat(patients): public lookup, booking and DRM-ID recovery use the active rule"`

---

### Task 17: Apply the active rule — scripts and fixtures

**Files:** `scripts/patient-dedup/engine.ts`, `scripts/clinical-backfill/engine.ts`, `scripts/clinical-backfill/followups/worksheet.ts`, `scripts/clinical-backfill/followups/resolutions.ts` (verify), `scripts/seed-test-users.ts`, `scripts/seed-sample-results.ts`, `scripts/seed-screenshot-data.ts`, `scripts/smoke-chemistry-consolidated.ts`.

Scripts import from `src/lib` with the relative/alias style each file already uses (check the file's existing imports; `scripts/` resolve `@/` via tsconfig paths under tsx — if a script has no `@/` import yet, use a relative path such as `../../src/lib/patients/active`).

- [ ] **Step 1: Dedup engine.** `loadRows`: replace `.is("merged_into_id", null)` with the `activePatients(...)` wrapper. `mergeOne` idempotency re-read: select `"merged_into_id, deleted_at"` for both ids and skip (log `skip: <drm> is deleted`) when either side is deleted, exactly like the existing already-merged skip.

- [ ] **Step 2: Clinical backfill.** Patient index (L85–89): `activePatients(admin.from("patients").select("id,drm_id,last_name,first_name,sex")).range(lo, hi)`. `priorClinicalPatients` (L296–301): `activePatients(admin.from("patients").select("id,legacy_intake")).not("legacy_import_run_id", "is", null).range(lo, hi)`. Explicit DRM overrides and commit targets: where the engine resolves an explicit DRM-ID override to a patient, resolve through the active index built above (an inactive DRM-ID then fails with the engine's existing "unknown DRM-ID" error). Worksheet (L132–137): wrap with `activePatients(...)`. `followups/resolutions.ts`: confirm it has no `.from("patients")`; its targets are resolved through the engine index, so they inherit the rule.

- [ ] **Step 3: Seed/smoke fixtures.** For each fixture lookup by DRM-ID, select the lifecycle columns and refuse to reuse an inactive record:

```ts
import { isActivePatient, PATIENT_LIFECYCLE_COLUMNS } from "../src/lib/patients/active";

const { data: existing } = await admin
  .from("patients")
  .select(`id, ${PATIENT_LIFECYCLE_COLUMNS}`)
  .eq("drm_id", p.drm_id)
  .maybeSingle();
if (existing && !isActivePatient(existing)) {
  throw new Error(
    `${p.drm_id} is held by a deleted or merged record — refusing to reuse or overwrite it. Restore it or pick another fixture DRM-ID.`,
  );
}
```
Apply the same shape in all four scripts (adjust the variable names to the file). `smoke-chemistry-consolidated.ts`'s teardown hard-delete of its own fixture stays as is.

- [ ] **Step 4: Run.** `npx vitest run src/lib/patients/query-surfaces.test.ts scripts` (includes `scripts/lib/guard-coverage.test.ts`) and `npm run typecheck`.
Expected: every `scripts/` line gone from the inventory failures.

- [ ] **Step 5: Full gate.** `npm test && npm run lint`. The inventory test may still fail ONLY on files created by Tasks 18–26 ("stale SURFACES entries"); everything else must be green.

- [ ] **Step 6: Commit.** `git commit -am "feat(scripts): dedup, backfill and fixtures respect the active rule"`

---
### Task 18: Portal — `getActivePatientSession()` and no merge chain

**Files:**
- Modify: `src/lib/auth/require-patient.ts`
- Create: `src/lib/portal/active-session.test.ts`

- [ ] **Step 1: Write the failing guard test** (pure fs, like `portal-scoping.test.ts`).

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// 0167: portal access requires an ACTIVE patient record on every request.
// The bare cookie helper getPatientSession() only proves the cookie is
// signed; getActivePatientSession() also re-reads the record. Any portal
// entry point that still calls the bare helper would keep serving a deleted
// or merged record until its cookie expires.

const ROOT = process.cwd();
const PORTAL = join(ROOT, "src", "app", "(patient)", "portal");
const EXTRA = [
  "src/lib/actions/consent/portal-accept.ts",
  "src/app/(marketing)/schedule/actions.ts",
];
// The login flow mints the cookie; it never reads a session.
const ALLOWED_BARE = new Set(["src/app/(patient)/portal/login/actions.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\./.test(full)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
const files = [...walk(PORTAL).map(rel), ...EXTRA];

describe("portal entry points require an active patient record", () => {
  it("scans portal files", () => expect(files.length).toBeGreaterThan(5));

  it("never calls the bare cookie helper", () => {
    const offenders = files.filter((f) => !ALLOWED_BARE.has(f))
      .filter((f) => /\bgetPatientSession\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders, "Use getActivePatientSession() or requirePatientProfile().").toEqual([]);
  });

  it("requirePatientProfile no longer follows the merge chain", () => {
    const src = readFileSync(join(ROOT, "src/lib/auth/require-patient.ts"), "utf8");
    expect(src).not.toMatch(/merged_into_id\)/);
    expect(src).toMatch(/export async function getActivePatientSession/);
    expect(src).toMatch(/activePatients\(/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (seven bare callers; merge chain present).

- [ ] **Step 3: Rewrite `src/lib/auth/require-patient.ts`.**

```ts
import "server-only";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import type { PatientSession } from "@/lib/auth/patient-session";
import { activePatients } from "@/lib/patients/active";

export interface PatientProfile {
  patient_id: string;
  drm_id: string;
  visit_id: string;
  first_name: string;
  last_name: string;
  middle_name: string | null;
}

export interface ActivePatientSession extends PatientSession {
  first_name: string;
  last_name: string;
  middle_name: string | null;
}

// The portal's only session check (0167). Verifies the signed cookie AND
// re-reads the patient record: a deleted or merged record returns null on the
// very next request, whatever the cookie's remaining lifetime. No merge-chain
// following — the surviving record signs in with its own DRM-ID and PIN.
// Callers answer null with their existing generic "session expired" wording,
// never with the record's lifecycle state. A restore makes a still-unexpired
// cookie work again; nothing extends its lifetime.
export async function getActivePatientSession(): Promise<ActivePatientSession | null> {
  const session = await getPatientSession();
  if (!session) return null;
  const admin = createAdminClient();
  const { data: patient } = await activePatients(
    admin.from("patients").select("id, drm_id, first_name, last_name, middle_name"),
  )
    .eq("id", session.patient_id)
    .maybeSingle();
  if (!patient) return null;
  return {
    patient_id: patient.id,
    drm_id: patient.drm_id,
    visit_id: session.visit_id,
    first_name: patient.first_name,
    last_name: patient.last_name,
    middle_name: patient.middle_name,
  };
}

// Call at the top of any /portal/(authenticated)/* server component or route.
export async function requirePatientProfile(): Promise<PatientProfile> {
  const s = await getActivePatientSession();
  if (!s) redirect("/portal/login");
  return {
    patient_id: s.patient_id,
    drm_id: s.drm_id,
    visit_id: s.visit_id,
    first_name: s.first_name,
    last_name: s.last_name,
    middle_name: s.middle_name,
  };
}
```
(The old comment claiming "the middleware already gates on cookie presence" is gone — there is no middleware.)

- [ ] **Step 4: Typecheck.** `npm run typecheck` — the layout, page, book page and data-export route already call `requirePatientProfile()` and need no change.

- [ ] **Step 5: Commit** (the guard test stays red until Task 19). `git commit -am "feat(portal): getActivePatientSession — deleted/merged records lose portal access"`

---

### Task 19: Portal — every entry point, and PIN login

**Files:**
- Modify: `src/app/(patient)/portal/(authenticated)/actions.ts` (5 exports), `src/lib/actions/consent/portal-accept.ts`, `src/app/(marketing)/schedule/actions.ts` (portal branch), `src/app/(patient)/portal/login/actions.ts`

- [ ] **Step 1: The five portal actions.** In each of `getPatientConsolidatedResultDownloadUrl`, `getPatientResultDownloadUrl`, `getPackagePdfDownloadUrl`, `getPatientLabRequestFormUrl`, `deletePatientLabRequestUpload`, replace

```ts
const session = await getPatientSession();
if (!session) return { ok: false, error: "Session expired. Sign in again." };
```
with

```ts
const session = await getActivePatientSession();
if (!session) return { ok: false, error: "Session expired. Sign in again." };
```
and swap the import to `import { getActivePatientSession } from "@/lib/auth/require-patient";` (drop the `getPatientSession` import if nothing else uses it). The rest of each action already scopes reads through `createPatientClient(session.patient_id)` and, after 0167, RLS itself refuses a deleted record — the app check is the friendly half. For the two storage actions, the check runs immediately before signing/removal because it is the first line of the action; do not move it later.

- [ ] **Step 2: Portal consent acceptance** (`portal-accept.ts`): the same two-line swap (import from `@/lib/auth/require-patient`). The DB guard also refuses a consent event for a deleted record (the consent sync updates `patients`).

- [ ] **Step 3: `/schedule` portal branch:**

```ts
if (isPortalSource) {
  const session = await getActivePatientSession();
  if (!session) return { ok: false, error: "Your session expired. Please sign in again." };
  resolvedPatientIdFromSession = session.patient_id;
}
```
(Import from `@/lib/auth/require-patient`; the file is a server action module, so the `server-only` import is fine.)

- [ ] **Step 4: PIN login** (`portal/login/actions.ts`). Step 1's lookup:

```ts
const { data: patient } = await activePatients(admin.from("patients").select("id, drm_id"))
  .eq("drm_id", drm_id)
  .maybeSingle();
```
An inactive record then takes the existing `patient_not_found` branch: same `GENERIC_ERROR`, same audit shape — nothing public reveals deletion. Then, immediately before `mintPatientSession`, re-check (the record may have been deleted or merged while the PIN was being verified):

```ts
// 0167: re-check right before issuing the cookie — a record deleted or
// merged during PIN verification must not get a session.
const { data: stillActive } = await activePatients(admin.from("patients").select("id"))
  .eq("id", patient.id)
  .maybeSingle();
if (!stillActive) {
  await audit({
    actor_id: null,
    actor_type: "anonymous",
    patient_id: patient.id,
    action: "patient.signin.failed",
    metadata: { drm_id, reason: "patient_inactive_at_issue" },
    ip_address: ipAddress,
    user_agent: userAgent,
  });
  return { ok: false, error: GENERIC_ERROR };
}
```
Rate limits, lockout and PIN bookkeeping are untouched.

- [ ] **Step 5: Run.** `npx vitest run src/lib/portal src/lib/patients/query-surfaces.test.ts && npm run typecheck`
Expected: `active-session.test.ts` PASS; `portal-scoping.test.ts` PASS unchanged; the portal login and schedule lines gone from the inventory failures.

- [ ] **Step 6: Commit.** `git commit -am "feat(portal): every portal entry point and PIN login require an active record"`

---

### Task 20: Notifications — the active-recipient check

**Files:**
- Create: `src/lib/notifications/active-patient-recipient.ts`, `…/active-patient-recipient.test.ts`, `src/lib/notifications/inactive-recipient-audit.ts`, `src/lib/notifications/patient-senders.test.ts`

- [ ] **Step 1: Write the failing unit test.**

```ts
import { describe, expect, it } from "vitest";
import { recipientDecision } from "./active-patient-recipient";

const row = {
  id: "p1", drm_id: "DRM-0001", first_name: "Ana", email: "ana@example.test", phone: "09170000000",
  deleted_at: null as string | null, merged_into_id: null as string | null,
};

describe("recipientDecision", () => {
  it("treats a NULL patient id as a genuine walk-in", () => {
    expect(recipientDecision(null, null)).toEqual({ kind: "walk_in" });
  });
  it("returns the FRESH contact for an active record", () => {
    expect(recipientDecision("p1", row)).toEqual({
      kind: "active",
      patient: { id: "p1", drm_id: "DRM-0001", first_name: "Ana", email: "ana@example.test", phone: "09170000000" },
    });
  });
  it("skips deleted, merged and missing records — never a walk-in fallback", () => {
    expect(recipientDecision("p1", { ...row, deleted_at: "2026-09-24T00:00:00Z" })).toEqual({ kind: "inactive", patientId: "p1", reason: "deleted" });
    expect(recipientDecision("p1", { ...row, merged_into_id: "k" })).toEqual({ kind: "inactive", patientId: "p1", reason: "merged" });
    expect(recipientDecision("p1", null)).toEqual({ kind: "inactive", patientId: "p1", reason: "missing" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `active-patient-recipient.ts`** (no `server-only` import — unit-testable; it only takes the client as a parameter):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { PATIENT_LIFECYCLE_COLUMNS } from "@/lib/patients/active";

// The last check before ANY patient email/SMS provider call (0167). Reads the
// record fresh — deferred work (cron, retries) carries the patient_id, never a
// cached address. A deleted or merged record gets NOTHING on any channel and
// never falls back to an appointment's walk-in contact fields; a genuinely
// NULL patient id is a walk-in and is the caller's business. Staff alerts,
// newsletters and contact-form replies do not go through here (see
// patient-senders.test.ts). A provider call already admitted before a delete
// can still be in flight — that is the documented delivery boundary.

export interface RecipientPatient {
  id: string;
  drm_id: string;
  first_name: string;
  email: string | null;
  phone: string | null;
}

export type RecipientCheck =
  | { kind: "walk_in" }
  | { kind: "active"; patient: RecipientPatient }
  | { kind: "inactive"; patientId: string; reason: "deleted" | "merged" | "missing" | "lookup_failed" };

interface RecipientRow extends RecipientPatient {
  deleted_at: string | null;
  merged_into_id: string | null;
}

export function recipientDecision(patientId: string | null, row: RecipientRow | null): RecipientCheck {
  if (patientId === null) return { kind: "walk_in" };
  if (!row) return { kind: "inactive", patientId, reason: "missing" };
  if (row.merged_into_id !== null) return { kind: "inactive", patientId, reason: "merged" };
  if (row.deleted_at !== null) return { kind: "inactive", patientId, reason: "deleted" };
  return {
    kind: "active",
    patient: { id: row.id, drm_id: row.drm_id, first_name: row.first_name, email: row.email, phone: row.phone },
  };
}

export async function checkPatientRecipient(
  db: SupabaseClient<Database>,
  patientId: string | null,
): Promise<RecipientCheck> {
  if (patientId === null) return { kind: "walk_in" };
  const { data, error } = await db
    .from("patients")
    .select(`id, first_name, email, phone, ${PATIENT_LIFECYCLE_COLUMNS}`)
    .eq("id", patientId)
    .maybeSingle();
  // Fail closed: if we cannot prove the record is active, do not send.
  if (error) return { kind: "inactive", patientId, reason: "lookup_failed" };
  return recipientDecision(patientId, (data as RecipientRow | null) ?? null);
}
```

- [ ] **Step 4: The skip audit** `src/lib/notifications/inactive-recipient-audit.ts`:

```ts
import "server-only";
import { audit } from "@/lib/audit/log";

/** Staff-only record that a patient message was NOT sent (never shown to the public caller). */
export async function auditSkippedInactiveRecipient(args: {
  sender: string;
  patientId: string;
  reason: string;
  resourceType: string;
  resourceId: string | null;
}): Promise<void> {
  await audit({
    actor_id: null,
    actor_type: "system",
    // A missing record cannot be referenced (audit_log.patient_id is an FK).
    patient_id: args.reason === "missing" ? null : args.patientId,
    action: "notification.skipped_inactive_patient",
    resource_type: args.resourceType,
    resource_id: args.resourceId,
    metadata: { sender: args.sender, reason: args.reason, patient_id: args.patientId },
  });
}
```

- [ ] **Step 5: The sender inventory test** `src/lib/notifications/patient-senders.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Every file that calls sendEmail/sendSms either messages a PATIENT — and then
// must run checkPatientRecipient right before the provider call — or is listed
// here as staff/infra with the reason.
const ROOT = process.cwd();
const NOT_PATIENT: Record<string, string> = {
  "src/lib/notifications/email.ts": "The provider wrapper itself.",
  "src/lib/notifications/sms.ts": "The provider wrapper itself.",
  "src/lib/notifications/branded-email.ts": "Template helper; callers are classified.",
  "src/app/(staff)/staff/(dashboard)/admin/newsletter/actions.ts": "Newsletter subscribers, not patient records (spec: subscriptions are untouched).",
  "src/app/(staff)/staff/(dashboard)/admin/settings/alerts/actions.ts": "Test email to staff alert recipients.",
  "src/app/(staff)/staff/(dashboard)/messages/actions.ts": "Reply to a website message sender, not a patient record.",
  "src/app/api/cron/dedup-digest/route.ts": "Staff digest.",
  "src/app/api/cron/template-health/route.ts": "Staff alert.",
  "src/lib/appointments/booking-alert.ts": "Staff alert about a booking.",
  "src/lib/contact-messages/alert.ts": "Staff alert about a website message.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\./.test(full)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
const senders = walk(join(ROOT, "src")).filter((f) => /\b(sendEmail|sendSms)\s*\(/.test(readFileSync(f, "utf8"))).map(rel);

describe("patient notifications check the recipient is active", () => {
  it("finds the senders", () => expect(senders.length).toBeGreaterThan(8));
  it("every patient sender calls checkPatientRecipient", () => {
    const bad = senders
      .filter((f) => !NOT_PATIENT[f])
      .filter((f) => !/checkPatientRecipient\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(bad, "Gate the send with checkPatientRecipient, or add the file to NOT_PATIENT with a reason.").toEqual([]);
  });
  it("has no stale NOT_PATIENT entries", () => {
    expect(Object.keys(NOT_PATIENT).filter((f) => !senders.includes(f))).toEqual([]);
  });
});
```

- [ ] **Step 6: Run** `npx vitest run src/lib/notifications` — Expected: the unit test PASSES; the sender test FAILS listing the seven patient senders (Task 21 fixes them). Re-check the `NOT_PATIENT` list against `grep -rlE "sendEmail|sendSms" src | grep -v test` — if `messages/actions.ts` replies to a message that is linked to a patient record, it is still a reply to the person who wrote in (spec: contact messages are preserved, not suppressed); keep it listed.

- [ ] **Step 7: Commit.** `git add src/lib/notifications && git commit -m "feat(notifications): active-recipient check + skip audit + sender inventory"`

---

### Task 21: Notifications — gate every patient sender

**Files:** `src/lib/notifications/notify-released.ts`, `notify-released-bulk.ts`, `notify-appointment-booked.ts`, `notify-appointment-reminder.ts`, `src/app/api/cron/appointment-reminders/route.ts`, `src/app/(marketing)/register/actions.ts`, `src/app/(marketing)/find-my-id/actions.ts`, `staff/admin/patient-merge/actions.ts`.

Each sender keeps its current query for the message CONTENT and adds the recipient check immediately before its provider call. Use the returned `recipient.patient.email/phone` as the destination (fresh), not the earlier embed.

- [ ] **Step 1: Result notifications** (`notify-released.ts`, and the same shape in `notify-released-bulk.ts`). Immediately before the `Promise.all([...sendSms, sendEmail...])`:

```ts
const recipient = await checkPatientRecipient(admin, patient.id);
if (recipient.kind !== "active") {
  await auditSkippedInactiveRecipient({
    sender: "notify-released",
    patientId: patient.id,
    reason: recipient.kind === "inactive" ? recipient.reason : "walk_in",
    resourceType: "test_request",
    resourceId: testRequestId,
  });
  return;
}
const to = recipient.patient;
```
then use `to.phone` / `to.email` in the two branches (`patient.phone ? sendSms({ to: patient.phone …` → `to.phone ? sendSms({ to: to.phone …`, same for email). In the bulk file use `sender: "notify-released-bulk"`, `resourceType: "visit"`, `resourceId: visitId`.

- [ ] **Step 2: Booking confirmation** (`notify-appointment-booked.ts`). The function receives `patientId` (the appointment's `patient_id`, NULL for a walk-in). Replace the contact derivation:

```ts
const recipient = await checkPatientRecipient(admin, patientId);
if (recipient.kind === "inactive") {
  await auditSkippedInactiveRecipient({
    sender: "notify-appointment-booked",
    patientId: recipient.patientId,
    reason: recipient.reason,
    resourceType: "appointment",
    resourceId: appointmentId,
  });
  return;
}
// A linked record uses ITS fresh contact only; walk-in fields are for genuine walk-ins.
const greeting = recipient.kind === "active" ? recipient.patient.first_name : (appt.walk_in_name ?? "there");
const phone = recipient.kind === "active" ? recipient.patient.phone : (appt.walk_in_phone ?? null);
const email = recipient.kind === "active" ? recipient.patient.email : null;
```
Place it right before the existing `Promise.all` and delete the old `patient?.… ?? appt.walk_in_…` lines it replaces. (Previously an inactive linked record would have been emailed through the embed, and a NULL embed fell back to walk-in fields even for a linked id.)

- [ ] **Step 3: Reminder** (`notify-appointment-reminder.ts`): same derivation (email-only channel), before the `if (!email)` branch:

```ts
const recipient = await checkPatientRecipient(admin, patientId);
if (recipient.kind === "inactive") {
  await auditSkippedInactiveRecipient({
    sender: "notify-appointment-reminder",
    patientId: recipient.patientId,
    reason: recipient.reason,
    resourceType: "appointment",
    resourceId: appointmentId,
  });
  return { emailed: false, reason: "patient inactive" };
}
const greeting = recipient.kind === "active" ? recipient.patient.first_name : (appt.walk_in_name ?? "there");
const email = recipient.kind === "active" ? recipient.patient.email : null;
```
Cron route (`api/cron/appointment-reminders/route.ts`): select the embed and skip inactive linked records when choosing work (the sender still re-checks):

```ts
const { data: due, error } = await admin
  .from("appointments")
  .select("id, patient_id, patients ( deleted_at, merged_into_id )")
  .eq("status", "confirmed")
  .gte("scheduled_at", startIso)
  .lt("scheduled_at", endIso)
  .is("reminder_sent_at", null);
```
and at the top of the loop:

```ts
const p = Array.isArray(a.patients) ? a.patients[0] : a.patients;
if (a.patient_id && p && (p.deleted_at || p.merged_into_id)) {
  skippedInactive += 1;
  continue; // not stamped: a restored record still gets its reminder next run
}
```
declare `let skippedInactive = 0;` beside the other counters and add it to the route's JSON summary and its audit metadata. Walk-ins (`patient_id` NULL) are never skipped here.

- [ ] **Step 4: `/register`.** Before each of the three `sendEmail` calls:

```ts
const recipient = await checkPatientRecipient(admin, match.patient.id); // or res.id for the other two
if (recipient.kind !== "active") {
  await auditSkippedInactiveRecipient({
    sender: "register",
    patientId: match.patient.id,
    reason: recipient.kind === "inactive" ? recipient.reason : "walk_in",
    resourceType: "patient",
    resourceId: match.patient.id,
  });
}
```
and only send when `recipient.kind === "active"`. The public response is unchanged in every case (the page already shows the same "check your email" wording whether or not a record matched — keep it that way).

- [ ] **Step 5: `/find-my-id`** — same guard on `match.id` before its `sendEmail`; response unchanged.

- [ ] **Step 6: Merge confirmation** — before the kept-record email in `mergePatientsAction`:

```ts
const recipient = await checkPatientRecipient(admin, keep.id);
const mergeEmail =
  recipient.kind === "active" && (recipient.patient.email ?? fill.email)
    ? await sendEmail({ to: (recipient.patient.email ?? fill.email)!, subject: "Your DRMed records were combined", text, html })
    : null;
```
(keep the existing `text`/`html` construction; `fill.email` is the value the merge just copied onto the kept record). No audit skip here — the merge's own audit row already records `merge_email` status; add `recipient: recipient.kind` to that metadata.

- [ ] **Step 7: Run.** `npx vitest run src/lib/notifications && npm run typecheck`
Expected: `patient-senders.test.ts` PASS. Existing notifier tests (if any) still pass; update fakes that stubbed only the content query to also answer the `patients` recipient read.

- [ ] **Step 8: Commit.** `git commit -am "feat(notifications): no patient email or SMS to a deleted or merged record"`

---

### Task 22: Refuse writes on an inactive patient — record, consent, PIN, visits, appointments

**Files:** (paths under `staff/` unless absolute)
- `patients/[id]/edit/page.tsx`, `patients/[id]/edit-actions.ts`, `patients/[id]/actions.ts`
- `src/lib/actions/consent/grant.ts`, `src/lib/actions/consent/withdraw.ts`
- `src/lib/actions/visits/reissue-pin.ts`
- `visits/new/actions.ts` (`createVisitAction`)
- `appointments/actions.ts` (`transitionGroup`)

The guard shape (adapt the returned object to the action's own result type — every one below returns `{ ok: false; error: string }` on failure):

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPatientActive } from "@/lib/patients/require-active";

const active = await assertPatientActive(createAdminClient(), patientId);
if (!active.ok) return { ok: false, error: active.error };
```
Place it after the auth gate and input parsing, before the first read that feeds a write.

- [ ] **Step 1: Edit route + action.** `edit/page.tsx` — add the lifecycle columns to `loadDetail`'s select (`…, consent_signed_at, deleted_at, merged_into_id`) and, right after `if (!patient) notFound();`:

```ts
// 0167: a deleted or merged record is read-only — no form at all.
if (!isActivePatient(patient)) redirect(`/staff/patients/${patient.id}`);
```
(`import { isActivePatient } from "@/lib/patients/active"; import { redirect } from "next/navigation";`). `edit-actions.ts` `updatePatientAction(patientId, …)`: guard with `assertPatientActive(createAdminClient(), patientId)`. (The DB guard also refuses any edit of a deleted row with P0058; merged rows are app-guarded until PR 3.)

- [ ] **Step 2: Verify identity** (`patients/[id]/actions.ts`): guard `patientId` before the update.

- [ ] **Step 3: Consent grant + withdraw** (`grant.ts` guards `d.patientId`; `withdraw.ts` guards its `patientId`). `createPatientAction` calls grant for a brand-new record — the guard passes (active).

- [ ] **Step 4: PIN reissue** (`reissue-pin.ts`, both callers funnel here): guard `patientId` before the visit lookup. `ReissueResult` failure shape is `{ ok: false; error }` — reuse it.

- [ ] **Step 5: New visit** (`createVisitAction`): after the form is parsed and the role check passes, before `createOneVisit`:

```ts
const active = await assertPatientActive(createAdminClient(), parsed.data.patient_id);
if (!active.ok) return { ok: false, error: active.error };
```
(Use the field name the schema actually has — `patient_id` per `visits/new/actions.ts:88`.) PR 3 moves visit creation into a transactional RPC under the lifecycle lock. Do not rely on the patient guard trigger here: it only fires on a new visit when `maintain_repeat_patient_flag` actually flips `is_repeat_patient`, so this app guard is the enforcement until PR 3.

- [ ] **Step 6: Appointment check-in / reopen** (`transitionGroup`): moving to `arrived` or back to `confirmed` puts work back on an inactive record; cancelling or marking no-show does not.

```ts
if (to === "arrived" || to === "confirmed") {
  const active = await assertAppointmentsPatientsActive(createAdminClient(), appointmentIds);
  if (!active.ok) return { ok: false, error: active.error };
}
```
(`import { assertAppointmentsPatientsActive } from "@/lib/patients/require-active";`; walk-ins pass.) `completeAppointmentFromVisitAction` / `completeArrivedAppointmentsForPatientAction` run only after `createVisitAction`'s guard, and `attachPatientToAppointmentAction`'s picker is active-only (Task 15); `deleteAppointmentAction`, `cancelAppointmentAction` (public) and `bulkRescheduleForClosureAction` reduce work and stay unguarded.

- [ ] **Step 7: Run** `npm run typecheck && npx vitest run src/lib src/app` — Expected: PASS (update any action unit test whose fake Supabase client now needs to answer the `patients` lifecycle read: return `{ id, drm_id, deleted_at: null, merged_into_id: null }`).

- [ ] **Step 8: Commit.** `git commit -am "feat(patients): refuse edits, consent, PINs, new visits and check-ins on inactive records"`

---

### Task 23: Refuse writes on an inactive patient — money, clinical edits, restores, HMO

Spec: "Historical result amendments, financial reversals, claim changes and queue restores require restoring the patient first; downloads, prints and read-access audit events remain available." Deletion already requires no open work or money, so these are the paths that could put work or debt back on a deleted record.

**Files and guards** (paths under `staff/` unless absolute; `db` = `createAdminClient()`):

| Action | Guard | Placement |
|---|---|---|
| `visits/[id]/actions.ts` — `releaseTestAction`, `releaseAllReadyComponentsAction`, `releasePackageHeaderAction`, `releaseSelectedAction`, `undoReleaseSelectedAction`, `markDoctorLineDoneAction` (→ `markConsultationDoneAction`/`markProcedureDoneAction`), `waiveVisitBalanceAction` | `assertVisitPatientActive(db, visitId)` | Add inside the existing `refuseIfVisitDeleted` helper (below) so the 6 callers get it for free; add explicitly to `waiveVisitBalanceAction`, which does its own inline check |
| `src/lib/actions/visits/queue-deletion.ts` — `restoreVisitAction`, `restoreTestRequestsAction` | `assertVisitPatientActive(db, visitId)` | After the role gate. Deletes stay unguarded (they remove work) |
| `payments/new/actions.ts` — `recordPaymentAction` (covers the `redeemGiftCode` branch, dispatched from it) | `assertVisitPatientActive(db, visit_id)` | After schema parse, before the gift-code dispatch |
| `payments/[id]/void/actions.ts` — `voidPaymentAction` | `assertPaymentPatientActive(db, paymentId)` | After the role check |
| `src/lib/actions/accounting/visits-attending.ts` — `setVisitAttendingPhysician` | `assertVisitPatientActive(db, visit_id)` | After its deleted_at check |
| `queue/[id]/actions.ts` — `saveDraftAction`, `finaliseStructuredAction` (via `prepareStructured`), `uploadResultAction`, `amendResultAction`, `amendStructuredResultAction` | `assertPatientActive(db, patientId)` using the `patient_id` each already loads through `visits!inner(id, patient_id)` | In `prepareStructured` right after its load (covers the first two); inline in the other three right after their load |
| `src/lib/actions/results/finalise-consolidated.ts` — `finaliseConsolidatedReport` | `assertVisitPatientActive(db, input.visitId)` | After it proves every id belongs to the visit |
| `admin/accounting/hmo-claims/actions.ts` — `createClaimBatchAction`, `addItemsToBatchAction` | `assertTestRequestsPatientsActive(db, input.test_request_ids)` | After schema parse |
| same — `removeItemFromBatchAction`, `updateItemHmoResponseAction`, `createResolutionAction` | `assertClaimItemsPatientsActive(db, [input.item_id])` | After schema parse |
| same — `submitBatchAction`, `acknowledgeBatchAction`, `voidBatchAction`, `bulkSetHmoResponseAction` | `assertBatchPatientsActive(db, input.batch_id)` | After schema parse |
| same — `voidResolutionAction` | `assertResolutionPatientActive(db, input.resolution_id)` | After schema parse |
| same — `recordHmoSettlementAction`, `allocateExistingPaymentAction` | `assertClaimItemsPatientsActive(db, input.items.map((i) => i.item_id))` / for allocate: `assertPaymentPatientActive(db, input.payment_id)` | After schema parse |

Not guarded, on purpose: `claimTestAction`, `unclaim*`, `reassignTestAction`, `claimConsolidated` (a deleted record has no open lines to claim; claiming does not bill), `acknowledgeCriticalAlertAction` (acknowledging a past alert), `getResultDownloadUrl` and every print/download/audit-only action, the historic-claims ledger actions (`historic_hmo_claims` has no patient FK — spec).

- [ ] **Step 1: Extend `refuseIfVisitDeleted`** in `visits/[id]/actions.ts` (it runs at the top of six actions). Keep its name and return shape; add the patient check after the visit check:

```ts
async function refuseIfVisitDeleted(supabase: SupabaseClient<Database>, visitId: string) {
  // …existing visit lookup and "This visit was deleted…" refusal, unchanged…
  // 0167: history of a deleted or merged patient stays readable, but no
  // release, undo or mark-done until the record is restored.
  const active = await assertVisitPatientActive(createAdminClient(), visitId);
  if (!active.ok) return { ok: false as const, error: active.error };
  return null;
}
```
Match the helper's existing return convention exactly (read it first: it returns an error object or `null`); only the second check is new.

- [ ] **Step 2: Apply the table.** One guard per action, placed as listed, using the import `import { … } from "@/lib/patients/require-active";`. Where an action's failure type is not `{ ok: false; error }` (check `queue/[id]/actions.ts` result types), map `active.error` into its existing error field.

- [ ] **Step 3: Grep for anything missed.**

Run: `grep -rn "\"use server\"" -l src | xargs grep -lE "from\(\"(visits|test_requests|payments|visit_pins|patient_consents|results|result_test_requests|result_values|appointment_attachments|appointments|hmo_claim_items|hmo_payment_allocations|hmo_claim_resolutions|hmo_claim_batches|critical_alerts)\"\)\.(insert|update|upsert|delete)" | sort`
Expected: every file listed is covered by Task 22, this task, the "not guarded, on purpose" list, the merge actions (Task 15), or the portal actions (Task 19). Anything else: classify it the same way and add it to this table in the plan before guarding.

- [ ] **Step 4: Run** `npm run typecheck && npx vitest run src` — Expected: PASS (fake clients in action tests may need the lifecycle read, as in Task 22 Step 7).

- [ ] **Step 5: Commit.** `git commit -am "feat(patients): no release, payment, result, restore or claim change on inactive records"`

---
### Task 24: Delete / restore server actions

**Files:**
- Create: `src/lib/actions/patients/lifecycle.ts`

- [ ] **Step 1: Implement.** (The parsing it relies on is unit-tested in `deletion.test.ts`; the RPCs in the smoke test.)

```ts
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  DeletePatientSchema,
  parseBlockerDetail,
  parseBlockers,
  parseKeptCounts,
  parseLifecycleResult,
  type DeleteBlocker,
  type DeletePatientInput,
  type KeptCounts,
} from "@/lib/patients/deletion";

// Admin-only delete/restore of a patient record (0167). The database does the
// work and the audit row in one transaction (delete_patient/restore_patient);
// these actions only gate, validate and pass the server-derived actor and
// request context. They never audit a second time.

export interface DeletePreview {
  patient: {
    id: string;
    drm_id: string;
    first_name: string;
    last_name: string;
    middle_name: string | null;
    birthdate: string | null;
  };
  blockers: DeleteBlocker[];
  kept: KeptCounts;
}

export type PreviewResult = { ok: true; data: DeletePreview } | { ok: false; error: string };
export type DeleteResult =
  | { ok: true; data: { patientId: string; drmId: string } }
  | { ok: false; error: string; blockers?: DeleteBlocker[] };
export type RestoreResult =
  | { ok: true; data: { patientId: string; drmId: string } }
  | { ok: false; error: string };

const IdSchema = z.string().uuid();

function revalidatePatient(patientId: string) {
  revalidatePath("/staff/patients");
  revalidatePath(`/staff/patients/${patientId}`);
  revalidatePath("/staff/admin/deleted-patients");
}

/** What the confirm dialog shows. Advisory: delete_patient re-checks under lock. */
export async function previewPatientDeleteAction(patientId: string): Promise<PreviewResult> {
  await requireAdminStaff();
  const id = IdSchema.safeParse(patientId);
  if (!id.success) return { ok: false, error: "We couldn't find that patient." };

  const admin = createAdminClient();
  const [patientRes, blockersRes, keptRes] = await Promise.all([
    admin
      .from("patients")
      .select("id, drm_id, first_name, last_name, middle_name, birthdate, deleted_at, merged_into_id")
      .eq("id", id.data)
      .maybeSingle(),
    admin.rpc("patient_delete_blockers", { p_patient_id: id.data }),
    admin.rpc("patient_kept_counts", { p_patient_ids: [id.data] }),
  ]);
  if (patientRes.error || blockersRes.error || keptRes.error) {
    return { ok: false, error: "Could not load this patient's open items. Try again." };
  }
  const p = patientRes.data;
  if (!p) return { ok: false, error: "We couldn't find that patient." };
  if (p.deleted_at || p.merged_into_id) {
    return { ok: false, error: "This patient record is already deleted or merged." };
  }
  return {
    ok: true,
    data: {
      patient: {
        id: p.id,
        drm_id: p.drm_id,
        first_name: p.first_name,
        last_name: p.last_name,
        middle_name: p.middle_name,
        birthdate: p.birthdate,
      },
      blockers: parseBlockers(blockersRes.data),
      kept: parseKeptCounts((keptRes.data ?? [])[0]),
    },
  };
}

export async function deletePatientAction(input: DeletePatientInput): Promise<DeleteResult> {
  const session = await requireAdminStaff();
  const parsed = DeletePatientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("delete_patient", {
    p_patient_id: parsed.data.patientId,
    p_reason: parsed.data.reason,
    p_note: parsed.data.note ?? "",
    p_actor: session.user_id,
    p_context: { ip, user_agent: ua },
  });
  if (error) {
    if (error.code === "P0059") {
      return { ok: false, error: translatePgError(error), blockers: parseBlockerDetail(error.details) };
    }
    return { ok: false, error: translatePgError(error) };
  }
  const result = parseLifecycleResult(data);
  if (!result) return { ok: false, error: "The patient was deleted, but the result could not be read. Refresh the page." };
  revalidatePatient(result.patientId);
  return { ok: true, data: result };
}

export async function restorePatientAction(patientId: string): Promise<RestoreResult> {
  const session = await requireAdminStaff();
  const id = IdSchema.safeParse(patientId);
  if (!id.success) return { ok: false, error: "We couldn't find that patient." };

  const { ip, ua } = await ipAndAgent();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("restore_patient", {
    p_patient_id: id.data,
    p_actor: session.user_id,
    p_context: { ip, user_agent: ua },
  });
  if (error) return { ok: false, error: translatePgError(error) };
  const result = parseLifecycleResult(data);
  if (!result) return { ok: false, error: "The patient was restored, but the result could not be read. Refresh the page." };
  revalidatePatient(result.patientId);
  return { ok: true, data: result };
}
```
If the generated RPC arg types require a different JSON type for `p_context`, cast with `as Json` (import `type Json` from `@/types/database`) — no `any`.

- [ ] **Step 2: Typecheck + inventory.** `npm run typecheck && npx vitest run src/lib/patients/query-surfaces.test.ts` — the `lifecycle.ts` entry is no longer stale.

- [ ] **Step 3: Commit.** `git add src/lib/actions/patients && git commit -m "feat(patients): admin delete/restore/preview server actions"`

---

### Task 25: Shared `ConfirmDialog` with `confirmDisabled`

**Files:**
- Move: `staff/admin/payroll/runs/[id]/_components/confirm-dialog.tsx` → `src/components/staff/confirm-dialog.tsx`
- Modify: `staff/admin/payroll/runs/[id]/run-review-client.tsx` (import only)
- Create: `src/components/staff/confirm-dialog.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "./confirm-dialog";

vi.mock("@/lib/a11y/use-focus-trap", () => ({ useFocusTrap: () => ({ current: null }) }));

const base = {
  open: true,
  title: "Delete DRM-0001?",
  body: <p>body</p>,
  confirmLabel: "Delete patient",
  confirmVariant: "danger" as const,
  onConfirm: () => {},
  onCancel: () => {},
};

const confirmButton = (html: string) => {
  const m = /<button[^>]*>Delete patient<\/button>/.exec(html);
  return m ? m[0] : "";
};

describe("ConfirmDialog", () => {
  it("enables confirm by default", () => {
    expect(confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} />))).not.toMatch(/disabled/);
  });
  it("disables confirm when confirmDisabled", () => {
    expect(confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} confirmDisabled />))).toMatch(/disabled/);
  });
  it("renders nothing when closed", () => {
    expect(renderToStaticMarkup(<ConfirmDialog {...base} open={false} />)).toBe("");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found).

- [ ] **Step 3: Move and extend.**

```bash
git mv "src/app/(staff)/staff/(dashboard)/admin/payroll/runs/[id]/_components/confirm-dialog.tsx" src/components/staff/confirm-dialog.tsx
```
In the moved file: update the header comment ("Shared by payroll run review, patient delete/restore and Admin Tools › Deleted Patients…"), add the prop and OR it in:

```ts
  // Caller-owned extra reason to keep confirm disabled (e.g. a reason picker
  // not yet chosen, or open blockers). OR'd with the built-in checks.
  confirmDisabled?: boolean;
```
```ts
  confirmDisabled: confirmDisabledProp = false,
```
```ts
  const confirmDisabled = isPending || reasonBlocks || confirmDisabledProp;
```
In `run-review-client.tsx`: `import { ConfirmDialog } from "@/components/staff/confirm-dialog";`. If the `_components` folder is now empty, remove it.

- [ ] **Step 4: Run** `npx vitest run src/components/staff/confirm-dialog.test.tsx && npm run typecheck` — PASS. If `useFocusTrap`'s real module path differs, point the `vi.mock` at the path the component imports.

- [ ] **Step 5: Commit.** `git commit -am "refactor(staff-ui): share ConfirmDialog, add confirmDisabled"`

---

### Task 26: Delete button, restore button, lifecycle banner, row badge

**Files:**
- Create: `src/components/staff/patient-delete-button.tsx`, `restore-patient-button.tsx`, `patient-lifecycle-banner.tsx`, `inactive-patient-badge.tsx`
- Create: `src/lib/patients/lifecycle-display.ts`

- [ ] **Step 1: Banner data loader** `src/lib/patients/lifecycle-display.ts`:

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// Banner data for a deleted or merged record (0167). History pages call it
// only when the record they show is inactive. Reads regardless of lifecycle —
// that is the point.

export interface PatientLifecycleDisplay {
  patientId: string;
  drmId: string;
  deletedAt: string | null;
  deletedByName: string | null;
  deleteReason: string | null;
  deleteNote: string | null;
  mergedIntoId: string | null;
  mergedIntoDrmId: string | null;
  mergedAt: string | null;
}

export async function loadPatientLifecycle(
  db: SupabaseClient<Database>,
  patientId: string,
): Promise<PatientLifecycleDisplay | null> {
  const { data: p } = await db
    .from("patients")
    .select("id, drm_id, deleted_at, deleted_by, delete_reason, delete_note, merged_into_id, merged_at")
    .eq("id", patientId)
    .maybeSingle();
  if (!p) return null;

  const [staff, kept] = await Promise.all([
    p.deleted_by
      ? db.from("staff_profiles").select("full_name").eq("id", p.deleted_by).maybeSingle()
      : Promise.resolve({ data: null }),
    p.merged_into_id
      ? db.from("patients").select("drm_id, deleted_at, merged_into_id").eq("id", p.merged_into_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    patientId: p.id,
    drmId: p.drm_id,
    deletedAt: p.deleted_at,
    deletedByName: staff.data?.full_name ?? null,
    deleteReason: p.delete_reason,
    deleteNote: p.delete_note,
    mergedIntoId: p.merged_into_id,
    mergedIntoDrmId: kept.data?.drm_id ?? null,
    mergedAt: p.merged_at,
  };
}
```

- [ ] **Step 2: Restore button** `src/components/staff/restore-patient-button.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/staff/confirm-dialog";
import { restorePatientAction } from "@/lib/actions/patients/lifecycle";

export function RestorePatientButton({ patientId, drmId }: { patientId: string; drmId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onConfirm() {
    setError(null);
    start(async () => {
      const res = await restorePatientAction(patientId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      toast.success(`${res.data.drmId} restored`);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[36px] rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        Restore
      </button>
      <ConfirmDialog
        open={open}
        title={`Restore ${drmId}?`}
        body={
          <div className="space-y-2">
            <p>
              This puts the record back in the patient list, the pickers and the patient portal. Its visits
              and history are unchanged, and it keeps its DRM-ID.
            </p>
            <p className="text-[color:var(--color-brand-text-soft)]">
              If the patient registered again while this record was deleted, restore it and then merge the two
              records in Admin Tools › Merge Duplicate Patients.
            </p>
          </div>
        }
        confirmLabel="Restore"
        confirmVariant="primary"
        onConfirm={onConfirm}
        onCancel={() => {
          if (!pending) setOpen(false);
        }}
        isPending={pending}
        errorMessage={error}
      />
    </>
  );
}
```

- [ ] **Step 3: Banner** `src/components/staff/patient-lifecycle-banner.tsx` (server component):

```tsx
import Link from "next/link";
import { manilaDate } from "@/lib/dates/manila";
import { deleteReasonLabel } from "@/lib/patients/deletion";
import type { PatientLifecycleDisplay } from "@/lib/patients/lifecycle-display";
import { RestorePatientButton } from "./restore-patient-button";

// Shown on every history page of a deleted or merged record. Screen only —
// never on a printout.
export function PatientLifecycleBanner({
  lifecycle,
  isAdmin,
  className = "",
}: {
  lifecycle: PatientLifecycleDisplay;
  isAdmin: boolean;
  className?: string;
}) {
  if (lifecycle.mergedIntoId) {
    return (
      <div role="status" className={`print:hidden rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 ${className}`}>
        This record was merged into{" "}
        <Link href={`/staff/patients/${lifecycle.mergedIntoId}`} className="font-semibold underline">
          {lifecycle.mergedIntoDrmId ?? "another record"}
        </Link>
        {lifecycle.mergedAt ? ` on ${manilaDate(lifecycle.mergedAt)}` : ""}. Use the surviving record for
        anything new.
      </div>
    );
  }
  if (!lifecycle.deletedAt) return null;
  const reason = deleteReasonLabel(lifecycle.deleteReason);
  return (
    <div
      role="status"
      className={`print:hidden flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 ${className}`}
    >
      <p>
        This patient record was deleted on {manilaDate(lifecycle.deletedAt)} by{" "}
        {lifecycle.deletedByName ?? "an admin"} ({reason}
        {lifecycle.deleteNote ? `: ${lifecycle.deleteNote}` : ""}). Its history stays on file; nothing new can
        be added until it is restored.
      </p>
      {isAdmin ? <RestorePatientButton patientId={lifecycle.patientId} drmId={lifecycle.drmId} /> : null}
    </div>
  );
}
```

- [ ] **Step 4: Row badge** `src/components/staff/inactive-patient-badge.tsx`:

```tsx
// For list rows (results archive, appointments) whose patient record is
// deleted or merged. The row stays — history — but staff can see why the
// patient is missing from the directory.
export function InactivePatientBadge({
  deletedAt,
  mergedIntoId,
}: {
  deletedAt: string | null | undefined;
  mergedIntoId: string | null | undefined;
}) {
  if (!deletedAt && !mergedIntoId) return null;
  return (
    <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-800">
      {mergedIntoId ? "Merged record" : "Deleted record"}
    </span>
  );
}
```

- [ ] **Step 5: Delete button + dialog** `src/components/staff/patient-delete-button.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/staff/confirm-dialog";
import {
  deletePatientAction,
  previewPatientDeleteAction,
  restorePatientAction,
  type DeletePreview,
} from "@/lib/actions/patients/lifecycle";
import {
  DELETE_NOTE_MAX,
  DELETE_REASONS,
  DELETE_REASON_LABEL,
  groupBlockers,
  keptSummary,
  type DeleteBlocker,
  type DeleteReason,
} from "@/lib/patients/deletion";
import { formatPatientName } from "@/lib/patients/format-name";
import { formatPhp } from "@/lib/marketing/format";
import { manilaDate } from "@/lib/dates/manila";

// Admin-only. The dialog asks the database what is still open (appointments,
// unfinished work, money, HMO claims) and disables confirmation while
// anything is; delete_patient() re-checks under its own lock, so this list
// is advisory. Reason is required; a note is required for "Other".
export function PatientDeleteButton({
  patientId,
  drmId,
  initialReason,
}: {
  patientId: string;
  drmId: string;
  initialReason?: DeleteReason;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [blockers, setBlockers] = useState<DeleteBlocker[]>([]);
  const [reason, setReason] = useState<DeleteReason | "">(initialReason ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [pending, startDelete] = useTransition();

  function openDialog() {
    setOpen(true);
    setError(null);
    setPreview(null);
    setBlockers([]);
    startLoading(async () => {
      const res = await previewPatientDeleteAction(patientId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPreview(res.data);
      setBlockers(res.data.blockers);
    });
  }

  function close() {
    if (pending) return;
    setOpen(false);
    setReason(initialReason ?? "");
    setNote("");
    setError(null);
  }

  function confirm() {
    if (!reason) return;
    setError(null);
    startDelete(async () => {
      const res = await deletePatientAction({ patientId, reason, note });
      if (!res.ok) {
        setError(res.error);
        if (res.blockers) setBlockers(res.blockers);
        return;
      }
      setOpen(false);
      const deleted = res.data.drmId;
      toast.success(`${deleted} deleted`, {
        duration: 10_000,
        action: {
          label: "Undo",
          onClick: () => {
            void restorePatientAction(patientId).then((r) => {
              if (r.ok) {
                toast.success(`${deleted} restored`);
                router.refresh();
              } else {
                toast.error(r.error);
              }
            });
          },
        },
      });
      router.push("/staff/patients");
    });
  }

  const trimmedNote = note.trim();
  const confirmDisabled =
    loading ||
    !preview ||
    blockers.length > 0 ||
    !reason ||
    (reason === "other" && trimmedNote.length === 0) ||
    trimmedNote.length > DELETE_NOTE_MAX;

  const groups = groupBlockers(blockers);

  const body = (
    <div className="space-y-4">
      {loading ? (
        <p className="text-[color:var(--color-brand-text-soft)]">Checking what this record still has open…</p>
      ) : null}
      {preview ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">Patient</dt>
            <dd className="font-semibold">{formatPatientName(preview.patient) || "(no name on file)"}</dd>
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">DRM-ID</dt>
            <dd className="font-mono">{preview.patient.drm_id}</dd>
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">Birthdate</dt>
            <dd>{preview.patient.birthdate ? manilaDate(preview.patient.birthdate) : "—"}</dd>
          </dl>
          <p className="rounded-md bg-[color:var(--color-brand-bg)] px-3 py-2">
            <b>These stay on file:</b> {keptSummary(preview.kept)}. Deleting hides the record from the patient
            list, the pickers, booking and the patient portal. It does not erase any history, and an admin can
            restore it from Admin Tools › Deleted Patients.
          </p>
        </>
      ) : null}

      {groups.length > 0 ? (
        <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-900">
          <p className="font-bold">This record can&apos;t be deleted yet. Close these first:</p>
          {groups.map((g) => (
            <div key={g.kind} className="mt-2">
              <p className="text-xs font-bold uppercase tracking-wider">{g.title}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {g.items.map((b) => (
                  <li key={`${b.kind}:${b.resource_id}`}>
                    {b.href ? (
                      <Link href={b.href} className="underline hover:no-underline">
                        {b.label}
                      </Link>
                    ) : (
                      b.label
                    )}
                    {b.amount_php !== null ? ` (${formatPhp(b.amount_php)})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {preview && groups.length === 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Why is this record being deleted? (required)
          </legend>
          {DELETE_REASONS.map((r) => (
            <label key={r} className="flex items-center gap-2">
              <input
                type="radio"
                name="delete-reason"
                value={r}
                checked={reason === r}
                onChange={() => setReason(r)}
                disabled={pending}
              />
              {DELETE_REASON_LABEL[r]}
            </label>
          ))}
          <label htmlFor="delete-note" className="block pt-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Note {reason === "other" ? "(required)" : "(optional)"}
          </label>
          <textarea
            id="delete-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={DELETE_NOTE_MAX + 50}
            disabled={pending}
            aria-required={reason === "other"}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
          <p className={`text-xs ${trimmedNote.length > DELETE_NOTE_MAX ? "text-rose-700" : "text-[color:var(--color-brand-text-soft)]"}`}>
            {trimmedNote.length}/{DELETE_NOTE_MAX}
          </p>
        </fieldset>
      ) : null}
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-md border border-rose-700 px-4 py-2 text-sm font-bold text-rose-700 hover:bg-rose-50"
      >
        Delete patient
      </button>
      <ConfirmDialog
        open={open}
        title={`Delete ${drmId}?`}
        body={body}
        confirmLabel="Delete patient"
        confirmVariant="danger"
        confirmDisabled={confirmDisabled}
        onConfirm={confirm}
        onCancel={close}
        isPending={pending}
        errorMessage={error}
      />
    </>
  );
}
```
`formatPatientName`, `formatPhp` and `manilaDate` are pure (client-safe) — confirm none imports `server-only`. `date-render-surfaces.test.ts` accepts `manilaDate`.

- [ ] **Step 6: Typecheck + tests.** `npm run typecheck && npx vitest run src/components src/lib/patients src/lib/dates`

- [ ] **Step 7: Commit.** `git add src/components/staff src/lib/patients/lifecycle-display.ts && git commit -m "feat(staff-ui): patient delete dialog, restore button, lifecycle banner and badge"`

---

### Task 27: Patient page and edit page

**Files:** `staff/patients/[id]/page.tsx`, `staff/patients/[id]/consent/consent-panel.tsx`

- [ ] **Step 1: Load lifecycle.** In `loadDetail`'s select append `, deleted_at, merged_into_id`. After `if (!patient) notFound();`:

```ts
const patientActive = isActivePatient(patient);
const lifecycle = patientActive ? null : await loadPatientLifecycle(supabase, id);
```
Imports: `isActivePatient` from `@/lib/patients/active`, `loadPatientLifecycle` from `@/lib/patients/lifecycle-display`, `PatientLifecycleBanner`, `PatientDeleteButton` from `@/components/staff/…`.

- [ ] **Step 2: Header.** Under the `<header>` block:

```tsx
{lifecycle ? <PatientLifecycleBanner lifecycle={lifecycle} isAdmin={isAdmin} className="mt-4" /> : null}
```
Render the actions `<div className="flex flex-wrap gap-2">` only when `patientActive`, and add the Delete button for admins inside it, last:

```tsx
{patientActive ? (
  <div className="flex flex-wrap gap-2">
    {/* Edit, ReissuePinButton, + Start visit — unchanged */}
    {isAdmin ? <PatientDeleteButton patientId={patient.id} drmId={patient.drm_id} /> : null}
  </div>
) : null}
```
Also gate `<VerifyIdentityButton>` and the DOB-warning "Edit" link on `patientActive`.

- [ ] **Step 3: Consent panel read-only.** Add `readOnly?: boolean` to `ConsentPanel`'s props (default `false`). Wrap "Capture signature", "Attach signed paper form" and "Withdraw consent" in `!readOnly &&` (keep "Print form" and "View signed form" — reads). Pass `readOnly={!patientActive}` from the page. The server actions refuse regardless (Task 22).

- [ ] **Step 4: Edit page** was handled in Task 22 Step 1 — confirm by opening `/staff/patients/<deleted id>/edit` in Task 31's browser smoke (it must land on the record page).

- [ ] **Step 5: Typecheck + tests.** `npm run typecheck && npx vitest run src/app src/lib/patients`

- [ ] **Step 6: Commit.** `git commit -am "feat(patients): delete button, banner and read-only mode on the patient page"`

---

### Task 28: History pages — visit, receipt, lab queue detail, results archive, appointments

**Files:** `staff/visits/[id]/page.tsx`, `staff/visits/[id]/receipt/page.tsx`, `staff/queue/[id]/page.tsx`, `staff/results/page.tsx`, `staff/appointments/page.tsx`

- [ ] **Step 1: Visit page.** Add `deleted_at, merged_into_id` to the `patients!inner ( … )` embed in `loadDetail`. After the patient is read:

```ts
const patientActive = isActivePatient({ drm_id: patient.drm_id, deleted_at: patient.deleted_at, merged_into_id: patient.merged_into_id });
const lifecycle = patientActive ? null : await loadPatientLifecycle(supabase, patient.id);
```
Render `{lifecycle ? <PatientLifecycleBanner lifecycle={lifecycle} isAdmin={isAdmin} className="mt-4" /> : null}` directly under the page header (use the page's existing admin flag; if it has none, `const isAdmin = session.role === "admin"`). Then render these controls only when `patientActive` (line numbers from 2026-09-24; re-find by component name): `ReissuePinButton` (L464), the "Record payment" link (L486–489), every `QueueDeleteDialog` (L494, 543, 758, 1097, 1200), `WaiveBalanceDialog` (L576), `AttendingPhysicianDialog` (L597), `ReleaseAllButton` (L711), `ReleasePackageHeaderButton` (L736), `BulkActionBar` (L1134), `VoidPaymentDialog` (L1252), `MarkDoneButton` (L1502), `ReleaseButton` (L1514), `UndoReleaseDialog` (L1570). Keep every read-only element (result views, downloads, receipt link, print).

- [ ] **Step 2: Receipt.** Add the two columns to its `patients!inner ( … )` embed; when inactive, render the banner at the top (`print:hidden` is built in) — the receipt itself still prints unchanged.

- [ ] **Step 3: Lab queue detail** (`queue/[id]/page.tsx`): load the patient's lifecycle from the embed it already has (add the two columns); when inactive, show the banner and hide `ReassignPanel`, `UnclaimOwnButton`, `ClaimButton`, `StructuredResultForm`, `UploadResultForm`, `AmendResultForm`; keep `ViewResultButton`.

- [ ] **Step 4: Results archive** (`results/page.tsx`): add `deleted_at, merged_into_id` to the `patients!inner ( first_name, last_name, drm_id )` embed and its row type (L115/L612), and render `<InactivePatientBadge deletedAt={pat.deleted_at} mergedIntoId={pat.merged_into_id} />` right after the DRM-ID (L477). No filter changes — history.

- [ ] **Step 5: Appointments list** (`appointments/page.tsx`): add the two columns to `APPT_SELECT`'s `patients ( … )` embed and the row type; carry `patient_deleted_at` / `patient_merged_into_id` through the row mapping (L167 area, next to `patient_drm_id`); render the badge next to the DRM-ID wherever it is printed (L982 and the grouped view). Also hide the row's transition buttons that return work (`markArrived`, `revertToConfirmed`) for an inactive linked patient — the server refuses anyway (Task 22 Step 6).

- [ ] **Step 6: Run** `npm run typecheck && npx vitest run src/app src/lib/visits src/lib/dates` — `query-surfaces.test.ts` (visits) must stay green: these pages already classify their `visits`/`test_requests` reads; adding embed columns does not change that.

- [ ] **Step 7: Commit.** `git commit -am "feat(staff-ui): deleted-record banner and badges on history pages; mutations hidden"`

---

### Task 29: Admin Tools › Deleted Patients (+ CSV export)

**Files:**
- Create: `staff/admin/deleted-patients/page.tsx`, `src/lib/reports/deleted-patients.ts`, `src/app/api/admin/reports/deleted-patients.csv/route.ts`
- Modify: `src/lib/staff/route-names.ts`, `src/components/staff/staff-nav-config.ts`

- [ ] **Step 1: Route name + nav.** In `route-names.ts` add `"/staff/admin/deleted-patients": "Deleted Patients",` (Title Case — `drmed-nav-label-title-case`). In `staff-nav-config.ts`, in the Admin Tools section, after the `patient-merge` item:

```ts
          {
            href: "/staff/admin/deleted-patients",
            label: ROUTE_NAME["/staff/admin/deleted-patients"],
            description:
              "Patient records an admin deleted (duplicates, test records, patient requests). Their history stays on file; restore a record here to put it back in the patient list.",
            roles: ["admin"],
          },
```

- [ ] **Step 2: Shared loader** `src/lib/reports/deleted-patients.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchAllRows } from "@/lib/reports/paging";
import { deleteReasonLabel } from "@/lib/patients/deletion";
import { manilaDateTime } from "@/lib/dates/manila";

// Admin Tools › Deleted Patients and its CSV. Reads v_patients_directory_admin
// (0167) through the RLS client: the view returns rows only to admins.

export const DELETED_SORTABLE = ["deleted_at", "drm_id", "last_name", "deleted_by_name"] as const;
export type DeletedSortColumn = (typeof DELETED_SORTABLE)[number];

export const DELETED_SELECT =
  "id, drm_id, first_name, middle_name, last_name, deleted_at, deleted_by_name, delete_reason, delete_note";

export interface DeletedPatientRow {
  id: string;
  drm_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  deleted_at: string;
  deleted_by_name: string | null;
  delete_reason: string;
  delete_note: string | null;
}

export function deletedPatientsQuery(
  db: SupabaseClient<Database>,
  sort: { key: DeletedSortColumn; dir: "asc" | "desc" },
  opts: { count?: boolean } = {},
) {
  return db
    .from("v_patients_directory_admin")
    .select(DELETED_SELECT, opts.count ? { count: "exact" } : undefined)
    .not("deleted_at", "is", null)
    .order(sort.key, { ascending: sort.dir === "asc", nullsFirst: false })
    .order("id", { ascending: true });
}

export async function loadAllDeletedPatients(
  db: SupabaseClient<Database>,
  sort: { key: DeletedSortColumn; dir: "asc" | "desc" },
  maxRows: number,
) {
  return fetchAllRows<DeletedPatientRow>(
    (from, to) => deletedPatientsQuery(db, sort).range(from, to) as unknown as PromiseLike<{
      data: DeletedPatientRow[] | null;
      error: { message: string } | null;
    }>,
    maxRows,
  );
}

export function deletedPatientsCsvRows(
  rows: readonly DeletedPatientRow[],
  kept: ReadonlyMap<string, { visits: number; payments: number; appointments: number; consents: number }>,
): string[][] {
  return [
    ["DRM-ID", "Last name", "First name", "Middle name", "Deleted on", "Deleted by", "Reason", "Note",
     "Visits", "Payments", "Appointments", "Consent records"],
    ...rows.map((r) => {
      const k = kept.get(r.id);
      return [
        r.drm_id, r.last_name, r.first_name, r.middle_name ?? "", manilaDateTime(r.deleted_at),
        r.deleted_by_name ?? "", deleteReasonLabel(r.delete_reason), r.delete_note ?? "",
        String(k?.visits ?? 0), String(k?.payments ?? 0), String(k?.appointments ?? 0), String(k?.consents ?? 0),
      ];
    }),
  ];
}
```
Kept counts come from `patient_kept_counts` (service_role) — chunk ids by 500 in the page and the route. Add a unit test `src/lib/reports/deleted-patients.test.ts` for `deletedPatientsCsvRows` (header row, reason label, zero-filled counts).

- [ ] **Step 3: Page** `staff/admin/deleted-patients/page.tsx`:

```tsx
import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { RestorePatientButton } from "@/components/staff/restore-patient-button";
import {
  ariaSortFor, buildListHref, nextSort, pageCount, parsePage, parsePageSize, parseSort, rangeFor, type SortSpec,
} from "@/lib/ui/table-params";
import { formatPatientName } from "@/lib/patients/format-name";
import { deleteReasonLabel, keptSummary, parseKeptCounts } from "@/lib/patients/deletion";
import { manilaDate } from "@/lib/dates/manila";
import {
  DELETED_SORTABLE, deletedPatientsQuery, type DeletedPatientRow, type DeletedSortColumn,
} from "@/lib/reports/deleted-patients";

export const metadata = { title: "Deleted Patients" };

const BASE_PATH = "/staff/admin/deleted-patients";
const DEFAULT_SORT: SortSpec<DeletedSortColumn> = { key: "deleted_at", dir: "desc" };

interface Props {
  searchParams: Promise<{ sort?: string; dir?: string; page?: string; size?: string }>;
}

export default async function DeletedPatientsPage({ searchParams }: Props) {
  await requireAdminStaff();
  const params = await searchParams;
  const sort = parseSort(params.sort, params.dir, DELETED_SORTABLE, DEFAULT_SORT);
  const size = parsePageSize(params.size);
  const page = parsePage(params.page);
  const [from, to] = rangeFor(page, size);

  const supabase = await createClient();
  const { data, count, error } = await deletedPatientsQuery(supabase, sort, { count: true }).range(from, to);
  const rows = (data ?? []) as DeletedPatientRow[];
  const total = count ?? 0;
  const totalPages = pageCount(total, size);

  // Display enrichment only (never sort/filter/page input). service_role RPC,
  // called after the admin gate above.
  const kept = new Map<string, ReturnType<typeof parseKeptCounts>>();
  if (rows.length > 0) {
    const { data: counts } = await createAdminClient().rpc("patient_kept_counts", {
      p_patient_ids: rows.map((r) => r.id),
    });
    for (const c of counts ?? []) kept.set(c.patient_id, parseKeptCounts(c));
  }

  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === PAGE_SIZES[2] ? null : String(size),
  };
  const sortHref = (key: DeletedSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };
  const th = (key: DeletedSortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Deleted Patients"
        subtitle="Records an admin deleted. Their visits, payments and results stay on file; restoring puts the record back everywhere."
        actions={
          <ExportCsvLink
            href={buildListHref("/api/admin/reports/deleted-patients.csv", { sort: sort.key, dir: sort.dir })}
          />
        }
      />
      {error ? (
        <p role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Could not load deleted patients. Refresh the page.
        </p>
      ) : null}
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("drm_id", "DRM-ID")}
              {th("last_name", "Name")}
              {th("deleted_at", "Deleted on")}
              {th("deleted_by_name", "Deleted by")}
              <PlainTh label="Reason" />
              <PlainTh label="On file" />
              <PlainTh label="" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
                  No deleted patient records.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 font-mono">
                    <Link href={`/staff/patients/${r.id}`} className="text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]">
                      {r.drm_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{formatPatientName(r) || "(no name on file)"}</td>
                  <td className="px-4 py-3">{manilaDate(r.deleted_at)}</td>
                  <td className="px-4 py-3">{r.deleted_by_name ?? "—"}</td>
                  <td className="px-4 py-3">
                    {deleteReasonLabel(r.delete_reason)}
                    {r.delete_note ? (
                      <span className="block text-xs text-[color:var(--color-brand-text-soft)]">{r.delete_note}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                    {keptSummary(kept.get(r.id) ?? parseKeptCounts(null))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RestorePatientButton patientId={r.id} drmId={r.drm_id} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
      <ListPagination
        page={page}
        pageCount={totalPages}
        total={total}
        size={size}
        prevHref={page > 1 ? buildListHref(BASE_PATH, baseParams, { page: page - 1 > 1 ? String(page - 1) : null }) : null}
        nextHref={page < totalPages ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) }) : null}
        sizeOptions={PAGE_SIZES.map((s) => ({
          size: s,
          href: buildListHref(BASE_PATH, baseParams, { size: s === PAGE_SIZES[2] ? null : String(s), page: null }),
        }))}
        noun="deleted patient"
      />
    </div>
  );
}
```
`PAGE_SIZES[2]` is 25 = `DEFAULT_PAGE_SIZE`; import `DEFAULT_PAGE_SIZE` from `table-params` instead if you prefer the name. Use `buildListHref`'s real signature (base, params, overrides) for the export link if it requires the third argument.

- [ ] **Step 4: CSV route** `src/app/api/admin/reports/deleted-patients.csv/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportCsvResponse } from "@/lib/reports/csv-response";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { parseSort } from "@/lib/ui/table-params";
import { parseKeptCounts } from "@/lib/patients/deletion";
import { DELETED_SORTABLE, deletedPatientsCsvRows, loadAllDeletedPatients } from "@/lib/reports/deleted-patients";

// Admin-only, RLS-scoped rows, hard ceiling, audit row (report.deleted_patients.exported).
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const staff = await requireAdminStaff();
  const sp = req.nextUrl.searchParams;
  const sort = parseSort(sp.get("sort") ?? undefined, sp.get("dir") ?? undefined, DELETED_SORTABLE, {
    key: "deleted_at",
    dir: "desc",
  });
  const supabase = await createClient();
  const { rows, truncated } = await loadAllDeletedPatients(supabase, sort, REPORT_EXPORT_MAX_ROWS);

  const admin = createAdminClient();
  const kept = new Map<string, ReturnType<typeof parseKeptCounts>>();
  for (let i = 0; i < rows.length; i += 500) {
    const { data } = await admin.rpc("patient_kept_counts", {
      p_patient_ids: rows.slice(i, i + 500).map((r) => r.id),
    });
    for (const c of data ?? []) kept.set(c.patient_id, parseKeptCounts(c));
  }

  return reportCsvResponse({
    staff,
    report: "deleted_patients",
    filename: "deleted-patients.csv",
    rows: deletedPatientsCsvRows(rows, kept),
    truncated,
    filters: { sort: sort.key, dir: sort.dir },
  });
}
```

- [ ] **Step 5: Run** `npm run typecheck && npx vitest run src/lib/reports src/components/staff src/app` (includes `staff-page-titles.test.ts` and `staff-nav-config.test.ts`).

- [ ] **Step 6: Commit.** `git add -A src && git commit -m "feat(admin): Deleted Patients page with restore and CSV export"`

---

### Task 30: Documentation

**Files:** `docs/drmed-user-guide.html`, `CLAUDE.md`, `.claude/skills/drmed-{migrations,rls-and-auth,booking-and-intake,payments,staff-ui}/SKILL.md` (tracked copies in this worktree).

- [ ] **Step 1: User guide.** In "5.6 Patient tools", add after "Merge Duplicate Patients" (same `<dl class="defs">` idiom — `<kbd class="ui">` for buttons, `<b>` for page names, `<q>` for on-screen wording):

```html
  <dt>Delete a patient record</dt><dd>Admins only. On the patient's page, <kbd class="ui">Delete patient</kbd> opens a box that shows what stays on file (visits, payments, appointments, consent records) and asks for a reason: <b>Duplicate record</b>, <b>Test record</b>, <b>Requested by the patient</b> or <b>Other</b> (Other needs a note). Nothing is erased: the record disappears from the patient list, the pickers, online booking and the patient portal, and the patient stops getting result and appointment messages. Old visits, receipts, results and reports keep working and show <q>This patient record was deleted on … by … (…)</q>. The button is disabled while anything is still open, and the box lists each item with a link: an upcoming or callback appointment, an unfinished test or consultation, a visit with nothing on it, an unpaid balance, an unpaid HMO patient share, an HMO claim that is not settled, approved HMO coverage that was never claimed, or HMO records that need reconciling first. After deleting, <kbd class="ui">Undo</kbd> on the confirmation restores it.</dd>
  <dt>Deleted Patients</dt><dd>Admin Tools › <b>Deleted Patients</b> lists every deleted record with who deleted it, when and why, and what stays on file. <kbd class="ui">Restore</kbd> puts a record back everywhere with the same DRM-ID; a patient portal sign-in that had not yet expired works again. If the person registered again while their record was deleted, they got a new DRM-ID — restore the old record, then merge the two. <kbd class="ui">Export CSV</kbd> downloads the list (logged as an export).</dd>
```
Also update the portal/booking section wherever it says what happens on sign-in with a merged record (it used to follow the merge; now a merged or deleted DRM-ID signs in with the generic <q>Invalid DRM-ID or PIN</q> message), and bump the guide's version/date line (next minor version, today's date).

- [ ] **Step 2: Skills.** `drmed-migrations`: P-code registry → P0057–P0061 (meanings from the table at the top of this plan), the private-role pattern (`patient_lifecycle_writer`, SET+INHERIT for postgres, never a runtime member), and "0167 must follow 0162". `drmed-rls-and-auth`: `current_patient_id()` is now SECURITY DEFINER + active-only; `getActivePatientSession()` is the only portal session check; `active-session.test.ts`. `drmed-booking-and-intake`: `resolve_patient_guarded` matches active records only (a deleted identity gets a fresh DRM-ID); `activePatients()` on every lookup. `drmed-payments`: the write guards in Task 23 (payments, voids, HMO claims refuse on inactive records). `drmed-staff-ui`: shared `ConfirmDialog` path + `confirmDisabled`, `PatientLifecycleBanner`, `InactivePatientBadge`, "Deleted Patients" nav item. Then copy each changed tracked skill to the container root if the global instruction applies to DRMed (`~/Claude/DRMed/.claude/skills/…` is the same tracked tree in the main checkout — update it through this PR, not by hand).

- [ ] **Step 3: CLAUDE.md "Where things live"** — add rows:

```
| The active-patient rule (`activePatients`, `isActivePatient`) and the write guards (`assertPatientActive`, `assertVisitPatientActive`, …) — pinned by `src/lib/patients/query-surfaces.test.ts` and `active-views.test.ts` | `src/lib/patients/{active,require-active}.ts` |
| Patient delete/restore: reasons, blocker parsing, server actions, banner data | `src/lib/patients/{deletion,lifecycle-display}.ts`, `src/lib/actions/patients/lifecycle.ts` |
| Final recipient check before every patient email/SMS | `src/lib/notifications/active-patient-recipient.ts` (+ `patient-senders.test.ts`) |
```
and under "Cross-cutting rules" one bullet: "**Patient reads declare whether they mean ACTIVE records.** Directory/picker/matching/authentication reads wrap the builder in `activePatients(...)`; history reads never filter; the inventory test fails on an unclassified `.from("patients")`."

- [ ] **Step 4: Commit.** `git add docs CLAUDE.md .claude/skills && git commit -m "docs: patient delete/restore in the user guide, skills and CLAUDE.md"`

---

### Task 31: Full verification

- [ ] **Step 1: Static gates.** `npm test && npm run typecheck && npm run lint` — all PASS. Capture to a log file and report only failures.

- [ ] **Step 2: Mutation-check the TS guards** (vacuous-assertions rule). Temporarily remove `activePatients(` from `schedule/actions.ts`'s lookup → `query-surfaces.test.ts` must FAIL. Temporarily add `.is("deleted_at", null)` to `audit/page.tsx`'s patient enrichment → it must FAIL ("never filters a history read"). Temporarily revert one sender's `checkPatientRecipient` → `patient-senders.test.ts` must FAIL. Revert all three.

- [ ] **Step 3: Full replay on a fresh local database — coordinate first.** The stack is shared: `db reset` re-applies ONLY this branch's migrations and wipes other sessions' local state. Before running it, check `git log origin/main --oneline -1` contains 0162 (else this branch lacks it and the replay differs from prod) and ask the controller/owner that no other session is mid-smoke on the local stack. Then:

```bash
/opt/homebrew/bin/supabase db reset 2>&1 | tail -5
docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/0167_patient_soft_delete_smoke.sql 2>&1 | grep -E "NOTICE|ERROR" | tail -80
```
Expected: the full history applies (no error), every `0167 s…` notice is `OK`, including s7.8–s7.11 now that `seed.sql`'s blanket grants and carve-outs have run. Also run the neighbouring smoke tests the change could affect: `0147_hmo_claim_delete_guard_smoke.sql`, `0151_rls_initplan_smoke.sql`.

- [ ] **Step 4: Browser smoke (Playwright MCP, local dev).** Follow the DRMed local-smoke recipe (dev server on port 3005 pointed at the LOCAL stack via `.env.development.local`; local GoTrue admin user — see memory `drmed-sidebar-cleanup`). Seed a throwaway patient with one paid, released visit. Verify with `browser_snapshot`/`browser_evaluate` text checks, screenshots only for the dialog and the banner:
  1. Patient page (admin) shows **Delete patient**; open it → kept summary shows `1 visit, 1 payment, …`; confirm disabled until a reason is picked; pick **Other** → still disabled until a note is typed.
  2. Delete → lands on the patient list with a `DRM-… deleted · Undo` toast; the record is gone from the list and from the new-visit picker and the staff booking search.
  3. Open the old visit by URL → the banner shows; release/payment/void/waive controls are gone; the receipt still renders.
  4. `/staff/patients/<id>/edit` redirects to the record page. The record page shows the banner, no Edit/PIN/Start visit/Delete.
  5. Admin Tools › Deleted Patients lists it with counts; **Restore** → back in the list; the banner is gone.
  6. A reception user: the patient page of a deleted record shows the banner with no Restore; `/staff/admin/deleted-patients` redirects away.
  7. Blocked case: give the throwaway patient a `pending_callback` appointment → the dialog lists it under "Open appointments" with a working link, and confirmation stays disabled.
  8. Portal: sign in as the throwaway patient (issue a PIN locally), delete the record in another tab, then download a result → "Session expired. Sign in again."; sign-in again → the generic invalid message.
  Record what was checked and any failure in the task report.

- [ ] **Step 5: Commit any fixes** with their own messages; re-run Step 1.

---

### Task 32: Review gates

- [ ] **Step 1: Code review** — invoke `superpowers:requesting-code-review` over `git diff origin/main...HEAD` (Opus reviewer; focus: guard trigger + role grants, blocker SQL arithmetic, RLS helper, ACLs, portal session, write guards, notification gating).
- [ ] **Step 2: Codex review** — `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"` then `/codex-review` (never through a pipe; open the report and confirm `Status: Completed` before trusting it). On this repo the Codex spec review found 10 real gaps — treat its findings seriously.
- [ ] **Step 3: Fix confirmed findings** (rule: close real gaps by matching existing patterns), re-run Task 31 Steps 1 and 3, commit.

---

### Task 33: Ship — PR, prod migration, merge

- [ ] **Step 1: Ask the owner before pushing** whether to genericise the owner's own test DRM-IDs (listed in the private rollout notes) named in the spec — the repo is public. Apply their answer to the spec and this plan in a `docs(spec)` commit.

- [ ] **Step 2: Push and open the PR.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/patient-delete
gh pr create --title "feat(patients): delete and restore patient records; deleted/merged records leave the directory, portal and messages (0167)" --body-file <(cat <<'MD'
PR 2 of the patient-delete rollout (spec: docs/superpowers/specs/2026-09-24-patient-delete-design.md).

- Admins can delete a patient record with a reason (red button, blocked while anything is open) and restore it from Admin Tools › Deleted Patients. Nothing is erased.
- Deleted AND merged records disappear from the patient list, pickers, booking/registration matching, DRM-ID recovery, the portal (incl. already-issued sessions, via RLS) and patient emails/SMS. History pages keep working with a banner.
- Writes on an inactive record are refused (edits, consent, PINs, new visits, check-ins, releases, payments, voids, result amendments, restores, HMO claim changes).
- Migration 0167 (must follow 0162): lifecycle columns, private writer role + guard trigger, blocker evaluator, delete/restore RPCs with in-transaction audit, active-only views + admin view, active-only current_patient_id() and resolve_patient_guarded. P0057–P0061.

Verification: npm test / typecheck / lint; 0167 smoke (s1–s8, each with a control) on a fresh local replay; browser smoke; code review + Codex review.

Not in this PR: shared lock protocol + child-table DB guards + transactional visit/merge RPCs (PR 3); Show-deleted toggle, duplicates-page Delete, Possible-duplicates panel (PR 4).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
MD
)
```
Mark it ready immediately if opened as draft (the ready-for-review cancel trap is eaglewatch-specific but costs nothing to avoid).

- [ ] **Step 3: Apply 0167 to prod right before the merge** (owner authorised Claude-run `db push` for DRMed, 2026-09-24). Preconditions, each checked by OBJECT, not by the CLI summary:
  - 0162 is on prod (`select 1 from pg_attribute where attrelid = 'public.v_patients_directory'::regclass and attname = 'consent_current'`); if not, stop — #215 must go first.
  - The worktree is rebased on the current `origin/main`, and `npm run -s claim -- list` still shows 0167 for this branch.

```bash
cd /Users/jamila/Claude/DRMed/.worktrees/patient-delete
/opt/homebrew/bin/supabase db push --dry-run 2>&1 | tail -8
```
Expected: exactly `0167_patient_soft_delete.sql` pending. 0171 is already on prod (2026-09-24), so the push needs `--include-all` (the documented out-of-order recipe) — check the dry-run lists nothing else. Then push for real, and verify read-only (MCP `execute_sql` SELECTs only):

```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='patients'
   and column_name in ('deleted_at','deleted_by','delete_reason','delete_note');              -- 4 rows
select rolname, rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname='patient_lifecycle_writer'; -- f/f/f
select u.rolname from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member
 where r.rolname='patient_lifecycle_writer';                                                   -- postgres only
select p.proname, r.rolname owner, p.prosecdef, p.proconfig from pg_proc p join pg_roles r on r.oid=p.proowner
 where p.proname in ('delete_patient','restore_patient','patient_delete_blockers','patient_kept_counts',
                     'enforce_patient_lifecycle','current_patient_id','resolve_patient_guarded');
select tgname, tgenabled from pg_trigger where tgname='trg_patients_lifecycle_guard';           -- O
select c.relname, c.reloptions, has_table_privilege('anon', c.oid, 'select') anon_sel
  from pg_class c where c.relname in ('v_patients_directory','v_patients_directory_admin',
                                      'v_patient_dedup_candidate_pairs','v_patients_without_consent');
select pg_get_viewdef('public.v_patients_directory'::regclass) like '%deleted_at IS NULL%';      -- true
select has_function_privilege('anon','public.delete_patient(uuid,text,text,uuid,jsonb)','execute'),
       has_function_privilege('authenticated','public.delete_patient(uuid,text,text,uuid,jsonb)','execute'); -- f,f
select version from supabase_migrations.schema_migrations where version = '0167';               -- 1 row
select count(*) from public.patients where deleted_at is not null;                               -- 0
```
If any check fails, stop and report — do not merge.

- [ ] **Step 4: Owner merges** (DRMed merges are the owner's). Then confirm `gh pr view --json state` = MERGED and the Vercel Production deployment for the merge commit is Ready — merge ≠ deploy.

- [ ] **Step 5: After deploy** — do NOT touch the owner's five test rows. Report that the next step is previewing their blockers on prod through the new dialog, deleting them only with the owner's go-ahead at that moment, then PR 3.

---

## Self-review notes (plan author)

- Spec coverage: columns/checks/FK/index (T2), private role + invoker guard + INSERT rule + no GUC (T1–T2), blocker rules incl. every HMO case (T4–T5), kept counts (T3), delete/restore + actor + metadata + context keys + in-transaction audit + P-codes in DETAIL (T6, T10), portal RLS via `current_patient_id()` (T7), views + admin inclusive source + ACLs + seed parity + hardened registry (T8), resolve active-only (T9), active rule on every listed read path + inventory (T11, T14–T17), portal session + PIN login (T18–T19), notification suppression incl. cron + walk-in rule (T20–T21), write-path refusal (T22–T23), confirm dialog + toast Undo (T24–T26), history banners + read-only record page + edit route refusal (T26–T28), Deleted Patients (T29), docs (T30), tests incl. mutation checks (T4–T6, T10, T31), prod verification by object (T33).
- Deliberately PR 3: lifecycle locks in every writer, child-table DB activity guards, transactional visit-creation and merge/undo RPCs under `patient_merge_writer`, two-connection race tests, resolve's post-lock re-read. `delete_patient` already takes the shared advisory lock, so PR 3's writers slot in without changing it.
- Deliberately PR 4: Show deleted toggle (the admin view it needs ships here), duplicates-page Delete (the dialog takes `initialReason` for it), Possible-duplicates panel and queue badge.

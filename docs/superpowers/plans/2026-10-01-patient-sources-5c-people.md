# Patient Sources 5c — `patient_sources_people` over the shared arrays — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use Sonnet for sub-agents.

**Goal:** Rebuild `public.patient_sources_people(p_from date, p_to date, p_mode text, p_channel text, p_limit int, p_offset int)` as a thin wrapper over a new closed helper `public._ps_sec_people(...)` that reads the shared arrays from 0206 (`_ps_identity_list()`, `_ps_encounter_list()`), exactly as 0206 rebuilt the other five report RPCs, with byte-identical behaviour (signature, return type, volatility, SECURITY DEFINER, `search_path`, admin-only gate, validation order, paging, ACL; `service_role` keeps EXECUTE).

**Architecture:** One new migration `0209_patient_sources_people.sql`: (1) `_ps_sec_people(p_ids _ps_identity[], p_enc _ps_encounter[], p_from, p_to, p_mode, p_channel, p_limit, p_offset)` holding the 0189 body verbatim except `unnest(p_ids)` / `unnest(p_enc)` replace the two core calls; (2) `create or replace` of the public wrapper (gate, mirror-mode assert, period check, mode check, then `return query select * from _ps_sec_people(...)`); (3) revoke on the helper; (4) a post-condition DO block. Proof = the existing `scripts/patient-sources-db-proof.ts` harness plus a frozen copy of the 0189 body under schema `ps_old` (fixture) compared row-for-row over a grid on the seeded world, with seven in-script mutant controls that must be caught.

**Tech Stack:** Postgres 17 / plpgsql, Supabase CLI (repo-pinned 2.118 via `npx supabase`) on an ISOLATED local stack (ports 563xx), `tsx` + `pg` proof script, vitest, Next.js 16 (no app code change).

**Spec:** `docs/superpowers/specs/2026-10-01-patient-sources-phase5-design.md` §0, §1, §5 (copied into this branch so the PR carries it).

**Placeholder rule:** `0209` is the ONLY placeholder. It is the migration number claimed in Task 0 Step 2 (four digits, e.g. `0209`). Every `0209` in this plan, in file names, SQL comments, TS code and commit messages, is replaced with that number as soon as it is claimed (`grep -rn "0209" docs/superpowers/plans/2026-10-01-patient-sources-5c-people.md` should be empty of live uses before commit of Task 1 — do the replacement in the plan copy you execute from, and in every file you create).

---

## Ground rules for every task

- Work ONLY in `/Users/jamila/Claude/DRMed/.worktrees/ps-people` (branch `feat/patient-sources-5c-people`). Never touch `~/Claude/DRMed` and never copy its `.env.local` (it points at PROD).
- Bash is zsh: never name a variable `path`; no `python3` heredocs (use `node -e` / `.mjs`); `curl` to localhost needs the sandbox disabled.
- Database work runs ONLY on the isolated stack from Task 0 (DB `127.0.0.1:56322`, API `56321`), never the shared 54322 stack, never prod, except the explicit read-only prod verification in Task 10.
  - `PSQL=/opt/homebrew/opt/libpq/bin/psql`
  - `DB=postgresql://postgres:postgres@127.0.0.1:56322/postgres`
  - Proofs run with `SUPABASE_DB_URL=$DB PS_STACK_IMAGE=17.6.1.167`.
  - `SP=/private/tmp/claude-501/-Users-jamila/3b674312-e5b3-4261-ba5b-259737df9a52/scratchpad/ps-people-stack`
- The denial probes in the proof (a refused call from anon / reception / service_role) segfault Postgres on image `17.6.1.106` and `.111` (prod is `.111`). They run ONLY on the isolated stack, whose image is `17.6.1.167`; the proof refuses to run its denial checks unless `PS_STACK_IMAGE` is set to a safe image.
- Capture long output to files in `$SP` and read only the relevant lines (`grep -E "^(PASS|FAIL|[0-9]+/)"`).
- Commit after each task. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. The post-commit hook may print `Killed: 9 python3 -c "import graphify"` — harmless.
- Never revoke EXECUTE from `service_role` on `patient_sources_people` (a refused call segfaults prod image .111). Never run the proof against a non-local URL (the script refuses).

## File map

| File | Change | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-10-01-patient-sources-phase5-design.md` | add (already copied) | approved spec, carried by the PR |
| `docs/superpowers/plans/2026-10-01-patient-sources-5c-people.md` | add | this plan |
| `supabase/migrations/0209_patient_sources_people.sql` | create | `_ps_sec_people` helper, wrapper, revoke, post-conditions |
| `scripts/fixtures/patient-sources-people-pre-0209.sql` | create | the 0189 `patient_sources_people` body frozen under schema `ps_old` + `ps_old.frozen_people_meta` (ACL, identity args, result type, volatility, config of the live function) |
| `scripts/patient-sources-db-proof.ts` | modify | people seed extras, non-vacuous category check, ordered equivalence grid (3 modes), invalid-input parity, gate parity, ACL/definition equality, closed helper, seven mutant controls, timing, image guard; header notes |
| `src/lib/sheet-sync/mirror-readers.test.ts` | modify | allowlist the new migration by name |
| `src/types/database.ts` | regenerate | gains ONE new entry, `_ps_sec_people` (see Task 7) |
| `CLAUDE.md` | modify | migration-ledger line (after the verified push) and guide version (at merge) |
| `.claude/skills/drmed-migrations/SKILL.md` | modify | one ledger line for `0209` |
| `docs/drmed-user-guide.html` | modify (version only) | version bump at merge time |

No app code changes: `loadPeoplePage` / `loadAllPeople` (`src/lib/marketing/patient-sources.server.ts`) call the same RPC name with the same arguments. `src/lib/marketing/patient-sources-surfaces.test.ts` already lists `patient_sources_people`; unchanged.

## Decisions and spec discrepancies found while planning (read before executing)

1. **`_ps_sec_people` is NOT `security definer`.** Spec §5 says "security definer"; 0206's `_ps_sec_*` helpers are SECURITY INVOKER and its proof asserts `!prosecdef`. The helper is only called from the SECURITY DEFINER wrapper, so it runs as the owner and needs no definer flag; making it a definer would add an attack surface for nothing. This plan follows 0206 (invoker, `set search_path = ''`, `revoke … from public, anon, authenticated, service_role`).
2. **Regenerated types are NOT a no-op.** The generated `src/types/database.ts` already carries every `_ps_sec_*` helper (`_ps_sec_summary` etc.), so `_ps_sec_people` will appear as one new `Functions` entry. The wrapper entry must be unchanged. Task 7 expects exactly that diff.
3. **"Null-name identity" is unreachable.** An identity only exists when a matching `sheet_encounter_lines` / `sheet_customer_rows` row exists with `patient_id is null` (name columns are NOT NULL), or when it is a confirmed patient (names concatenated, never NULL). The proof therefore seeds every REACHABLE name path (confirmed concat, earliest-line name, earliest-customer-row fallback) and compares `display_name` null-safely; it records the count of null `display_name` values in the grid (expected 0) instead of seeding an impossible state. The grid would still catch a NULL appearing on either side.
4. **Served mode needs encounters only; new/returning never read them.** The wrapper builds `_ps_encounter_list()` only when `p_mode = 'served'` (passing `'{}'` otherwise), mirroring 0206's `patient_sources_series`. Results are identical because the 0189 body reads encounters only inside the `p_mode = 'served'` branch; the grid proves it for all three modes.
5. **Performance risk.** Both helpers' arrays become `unnest()` row sources whose row estimate defaults to 100, which could steer the planner to a nested loop in the served join (`unnest(p_enc) e join ids i`). 0206 already does the same join in `_ps_sec_series` and was timed on prod, but the local seeded world is too small to show it, so Task 4 adds a 3,000-patient scale timing check and Task 10 times the helper on prod (rollback = forward migration restoring the fixture body).
6. **Server-key hazard unchanged.** `patient_sources_people` stays admin-only inside the body while `service_role` keeps EXECUTE; server code holding the service key must never call it. No code in this PR calls it with the service key.

---

### Task 0: Claim the number, dependencies, isolated stack, baseline

**Files:** none committed except the claim note (none).

- [ ] **Step 1: Sync with main and confirm the base**

Run: `cd /Users/jamila/Claude/DRMed/.worktrees/ps-people && git fetch origin && git status -sb | head -3 && git log --oneline -1 && git merge-base --is-ancestor 8b3e03c7 HEAD && echo base-ok`
Expected: branch `feat/patient-sources-5c-people`, `base-ok`. If `origin/main` has moved and the branch is clean apart from the untracked spec/plan, run `git rebase origin/main` (never rebase with uncommitted work; commit the plan first).

- [ ] **Step 2: Claim the migration number**

Run: `npm run claim -- migration --note "5c patient_sources_people over shared arrays"`
Expected: prints a claimed number such as `0209`. Write it down. From now on replace every `0209` (in this plan copy and in every file below) with that number. Also run `npm run claim -- list | tail -5` and confirm the claim is listed under this worktree.

- [ ] **Step 3: Install dependencies**

Run: `cd /Users/jamila/Claude/DRMed/.worktrees/ps-people && npm ci > /private/tmp/claude-501/-Users-jamila/3b674312-e5b3-4261-ba5b-259737df9a52/scratchpad/ps-people-npm-ci.log 2>&1; echo exit=$?`
Expected: `exit=0`.

- [ ] **Step 4: Start the isolated stack from a copy of `supabase/`**

```bash
SP=/private/tmp/claude-501/-Users-jamila/3b674312-e5b3-4261-ba5b-259737df9a52/scratchpad/ps-people-stack
lsof -i :56322 -i :56321 >/dev/null 2>&1 && echo "PORT IN USE - STOP and ask" || echo ports-free
rm -rf $SP && mkdir -p $SP && rsync -a --exclude .temp --exclude .branches supabase/ $SP/supabase/
mkdir -p $SP/supabase/.temp && echo 17.6.1.167 > $SP/supabase/.temp/postgres-version
node -e '
const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");
s=s.replace(/^project_id = ".*"$/m,"project_id = \"drmed-ps-people\"");
s=s.replace(/^(port|shadow_port) = 54(\d{3})$/gm,(m,k,n)=>`${k} = 56${n}`);
fs.writeFileSync(f,s);' $SP/supabase/config.toml
grep -n -E "^project_id|^(port|shadow_port) = " $SP/supabase/config.toml
npx supabase --version
npx supabase start --workdir $SP > $SP/start.log 2>&1; echo exit=$?
```
Expected: `ports-free`; every port line shows `563xx` (`56321`, `56322`, ...); version `2.118.x`; `exit=0`. The stack applies every migration on this branch's `supabase/migrations/` (head = whatever main has, WITHOUT the new migration).

- [ ] **Step 5: Confirm head and Postgres version**

```bash
PSQL=/opt/homebrew/opt/libpq/bin/psql; DB=postgresql://postgres:postgres@127.0.0.1:56322/postgres
$PSQL $DB -At -c "select max(version) from supabase_migrations.schema_migrations; select version();"
$PSQL $DB -At -c "select count(*) from pg_proc where proname in ('_ps_sec_people')"
```
Expected: a head below `0209`, `PostgreSQL 17.6`, and `0` (the helper does not exist yet).

- [ ] **Step 6: Baseline proof is green before any change**

Run: `SUPABASE_DB_URL=$DB npm run -s patient-sources:db-proof > $SP/proof-base.log 2>&1; grep -E "^(FAIL|[0-9]+/)" $SP/proof-base.log`
Expected: `N/N checks passed.` and no `FAIL` line. Record N (the number of checks before this PR).

---

### Task 1: Freeze the 0189 `patient_sources_people` body as a fixture

**Files:**
- Create: `scripts/fixtures/patient-sources-people-pre-0209.sql`

The fixture is generated from the stack at the pre-migration head, so it is exactly what is live on prod today (0189's body; no later migration redefines it — verified by `git grep -n "create or replace function public.patient_sources_people" supabase/migrations` returning only 0189).

- [ ] **Step 1: Verify nothing else redefines the function**

Run: `git grep -n "function public.patient_sources_people" -- supabase/migrations`
Expected: exactly one hit, `0189_patient_sources.sql`.

- [ ] **Step 2: Generate the fixture**

```bash
F=scripts/fixtures/patient-sources-people-pre-0209.sql
SIG="public.patient_sources_people(date,date,text,text,integer,integer)"
{
  echo "-- patient_sources_people exactly as it was on main before 0209 (0189's body, generated with"
  echo "-- pg_get_functiondef from a stack at the pre-0209 head), re-homed in schema ps_old, plus the"
  echo "-- live function's ACL / signature / volatility facts in ps_old.frozen_people_meta."
  echo "-- scripts/patient-sources-db-proof.ts loads this INSIDE its rolled-back transaction and proves"
  echo "-- the 0209 wrapper returns identical rows. Never applied anywhere. It is also the ROLLBACK body:"
  echo "-- a forward migration that restores this function (ACL unchanged) undoes 0209."
  echo "create schema if not exists ps_old;"
  echo "grant usage on schema ps_old to anon, authenticated, service_role;"
  $PSQL $DB -At -c "select replace(pg_get_functiondef(p.oid), 'FUNCTION public.patient_sources_people(', 'FUNCTION ps_old.patient_sources_people(') || ';' from pg_proc p where p.oid = '$SIG'::regprocedure"
  echo "revoke all on function ps_old.patient_sources_people(date, date, text, text, integer, integer) from public, anon, authenticated, service_role;"
  echo "grant execute on function ps_old.patient_sources_people(date, date, text, text, integer, integer) to authenticated, service_role;"
  $PSQL $DB -At -c "select format('create table ps_old.frozen_people_meta as select %L::text as owner, %L::text as proacl, %L::text as identity_args, %L::text as result, %L::text as secdef, %L::text as volatility, %L::text as config, %L::text as lang, %L::text as parallel, %L::text as cost, %L::text as prorows;',
      pg_get_userbyid(p.proowner), coalesce(p.proacl::text, ''), pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
      p.prosecdef::text, p.provolatile::text, coalesce(p.proconfig::text, ''), l.lanname, p.proparallel::text, p.procost::text, p.prorows::text)
    from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = '$SIG'::regprocedure"
} > $F
grep -c "CREATE OR REPLACE FUNCTION ps_old\." $F
grep -c "FUNCTION public\.patient_sources_people" $F
grep -c "frozen_people_meta" $F
grep -c "_patient_sources_identities()" $F
```
Expected: `1`, `0`, `1`, and at least `1` (the frozen body still calls the live core by its qualified name — that is intended: both sides read the same snapshot).

- [ ] **Step 3: Prove the fixture loads and rolls back cleanly, and record the frozen ACL**

Run:
```bash
$PSQL $DB -v ON_ERROR_STOP=1 -c "begin;" -f $F -c "select proacl, identity_args, result, secdef, volatility, config from ps_old.frozen_people_meta; select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ps_old'; rollback;"
```
Expected: one metadata row (ACL like `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`, `secdef` = `true`, `volatility` = `s`, `config` = `{search_path=""}`), count `1`, no error. Note the ACL: it must contain `service_role=X/…` and no `anon`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-patient-sources-phase5-design.md docs/superpowers/plans/2026-10-01-patient-sources-5c-people.md scripts/fixtures/patient-sources-people-pre-0209.sql
git commit -m "test(patient-sources): freeze the pre-0209 patient_sources_people body for the 5c equivalence proof

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The migration `0209_patient_sources_people.sql`

**Files:**
- Create: `supabase/migrations/0209_patient_sources_people.sql`

The helper's body is the 0189 body (`supabase/migrations/0189_patient_sources.sql`, lines ~656–696) moved verbatim, with exactly two substitutions: `public._patient_sources_identities()` becomes `unnest(p_ids)` and `public._patient_sources_encounters() e` becomes `unnest(p_enc) e`. Do not reformat, re-alias or reorder anything else (the proof's mutants string-match these exact lines).

- [ ] **Step 1: Write the migration**

```sql
-- 0209_patient_sources_people.sql
--
-- Patient Sources Phase 5c: patient_sources_people (0189) rebuilt on the shared
-- arrays 0206 introduced. The people list used to build the identity core
-- itself (_patient_sources_identities(), + _patient_sources_encounters() for
-- "served"); it now takes the arrays from the same list builders the other
-- report RPCs use, so every list on the page has one definition of "who is who".
--   * adds the closed helper _ps_sec_people(ids, encounters, from, to, mode,
--     channel, limit, offset) holding 0189's rules VERBATIM (only the two core
--     calls became unnest(p_ids) / unnest(p_enc));
--   * re-creates patient_sources_people as a wrapper: same signature, return
--     type, STABLE, SECURITY DEFINER, search_path, admin-only gate (NO
--     service_role: a refused call segfaults prod image .111, so server code
--     never calls this function), validation order, paging and ACL.
-- Additive create-or-replace with an identical signature: the live app keeps
-- working whether this lands before or after the deploy. ACLs on the wrapper are
-- deliberately NOT restated (create or replace keeps them; the proof asserts the
-- proacl is byte-equal to the pre-0209 value). service_role keeps EXECUTE.
-- Rollback: a forward migration restoring scripts/fixtures/patient-sources-people-pre-0209.sql
-- (ps_old -> public), ACLs unchanged.

-- 1. The section helper (no gate: the wrapper gates and validates).
create or replace function public._ps_sec_people(
  p_ids public._ps_identity[], p_enc public._ps_encounter[], p_from date, p_to date,
  p_mode text, p_channel text, p_limit int, p_offset int)
returns table (
  identity_kind text,
  identity      text,
  patient_id    uuid,
  drm_id        text,
  display_name  text,
  first_date    date,
  total_count   bigint
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with ids as (
    select * from unnest(p_ids)
  ),
  picked as (
    select i.identity, i.confirmed, i.survivor_id, i.loose_key, i.first_date as d
    from ids i
    where p_mode in ('new', 'returning')
      and i.basis in ('encounter', 'registration')
      and i.first_date between p_from and p_to
      and i.is_returning = (p_mode = 'returning')
      and (p_channel is null or i.channel = p_channel)
    union all
    select i.identity, i.confirmed, i.survivor_id, i.loose_key, min(e.service_date)
    from unnest(p_enc) e
    join ids i on i.identity = e.identity
    where p_mode = 'served'
      and e.service_date between p_from and p_to
      and (p_channel is null or i.channel = p_channel)
    group by i.identity, i.confirmed, i.survivor_id, i.loose_key
  )
  select case when k.confirmed then 'confirmed' else 'unconfirmed' end,
         k.identity,
         k.survivor_id,
         p.drm_id,
         case when k.confirmed
              then concat_ws(', ', p.last_name, concat_ws(' ', p.first_name, p.middle_name))
              else coalesce(
                (select l.name_raw from public.sheet_encounter_lines l
                  where l.patient_id is null and l.loose_key = k.loose_key
                  order by l.service_date, l.id limit 1),
                (select c.full_name_raw from public.sheet_customer_rows c
                  where c.patient_id is null and c.loose_key = k.loose_key
                  order by c.sheet_row limit 1))
         end,
         k.d,
         count(*) over ()
  from picked k
  left join public.patients p on p.id = k.survivor_id
  order by k.d, k.identity
  limit greatest(1, least(coalesce(p_limit, 50), 1000))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

-- 2. The public RPC as a wrapper (signature, gate, validation order, paging unchanged).
create or replace function public.patient_sources_people(
  p_from date, p_to date, p_mode text, p_channel text, p_limit int, p_offset int)
returns table (
  identity_kind text,
  identity      text,
  patient_id    uuid,
  drm_id        text,
  display_name  text,
  first_date    date,
  total_count   bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  if p_mode is null or p_mode not in ('new', 'returning', 'served') then
    raise exception 'Unknown list %', coalesce(p_mode, '(none)') using errcode = '22023';
  end if;

  return query
  select * from public._ps_sec_people(
    public._ps_identity_list(),
    -- 'new' / 'returning' never read encounters: skip building them.
    case when p_mode = 'served' then public._ps_encounter_list() else '{}'::public._ps_encounter[] end,
    p_from, p_to, p_mode, p_channel, p_limit, p_offset);
end;
$$;

-- 3. ACLs. The helper is closed to every runtime role. The wrapper's ACL is
-- untouched (admin-only inside the body; authenticated and service_role keep
-- EXECUTE exactly as 0189 left them: NEVER revoke service_role — see header).
revoke all on function public._ps_sec_people(public._ps_identity[], public._ps_encounter[], date, date, text, text, int, int) from public, anon, authenticated, service_role;

-- 4. Post-conditions: abort the deploy if anything is not what this file says.
do $$
declare
  f constant text := 'public._ps_sec_people(public._ps_identity[],public._ps_encounter[],date,date,text,text,integer,integer)';
  w constant text := 'public.patient_sources_people(date,date,text,text,integer,integer)';
  v_def text;
  v_wrapper record;
begin
  -- Helper: closed, invoker, no service_role literal, reads the arrays.
  if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
     or has_function_privilege('service_role', f, 'execute') then
    raise exception '0209: internal % is executable by a runtime role', f;
  end if;
  if (select p.prosecdef from pg_proc p where p.oid = f::regprocedure) then
    raise exception '0209: % must not be SECURITY DEFINER', f;
  end if;
  v_def := pg_get_functiondef(f::regprocedure);
  if v_def like '%service_role%' then
    raise exception '0209: % must not mention service_role', f;
  end if;
  if v_def not like '%unnest(p_ids)%' or v_def not like '%unnest(p_enc) e%' then
    raise exception '0209: % does not read the shared arrays', f;
  end if;
  if v_def like '%_patient_sources_identities%' or v_def like '%_patient_sources_encounters%' then
    raise exception '0209: % still calls the identity core directly', f;
  end if;

  -- Wrapper: same shape as before, ACL unchanged, still admin-only.
  select p.prosecdef, p.provolatile, p.proconfig, p.proretset,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_function_result(p.oid) as result
    into v_wrapper
    from pg_proc p where p.oid = w::regprocedure;
  if not v_wrapper.prosecdef then
    raise exception '0209: % lost SECURITY DEFINER', w;
  end if;
  if v_wrapper.provolatile <> 's' then
    raise exception '0209: % is no longer STABLE', w;
  end if;
  if v_wrapper.proconfig is distinct from array['search_path=""'] then
    raise exception '0209: % lost its empty search_path', w;
  end if;
  if not v_wrapper.proretset then
    raise exception '0209: % no longer returns a set', w;
  end if;
  if v_wrapper.args <> 'p_from date, p_to date, p_mode text, p_channel text, p_limit integer, p_offset integer' then
    raise exception '0209: % identity arguments changed: %', w, v_wrapper.args;
  end if;
  if v_wrapper.result <> 'TABLE(identity_kind text, identity text, patient_id uuid, drm_id text, display_name text, first_date date, total_count bigint)' then
    raise exception '0209: % result type changed: %', w, v_wrapper.result;
  end if;
  if has_function_privilege('anon', w, 'execute') then
    raise exception '0209: % is executable by anon', w;
  end if;
  if not has_function_privilege('authenticated', w, 'execute') then
    raise exception '0209: % is not executable by authenticated', w;
  end if;
  -- service_role EXECUTE is deliberate (see header); the BODY stays admin-only.
  if not has_function_privilege('service_role', w, 'execute') then
    raise exception '0209: % lost service_role EXECUTE (a refused call segfaults prod image .111)', w;
  end if;
  v_def := pg_get_functiondef(w::regprocedure);
  if v_def like '%service_role%' then
    raise exception '0209: % must stay admin-only', w;
  end if;
  if v_def not like '%_ps_sec_people%' or v_def not like '%_ps_identity_list()%' then
    raise exception '0209: % does not call the shared-array helper', w;
  end if;
end;
$$;
```

- [ ] **Step 2: Diff the helper against 0189 to prove it is verbatim**

```bash
node -e '
const fs=require("fs");
const grab=(f,startRe)=>{const s=fs.readFileSync(f,"utf8");const i=s.search(startRe);const j=s.indexOf("  limit greatest(1, least(coalesce(p_limit, 50), 1000))",i);return s.slice(s.indexOf("select case when k.confirmed",i),j+120);};
const a=grab("supabase/migrations/0189_patient_sources.sql",/create or replace function public\.patient_sources_people/);
const b=grab("supabase/migrations/0209_patient_sources_people.sql",/create or replace function public\._ps_sec_people/);
console.log(a===b?"final select identical":"FINAL SELECT DIFFERS");'
diff <(sed -n '/^  picked as (/,/^  )$/p' supabase/migrations/0189_patient_sources.sql | sed -n '1,22p') <(sed -n '/^  picked as (/,/^  )$/p' supabase/migrations/0209_patient_sources_people.sql | sed -n '1,22p')
```
Expected: `final select identical`; the diff shows ONLY the line `from public._patient_sources_encounters() e` → `from unnest(p_enc) e` (and nothing else inside `picked`). Anything else differing means the helper was edited beyond the two allowed substitutions: fix it.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0209_patient_sources_people.sql
git commit -m "feat(patient-sources): patient_sources_people over the shared arrays (0209)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Apply on the isolated stack and replay from empty

**Files:** none.

- [ ] **Step 1: Apply to the running isolated stack**

Run: `$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0209_patient_sources_people.sql > $SP/apply.log 2>&1; echo exit=$?; tail -3 $SP/apply.log`
Expected: `exit=0`; output ends with `DO` (the post-conditions passed). Re-run once more: expected `exit=0` again (create-or-replace is idempotent; the DO block re-verifies).

- [ ] **Step 2: Prove the post-conditions can abort (quick negative)**

```bash
$PSQL $DB -v ON_ERROR_STOP=1 -c "begin; revoke execute on function public.patient_sources_people(date,date,text,text,int,int) from service_role;" -f supabase/migrations/0209_patient_sources_people.sql -c "rollback;" 2>&1 | grep -E "ERROR|lost service_role" | head -2
```
Expected: an `ERROR:  0209: public.patient_sources_people(...) lost service_role EXECUTE ...` line (the migration refuses to finish when service_role EXECUTE is missing). The transaction is rolled back; nothing persists. (Note: this probe revokes then calls nothing, so it cannot trigger the refused-call crash.)

- [ ] **Step 3: Fresh replay on an empty database**

Bring the stack down and up with the full history (this branch's migrations including `0209`):
```bash
npx supabase db reset --workdir $SP > $SP/reset.log 2>&1; echo exit=$?; tail -3 $SP/reset.log
$PSQL $DB -At -c "select max(version) from supabase_migrations.schema_migrations; select pg_get_functiondef('public._ps_sec_people(public._ps_identity[],public._ps_encounter[],date,date,text,text,integer,integer)'::regprocedure) like '%unnest(p_ids)%'"
```
Expected: `exit=0`; head = `0209`; `t`. (`db reset` here targets ONLY the isolated stack via `--workdir $SP`; never run it without that flag.)

- [ ] **Step 4: Confirm the wrapper ACL is unchanged against the frozen value**

```bash
$PSQL $DB -At -c "select coalesce(proacl::text,'') from pg_proc where oid='public.patient_sources_people(date,date,text,text,integer,integer)'::regprocedure"
grep -c "" /dev/null; $PSQL $DB -v ON_ERROR_STOP=1 -At -c "begin;" -f scripts/fixtures/patient-sources-people-pre-0209.sql -c "select proacl from ps_old.frozen_people_meta; rollback;" | tail -2
```
Expected: the two ACL strings are byte-identical. (Task 4's proof asserts the same programmatically.)

---

### Task 4: Proof — seeded world extras, grid, parity, controls, timing

**Files:**
- Modify: `scripts/patient-sources-db-proof.ts`

All new code goes (a) next to `gridCalls(...)` just before the line `await q("begin");` (helpers and constants — `fx`, `q`, `asAdmin`, `setRole`, `seedWorld`, `P_JUNE`, `P_LONG`, `P_EARLY`, `loose`, `sheetLine`, `customerRow`, `patient`, `visit`, `assert`, `expectOk` are already in scope there), and (b) after the last 0206 check (`"0206: helpers and list builders are closed; row types match their producers"`) and before `} finally {` (the checks). Use the exact code below.

- [ ] **Step 1: Add constants and helpers (before `await q("begin");`)**

```ts
  // ---- 5c: patient_sources_people over the shared arrays (0209) ---------
  const PEOPLE_SIG = "public.patient_sources_people(date,date,text,text,integer,integer)";
  const PEOPLE_HELPER = "public._ps_sec_people(public._ps_identity[],public._ps_encounter[],date,date,text,text,integer,integer)";
  const P_MIN = { from: "2023-12-01", to: "2023-12-05" }; // starts on PATIENT_SOURCES_MIN_DATE
  const P_ONE = { from: "2026-06-03", to: "2026-06-03" }; // a single day with seeded activity
  const P_NONE = { from: "2024-03-01", to: "2024-03-05" }; // nothing seeded
  const PEOPLE_PERIODS = [P_ONE, P_MIN, P_NONE, P_EARLY, P_JUNE, P_LONG];
  const PEOPLE_MODES = ["new", "returning", "served"] as const;
  const PEOPLE_CHANNELS: (string | null)[] = [null, "walk_in", "online_facebook", "online_google", "not_recorded", "no_such_channel"];
  type PeopleArgs = [string | null, string | null, string | null, string | null, number | null, number | null];
  const PAGING: [number | null, number | null][] = [[50, 0], [3, 0], [3, 3], [3, 1000000], [1, 0], [1, 1], [null, null], [0, 0], [-5, -5], [100000, 0], [null, 2]];

  /** The seeded world plus every people-specific path: earliest-LINE name, earliest-CUSTOMER-ROW fallback, descending-insert multi-date served patient. */
  async function seedPeopleExtras() {
    const lia = loose("PeopleLine", "Lia");
    await sheetLine("2026-06-24", lia, null, 50);
    await sheetLine("2026-06-13", lia, null, 50);
    await q(`update public.sheet_encounter_lines set name_raw = 'Lia Peopleline (later line)' where loose_key = $1 and service_date = '2026-06-24'`, [lia]);
    await q(`update public.sheet_encounter_lines set name_raw = 'Lia Peopleline (earliest line)' where loose_key = $1 and service_date = '2026-06-13'`, [lia]);
    const cora = loose("PeopleCust", "Cora");
    await customerRow(cora, { registeredOn: "2026-06-12", source: "walk_in", sheetRow: 1 });
    await customerRow(cora, { registeredOn: "2026-06-14", sheetRow: 2 });
    await q(`update public.sheet_customer_rows set full_name_raw = 'Cora Peoplecust (row 1)' where loose_key = $1 and sheet_row = 1`, [cora]);
    await q(`update public.sheet_customer_rows set full_name_raw = 'Cora Peoplecust (row 2)' where loose_key = $1 and sheet_row = 2`, [cora]);
    // Visits inserted in DESCENDING date order: "first row" != min(service_date).
    const desc = await patient("PeopleDesc", "Dan", { source: "online_google", createdAt: "2026-06-01T09:00:00+08:00" });
    await visit(desc, "2026-06-25", 120);
    await visit(desc, "2026-06-05", 130);
    return { lia, cora, desc };
  }

  function peopleCases(): { tag: string; args: PeopleArgs }[] {
    const out: { tag: string; args: PeopleArgs }[] = [];
    for (const p of PEOPLE_PERIODS) for (const m of PEOPLE_MODES) for (const c of PEOPLE_CHANNELS) {
      out.push({ tag: `${m} ${p.from}..${p.to} channel=${c} 50/0`, args: [p.from, p.to, m, c, 50, 0] });
    }
    for (const p of [P_JUNE, P_LONG]) for (const m of PEOPLE_MODES) for (const [l, o] of PAGING) {
      out.push({ tag: `${m} ${p.from}..${p.to} page limit=${l} offset=${o}`, args: [p.from, p.to, m, null, l, o] });
    }
    return out;
  }
  /** Cases the seeded world guarantees non-empty (so equality there is never vacuous). */
  const peopleMustBeNonEmpty = (a: PeopleArgs) => {
    const [from, , mode, channel, , offset] = a;
    if (!(from === P_JUNE.from || from === P_LONG.from) || (offset ?? 0) !== 0) return false;
    if (mode === "returning") return channel === null || channel === "online_google";
    return channel !== "no_such_channel";
  };
  const PEOPLE_Q = (fn: string) =>
    `select to_jsonb(t) as j from (select * from ${fn}($1::date,$2::date,$3::text,$4::text,$5::int,$6::int)) t`;
  /** Rows IN THE ORDER RETURNED (order and total_count are part of the contract). */
  async function peopleJson(fn: string, args: PeopleArgs): Promise<string[]> {
    return (await q<{ j: unknown }>(PEOPLE_Q(fn), args)).rows.map((x) => JSON.stringify(x.j));
  }
  async function peopleOld(): Promise<Map<string, string[]>> {
    await q(fs.readFileSync(path.join(__dirname, "fixtures/patient-sources-people-pre-0209.sql"), "utf8"));
    await asAdmin();
    const m = new Map<string, string[]>();
    for (const c of peopleCases()) {
      const rows = await peopleJson("ps_old.patient_sources_people", c.args);
      if (peopleMustBeNonEmpty(c.args)) assert(rows.length > 0, `${c.tag}: empty on the OLD side — equality would be vacuous`);
      m.set(c.tag, rows);
    }
    await setRole("postgres", null);
    return m;
  }
  async function peopleDiffs(newFn: string, role: "admin" | "postgres", old: Map<string, string[]>) {
    const diffs: string[] = [];
    let nonEmpty = 0;
    let nullNames = 0;
    if (role === "admin") await asAdmin(); else await setRole("postgres", null);
    for (const c of peopleCases()) {
      const a = await peopleJson(newFn, c.args);
      const b = old.get(c.tag)!;
      if (a.length) nonEmpty += 1;
      nullNames += b.filter((r) => JSON.parse(r).display_name === null).length;
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${c.tag}: new=${JSON.stringify(a).slice(0, 240)} old=${JSON.stringify(b).slice(0, 240)}`);
    }
    await setRole("postgres", null);
    return { diffs, nonEmpty, nullNames };
  }
  async function peopleErr(fn: string, args: PeopleArgs): Promise<{ code: string; message: string } | null> {
    await q("savepoint sp_people_err");
    let out: { code: string; message: string } | null = null;
    try {
      await q(`select * from ${fn}($1::date,$2::date,$3::text,$4::text,$5::int,$6::int)`, args);
    } catch (e) {
      const x = e as Error & { code?: string };
      out = { code: x.code ?? "?", message: x.message };
    }
    await q("rollback to savepoint sp_people_err");
    return out;
  }
  /** Copy the live helper into ps_ctl with string edits (throws if an edit's text is missing) + a gate-free shim with the public signature. */
  async function peopleMutant(label: string, edits: [string, string][]) {
    const def = (await q<{ d: string }>(`select pg_get_functiondef('${PEOPLE_HELPER}'::regprocedure) as d`)).rows[0].d;
    let body = def.replace("FUNCTION public._ps_sec_people(", "FUNCTION ps_ctl._ps_sec_people(");
    for (const [from, to] of edits) {
      if (!body.includes(from)) throw new Error(`control ${label}: text not found in the live helper: ${from}`);
      body = body.split(from).join(to);
    }
    await q(`create schema if not exists ps_ctl`);
    await q(body);
    await q(`create or replace function ps_ctl.people(p_from date, p_to date, p_mode text, p_channel text, p_limit int, p_offset int)
             returns table (identity_kind text, identity text, patient_id uuid, drm_id text, display_name text, first_date date, total_count bigint)
             language sql stable as $$
               select * from ps_ctl._ps_sec_people(public._ps_identity_list(), public._ps_encounter_list(), p_from, p_to, p_mode, p_channel, p_limit, p_offset)
             $$`);
  }
```

- [ ] **Step 2: Add the checks (after the last 0206 check, before `} finally {`)**

```ts
    // ---- 5c: patient_sources_people over the shared arrays (0209) --------
    await check("5c: denial probes run on a stack whose image survives refused calls", async () => {
      const img = process.env.PS_STACK_IMAGE ?? "";
      assert(/^\d+\.\d+\.\d+\.\d+$/.test(img), `PS_STACK_IMAGE must be set to the stack's Postgres image tag (e.g. 17.6.1.167), got "${img}"`);
      assert(!/\.(106|111)$/.test(img), `image ${img} segfaults on a refused function call; run the proof on a newer image`);
      const v = (await q<{ v: string }>(`show server_version`)).rows[0].v;
      console.log(`   5c image=${img} server_version=${v}`);
    });

    await check("5c: the seeded world reaches every people path (non-vacuous)", () => scoped(async () => {
      const w = await seedWorld();
      const x = await seedPeopleExtras();
      await asAdmin();
      const news = await peopleRows(P_JUNE.from, P_JUNE.to, "new", null, 1000, 0);
      const byIdentity = (rows: typeof news, id: string) => rows.find((r) => r.identity === id);
      assert(news.some((r) => r.identity_kind === "confirmed"), "no confirmed row in June/new");
      assert(news.some((r) => r.identity_kind === "unconfirmed"), "no unconfirmed row in June/new");
      assert(news.length >= 8, `June/new needs >= 8 rows for a middle page, got ${news.length}`);
      const lia = byIdentity(news, `name:${x.lia}`);
      assert(lia?.display_name === "Lia Peopleline (earliest line)", `earliest sheet LINE name wins: ${JSON.stringify(lia)}`);
      const cora = byIdentity(news, `name:${x.cora}`);
      assert(cora?.display_name === "Cora Peoplecust (row 1)", `customer-ROWS fallback (lowest sheet_row) name: ${JSON.stringify(cora)}`);
      assert(cora?.drm_id === null && cora?.patient_id === null, `unconfirmed rows carry no patient: ${JSON.stringify(cora)}`);
      const una = news.find((r) => r.identity_kind === "unconfirmed" && r.display_name === loose("WorldSheet", "Una"));
      assert(una, "an unconfirmed identity with BOTH a line and a customer row resolves via the line");
      const merged = news.find((r) => r.patient_id === w.surv);
      assert(merged && merged.drm_id && /WorldMerge/.test(merged.display_name ?? ""), `survivor join (drm_id + concatenated name): ${JSON.stringify(merged)}`);
      const ret = await peopleRows(P_JUNE.from, P_JUNE.to, "returning", null, 1000, 0);
      assert(ret.some((r) => r.patient_id === w.imp), `returning list must hold the imported repeat patient: ${JSON.stringify(ret)}`);
      const served = await peopleRows(P_JUNE.from, P_JUNE.to, "served", null, 1000, 0);
      const survServed = served.find((r) => r.patient_id === w.surv);
      assert(survServed?.first_date === "2026-06-06", `the duplicate's visit serves the survivor on 2026-06-06: ${JSON.stringify(survServed)}`);
      assert(!served.some((r) => r.patient_id === w.dup), "the merged duplicate is never listed");
      const desc = served.find((r) => r.patient_id === x.desc);
      assert(desc?.first_date === "2026-06-05", `served first_date is min(service_date), not the first row: ${JSON.stringify(desc)}`);
      await setRole("postgres", null);
      const multi = Number((await q<{ n: string }>(
        `select count(*)::text as n from (select identity from public._patient_sources_encounters()
           where service_date between '2026-06-01' and '2026-06-30' group by identity having count(distinct service_date) > 1) t`)).rows[0].n);
      assert(multi > 0, "served needs identities with several dates in the period");
      const chans = (await q<{ channel: string }>(`select distinct channel from public._patient_sources_identities() where basis in ('encounter','registration')`)).rows.map((r) => r.channel);
      for (const c of ["walk_in", "online_facebook", "online_google", "not_recorded"]) assert(chans.includes(c), `channel ${c} not seeded: ${chans.join(",")}`);
      await asAdmin();
      for (const [mode, ch] of [["new", "not_recorded"], ["served", "not_recorded"], ["new", "walk_in"], ["served", "online_facebook"]] as const) {
        const r = await peopleRows(P_JUNE.from, P_JUNE.to, mode, ch, 1000, 0);
        assert(r.length > 0, `${mode}/${ch} must be non-empty`);
      }
      assert((await peopleRows(P_JUNE.from, P_JUNE.to, "new", null, 3, 3)).length === 3, "a middle page of 3 must exist");
      assert((await peopleRows(P_JUNE.from, P_JUNE.to, "new", null, 3, 1000000)).length === 0, "past the end is empty");
    }));

    await check("5c: patient_sources_people returns exactly the pre-0209 rows, in order, with the same total_count", () => scoped(async () => {
      await seedWorld();
      await seedPeopleExtras();
      const old = await peopleOld();
      const { diffs, nonEmpty, nullNames } = await peopleDiffs("public.patient_sources_people", "admin", old);
      assert(diffs.length === 0, `people differ from the pre-0209 body (${diffs.length} of ${old.size} cases):\n${diffs.slice(0, 8).join("\n")}`);
      assert(nonEmpty >= 60, `only ${nonEmpty} non-empty comparisons — the grid is too thin`);
      assert(nullNames === 0, `unexpected NULL display_name rows: ${nullNames} (unreachable by construction; see plan decision 3)`);
      console.log(`   5c grid: ${old.size} cases, ${nonEmpty} non-empty, all identical`);
    }));

    await check("5c: invalid inputs fail with the same SQLSTATE and message as before, in the same order", () => scoped(async () => {
      await peopleOld();
      await asAdmin();
      const BAD: [string, PeopleArgs][] = [
        ["bad mode", [P_JUNE.from, P_JUNE.to, "everyone", null, 50, 0]],
        ["null mode", [P_JUNE.from, P_JUNE.to, null, null, 50, 0]],
        ["empty mode", [P_JUNE.from, P_JUNE.to, "", null, 50, 0]],
        ["reversed period", ["2026-06-30", "2026-06-01", "new", null, 50, 0]],
        ["before the minimum date", ["2023-11-30", "2023-12-31", "new", null, 50, 0]],
        ["over 400 days", ["2025-01-01", "2026-06-30", "new", null, 50, 0]],
        ["null from", [null, P_JUNE.to, "new", null, 50, 0]],
        ["null to", [P_JUNE.from, null, "new", null, 50, 0]],
        ["bad mode AND bad period: the period error comes first", ["2026-06-30", "2026-06-01", "everyone", null, 50, 0]],
      ];
      for (const [label, args] of BAD) {
        const a = await peopleErr("public.patient_sources_people", args);
        const b = await peopleErr("ps_old.patient_sources_people", args);
        assert(a && b, `${label}: expected an error on both sides, got new=${JSON.stringify(a)} old=${JSON.stringify(b)}`);
        assert(a.code === b.code && a.message === b.message, `${label}: new=${JSON.stringify(a)} old=${JSON.stringify(b)}`);
      }
      const unknown = await peopleErr("public.patient_sources_people", [P_JUNE.from, P_JUNE.to, "everyone", null, 50, 0]);
      assert(unknown?.code === "22023" && unknown.message === "Unknown list everyone", `message text: ${JSON.stringify(unknown)}`);
    }));

    await check("5c: gate parity — every non-admin principal is refused exactly as before; View-as unchanged", () => scoped(async () => {
      await peopleOld();
      const args: PeopleArgs = [P_JUNE.from, P_JUNE.to, "new", null, 50, 0];
      const principals: [string, () => Promise<void>][] = [
        ["anon", () => setRole("anon", null)],
        ["portal patient", () => setRole("anon", { role: "anon", patient_id: fx.patientPId })],
        ["reception", () => setRole("authenticated", { sub: fx.receptionId, role: "authenticated" })],
        ["inactive admin", () => setRole("authenticated", { sub: fx.inactiveAdminId, role: "authenticated" })],
        ["no JWT claims at all", () => setRole("authenticated", null)],
        ["authenticated with a service_role app_metadata", () => setRole("authenticated", { sub: fx.receptionId, role: "authenticated", app_metadata: { role: "service_role" } })],
        ["service_role (EXECUTE kept, body refuses)", () => setRole("service_role", { role: "service_role" })],
      ];
      for (const [label, set] of principals) {
        await set();
        const a = await peopleErr("public.patient_sources_people", args);
        const b = await peopleErr("ps_old.patient_sources_people", args);
        assert(a && b && a.code === "42501", `${label}: expected 42501 on both, got new=${JSON.stringify(a)} old=${JSON.stringify(b)}`);
        assert(a.code === b.code && a.message === b.message, `${label}: new=${JSON.stringify(a)} old=${JSON.stringify(b)}`);
      }
      await setRole("postgres", null);
      await q(`update public.staff_profiles set view_as_role = 'reception', view_as_until = now() + interval '1 hour' where id = $1`, [fx.adminId]);
      try {
        await asAdmin();
        const a = await peopleErr("public.patient_sources_people", args);
        const b = await peopleErr("ps_old.patient_sources_people", args);
        assert(a && b && a.code === "42501" && a.message === b.message, `admin viewing as reception: new=${JSON.stringify(a)} old=${JSON.stringify(b)}`);
      } finally {
        await setRole("postgres", null);
        await q(`update public.staff_profiles set view_as_role = null, view_as_until = null where id = $1`, [fx.adminId]);
      }
      await asAdmin();
      await expectOk("admin", () => q(`select * from public.patient_sources_people($1::date,$2::date,'new',null,50,0)`, [P_JUNE.from, P_JUNE.to]));
    }));

    await check("5c: ACL, signature, result type and settings are byte-equal to the frozen function; the helper is closed", () => scoped(async () => {
      await peopleOld();
      const live = (await q<Record<string, string>>(
        `select pg_get_userbyid(p.proowner) as owner, coalesce(p.proacl::text, '') as proacl,
                pg_get_function_identity_arguments(p.oid) as identity_args, pg_get_function_result(p.oid) as result,
                p.prosecdef::text as secdef, p.provolatile::text as volatility, coalesce(p.proconfig::text, '') as config,
                l.lanname as lang, p.proparallel::text as parallel, p.procost::text as cost, p.prorows::text as prorows
           from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [PEOPLE_SIG])).rows[0];
      const frozen = (await q<Record<string, string>>(`select * from ps_old.frozen_people_meta`)).rows[0];
      for (const k of Object.keys(frozen)) assert(live[k] === frozen[k], `patient_sources_people ${k} changed: now=${JSON.stringify(live[k])} was=${JSON.stringify(frozen[k])}`);
      assert(live.proacl.includes("service_role=X/") && live.proacl.includes("authenticated=X/") && !live.proacl.includes("anon="), `ACL shape: ${live.proacl}`);
      const wrapper = (await q<{ d: string }>(`select pg_get_functiondef($1::regprocedure) as d`, [PEOPLE_SIG])).rows[0].d;
      assert(wrapper.includes("_ps_sec_people") && wrapper.includes("_ps_identity_list()"), "wrapper must call the shared-array helper");
      assert(!wrapper.includes("service_role"), "wrapper must stay admin-only inside the body (no service_role literal)");
      const h = (await q<{ a: boolean; u: boolean; s: boolean; sd: boolean; d: string }>(
        `select has_function_privilege('anon', $1, 'execute') as a, has_function_privilege('authenticated', $1, 'execute') as u,
                has_function_privilege('service_role', $1, 'execute') as s, (select p.prosecdef from pg_proc p where p.oid = $1::regprocedure) as sd,
                pg_get_functiondef($1::regprocedure) as d`, [PEOPLE_HELPER])).rows[0];
      assert(!h.a && !h.u && !h.s, `_ps_sec_people must be closed to anon/authenticated/service_role: ${JSON.stringify({ a: h.a, u: h.u, s: h.s })}`);
      assert(!h.sd, "_ps_sec_people must not be SECURITY DEFINER (0206 pattern)");
      assert(!h.d.includes("service_role"), "_ps_sec_people must not contain a service_role literal");
      assert(h.d.includes("unnest(p_ids)") && h.d.includes("unnest(p_enc) e"), "_ps_sec_people must read the arrays");
      assert(!h.d.includes("_patient_sources_identities") && !h.d.includes("_patient_sources_encounters"), "_ps_sec_people must not call the core directly");
    }));

    await check("5c controls: seven mutants of the helper are each caught by the same grid", () => scoped(async () => {
      await seedWorld();
      await seedPeopleExtras();
      const old = await peopleOld();
      // The unmutated shim must pass — otherwise a "caught" mutant could be the shim's fault.
      await peopleMutant("baseline", []);
      const base = await peopleDiffs("ps_ctl.people", "postgres", old);
      assert(base.diffs.length === 0, `control baseline (unmutated copy) must equal the old body: ${base.diffs.slice(0, 3).join("\n")}`);
      const mutants: [string, [string, string][]][] = [
        ["C1 drop the channel filter", [["and (p_channel is null or i.channel = p_channel)", "and true"]]],
        ["C2 off-by-one on first_date", [["and i.first_date between p_from and p_to", "and i.first_date > p_from and i.first_date <= p_to"]]],
        ["C3 wrong total_count", [["count(*) over ()", "count(*) over (partition by k.confirmed)"]]],
        ["C4 drop the survivor LEFT join", [["left join public.patients p on p.id = k.survivor_id", "join public.patients p on p.id = k.survivor_id"]]],
        ["C5 first row instead of min(service_date) in served", [["min(e.service_date)", "(array_agg(e.service_date))[1]"]]],
        ["C6 drop the customer-rows name fallback", [["where c.patient_id is null and c.loose_key = k.loose_key", "where false and c.loose_key = k.loose_key"]]],
        ["C7 max instead of min(service_date) in served", [["min(e.service_date)", "max(e.service_date)"]]],
      ];
      const escaped: string[] = [];
      for (const [label, edits] of mutants) {
        await peopleMutant(label, edits);
        const r = await peopleDiffs("ps_ctl.people", "postgres", old);
        console.log(`   5c ${label}: ${r.diffs.length} differing cases`);
        if (r.diffs.length === 0) escaped.push(label);
      }
      assert(escaped.length === 0, `these mutants were NOT caught (the proof is blind to them): ${escaped.join("; ")}`);
    }));

    await check("5c: timing — one page call, small world and a 3,000-patient scale world (no regression)", () => scoped(async () => {
      await seedWorld();
      await seedPeopleExtras();
      await peopleOld();
      await q(`insert into public.patients (first_name, last_name, birthdate, referral_source, created_at)
               select 'Scale' || g, 'Perf' || g, date '1990-01-01', (array['walk_in','online_facebook','online_google',null])[1 + g % 4],
                      timestamptz '2026-06-01 09:00+08' + (g % 28) * interval '1 day'
                 from generate_series(1, 3000) g`);
      await q(`insert into public.visits (patient_id, visit_date)
               select p.id, (p.created_at at time zone 'Asia/Manila')::date from public.patients p where p.last_name like 'Perf%'`);
      await asAdmin();
      const time = async (fn: string, mode: string) => {
        const runs: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await q(`select count(*) from ${fn}($1::date,$2::date,$3::text,null,50,0)`, [P_JUNE.from, P_JUNE.to, mode]);
          runs.push(performance.now() - t0);
        }
        return runs.sort((a, b) => a - b)[2];
      };
      for (const mode of ["new", "served"]) {
        const oldMs = await time("ps_old.patient_sources_people", mode);
        const newMs = await time("public.patient_sources_people", mode);
        console.log(`   5c timing ${mode} (3,000-patient world): old=${oldMs.toFixed(0)}ms new=${newMs.toFixed(0)}ms`);
        assert(newMs <= oldMs * 3 + 300, `${mode}: new ${newMs.toFixed(0)}ms vs old ${oldMs.toFixed(0)}ms — a planner regression (nested loop over unnest?)`);
      }
    }));
```

- [ ] **Step 3: Update the header comment of the proof script**

In the header block (around line 36) change the line `//   patient_sources_people = 0189. Letters A, B, C, E, F, G, L edit the core` to
`//   patient_sources_people = 0209_patient_sources_people.sql (wrapper + _ps_sec_people; 0189's body is`
`//   frozen in scripts/fixtures/patient-sources-people-pre-0209.sql). Letters A, B, C, E, F, G, L edit the core`
and append, after the M–P notes and before `//   0206 re-apply needs the objects dropped first:`, the placeholder block (filled in Task 5):
```
//   Q–R (0209) — see Task 5 of docs/superpowers/plans/2026-10-01-patient-sources-5c-people.md; the in-script
//   mutants C1–C7 ("5c controls") run on every proof run and need no file edit.
```
Also add to the run recipe near `PSQL=` the line `//   PS_STACK_IMAGE=17.6.1.167   (required by the 5c denial probes; .106/.111 segfault on a refused call)`.

- [ ] **Step 4: Typecheck the script**

Run: `npm run -s typecheck 2>&1 | tail -5`
Expected: no errors (the script is part of the project's `tsc` scope; fix any type error — e.g. the `peopleRows` row type is already declared in the file).

- [ ] **Step 5: Commit**

```bash
git add scripts/patient-sources-db-proof.ts
git commit -m "test(patient-sources): 5c people proof — seeded paths, ordered 3-mode grid, parity, controls, timing

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Run the proof; confirm it can fail

**Files:**
- Modify: `scripts/patient-sources-db-proof.ts` (control notes only)

- [ ] **Step 1: Full proof on the isolated stack with the migration applied**

Run: `SUPABASE_DB_URL=$DB PS_STACK_IMAGE=17.6.1.167 npm run -s patient-sources:db-proof > $SP/proof-5c.log 2>&1; grep -E "^(FAIL|[0-9]+/)|5c " $SP/proof-5c.log`
Expected: no `FAIL`; `N+8/N+8 checks passed.` where N is the Task 0 baseline (eight new checks: image, seeded, equality, invalid, gate, ACL, controls, timing); lines such as `5c grid: 192 cases, <≥60> non-empty, all identical`, `5c C1 …: <k> differing cases` with `k > 0` for all seven mutants and the baseline absent from the list, and `5c timing …` lines. Record the grid size and timings for the PR description.

- [ ] **Step 2: Prove the grid fails on the real function — file round Q (drop the channel filter in the migration)**

```bash
cp supabase/migrations/0209_patient_sources_people.sql $SP/mig.bak
node -e '
const fs=require("fs");const f="supabase/migrations/0209_patient_sources_people.sql";let s=fs.readFileSync(f,"utf8");
const from="and (p_channel is null or i.channel = p_channel)";if(!s.includes(from))throw new Error("missing");
fs.writeFileSync(f,s.split(from).join("and true"));'
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0209_patient_sources_people.sql > $SP/q-apply.log 2>&1; echo apply=$?
SUPABASE_DB_URL=$DB PS_STACK_IMAGE=17.6.1.167 npm run -s patient-sources:db-proof > $SP/proof-Q.log 2>&1; grep -E "^FAIL" $SP/proof-Q.log | cut -c1-260
cp $SP/mig.bak supabase/migrations/0209_patient_sources_people.sql
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0209_patient_sources_people.sql > /dev/null 2>&1; echo restored=$?
git diff --quiet supabase/migrations/0209_patient_sources_people.sql && echo file-clean
```
Expected: `apply=0`; `FAIL 5c: patient_sources_people returns exactly the pre-0209 rows, in order, with the same total_count — people differ from the pre-0209 body (…) : new … channel=walk_in …`; `restored=0`; `file-clean`. Copy the quoted FAIL fragment into the notes in Step 4.

- [ ] **Step 3: File round R (wrapper passes an empty encounter array in served mode)**

```bash
node -e '
const fs=require("fs");const f="supabase/migrations/0209_patient_sources_people.sql";let s=fs.readFileSync(f,"utf8");
const from="case when p_mode = \x27served\x27 then public._ps_encounter_list() else";if(!s.includes(from))throw new Error("missing");
fs.writeFileSync(f,s.replace(from,"case when p_mode = \x27never\x27 then public._ps_encounter_list() else"));'
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0209_patient_sources_people.sql > /dev/null 2>&1; echo apply=$?
SUPABASE_DB_URL=$DB PS_STACK_IMAGE=17.6.1.167 npm run -s patient-sources:db-proof > $SP/proof-R.log 2>&1; grep -E "^FAIL" $SP/proof-R.log | cut -c1-260
cp $SP/mig.bak supabase/migrations/0209_patient_sources_people.sql
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0209_patient_sources_people.sql > /dev/null 2>&1; echo restored=$?
git diff --quiet supabase/migrations/0209_patient_sources_people.sql && echo file-clean
```
Expected: `FAIL 5c: … returns exactly the pre-0209 rows … served …` (every served case returns nothing); `restored=0`; `file-clean`.

- [ ] **Step 4: Record the confirmations in the proof header and re-run green**

Replace the Q–R placeholder block added in Task 4 Step 3 with:
```
//   Q (0209). _ps_sec_people: `and (p_channel is null or i.channel = p_channel)` -> `and true` (both
//      occurrences) in the migration, psql -f it. Confirmed <date>: FAIL 5c: patient_sources_people
//      returns exactly the pre-0209 rows … — <quoted fragment from Step 2>.
//   R (0209). wrapper: `case when p_mode = 'served' then …` -> `'never'`. Confirmed <date>: FAIL 5c:
//      patient_sources_people returns exactly the pre-0209 rows … — <quoted fragment from Step 3>.
//   C1–C7 (in script, no file edit): seven copies of the helper in schema ps_ctl, each with one edit,
//      each compared through the same grid; the check fails if ANY escapes ("5c controls").
```
Then: `SUPABASE_DB_URL=$DB PS_STACK_IMAGE=17.6.1.167 npm run -s patient-sources:db-proof > $SP/proof-final.log 2>&1; grep -E "^(FAIL|[0-9]+/)" $SP/proof-final.log` — expected all-PASS `N+8/N+8`. Also run the neighbouring proof once: `SUPABASE_DB_URL=$DB npm run -s sheet-sync:db-proof 2>&1 | tail -2` (expected: all passed; it shares the mirror tables).

- [ ] **Step 5: Commit**

```bash
git add scripts/patient-sources-db-proof.ts
git commit -m "test(patient-sources): 5c control rounds Q-R confirmed; C1-C7 in-script mutants documented

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Mirror-readers allowlist and the unit-test gate for the new migration

**Files:**
- Modify: `src/lib/sheet-sync/mirror-readers.test.ts`

The migration names both mirror tables (`sheet_encounter_lines`, `sheet_customer_rows`) in the helper body, so the "no migration other than …" test fails until the file is allowlisted BY NAME (not number, like the others).

- [ ] **Step 1: Confirm the test fails first**

Run: `npx vitest run src/lib/sheet-sync/mirror-readers.test.ts 2>&1 | tail -15`
Expected: FAIL — `offenders` contains `0209_patient_sources_people.sql`.

- [ ] **Step 2: Add the allowlist entry**

In the third `it(...)` ("no migration other than …"): add a comment line after the 0206 note —
`    // 0209 moves patient_sources_people's rules (the unlinked-name lookups read both mirror tables)`
`    // verbatim into a closed helper behind the same admin-only gate.`
— and after `const oneCall = …; expect(oneCall).toHaveLength(1);` add
```ts
    const people = sql.filter((f) => /_patient_sources_people\.sql$/.test(f));
    expect(people).toHaveLength(1);
```
and extend the filter chain: `&& !oneCall.includes(f)` becomes `&& !oneCall.includes(f) && !people.includes(f)`. Also extend the test's title string to end `… the held-patient tidy-up, the one-call report and the people helper mention the mirror tables` (keep the existing wording, appending only the new clause).

- [ ] **Step 3: Run it green, then the Patient Sources surface tests**

Run: `npx vitest run src/lib/sheet-sync/mirror-readers.test.ts src/lib/marketing 2>&1 | tail -8`
Expected: all pass. (`patient-sources-surfaces.test.ts` is unchanged: the RPC name is already listed and only the loader module calls it.)

- [ ] **Step 4: Check no other migration-scanning test objects**

Run: `npx vitest run src/lib/patients/lifecycle-owned-functions.test.ts src/lib/accounting/pg-error-coverage.test.ts src/lib/db 2>&1 | tail -6`
Expected: pass. If any other scan fails on the new file (e.g. a "every SECURITY DEFINER sets search_path" or ACL scan), fix the migration or that test's allowlist by matching how it already treats `0206_patient_sources_report.sql` (grep the test for `0206`/`patient_sources_report` to see the pattern); do not weaken a test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sheet-sync/mirror-readers.test.ts
git commit -m "test(sheet-sync): allow the 0209 people migration to name the mirror tables

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Regenerate database types

**Files:**
- Modify: `src/types/database.ts`

- [ ] **Step 1: Regenerate from the isolated stack**

Run: `npm run -s db:types -- --workdir $SP && git diff --stat src/types/database.ts`
Expected: only `src/types/database.ts` changes.

- [ ] **Step 2: Check the diff is exactly one new function entry**

Run: `git diff src/types/database.ts`
Expected: ONE added block `_ps_sec_people: { Args: { p_channel: string; p_enc: …_ps_encounter[]; p_from: string; p_ids: …_ps_identity[]; p_limit: number; p_mode: string; p_offset: number; p_to: string }; Returns: { display_name: string; drm_id: string; first_date: string; identity: string; identity_kind: string; patient_id: string; total_count: number }[] }` next to the other `_ps_sec_*` entries, and NO change to the `patient_sources_people` entry (src/types/database.ts ~line 7765). If the `patient_sources_people` entry changed, the wrapper's signature drifted: stop and fix the migration. (The spec expected "no diff"; the closed helpers are typed too — see Decision 2.)

- [ ] **Step 3: Typecheck and commit**

Run: `npm run -s typecheck && echo ok`
Expected: `ok`.

```bash
git add src/types/database.ts
git commit -m "chore(db): types for the _ps_sec_people helper

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Skill ledger line (CLAUDE.md ledger waits for the verified push)

**Files:**
- Modify: `.claude/skills/drmed-migrations/SKILL.md`

- [ ] **Step 1: Add one line to the skill's migration list**

After the `0205_release_audit_in_rpc.sql …` line (grep `^0205` to find it) add a line in the same style:
`0209_patient_sources_people.sql ← feat/patient-sources-5c-people (Phase 5c). `patient_sources_people` re-created as a thin wrapper (same signature/gate/ACL; admin-only, service_role keeps EXECUTE — a refused call segfaults image .111, server code never calls it) over the new closed `_ps_sec_people(_ps_identity[], _ps_encounter[], …)` helper holding 0189's rules verbatim, reading the 0206 shared arrays. Proof: frozen 0189 body (`scripts/fixtures/patient-sources-people-pre-0209.sql`, schema `ps_old`) compared row-for-row over a 192-case grid, seven in-script mutants, gate/ACL parity. Rollback = a forward migration restoring that fixture body.`

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/drmed-migrations/SKILL.md
git commit -m "docs(skill): record 0209 patient_sources_people in the migrations skill

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(The `CLAUDE.md` ledger line is written in Task 10, only after prod verification, so it never claims a head that is not true.)

---

### Task 9: Full gate

**Files:** none (fix anything that fails in the file that owns it).

- [ ] **Step 1: Unit tests**

Run: `npm test > $SP/test.log 2>&1; echo exit=$?; tail -8 $SP/test.log`
Expected: `exit=0`, no failed files.

- [ ] **Step 2: Typecheck, lint, build**

```bash
npm run -s typecheck > $SP/tc.log 2>&1; echo typecheck=$?
npm run -s lint > $SP/lint.log 2>&1; echo lint=$?
npm run build > $SP/build.log 2>&1; echo build=$?; tail -5 $SP/build.log
```
Expected: `typecheck=0`, `lint=0`, `build=0`. (The Vercel preview build needs `0209` applied to the linked project; that happens in Task 10 before merge.)

- [ ] **Step 3: One last proof run and a clean-tree check**

Run: `SUPABASE_DB_URL=$DB PS_STACK_IMAGE=17.6.1.167 npm run -s patient-sources:db-proof 2>&1 | grep -E "^(FAIL|[0-9]+/)"; git status --short`
Expected: all-PASS; clean tree.

- [ ] **Step 4: Open the PR (draft first)**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/patient-sources-5c-people
gh pr create --draft --title "feat(patient-sources): people list over the shared arrays (0209)" --body "<summary for a non-developer, the proof numbers from Task 5 (grid size, mutants caught, timings), the rollback note, and: migration 0209 must be applied to prod before merge (user-run db push). 

🤖 Generated with [Claude Code](https://claude.com/claude-code)>"
```
Expected: a PR URL. Do NOT `gh pr ready` within seconds of a push (the ready-for-review cancel trap): wait for the push's CI run to start, then mark ready.

---

### Task 10: Prod apply (user-run), verification, ledger line, guide bump, merge

**Files:**
- Modify: `CLAUDE.md` (ledger line, guide version), `docs/drmed-user-guide.html` (version only)

- [ ] **Step 1: Pre-flight against prod (read-only)**

Run (MCP `list_migrations`, project `qhptbmafrosgibooelpp`): confirm the head and that `0209` is not applied and no other session took it. Run `git fetch origin && git log --oneline origin/main -3`; if main moved, rebase and re-run Task 9 Step 1–2. Run `npm run claim -- list | grep 0209` — still ours.

- [ ] **Step 2: Capture the BEFORE facts on prod (read-only SQL via MCP `execute_sql`, no calls to the function)**

```sql
select coalesce(proacl::text,'') as acl, prosecdef, provolatile,
       pg_get_function_identity_arguments(oid) as args,
       has_function_privilege('service_role', oid, 'execute') as svc,
       pg_get_functiondef(oid) like '%_ps_sec_people%' as already_new
from pg_proc where oid = 'public.patient_sources_people(date,date,text,text,integer,integer)'::regprocedure;
```
Expected: ACL equals the frozen ACL from Task 1 Step 3 (this also confirms prod's grants match the local stack's), `already_new = false`, `svc = true`. Never `select` the function itself with a service role (refused-call segfault on .111).

- [ ] **Step 3: The user applies the migration (user approves the prompt)**

Copy the link files into the worktree (`supabase/.temp/{project-ref,linked-project.json,pooler-url}` from the main checkout), then hand the user these two commands, dry run first. Wait for the user to run them and paste the output:
```
! cd /Users/jamila/Claude/DRMed/.worktrees/ps-people && /opt/homebrew/bin/supabase db push --dry-run
! cd /Users/jamila/Claude/DRMed/.worktrees/ps-people && /opt/homebrew/bin/supabase db push
```
Expected dry-run output: exactly ONE pending migration, `0209_patient_sources_people.sql`. If it lists anything else, STOP and ask (another session's migration is unapplied; only then consider `--include-all` with the user's explicit OK). The user answers the push confirmation prompt. Never use MCP `apply_migration`.

- [ ] **Step 4: Verify on prod by object (read-only SQL)**

```sql
select max(version) from supabase_migrations.schema_migrations;                 -- expect '0209'
select coalesce(proacl::text,'') as acl,                                        -- byte-equal to Step 2's
       pg_get_functiondef(oid) like '%_ps_sec_people%' as wrapper_calls_helper,  -- true
       pg_get_functiondef(oid) like '%service_role%' as wrapper_mentions_service_role, -- false
       has_function_privilege('service_role', oid, 'execute') as svc,            -- true
       has_function_privilege('anon', oid, 'execute') as anon_exec,              -- false
       prosecdef, provolatile
from pg_proc where oid = 'public.patient_sources_people(date,date,text,text,integer,integer)'::regprocedure;
select has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute')
       or has_function_privilege('service_role', oid, 'execute') as helper_open,  -- false
       pg_get_functiondef(oid) like '%unnest(p_ids)%' as reads_arrays             -- true
from pg_proc where oid = 'public._ps_sec_people(public._ps_identity[],public._ps_encounter[],date,date,text,text,integer,integer)'::regprocedure;
```
Expected as annotated. Then confirm the live page still works: in the browser as the admin (Playwright MCP per the user's rules; sign in as the admin on the deployed URL or use the cookie-injection recipe — never switch to claude-in-chrome silently), open `/staff/marketing/patients/people` for each of New / Returning / Served over the last full month and compare the totals with the Patient Sources page tiles for the same period (they come from a different RPC, so they must agree). Note: a refused call must never be produced on prod; this step only makes allowed admin calls.

- [ ] **Step 5: Time it on prod (read-only)**

```sql
explain (analyze, buffers, timing on)
select * from public._ps_sec_people(public._ps_identity_list(), public._ps_encounter_list(),
       date '2026-09-01', date '2026-09-30', 'served', null, 50, 0);
explain (analyze, buffers, timing on)
select count(*) from public._patient_sources_identities();
```
(Run as the default `postgres` MCP role; the helper is closed to runtime roles but not to the owner.) Record execution time of the first (served, ~identity core + encounters + join) against the second (identity core alone, ~185 ms) in the PR. Expected: the helper is within about 1.5x the core cost (the old body cost = core + encounters + the same join). If the plan shows a Nested Loop joining `unnest(p_enc)` to `unnest(p_ids)` with tens of seconds of runtime, ROLL BACK: add a forward migration restoring `scripts/fixtures/patient-sources-people-pre-0209.sql` (`ps_old` -> `public`) and stop; report to the user.

- [ ] **Step 6: Ledger line and guide version (at merge time)**

After Step 4 passes, edit `CLAUDE.md`: change the start of the `Migration ledger:` paragraph (line ~30) from `Migration ledger: **prod head = 0208** (` to `Migration ledger: **prod head = 0209** (`patient_sources_people`, Patient Sources Phase 5c — `patient_sources_people` re-created as a thin wrapper over the closed `_ps_sec_people` helper reading the 0206 shared arrays; same signature/gate/ACL, service_role EXECUTE kept; pushed <date> by the user, verified by object, rollback = restore `scripts/fixtures/patient-sources-people-pre-0209.sql`) over **0208** (`, leaving the rest of the line unchanged; if main has since moved the head, put `0209` above whatever head is now there. Then bump the user-guide version at merge time: re-read the current version (`grep -n "v2\.[0-9]*" CLAUDE.md docs/drmed-user-guide.html | head -5`; it was v2.62, 1 Oct 2026 when this plan was written, another PR may have bumped it), increment the minor by one and set today's date in `docs/drmed-user-guide.html` and the `CLAUDE.md` guide line (no new guide content: nothing user-visible changed). Run `npm test 2>&1 | tail -4` (some tests pin the guide version string), then:

```bash
git add CLAUDE.md docs/drmed-user-guide.html
git commit -m "docs: ledger 0209 patient_sources_people on prod; guide version bump

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
```

- [ ] **Step 7: Mark ready, merge, confirm the deploy**

Wait for the push's CI run to start, then `gh pr ready`; when CI is green and the user says merge, merge with the repo's merge flow, then confirm the Vercel production deploy landed (merge is not deploy) and the People page still loads for all three modes. Update the project memory file (`drmed-sheet-sync.md`): 5c merged, `0209` on prod, next = 5a/5b per the spec.

- [ ] **Step 8: Tear down the isolated stack**

Run: `npx supabase stop --no-backup --workdir $SP && rm -rf $SP`
Expected: the stack stops; ports 563xx are free again.

---

## Self-review notes (checked against the spec)

- §5 helper: shape, reads `unnest(p_ids)` / `unnest(p_enc)`, name lookups verbatim, closed ACL — Task 2 (with the invoker-not-definer correction, Decision 1).
- §5 wrapper identical: signature/return/volatility/security/search_path/gate/validation/paging/ACL, `service_role` EXECUTE kept — Task 2 + post-conditions + Task 4 ACL check.
- §5 allowlist: Task 6. App side unchanged, types diff = one new helper entry (Task 7; spec said none — Decision 2).
- §5 proof 1–7: freeze (Task 1), non-vacuous seeded world incl. both name fallbacks, merged survivor, channels, multi-date served (Task 4 check 2; null-name unreachable, Decision 3), full ordered grid across all three modes with all period/channel/paging cases (check 3), invalid-input parity with SQLSTATE + message (check 4), gate + View-as parity on a safe image only, image recorded (checks 1 and 5), ACL byte-equality, identity args/result equality, helper closed + no `service_role` literal (check 6), six must-fail controls plus a seventh (check 7 and file rounds Q–R), timing local + scale + prod (check 8, Task 10).
- Gate, user-run push (dry run first, approve prompt), prod verification by object, ledger line, guide bump at merge: Tasks 9–10.

# DRM-ID width fix (patient-delete rollout, PR 1) Implementation Plan

> Shipped as 0163 (#216).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `generate_drm_id()` truncating five-digit sequence values, so patient creation keeps working past DRM-9999.

**Architecture:** One migration re-creates `public.generate_drm_id()` with a width of `greatest(4, length(n))`, calling `nextval` exactly once. Same signature, so the ACL survives; the `search_path` SET is restated because `create or replace` replaces it. A LOCAL-ONLY SQL smoke test proves the 9999 → 10000 → 10001 boundary, and proves with a control that the old body collides with a kept DRM-1000.

**Tech Stack:** Postgres (Supabase local stack on OrbStack), psql smoke tests in `supabase/tests/`, Supabase CLI 2.105.

Spec: `docs/superpowers/specs/2026-09-24-patient-delete-design.md` → "DRM-ID generation, in this same batch" and "Rollout" item 1.

## Facts established 2026-09-24 (prod, read-only)

- `0001_init.sql:25-31`: `select 'DRM-' || lpad(nextval('public.drm_id_seq')::text, 4, '0');`. Postgres `lpad` **truncates** a longer string, so `lpad('10000', 4, '0') = '1000'`, and the insert then fails the `drm_id` unique constraint against the existing DRM-1000.
- `0002_function_search_path.sql:8` sets `search_path = public` on it.
- Prod: `drm_id_seq.last_value = 7275`, `is_called = true`, max numeric suffix = 7275, 7,068 patients, and every `drm_id` matches `^DRM-\d{4}$`. The sequence is at the watermark, so no correction is needed. Re-check this at push time.
- Prod ACL: `{=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}`, owner `postgres`. It is a column default, so every inserting role needs EXECUTE. **Do not change the ACL.**
- App validators already accept 4+ digits: `src/lib/validations/auth.ts:8`, `src/lib/validations/booking.ts:250`, `admin/patient-merge/actions.ts:49` (`/^DRM-\d{4,}$/`); `sentry-scrub.ts:21` uses `\d{3,}`. No TypeScript change is needed.
- **Migration number: 0161.** `origin/fix/retire-send-out-accrual` holds 0159; `origin/feat/payment-edit` and `origin/feat/xray-claim-gate` both hold 0160. Re-check before pushing.

## Files

- Create: `supabase/migrations/0161_drm_id_width.sql`, the function fix.
- Create: `supabase/tests/0161_drm_id_width_smoke.sql`, the boundary and control proof (LOCAL ONLY).
- Modify: `CLAUDE.md`, the migration ledger paragraph.

---

### Task 0: Branch and local stack

- [ ] **Step 1: Create the PR worktree off current main**

```bash
cd /Users/jamila/Claude/DRMed && git fetch -q origin && \
git worktree add .worktrees/drm-id-width -b fix/drm-id-width origin/main
```

- [ ] **Step 2: Copy the Supabase link files for the later `db push`**

```bash
mkdir -p /Users/jamila/Claude/DRMed/.worktrees/drm-id-width/supabase/.temp && \
cp /Users/jamila/Claude/DRMed/supabase/.temp/{project-ref,linked-project.json,pooler-url} \
   /Users/jamila/Claude/DRMed/.worktrees/drm-id-width/supabase/.temp/ 2>&1 | tail -3
```

- [ ] **Step 3: Make sure the local stack is up (OrbStack, never Docker Desktop)**

Run: `cd /Users/jamila/Claude/DRMed/.worktrees/drm-id-width && /opt/homebrew/bin/supabase status 2>&1 | head -5`
Expected: a DB URL on `127.0.0.1:54322`. If it's stopped: `/opt/homebrew/bin/supabase start`. The local stack is shared across worktrees, so only apply this branch's migration to it; don't reset it without checking other sessions.

### Task 1: Write the failing smoke test

**Files:**
- Create: `supabase/tests/0161_drm_id_width_smoke.sql`

- [ ] **Step 1: Write the test**

```sql
-- =============================================================================
-- 0161_drm_id_width_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after migrations:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/0161_drm_id_width_smoke.sql
--
-- What it proves:
--   1. generate_drm_id() yields DRM-9999, DRM-10000, DRM-10001 across the boundary.
--   2. A patient inserted at DRM-10000 succeeds while a DRM-1000 row exists.
--   3. THE CONTROL: with 0001's original body restored inside this transaction, the
--      same insert raises unique_violation. That shows assertion 2 would catch the
--      truncation, rather than passing because DRM-1000 happened to be absent.
--   4. The ACL and pinned search_path survived the create-or-replace.
--
-- Sequences are NOT transactional: setval survives ROLLBACK. The block saves the
-- sequence position and restores it before exit, and it refuses to run against a
-- database that looks like prod.
begin;

do $$
declare
  saved_last bigint;
  saved_called boolean;
  got text;
  collided boolean := false;
begin
  if (select count(*) from public.patients) > 5000 then
    raise exception 'refusing: % patients looks like prod — this test is LOCAL ONLY',
      (select count(*) from public.patients);
  end if;

  select last_value, is_called into saved_last, saved_called from public.drm_id_seq;

  -- A kept DRM-1000 row: the one the old body collides with.
  if not exists (select 1 from public.patients where drm_id = 'DRM-1000') then
    insert into public.patients (drm_id, first_name, last_name, birthdate)
    values ('DRM-1000', 'Smoke', 'Kept', '1990-01-01');
  end if;

  -- 1. Boundary through the live function.
  perform setval('public.drm_id_seq', 9998, true);
  got := public.generate_drm_id();
  if got <> 'DRM-9999' then raise exception 'FAIL 1a: expected DRM-9999, got %', got; end if;
  got := public.generate_drm_id();
  if got <> 'DRM-10000' then raise exception 'FAIL 1b: expected DRM-10000, got %', got; end if;
  got := public.generate_drm_id();
  if got <> 'DRM-10001' then raise exception 'FAIL 1c: expected DRM-10001, got %', got; end if;

  -- 2. Real insert at the boundary, next to the kept DRM-1000.
  perform setval('public.drm_id_seq', 9999, true);
  insert into public.patients (first_name, last_name, birthdate)
  values ('Smoke', 'Boundary', '1990-01-01')
  returning drm_id into got;
  if got <> 'DRM-10000' then raise exception 'FAIL 2: inserted %, expected DRM-10000', got; end if;

  -- 4. ACL + search_path preserved (checked before the control redefines the body).
  if not has_function_privilege('authenticated', 'public.generate_drm_id()', 'execute')
     or not has_function_privilege('service_role', 'public.generate_drm_id()', 'execute')
     or not has_function_privilege('anon', 'public.generate_drm_id()', 'execute') then
    raise exception 'FAIL 4a: generate_drm_id lost an EXECUTE grant (column default needs it)';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.generate_drm_id()'::regprocedure
      and array_to_string(proconfig, ',') like 'search_path=%'
  ) then
    raise exception 'FAIL 4b: generate_drm_id has no pinned search_path';
  end if;

  -- 3. CONTROL: 0001's original body collides at the same boundary.
  execute $f$
    create or replace function public.generate_drm_id()
    returns text language sql volatile set search_path = public as $b$
      select 'DRM-' || lpad(nextval('public.drm_id_seq')::text, 4, '0');
    $b$
  $f$;
  perform setval('public.drm_id_seq', 9999, true);
  begin
    insert into public.patients (first_name, last_name, birthdate)
    values ('Smoke', 'Control', '1990-01-01');
  exception when unique_violation then
    collided := true;
  end;
  if not collided then
    raise exception 'FAIL 3 (control): the old body did not collide — assertion 2 proves nothing';
  end if;

  perform setval('public.drm_id_seq', saved_last, saved_called);
  raise notice 'PASS: boundary 9999→10000→10001, insert beside DRM-1000, control collides, ACL + search_path intact';
end;
$$;

rollback;
```

Note: if any assertion raises, the block aborts before its final `setval`, which leaves the local sequence at about 10001. That is harmless locally: the sequence is only ahead, and it never goes backwards onto used IDs. To reset it, run `select setval('public.drm_id_seq', (select max(substring(drm_id from '^DRM-(\d+)$')::bigint) from public.patients));`.

- [ ] **Step 2: Run it against the unfixed function and see it fail**

Run: `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/0161_drm_id_width_smoke.sql 2>&1 | tail -3`
Expected: `ERROR:  FAIL 1b: expected DRM-10000, got DRM-1000`

- [ ] **Step 3: Put the local sequence back (the failed run skipped its restore; its rows were rolled back, so the max suffix is the right watermark)**

```bash
docker exec -i supabase_db_DRMed psql -U postgres -d postgres -c \
"select setval('public.drm_id_seq', coalesce((select max(substring(drm_id from '^DRM-(\\d+)$')::bigint) from public.patients where drm_id ~ '^DRM-\\d+$'), 1));"
```

### Task 2: The migration

**Files:**
- Create: `supabase/migrations/0161_drm_id_width.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0161_drm_id_width.sql
-- generate_drm_id() padded to a FIXED width of 4 with lpad, and Postgres lpad
-- truncates a longer string: lpad('10000', 4, '0') = '1000'. So the 10,000th
-- patient would have been given DRM-1000, which already exists, and every patient
-- insert after DRM-9999 would fail the drm_id unique constraint. Prod stood at
-- DRM-7275 on 2026-09-24.
--
-- Width is now greatest(4, length(n)): DRM-0001 … DRM-9999, DRM-10000, DRM-10001 …
-- nextval is called exactly once. IDs are never renumbered, reused or reseeded.
--
-- Same signature, so the existing ACL (PUBLIC/anon/authenticated/service_role
-- EXECUTE — it is a column default, and every inserting role needs it) survives
-- unchanged. create or replace REPLACES proconfig, so the search_path pin from
-- 0002 is restated here. Proof: supabase/tests/0161_drm_id_width_smoke.sql.

create or replace function public.generate_drm_id()
returns text
language sql
volatile
set search_path = public
as $$
  select 'DRM-' || lpad(s.n, greatest(4, length(s.n)), '0')
  from (select nextval('public.drm_id_seq')::text as n) s;
$$;
```

- [ ] **Step 2: Apply it to the local stack only**

Run: `/opt/homebrew/bin/supabase migration up --local 2>&1 | tail -3`
Expected: `Applying migration 0161_drm_id_width.sql...` and then `Local database is up to date.` If the local ledger is missing 0159/0160 from other branches, that's fine: they aren't on main.

- [ ] **Step 3: Run the smoke test and see it pass**

Run: `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/0161_drm_id_width_smoke.sql 2>&1 | tail -3`
Expected: `NOTICE:  PASS: boundary 9999→10000→10001, insert beside DRM-1000, control collides, ACL + search_path intact` then `ROLLBACK`.

- [ ] **Step 4: Confirm the sequence was restored**

Run: `docker exec -i supabase_db_DRMed psql -U postgres -d postgres -Atc "select last_value < 9990 from public.drm_id_seq;"`
Expected: `t`

- [ ] **Step 5: Full-history replay check (fresh empty DB)**

The 2026-09-24 CLAUDE.md requires the whole history to apply to an empty DB. Because the local stack is shared, don't `db reset` it if another session is using it. Check `git worktree list` and ask before resetting. If it's clear: `npm run db:reset 2>&1 | tail -3`, expected to finish with `Finished supabase db reset`, then re-run Step 3.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0161_drm_id_width.sql supabase/tests/0161_drm_id_width_smoke.sql
git commit -m "fix(db): DRM-ID no longer truncates past DRM-9999 (0161)

lpad(n, 4) truncates a 5-digit value, so the 10,000th patient would get
DRM-1000 and every insert after DRM-9999 would fail the unique constraint.
Width is now greatest(4, length(n)). ACL unchanged; search_path restated.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: Gates, types, docs

**Files:**
- Modify: `CLAUDE.md` (the "Migration ledger" paragraph)

- [ ] **Step 1: Regenerate types. There should be no diff (same signature).**

Run: `npm run db:types >/dev/null 2>&1; git diff --stat src/types/database.ts`
Expected: no output.

- [ ] **Step 2: Unit, type and lint gates**

Run: `npm test 2>&1 | tail -4; npm run typecheck 2>&1 | tail -2; npm run lint 2>&1 | tail -2`
Expected: vitest reports all passed (in particular `pg-error-coverage.test.ts` is unaffected: the new function has no `raise`), tsc exits clean, and eslint reports no errors.

- [ ] **Step 3: Update the CLAUDE.md ledger paragraph**

Add a sentence after the 0158 sentence: `**0161** (`drm_id_width`, patient-delete rollout PR 1) fixes `generate_drm_id()` truncating past DRM-9999; 0159/0160 are claimed by open branches (`fix/retire-send-out-accrual`, `feat/payment-edit`, `feat/xray-claim-gate` — the last two BOTH claim 0160), so whichever lands after 0161 needs `db push --include-all`.` Then update "Next unused number" to 0162.

- [ ] **Step 4: Check whether a skill or the user guide cites the old format**

Run: `git grep -n "generate_drm_id\|lpad" -- .claude/skills/drmed-* docs/drmed-user-guide.html | head`
Expected: no hits, or only descriptive text. Update any line that says IDs are always 4 digits.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: ledger — 0161 drm_id_width, 0159/0160 claimed by open branches

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: PR, prod apply, verify, merge

- [ ] **Step 1: Push and open the PR (mark it ready immediately, not as a draft)**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin fix/drm-id-width 2>&1 | tail -1
gh pr create --title "fix(db): DRM-ID no longer truncates past DRM-9999 (0161)" --body "$(cat <<'EOF'
## What
`generate_drm_id()` used `lpad(n, 4, '0')`, which truncates: the 10,000th patient would
get `DRM-1000` (already taken) and every patient insert after DRM-9999 would fail.
Prod is at DRM-7275. Width is now `greatest(4, length(n))`.

PR 1 of 4 in the patient-delete rollout (spec: `docs/superpowers/specs/2026-09-24-patient-delete-design.md` on `feat/patient-delete`).

## Safety
- Same signature → ACL unchanged (verified on prod before/after). `search_path` restated.
- No renumbering, no sequence change (prod sequence = max suffix = 7275).
- App validators already accept `DRM-\d{4,}`.

## Proof
`supabase/tests/0161_drm_id_width_smoke.sql` (local): boundary 9999→10000→10001, insert beside
a kept DRM-1000, and a control showing 0001's body collides.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -1
```

- [ ] **Step 2: Re-check the migration number and the prod watermark right before the push**

Re-run the branch loop from Task 0 facts: `for b in $(git branch -r --format='%(refname:short)'); do echo "$b $(git ls-tree --name-only $b supabase/migrations/ | tail -1)"; done | sort -k2 | tail -3`. Expected: nothing else claims 0161. On prod (read-only MCP `execute_sql`), `select last_value from public.drm_id_seq` should still be below 9999.

- [ ] **Step 3: Dry-run, then push to prod (Claude runs this per the 2026-09-24 owner authorisation)**

Run: `/opt/homebrew/bin/supabase db push --dry-run 2>&1 | tail -4`
Expected: exactly `0161_drm_id_width.sql` listed. If 0159/0160 appear, stop: they belong to other branches.
Then: `/opt/homebrew/bin/supabase db push 2>&1 | tail -3`

- [ ] **Step 4: Verify on prod by OBJECT, never by the push summary line (read-only)**

```sql
select pg_get_functiondef('public.generate_drm_id()'::regprocedure) like '%greatest(4, length(s.n))%' as fixed,
       (select proconfig::text from pg_proc where oid = 'public.generate_drm_id()'::regprocedure) as cfg,
       (select proacl::text from pg_proc where oid = 'public.generate_drm_id()'::regprocedure) as acl,
       (select version from supabase_migrations.schema_migrations order by version desc limit 1) as head;
```
Expected: `fixed = true`, `cfg = {search_path=public}`, `acl` identical to the "Facts" line above, `head = 0161`. Do NOT call `generate_drm_id()` on prod: it would burn a real DRM-ID.

- [ ] **Step 5: Ask the owner to merge (DRMed blocks `gh pr merge` from Claude), then confirm the Vercel production deploy landed**

`gh pr view --json state,mergeCommit -q '.state+" "+.mergeCommit.oid'` → `MERGED <sha>`; then check the deploy status for that sha (`gh api repos/{owner}/{repo}/commits/<sha>/status -q .state` → `success`).

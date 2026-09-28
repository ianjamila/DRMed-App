# Admin "View as role" follow-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four Codex P2s + one P3 on #237's admin "View as role" and ship the seven approved refinements (spec: `docs/superpowers/specs/2026-09-28-view-as-followups-design.md`).

**Architecture:** Migration 0187 moves every View-as state change into two row-locked SQL functions (`view_as_transition`, `view_as_expire`) that also write the audit rows, plus a `before insert` trigger that stamps `metadata.acting_as` on staff audit rows during a simulation. The TS side becomes thin callers; the client gets `useActionState` forms (pending/error/return-to), a server-clock countdown, and a cheap `GET /staff/view-as/state` check that refreshes a stale shell only on mismatch.

**Tech Stack:** Next.js 16 App Router (Server Actions, route handlers), React 19 (`useActionState`), Supabase Postgres (plpgsql, RLS), Vitest (node env, `renderToStaticMarkup` — **no DOM**), psql smoke scripts.

**Worktree:** `~/Claude/DRMed/.worktrees/view-as-followups`, branch `feat/view-as-followups`. Run every command from there.

---

## Ground rules for every task

- **Vitest has no DOM** (`environment: "node"`). Client components are tested with `renderToStaticMarkup`; effects never run. Put logic worth testing in **pure functions** and test those. Run a file with `npx vitest run <path>`.
- Modules under test that `import "server-only"` need `vi.mock("server-only", () => ({}))` (see `src/lib/auth/view-as-switch.test.ts`).
- `npx tsc --noEmit` has ~24–38 **pre-existing** errors (stale `.next/types`, `scripts/smoke-print.ts`). Only errors in files you touched count: `npx tsc --noEmit 2>&1 | grep -E "view-as|require-staff|staff-shell|staff-mobile-nav|users/|database.ts"`.
- Lint touched files: `npx eslint <files>`.
- **Local DB is shared with other sessions and gets reset by them.** Never run `supabase db reset`. Apply migrations with psql. `psql` is at `/opt/homebrew/opt/libpq/bin/psql`. DB URL: `DB=$(supabase status -o json | jq -r .DB_URL)`. Before any DB step check the 0182 columns exist: `$PSQL "$DB" -Atc "select count(*) from information_schema.columns where table_name='staff_profiles' and column_name like 'view_as%'"` → `2`. If `0`, re-apply 0182 first: `$PSQL "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0182_staff_view_as_role.sql`.
- Bash is **zsh**: never name a variable `path`; don't use `python3 - <<EOF` heredocs (killed); `echo "====="` fails (use `echo '---'`).
- Commits end with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. A post-commit hook may print `Killed: 9 python3 -c "import graphify"` — harmless.

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/0187_view_as_followups.sql` | create | `view_as_transition`, `view_as_expire`, `audit_log_stamp_view_as` trigger, ACLs |
| `supabase/tests/0187_view_as_followups_smoke.sql` | create | DB proof for 0187 |
| `supabase/tests/0182_staff_view_as_smoke.sql` | modify | + P8 Pathologist equivalence, + P9 X-ray Claim write |
| `src/lib/auth/view-as-followups-migration.test.ts` | create | pins 0187 text (duration, roles, CASE, ACLs) |
| `src/types/database.ts` | modify | `Functions` entries for the two RPCs |
| `src/lib/auth/view-as.ts` | modify | + `formatRemainingMs`, `expiryRefreshDelay`, `hasStaleViewAs`, `viewAsStateKey`, `ViewAsActionState` |
| `src/lib/auth/view-as-return.ts` | create | `safeReturnTo(raw, role)` |
| `src/lib/auth/view-as-shell-sync.ts` | create | `shellIsStale`, `checkViewAsShell` (client-safe) |
| `src/lib/auth/view-as-switch.ts` | modify | RPC callers `startViewAs`/`exitViewAs`, `expireStaleViewAs` |
| `src/lib/auth/require-staff.ts` | modify | lazy expiry call |
| `src/app/(staff)/staff/(dashboard)/view-as/actions.ts` | modify | `useActionState` shape, error return, `safeReturnTo` redirect |
| `src/app/(staff)/staff/(dashboard)/view-as/state/route.ts` | create | `GET` own View-as state |
| `src/components/staff/view-as-select.tsx` | modify | pending/error/return_to |
| `src/components/staff/view-as-exit-button.tsx` | create | Exit with pending/error/return_to |
| `src/components/staff/use-view-as-shell-sync.ts` | create | hook: pathname + visibility → check → refresh |
| `src/components/staff/view-as-banner.tsx` | modify | until label, countdown, server-remaining timer, `ViewAsShellSync` |
| `src/components/staff/staff-shell.tsx` | modify | new banner props, keys, `ViewAsShellSync` |
| `src/components/staff/staff-mobile-nav-trigger.tsx` | modify | drawer closes on View-as state change; select key/until |
| `src/lib/staff/active-role-views.ts` | create | `activeRoleViews(rows, now)` |
| `src/app/(staff)/staff/(dashboard)/users/active-role-views-panel.tsx` | create | readout panel |
| `src/app/(staff)/staff/(dashboard)/users/page.tsx` | modify | load columns, panel, role chip |
| docs (spec, guide, CLAUDE.md) | modify | Task 12 |

---

### Task 1: Migration 0187 + migration pin test + DB types

**Files:**
- Create: `supabase/migrations/0187_view_as_followups.sql`
- Create: `src/lib/auth/view-as-followups-migration.test.ts`
- Modify: `src/types/database.ts` (the `Functions:` block of `public`, alphabetical)

- [ ] **Step 1: Write the failing pin test**

```ts
// src/lib/auth/view-as-followups-migration.test.ts
// Reads migration 0187 as text (no database), like view-as-migration.test.ts.
// Pins what could drift silently between SQL and TS:
//   (a) the 4-hour duration in SQL equals VIEW_AS_DURATION_MS;
//   (b) the role list in view_as_transition equals VIEW_AS_ROLES;
//   (c) the trigger uses 0182's effective-override condition;
//   (d) the three functions are security definer + pinned search_path and are
//       closed to public/anon/authenticated, open to service_role;
//   (e) P0074 is the not-admin code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VIEW_AS_DURATION_MS, VIEW_AS_ROLES } from "./view-as";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0187_view_as_followups.sql"),
  "utf8",
);

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} not defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  return sql.slice(start, end);
}

describe("0187_view_as_followups.sql", () => {
  it("(a) duration matches VIEW_AS_DURATION_MS", () => {
    const m = fnBody("view_as_transition").match(/now\(\) \+ interval '(\d+) hours'/);
    expect(m, "interval 'N hours' missing").not.toBeNull();
    expect(Number(m![1]) * 60 * 60 * 1000).toBe(VIEW_AS_DURATION_MS);
  });

  it("(b) the accepted roles are exactly VIEW_AS_ROLES", () => {
    const m = fnBody("view_as_transition").match(/p_role not in \(([^)]+)\)/);
    expect(m, "p_role not in (...) missing").not.toBeNull();
    const roles = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
    expect(roles).toEqual([...VIEW_AS_ROLES].sort());
  });

  it("(c) the stamp trigger uses the effective-override condition", () => {
    const body = fnBody("audit_log_stamp_view_as");
    expect(body).toContain("role = 'admin'");
    expect(body).toContain("view_as_until > now()");
    expect(body).toContain("starts_with(new.action, 'staff.view_as.')");
    expect(sql).toMatch(/create trigger audit_log_stamp_view_as\s+before insert on public\.audit_log/);
  });

  it("(d) all three are security definer with a pinned search_path and closed ACLs", () => {
    for (const name of ["view_as_transition", "view_as_expire", "audit_log_stamp_view_as"]) {
      const body = fnBody(name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = public");
    }
    for (const sig of [
      "public.view_as_transition(uuid, text, inet, text)",
      "public.view_as_expire(uuid, inet, text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${sig} to service_role;`);
    }
    expect(sql).toContain(
      "revoke all on function public.audit_log_stamp_view_as() from public, anon, authenticated;",
    );
  });

  it("(e) not-admin raises P0074", () => {
    expect(fnBody("view_as_transition")).toContain("errcode = 'P0074'");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`ENOENT … 0187_view_as_followups.sql`)

Run: `npx vitest run src/lib/auth/view-as-followups-migration.test.ts`

- [ ] **Step 3: Write the migration**

```sql
-- =============================================================================
-- 0187_view_as_followups.sql
-- =============================================================================
-- Admin "View as role" follow-ups — spec:
--   docs/superpowers/specs/2026-09-28-view-as-followups-design.md
--
-- 1. view_as_transition(): start / switch / exit in ONE row-locked
--    transaction that also writes the staff.view_as.* audit rows. Before this,
--    the app updated the row and then audited from a request-time snapshot,
--    so two tabs could double-log one "ended" and lose another (Codex P2).
-- 2. view_as_expire(): the lazy "ended / reason expired" row, written by the
--    first request that finds an expired override still stored. Idempotent
--    under concurrency: the second caller re-checks the locked row and finds
--    nothing to do.
-- 3. audit_log_stamp_view_as: every staff audit row written while the actor
--    is simulating gets metadata.acting_as = <simulated role>. A trigger, not
--    src/lib/audit/log.ts, because SQL functions insert audit rows directly
--    (0167, 0173, 0179) and a TS-only stamp would miss them.
--
-- All three are service-role only; the app calls the two functions through
-- the service-role client (while simulating, has_role(array['admin']) is
-- false, so RLS would refuse the admin's own row — see 0182).

create or replace function public.view_as_transition(
  p_actor uuid,
  p_role  text default null,
  p_ip    inet default null,
  p_ua    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_role  text;
  v_old_until timestamptz;
  v_until     timestamptz;
begin
  select view_as_role, view_as_until
    into v_old_role, v_old_until
    from public.staff_profiles
   where id = p_actor
     and role = 'admin'
     and is_active = true
     and deleted_at is null
   for update;
  if not found then
    raise exception 'Only an admin can view the app as another role.'
      using errcode = 'P0074';
  end if;

  if p_role is not null
     and p_role not in ('reception', 'medtech', 'xray_technician', 'pathologist') then
    raise exception 'Unknown role.' using errcode = '22023';
  end if;

  -- Close whatever the row carried: an active override ended by this call,
  -- or one that had already run out and was never cleaned up.
  if v_old_role is not null then
    insert into public.audit_log (actor_id, actor_type, action, metadata, ip_address, user_agent)
    values (
      p_actor, 'staff', 'staff.view_as.ended',
      case
        when v_old_until > now() then
          jsonb_build_object('role', v_old_role,
                             'reason', case when p_role is null then 'manual' else 'switched' end)
        else
          jsonb_build_object('role', v_old_role, 'reason', 'expired', 'expired_at', v_old_until)
      end,
      p_ip, p_ua
    );
  end if;

  if p_role is null then
    update public.staff_profiles
       set view_as_role = null, view_as_until = null
     where id = p_actor;
    return jsonb_build_object('role', null, 'until', null);
  end if;

  v_until := now() + interval '4 hours';
  update public.staff_profiles
     set view_as_role = p_role, view_as_until = v_until
   where id = p_actor;
  insert into public.audit_log (actor_id, actor_type, action, metadata, ip_address, user_agent)
  values (p_actor, 'staff', 'staff.view_as.started',
          jsonb_build_object('role', p_role, 'until', v_until), p_ip, p_ua);
  return jsonb_build_object('role', p_role, 'until', v_until);
end;
$$;

comment on function public.view_as_transition(uuid, text, inet, text) is
  'Admin View-as start/switch (p_role) or exit (null). Locks the admin row, writes the override and the staff.view_as.* audit rows atomically. Service role only.';

create or replace function public.view_as_expire(
  p_actor uuid,
  p_ip    inet default null,
  p_ua    text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  text;
  v_until timestamptz;
begin
  -- FOR UPDATE re-checks the WHERE after waiting on a concurrent caller's
  -- lock, so only the first of two racing requests finds the stale row.
  select view_as_role, view_as_until
    into v_role, v_until
    from public.staff_profiles
   where id = p_actor
     and role = 'admin'
     and view_as_role is not null
     and view_as_until <= now()
   for update;
  if not found then
    return false;
  end if;

  update public.staff_profiles
     set view_as_role = null, view_as_until = null
   where id = p_actor;
  insert into public.audit_log (actor_id, actor_type, action, metadata, ip_address, user_agent)
  values (p_actor, 'staff', 'staff.view_as.ended',
          jsonb_build_object('role', v_role, 'reason', 'expired', 'expired_at', v_until),
          p_ip, p_ua);
  return true;
end;
$$;

comment on function public.view_as_expire(uuid, inet, text) is
  'Clears an admin''s EXPIRED View-as override and writes staff.view_as.ended reason=expired, once. No-op otherwise. Service role only.';

create or replace function public.audit_log_stamp_view_as()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if new.actor_type is distinct from 'staff'
     or new.actor_id is null
     or starts_with(new.action, 'staff.view_as.') then
    return new;
  end if;
  -- Merging into a non-object (array/scalar) would change its shape; none
  -- exist today, so leave such a row alone rather than rewrite it.
  if new.metadata is not null and jsonb_typeof(new.metadata) <> 'object' then
    return new;
  end if;
  -- Same effective-override condition as staff_role()/has_role() (0182).
  select view_as_role into v_role
    from public.staff_profiles
   where id = new.actor_id
     and role = 'admin'
     and view_as_until > now();
  if v_role is not null then
    new.metadata := coalesce(new.metadata, '{}'::jsonb)
                    || jsonb_build_object('acting_as', v_role);
  end if;
  return new;
end;
$$;

comment on function public.audit_log_stamp_view_as() is
  'BEFORE INSERT on audit_log: stamps metadata.acting_as on staff rows written while the actor is viewing the app as another role.';

drop trigger if exists audit_log_stamp_view_as on public.audit_log;
create trigger audit_log_stamp_view_as
  before insert on public.audit_log
  for each row execute function public.audit_log_stamp_view_as();

revoke all on function public.view_as_transition(uuid, text, inet, text) from public, anon, authenticated;
grant execute on function public.view_as_transition(uuid, text, inet, text) to service_role;
revoke all on function public.view_as_expire(uuid, inet, text) from public, anon, authenticated;
grant execute on function public.view_as_expire(uuid, inet, text) to service_role;
revoke all on function public.audit_log_stamp_view_as() from public, anon, authenticated;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.view_as_transition(uuid, text, inet, text)',
    'public.view_as_expire(uuid, inet, text)',
    'public.audit_log_stamp_view_as()'
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '0187: % must not be executable by anon/authenticated', v_fn;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.view_as_transition(uuid, text, inet, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.view_as_expire(uuid, inet, text)', 'EXECUTE') then
    raise exception '0187: service_role lost EXECUTE on a View-as function';
  end if;
end $$;
```

- [ ] **Step 4: Run the pin test — expect PASS**

Run: `npx vitest run src/lib/auth/view-as-followups-migration.test.ts`

- [ ] **Step 5: Apply locally (no reset) and confirm objects**

```sh
PSQL=/opt/homebrew/opt/libpq/bin/psql; DB=$(supabase status -o json | jq -r .DB_URL)
$PSQL "$DB" -Atc "select count(*) from information_schema.columns where table_name='staff_profiles' and column_name like 'view_as%'"   # 2, else apply 0182 first
$PSQL "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0187_view_as_followups.sql
$PSQL "$DB" -Atc "select proname from pg_proc where proname in ('view_as_transition','view_as_expire','audit_log_stamp_view_as') order by 1; select tgname from pg_trigger where tgname='audit_log_stamp_view_as'"
```
Expected: three function names and the trigger name. Applying twice must also succeed (idempotent) — run the `-f` line a second time.

- [ ] **Step 6: Add DB types**

In `src/types/database.ts`, inside `public` → `Functions`, add in alphabetical position (entries look like `result_mark_copy_contacted: { Args: {...}; Returns: string }`):

```ts
      view_as_expire: {
        Args: { p_actor: string; p_ip?: unknown; p_ua?: string }
        Returns: boolean
      }
      view_as_transition: {
        Args: { p_actor: string; p_ip?: unknown; p_role?: string; p_ua?: string }
        Returns: Json
      }
```
(`audit_log_stamp_view_as` is a trigger function; generated types omit those.)

- [ ] **Step 7: Commit**

```sh
git add supabase/migrations/0187_view_as_followups.sql src/lib/auth/view-as-followups-migration.test.ts src/types/database.ts
git commit -m "feat(view-as): 0187 atomic transition, lazy expiry, acting_as audit stamp"
```

---

### Task 2: DB smoke for 0187

**Files:** Create `supabase/tests/0187_view_as_followups_smoke.sql`

- [ ] **Step 1: Write the smoke script**

Model it on `supabase/tests/0182_staff_view_as_smoke.sql` (read its header, fixtures and `pg_temp.become/unbecome` helpers first; copy them). Use ids ending `…000000000187` and emails `smoke187-…@example.test`. Fixtures: admin A (`a0…187`, role admin), medtech M (`a2…187`). Runs inside `begin; … rollback;`. Helper to count audit rows:

```sql
create or replace function pg_temp.va_rows(who uuid)
returns table (action text, role text, reason text) language sql as $$
  select action, metadata->>'role', metadata->>'reason'
    from public.audit_log
   where actor_id = who and action like 'staff.view_as.%'
   order by id;
$$;
```

Then one `do $$ … $$` block with these probes, each raising a named exception on failure and a `raise notice 'Tn ok: …'` on success:

- **T1 ACLs:** `has_function_privilege` false for `anon` and `authenticated` on all three functions (signatures as in the migration); true for `service_role` on the two RPCs.
- **T2 start → switch → exit sequence:** as postgres call `view_as_transition(A,'reception')`, `view_as_transition(A,'medtech')`, `view_as_transition(A,null)`. `pg_temp.va_rows(A)` must equal exactly, in order: `(started,reception,null)`, `(ended,reception,switched)`, `(started,medtech,null)`, `(ended,medtech,manual)` (compare `array_agg(action||':'||coalesce(role,'')||':'||coalesce(reason,''))` to a literal array). Row A's columns are both null afterwards. The `started` rows' `metadata->>'until'` is non-null.
- **T3 double exit logs once:** delete A's `staff.view_as.%` rows (postgres can), call `view_as_transition(A,null)` twice → 0 rows (nothing active). Then start reception, exit, exit → exactly `started`, `ended:manual` (2 rows).
- **T4 start over an expired row:** `update staff_profiles set view_as_role='reception', view_as_until=now()-interval '1 minute' where id=A`; clear audit rows; `view_as_transition(A,'pathologist')` → rows `ended:reception:expired` (with `metadata ? 'expired_at'`) then `started:pathologist`.
- **T5 lazy expire idempotent:** set an expired override again; clear rows; `view_as_expire(A)` returns true, a second call returns false; exactly one `ended:…:expired` row; columns null. With an ACTIVE override (`until = now()+1h`), `view_as_expire(A)` returns false and leaves the columns set.
- **T6 non-admin:** `view_as_transition(M,'reception')` raises SQLSTATE `P0074` (catch with `exception when sqlstate 'P0074' then …`; if no exception, raise `'T6: non-admin accepted'`). Same for `view_as_transition(A,'admin')` → SQLSTATE `22023`.
- **T7 stamp trigger:** with A active as reception (`view_as_transition(A,'reception')`), `insert into audit_log (actor_id, actor_type, action, metadata) values (A,'staff','smoke.187.a','{"k":1}') returning metadata` → `metadata->>'acting_as' = 'reception'` and `metadata->>'k' = '1'`. Also insert with `metadata` null → `{"acting_as":"reception"}`. A `staff.view_as.smoke` action → no `acting_as`. `actor_type='patient'` with A's id → no `acting_as`. A non-object metadata `'[1]'` → unchanged `[1]`. Insert as M (not simulating) → no `acting_as`. Then `view_as_transition(A,null)` and insert again → no `acting_as`.
- **T8 stamp from an SQL-side writer as `authenticated`:** as A (`pg_temp.become(A)` after re-starting reception), call nothing new — instead verify the trigger fires regardless of inserter by inserting through a `security definer` pg_temp function owned by postgres (`create function pg_temp.definer_insert(who uuid) … security definer … insert into public.audit_log(actor_id, actor_type, action) values (who,'staff','smoke.187.definer')`, `grant execute … to authenticated`) and calling it while `become(A)`; the row carries `acting_as`.
- **T9 CONTROL (mutation):** `alter table public.audit_log disable trigger audit_log_stamp_view_as;` insert as in T7 → `acting_as` absent (proves T7 detects the trigger); `enable trigger` again.

Header comment: purpose, run command, list of T1–T9 (same style as 0182's).

Run command (put in the header too):
```sh
/opt/homebrew/opt/libpq/bin/psql "$(supabase status -o json | jq -r .DB_URL)" -v ON_ERROR_STOP=1 -f supabase/tests/0187_view_as_followups_smoke.sql
```

- [ ] **Step 2: Run it — expect all `Tn ok` notices and `ROLLBACK`**

- [ ] **Step 3: Mutation-check** (do not commit these edits; work on a scratch copy under the session scratchpad and apply it with psql): (a) change `'switched'` to `'manual'` in `view_as_transition` → T2 must fail; (b) change `view_as_until <= now()` to `view_as_until >= now()` in `view_as_expire` → T5 must fail; (c) re-apply the real migration file and re-run → green. Record the three outcomes in the commit message body.

- [ ] **Step 4: Commit**

```sh
git add supabase/tests/0187_view_as_followups_smoke.sql
git commit -m "test(view-as): 0187 DB smoke — transitions, lazy expiry, acting_as stamp"
```

---

### Task 3: Extend the 0182 smoke — Pathologist equivalence (P8) and an X-ray Claim write (P9)

**Files:** Modify `supabase/tests/0182_staff_view_as_smoke.sql`

Facts:
- `test_requests` UPDATE policy (0151, line ~1261): `has_role(ARRAY['medtech','pathologist','xray_technician'])` — check whether a later migration added more (grep `on public."test_requests"` / `on public.test_requests` for `for update` in later files) and note the effective set in the header.
- Claim = `update test_requests set status='in_progress', assigned_to=<me>, started_at=now() where id=… and status='requested'` (`src/app/(staff)/staff/(dashboard)/queue/actions.ts` `claimTestAction`).
- Fixture pattern for services/patients/visits/test_requests: `supabase/tests/0172_result_edit_commit_smoke.sql` lines 67–110 (copy column lists; x-ray service `section = 'imaging_xray'`, `kind = 'lab_test'`).

- [ ] **Step 1: Add fixtures** (inside the existing transaction, after current fixtures): a pathologist P (`a4000000-0000-4000-8000-000000000182`, auth.users + staff_profiles), one x-ray service, one patient, one visit (`payment_status 'paid'`), and two x-ray `test_requests` with `status 'requested'` (one for A-as-xray, one for genuine X).

- [ ] **Step 2: Add P8** — Pathologist equivalence. Pick a relation whose SELECT policy lets pathologist read but not reception (grep `has_role(array['pathologist', 'admin'])` → e.g. 0051/0137 tables; read the policy and insert one fixture row it covers). Assert: A-as-pathologist `staff_role() = 'pathologist'`; `lab_sections_for_role(staff_role())` equal for A-as-pathologist and genuine P; the fixture row count equal for both (1), and 0 for A-as-reception (the control that proves the probe discriminates). Raise `'P8: …'` on mismatch; notice `'P8 ok: pathologist equivalence'`.

- [ ] **Step 3: Add P9** — Claim write. A-as-xray_technician (`view_as_until = now()+4h`) runs the claim UPDATE on its line → `get diagnostics v_n = row_count` = 1 and the row now has `assigned_to = A`, `status = 'in_progress'`; genuine X on the other line → 1. Control: A-as-reception on a fresh `requested` x-ray line → 0 rows **if** reception has no UPDATE policy; if the grep in "Facts" shows reception can update, use A with NO override removed from the admin policy path instead — i.e. choose any effective role the policy refuses and state which in a comment. Notice `'P9 ok: X-ray claim write as A-as-xray'`.

- [ ] **Step 4: Run** the 0182 smoke (command in its header) → P1–P9 ok, ROLLBACK.

- [ ] **Step 5: Mutation-check** (not committed): set A's override to `medtech` instead of `xray_technician` for P9's first update, or drop the fixture row for P8 → the probe must fail. Revert. Note outcomes in the commit body.

- [ ] **Step 6: Commit**

```sh
git add supabase/tests/0182_staff_view_as_smoke.sql
git commit -m "test(view-as): 0182 smoke P8 pathologist equivalence + P9 x-ray claim write"
```

---

### Task 4: Pure helpers — `view-as.ts`, `view-as-return.ts`, `view-as-shell-sync.ts`

**Files:**
- Modify: `src/lib/auth/view-as.ts`, `src/lib/auth/view-as.test.ts`
- Create: `src/lib/auth/view-as-return.ts`, `src/lib/auth/view-as-return.test.ts`
- Create: `src/lib/auth/view-as-shell-sync.ts`, `src/lib/auth/view-as-shell-sync.test.ts`

- [ ] **Step 1: Failing tests**

Append to `src/lib/auth/view-as.test.ts` (keep its existing imports style):

```ts
import {
  expiryRefreshDelay,
  formatRemainingMs,
  hasStaleViewAs,
  viewAsStateKey,
} from "./view-as";

describe("formatRemainingMs", () => {
  it("formats hours+minutes, minutes, and the sub-minute floor", () => {
    expect(formatRemainingMs(3 * 3_600_000 + 40 * 60_000 + 59_000)).toBe("3h 40m");
    expect(formatRemainingMs(12 * 60_000)).toBe("12m");
    expect(formatRemainingMs(59_999)).toBe("under a minute");
    expect(formatRemainingMs(-5)).toBe("under a minute");
    expect(formatRemainingMs(Number.NaN)).toBe("under a minute");
  });
});

describe("expiryRefreshDelay", () => {
  it("fires one second after the server-side remaining time, never negative", () => {
    expect(expiryRefreshDelay(60_000)).toBe(61_000);
    expect(expiryRefreshDelay(0)).toBe(1_000);
    expect(expiryRefreshDelay(-30_000)).toBe(1_000);
  });
});

describe("hasStaleViewAs", () => {
  const now = new Date("2026-09-28T04:00:00.000Z");
  it("is true only for an admin row carrying an expired override", () => {
    expect(hasStaleViewAs({ role: "admin", view_as_role: "reception", view_as_until: "2026-09-28T03:59:59.000Z" }, now)).toBe(true);
    expect(hasStaleViewAs({ role: "admin", view_as_role: "reception", view_as_until: "2026-09-28T04:00:00.000Z" }, now)).toBe(true);
    expect(hasStaleViewAs({ role: "admin", view_as_role: "reception", view_as_until: "2026-09-28T05:00:00.000Z" }, now)).toBe(false);
    expect(hasStaleViewAs({ role: "admin", view_as_role: null, view_as_until: null }, now)).toBe(false);
    expect(hasStaleViewAs({ role: "medtech", view_as_role: "reception", view_as_until: "2026-09-28T03:00:00.000Z" }, now)).toBe(false);
  });
});

describe("viewAsStateKey", () => {
  it("changes with role and with until, and is stable for none", () => {
    expect(viewAsStateKey(null)).toBe("none");
    expect(viewAsStateKey({ role: "reception", until: "2026-09-28T08:00:00.000Z" })).toBe(
      "reception@2026-09-28T08:00:00.000Z",
    );
    expect(viewAsStateKey({ role: "reception", until: "2026-09-28T08:00:01.000Z" })).not.toBe(
      viewAsStateKey({ role: "reception", until: "2026-09-28T08:00:00.000Z" }),
    );
  });
});
```

`src/lib/auth/view-as-return.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./view-as-return";

describe("safeReturnTo", () => {
  it("keeps a page the new role's sidebar reaches, with its query, without hash", () => {
    expect(safeReturnTo("/staff/appointments?date=2026-09-28#x", "reception")).toBe(
      "/staff/appointments?date=2026-09-28",
    );
  });
  it("keeps detail pages under a reachable page (prefix match)", () => {
    expect(safeReturnTo("/staff/patients/abc", "reception")).toBe("/staff/patients/abc");
  });
  it("sends an admin-only page home for a non-admin role, keeps it for admin", () => {
    expect(safeReturnTo("/staff/users", "reception")).toBe("/staff");
    expect(safeReturnTo("/staff/users", "admin")).toBe("/staff/users");
  });
  it("always allows /staff", () => {
    expect(safeReturnTo("/staff", "xray_technician")).toBe("/staff");
  });
  it.each([
    ["//evil.example/staff"],
    ["https://evil.example/staff"],
    ["/staff\\evil"],
    ["/staffx"],
    ["/patients"],
    ["/staff/../patients"],
    ["/staff/%0d%0aSet-Cookie"],
    [""],
  ])("rejects %s", (raw) => {
    expect(safeReturnTo(raw, "admin")).toBe("/staff");
  });
  it("rejects non-strings", () => {
    expect(safeReturnTo(null, "admin")).toBe("/staff");
    expect(safeReturnTo(new File([], "x"), "admin")).toBe("/staff");
  });
});
```
(Before running, confirm `/staff/appointments` and `/staff/patients` are reception items and `/staff/users` is admin-only in `src/components/staff/staff-nav-config.ts`; if an href differs, use the real one — the assertion shape stays.)

`src/lib/auth/view-as-shell-sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkViewAsShell, shellIsStale } from "./view-as-shell-sync";

const ACTIVE = { role: "reception" as const, until: "2026-09-28T08:00:00.000Z" };

describe("shellIsStale", () => {
  it("is false when the server agrees (same instant, any precision)", () => {
    expect(shellIsStale(ACTIVE, { role: "reception", until: "2026-09-28T08:00:00.000Z" })).toBe(false);
    expect(shellIsStale(ACTIVE, { role: "reception", until: "2026-09-28T08:00:00+00:00" })).toBe(false);
    expect(shellIsStale(null, { role: null, until: null })).toBe(false);
  });
  it("is true on any difference or a malformed answer", () => {
    expect(shellIsStale(ACTIVE, { role: "medtech", until: ACTIVE.until })).toBe(true);
    expect(shellIsStale(ACTIVE, { role: "reception", until: "2026-09-28T09:00:00.000Z" })).toBe(true);
    expect(shellIsStale(ACTIVE, { role: null, until: null })).toBe(true);
    expect(shellIsStale(null, ACTIVE)).toBe(true);
    expect(shellIsStale(null, "nope")).toBe(true);
    expect(shellIsStale(null, null)).toBe(true);
  });
});

function fakeFetch(body: unknown, init: { ok?: boolean; type?: string; throws?: unknown } = {}) {
  return (async () => {
    if (init.throws) throw init.throws;
    return {
      ok: init.ok ?? true,
      headers: new Headers({ "content-type": init.type ?? "application/json" }),
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

describe("checkViewAsShell", () => {
  it("asks for a refresh only on mismatch", async () => {
    expect(await checkViewAsShell(ACTIVE, fakeFetch(ACTIVE))).toBe(false);
    expect(await checkViewAsShell(ACTIVE, fakeFetch({ role: null, until: null }))).toBe(true);
  });
  it("refreshes when the answer is not usable JSON (e.g. redirected to login)", async () => {
    expect(await checkViewAsShell(null, fakeFetch("<html>", { type: "text/html" }))).toBe(true);
    expect(await checkViewAsShell(null, fakeFetch({}, { ok: false }))).toBe(true);
    expect(await checkViewAsShell(null, fakeFetch(null, { throws: new TypeError("net") }))).toBe(true);
  });
  it("does nothing when aborted", async () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(await checkViewAsShell(null, fakeFetch(null, { throws: abort }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (missing exports/modules)

Run: `npx vitest run src/lib/auth/view-as.test.ts src/lib/auth/view-as-return.test.ts src/lib/auth/view-as-shell-sync.test.ts`

- [ ] **Step 3: Implement**

In `src/lib/auth/view-as.ts`, replace `formatRemaining` and add the rest:

```ts
/** "3h 40m" / "12m" / "under a minute". */
export function formatRemainingMs(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Server-side label from an ISO expiry. */
export function formatRemaining(untilIso: string, now: Date = new Date()): string {
  return formatRemainingMs(Date.parse(untilIso) - now.getTime());
}

/** Delay before the banner asks the server whether the override has ended:
 *  the server-computed remaining time plus 1s, so the server's strict
 *  `until > now()` is already false. Never below 1s (no hot loop). */
export function expiryRefreshDelay(remainingMs: number): number {
  return Math.max(remainingMs, 0) + 1_000;
}

/** An admin row still storing an override that has run out — the case the
 *  lazy `view_as_expire` cleanup (0187) exists for. */
export function hasStaleViewAs(profile: ViewAsColumns, now: Date = new Date()): boolean {
  return profile.role === "admin" && profile.view_as_role !== null && activeViewAs(profile, now) === null;
}

/** Identity of a View-as state; changes on every start/switch/exit. Used as a
 *  React key (reset the picker) and to close the mobile drawer. */
export function viewAsStateKey(v: ActiveViewAs | null): string {
  return v ? `${v.role}@${v.until}` : "none";
}

/** What the View-as Server Actions return to `useActionState`. */
export interface ViewAsActionState {
  error: string | null;
}
```

`src/lib/auth/view-as-return.ts`:

```ts
// Where a View-as switch/exit sends the admin: back to the page they were on
// when the NEW role's sidebar can reach it, else /staff. The value comes from
// a hidden form field, so it is attacker-controlled: safeRedirectPath() does
// the open-redirect checks (same rules as post-login), then a URL parse pins
// the origin, then the sidebar decides reachability. Pages no sidebar item
// owns fall back to /staff; every page's own server guard stays the backstop.
import { isSectionActive, visibleNavFor, type StaffRole } from "@/components/staff/staff-nav-config";
import { safeRedirectPath } from "./safe-redirect";

const HOME = "/staff";
const BASE = "https://x.invalid";

export function safeReturnTo(raw: unknown, role: StaffRole): string {
  if (typeof raw !== "string") return HOME;
  const checked = safeRedirectPath(raw);
  if (checked === HOME) return HOME;
  let url: URL;
  try {
    url = new URL(checked, BASE);
  } catch {
    return HOME;
  }
  if (url.origin !== BASE) return HOME;
  const { pathname, search } = url;
  if (pathname !== HOME && !pathname.startsWith(`${HOME}/`)) return HOME;
  if (pathname !== HOME && !visibleNavFor(role).some((s) => isSectionActive(s, pathname))) {
    return HOME;
  }
  return pathname + search;
}
```

(If `/staff/%0d%0aSet-Cookie` is not rejected by `safeRedirectPath` — it checks raw control characters, and `%0d` is encoded — it will still resolve to a pathname no sidebar owns and fall back to `/staff`; the test only asserts the result.)

`src/lib/auth/view-as-shell-sync.ts`:

```ts
// Client-safe. Decides whether an admin's staff shell (sidebar, banner,
// picker) is out of date with the database. Next caches the dashboard
// layout across client navigations, so a switch made on another device is
// invisible here until something refreshes it; a full router.refresh() on
// every navigation would double every page load, so ask a tiny endpoint first.
import { isViewAsRole, type ViewAsRole } from "./view-as";

export const VIEW_AS_STATE_URL = "/staff/view-as/state";

export interface ViewAsShellState {
  role: ViewAsRole;
  until: string;
}

export function shellIsStale(expected: ViewAsShellState | null, actual: unknown): boolean {
  if (!actual || typeof actual !== "object") return true;
  const a = actual as Record<string, unknown>;
  const role = isViewAsRole(a.role) ? a.role : null;
  const until = typeof a.until === "string" ? Date.parse(a.until) : null;
  if (!expected) return role !== null;
  return role !== expected.role || until !== Date.parse(expected.until);
}

/** true → the caller should router.refresh(). An aborted check is a no-op;
 *  any other failure (network, login redirect, non-JSON) refreshes, which is
 *  the safe direction: a refresh re-renders from the database. */
export async function checkViewAsShell(
  expected: ViewAsShellState | null,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetchImpl(VIEW_AS_STATE_URL, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return true;
    return shellIsStale(expected, await res.json());
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return false;
    return true;
  }
}
```

- [ ] **Step 4: Run — expect PASS** (same command as Step 2; also re-run `src/lib/auth/view-as-migration.test.ts`)

- [ ] **Step 5: Commit**

```sh
git add src/lib/auth/view-as.ts src/lib/auth/view-as.test.ts src/lib/auth/view-as-return.ts src/lib/auth/view-as-return.test.ts src/lib/auth/view-as-shell-sync.ts src/lib/auth/view-as-shell-sync.test.ts
git commit -m "feat(view-as): pure helpers — countdown, refresh delay, return-to, shell check"
```

---

### Task 5: Switch core on the RPC + lazy expiry in `requireSignedInStaff`

**Files:**
- Modify: `src/lib/auth/view-as-switch.ts`, `src/lib/auth/view-as-switch.test.ts`
- Modify: `src/lib/auth/require-staff.ts`

- [ ] **Step 1: Rewrite the test** (`src/lib/auth/view-as-switch.test.ts`) — the fake admin client now records `rpc` calls:

```ts
// src/lib/auth/view-as-switch.test.ts
// `npm test` has no database: the admin client is faked and records rpc()
// calls; all state + audit writes now happen inside view_as_transition /
// view_as_expire (0187), so TS must not call audit() at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  result: { data: null as unknown, error: null as { code?: string; message: string } | null },
  audits: 0,
  reported: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      fx.calls.push({ fn, args });
      return fx.result;
    },
  }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async () => { fx.audits++; } }));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (e: Record<string, unknown>) => { fx.reported.push(e); },
}));

const { startViewAs, exitViewAs, expireStaleViewAs } = await import("./view-as-switch");
import type { StaffSession } from "./require-staff";

const ctx = { ip: "10.0.0.1", ua: "vitest" };

function session(actual: StaffSession["role"] = "admin"): StaffSession {
  return { user_id: "admin-1", email: "a@x.test", full_name: "Ada", role: actual, actual_role: actual, view_as: null };
}

beforeEach(() => {
  fx.calls.length = 0;
  fx.reported.length = 0;
  fx.audits = 0;
  fx.result = { data: null, error: null };
});

describe("startViewAs", () => {
  it("calls view_as_transition with the role, ip and ua and returns the new role", async () => {
    fx.result = { data: { role: "reception", until: "2026-09-28T08:00:00+00:00" }, error: null };
    const r = await startViewAs(session(), "reception", ctx);
    expect(r).toEqual({ ok: true, role: "reception" });
    expect(fx.calls).toEqual([
      { fn: "view_as_transition", args: { p_actor: "admin-1", p_role: "reception", p_ip: "10.0.0.1", p_ua: "vitest" } },
    ]);
    expect(fx.audits).toBe(0);
  });
  it("refuses a non-admin and an unknown role without touching the database", async () => {
    expect(await startViewAs(session("medtech"), "reception", ctx)).toMatchObject({ ok: false });
    expect(await startViewAs(session(), "admin", ctx)).toEqual({ ok: false, error: "Unknown role." });
    expect(fx.calls).toHaveLength(0);
  });
  it("maps P0074 to the not-admin message and anything else to the generic one", async () => {
    fx.result = { data: null, error: { code: "P0074", message: "x" } };
    expect(await startViewAs(session(), "reception", ctx)).toEqual({
      ok: false, error: "Only an admin can view the app as another role.",
    });
    fx.result = { data: null, error: { code: "08006", message: "down" } };
    expect(await startViewAs(session(), "reception", ctx)).toEqual({
      ok: false, error: "Could not start viewing as another role.",
    });
  });
  it("omits null ip/ua instead of sending null", async () => {
    fx.result = { data: { role: "medtech", until: "x" }, error: null };
    await startViewAs(session(), "medtech", { ip: null, ua: null });
    expect(fx.calls[0].args).toEqual({ p_actor: "admin-1", p_role: "medtech" });
  });
});

describe("exitViewAs", () => {
  it("calls view_as_transition with no role", async () => {
    fx.result = { data: { role: null, until: null }, error: null };
    expect(await exitViewAs(session(), ctx)).toEqual({ ok: true, role: null });
    expect(fx.calls).toEqual([
      { fn: "view_as_transition", args: { p_actor: "admin-1", p_ip: "10.0.0.1", p_ua: "vitest" } },
    ]);
  });
  it("uses the actual role, so an admin viewing as reception can exit", async () => {
    const s = { ...session(), role: "reception" as const, view_as: { role: "reception" as const, until: "x" } };
    fx.result = { data: { role: null, until: null }, error: null };
    expect(await exitViewAs(s, ctx)).toEqual({ ok: true, role: null });
  });
  it("returns the exit error on failure", async () => {
    fx.result = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await exitViewAs(session(), ctx)).toEqual({ ok: false, error: "Could not exit the role view." });
  });
});

describe("expireStaleViewAs", () => {
  it("calls view_as_expire and never throws on error (reports instead)", async () => {
    await expireStaleViewAs("admin-1", ctx);
    expect(fx.calls).toEqual([{ fn: "view_as_expire", args: { p_actor: "admin-1", p_ip: "10.0.0.1", p_ua: "vitest" } }]);
    fx.result = { data: null, error: { message: "down" } };
    await expect(expireStaleViewAs("admin-1", ctx)).resolves.toBeUndefined();
    expect(fx.reported[0]).toMatchObject({ scope: "view-as.expire" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npx vitest run src/lib/auth/view-as-switch.test.ts`

- [ ] **Step 3: Implement** — replace the body of `src/lib/auth/view-as-switch.ts` below the imports:

```ts
// src/lib/auth/view-as-switch.ts
// Admin "View as role" — start / switch / exit / lazy expiry. Server-only;
// called by the Server Actions in app/(staff)/staff/(dashboard)/view-as/
// actions.ts and by requireSignedInStaff().
//
// Every state change and its staff.view_as.* audit rows happen inside one
// row-locked SQL call (0187 view_as_transition / view_as_expire), so two
// tabs can no longer double-log or lose an "ended" row. Guards on
// session.actual_role, never session.role: while simulating, `role` IS the
// simulated role, and an admin viewing as reception must still be able to
// exit. Service-role client because under the simulated role RLS would refuse
// the admin's own row; the SQL re-checks role = 'admin' under the row lock
// (P0074), so a wrong session still cannot put an override on anyone else.
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import type { StaffSession } from "./require-staff";
import { isViewAsRole, type ViewAsRole } from "./view-as";

export type ViewAsResult =
  | { ok: true; role: ViewAsRole | null }
  | { ok: false; error: string };

export interface ViewAsContext {
  ip: string | null;
  ua: string | null;
}

const NOT_ADMIN = "Only an admin can view the app as another role.";

function requestArgs(ctx: ViewAsContext) {
  return {
    ...(ctx.ip ? { p_ip: ctx.ip } : {}),
    ...(ctx.ua ? { p_ua: ctx.ua } : {}),
  };
}

async function transition(
  session: StaffSession,
  role: ViewAsRole | null,
  ctx: ViewAsContext,
  failure: string,
): Promise<ViewAsResult> {
  const { data, error } = await createAdminClient().rpc("view_as_transition", {
    p_actor: session.user_id,
    ...(role ? { p_role: role } : {}),
    ...requestArgs(ctx),
  });
  if (error) return { ok: false, error: error.code === "P0074" ? NOT_ADMIN : failure };
  const next = (data as { role?: unknown } | null)?.role;
  return { ok: true, role: isViewAsRole(next) ? next : null };
}

export async function startViewAs(
  session: StaffSession,
  role: unknown,
  ctx: ViewAsContext,
): Promise<ViewAsResult> {
  if (session.actual_role !== "admin") return { ok: false, error: NOT_ADMIN };
  if (!isViewAsRole(role)) return { ok: false, error: "Unknown role." };
  return transition(session, role, ctx, "Could not start viewing as another role.");
}

export async function exitViewAs(
  session: StaffSession,
  ctx: ViewAsContext,
): Promise<ViewAsResult> {
  if (session.actual_role !== "admin") return { ok: false, error: NOT_ADMIN };
  return transition(session, null, ctx, "Could not exit the role view.");
}

/** Lazy `staff.view_as.ended` reason=expired (0187 view_as_expire). Best
 *  effort: the session is already correct without it (an expired override
 *  is inert), so a failure is reported, never thrown. */
export async function expireStaleViewAs(userId: string, ctx: ViewAsContext): Promise<void> {
  const { error } = await createAdminClient().rpc("view_as_expire", {
    p_actor: userId,
    ...requestArgs(ctx),
  });
  if (error) {
    await reportError({
      scope: "view-as.expire",
      error: new Error(error.message),
      metadata: { userId },
    });
  }
}
```

- [ ] **Step 4: Wire lazy expiry into `requireSignedInStaff`** (`src/lib/auth/require-staff.ts`). Change the view-as import line to `import { activeViewAs, hasStaleViewAs, type ActiveViewAs } from "@/lib/auth/view-as";`, add `import { expireStaleViewAs } from "@/lib/auth/view-as-switch";`, and insert just before `const view_as = activeViewAs(profile);`:

```ts
  // An override that has run out but is still stored: clear it and write the
  // one "ended / expired" audit row (0187 view_as_expire — idempotent, so
  // concurrent requests log it once). Rare: only the first request after an
  // expiry gets here.
  if (hasStaleViewAs(profile)) {
    const h = await headers();
    await expireStaleViewAs(user.id, {
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      ua: h.get("user-agent"),
    });
  }
```

Check for an import cycle: `view-as-switch.ts` imports only the *type* `StaffSession` from `require-staff.ts` — keep it `import type`.

- [ ] **Step 5: Run** `npx vitest run src/lib/auth/` → all PASS. `npx tsc --noEmit 2>&1 | grep -E "view-as|require-staff"` → nothing (the actions file will error until Task 6 if it used `ctx.now`; it does not).

- [ ] **Step 6: Commit**

```sh
git add src/lib/auth/view-as-switch.ts src/lib/auth/view-as-switch.test.ts src/lib/auth/require-staff.ts
git commit -m "feat(view-as): switch via view_as_transition; lazy expired row in requireSignedInStaff"
```

---

### Task 6: Server Actions (error state, return-to) + state endpoint

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/view-as/actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/view-as/actions.test.ts`
- Create: `src/app/(staff)/staff/(dashboard)/view-as/state/route.ts`

- [ ] **Step 1: Failing action test**

```ts
// src/app/(staff)/staff/(dashboard)/view-as/actions.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  start: { ok: true, role: "reception" } as { ok: boolean; role?: string | null; error?: string },
  exit: { ok: true, role: null } as { ok: boolean; role?: string | null; error?: string },
  redirected: null as string | null,
  revalidated: [] as unknown[][],
  reported: [] as Record<string, unknown>[],
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => fx.revalidated.push(a) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    fx.redirected = to;
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({
    user_id: "admin-1", email: "", full_name: "Ada", role: "admin", actual_role: "admin", view_as: null,
  }),
}));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (e: Record<string, unknown>) => { fx.reported.push(e); },
}));
vi.mock("@/lib/auth/view-as-switch", () => ({
  startViewAs: async () => fx.start,
  exitViewAs: async () => fx.exit,
}));

const { startViewAsAction, exitViewAsAction } = await import("./actions");

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  fx.redirected = null;
  fx.revalidated.length = 0;
  fx.reported.length = 0;
  fx.start = { ok: true, role: "reception" };
  fx.exit = { ok: true, role: null };
});

describe("startViewAsAction", () => {
  it("on success revalidates the layout and returns to an allowed page", async () => {
    await expect(
      startViewAsAction({ error: null }, form({ role: "reception", return_to: "/staff/patients" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(fx.revalidated).toEqual([["/staff", "layout"]]);
    expect(fx.redirected).toBe("/staff/patients");
  });
  it("falls back to /staff for a page the new role cannot reach", async () => {
    await expect(
      startViewAsAction({ error: null }, form({ role: "reception", return_to: "/staff/users" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(fx.redirected).toBe("/staff");
  });
  it("on failure returns the error, reports it, and does not redirect", async () => {
    fx.start = { ok: false, error: "Could not start viewing as another role." };
    const state = await startViewAsAction({ error: null }, form({ role: "reception" }));
    expect(state).toEqual({ error: "Could not start viewing as another role." });
    expect(fx.redirected).toBeNull();
    expect(fx.reported[0]).toMatchObject({ scope: "view-as.start" });
  });
});

describe("exitViewAsAction", () => {
  it("returns to the page as admin", async () => {
    await expect(
      exitViewAsAction({ error: null }, form({ return_to: "/staff/users?q=a" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(fx.redirected).toBe("/staff/users?q=a");
  });
  it("on failure returns the error", async () => {
    fx.exit = { ok: false, error: "Could not exit the role view." };
    expect(await exitViewAsAction({ error: null }, form({}))).toEqual({ error: "Could not exit the role view." });
    expect(fx.redirected).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npx vitest run "src/app/(staff)/staff/(dashboard)/view-as/actions.test.ts"`

- [ ] **Step 3: Implement `actions.ts`**

```ts
"use server";

// Admin "View as role" — Server Actions, in the useActionState shape so the
// picker can show a pending state and an inline error (a failed switch used
// to redirect home silently). Success invalidates the staff layout — the
// sidebar, footer and banner live in the shared (dashboard)/layout.tsx that
// Next caches across client navigations — and returns the admin to the page
// they were on when the NEW role's sidebar reaches it (safeReturnTo), else
// /staff. Only types may be exported besides the async actions ("use server").
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { exitViewAs, startViewAs } from "@/lib/auth/view-as-switch";
import { safeReturnTo } from "@/lib/auth/view-as-return";
import type { ViewAsActionState } from "@/lib/auth/view-as";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { reportError } from "@/lib/observability/report-error";

export async function startViewAsAction(
  _prev: ViewAsActionState,
  formData: FormData,
): Promise<ViewAsActionState> {
  const session = await requireActiveStaff();
  const { ip, ua } = await ipAndAgent();
  const result = await startViewAs(session, formData.get("role"), { ip, ua });
  if (!result.ok) {
    await reportError({
      scope: "view-as.start",
      error: new Error(result.error),
      metadata: { userId: session.user_id, actual_role: session.actual_role },
    });
    return { error: result.error };
  }
  revalidatePath("/staff", "layout");
  redirect(safeReturnTo(formData.get("return_to"), result.role ?? session.actual_role));
}

export async function exitViewAsAction(
  _prev: ViewAsActionState,
  formData: FormData,
): Promise<ViewAsActionState> {
  const session = await requireActiveStaff();
  const { ip, ua } = await ipAndAgent();
  const result = await exitViewAs(session, { ip, ua });
  if (!result.ok) {
    await reportError({
      scope: "view-as.exit",
      error: new Error(result.error),
      metadata: { userId: session.user_id, actual_role: session.actual_role },
    });
    return { error: result.error };
  }
  revalidatePath("/staff", "layout");
  redirect(safeReturnTo(formData.get("return_to"), session.actual_role));
}
```

- [ ] **Step 4: Implement the state route**

```ts
// src/app/(staff)/staff/(dashboard)/view-as/state/route.ts
// The caller's own View-as state, for the shell-sync check in
// src/lib/auth/view-as-shell-sync.ts. requireActiveStaff() is the same
// session rule every page uses (and runs the lazy expiry cleanup), so this
// answer always matches what a full refresh would render.
import { NextResponse } from "next/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireActiveStaff();
  return NextResponse.json(
    { role: session.view_as?.role ?? null, until: session.view_as?.until ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
```

- [ ] **Step 5: Run** the action test → PASS. `npx tsc --noEmit 2>&1 | grep -E "view-as"` — the components still pass the old action signature to `<form action>`; errors in `view-as-select.tsx`/`view-as-banner.tsx` are expected and fixed in Tasks 7–8. No errors in `actions.ts`/`route.ts`.

- [ ] **Step 6: Commit**

```sh
git add "src/app/(staff)/staff/(dashboard)/view-as"
git commit -m "feat(view-as): actions return errors and go back to the page; GET view-as/state"
```

---

### Task 7: `ViewAsSelect` and `ViewAsExitButton` (pending, error, return_to)

**Files:**
- Modify: `src/components/staff/view-as-select.tsx`
- Create: `src/components/staff/view-as-exit-button.tsx`
- Modify: `src/components/staff/view-as-banner.test.tsx` (the `ViewAsSelect` describe + mocks)

- [ ] **Step 1: Update tests** — in `view-as-banner.test.tsx` change the actions mock to functions (a string cannot feed `useActionState`):

```ts
vi.mock("@/app/(staff)/staff/(dashboard)/view-as/actions", () => ({
  startViewAsAction: async () => ({ error: null }),
  exitViewAsAction: async () => ({ error: null }),
}));
```
Add `usePathname: () => "/staff"` to the `next/navigation` mock (Task 8's hook uses it). Replace every `action="/noop-…"` assertion with `name="return_to"` presence. Add to the `ViewAsSelect` describe:

```ts
  it("carries a hidden return_to field and no error by default", () => {
    const html = renderToStaticMarkup(<ViewAsSelect current={null} id="t" />);
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="return_to"');
    expect(html).not.toContain('role="alert"');
  });
```
And a new describe:

```ts
const { ViewAsExitButton } = await import("./view-as-exit-button");
describe("ViewAsExitButton", () => {
  it("renders an Exit submit with a hidden return_to", () => {
    const html = renderToStaticMarkup(<ViewAsExitButton />);
    expect(html).toContain(">Exit<");
    expect(html).toContain('name="return_to"');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npx vitest run src/components/staff/view-as-banner.test.tsx`

- [ ] **Step 3: Implement `view-as-select.tsx`**

```tsx
"use client";

// Admin "View as role" picker. Submits on change (needs JS; the <noscript>
// Go button covers the rest). useActionState gives a pending state (the
// select is disabled and says so) and an inline error — a failed switch no
// longer lands home silently. The hidden return_to is filled with the
// current page at submit time so the action can bring the admin back
// (safeReturnTo decides whether the new role may see it).
//
// Stale-picker fix (Codex P2): the parent renders this with
// key={viewAsStateKey(...)}, so a new server state remounts it and the
// uncontrolled <select> shows the role actually in force.
import { useActionState } from "react";
import { startViewAsAction } from "@/app/(staff)/staff/(dashboard)/view-as/actions";
import { VIEW_AS_ROLES, type ViewAsRole } from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";

interface Props {
  current: ViewAsRole | null;
  /** DOM id for the select (the shell renders up to three of these). */
  id: string;
  className?: string;
}

export function currentPageForReturn(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function ViewAsSelect({ current, id, className }: Props) {
  const [state, formAction, pending] = useActionState(startViewAsAction, { error: null });
  const errorId = `${id}-error`;
  return (
    <form action={formAction} className={className} aria-busy={pending}>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
      >
        View as
      </label>
      <input type="hidden" name="return_to" defaultValue="" />
      <select
        id={id}
        name="role"
        defaultValue={current ?? ""}
        disabled={pending}
        aria-describedby={state.error ? errorId : undefined}
        onChange={(e) => {
          const form = e.currentTarget.form;
          const rt = form?.elements.namedItem("return_to");
          if (rt instanceof HTMLInputElement) rt.value = currentPageForReturn();
          form?.requestSubmit();
        }}
        className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs disabled:opacity-60"
      >
        <option value="" disabled>
          View as…
        </option>
        {VIEW_AS_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      {pending && (
        <p className="mt-1 text-[11px] text-[color:var(--color-brand-text-soft)]">Switching…</p>
      )}
      {state.error && (
        <p id={errorId} role="alert" className="mt-1 text-[11px] text-red-700">
          {state.error}
        </p>
      )}
      <noscript>
        <button type="submit" className="mt-1 text-xs underline">
          Go
        </button>
      </noscript>
    </form>
  );
}
```

Note: a `disabled` select is excluded from FormData — safe here because `requestSubmit()` captures the form data before React re-renders with `pending = true`. Verify in the browser task (Task 13).

- [ ] **Step 4: Implement `view-as-exit-button.tsx`**

```tsx
"use client";

// Exit for the View-as banner: same pending/error/return_to pattern as
// ViewAsSelect. return_to is filled on click, before the form submits.
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { exitViewAsAction } from "@/app/(staff)/staff/(dashboard)/view-as/actions";
import { currentPageForReturn } from "./view-as-select";

export function ViewAsExitButton() {
  const [state, formAction, pending] = useActionState(exitViewAsAction, { error: null });
  return (
    <form action={formAction} aria-busy={pending} className="flex flex-col items-start">
      <input type="hidden" name="return_to" defaultValue="" />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={(e) => {
          const rt = e.currentTarget.form?.elements.namedItem("return_to");
          if (rt instanceof HTMLInputElement) rt.value = currentPageForReturn();
        }}
      >
        {pending ? "Exiting…" : "Exit"}
      </Button>
      {state.error && (
        <p role="alert" className="mt-1 text-[11px] text-red-700">
          {state.error}
        </p>
      )}
    </form>
  );
}
```
(If `Button` does not forward `onClick`'s `e.currentTarget` as an `HTMLButtonElement` with `.form`, cast: `(e.currentTarget as HTMLButtonElement).form`.)

- [ ] **Step 5: Run** the banner test (the `ViewAsBanner` describe may still fail until Task 8 — only the `ViewAsSelect`/`ViewAsExitButton` describes must pass now: `npx vitest run src/components/staff/view-as-banner.test.tsx -t "ViewAsSelect|ViewAsExitButton"`).

- [ ] **Step 6: Commit**

```sh
git add src/components/staff/view-as-select.tsx src/components/staff/view-as-exit-button.tsx src/components/staff/view-as-banner.test.tsx
git commit -m "feat(view-as): picker and Exit show pending + errors and carry return_to"
```

---

### Task 8: Banner countdown, server-clock expiry timer, shell sync, shell wiring

**Files:**
- Create: `src/components/staff/use-view-as-shell-sync.ts`
- Modify: `src/components/staff/view-as-banner.tsx`, `src/components/staff/view-as-banner.test.tsx`
- Modify: `src/components/staff/staff-shell.tsx` (+ `src/components/staff/staff-shell.test.tsx` if it asserts banner props/text)

- [ ] **Step 1: Update the banner test** — replace the `ViewAsBanner` describe:

```ts
describe("ViewAsBanner", () => {
  const html = renderToStaticMarkup(
    <ViewAsBanner
      role="reception"
      until="2026-09-25T08:00:00.000Z"
      untilLabel="4:00 PM"
      remainingMs={3 * 3_600_000 + 40 * 60_000}
    />,
  );
  it("names the role, the absolute end time and the time left, and warns about saves", () => {
    expect(html).toContain("Viewing as Reception");
    expect(html).toContain("until 4:00 PM");
    expect(html).toContain("3h 40m left");
    expect(html).toContain("Anything you save is recorded under your name.");
  });
  it("is a status region hidden on print, with Exit and a role select", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain("print:hidden");
    expect(html).toContain(">Exit<");
    expect(html).toContain('name="role"');
  });
  it("renders the time left from the server's remainingMs, not the device clock", () => {
    const skewed = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00Z"));
    const h = renderToStaticMarkup(
      <ViewAsBanner role="medtech" until="2026-09-25T08:00:00.000Z" untilLabel="4:00 PM" remainingMs={12 * 60_000} />,
    );
    expect(h).toContain("12m left");
    skewed.mockRestore();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npx vitest run src/components/staff/view-as-banner.test.tsx`

- [ ] **Step 3: Create the hook**

```ts
"use client";

// Keeps an admin's staff shell honest across devices/tabs (Codex P3). The
// dashboard layout is cached across client navigations, so a View-as switch
// made elsewhere would not show here. On every pathname change (not the first
// render) and whenever the tab becomes visible, ask the tiny state endpoint
// and router.refresh() only if the answer differs — never a blind refresh
// per navigation. Rendered only for admins (banner, or ViewAsShellSync).
import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { checkViewAsShell, type ViewAsShellState } from "@/lib/auth/view-as-shell-sync";

export function useViewAsShellSync(expected: ViewAsShellState | null) {
  const router = useRouter();
  const pathname = usePathname();
  const expectedRef = useRef(expected);
  const inflight = useRef<AbortController | null>(null);
  const firstPath = useRef(true);

  useEffect(() => {
    expectedRef.current = expected;
  });

  function check() {
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    void checkViewAsShell(expectedRef.current, fetch, ctl.signal).then((stale) => {
      if (stale && !ctl.signal.aborted) router.refresh();
    });
  }

  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per pathname by design
  }, [pathname]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      inflight.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check reads refs only
  }, [router]);
}
```
(If the repo's ESLint config flags `check` as used-before-defined or wants `useCallback`, hoist `check` into a `useCallback` with `[router]` deps — behaviour unchanged.)

- [ ] **Step 4: Rewrite `view-as-banner.tsx`**

```tsx
"use client";

// Admin "View as role" banner.
//   - "until 4:00 PM" is the server's Manila clock time; "3h 40m left" counts
//     down from the SERVER's remaining time using performance.now(), so a
//     wrong device clock can neither end it early nor freeze it (Codex P2).
//   - Just after the server's expiry the banner refreshes the route; the
//     refreshed render brings a new remainingMs, which re-arms the timer, so
//     an override that is still active never leaves a stuck banner.
//   - useViewAsShellSync picks up switches/exits made in another tab/device.
// Every server render and action uses the database's effective role, so a
// momentarily stale shell can mislead, never authorize.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { expiryRefreshDelay, formatRemainingMs, type ViewAsRole } from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";
import { ViewAsSelect } from "./view-as-select";
import { ViewAsExitButton } from "./view-as-exit-button";
import { useViewAsShellSync } from "./use-view-as-shell-sync";
import { viewAsStateKey } from "@/lib/auth/view-as";

const TICK_MS = 15_000;

interface Props {
  role: ViewAsRole;
  /** ISO-8601; identity of this override (shell-sync + picker key). */
  until: string;
  /** Server-formatted Manila clock time of `until`, e.g. "4:00 PM". */
  untilLabel: string;
  /** Server-computed ms until `until` at render time. */
  remainingMs: number;
}

function useCountdown(remainingMs: number): number {
  const [tick, setTick] = useState<{ base: number; elapsed: number } | null>(null);
  useEffect(() => {
    const start = performance.now();
    const id = setInterval(
      () => setTick({ base: remainingMs, elapsed: performance.now() - start }),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, [remainingMs]);
  return tick && tick.base === remainingMs ? remainingMs - tick.elapsed : remainingMs;
}

export function ViewAsBanner({ role, until, untilLabel, remainingMs }: Props) {
  const router = useRouter();
  useViewAsShellSync({ role, until });
  const left = useCountdown(remainingMs);
  useEffect(() => {
    const timer = setTimeout(() => router.refresh(), expiryRefreshDelay(remainingMs));
    return () => clearTimeout(timer);
  }, [remainingMs, router]);

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 print:hidden"
    >
      <p className="min-w-0 flex-1">
        <b>
          Viewing as {ROLE_LABEL[role]} until {untilLabel}
        </b>{" "}
        · {formatRemainingMs(left)} left. Anything you save is recorded under your name.
      </p>
      <ViewAsSelect key={viewAsStateKey({ role, until })} current={role} id="view-as-banner" className="w-44" />
      <ViewAsExitButton />
    </div>
  );
}

/** Headless: rendered for an admin with NO active override so a start made
 *  in another tab/device shows up here on the next navigation or focus. */
export function ViewAsShellSync() {
  useViewAsShellSync(null);
  return null;
}
```
(Merge the two `@/lib/auth/view-as` imports into one.) "under a minute left" reads fine; keep it.

- [ ] **Step 5: Wire `staff-shell.tsx`**

- Imports: replace `RefreshOnFocus` with `ViewAsShellSync`; replace `formatRemaining` import with `viewAsStateKey` from `@/lib/auth/view-as`; add `import { manilaTime } from "@/lib/dates/manila";`.
- Sidebar picker: add `key={viewAsStateKey(session.view_as)}` to the `<ViewAsSelect … id="view-as-sidebar" />`.
- Banner:

```tsx
        {session.view_as ? (
          <ViewAsBanner
            role={session.view_as.role}
            until={session.view_as.until}
            untilLabel={manilaTime(session.view_as.until)}
            remainingMs={Date.parse(session.view_as.until) - Date.now()}
          />
        ) : session.actual_role === "admin" ? (
          <ViewAsShellSync />
        ) : null}
```
If ESLint's React-purity rule rejects `Date.now()` in a server component render, compute `const remainingMs = …` via a tiny helper in `src/lib/auth/view-as.ts` — `export function remainingMsFrom(untilIso: string, now: Date = new Date()): number { return Date.parse(untilIso) - now.getTime(); }` — and call that (the repo does the same for `hasRecentAudit` in `action-helpers.ts`).

Grep for other users of `RefreshOnFocus`, `remainingLabel`, `formatRemaining(`: `grep -rn "RefreshOnFocus\|remainingLabel\|formatRemaining(" src` → update each (only `staff-shell.tsx` and tests expected).

- [ ] **Step 6: Run** `npx vitest run src/components/staff/` → PASS (fix `staff-shell.test.tsx` expectations if it asserted the old "Ends in" copy). `npx eslint src/components/staff/view-as-banner.tsx src/components/staff/use-view-as-shell-sync.ts src/components/staff/staff-shell.tsx src/components/staff/view-as-select.tsx src/components/staff/view-as-exit-button.tsx` → clean. `npx tsc --noEmit 2>&1 | grep -E "view-as|staff-shell"` → nothing.

- [ ] **Step 7: Commit**

```sh
git add src/components/staff src/lib/auth/view-as.ts
git commit -m "feat(view-as): banner shows until-time + server-clock countdown; shell sync on navigation"
```

---

### Task 9: Mobile drawer closes after a successful switch

**Files:**
- Modify: `src/components/staff/staff-mobile-nav-trigger.tsx`
- Modify: `src/components/staff/staff-mobile-nav-trigger.test.tsx`

- [ ] **Step 1: Read** `staff-mobile-nav-trigger.tsx` lines ~240–337 (the `open` state, `close`, how the hamburger opens the drawer, and the `ViewAsSelect` at ~326).

- [ ] **Step 2: Test** — add to the test file (static render: the drawer mock always renders children, so assert the picker is keyed/rendered with the current role and that the component still renders with an active `viewAs`):

```ts
describe("View-as in the drawer", () => {
  it("renders the picker preselected with the active role", () => {
    pathname.current = "/staff";
    const html = renderToStaticMarkup(
      <StaffMobileNavTrigger
        role="reception"
        actualRole="admin"
        viewAs={{ role: "reception", until: "2026-09-28T08:00:00.000Z" }}
        email="a@b.ph"
        fullName="Ada"
      />,
    );
    expect(html).toContain('id="view-as-drawer"');
    expect(html).toContain('name="return_to"');
  });
});
```
Also change this file's actions mock to functions returning `{ error: null }` (same as Task 7).

- [ ] **Step 3: Implement** — replace the boolean open state with "open for a View-as state":

```tsx
  // The drawer is open FOR a given View-as state. A successful switch
  // re-renders the shell with a new viewAs, so `open` turns false by itself —
  // no effect needed (Codex P2: the drawer used to stay open over the new
  // role). A failed switch keeps the same state, so the drawer stays open and
  // the picker's error stays visible.
  const stateKey = viewAsStateKey(viewAs);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === stateKey;
  const close = () => setOpenFor(null);
```
Replace every `setOpen(true)` with `setOpenFor(stateKey)` and any toggle `setOpen((o) => !o)` with `setOpenFor(open ? null : stateKey)`. Import `viewAsStateKey` from `@/lib/auth/view-as`. Give the drawer's picker `key={stateKey}`. Update the "Drawer closes via the per-link onClick" comment to mention the View-as case.

- [ ] **Step 4: Run** `npx vitest run src/components/staff/staff-mobile-nav-trigger.test.tsx` → PASS; eslint + tsc on the file clean.

- [ ] **Step 5: Commit**

```sh
git add src/components/staff/staff-mobile-nav-trigger.tsx src/components/staff/staff-mobile-nav-trigger.test.tsx
git commit -m "fix(view-as): mobile drawer closes once a switch lands, stays open on error"
```

---

### Task 10: "Active role views" on Staff Users

**Files:**
- Create: `src/lib/staff/active-role-views.ts`, `src/lib/staff/active-role-views.test.ts`
- Create: `src/app/(staff)/staff/(dashboard)/users/active-role-views-panel.tsx`, `…/users/active-role-views-panel.test.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/users/page.tsx`

- [ ] **Step 1: Failing tests**

```ts
// src/lib/staff/active-role-views.test.ts
import { describe, expect, it } from "vitest";
import { activeRoleViews } from "./active-role-views";

const now = new Date("2026-09-28T04:00:00.000Z");
const row = (id: string, o: Partial<{ role: string; view_as_role: string | null; view_as_until: string | null; deleted_at: string | null }>) => ({
  id, full_name: `N-${id}`, role: "admin", view_as_role: null, view_as_until: null, deleted_at: null, ...o,
});

describe("activeRoleViews", () => {
  it("lists only admins with an active override, soonest ending first", () => {
    const out = activeRoleViews(
      [
        row("a", { view_as_role: "reception", view_as_until: "2026-09-28T07:00:00.000Z" }),
        row("b", { view_as_role: "medtech", view_as_until: "2026-09-28T05:00:00.000Z" }),
        row("c", { view_as_role: "reception", view_as_until: "2026-09-28T03:00:00.000Z" }),
        row("d", { role: "medtech", view_as_role: "reception", view_as_until: "2026-09-28T07:00:00.000Z" }),
        row("e", { view_as_role: "reception", view_as_until: "2026-09-28T07:00:00.000Z", deleted_at: "2026-09-01T00:00:00Z" }),
        row("f", {}),
      ],
      now,
    );
    expect(out.map((v) => [v.id, v.role])).toEqual([["b", "medtech"], ["a", "reception"]]);
    expect(out[0]).toMatchObject({ full_name: "N-b", until: "2026-09-28T05:00:00.000Z" });
  });
});
```

```tsx
// src/app/(staff)/staff/(dashboard)/users/active-role-views-panel.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveRoleViewsPanel } from "./active-role-views-panel";

describe("ActiveRoleViewsPanel", () => {
  const now = new Date("2026-09-28T04:00:00.000Z");
  it("lists who is viewing as what, until when, and time left", () => {
    const html = renderToStaticMarkup(
      <ActiveRoleViewsPanel
        now={now}
        views={[{ id: "a", full_name: "Ada Admin", role: "reception", until: "2026-09-28T07:40:00.000Z" }]}
      />,
    );
    expect(html).toContain("Active role views");
    expect(html).toContain("Ada Admin");
    expect(html).toContain("Reception");
    expect(html).toContain("3:40 PM"); // 07:40Z = 15:40 Manila
    expect(html).toContain("3h 40m left");
  });
  it("says so when nobody is viewing as another role", () => {
    const html = renderToStaticMarkup(<ActiveRoleViewsPanel now={now} views={[]} />);
    expect(html).toContain("No one is viewing the app as another role.");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```ts
// src/lib/staff/active-role-views.ts
// Who is currently using admin "View as role" — for the Staff Users readout.
// Same rule as the session and RLS (activeViewAs): admin row, future expiry.
import { activeViewAs, type ViewAsRole } from "@/lib/auth/view-as";

export interface ActiveRoleView {
  id: string;
  full_name: string;
  role: ViewAsRole;
  until: string;
}

interface Row {
  id: string;
  full_name: string;
  role: string;
  view_as_role: string | null;
  view_as_until: string | null;
  deleted_at: string | null;
}

export function activeRoleViews(rows: Row[], now: Date = new Date()): ActiveRoleView[] {
  const out: ActiveRoleView[] = [];
  for (const r of rows) {
    if (r.deleted_at !== null) continue;
    const v = activeViewAs(r, now);
    if (v) out.push({ id: r.id, full_name: r.full_name, role: v.role, until: v.until });
  }
  return out.sort((a, b) => Date.parse(a.until) - Date.parse(b.until));
}
```

```tsx
// src/app/(staff)/staff/(dashboard)/users/active-role-views-panel.tsx
// Admin-only readout (the page is behind requireAdminStaff): which admins are
// viewing the app as another role right now, and until when (Manila time).
import { Panel } from "@/components/ui/panel";
import { formatRemaining } from "@/lib/auth/view-as";
import { manilaTime } from "@/lib/dates/manila";
import { ROLE_LABEL } from "@/lib/staff/role-labels";
import type { ActiveRoleView } from "@/lib/staff/active-role-views";

export function ActiveRoleViewsPanel({ views, now }: { views: ActiveRoleView[]; now: Date }) {
  return (
    <Panel>
      <h2 className="text-sm font-bold text-[color:var(--color-brand-navy)]">Active role views</h2>
      {views.length === 0 ? (
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          No one is viewing the app as another role.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {views.map((v) => (
            <li key={v.id}>
              <b>{v.full_name}</b> is viewing as {ROLE_LABEL[v.role]} until {manilaTime(v.until)} (
              {formatRemaining(v.until, now)} left)
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
```
Check `Panel`'s props in `src/components/ui/panel.tsx` first (it may take `title`/`className`); use its heading prop if it has one instead of the `<h2>`, and keep the test strings.

- [ ] **Step 4: Wire the page** — in `users/page.tsx`: find the `staff_profiles` select; add `view_as_role, view_as_until` to it and to `StaffRow` (`view_as_role: string | null; view_as_until: string | null;`). After rows load: `const now = new Date(); const roleViews = activeRoleViews(rows, now);` (pass the unfiltered, non-deleted set — before search/role filters, so the readout is not hidden by a filter). Render `<ActiveRoleViewsPanel views={roleViews} now={now} />` directly above the "Existing users" table panel. In the role cell, after the role label, when `roleViews.find((v) => v.id === row.id)` exists render:

```tsx
<span className="ml-2 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
  Viewing as {ROLE_LABEL[view.role]}
</span>
```
(Build a `Map` by id once rather than `find` per row.) If `new Date()` in render trips the purity lint, reuse the pattern already used in this file for time (it calls `relativeSignIn`) or pass `now` from a helper.

- [ ] **Step 5: Run** the two tests + `npx vitest run "src/app/(staff)/staff/(dashboard)/users"` → PASS; eslint + tsc on touched files clean.

- [ ] **Step 6: Commit**

```sh
git add src/lib/staff/active-role-views.ts src/lib/staff/active-role-views.test.ts "src/app/(staff)/staff/(dashboard)/users"
git commit -m "feat(view-as): Active role views readout and chip on Staff Users"
```

---

### Task 11: Full test/lint/type sweep

- [ ] **Step 1:** `npx vitest run 2>&1 | tail -20` → all pass. Any failure in a file this branch did not touch: check it also fails on `origin/main` (`git stash` is shared — instead run it in a scratch worktree of origin/main) before calling it pre-existing.
- [ ] **Step 2:** `npx eslint $(git diff --name-only origin/main -- '*.ts' '*.tsx')` → clean.
- [ ] **Step 3:** `npx tsc --noEmit 2>&1 | grep -E "$(git diff --name-only origin/main -- '*.ts' '*.tsx' | sed 's/[()]/./g' | paste -sd'|' -)"` → nothing.
- [ ] **Step 4:** `npm run build 2>&1 | tail -30` → success (catches the `"use server"` non-async-export trap).
- [ ] **Step 5:** Re-run both smoke scripts (0182, 0187) against the local DB (check columns first — sibling resets).
- [ ] **Step 6:** Commit any fixes: `git commit -m "chore(view-as): sweep fixes"`.

---

### Task 12: Docs — parent spec, user guide, CLAUDE.md

**Files:**
- Modify: `docs/superpowers/specs/2026-09-25-staff-view-as-role-design.md` (line ~190)
- Modify: `docs/drmed-user-guide.html`
- Modify: `CLAUDE.md` (migration ledger, line ~28)

- [ ] **Step 1: Parent spec** — replace `Expiry writes no event; \`started\` already carries \`until\`.` with: `Expiry writes \`staff.view_as.ended\` with \`reason: "expired"\` lazily — on the first request after the expiry, or on the next start/exit, whichever comes first (0187, follow-ups spec 2026-09-28). \`started\` carries \`until\`.` Also note in that spec's audit section that ordinary audit rows written during a simulation carry \`metadata.acting_as\`.

- [ ] **Step 2: Guide §5.8 "Seeing the app as another role"** (around line 1157). Update to describe: the banner shows "until <time>" and the time left, counting down; switching or exiting brings you back to the page you were on when the new role can use it, otherwise to the dashboard; if a switch fails you see a message under the picker and nothing changes; on a phone the menu closes once the switch lands; when a view runs out, the app records that it ended ("expired") the next time you load a page; everything you do while viewing as another role is recorded under your name *and* tagged with the role you were viewing as; admins can see who is viewing as another role under Staff Users → "Active role views". Plain English, match the guide's voice (read two neighbouring sections first).

- [ ] **Step 3: Fix the duplicate 5.8** — the "Books, payroll and marketing (orientation)" section (~line 1135) and "Seeing the app as another role" (~1157) are both 5.8. Renumber the View-as section to the next free number in chapter 5 and shift any later chapter-5 sections; update the table of contents and any in-text "see 5.x" references (`grep -n "5\.[0-9]" docs/drmed-user-guide.html`).

- [ ] **Step 4: Bump the version** — `grep -n "v2\.[0-9][0-9]" docs/drmed-user-guide.html`; take the next number after the highest on `origin/main` at this moment (`git fetch -q && git show origin/main:docs/drmed-user-guide.html | grep -o "v2\.[0-9]*" | sort -V | tail -1`), expected **v2.33**. Update both the TOC tag and the footer line; footer date `28 September 2026` (or today) and add `0187 (View-as follow-ups)` to the migration list in the footer sentence.

- [ ] **Step 5: CLAUDE.md ledger** — leave for the controller at merge time (the PR number is not known yet). Do not edit.

- [ ] **Step 6: Commit**

```sh
git add docs/superpowers/specs/2026-09-25-staff-view-as-role-design.md docs/drmed-user-guide.html
git commit -m "docs(view-as): guide v2.33 §View-as follow-ups, fix duplicate 5.8, spec expiry rule"
```

---

### Task 13: Browser verification (controller, local)

Controller runs this (Playwright MCP, text-first; screenshots only to confirm a visual result). Local admin: `npm run seed:services && npm run seed:test` → `admin@drmed.ph / AdminPass123!`. Dev server: `npx next dev -p 3010` (3000 is often taken). Check the 0182 + 0187 objects exist locally first.

Checklist:
1. Start "Reception" from the sidebar on `/staff/patients` → lands back on `/staff/patients`; banner "Viewing as Reception until <time> · 3h 59m left"; sidebar picker shows Reception.
2. Switch to Medical Tech from the banner on `/staff/patients` → if medtech's sidebar lacks Patients, lands on `/staff`; picker shows Medical Tech (Codex #1).
3. Re-pick in the sidebar after a switch → select shows the current role (no stale value).
4. Exit from `/staff/appointments` (as Reception) → back on `/staff/appointments` as admin.
5. Start from `/staff/users` → lands on `/staff` (admin-only page).
6. Forced failure: with the dev server running, temporarily revoke `execute on view_as_transition from service_role` in the local DB, pick a role → inline "Could not start viewing as another role." with no navigation; re-grant.
7. Phone width (390px): open drawer, pick a role → drawer closes and the banner shows the new role. With the revoke from (6) → drawer stays open showing the error.
8. Two tabs: tab A on `/staff`, tab B starts Reception; in tab A click a sidebar link → shell updates to Reception without a manual reload (network: one `GET /staff/view-as/state` then a refresh). With no change, a navigation makes only the state request.
9. Expiry: set `view_as_until = now() + interval '70 seconds'` locally, reload; wait → banner disappears ~1s after the time; `audit_log` has exactly one `staff.view_as.ended` with `reason: expired`.
10. While viewing as Reception, do an audited action (e.g. open a patient record or record a payment in the test visit) → that `audit_log` row's `metadata.acting_as = 'reception'`; after exit, the same action has no `acting_as`.
11. `/staff/users` as admin while another admin row (set via SQL) is viewing as X-ray → panel lists it with time and chip in the table.
12. `audit_log` rows for the whole session: every start/switch/exit logged once, in order.

Record PASS/FAIL per item in the PR description.

---

## After the plan (controller, not subagents)

1. `/codex-review astra high` (recheck session `01a0e5d0-b801-71f3-8214-4872eb37e8c6`; prior report `/var/folders/6j/24mb579n103fwqy04bct5djr0000gn/T/codex-review-JuOABN/review.md`); fix real findings.
2. Open the PR; re-run the open-branch migration-number check right before push (0187 must still be free).
3. `supabase db push --include-all --dry-run` then real push from this worktree right before merge; verify on prod by object (3 functions, trigger, ACLs, ledger has 0187).
4. Update CLAUDE.md ledger line with 0187 + PR number; merge; confirm the Vercel production deploy.

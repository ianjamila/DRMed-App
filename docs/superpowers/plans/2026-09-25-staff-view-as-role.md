# Staff "View as role" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin on `/staff` view and use the app as Reception, Medical Tech, X-ray Technician or Pathologist without a second login, with the app layer and row-level security agreeing on the simulated role.

**Architecture:** Two nullable columns on the admin's own `staff_profiles` row (`view_as_role`, `view_as_until`). Migration 0182 redefines the two RLS caller-identity helpers `staff_role()` / `has_role(text[])` to answer with the *effective* role (override while real role is admin and expiry is in the future). The session loader computes the same effective role with a pure TS helper, so all ~170 existing `session.role` checks follow the simulation with no edits. Two server actions (start/exit) write the columns through the service-role client and audit under the admin's real identity. A client banner keeps the cached shell in step with the database (refresh at expiry and on tab focus).

**Tech Stack:** Next.js 16 App Router (server components + Server Actions), Supabase (Postgres RLS, `supabase gen types`), vitest + `react-dom/server` `renderToStaticMarkup` for component tests, zod, plain SQL smoke test run with `psql` against the local stack.

**Spec:** `docs/superpowers/specs/2026-09-25-staff-view-as-role-design.md` (Codex Astra plan review applied).

**Branch:** `feat/staff-view-as-role` (already created from `origin/main`; spec commits are on it). **Migration number 0182 is claimed** (`npm run claim -- list` shows it). No P-code is needed (the migration's `raise exception` guards run once at apply time, not at runtime).

**Project rules that apply** (from `~/Claude/DRMed/CLAUDE.md` / AGENTS.md and memory):
- Read `node_modules/next/dist/docs/` before using a Next API you are unsure of; this Next version differs from training data.
- `psql` is at `/opt/homebrew/opt/libpq/bin/psql`; local DB URL `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. **Never `supabase db reset`** — the local stack is shared across worktrees; apply the migration file with `psql -f` instead.
- `npm test` = `vitest run` (no database). Typecheck: `npx tsc --noEmit`. Lint: `npm run lint`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Sandbox shell is zsh: never name a variable `path`; `python3` heredocs are killed; use `node -e` for scripted edits.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/auth/view-as.ts` (new) | Pure rules: allowed roles, duration, `activeViewAs()`, `effectiveRole()`, `formatRemaining()`. No server-only imports (used by client banner too). |
| `src/lib/auth/view-as.test.ts` (new) | Pins the TS rule. |
| `supabase/migrations/0182_staff_view_as_role.sql` (new) | Columns, constraints, helper redefinition, ACL assertions. |
| `src/lib/auth/view-as-migration.test.ts` (new) | Text-pins 0182 to the TS constants. |
| `src/types/database.ts` (modify) | Two new columns on `staff_profiles` Row/Insert/Update. |
| `src/lib/auth/require-staff.ts` (modify) | Selects the columns; `StaffSession` gains `actual_role` + `view_as`. |
| `src/lib/staff/role-labels.ts` (new) | Single `ROLE_LABEL` (replaces two duplicates). |
| `src/components/staff/staff-shell.tsx`, `staff-mobile-nav-trigger.tsx` (modify) | Import `ROLE_LABEL`; footer select; banner; props. |
| `src/lib/auth/view-as-switch.ts` (new, server-only) | `startViewAs()` / `exitViewAs()` core: guard, DB write, audit. |
| `src/lib/auth/view-as-switch.test.ts` (new) | Core tests with faked admin client + audit. |
| `src/app/(staff)/staff/(dashboard)/view-as/actions.ts` (new) | `"use server"` wrappers: core → revalidate layout → redirect. |
| `src/components/staff/view-as-select.tsx` (new, client) | Role `<select>` that submits `startViewAsAction` on change. |
| `src/components/staff/view-as-banner.tsx` (new, client) | Amber banner + Exit + select; refresh at expiry / on focus. `RefreshOnFocus` headless sibling. |
| `src/components/staff/view-as-banner.test.tsx`, `staff-shell.test.tsx` (new), `staff-mobile-nav-trigger.test.tsx` (extend) | Markup tests. |
| `supabase/tests/0182_staff_view_as_smoke.sql` (new) | DB proof with control, BEGIN/ROLLBACK. |
| `docs/drmed-user-guide.html` (modify) | New Admin sub-section; version bump to v2.27. |

---

### Task 1: Pure view-as rules (`view-as.ts`)

**Files:**
- Create: `src/lib/auth/view-as.ts`
- Test: `src/lib/auth/view-as.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth/view-as.test.ts
import { describe, expect, it } from "vitest";
import {
  VIEW_AS_ROLES,
  VIEW_AS_DURATION_MS,
  activeViewAs,
  effectiveRole,
  formatRemaining,
  isViewAsRole,
} from "./view-as";

const NOW = new Date("2026-09-25T04:00:00.000Z");
const FUTURE = "2026-09-25T07:40:00.000Z"; // 3h40m later
const PAST = "2026-09-25T03:59:59.000Z";

describe("VIEW_AS_ROLES", () => {
  it("is exactly the four non-admin staff roles", () => {
    expect([...VIEW_AS_ROLES].sort()).toEqual(
      ["medtech", "pathologist", "reception", "xray_technician"].sort(),
    );
    expect(VIEW_AS_DURATION_MS).toBe(4 * 60 * 60 * 1000);
  });
  it("isViewAsRole accepts only those", () => {
    expect(isViewAsRole("reception")).toBe(true);
    expect(isViewAsRole("admin")).toBe(false);
    expect(isViewAsRole("")).toBe(false);
    expect(isViewAsRole(null)).toBe(false);
  });
});

describe("activeViewAs / effectiveRole", () => {
  it("admin + future expiry → override", () => {
    const p = { role: "admin", view_as_role: "reception", view_as_until: FUTURE };
    expect(activeViewAs(p, NOW)).toEqual({ role: "reception", until: FUTURE });
    expect(effectiveRole(p, NOW)).toBe("reception");
  });
  it("admin + past expiry → admin", () => {
    const p = { role: "admin", view_as_role: "reception", view_as_until: PAST };
    expect(activeViewAs(p, NOW)).toBeNull();
    expect(effectiveRole(p, NOW)).toBe("admin");
  });
  it("admin + expiry exactly now → admin (strict >)", () => {
    const p = { role: "admin", view_as_role: "medtech", view_as_until: NOW.toISOString() };
    expect(effectiveRole(p, NOW)).toBe("admin");
  });
  it("non-admin with override columns set → real role", () => {
    const p = { role: "medtech", view_as_role: "reception", view_as_until: FUTURE };
    expect(activeViewAs(p, NOW)).toBeNull();
    expect(effectiveRole(p, NOW)).toBe("medtech");
  });
  it("nulls → real role", () => {
    const p = { role: "admin", view_as_role: null, view_as_until: null };
    expect(activeViewAs(p, NOW)).toBeNull();
    expect(effectiveRole(p, NOW)).toBe("admin");
  });
  it("an unknown stored role (e.g. admin) is ignored", () => {
    const p = { role: "admin", view_as_role: "admin", view_as_until: FUTURE };
    expect(effectiveRole(p, NOW)).toBe("admin");
  });
  it("+08:00 and UTC spellings of the same instant agree", () => {
    const manila = { role: "admin", view_as_role: "reception", view_as_until: "2026-09-25T15:40:00+08:00" };
    const utc = { role: "admin", view_as_role: "reception", view_as_until: FUTURE };
    expect(activeViewAs(manila, NOW)?.until).toBe(activeViewAs(utc, NOW)?.until);
    expect(activeViewAs(manila, NOW)?.until).toBe(FUTURE);
  });
});

describe("formatRemaining", () => {
  it("hours and minutes", () => {
    expect(formatRemaining(FUTURE, NOW)).toBe("3h 40m");
  });
  it("minutes only", () => {
    expect(formatRemaining("2026-09-25T04:12:00.000Z", NOW)).toBe("12m");
  });
  it("under a minute, and never negative", () => {
    expect(formatRemaining("2026-09-25T04:00:30.000Z", NOW)).toBe("under a minute");
    expect(formatRemaining(PAST, NOW)).toBe("under a minute");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/view-as.test.ts`
Expected: FAIL — `Cannot find module './view-as'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/auth/view-as.ts
// Admin "View as role" — the pure rules shared by the session loader (server),
// the switch actions (server) and the banner (client). No server-only imports.
//
// Mirrors the SQL CASE in supabase/migrations/0182_staff_view_as_role.sql:
//   when role = 'admin' and view_as_until > now() then view_as_role else role
// view-as-migration.test.ts pins the two to each other.
import type { StaffSession } from "./require-staff";

export const VIEW_AS_ROLES = [
  "reception",
  "medtech",
  "xray_technician",
  "pathologist",
] as const;
export type ViewAsRole = (typeof VIEW_AS_ROLES)[number];

/** How long an override lasts. Owner decision 2026-09-25: 4 hours. */
export const VIEW_AS_DURATION_MS = 4 * 60 * 60 * 1000;

export interface ViewAsColumns {
  role: string;
  view_as_role: string | null;
  view_as_until: string | null;
}

export interface ActiveViewAs {
  role: ViewAsRole;
  /** ISO-8601 UTC. */
  until: string;
}

export function isViewAsRole(value: unknown): value is ViewAsRole {
  return typeof value === "string" && (VIEW_AS_ROLES as readonly string[]).includes(value);
}

/** The override that is in force right now, or null. Only an admin row can
 *  carry one; the expiry check is strict (an expiry equal to `now` is over). */
export function activeViewAs(profile: ViewAsColumns, now: Date = new Date()): ActiveViewAs | null {
  if (profile.role !== "admin") return null;
  if (!isViewAsRole(profile.view_as_role) || !profile.view_as_until) return null;
  const until = Date.parse(profile.view_as_until);
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  return { role: profile.view_as_role, until: new Date(until).toISOString() };
}

/** The role every page should behave as. */
export function effectiveRole(profile: ViewAsColumns, now: Date = new Date()): StaffSession["role"] {
  return (activeViewAs(profile, now)?.role ?? profile.role) as StaffSession["role"];
}

/** "3h 40m" / "12m" / "under a minute" — rendered server-side in the banner. */
export function formatRemaining(untilIso: string, now: Date = new Date()): string {
  const ms = Date.parse(untilIso) - now.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/view-as.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/view-as.ts src/lib/auth/view-as.test.ts
git commit -m "feat(auth): pure view-as role rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0182 + text-pinned migration test

**Files:**
- Create: `supabase/migrations/0182_staff_view_as_role.sql`
- Test: `src/lib/auth/view-as-migration.test.ts`
- Modify: `src/types/database.ts` (staff_profiles Row/Insert/Update, around line 5425)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth/view-as-migration.test.ts
// Reads migration 0182 as text, without a database (same reasoning as
// result-edit-migration.test.ts). Pins what could drift silently:
//   (a) the allowed override roles = VIEW_AS_ROLES;
//   (b) exactly staff_role() and has_role() are redefined, is_staff() is not;
//   (c) both keep STABLE / SECURITY DEFINER / search_path and carry the
//       effective-role CASE that view-as.ts mirrors;
//   (d) the migration asserts anon + authenticated EXECUTE on all three helpers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VIEW_AS_ROLES } from "./view-as";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0182_staff_view_as_role.sql"),
  "utf8",
);

const CASE = "when role = 'admin' and view_as_until > now() then view_as_role";

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} not redefined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  return sql.slice(start, end);
}

describe("0182_staff_view_as_role.sql", () => {
  it("(a) the role check constraint lists exactly VIEW_AS_ROLES", () => {
    const m = sql.match(/view_as_role in \(([^)]+)\)/);
    expect(m, "view_as_role IN (...) check missing").not.toBeNull();
    const roles = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
    expect(roles).toEqual([...VIEW_AS_ROLES].sort());
  });

  it("(a) both-or-neither pair constraint exists", () => {
    expect(sql).toContain("(view_as_role is null) = (view_as_until is null)");
  });

  it("(b) redefines staff_role() and has_role() and nothing else", () => {
    const defs = sql.match(/create or replace function public\.([a-z_]+)/g) ?? [];
    expect(defs.sort()).toEqual([
      "create or replace function public.has_role",
      "create or replace function public.staff_role",
    ]);
  });

  it("(c) both keep their properties and use the effective-role CASE", () => {
    for (const name of ["staff_role()", "has_role(roles text[])"]) {
      const body = fnBody(name);
      expect(body).toContain("stable");
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = public");
      expect(body).toContain("is_active = true");
      expect(body).toContain(CASE);
    }
    expect(fnBody("staff_role()")).toContain("returns text");
    expect(fnBody("has_role(roles text[])")).toContain("= any(roles)");
  });

  it("(d) asserts anon and authenticated EXECUTE on all three helpers", () => {
    for (const grantee of ["anon", "authenticated"]) {
      for (const fn of ["public.has_role(text[])", "public.staff_role()", "public.is_staff()"]) {
        expect(sql).toContain(`has_function_privilege('${grantee}', '${fn}', 'EXECUTE')`);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/view-as-migration.test.ts`
Expected: FAIL — `ENOENT ... 0182_staff_view_as_role.sql`.

- [ ] **Step 3: Write the migration**

```sql
-- =============================================================================
-- 0182_staff_view_as_role.sql
-- =============================================================================
-- Admin "View as role" — spec: docs/superpowers/specs/2026-09-25-staff-view-as-role-design.md
--
-- An admin may carry a temporary override on their OWN staff_profiles row.
-- The caller-identity helpers staff_role() and has_role() (0001) then answer
-- with the EFFECTIVE role: the override while the real role is admin and the
-- expiry is strictly in the future, the real role otherwise. is_staff() is
-- untouched (existence, not role). No policy or function reads
-- staff_profiles.role directly (verified 2026-09-25; 0167's actor check is
-- service-role-only and deliberately real-role), so these two bodies are the
-- whole database change. src/lib/auth/view-as.ts mirrors the CASE and
-- view-as-migration.test.ts pins the two together.
--
-- Deliberately NO constraint tying view_as_role to role = 'admin': another
-- admin demoting a currently-simulating admin must not fail. The CASE ignores
-- an override on a non-admin row, so a stale override is inert.
--
-- The columns are written only by the View-as server actions through the
-- service-role client: while simulating, has_role(array['admin']) is false,
-- so the "admin manage" policy would refuse the admin's own exit.

alter table public.staff_profiles
  add column if not exists view_as_role  text        null,
  add column if not exists view_as_until timestamptz null;

alter table public.staff_profiles
  drop constraint if exists staff_profiles_view_as_role_check,
  drop constraint if exists staff_profiles_view_as_pair_check;

alter table public.staff_profiles
  add constraint staff_profiles_view_as_role_check
    check (view_as_role is null
           or view_as_role in ('reception', 'medtech', 'xray_technician', 'pathologist')),
  add constraint staff_profiles_view_as_pair_check
    check ((view_as_role is null) = (view_as_until is null));

comment on column public.staff_profiles.view_as_role is
  'Admin testing override: the role the app and RLS treat this admin as until view_as_until. Inert unless role = admin. Written only by the View-as server actions (service role).';
comment on column public.staff_profiles.view_as_until is
  'Expiry of view_as_role. Active while strictly greater than now().';

-- Bodies only. Signature, STABLE, SECURITY DEFINER, search_path and ACLs are
-- unchanged — CREATE OR REPLACE keeps grants; asserted below regardless.
create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
           when role = 'admin' and view_as_until > now() then view_as_role
           else role
         end
  from public.staff_profiles
  where id = auth.uid() and is_active = true;
$$;

create or replace function public.has_role(roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_profiles
    where id = auth.uid()
      and is_active = true
      and (case
             when role = 'admin' and view_as_until > now() then view_as_role
             else role
           end) = any(roles)
  );
$$;

-- 0118 keeps anon + authenticated EXECUTE on the caller-identity predicates.
-- If either were lost, every policy that calls them would raise instead of
-- filter — so fail the migration loudly rather than ship a broken app.
do $$
begin
  if not has_function_privilege('anon', 'public.has_role(text[])', 'EXECUTE')
     or not has_function_privilege('anon', 'public.staff_role()', 'EXECUTE')
     or not has_function_privilege('anon', 'public.is_staff()', 'EXECUTE') then
    raise exception '0182: a caller-identity predicate lost anon EXECUTE';
  end if;
  if not has_function_privilege('authenticated', 'public.has_role(text[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.staff_role()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.is_staff()', 'EXECUTE') then
    raise exception '0182: a caller-identity predicate lost authenticated EXECUTE';
  end if;
end $$;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/auth/view-as-migration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Apply the migration to the shared local stack (no reset)**

Run:
```bash
/opt/homebrew/opt/libpq/bin/psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/0182_staff_view_as_role.sql
/opt/homebrew/opt/libpq/bin/psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.staff_profiles" | grep -E "view_as|staff_profiles_view_as"
```
Expected: the first prints `ALTER TABLE … CREATE FUNCTION … DO`; the second lists both columns and both check constraints. If the DB is not running (`connection refused`), run `/opt/homebrew/bin/supabase start` first (OrbStack must be up, see memory `drmed-local-stack-on-orbstack`).

- [ ] **Step 6: Add the columns to the generated types by hand**

Do not run `npm run db:types` (the shared local DB may carry other branches' objects and would produce unrelated diffs). In `src/types/database.ts`, inside `staff_profiles:` (≈ line 5425), add to **Row**:
```ts
          view_as_role: string | null
          view_as_until: string | null
```
and to **Insert** and **Update**:
```ts
          view_as_role?: string | null
          view_as_until?: string | null
```
Keep alphabetical order (after `updated_at`). Run `npx tsc --noEmit` — expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0182_staff_view_as_role.sql src/lib/auth/view-as-migration.test.ts src/types/database.ts
git commit -m "feat(db): 0182 staff view-as override columns; helpers answer the effective role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Session loader carries the effective role

**Files:**
- Modify: `src/lib/auth/require-staff.ts` (interface lines 8–17, select line 35, return lines 61–66)

- [ ] **Step 1: Extend `StaffSession`**

Replace the interface with:
```ts
export interface StaffSession {
  user_id: string;
  email: string;
  full_name: string;
  /** The role every page should behave as — the admin's View-as override
   *  while one is active, otherwise the real role. */
  role:
    | "reception"
    | "medtech"
    | "pathologist"
    | "admin"
    | "xray_technician";
  /** The real profile role. Only the View-as controls read this. */
  actual_role: StaffSession["role"];
  /** The active View-as override (admin only), or null. */
  view_as: ActiveViewAs | null;
}
```
Add the import at the top: `import { activeViewAs, type ActiveViewAs } from "@/lib/auth/view-as";`

- [ ] **Step 2: Select the columns and compute the effective role**

Change the select to:
```ts
    .select("full_name, role, is_active, deleted_at, view_as_role, view_as_until")
```
Replace the final `return { … }` of `requireSignedInStaff` with:
```ts
  const view_as = activeViewAs(profile);
  return {
    user_id: user.id,
    email: user.email ?? "",
    full_name: profile.full_name,
    role: (view_as?.role ?? profile.role) as StaffSession["role"],
    actual_role: profile.role as StaffSession["role"],
    view_as,
  };
```
Add a comment above it:
```ts
  // Admin "View as role": the columns are inert unless role = 'admin' and the
  // expiry is in the future — activeViewAs() is the TS mirror of the SQL CASE
  // in 0182 that RLS uses, so both layers agree on every request.
```

- [ ] **Step 3: Typecheck and run the whole suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean. (Test mocks of `requireActiveStaff` return untyped partial sessions, so none need the new fields. If tsc names a file that builds a typed `StaffSession` literal, add `actual_role: <same as role>, view_as: null` to it.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth/require-staff.ts
git commit -m "feat(auth): session reports the effective role plus actual_role/view_as

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: One `ROLE_LABEL`

**Files:**
- Create: `src/lib/staff/role-labels.ts`
- Modify: `src/components/staff/staff-shell.tsx` (delete lines 18–24 const), `src/components/staff/staff-mobile-nav-trigger.tsx` (delete the `ROLE_LABEL` const at ≈ line 39)

- [ ] **Step 1: Create the shared module**

```ts
// src/lib/staff/role-labels.ts
import type { StaffSession } from "@/lib/auth/require-staff";

/** Plain names for staff roles, as shown in the shell footer, the mobile
 *  topbar pill and the View-as controls. */
export const ROLE_LABEL: Record<StaffSession["role"], string> = {
  reception: "Reception",
  medtech: "Medical Tech",
  xray_technician: "X-ray Technician",
  pathologist: "Pathologist",
  admin: "Admin",
};
```

- [ ] **Step 2: Replace the two local copies**

In both `staff-shell.tsx` and `staff-mobile-nav-trigger.tsx`, delete the local `const ROLE_LABEL … = { … };` block and add `import { ROLE_LABEL } from "@/lib/staff/role-labels";`. Check the mobile copy has the same five values before deleting (it does today).

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run src/components/staff`
Expected: clean; the existing nav / mobile-trigger tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/staff/role-labels.ts src/components/staff/staff-shell.tsx src/components/staff/staff-mobile-nav-trigger.tsx
git commit -m "refactor(staff): one ROLE_LABEL for shell and mobile drawer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Switch core (`view-as-switch.ts`)

**Files:**
- Create: `src/lib/auth/view-as-switch.ts`
- Test: `src/lib/auth/view-as-switch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth/view-as-switch.test.ts
// `npm test` has no database: the admin client is faked (captures the
// staff_profiles update) and the audit writer is captured.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  updates: [] as { table: string; values: Record<string, unknown>; filters: [string, unknown][] }[],
  updateError: null as { message: string } | null,
  audits: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        const rec = { table, values, filters: [] as [string, unknown][] };
        fx.updates.push(rec);
        const q = {
          eq: (col: string, val: unknown) => {
            rec.filters.push([col, val]);
            return q;
          },
          then: (resolve: (v: { error: { message: string } | null }) => void) =>
            resolve({ error: fx.updateError }),
        };
        return q;
      },
    }),
  }),
}));
vi.mock("@/lib/audit/log", () => ({
  audit: async (entry: Record<string, unknown>) => {
    fx.audits.push(entry);
  },
}));

const { startViewAs, exitViewAs } = await import("./view-as-switch");
import type { StaffSession } from "./require-staff";

const NOW = new Date("2026-09-25T04:00:00.000Z");
const ctx = { ip: "10.0.0.1", ua: "vitest", now: NOW };

function admin(view_as: StaffSession["view_as"] = null): StaffSession {
  return {
    user_id: "admin-1",
    email: "a@x.test",
    full_name: "Ada Admin",
    role: view_as?.role ?? "admin",
    actual_role: "admin",
    view_as,
  };
}

beforeEach(() => {
  fx.updates.length = 0;
  fx.audits.length = 0;
  fx.updateError = null;
});

describe("startViewAs", () => {
  it("refuses a non-admin actual_role even if role says admin", async () => {
    const s: StaffSession = { ...admin(), role: "admin", actual_role: "medtech" };
    const r = await startViewAs(s, "reception", ctx);
    expect(r.ok).toBe(false);
    expect(fx.updates).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });

  it("refuses an unknown role, including admin", async () => {
    expect((await startViewAs(admin(), "admin", ctx)).ok).toBe(false);
    expect((await startViewAs(admin(), "owner", ctx)).ok).toBe(false);
    expect((await startViewAs(admin(), null, ctx)).ok).toBe(false);
    expect(fx.updates).toHaveLength(0);
  });

  it("writes the override on the caller's own admin row with a 4h expiry and audits started", async () => {
    const r = await startViewAs(admin(), "reception", ctx);
    expect(r).toEqual({ ok: true });
    expect(fx.updates).toHaveLength(1);
    const u = fx.updates[0];
    expect(u.table).toBe("staff_profiles");
    expect(u.values).toEqual({
      view_as_role: "reception",
      view_as_until: "2026-09-25T08:00:00.000Z",
    });
    expect(u.filters).toEqual([["id", "admin-1"], ["role", "admin"]]);
    expect(fx.audits).toEqual([
      expect.objectContaining({
        actor_id: "admin-1",
        actor_type: "staff",
        action: "staff.view_as.started",
        metadata: { role: "reception", until: "2026-09-25T08:00:00.000Z" },
        ip_address: "10.0.0.1",
        user_agent: "vitest",
      }),
    ]);
  });

  it("switching from an active override audits ended(switched) then started", async () => {
    const s = admin({ role: "medtech", until: "2026-09-25T07:00:00.000Z" });
    await startViewAs(s, "xray_technician", ctx);
    expect(fx.audits.map((a) => a.action)).toEqual([
      "staff.view_as.ended",
      "staff.view_as.started",
    ]);
    expect(fx.audits[0].metadata).toEqual({ role: "medtech", reason: "switched" });
  });

  it("a failed update returns an error and audits nothing", async () => {
    fx.updateError = { message: "boom" };
    const r = await startViewAs(admin(), "reception", ctx);
    expect(r.ok).toBe(false);
    expect(fx.audits).toHaveLength(0);
  });
});

describe("exitViewAs", () => {
  it("refuses a non-admin actual_role", async () => {
    const s: StaffSession = { ...admin(), actual_role: "reception" };
    expect((await exitViewAs(s, ctx)).ok).toBe(false);
    expect(fx.updates).toHaveLength(0);
  });

  it("nulls both columns and audits ended(manual) when an override was active", async () => {
    const s = admin({ role: "reception", until: "2026-09-25T07:00:00.000Z" });
    expect(await exitViewAs(s, ctx)).toEqual({ ok: true });
    expect(fx.updates[0].values).toEqual({ view_as_role: null, view_as_until: null });
    expect(fx.updates[0].filters).toEqual([["id", "admin-1"]]);
    expect(fx.audits).toEqual([
      expect.objectContaining({
        action: "staff.view_as.ended",
        metadata: { role: "reception", reason: "manual" },
      }),
    ]);
  });

  it("with no active override still clears (stale columns) but audits nothing", async () => {
    expect(await exitViewAs(admin(), ctx)).toEqual({ ok: true });
    expect(fx.updates).toHaveLength(1);
    expect(fx.audits).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/view-as-switch.test.ts`
Expected: FAIL — `Cannot find module './view-as-switch'`.

- [ ] **Step 3: Write the core**

```ts
// src/lib/auth/view-as-switch.ts
// Admin "View as role" — start / switch / exit. Server-only core, called by
// the Server Actions in app/(staff)/staff/(dashboard)/view-as/actions.ts.
//
// Guards on session.actual_role, never session.role: while simulating, `role`
// IS the simulated role, and an admin viewing as reception must still be able
// to exit. Writes go through the service-role client for the same reason —
// under the simulated role has_role(array['admin']) is false, so the
// "staff_profiles: admin manage" policy would refuse the admin's own row.
// The `.eq("role", "admin")` filter is defense in depth: even a wrong session
// can never put an override on a non-admin row (and the SQL CASE would ignore
// it anyway).
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import type { StaffSession } from "./require-staff";
import { VIEW_AS_DURATION_MS, isViewAsRole } from "./view-as";

export type ViewAsResult = { ok: true } | { ok: false; error: string };

export interface ViewAsContext {
  ip: string | null;
  ua: string | null;
  /** Injectable clock for tests. */
  now?: Date;
}

const NOT_ADMIN = "Only an admin can view the app as another role.";

export async function startViewAs(
  session: StaffSession,
  role: unknown,
  ctx: ViewAsContext,
): Promise<ViewAsResult> {
  if (session.actual_role !== "admin") return { ok: false, error: NOT_ADMIN };
  if (!isViewAsRole(role)) return { ok: false, error: "Unknown role." };

  const now = ctx.now ?? new Date();
  const until = new Date(now.getTime() + VIEW_AS_DURATION_MS).toISOString();

  const { error } = await createAdminClient()
    .from("staff_profiles")
    .update({ view_as_role: role, view_as_until: until })
    .eq("id", session.user_id)
    .eq("role", "admin");
  if (error) return { ok: false, error: "Could not start viewing as another role." };

  const base = {
    actor_id: session.user_id,
    actor_type: "staff" as const,
    ip_address: ctx.ip,
    user_agent: ctx.ua,
  };
  if (session.view_as) {
    await audit({
      ...base,
      action: "staff.view_as.ended",
      metadata: { role: session.view_as.role, reason: "switched" },
    });
  }
  await audit({
    ...base,
    action: "staff.view_as.started",
    metadata: { role, until },
  });
  return { ok: true };
}

export async function exitViewAs(
  session: StaffSession,
  ctx: ViewAsContext,
): Promise<ViewAsResult> {
  if (session.actual_role !== "admin") return { ok: false, error: NOT_ADMIN };

  const { error } = await createAdminClient()
    .from("staff_profiles")
    .update({ view_as_role: null, view_as_until: null })
    .eq("id", session.user_id);
  if (error) return { ok: false, error: "Could not exit the role view." };

  // No active override (expired, or stale columns) → nothing to bracket.
  if (session.view_as) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "staff.view_as.ended",
      metadata: { role: session.view_as.role, reason: "manual" },
      ip_address: ctx.ip,
      user_agent: ctx.ua,
    });
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/view-as-switch.test.ts`
Expected: PASS (8 tests). If the fake query's `then` shape trips TypeScript in the test, it is fine — tests are not part of `tsc --noEmit` only if the project excludes them; if they are included, cast the fake with `as unknown as ReturnType<typeof createAdminClient>` inside the mock factory.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/view-as-switch.ts src/lib/auth/view-as-switch.test.ts
git commit -m "feat(auth): view-as start/exit core with audit bracketing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Server Actions (`view-as/actions.ts`)

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/view-as/actions.ts`

- [ ] **Step 1: Write the actions**

```ts
"use server";

// Admin "View as role" — Server Actions. Thin: auth → core → invalidate the
// staff layout → go home. The sidebar, footer and banner are rendered by the
// shared (dashboard)/layout.tsx, which Next caches across client navigations;
// without revalidatePath("/staff", "layout") the shell would keep showing the
// previous role while the database already applies the new one (same reason
// messages/actions.ts revalidates the layout for its badge).
//
// A refused switch (non-admin, bad role) just goes home: no staff member who
// is not an admin ever sees the control, so there is nothing to explain.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { exitViewAs, startViewAs } from "@/lib/auth/view-as-switch";
import { ipAndAgent } from "@/lib/server/action-helpers";

export async function startViewAsAction(formData: FormData): Promise<void> {
  const session = await requireActiveStaff();
  const { ip, ua } = await ipAndAgent();
  await startViewAs(session, formData.get("role"), { ip, ua });
  revalidatePath("/staff", "layout");
  redirect("/staff");
}

export async function exitViewAsAction(): Promise<void> {
  const session = await requireActiveStaff();
  const { ip, ua } = await ipAndAgent();
  await exitViewAs(session, { ip, ua });
  revalidatePath("/staff", "layout");
  redirect("/staff");
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/view-as/actions.ts"
git commit -m "feat(staff): view-as server actions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `ViewAsSelect` and `ViewAsBanner` (+ `RefreshOnFocus`)

**Files:**
- Create: `src/components/staff/view-as-select.tsx`
- Create: `src/components/staff/view-as-banner.tsx`
- Test: `src/components/staff/view-as-banner.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/staff/view-as-banner.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Client components rendered without a DOM: stub the router and the two
// Server Actions (a string action serialises as a plain form action).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/app/(staff)/staff/(dashboard)/view-as/actions", () => ({
  startViewAsAction: "/noop-start",
  exitViewAsAction: "/noop-exit",
}));

const { ViewAsBanner } = await import("./view-as-banner");
const { ViewAsSelect } = await import("./view-as-select");

describe("ViewAsBanner", () => {
  const html = renderToStaticMarkup(
    <ViewAsBanner role="reception" until="2026-09-25T08:00:00.000Z" remainingLabel="3h 40m" />,
  );
  it("names the role, warns about saves, and shows the remaining time", () => {
    expect(html).toContain("Viewing as Reception.");
    expect(html).toContain("Anything you save is recorded under your name.");
    expect(html).toContain("Ends in 3h 40m.");
  });
  it("is a status region hidden on print, with Exit and a role select", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain("print:hidden");
    expect(html).toContain('action="/noop-exit"');
    expect(html).toContain(">Exit<");
    expect(html).toContain('action="/noop-start"');
    expect(html).toContain('name="role"');
  });
});

describe("ViewAsSelect", () => {
  it("lists exactly the four non-admin roles with the current one selected", () => {
    const html = renderToStaticMarkup(<ViewAsSelect current="medtech" id="t" />);
    expect(html).toContain('<option value="reception">Reception</option>');
    expect(html).toContain('<option selected="" value="medtech">Medical Tech</option>');
    expect(html).toContain('<option value="xray_technician">X-ray Technician</option>');
    expect(html).toContain('<option value="pathologist">Pathologist</option>');
    expect(html).not.toContain('value="admin"');
  });
  it("with no current role shows the placeholder selected", () => {
    const html = renderToStaticMarkup(<ViewAsSelect current={null} id="t" />);
    expect(html).toMatch(/<option selected="" (disabled="" )?value="">View as…<\/option>|<option (disabled="" )?selected="" value="">View as…<\/option>/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/staff/view-as-banner.test.tsx`
Expected: FAIL — `Cannot find module './view-as-banner'`.

- [ ] **Step 3: Write the select**

```tsx
// src/components/staff/view-as-select.tsx
"use client";

// Admin "View as role" picker. Submitting on change needs JS, hence a client
// component; the Server Action is imported directly (Next serialises it as
// the form action). `current` pre-selects the role in force so the banner's
// copy of this control reads as "switch", the sidebar's as "start".
import { startViewAsAction } from "@/app/(staff)/staff/(dashboard)/view-as/actions";
import { VIEW_AS_ROLES, type ViewAsRole } from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";

interface Props {
  current: ViewAsRole | null;
  /** DOM id for the select (the shell renders up to two of these). */
  id: string;
  className?: string;
}

export function ViewAsSelect({ current, id, className }: Props) {
  return (
    <form action={startViewAsAction} className={className}>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
      >
        View as
      </label>
      <select
        id={id}
        name="role"
        defaultValue={current ?? ""}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1.5 text-xs"
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
      <noscript>
        <button type="submit" className="mt-1 text-xs underline">
          Go
        </button>
      </noscript>
    </form>
  );
}
```

- [ ] **Step 4: Write the banner and the focus refresher**

```tsx
// src/components/staff/view-as-banner.tsx
"use client";

// Admin "View as role" banner. The database applies the override on every
// request, but the shell that renders this banner lives in a layout Next
// caches across client navigations. So the banner refreshes the route:
//   - once, just after `until` (the override has expired → banner drops);
//   - whenever the tab becomes visible again (a switch or exit made in
//     another tab/device is picked up when the admin comes back).
// A tab that stays in the foreground while another device switches keeps
// the stale shell until its next navigation; every server render and action
// still uses the database's effective role, so a stale shell can mislead,
// never authorize. `remainingLabel` is computed server-side (formatRemaining)
// so the SSR markup carries a real countdown.
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { exitViewAsAction } from "@/app/(staff)/staff/(dashboard)/view-as/actions";
import type { ViewAsRole } from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";
import { ViewAsSelect } from "./view-as-select";

interface Props {
  role: ViewAsRole;
  /** ISO-8601; the moment the override stops applying. */
  until: string;
  remainingLabel: string;
}

function useRefreshOnVisible() {
  const router = useRouter();
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [router]);
}

export function ViewAsBanner({ role, until, remainingLabel }: Props) {
  const router = useRouter();
  useRefreshOnVisible();
  useEffect(() => {
    // +1s so the server's strict `until > now()` is already false.
    const ms = Math.max(0, Date.parse(until) - Date.now()) + 1_000;
    const timer = setTimeout(() => router.refresh(), ms);
    return () => clearTimeout(timer);
  }, [until, router]);

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 print:hidden"
    >
      <p className="min-w-0 flex-1">
        <b>Viewing as {ROLE_LABEL[role]}.</b> Anything you save is recorded under
        your name. Ends in {remainingLabel}.
      </p>
      <ViewAsSelect current={role} id="view-as-banner" className="w-44" />
      <form action={exitViewAsAction}>
        <Button type="submit" size="sm" variant="outline">
          Exit
        </Button>
      </form>
    </div>
  );
}

/** Headless: rendered for an admin with NO active override so a start made
 *  in another tab/device shows up here when this tab regains focus. */
export function RefreshOnFocus() {
  useRefreshOnVisible();
  return null;
}
```

Check `Button` accepts `size="sm"` (`src/components/ui/button.tsx`); if not, drop the prop and add `className="h-8 px-3 text-xs"`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/staff/view-as-banner.test.tsx`
Expected: PASS (4 tests). If the placeholder assertion fails only on attribute order, loosen it to two `toContain`s (`'value=""'` and `'View as…'`) plus `selected=""` on that option.

- [ ] **Step 6: Commit**

```bash
git add src/components/staff/view-as-select.tsx src/components/staff/view-as-banner.tsx src/components/staff/view-as-banner.test.tsx
git commit -m "feat(staff): view-as select, banner and focus refresher

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Wire the shell and the mobile drawer

**Files:**
- Modify: `src/components/staff/staff-shell.tsx`
- Modify: `src/components/staff/staff-mobile-nav-trigger.tsx` (Props ≈ line 30, signature ≈ line 240, footer ≈ line 310)
- Test: `src/components/staff/staff-shell.test.tsx` (new), `src/components/staff/staff-mobile-nav-trigger.test.tsx` (extend)

- [ ] **Step 1: Write the failing shell test**

```tsx
// src/components/staff/staff-shell.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StaffSession } from "@/lib/auth/require-staff";

// The shell is a server component whose children are client components with
// browser dependencies. Stub each at the module boundary so the real shell
// markup renders with renderToStaticMarkup — no DOM, no router, no RSC.
const pathname = vi.hoisted(() => ({ current: "/staff" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/components/ui/mobile-drawer", () => ({
  MobileDrawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HamburgerIcon: () => <svg />,
  CloseIcon: () => <svg />,
}));
vi.mock("@/app/(staff)/staff/login/actions", () => ({ signOutStaff: "/noop-signout" }));
vi.mock("@/app/(staff)/staff/(dashboard)/view-as/actions", () => ({
  startViewAsAction: "/noop-start",
  exitViewAsAction: "/noop-exit",
}));
vi.mock("./notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("./staff-quote-shortcut", () => ({ StaffQuoteShortcut: () => null }));

const { StaffShell } = await import("./staff-shell");

function session(over: Partial<StaffSession>): StaffSession {
  return {
    user_id: "u1",
    email: "a@x.test",
    full_name: "Ada Admin",
    role: "admin",
    actual_role: "admin",
    view_as: null,
    ...over,
  };
}
const render = (s: StaffSession) =>
  renderToStaticMarkup(<StaffShell session={s}><p>page</p></StaffShell>);

describe("StaffShell view-as", () => {
  it("admin with no override: two View-as selects (sidebar + drawer), no banner", () => {
    const html = render(session({}));
    expect(html.match(/name="role"/g)).toHaveLength(2);
    expect(html).not.toContain('role="status"');
    expect(html).toContain("Admin · a@x.test");
  });

  it("non-admin: no View-as control anywhere", () => {
    const html = render(session({ role: "reception", actual_role: "reception" }));
    expect(html).not.toContain('name="role"');
    expect(html).not.toContain("View as");
  });

  it("admin viewing as reception: banner, reception nav, footer says viewing as", () => {
    const html = render(
      session({
        role: "reception",
        view_as: { role: "reception", until: new Date(Date.now() + 3_600_000).toISOString() },
      }),
    );
    expect(html).toContain("Viewing as Reception.");
    expect(html).toContain('action="/noop-exit"');
    expect(html).toContain("Reception (viewing as) · Admin");
    // Admin-only sidebar item must be gone; a reception item must be present.
    expect(html).not.toContain('href="/staff/users"');
    expect(html).toContain('href="/staff/queue"');
  });
});
```
If `/staff/queue` is not a reception item in `staff-nav-config.ts`, pick any item whose `roles` includes `reception` (e.g. `/staff/messages`) and use its `href`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/staff/staff-shell.test.tsx`
Expected: FAIL — "two selects" finds 0; "Viewing as" missing.

- [ ] **Step 3: Update `staff-shell.tsx`**

Add imports:
```tsx
import { ViewAsSelect } from "./view-as-select";
import { RefreshOnFocus, ViewAsBanner } from "./view-as-banner";
import { formatRemaining } from "@/lib/auth/view-as";
```
Replace the sidebar footer block (the `<div className="border-t … p-4">` inside `<aside>`) with:
```tsx
        <div className="border-t border-[color:var(--color-brand-bg-mid)] p-4">
          <p className="truncate text-sm font-semibold text-[color:var(--color-brand-navy)]">
            {session.full_name}
          </p>
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {session.view_as
              ? `${ROLE_LABEL[session.role]} (viewing as) · ${ROLE_LABEL[session.actual_role]}`
              : ROLE_LABEL[session.role]}{" "}
            · {session.email}
          </p>
          {session.actual_role === "admin" && (
            <ViewAsSelect
              current={session.view_as?.role ?? null}
              id="view-as-sidebar"
              className="mt-3"
            />
          )}
          <form action={signOutStaff} className="mt-3">
            <Button type="submit" variant="outline" className="w-full text-xs">
              Sign out
            </Button>
          </form>
        </div>
```
(Keep the existing Sign out button markup exactly as it is today if it differs from the above — only the role line and the select are new.)

In the mobile topbar, pass the new props:
```tsx
            <StaffMobileNavTrigger
              role={session.role}
              actualRole={session.actual_role}
              viewAs={session.view_as}
              email={session.email}
              fullName={session.full_name}
              badges={badges}
            />
```
Directly inside `<div className="flex min-w-0 flex-1 flex-col">`, **before** the `<header …md:hidden>`, add:
```tsx
        {session.view_as ? (
          <ViewAsBanner
            role={session.view_as.role}
            until={session.view_as.until}
            remainingLabel={formatRemaining(session.view_as.until)}
          />
        ) : session.actual_role === "admin" ? (
          <RefreshOnFocus />
        ) : null}
```

- [ ] **Step 4: Update `staff-mobile-nav-trigger.tsx`**

Extend `Props`:
```ts
interface Props {
  role: StaffRole;
  /** Real role; the View-as picker shows only when this is "admin". */
  actualRole: StaffRole;
  viewAs: ActiveViewAs | null;
  email: string;
  fullName: string;
  badges?: Record<string, number>;
}
```
Add imports: `import type { ActiveViewAs } from "@/lib/auth/view-as";` and `import { ViewAsSelect } from "./view-as-select";`. Change the signature to `({ role, actualRole, viewAs, email, fullName, badges }: Props)`. Replace the drawer footer's role line and add the select before Sign out:
```tsx
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {viewAs
              ? `${ROLE_LABEL[role]} (viewing as) · ${ROLE_LABEL[actualRole]}`
              : ROLE_LABEL[role]}{" "}
            · {email}
          </p>
          {actualRole === "admin" && (
            <ViewAsSelect current={viewAs?.role ?? null} id="view-as-drawer" className="mt-3" />
          )}
```

- [ ] **Step 5: Extend the mobile trigger test**

In `staff-mobile-nav-trigger.test.tsx`, add next to the existing mocks:
```tsx
vi.mock("@/app/(staff)/staff/(dashboard)/view-as/actions", () => ({
  startViewAsAction: "/noop-start",
  exitViewAsAction: "/noop-exit",
}));
```
Update its `render` helper to pass `actualRole={role}` and `viewAs={null}` (so existing cases keep rendering), then add:
```tsx
describe("view-as in the drawer", () => {
  it("admin gets the picker; reception does not", () => {
    const adminHtml = renderToStaticMarkup(
      <StaffMobileNavTrigger role="admin" actualRole="admin" viewAs={null} email="a@x.test" fullName="Ada" />,
    );
    expect(adminHtml).toContain('id="view-as-drawer"');
    const recHtml = renderToStaticMarkup(
      <StaffMobileNavTrigger role="reception" actualRole="reception" viewAs={null} email="r@x.test" fullName="Rae" />,
    );
    expect(recHtml).not.toContain('name="role"');
  });
  it("while viewing as medtech the footer says so and the nav is medtech's", () => {
    const html = renderToStaticMarkup(
      <StaffMobileNavTrigger
        role="medtech"
        actualRole="admin"
        viewAs={{ role: "medtech", until: "2026-09-25T08:00:00.000Z" }}
        email="a@x.test"
        fullName="Ada"
      />,
    );
    expect(html).toContain("Medical Tech (viewing as) · Admin");
    expect(html).not.toContain('href="/staff/users"');
  });
});
```

- [ ] **Step 6: Run the staff component tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run src/components/staff`
Expected: clean; new shell test 3/3, mobile test all green.

- [ ] **Step 7: Commit**

```bash
git add src/components/staff/staff-shell.tsx src/components/staff/staff-shell.test.tsx src/components/staff/staff-mobile-nav-trigger.tsx src/components/staff/staff-mobile-nav-trigger.test.tsx
git commit -m "feat(staff): View-as picker in sidebar and drawer, banner above every page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Database smoke test (with control)

**Files:**
- Create: `supabase/tests/0182_staff_view_as_smoke.sql`

Precondition: Task 2 Step 5 applied 0182 to the local DB.

- [ ] **Step 1: Write the smoke script**

```sql
-- =============================================================================
-- 0182_staff_view_as_smoke.sql
-- =============================================================================
-- DB proof for migration 0182 (admin "View as role"). Runs inside
-- BEGIN/ROLLBACK, leaves no state. Asserts with raise exception; the control
-- at the end shows the probes can tell "override" from "no override".
--
-- Run: /opt/homebrew/opt/libpq/bin/psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 \
--        -f supabase/tests/0182_staff_view_as_smoke.sql
--
-- What it proves:
--   P1 helper ACLs: anon + authenticated can execute the three predicates.
--   P2 admin A with override 'reception': as A, has_role(admin) is false,
--      has_role(reception) true, staff_role() = reception; A can still read
--      its own staff_profiles row; A CANNOT update its own row under RLS
--      (why the app uses the service role to exit).
--   P3 equivalence: contact_messages (0154: reception/admin read) is visible
--      to A-as-reception exactly as to genuine reception R, and hidden from
--      A-as-medtech exactly as from genuine medtech M;
--      lab_sections_for_role(staff_role()) for A-as-xray equals genuine X.
--   P4 a non-admin (M) with override columns set still resolves to medtech.
--   P5 expiry: until = now() (strict >) and until in the past → admin.
--   P6 demoted: A.role = medtech with override set → medtech.
--   P7 CONTROL: override cleared → A is admin again and sees the message.
begin;

-- fixtures ------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-admin@example.test', '', now(), now(), now()),
  ('a1000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-reception@example.test', '', now(), now(), now()),
  ('a2000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-medtech@example.test', '', now(), now(), now()),
  ('a3000000-0000-4000-8000-000000000182', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'smoke182-xray@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role) values
  ('a0000000-0000-4000-8000-000000000182', 'Smoke Admin', 'admin'),
  ('a1000000-0000-4000-8000-000000000182', 'Smoke Reception', 'reception'),
  ('a2000000-0000-4000-8000-000000000182', 'Smoke Medtech', 'medtech'),
  ('a3000000-0000-4000-8000-000000000182', 'Smoke Xray', 'xray_technician');

insert into public.contact_messages (id, name, message) values
  ('c0000000-0000-4000-8000-000000000182', 'Smoke Sender', 'smoke 0182');

-- helper: run the rest of a block as `who` -----------------------------------
create or replace function pg_temp.become(who uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', who), true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.unbecome() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

do $$
declare
  k_admin     constant uuid := 'a0000000-0000-4000-8000-000000000182';
  k_reception constant uuid := 'a1000000-0000-4000-8000-000000000182';
  k_medtech   constant uuid := 'a2000000-0000-4000-8000-000000000182';
  k_xray      constant uuid := 'a3000000-0000-4000-8000-000000000182';
  v_bool boolean; v_text text; v_n int; v_n2 int; v_arr text[]; v_arr2 text[];
begin
  -- P1 -----------------------------------------------------------------------
  if not has_function_privilege('anon', 'public.has_role(text[])', 'EXECUTE')
     or not has_function_privilege('anon', 'public.staff_role()', 'EXECUTE')
     or not has_function_privilege('anon', 'public.is_staff()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.has_role(text[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.staff_role()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.is_staff()', 'EXECUTE') then
    raise exception 'P1: helper ACL lost';
  end if;
  raise notice 'P1 ok: helper ACLs intact';

  -- P2 -----------------------------------------------------------------------
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() + interval '4 hours'
   where id = k_admin;

  perform pg_temp.become(k_admin);
  select public.has_role(array['admin']) into v_bool;
  if v_bool then raise exception 'P2: has_role(admin) should be false while viewing as reception'; end if;
  select public.has_role(array['reception']) into v_bool;
  if not v_bool then raise exception 'P2: has_role(reception) should be true'; end if;
  select public.staff_role() into v_text;
  if v_text <> 'reception' then raise exception 'P2: staff_role() = % (want reception)', v_text; end if;
  select count(*) into v_n from public.staff_profiles where id = k_admin;
  if v_n <> 1 then raise exception 'P2: self-read failed (% rows)', v_n; end if;
  update public.staff_profiles set view_as_role = null, view_as_until = null where id = k_admin;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'P2: RLS let the simulating admin clear its own override (% rows) — the service-role exit path is then unnecessary, re-check the policies', v_n; end if;
  perform pg_temp.unbecome();
  raise notice 'P2 ok: helpers answer reception; self-read works; self-update denied';

  -- P3 -----------------------------------------------------------------------
  perform pg_temp.become(k_admin);
  select count(*) into v_n from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  perform pg_temp.become(k_reception);
  select count(*) into v_n2 from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  if v_n <> 1 or v_n2 <> 1 then raise exception 'P3: reception equivalence broken (A=% R=%)', v_n, v_n2; end if;

  update public.staff_profiles set view_as_role = 'medtech' where id = k_admin;
  perform pg_temp.become(k_admin);
  select count(*) into v_n from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  perform pg_temp.become(k_medtech);
  select count(*) into v_n2 from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  if v_n <> 0 or v_n2 <> 0 then raise exception 'P3: medtech equivalence broken (A=% M=%)', v_n, v_n2; end if;

  update public.staff_profiles set view_as_role = 'xray_technician' where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.lab_sections_for_role(public.staff_role()) into v_arr;
  perform pg_temp.unbecome();
  perform pg_temp.become(k_xray);
  select public.lab_sections_for_role(public.staff_role()) into v_arr2;
  perform pg_temp.unbecome();
  if v_arr is distinct from v_arr2 or v_arr is null then
    raise exception 'P3: xray lab sections differ (A=% X=%)', v_arr, v_arr2;
  end if;
  raise notice 'P3 ok: reception / medtech / xray equivalence';

  -- P4 -----------------------------------------------------------------------
  update public.staff_profiles
     set view_as_role = 'reception', view_as_until = now() + interval '4 hours'
   where id = k_medtech;
  perform pg_temp.become(k_medtech);
  select public.staff_role() into v_text;
  select public.has_role(array['reception']) into v_bool;
  perform pg_temp.unbecome();
  if v_text <> 'medtech' or v_bool then raise exception 'P4: non-admin override must be inert (role=% has_reception=%)', v_text, v_bool; end if;
  raise notice 'P4 ok: non-admin override inert';

  -- P5 -----------------------------------------------------------------------
  update public.staff_profiles set view_as_role = 'reception', view_as_until = now() where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.staff_role() into v_text;
  perform pg_temp.unbecome();
  if v_text <> 'admin' then raise exception 'P5: until = now() must be expired (got %)', v_text; end if;
  update public.staff_profiles set view_as_until = now() - interval '1 second' where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.staff_role() into v_text;
  perform pg_temp.unbecome();
  if v_text <> 'admin' then raise exception 'P5: past until must be expired (got %)', v_text; end if;
  raise notice 'P5 ok: expiry strict';

  -- P6 -----------------------------------------------------------------------
  update public.staff_profiles
     set role = 'medtech', view_as_role = 'reception', view_as_until = now() + interval '4 hours'
   where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.staff_role() into v_text;
  perform pg_temp.unbecome();
  if v_text <> 'medtech' then raise exception 'P6: demoted admin must resolve to real role (got %)', v_text; end if;
  update public.staff_profiles set role = 'admin' where id = k_admin;
  raise notice 'P6 ok: demotion makes the override inert (and the demote itself was not blocked)';

  -- P7 CONTROL ---------------------------------------------------------------
  update public.staff_profiles set view_as_role = null, view_as_until = null where id = k_admin;
  perform pg_temp.become(k_admin);
  select public.has_role(array['admin']) into v_bool;
  select public.staff_role() into v_text;
  select count(*) into v_n from public.contact_messages where id = 'c0000000-0000-4000-8000-000000000182';
  perform pg_temp.unbecome();
  if not v_bool or v_text <> 'admin' or v_n <> 1 then
    raise exception 'P7 CONTROL: cleared override should restore admin (has_admin=% role=% msgs=%)', v_bool, v_text, v_n;
  end if;
  raise notice 'P7 ok (control): override cleared → admin again';
end $$;

rollback;
```

- [ ] **Step 2: Run it**

Run:
```bash
/opt/homebrew/opt/libpq/bin/psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/0182_staff_view_as_smoke.sql
```
Expected: seven `NOTICE: P… ok` lines, then `ROLLBACK`, exit 0. Known adjustment points if it fails on shape rather than behaviour: (a) `set_config('role', …)` — if the local role cannot be switched this way, replace `become`/`unbecome` bodies with `execute 'set local role authenticated'` / `'reset role'` inside the DO block (they are plpgsql, so `execute` works); (b) `contact_messages` NOT NULL columns changed since 0004 → add the extra columns to the insert; (c) `staff_profiles` requires more NOT NULL columns (check `\d public.staff_profiles`) → add them. Do **not** weaken an assertion to make it pass; a red P-line is a real finding — report it.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/0182_staff_view_as_smoke.sql
git commit -m "test(db): 0182 view-as smoke — helpers, self-read, equivalence, expiry, control

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: User guide

**Files:**
- Modify: `docs/drmed-user-guide.html` (Admin chapter starts ≈ line 955; version tags at ≈ line 250 and ≈ line 1248)
- Modify: `CLAUDE.md` (the `docs/drmed-user-guide.html — … (v2.26, 25 Sep 2026)` line)

- [ ] **Step 1: Add a sub-section at the end of the Admin chapter (before `<h2>For patients</h2>`)**

Find the last `</section>` before `<h2>For patients</h2>` and insert after it (use the next free `5.N` number — read the preceding `<h3>` to pick it):
```html
  <section class="sub" id="adm-view-as">
    <h3>5.N Seeing the app as another role</h3>
    <p>To check what Reception, a Medical Tech, an X-ray Technician or a Pathologist actually sees, you do not need a second login.</p>
    <ol class="steps">
      <li><p class="step-title">Pick a role under <b>View as</b> in the sidebar footer (on a phone: open the menu, it is under your name).</p><p>You land on the staff home page. The sidebar, dashboard, buttons and lists now match that role exactly — including which lab work you may claim.</p></li>
      <li><p class="step-title">An amber bar stays at the top of every page: <q>Viewing as Reception. Anything you save is recorded under your name. Ends in 3h 40m.</q></p><p>Everything you do is real and is logged against <b>you</b> (the admin), not a fictitious user. Use the same <b>View as</b> picker in the bar to hop to another role.</p></li>
      <li><p class="step-title">Tap <kbd class="ui">Exit</kbd> in the bar to return to Admin.</p><p>If you forget, the view ends by itself after four hours. Other staff never see this control.</p></li>
    </ol>
    <p>Admin-only pages redirect to the staff home page while you are viewing as another role — that is the role's real experience, not an error.</p>
  </section>
```

- [ ] **Step 2: Bump the version in both places and in CLAUDE.md**

Change `User guide · v2.26` → `v2.27`, and the footer line to `v2.27 · 25 September 2026 · Matches the production release at migration 0182 …` (keep the rest of that sentence). In `CLAUDE.md` change `(v2.26, 25 Sep 2026)` → `(v2.27, 25 Sep 2026)`.

- [ ] **Step 3: Commit**

```bash
git add docs/drmed-user-guide.html CLAUDE.md
git commit -m "docs(guide): v2.27 — admin View as role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Full verification + browser pass

- [ ] **Step 1: Static checks**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: all green. Fix anything red before continuing.

- [ ] **Step 2: Browser pass on the local dev server**

Start `npm run dev` (port 3000; the local Supabase stack must be up). Sign in as a local admin (seeded credentials per `README.md` / `supabase/seed.sql`). Use `playwright-cli` (skill `playwright-cli`) or the Playwright MCP; verify with snapshots/DOM text, screenshots only where a visual must be confirmed. Checklist (each must hold without a manual reload):

1. Desktop, `/staff`: sidebar footer shows "Admin · <email>" and a **View as** select; no banner.
2. Choose **Reception** → lands on `/staff`; amber banner "Viewing as Reception."; footer "Reception (viewing as) · Admin"; sidebar has no **Staff Users**; dashboard is the reception dashboard.
3. Navigate to `/staff/users` → redirected to `/staff`.
4. In the banner select **Medical Tech** → banner and sidebar update to Medical Tech; lab queue is visible; open a chemistry item and confirm **Claim** is offered; then switch to **X-ray Technician** and confirm chemistry claim is gone and imaging is offered.
5. **Exit** → footer "Admin · <email>", banner gone, **Staff Users** back.
6. Mobile width (375px): open the drawer → **View as** select under your name; start **Pathologist**; the banner shows above the topbar; drawer footer says "Pathologist (viewing as) · Admin"; Exit works from the banner.
7. Two tabs: A and B on `/staff` as admin. In A choose Reception. Switch to B (tab focus) → B shows the banner without reload. In A Exit; focus B → banner gone.
8. Expiry: with an override active, run in psql `update staff_profiles set view_as_until = now() + interval '5 seconds' where role = 'admin' and view_as_role is not null;` reload once, wait ~7s → banner disappears on its own.
9. `select action, metadata from audit_log where action like 'staff.view_as.%' order by created_at desc limit 6;` shows started / ended(switched) / ended(manual) rows with the expected roles.

Record the outcome of each item (pass/fail + note) in the PR description.

---

### Task 12: PR, migration to prod, merge

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/staff-view-as-role
export PATH="/opt/homebrew/bin:$PATH"
gh pr create --title "feat(staff): admin View as role (0182)" --body-file - <<'PR'
## What
Admins can view and use /staff as Reception, Medical Tech, X-ray Technician or Pathologist without a second login. Spec: docs/superpowers/specs/2026-09-25-staff-view-as-role-design.md (Codex Astra plan review applied).

- Migration **0182**: `staff_profiles.view_as_role/view_as_until`; `staff_role()`/`has_role()` answer the effective role; helper ACLs asserted.
- Session loader mirrors the SQL rule (`activeViewAs`), so all existing role checks and RLS agree.
- View-as picker (sidebar + mobile drawer), amber banner with Exit, 4-hour auto-expiry, layout revalidation, refresh at expiry / on tab focus.
- Audit: `staff.view_as.started` / `staff.view_as.ended` under the admin's real id.
- User guide v2.27.

## Rollout
Migration first (additive; old code ignores the columns and nothing can set one until this code is live), then merge/deploy. Rollback of the app: clear overrides (`update staff_profiles set view_as_role=null, view_as_until=null where view_as_role is not null`), verify 0 remain, then redeploy old code; the migration stays.

## Verification
- `npx tsc --noEmit`, `npm run lint`, `npx vitest run`: green.
- DB smoke `supabase/tests/0182_staff_view_as_smoke.sql` on local: P1–P7 ok (P7 = control).
- Browser checklist (Task 11): <fill in per item>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PR
```
Mark ready (not draft) before CI runs — see memory `eaglewatch-ready-for-review-cancel-trap`.

- [ ] **Step 2: Push 0182 to prod right before merge** (memory `feedback-drmed-apply-migrations-yourself`; if `supabase db push` is classifier-blocked in this session, hand the exact commands to the user)

```bash
export PATH="/opt/homebrew/bin:$PATH"
supabase db push --dry-run          # expect: only 0182 listed
supabase db push                    # if it reports "up to date", re-read memory supabase-db-push-remote-only-migration
```
Verify by object on prod (via the Supabase MCP `execute_sql`, read-only):
```sql
select column_name from information_schema.columns where table_name = 'staff_profiles' and column_name like 'view_as%';
select conname from pg_constraint where conname like 'staff_profiles_view_as%';
select prosrc like '%view_as_until > now()%' as new_body from pg_proc where proname = 'has_role';
select has_function_privilege('anon', 'public.has_role(text[])', 'EXECUTE');
```
Expected: 2 columns, 2 constraints, `true`, `true`.

- [ ] **Step 3: Merge, then update the ledger**

After merge and Vercel deploy: in `CLAUDE.md` update the "Migration ledger: prod head = …" line to 0182; update memory `drmed-repo-state.md`. Then sign in on prod as admin and repeat browser items 1, 2, 5 once.

---

## Self-review (done while writing)

- **Spec coverage:** §1 → Task 2; §2 → Tasks 1, 3; §3 (actions, revalidate, refresh at expiry / on focus, RefreshOnFocus) → Tasks 5, 6, 7, 8; §4 (sidebar, drawer, banner, footer line, ROLE_LABEL) → Tasks 4, 7, 8; §5 audit → Task 5; §6 edge cases → Tasks 1, 5 (`.eq role admin`), 9 (P4, P6); §7 tests → Tasks 1, 2, 5, 7, 8, 9, 11; §8 rollout/rollback → Task 12 + PR body. Guide requirement from CLAUDE.md → Task 10.
- **Type consistency:** `ActiveViewAs { role: ViewAsRole; until: string }` is used by `StaffSession.view_as`, `ViewAsBanner` props, `StaffMobileNavTrigger.viewAs`. Actions are `startViewAsAction(formData)` / `exitViewAsAction()`; core is `startViewAs(session, role, ctx)` / `exitViewAs(session, ctx)` returning `ViewAsResult`. Select ids: `view-as-sidebar`, `view-as-drawer`, `view-as-banner`.
- **Placeholders:** the guide's `5.N` and the PR body's `<fill in per item>` are the only fill-ins, both instructed (read the preceding heading; record the checklist results).

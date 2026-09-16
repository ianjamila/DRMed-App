# Performance: RLS InitPlan hoisting + realtime channel churn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DRMed staff app fast by evaluating each RLS helper function once per query instead of once per row, and by stopping the realtime component from rebuilding every channel on every render.

**Architecture:** One migration (`0151`) rewrites every RLS policy that calls a `STABLE` helper bare, wrapping the call in a scalar subquery so Postgres hoists it to an InitPlan. The migration's Phase 1 body is *generated* from live policy definitions so the rewrite is mechanical, then committed as static reviewable DDL. Phase 2 hand-consolidates nine stacked permissive policies, strictly within a role list. A React fix stabilises the realtime subscription identity. Everything is gated behind a row-visibility equivalence harness that proves no principal — `anon` included — can see a different set of rows after the change.

**Tech Stack:** Postgres 17 / Supabase, `pg_policies` catalog, Next.js 16 App Router, React client components, `tsx` scripts, vitest, local Supabase stack on OrbStack.

**Spec:** `docs/superpowers/specs/2026-09-16-perf-rls-realtime-design.md`

---

## Before you start

Read these. Do not re-derive what they already answer:

- `CLAUDE.md` — especially "Schema changes — order of operations" and "Cross-cutting rules learned the hard way".
- The `drmed-migrations` skill (`.claude/skills/drmed-migrations/SKILL.md`) — migration workflow, function ACLs, the RLS policy templates (which **this plan updates**, Task 9).
- The `drmed-rls-and-auth` skill (`.claude/skills/drmed-rls-and-auth/SKILL.md`) — the `current_patient_id()` JWT-claim bridge that Phase 1 touches.

**Non-negotiable constraints:**

1. **You do not push to prod.** The owner runs `! cd ~/Claude/DRMed && /opt/homebrew/bin/supabase db push`. Agent-run pushes and MCP DDL are blocked by the auto-mode classifier.
2. **Never use MCP `apply_migration`** — it stamps a timestamp version and `db push` then re-applies the file.
3. **Never run a fixture against prod.** `CREATE POLICY` takes `ACCESS EXCLUSIVE`; the harness runs on the local stack only.
4. **Work in `/Users/jamila/Claude/DRMed/.worktrees/perf-rls-realtime`** on branch `perf/rls-initplan-realtime`.

**The seven helper call patterns in scope.** All four helpers are `STABLE`, which is what makes wrapping them safe:

| Call | Volatility | Policies affected |
|---|---|---:|
| `has_role(text[])` | STABLE SECURITY DEFINER | 130 |
| `current_patient_id()` | STABLE | 8 |
| `is_staff()` | STABLE SECURITY DEFINER | 4 |
| `staff_role()` | STABLE SECURITY DEFINER | (included; 0 or few) |
| `auth.uid()` / `auth.jwt()` / `auth.role()` | STABLE | 10 |

`pg_policies` renders policy expressions **search-path-normalised and unqualified** — verified on prod: zero policies render `public.has_role(`. Match the bare form; do not also try to match a schema-qualified form that never appears.

**Local stack DB URL:** `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/perf/rls-equivalence-probe.ts` | Create. Connects to the local stack, snapshots visible-row count + content checksum per (table × principal), writes JSON. |
| `scripts/perf/rls-equivalence-check.ts` | Create. Diffs two probe JSON files; exits non-zero on any difference. |
| `scripts/perf/generate-rls-initplan-migration.ts` | Create. Reads `pg_policies`, emits static `DROP`/`CREATE POLICY` DDL for Phase 1. |
| `supabase/migrations/0151_rls_initplan_and_policy_consolidation.sql` | Create. Phase 1 (generated) + Phase 2 (hand-written). |
| `supabase/tests/0151_rls_initplan_smoke.sql` | Create. Follows the existing smoke convention. |
| `src/lib/supabase/rls-initplan.test.ts` | Create. Static guard: zero bare helper calls remain in `pg_policies`. |
| `src/components/staff/realtime-refresher.tsx` | Modify. Stable dependency identity, stable channel name, visibility gating. |
| Six staff pages (Task 7) | Modify. Hoist inline subscription arrays to module-level consts. |
| `.claude/skills/drmed-migrations/SKILL.md` | Modify. Update the RLS policy templates to the wrapped form. |

---

## Tasks 1–2: SUPERSEDED BY WHAT WAS BUILT — read this before the steps below

Both tasks are **done and committed** (`c501618`), but the design changed while building
them, because running the harness exposed three ways it could report green while proving
nothing. The steps below are kept as the original reasoning; the shipped design is:

| Script | Gate |
|---|---|
| `scripts/perf/rls-structural-prove.ts` | **Phase 1.** Unwraps the AFTER expression and compares byte-for-byte to BEFORE. Proves meaning is unchanged on **every** table, populated or not. 100% coverage, no fixture needed. |
| `scripts/perf/rls-equivalence-prove.ts` | **Phase 2.** Row visibility per table per principal, before/after in ONE `repeatable read` transaction. Only this can speak for expressions that genuinely change. |
| `scripts/perf/rls-equivalence-probe.ts` / `-check.ts` | Standalone snapshot + diff, for ad-hoc use. |

**Why it changed — three failures, each of which showed green:**

1. **The fixture has one active staff row (admin).** A probe that reads the fixture tests
   only the role that already sees everything. Both provers now provision all five roles by
   flipping the seeded row's `role` inside a rolled-back transaction, and fail loudly if
   they build fewer principals than expected.
2. **The local stack has concurrent writers.** Another session inserted a `staff_profiles`
   row between two snapshots taken minutes apart. Before/after now run inside one
   transaction at `repeatable read`, so the only difference is the policies.
3. **598 of 686 observations were `n=0`.** 67 of 98 RLS'd tables are empty locally, and
   equivalence over empty sets is vacuously true — the harness would have certified a
   migration that destroyed `test_requests` visibility. Deeper seeding (`seed:services`,
   `seed:physicians`, `seed:hmo`, `seed:templates`, `seed:sample-results`) lifts coverage
   23 → 31 tables but cannot close it. Hence the structural proof.

Both are control-tested: narrowing `visits: staff full` to admin makes the row prover name
exactly the four roles that lose visibility and the structural prover fail the policy by
name. **Re-run both control tests if you touch either script.**

---

## Task 1: Equivalence probe script

This is the safety net for everything else. It is built first and proved working (Task 2) before a single policy changes.

**Files:**
- Create: `scripts/perf/rls-equivalence-probe.ts`

- [ ] **Step 1: Write the probe script**

```ts
// scripts/perf/rls-equivalence-probe.ts
//
// Snapshots, for every RLS-protected table in `public` and every principal the app
// can present, how many rows are visible and what they contain. Run once before the
// 0151 migration and once after; `rls-equivalence-check.ts` diffs the two files.
//
// Content checksum, not just a count: a policy rewrite that swapped WHICH rows are
// visible while keeping the same number would pass a count-only check.
//
// Counts come from SQL. Never from the length of a fetched array — PostgREST caps a
// bare select at 1000 rows silently, which would make a truncated before and a
// truncated after look identical and wave a broken migration through.
import "../lib/load-env";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { writeFileSync } from "node:fs";
import { Client } from "pg";

requireLocalOrExplicitProd("perf:rls-probe", {
  writes: "nothing — read-only snapshot of row visibility per role",
});

interface Principal {
  label: string;
  role: "anon" | "authenticated";
  claims: Record<string, string> | null;
}

interface Snapshot {
  [key: string]: { n: string; fp: string } | { error: string };
}

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("usage: tsx scripts/perf/rls-equivalence-probe.ts <out.json>");
    process.exit(1);
  }

  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  // Every RLS-enabled table in public. Read from the catalog rather than a
  // hardcoded list so a table added later is covered automatically.
  const { rows: tables } = await db.query<{ tablename: string }>(`
    select c.relname as tablename
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    order by c.relname
  `);

  const principals = await buildPrincipals(db);
  const snapshot: Snapshot = {};

  for (const p of principals) {
    for (const { tablename } of tables) {
      const key = `${p.label}::${tablename}`;
      try {
        // Each probe runs in its own aborted transaction so `set local` cannot
        // leak into the next one and nothing is ever written.
        await db.query("begin");
        await db.query(`set local role ${p.role}`);
        if (p.claims) {
          await db.query("select set_config('request.jwt.claims', $1, true)", [
            JSON.stringify(p.claims),
          ]);
        } else {
          await db.query("select set_config('request.jwt.claims', '', true)");
        }
        // t::text hashes the whole row, so a column-level visibility change is
        // caught too, and no primary key is assumed.
        const { rows } = await db.query<{ n: string; fp: string | null }>(
          `select count(*)::text as n,
                  md5(coalesce(string_agg(x, '|' order by x), '')) as fp
             from (select t::text as x from public.${quoteIdent(tablename)} t) s`,
        );
        snapshot[key] = { n: rows[0].n, fp: rows[0].fp ?? "" };
      } catch (err) {
        // A permission denial is itself a stable, comparable observation.
        snapshot[key] = { error: (err as Error).message.split("\n")[0] };
      } finally {
        await db.query("rollback");
      }
    }
  }

  await db.end();
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `wrote ${outPath}: ${tables.length} tables x ${principals.length} principals = ${Object.keys(snapshot).length} observations`,
  );
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

async function buildPrincipals(db: Client): Promise<Principal[]> {
  const principals: Principal[] = [
    { label: "anon", role: "anon", claims: null },
  ];

  // One active staff member per role, chosen deterministically by lowest id so
  // two runs pick the same person.
  const { rows: staff } = await db.query<{ role: string; id: string }>(`
    select distinct on (role) role, id::text as id
    from public.staff_profiles
    where is_active = true
    order by role, id
  `);
  for (const s of staff) {
    principals.push({
      label: `staff:${s.role}`,
      role: "authenticated",
      claims: { sub: s.id, role: "authenticated" },
    });
  }

  // A patient, via the anon-role JWT carrying a patient_id claim (migration 0114).
  const { rows: patients } = await db.query<{ id: string }>(
    `select id::text as id from public.patients order by id limit 1`,
  );
  if (patients[0]) {
    principals.push({
      label: "patient",
      role: "anon",
      claims: { role: "anon", patient_id: patients[0].id },
    });
  }

  if (staff.length === 0 || patients.length === 0) {
    throw new Error(
      "fixture too thin: need at least one active staff_profiles row and one patient. Run `npm run seed:test` first.",
    );
  }
  return principals;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Register the npm scripts**

Add to `package.json` `scripts`:

```json
"perf:rls-probe": "tsx scripts/perf/rls-equivalence-probe.ts",
"perf:rls-check": "tsx scripts/perf/rls-equivalence-check.ts"
```

- [ ] **Step 3: Verify the guard test still passes**

`scripts/lib/guard-coverage.test.ts` walks each runner's module graph and fails when a
service-role client is reachable before the guard. The probe calls
`requireLocalOrExplicitProd` at module scope before building any client, so it should pass.

Run: `npx vitest run scripts/lib/guard-coverage.test.ts`
Expected: PASS

- [ ] **Step 4: Take a baseline snapshot**

```bash
supabase start
npm run db:reset
npm run seed:test
npm run perf:rls-probe -- /tmp/rls-before.json
```

Expected: `wrote /tmp/rls-before.json: N tables x M principals = N*M observations`, with
N ≈ 91 and M ≥ 5. If it throws "fixture too thin", the seed did not run.

- [ ] **Step 5: Commit**

```bash
git add scripts/perf/rls-equivalence-probe.ts package.json
git commit -m "test(perf): probe row visibility per table per principal"
```

---

## Task 2: Equivalence check + control test

A harness nobody has seen fail is not evidence. This task proves it detects a real change before it is trusted to certify one.

**Files:**
- Create: `scripts/perf/rls-equivalence-check.ts`

- [ ] **Step 1: Write the checker**

```ts
// scripts/perf/rls-equivalence-check.ts
//
// Diffs two snapshots from rls-equivalence-probe.ts. Exits 1 on any difference.
// Deliberately dumb: no tolerances, no "expected" diffs, no allowlist. Row
// visibility either is identical or the migration does not ship.
import { readFileSync } from "node:fs";

type Obs = { n: string; fp: string } | { error: string };

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error(
    "usage: tsx scripts/perf/rls-equivalence-check.ts <before.json> <after.json>",
  );
  process.exit(1);
}

const before: Record<string, Obs> = JSON.parse(readFileSync(beforePath, "utf8"));
const after: Record<string, Obs> = JSON.parse(readFileSync(afterPath, "utf8"));

const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
const diffs: string[] = [];

for (const k of keys) {
  const b = before[k];
  const a = after[k];
  if (!b) { diffs.push(`${k}: MISSING from before`); continue; }
  if (!a) { diffs.push(`${k}: MISSING from after`); continue; }
  if (JSON.stringify(b) !== JSON.stringify(a)) {
    diffs.push(`${k}:\n    before ${JSON.stringify(b)}\n    after  ${JSON.stringify(a)}`);
  }
}

if (diffs.length > 0) {
  console.error(`ROW VISIBILITY CHANGED — ${diffs.length} of ${keys.length} observations differ:\n`);
  for (const d of diffs) console.error("  " + d);
  console.error("\nThe migration must not ship. Every observation must be identical.");
  process.exit(1);
}

console.log(`OK — all ${keys.length} observations identical across ${beforePath} -> ${afterPath}`);
```

- [ ] **Step 2: Prove the harness catches a real change (the control test)**

Deliberately break one policy on the local stack, re-probe, and confirm the checker fails:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "drop policy \"visits: staff full\" on public.visits;
   create policy \"visits: staff full\" on public.visits
     for all to authenticated using (has_role(array['admin']));"

npm run perf:rls-probe -- /tmp/rls-control.json
npm run perf:rls-check -- /tmp/rls-before.json /tmp/rls-control.json; echo "exit=$?"
```

Expected: **exit=1**, with diffs listed for `staff:reception::visits`, `staff:medtech::visits`,
`staff:pathologist::visits` and `staff:xray_technician::visits` — those roles lost visibility.

**If this prints `OK` the harness is broken and nothing downstream can be trusted. Stop and
fix the probe before continuing.**

- [ ] **Step 3: Restore the local stack**

```bash
npm run db:reset && npm run seed:test
npm run perf:rls-probe -- /tmp/rls-before.json
npm run perf:rls-check -- /tmp/rls-before.json /tmp/rls-before.json
```

Expected: `OK — all N observations identical`

- [ ] **Step 4: Commit**

```bash
git add scripts/perf/rls-equivalence-check.ts
git commit -m "test(perf): fail the build on any row-visibility change"
```

---

## Task 3: Migration generator

**Files:**
- Create: `scripts/perf/generate-rls-initplan-migration.ts`

- [ ] **Step 1: Write the generator**

```ts
// scripts/perf/generate-rls-initplan-migration.ts
//
// Emits the Phase 1 body of migration 0151: every RLS policy that calls a STABLE
// helper bare, reissued with the call wrapped in a scalar subquery so Postgres
// hoists it to an InitPlan (evaluated once per query, not once per row).
//
// Runs at AUTHORING time only. It is not part of the migration — the committed
// artifact is plain static DDL a reviewer reads line by line.
import "../lib/load-env";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { Client } from "pg";

requireLocalOrExplicitProd("perf:gen-rls-migration", {
  writes: "nothing — reads pg_policies and prints DDL to stdout",
});

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// pg_policies renders expressions search-path-normalised and unqualified, so the
// bare form is the only form that appears. Verified against prod: zero policies
// render `public.has_role(`.
const HELPERS = [
  "has_role",
  "current_patient_id",
  "is_staff",
  "staff_role",
  "auth\\.uid",
  "auth\\.jwt",
  "auth\\.role",
];

// Match a helper call that is NOT already preceded by `select ` (case-insensitive,
// any whitespace). The leading group keeps the preceding character so adjacent
// identifiers like `my_has_role(` never match.
const CALL_RE = new RegExp(
  `(^|[^.\\w])(?<!select\\s)(?<!select\\s\\s)(${HELPERS.join("|")})\\s*\\(`,
  "gi",
);

export function wrapCalls(expr: string): string {
  // Walk the expression and wrap each bare helper call together with its balanced
  // argument list. A regex alone cannot find the closing paren of `has_role(array[...])`.
  let out = "";
  let i = 0;
  while (i < expr.length) {
    CALL_RE.lastIndex = i;
    const m = CALL_RE.exec(expr);
    if (!m) { out += expr.slice(i); break; }

    const prefix = m[1];
    const nameStart = m.index + prefix.length;
    const openParen = m.index + m[0].length - 1;

    // Already wrapped? Look back past whitespace for `(select`.
    const before = expr.slice(Math.max(0, nameStart - 10), nameStart).toLowerCase();
    if (/\(\s*select\s+$/.test(before)) {
      out += expr.slice(i, openParen + 1);
      i = openParen + 1;
      continue;
    }

    const close = matchParen(expr, openParen);
    if (close === -1) throw new Error(`unbalanced parens near: ${expr.slice(m.index, m.index + 60)}`);

    out += expr.slice(i, nameStart);
    out += `(select ${expr.slice(nameStart, close + 1)})`;
    i = close + 1;
  }
  return out;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function quoteIdent(n: string) { return '"' + n.replace(/"/g, '""') + '"'; }
function quoteLit(n: string) { return "'" + n.replace(/'/g, "''") + "'"; }

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const { rows } = await db.query<{
    tablename: string; policyname: string; cmd: string;
    permissive: string; roles: string[]; qual: string | null; with_check: string | null;
  }>(`
    select tablename, policyname, cmd, permissive, roles, qual, with_check
    from pg_policies
    where schemaname = 'public'
    order by tablename, policyname
  `);

  const out: string[] = [];
  let changed = 0;

  for (const p of rows) {
    const newQual = p.qual ? wrapCalls(p.qual) : null;
    const newCheck = p.with_check ? wrapCalls(p.with_check) : null;
    if (newQual === p.qual && newCheck === p.with_check) continue;
    changed++;

    const t = `public.${quoteIdent(p.tablename)}`;
    out.push(`-- ${p.tablename}: ${p.policyname}`);
    out.push(`drop policy ${quoteIdent(p.policyname)} on ${t};`);
    const parts = [
      `create policy ${quoteIdent(p.policyname)} on ${t}`,
      `  as ${p.permissive === "PERMISSIVE" ? "permissive" : "restrictive"}`,
      `  for ${p.cmd.toLowerCase() === "all" ? "all" : p.cmd.toLowerCase()}`,
      `  to ${p.roles.join(", ")}`,
    ];
    if (newQual) parts.push(`  using (${newQual})`);
    if (newCheck) parts.push(`  with check (${newCheck})`);
    out.push(parts.join("\n") + ";");
    out.push("");
  }

  await db.end();
  console.error(`-- ${changed} of ${rows.length} policies need rewriting`);
  console.log(out.join("\n"));
}

if (process.argv[1]?.endsWith("generate-rls-initplan-migration.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Write the unit test for `wrapCalls`**

Create `scripts/perf/generate-rls-initplan-migration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { wrapCalls } from "./generate-rls-initplan-migration";

describe("wrapCalls", () => {
  it("wraps a bare has_role with an array argument", () => {
    expect(wrapCalls("has_role(ARRAY['reception','admin'])"))
      .toBe("(select has_role(ARRAY['reception','admin']))");
  });

  it("wraps a zero-argument helper", () => {
    expect(wrapCalls("is_staff()")).toBe("(select is_staff())");
  });

  it("wraps inside a larger boolean expression", () => {
    expect(wrapCalls("(is_active = true) OR has_role(ARRAY['admin'])"))
      .toBe("(is_active = true) OR (select has_role(ARRAY['admin']))");
  });

  it("is idempotent — an already-wrapped call is left alone", () => {
    const wrapped = "(select has_role(ARRAY['admin']))";
    expect(wrapCalls(wrapped)).toBe(wrapped);
  });

  it("wraps current_patient_id in a comparison", () => {
    expect(wrapCalls("(patient_id = current_patient_id())"))
      .toBe("(patient_id = (select current_patient_id()))");
  });

  it("wraps a call nested inside a subquery", () => {
    expect(wrapCalls("(visit_id IN ( SELECT v.id FROM visits v WHERE (v.patient_id = current_patient_id())))"))
      .toBe("(visit_id IN ( SELECT v.id FROM visits v WHERE (v.patient_id = (select current_patient_id()))))");
  });

  it("wraps auth.uid()", () => {
    expect(wrapCalls("(id = auth.uid())")).toBe("(id = (select auth.uid()))");
  });

  it("does not match an identifier that merely ends in a helper name", () => {
    expect(wrapCalls("my_has_role(ARRAY['admin'])")).toBe("my_has_role(ARRAY['admin'])");
  });

  it("leaves an expression with no helper call untouched", () => {
    expect(wrapCalls("(is_active = true)")).toBe("(is_active = true)");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `npx vitest run scripts/perf/generate-rls-initplan-migration.test.ts`

Expected first: FAIL (module not found, or assertions fail).
Iterate on `wrapCalls` until: **PASS, 9 tests**.

The `(?<!select\s)` lookbehind in `CALL_RE` is fragile across whitespace widths — the
explicit `before` check inside `wrapCalls` is the real idempotence guard. If the lookbehind
fights you, delete it from the regex and rely on the `before` check alone.

- [ ] **Step 4: Commit**

```bash
git add scripts/perf/generate-rls-initplan-migration.ts scripts/perf/generate-rls-initplan-migration.test.ts
git commit -m "feat(perf): generator that hoists RLS helper calls to InitPlans"
```

---

## Task 4: Generate migration 0151, Phase 1

**Files:**
- Create: `supabase/migrations/0151_rls_initplan_and_policy_consolidation.sql`

- [ ] **Step 1: Re-confirm 0151 is still free across every branch**

`ls supabase/migrations` sees only this worktree. A duplicate number makes `db push` report
"up to date" and apply **nothing**.

```bash
git fetch --quiet
for b in $(git branch -a --format='%(refname:short)' | grep -v HEAD); do
  git ls-tree --name-only "$b" supabase/migrations/ 2>/dev/null | tail -1
done | sort -u | tail -3
```

Expected: highest is `0149_ap_cash_bill_payment_drawer_link.sql`. If anything shows `0151`,
stop and renumber to the next free number throughout this plan.

- [ ] **Step 2: Generate the Phase 1 body**

```bash
npm run db:reset   # ensure the local stack matches the committed migration history
npx tsx scripts/perf/generate-rls-initplan-migration.ts > /tmp/phase1.sql
wc -l /tmp/phase1.sql
```

Expected stderr: `-- 14X of 160 policies need rewriting` (the exact count is whatever the
catalog says; do not force it to a number from the spec).

- [ ] **Step 3: Assemble the migration file**

```bash
cat > supabase/migrations/0151_rls_initplan_and_policy_consolidation.sql <<'HEADER'
-- 0151: evaluate RLS helper functions once per query, not once per row.
--
-- has_role(), is_staff(), staff_role() and current_patient_id() are all STABLE, but
-- STABLE does not tell the planner to call them once — it only promises the answer
-- will not change within the statement. Written bare in a policy USING clause the
-- call is a per-row filter, so a staff user reading the 25,604-row test_requests
-- table did ~75,000-100,000 staff_profiles index lookups for one page load. That is
-- the whole reason visits_classification_summary took 2,733 ms against a 12 MB table.
--
-- Wrapping each call as (select fn(...)) turns it into an InitPlan: computed once.
-- Row visibility is unchanged by construction, and proved unchanged per table per
-- principal (anon included) by scripts/perf/rls-equivalence-probe.ts.
--
-- Phase 1 below is GENERATED by scripts/perf/generate-rls-initplan-migration.ts and
-- committed as static DDL. Regenerating against the migrated database must produce
-- an empty diff. Phase 2 (policy consolidation) is hand-written, further down.
--
-- No new P-code: this migration raises no exceptions.
-- Function ACLs untouched: no helper is redefined, and grants survive a policy replace.

-- ---------------------------------------------------------------------------
-- Phase 1 — InitPlan hoisting (generated; semantically inert)
-- ---------------------------------------------------------------------------

HEADER
cat /tmp/phase1.sql >> supabase/migrations/0151_rls_initplan_and_policy_consolidation.sql
```

- [ ] **Step 4: Read the generated DDL**

Open the file. Spot-check at least five policies against `pg_policies` for the
pre-migration form. Confirm for each: the policy name, table, `as permissive|restrictive`,
`for <cmd>`, `to <roles>` and the unwrapped parts of the expression are all **unchanged** —
only `(select ...)` has been added.

Pay particular attention to any `restrictive` policy. A restrictive policy accidentally
re-created as permissive **widens access** and the equivalence harness will catch it — but
you should catch it here first.

- [ ] **Step 5: Apply and prove equivalence**

```bash
npm run db:reset && npm run seed:test
npm run perf:rls-probe -- /tmp/rls-after.json
npm run perf:rls-check -- /tmp/rls-before.json /tmp/rls-after.json
```

Expected: `OK — all N observations identical`.

**If this fails, do not adjust the harness to make it pass.** The harness is right and the
generated DDL is wrong. Read the diff, fix the generator, regenerate.

- [ ] **Step 6: Prove the generator is idempotent**

```bash
npx tsx scripts/perf/generate-rls-initplan-migration.ts > /tmp/phase1-again.sql
wc -c /tmp/phase1-again.sql
```

Expected: **0 bytes**, and stderr `-- 0 of 160 policies need rewriting`. A non-empty result
means some call was missed or double-wrapped.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0151_rls_initplan_and_policy_consolidation.sql
git commit -m "perf(rls): hoist STABLE helper calls in every policy to an InitPlan"
```

---

## Task 5: Phase 2 — consolidate the nine stacked policy pairs

Hand-written, its own commit, so a reviewer reads nine policies rather than hunting them
inside a generated diff.

**Files:**
- Modify: `supabase/migrations/0151_rls_initplan_and_policy_consolidation.sql`

**The rule — consolidate WITHIN a role list, never across one.** Several pairs have
different role lists (`services: public read active` is `{anon, authenticated}`;
`services: staff read` is `{authenticated}`). Merging those into one policy over the union
would widen `anon`'s reachable expression. Instead: group by `(cmd, role)`, emit one policy
per group, splitting a multi-role policy into single-role policies first.

The nine targets:

| Table | Policies being merged |
|---|---|
| `appointment_attachments` | patient self + staff read |
| `hmo_providers` | public read active + staff read all |
| `physicians` | public read active + staff read all |
| `report_groups` | public read active + staff read |
| `result_test_requests` | patient released only + staff read |
| `results` | patient released only + staff select |
| `services` | public read active + staff read |
| `staff_profiles` | self select + staff read |
| `test_requests` | patient own visits + staff select |

- [ ] **Step 1: Append the Phase 2 header and the `services` worked example**

```sql
-- ---------------------------------------------------------------------------
-- Phase 2 — consolidate stacked permissive policies (hand-written)
-- ---------------------------------------------------------------------------
--
-- Nine tables carry two permissive SELECT policies for the same role, so both run
-- for every row. Consolidating puts the cheap staff check first and lets the
-- expensive patient subquery short-circuit.
--
-- The rule: consolidate WITHIN a role list, never across one. A policy granted to
-- {anon, authenticated} is split into one policy per role FIRST, so anon's
-- expression stays byte-identical rather than being widened into a union. That
-- widening is exactly how the two live anon-readable exposures found on 2026-09-10
-- would have been reintroduced.

-- services -----------------------------------------------------------------
drop policy "services: public read active" on public.services;
drop policy "services: staff read" on public.services;

-- anon: byte-identical to the expression it had before.
create policy "services: anon read active" on public.services
  as permissive for select to anon
  using (is_active = true);

-- authenticated: both arms OR'd, staff check first so it short-circuits.
create policy "services: authenticated read" on public.services
  as permissive for select to authenticated
  using (
    (select has_role(array['reception','medtech','pathologist','xray_technician']))
    or is_active = true
  );
```

- [ ] **Step 2: Write the remaining eight**

For each, first read its current definition so you reproduce the expression exactly:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select tablename, policyname, cmd, roles::text, qual, with_check
     from pg_policies
    where schemaname='public'
      and tablename in ('appointment_attachments','hmo_providers','physicians',
                        'report_groups','result_test_requests','results',
                        'staff_profiles','test_requests')
    order by tablename, policyname;" -x
```

Follow the `services` shape exactly: drop both, emit one policy per `(cmd, role)` group,
staff arm first, every helper call wrapped as `(select ...)`, `anon`'s arm byte-identical to
what it was.

Note `appointment_attachments: staff read` uses `is_staff()` rather than `has_role(...)` —
wrap it as `(select is_staff())`; do not "normalise" it to `has_role`, that would change
behaviour.

`test_requests` additionally has a third policy, `test_requests: reception/admin write`
(cmd `ALL`). Leave it alone — it is a different `cmd` group, so it is out of scope for this
consolidation.

- [ ] **Step 3: Assert anon's expression is unchanged**

```bash
npm run db:reset && npm run seed:test
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -t -c \
  "select tablename || ' :: ' || qual
     from pg_policies
    where schemaname='public' and 'anon' = any(roles)
    order by tablename, policyname;" > /tmp/anon-after.txt
diff /tmp/anon-before.txt /tmp/anon-after.txt
```

You need `/tmp/anon-before.txt` captured from a pre-0151 database. If you did not capture
it, `git stash` the migration, `npm run db:reset`, capture, restore.

Expected: differences ONLY where `(select ...)` was added by Phase 1, and only in policy
rows. **No change to any `anon` predicate's logic, and no `anon` row appearing that was not
there before.**

- [ ] **Step 4: Re-prove full equivalence**

```bash
npm run perf:rls-probe -- /tmp/rls-after2.json
npm run perf:rls-check -- /tmp/rls-before.json /tmp/rls-after2.json
```

Expected: `OK — all N observations identical`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0151_rls_initplan_and_policy_consolidation.sql
git commit -m "perf(rls): consolidate nine stacked permissive policy pairs, within role"
```

---

## Task 6: Static regression guard

Stops policy #161 being added the old way.

**Files:**
- Create: `src/lib/supabase/rls-initplan.test.ts`

- [ ] **Step 1: Write the test**

```ts
// Fails if any RLS policy calls a STABLE helper bare. A bare call is evaluated once
// per row; wrapped as (select fn()) it becomes an InitPlan evaluated once per query.
// Migration 0151 fixed 14x policies that had this shape; this test stops #161.
//
// Reads the committed migration SQL rather than a live database, so it runs in plain
// `npm test` with no stack up.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../supabase/migrations");

const HELPERS = ["has_role", "current_patient_id", "is_staff", "staff_role"];

describe("RLS policies evaluate helpers once per query", () => {
  it("has no bare helper call in any create policy statement", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");

      // Each `create policy ... ;` statement, comments stripped.
      const statements = sql
        .split(/;\s*$/m)
        .map((s) => s.replace(/--[^\n]*/g, ""))
        .filter((s) => /create\s+policy/i.test(s));

      for (const stmt of statements) {
        for (const helper of HELPERS) {
          const bare = new RegExp(`(^|[^.\\w])${helper}\\s*\\(`, "gi");
          let m: RegExpExecArray | null;
          while ((m = bare.exec(stmt)) !== null) {
            const nameStart = m.index + m[1].length;
            const before = stmt.slice(Math.max(0, nameStart - 12), nameStart).toLowerCase();
            if (!/\(\s*select\s+$/.test(before)) {
              const name = /create\s+policy\s+"([^"]+)"/i.exec(stmt)?.[1] ?? "?";
              offenders.push(`${file}: policy "${name}" calls ${helper}() unwrapped`);
            }
          }
        }
      }
    }

    // Migrations before 0151 are history and are left as written; 0151 supersedes
    // them. Only 0151 and later are held to the rule.
    const current = offenders.filter((o) => {
      const n = Number(o.slice(0, 4));
      return Number.isFinite(n) && n >= 150;
    });

    expect(current, `Wrap the call as (select ${HELPERS[0]}(...)). See 0151.`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/supabase/rls-initplan.test.ts`
Expected: PASS

- [ ] **Step 3: Prove it catches a violation**

Temporarily append to `0151_...sql`:

```sql
create policy "scratch: bad" on public.services
  as permissive for select to authenticated using (has_role(array['admin']));
```

Run: `npx vitest run src/lib/supabase/rls-initplan.test.ts`
Expected: **FAIL**, naming `scratch: bad`.

Remove those three lines. Re-run. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/rls-initplan.test.ts
git commit -m "test(rls): fail on a policy that calls a STABLE helper per row"
```

---

## Task 7: Stop the realtime channel churn

**Files:**
- Modify: `src/components/staff/realtime-refresher.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/page.tsx:498`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/queue/page.tsx:236`
- Modify: `src/app/(staff)/staff/(dashboard)/queue/page.tsx:498`
- Modify: `src/app/(staff)/staff/(dashboard)/_dashboards/lab-dashboard.tsx:531`
- Modify: `src/app/(staff)/staff/(dashboard)/_dashboards/reception-dashboard.tsx:610`
- Modify: `src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx:732`

- [ ] **Step 1: Rewrite the effect in `realtime-refresher.tsx`**

Replace the `useEffect` at lines 60–95 and its `channelName` default:

```tsx
  // Key the effect on the CONTENT of the subscription list, not its identity.
  // Every call site passes an inline array literal, which is a new object on every
  // render — with `subscriptions` in the dep array the effect tore the channel down
  // and rebuilt it on every router.refresh(), and the refresh is itself triggered by
  // the subscription. That loop made realtime WAL filtering 85% of all prod DB time
  // (10.27M ms over 1.3M calls). Call sites also hoist their arrays to module scope;
  // this serialisation is the belt to that braces.
  const subscriptionKey = JSON.stringify(subscriptions);

  useEffect(() => {
    const subs: Subscription[] = JSON.parse(subscriptionKey);
    if (subs.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        // A backgrounded tab re-rendering the whole server page helps nobody and
        // costs a full RSC round-trip. Catch up on the way back instead.
        if (document.visibilityState === "visible") router.refresh();
        timeout = null;
      }, debounceMs);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Stable channel name. The old `-${Math.random()}` suffix worked around a
    // re-mount crash that was itself caused by the dep-array churn above; with a
    // stable key the effect no longer re-runs on every render, so the crash is gone.
    const channel = supabase.channel(channelName);
    for (const sub of subs) {
      channel.on(
        "postgres_changes",
        { event: sub.event ?? "INSERT", schema: "public", table: sub.table },
        () => scheduleRefresh(),
      );
    }
    channel.subscribe();

    return () => {
      if (timeout) clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, router, subscriptionKey, debounceMs, channelName]);
```

Also give `channelName` a distinct default per page rather than the shared
`"page-refresher"`, since the name is now stable and two mounted instances must not
collide. Leave the existing `intervalMs` effect untouched.

- [ ] **Step 2: Hoist each call site's array to module scope**

In each of the six files, move the inline literal above the component. Example for
`visits/queue/page.tsx`:

```tsx
// Module scope: a stable identity, so RealtimeRefresher's effect does not re-run
// on every render. See src/components/staff/realtime-refresher.tsx.
const QUEUE_SUBSCRIPTIONS = [
  { table: "visits", event: "UPDATE" },
  { table: "visits", event: "INSERT" },
  { table: "payments", event: "INSERT" },
  { table: "test_requests", event: "UPDATE" },
] as const satisfies readonly Subscription[];
```

then

```tsx
<RealtimeRefresher channelName="visits-queue" subscriptions={QUEUE_SUBSCRIPTIONS} />
```

Export the `Subscription` interface from `realtime-refresher.tsx` and widen the prop to
`readonly Subscription[]` so `as const` arrays type-check.

`admin-dashboard.tsx:732` passes `subscriptions={[]}` — hoist it to a shared
`const NO_SUBSCRIPTIONS: readonly Subscription[] = []` rather than leaving a literal.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean. A `readonly` mismatch on the prop type is the likely first failure —
fix by widening the prop, not by dropping `as const`.

- [ ] **Step 4: Verify in the browser**

Start the dev server on port 4000, sign in as admin, open `/staff/queue`, and in DevTools →
Network → WS confirm **one** websocket with **one** `phx_join` for `queue-page`. Trigger a
`test_requests` update and confirm the page refreshes and **no new `phx_join` follows**.

Before the fix, each refresh produced a fresh join under a new random channel name.

- [ ] **Step 5: Commit**

```bash
git add src/components/staff/realtime-refresher.tsx "src/app/(staff)/staff/(dashboard)"
git commit -m "perf(realtime): stop rebuilding every channel on every render"
```

---

## Task 8: Foreign-key indexes, trimmed

**Files:**
- Modify: `supabase/migrations/0151_rls_initplan_and_policy_consolidation.sql`

**Outcome: add no indexes. This task is a verification, not a change.**

The candidate list was pulled from prod while writing this plan. Every unindexed FK on a
table above 3,000 rows is an audit-provenance column:

| Table | Unindexed FK columns | Rows |
|---|---|---:|
| `test_requests` | `deleted_by`, `released_by`, `requested_by`, `signed_off_by` | 25,604 |
| `journal_entries` | `created_by`, `posted_by`, `reversed_by` | 22,432 |
| `visits` | `created_by`, `deleted_by` | 14,267 |
| `payments` | `received_by`, `voided_by` | 7,697 |
| `patients` | `created_by`, `referral_source` | 7,060 |
| `historic_hmo_claims` | `billed_by_staff_id`, `journal_entry_id`, `paid_recorded_by_staff_id`, `wrote_off_by_staff_id`, `wrote_off_journal_entry_id` | 6,058 |

None of these is joined on by any query in the spec's §2.2. They are read one row at a time
to render "released by X", and indexing them would cost write throughput on the hottest
tables in the system to speed up nothing.

The FKs the hot queries *do* join on — `test_requests.visit_id`, `test_requests.service_id`,
`visits.patient_id` — are **absent from that list, meaning they are already indexed.** The
join path was never the problem; per-row RLS evaluation was.

- [ ] **Step 1: Confirm the hot-join FKs are indexed on the local stack**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
select c.conrelid::regclass::text as tbl, a.attname as col,
       exists (select 1 from pg_index i
                where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]) as indexed
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
where c.contype = 'f'
  and c.conrelid::regclass::text in ('test_requests','visits')
  and a.attname in ('visit_id','service_id','patient_id')
order by tbl, col;"
```

Expected: `indexed = t` for all three. **If any is `f`, add that one index** with a comment
naming the §2.2 query it serves, then re-run the equivalence proof before committing.

- [ ] **Step 2: Record the finding in the spec**

Append to §4.4 of `docs/superpowers/specs/2026-09-16-perf-rls-realtime-design.md`:

```markdown
**Resolved 2026-09-16: no indexes added.** Every unindexed FK on a table above 3,000 rows
is an audit-provenance column (`*_by`) that no hot query joins on. The FKs the hot queries
do use — `test_requests.visit_id`, `test_requests.service_id`, `visits.patient_id` — are
already indexed. Adding the advisor's 126 would have cost write throughput on the busiest
tables to speed up nothing.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-16-perf-rls-realtime-design.md
git commit -m "docs(perf): Phase 4 resolves to no indexes — hot-join FKs already covered"
```

**Also skip dropping the 46 unused indexes in this PR.** A zero-scan index is as likely to be
unshipped feature work as dead weight, and it is unrelated to the two findings this PR exists
to fix. Record as a follow-up.

---

## Task 9: Update the migration skill's policy templates

`.claude/skills/drmed-migrations/SKILL.md` carries the RLS templates the next table will be
built from, and they are all written in the unwrapped form. Left alone, this PR's fix is
undone by the next migration that follows the documented pattern.

**Files:**
- Modify: `.claude/skills/drmed-migrations/SKILL.md`

- [ ] **Step 1: Rewrite the three templates under "RLS policy templates the skill carries"**

```sql
-- Staff full access
create policy "<table>: staff full"
  on public.<table>
  using ((select public.has_role(array['reception','medtech','pathologist','admin'])));

-- Patient self-select (via current_patient_id)
create policy "<table>: patient self"
  on public.<table> for select to anon, authenticated
  using (patient_id = (select public.current_patient_id()));
```

Apply the same wrapping to the release-gated template.

- [ ] **Step 2: Add the rule above the templates**

```markdown
**Always wrap a helper call as `(select fn(...))`.** `has_role`, `is_staff`, `staff_role`
and `current_patient_id` are all STABLE, but STABLE does not make the planner call them
once — written bare in a policy they are evaluated PER ROW. Wrapping makes it an InitPlan,
evaluated once per query. Migration 0151 fixed 14x policies that had this shape and took
the Visits page from 2,733 ms to <150 ms. `src/lib/supabase/rls-initplan.test.ts` fails on
a new policy that reverts to the bare form.

Note the Supabase performance advisor does NOT catch this. Its `auth_rls_initplan` lint
only sees direct `auth.*()` calls, not a helper like `has_role()` that wraps `auth.uid()`
one level down — it reported 10 when the real number was 130.
```

- [ ] **Step 3: Update the stale ledger line in the skill and in CLAUDE.md**

The skill says "Prod ledger head = 0135, repo↔prod in sync (2026-09-10)". `CLAUDE.md` says
"prod head = 0148 … 0149 in flight". Both are stale. As of 2026-09-16 prod head is **0150**
(`patients_without_consent_report`, merged to main), and this branch is **0151**. Correct both.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/drmed-migrations/SKILL.md CLAUDE.md
git commit -m "docs(skills): RLS templates wrap helper calls; refresh the ledger head"
```

---

## Task 10: Smoke test

**Files:**
- Create: `supabase/tests/0151_rls_initplan_smoke.sql`

- [ ] **Step 1: Write it, following the existing convention**

Read `supabase/tests/0149_ap_cash_bill_payment_drawer_smoke.sql` first and match its shape.

**CORRECTED 2026-09-16.** The obvious regex is wrong, and wrong in the direction that
looks like success. `'(^|[^.[:alnum:]_])(has_role|...)[[:space:]]*\('` matches
`(select has_role(` too — the character before `has_role` is a space, which satisfies
`[^.[:alnum:]_]`. So the naive smoke test fails on a *correctly* migrated database, every
time. Verified empirically against the local stack; Codex flagged it while implementing
Task 6.

Strip the wrapped form first, then scan for whatever is left:

```sql
-- 0151 smoke: every policy evaluates its STABLE helpers once per query.
--
-- Two-step on purpose. A single regex cannot tell `has_role(` from
-- `(select has_role(` without a lookbehind, and matching the wrapped form would
-- make this fail on exactly the databases it is meant to pass. So: blank out every
-- correctly-wrapped call, then anything still matching is a genuine per-row call.
do $$
declare
  bad_count int;
  bad_list  text;
begin
  with scanned as (
    select tablename, policyname,
           regexp_replace(
             coalesce(qual,'') || ' ' || coalesce(with_check,''),
             '\(\s*select\s+(has_role|is_staff|staff_role|current_patient_id)',
             '(WRAPPED', 'gi'
           ) as stripped
    from pg_policies
    where schemaname = 'public'
  )
  select count(*), string_agg(tablename || '.' || policyname, ', ')
    into bad_count, bad_list
  from scanned
  where stripped ~ '(^|[^.[:alnum:]_])(has_role|is_staff|staff_role|current_patient_id)[[:space:]]*\(';

  if bad_count > 0 then
    raise exception
      '0151 smoke: % policies still call a STABLE helper per row: %', bad_count, bad_list;
  end if;
end $$;
```

Confirm the correction with the five cases that matter — bare (must match), each of the
three wrapped helpers (must not), and a mixed expression containing both (must match).
A regex that passes the first four and fails the fifth is the subtle failure.

**Note:** this `raise` is a post-condition assert inside a `do $$ … $$` block, which
CLAUDE.md exempts from the P-code requirement — it aborts a deploy, never a user. Do not
mint a P-code for it.

- [ ] **Step 2: Run it**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/0151_rls_initplan_smoke.sql
```

Expected: `DO`, no exception.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/0151_rls_initplan_smoke.sql
git commit -m "test(db): smoke — no policy calls a STABLE helper per row"
```

---

## Task 11: Full gate, then hand back

- [ ] **Step 1: Fresh replay from an empty database**

The full history must apply to an empty DB.

```bash
npm run db:reset
```

Expected: all migrations 0001→0151 apply cleanly.

- [ ] **Step 2: Full local gate**

There is no PR-triggered CI in this repo — the Vercel preview is the only automated gate, so
this runs here or nowhere.

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all three clean.

- [ ] **Step 3: Final equivalence proof from a clean baseline**

```bash
git stash push -u -m "perf-0151-baseline-capture"
npm run db:reset && npm run seed:test
npm run perf:rls-probe -- /tmp/rls-final-before.json
git stash list --format='%H %gs' | head -3   # capture YOUR sha, do not use `pop`
git stash apply <sha-from-above>
npm run db:reset && npm run seed:test
npm run perf:rls-probe -- /tmp/rls-final-after.json
npm run perf:rls-check -- /tmp/rls-final-before.json /tmp/rls-final-after.json
```

Expected: `OK — all N observations identical`.

**The stash stack is shared with every other worktree and other sessions may push or pop it
concurrently.** Never bare `git stash pop`. Use the tagged push / `apply <sha>` / drop-by-tag
sequence above.

- [ ] **Step 4: Local timing measurement**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  (select json_build_object('sub', id, 'role', 'authenticated')::text
     from public.staff_profiles where role='admin' and is_active limit 1), true);
explain (analyze, buffers)
  select * from public.visits_classification_summary(null, null, 'active');
rollback;"
```

Record the planning + execution time. On the local fixture the absolute number will be
smaller than prod's 2,733 ms, but the **shape** is the evidence: confirm `has_role` now
appears as an `InitPlan` evaluated once, not as a per-row filter.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin perf/rls-initplan-realtime
```

PR body must state: the four phases, the measured baseline from the spec's §2, that the
equivalence harness passed with the control test proving it works, and that **the migration
must be applied to prod before the PR merges**.

- [ ] **Step 6: Hand back to the owner — do not push to prod yourself**

Report to the owner:

> Ready. Run `! cd ~/Claude/DRMed && /opt/homebrew/bin/supabase db push` to apply 0151,
> then confirm prod ledger head is 0151 and that `pg_policies` shows the wrapped form live.
> Verify the objects, never the summary line — a duplicate migration number makes `db push`
> report "up to date" and apply nothing.

- [ ] **Step 7: After the owner has pushed and merged — re-measure**

Re-run the `pg_stat_statements` query from the spec's §2 and fill in the §5.4 scorecard.
`pg_stat_statements` accumulates since last reset, so compare **means**, not totals.

| Metric | Before | Target | Actual |
|---|---:|---|---|
| `visits_classification_summary` mean | 2,733 ms | < 150 ms | |
| Visits list mean | 1,850 ms | < 200 ms | |
| `v_patients_directory` mean | 833 ms | < 150 ms | |
| Realtime share of DB time | 85.4% | < 20% | |

Also spot-check any headline tile whose value comes from a fetched array rather than a SQL
aggregate. A list that previously timed out or returned short may now be fast enough to hit
an implicit 1,000-row cap, turning a visibly broken number into a plausible wrong one.

Commit the filled-in scorecard to the spec.

---

## Out of scope — record, do not chase

- `pg_timezone_names` (682 calls × 339 ms). Supabase Auth/Studio, not app code.
- PostgREST schema-cache rebuilds (683 × ~165 ms).
- `auth_db_connections_absolute` — a Supabase dashboard setting.
- Dropping the 46 unused indexes (Task 8).
- The consent report aggregation — another session, migration 0151.
- Row-cap defects — `jamila-8e`'s audit. If it lands close in time, **merge it first**.

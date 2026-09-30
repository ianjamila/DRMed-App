# Patient Sources — One Call Per Page View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Patient Sources page (and its CSV) builds the identity core, encounters and revenue lines once per view through one new RPC, `patient_sources_report`, while every existing report RPC keeps returning exactly what it returns today.

**Architecture:** Migration 0206 adds three composite row types, three "list builder" functions (identity/encounter/revenue-line arrays) and five section helpers holding each section's rule verbatim over arrays. The five existing RPCs become gate + validate + `return query select * from helper(lists)` wrappers. `patient_sources_report` gates once, validates once, builds the lists once and returns all eight sections as one jsonb. The app gains one loader + parser; the page and the CSV route switch to it.

**Tech Stack:** Postgres 17 (Supabase, plpgsql/sql), Next.js 16 server components, supabase-js, vitest, tsx proof scripts (node-pg).

**Spec:** `docs/superpowers/specs/2026-09-30-patient-sources-one-call-design.md` (approved 2026-09-30).

**Worktree:** `/Users/jamila/Claude/DRMed/.worktrees/ps-report-bundle`, branch `feat/patient-sources-report`, off origin/main `9cb84443`. Migration **0206** is claimed. No new P-codes (reuses 42501 / 22023).

---

## Ground rules for every task

- Work ONLY inside the worktree above. Never touch `~/Claude/DRMed` (the main checkout) and never copy its `.env.local` (it points at PROD).
- Bash is zsh: never name a variable `path`; no `python3` heredocs; `curl` to localhost needs the sandbox disabled.
- Database work runs on the ISOLATED stack from Task 0 (DB port **56322**, API **56321**), never the shared 54322 stack and never prod.
  - `PSQL=/opt/homebrew/opt/libpq/bin/psql`
  - `DB=postgresql://postgres:postgres@127.0.0.1:56322/postgres`
  - Proofs run with `SUPABASE_DB_URL=$DB`.
- Commit after each task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. The post-commit hook may print `Killed: 9 python3 -c "import graphify"` — harmless.
- `supabase` CLI is `/Users/jamila/.local/bin/supabase`.

## File map

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/0206_patient_sources_report.sql` | create | types, list builders, section helpers, 5 wrappers, report RPC, ACLs, post-conditions |
| `scripts/fixtures/patient-sources-pre-0206.sql` | create | the five RPC bodies as they are on main, re-homed in schema `ps_old`, for the before/after proof |
| `scripts/patient-sources-db-proof.ts` | modify | seeded world, equivalence, report = wrappers, report gate/validation/ACL, controls, re-pointed control notes |
| `src/types/database.ts` | regenerate | new RPC + composite types |
| `src/lib/marketing/patient-sources.ts` | modify | `PatientSourcesReport` type + `parsePatientSourcesReport` |
| `src/lib/marketing/patient-sources.test.ts` | modify | parser tests |
| `src/lib/marketing/patient-sources.server.ts` | modify | `loadPatientSourcesReport` |
| `src/lib/marketing/patient-sources.server.test.ts` | modify | loader tests |
| `src/lib/marketing/patient-sources-surfaces.test.ts` | modify | new RPC name + page/CSV use the report loader |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx` | modify | one report call |
| `src/app/api/admin/reports/patient-sources.csv/route.ts` + `route.test.ts` | modify | one report call |
| `CLAUDE.md`, `docs/drmed-user-guide.html` | modify | ledger 0203/0204/0206; one guide sentence (version bump at merge time only) |

---

### Task 0: Worktree dependencies + isolated stack (controller runs this)

**Files:** none committed.

- [ ] **Step 1: Install dependencies**

Run: `cd /Users/jamila/Claude/DRMed/.worktrees/ps-report-bundle && npm ci > /private/tmp/claude-501/-Users-jamila/cf5b4733-06ca-4f97-8bac-de835cd7e214/scratchpad/npm-ci.log 2>&1; echo exit=$?`
Expected: `exit=0`.

- [ ] **Step 2: Start an isolated stack from a copy of `supabase/`**

```bash
SP=/private/tmp/claude-501/-Users-jamila/cf5b4733-06ca-4f97-8bac-de835cd7e214/scratchpad/ps-stack
rm -rf $SP && mkdir -p $SP && rsync -a --exclude .temp --exclude .branches supabase/ $SP/supabase/
mkdir -p $SP/supabase/.temp && echo 17.6.1.167 > $SP/supabase/.temp/postgres-version
node -e '
const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");
s=s.replace(/^project_id = ".*"$/m,"project_id = \"drmed-ps-report\"");
s=s.replace(/^(port|shadow_port) = 54(\d{3})$/gm,(m,k,n)=>`${k} = 56${n}`);
fs.writeFileSync(f,s);' $SP/supabase/config.toml
grep -n -E "^project_id|^(port|shadow_port) = " $SP/supabase/config.toml
/Users/jamila/.local/bin/supabase start --workdir $SP > $SP/start.log 2>&1; echo exit=$?
```
Expected: every port line shows `56xxx`; `exit=0`. The stack applies every migration on main (head **0204**).

- [ ] **Step 3: Confirm head and Postgres version**

Run: `$PSQL $DB -At -c "select max(version) from supabase_migrations.schema_migrations; select version();"`
Expected: `0204` and `PostgreSQL 17.6`.

- [ ] **Step 4: Confirm the existing proofs are green before any change**

Run: `SUPABASE_DB_URL=$DB npm run -s patient-sources:db-proof 2>&1 | tail -3`
Expected: `N/N checks passed.` (record N; 43 at the time of writing).

---

### Task 1: Freeze the pre-0206 RPC bodies as a fixture

**Files:**
- Create: `scripts/fixtures/patient-sources-pre-0206.sql`

- [ ] **Step 1: Generate the fixture from the stack at head 0204**

```bash
mkdir -p scripts/fixtures
{
  echo "-- The five Patient Sources report RPCs exactly as they were on main before 0206"
  echo "-- (generated with pg_get_functiondef from a stack at head 0204), re-homed in schema"
  echo "-- ps_old. scripts/patient-sources-db-proof.ts loads this INSIDE its rolled-back"
  echo "-- transaction and proves the 0206 wrappers return identical rows. Never applied anywhere."
  echo "create schema if not exists ps_old;"
  echo "grant usage on schema ps_old to authenticated;"
  $PSQL $DB -At -c "
    select string_agg(
             replace(pg_get_functiondef(p.oid),
                     'FUNCTION public.' || p.proname || '(',
                     'FUNCTION ps_old.' || p.proname || '(') || ';'
             || E'\ngrant execute on function ps_old.' || p.proname
             || '(' || pg_get_function_identity_arguments(p.oid) || ') to authenticated;',
             E'\n\n' order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('patient_sources_summary','patient_sources_series','patient_sources_revenue',
                        'patient_sources_overlaps','patient_sources_referrers')"
} > scripts/fixtures/patient-sources-pre-0206.sql
grep -c "CREATE OR REPLACE FUNCTION ps_old\." scripts/fixtures/patient-sources-pre-0206.sql
grep -c "FUNCTION public\.patient_sources_" scripts/fixtures/patient-sources-pre-0206.sql
```
Expected: `5` then `0`.

- [ ] **Step 2: Prove the fixture loads and rolls back cleanly**

Run: `$PSQL $DB -v ON_ERROR_STOP=1 -c "begin;" -f scripts/fixtures/patient-sources-pre-0206.sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ps_old'; rollback;"`
Expected: a count of `5`, no error.

- [ ] **Step 3: Commit**

```bash
git add scripts/fixtures/patient-sources-pre-0206.sql
git commit -m "test(patient-sources): freeze the pre-0206 report RPC bodies for the equivalence proof"
```

---

### Task 2: Proof checks for 0206 (written first — they must FAIL before the migration)

**Files:**
- Modify: `scripts/patient-sources-db-proof.ts`

Context: the proof runs everything in one transaction that is rolled back. `check(name, fn)` records PASS/FAIL; `scoped(fn)` always rolls back its savepoint; helpers `patient`, `visit`, `sheetLine`, `customerRow`, `facts`, `softDelete`, `asAdmin`, `setRole`, `expectPgError`, `expectOk`, `assert`, `q` already exist (lines ~150–480). Fixtures: `fx.adminId`, `fx.receptionId`, `fx.inactiveAdminId`, `fx.serviceId`, `fx.runId`.

- [ ] **Step 1: Add `patient_sources_report` to check 1's ACL matrix**

In check 1 ("ACL matrix - functions"), add to `FUNCS` after the `patient_sources_referrers` entry:

```ts
        { name: "patient_sources_report", sql: `select public.patient_sources_report('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text,null::date,null::date)` },
```

- [ ] **Step 2: Add the seeded world + comparison helpers**

Insert right after the `referrersRows` helper (before `await q("begin");`):

```ts
  // ---- 0206: a seeded world where every section is non-empty ----------
  // Dates straddle the three comparison periods below. Built inside a
  // scoped() check, so it never outlives that check.
  const P_EARLY = { from: "2023-12-01", to: "2024-01-31" };
  const P_JUNE = { from: "2026-06-01", to: "2026-06-30" };
  const P_LONG = { from: "2025-08-27", to: "2026-09-30" }; // exactly 400 days
  const PERIODS = [P_EARLY, P_JUNE, P_LONG];

  async function seedWorld(): Promise<void> {
    const sources = ["walk_in", "online_facebook", "online_google", null] as const;
    const days = ["2023-12-05", "2024-01-20", "2025-09-10", "2026-02-14", "2026-06-03", "2026-06-17", "2026-06-28", "2026-09-29"];
    // App-native patients, one per (source, day), with a priced visit that day.
    let n = 0;
    for (const source of sources) {
      for (const d of days) {
        n += 1;
        const id = await patient(`World${n}`, `App${n}`, { source: source ?? undefined, createdAt: `${d}T09:00:00+08:00` });
        await visit(id, d, 300 + n);
        if (n % 3 === 0) await visit(id, "2026-06-20", 150); // a repeat visit inside June
        if (n % 4 === 0) await q(`update public.patients set referred_by_doctor = $1 where id = $2`, [`Dr. World ${n % 3}`, id]);
      }
    }
    // Imported patient with a sheet registration + returning flag, linked sheet lines, and a same-day app visit (overlap).
    const imp = await patient("WorldImported", "Ivy", { source: "online_google", imported: true });
    await facts(imp, "2026-06-05", "repeat");
    await customerRow(looseKeyOf("WorldImported", "Ivy"), { patientId: imp, source: "online_google", registeredOn: "2026-06-05", referredBy: "Dr. Sheetworld" });
    await visit(imp, "2026-06-10", 500);
    await sheetLine("2026-06-10", looseKeyOf("WorldImported", "Ivy"), imp, 700);
    await sheetLine("2026-06-12", looseKeyOf("WorldImported", "Ivy"), imp, 200);
    // Merged pair: the duplicate's visit counts for the survivor.
    const surv = await patient("WorldMerge", "Sam", { source: "walk_in", createdAt: "2026-06-02T10:00:00+08:00" });
    const dup = await patient("WorldMerge", "Samuel", { source: "online_facebook", createdAt: "2026-06-04T10:00:00+08:00" });
    await visit(dup, "2026-06-06", 250);
    await q(`update public.patients set merged_into_id = $1 where id = $2`, [surv, dup]);
    // Deleted patient: must drop out everywhere.
    const del = await patient("WorldDeleted", "Dee", { source: "walk_in", createdAt: "2026-06-08T10:00:00+08:00" });
    await visit(del, "2026-06-08", 999);
    await softDelete(del);
    // Unlinked sheet names (unconfirmed), one with a single Customers row + referrer, one lines-only.
    await customerRow(looseKeyOf("WorldSheet", "Una"), { source: "online_facebook", registeredOn: "2026-06-09", referredBy: "Dr. World 1" });
    await sheetLine("2026-06-15", looseKeyOf("WorldSheet", "Una"), null, 400);
    await sheetLine("2025-10-01", looseKeyOf("WorldSheet", "Lina"), null, 120);
    await sheetLine("2026-06-15", looseKeyOf("WorldSheet", "Lina"), null, 80);
    // Registration-only (no visit) and undated (no date at all) patients.
    const regOnly = await patient("WorldRegOnly", "Rae", { imported: true });
    await facts(regOnly, "2026-06-21", "new");
    await patient("WorldUndated", "Uri", { imported: true });
    // Pre-window visitor with a later registration: never New.
    const old = await patient("WorldOld", "Ola", { source: "walk_in", createdAt: "2026-06-11T10:00:00+08:00" });
    await visit(old, "2023-06-01", 100);
  }

  // Both sides go through node-pg's jsonb parsing (so numeric 1500.00 and 1500
  // both become 1500) and are sorted AFTER that, in JS — sorting on jsonb text
  // in SQL would order "1500.00" and "1500" differently.
  const canon = (rows: unknown[]) => JSON.stringify(rows.map((x) => JSON.stringify(x)).sort());
  /** Canonical, order-insensitive JSON of a set-returning call. */
  async function rowsJson(sql: string, params: unknown[]): Promise<string> {
    const r = await q<{ j: unknown }>(`select to_jsonb(t) as j from (${sql}) t`, params);
    return canon(r.rows.map((x) => x.j));
  }
  /** Canonical JSON of a report section (already parsed jsonb). */
  async function sortedJson(arr: unknown): Promise<string> {
    return canon(Array.isArray(arr) ? arr : []);
  }
  /** Every (function, args) the page and CSV use, per period. `schema` is 'public' or 'ps_old'. */
  function gridCalls(schema: "public" | "ps_old", p: { from: string; to: string }) {
    const calls: { label: string; sql: string; params: unknown[] }[] = [
      { label: "summary", sql: `select * from ${schema}.patient_sources_summary($1, $2)`, params: [p.from, p.to] },
      { label: "revenue", sql: `select * from ${schema}.patient_sources_revenue($1, $2)`, params: [p.from, p.to] },
      { label: "overlaps", sql: `select * from ${schema}.patient_sources_overlaps($1, $2)`, params: [p.from, p.to] },
      { label: "referrers", sql: `select * from ${schema}.patient_sources_referrers($1, $2, 20)`, params: [p.from, p.to] },
      { label: "referrers limit 1", sql: `select * from ${schema}.patient_sources_referrers($1, $2, 1)`, params: [p.from, p.to] },
    ];
    for (const grain of ["day", "week", "month", "period"]) {
      for (const mode of ["new", "served"]) {
        calls.push({ label: `series ${grain}/${mode}`, sql: `select * from ${schema}.patient_sources_series($1, $2, $3, $4)`, params: [p.from, p.to, grain, mode] });
      }
    }
    return calls;
  }
```

- [ ] **Step 3: Add the 0206 checks at the end of the check list**

Insert immediately before the closing `} finally {` of the main `try` (after the last "0199 control" check):

```ts
    // ---- 0206: one call per page view ---------------------------------
    await check("0206: seeded world makes every section non-empty", () => scoped(async () => {
      await seedWorld();
      await asAdmin();
      for (const p of PERIODS) {
        for (const c of gridCalls("public", p)) {
          if (c.label.startsWith("overlaps") && p !== P_JUNE) continue; // overlaps only seeded in June
          if (c.label.startsWith("referrers") && p === P_EARLY) continue; // no referrers seeded that early
          const n = Number((await q<{ n: string }>(`select count(*)::text as n from (${c.sql}) t`, c.params)).rows[0].n);
          assert(n > 0, `${c.label} ${p.from}..${p.to} is empty — the equivalence below would be vacuous`);
        }
      }
    }));

    await check("0206: every wrapper returns exactly the pre-0206 rows", () => scoped(async () => {
      await q(fs.readFileSync(path.join(__dirname, "fixtures/patient-sources-pre-0206.sql"), "utf8"));
      await seedWorld();
      await asAdmin();
      const diffs: string[] = [];
      for (const p of PERIODS) {
        const now = gridCalls("public", p);
        const old = gridCalls("ps_old", p);
        for (let i = 0; i < now.length; i++) {
          const a = await rowsJson(now[i].sql, now[i].params);
          const b = await rowsJson(old[i].sql, old[i].params);
          if (a !== b) diffs.push(`${now[i].label} ${p.from}..${p.to}: new=${a.slice(0, 300)} old=${b.slice(0, 300)}`);
        }
      }
      assert(diffs.length === 0, `wrappers differ from the pre-0206 bodies:\n${diffs.join("\n")}`);
    }));

    await check("0206: report sections equal the single RPCs (with and without a previous period)", () => scoped(async () => {
      await seedWorld();
      await asAdmin();
      const cases = [
        { p: P_JUNE, grain: "day", mode: "new", prev: { from: "2026-05-02", to: "2026-05-31" } },
        { p: P_JUNE, grain: "week", mode: "served", prev: null },
        { p: P_LONG, grain: "month", mode: "served", prev: { from: "2024-07-23", to: "2025-08-26" } },
        { p: P_EARLY, grain: "day", mode: "served", prev: null },
      ];
      for (const c of cases) {
        const tag = `${c.p.from}..${c.p.to} ${c.grain}/${c.mode} prev=${c.prev ? "set" : "null"}`;
        const rep = (await q<{ r: Record<string, unknown> }>(
          `select public.patient_sources_report($1, $2, $3, $4, $5, $6) as r`,
          [c.p.from, c.p.to, c.grain, c.mode, c.prev?.from ?? null, c.prev?.to ?? null])).rows[0].r;
        assert(rep && typeof rep === "object", `${tag}: report returned ${JSON.stringify(rep)}`);
        const keys = Object.keys(rep).sort().join(",");
        assert(keys === "current,new_by_day,overlaps,previous,referrers,revenue,series,summary", `${tag}: sections are ${keys}`);
        const same = async (label: string, section: unknown, sql: string, params: unknown[]) => {
          const a = await sortedJson(section);
          const b = await rowsJson(sql, params);
          assert(a === b, `${tag} ${label}: report=${a.slice(0, 300)} rpc=${b.slice(0, 300)}`);
        };
        await same("summary", [rep.summary], `select * from public.patient_sources_summary($1,$2)`, [c.p.from, c.p.to]);
        await same("series", rep.series, `select * from public.patient_sources_series($1,$2,$3,$4)`, [c.p.from, c.p.to, c.grain, c.mode]);
        await same("current", rep.current, `select * from public.patient_sources_series($1,$2,'period',$3)`, [c.p.from, c.p.to, c.mode]);
        await same("new_by_day", rep.new_by_day, `select * from public.patient_sources_series($1,$2,'day','new')`, [c.p.from, c.p.to]);
        await same("revenue", rep.revenue, `select * from public.patient_sources_revenue($1,$2)`, [c.p.from, c.p.to]);
        await same("overlaps", rep.overlaps, `select * from public.patient_sources_overlaps($1,$2)`, [c.p.from, c.p.to]);
        await same("referrers", rep.referrers, `select * from public.patient_sources_referrers($1,$2,20)`, [c.p.from, c.p.to]);
        if (c.prev) {
          await same("previous", rep.previous, `select * from public.patient_sources_series($1,$2,'period',$3)`, [c.prev.from, c.prev.to, c.mode]);
        } else {
          assert(rep.previous === null, `${tag}: previous must be null without a previous period, got ${JSON.stringify(rep.previous)}`);
        }
        // Order is part of the contract (the page renders arrays as given).
        const series = rep.series as { bucket_start: string; channel: string }[];
        const sorted = [...series].sort((x, y) => (x.bucket_start + x.channel < y.bucket_start + y.channel ? -1 : 1));
        assert(JSON.stringify(series) === JSON.stringify(sorted), `${tag}: series is not ordered by bucket_start, channel`);
        const refs = (rep.referrers as { doctor_label: string }[]).map((r) => r.doctor_label);
        const rpcRefs = (await q<{ doctor_label: string }>(`select doctor_label from public.patient_sources_referrers($1,$2,20)`, [c.p.from, c.p.to])).rows.map((r) => r.doctor_label);
        assert(JSON.stringify(refs) === JSON.stringify(rpcRefs), `${tag}: referrers order ${JSON.stringify(refs)} vs ${JSON.stringify(rpcRefs)}`);
      }
    }));

    await check("0206: report gate matrix", () => scoped(async () => {
      const sql = `select public.patient_sources_report('2026-06-01'::date,'2026-06-30'::date,'day'::text,'new'::text,null::date,null::date)`;
      await setRole("anon", null);
      await expectPgError("anon", "42501", () => q(sql));
      await setRole("authenticated", { sub: fx.receptionId, role: "authenticated" });
      await expectPgError("reception", "42501", () => q(sql));
      await setRole("authenticated", { sub: fx.inactiveAdminId, role: "authenticated" });
      await expectPgError("inactive admin", "42501", () => q(sql));
      await setRole("authenticated", null);
      await expectPgError("no JWT claims at all", "42501", () => q(sql));
      await setRole("authenticated", { sub: fx.receptionId, role: "authenticated", app_metadata: { role: "service_role" } });
      await expectPgError("authenticated with a service_role app_metadata", "42501", () => q(sql));
      await setRole("postgres", null);
      await q(`update public.staff_profiles set view_as_role = 'reception', view_as_until = now() + interval '1 hour' where id = $1`, [fx.adminId]);
      try {
        await asAdmin();
        await expectPgError("admin viewing as reception", "42501", () => q(sql));
      } finally {
        await setRole("postgres", null);
        await q(`update public.staff_profiles set view_as_role = null, view_as_until = null where id = $1`, [fx.adminId]);
      }
      await asAdmin();
      await expectOk("admin", () => q(sql));
      await setRole("service_role", { role: "service_role" });
      const svc = await expectOk("service_role", () => q<{ r: unknown }>(sql + " as r"));
      await asAdmin();
      const adm = await q<{ r: unknown }>(sql + " as r");
      assert(JSON.stringify(svc.rows[0].r) === JSON.stringify(adm.rows[0].r), "service_role and admin must read the same report");
    }));

    await check("0206: report refuses bad input with today's codes", () => scoped(async () => {
      await asAdmin();
      const call = (a: unknown[]) => q(`select public.patient_sources_report($1::date,$2::date,$3::text,$4::text,$5::date,$6::date)`, a);
      await expectPgError("bad grain", "22023", () => call(["2026-06-01", "2026-06-30", "year", "new", null, null]));
      await expectPgError("null grain", "22023", () => call(["2026-06-01", "2026-06-30", null, "new", null, null]));
      await expectPgError("bad mode", "22023", () => call(["2026-06-01", "2026-06-30", "day", "converted", null, null]));
      await expectPgError("period over 400 days", "22023", () => call(["2025-01-01", "2026-06-30", "day", "new", null, null]));
      await expectPgError("start before 2023-12-01", "22023", () => call(["2023-11-30", "2023-12-31", "day", "new", null, null]));
      await expectPgError("reversed period", "22023", () => call(["2026-06-30", "2026-06-01", "day", "new", null, null]));
      await expectPgError("half a previous period (from only)", "22023", () => call(["2026-06-01", "2026-06-30", "day", "new", "2026-05-01", null]));
      await expectPgError("half a previous period (to only)", "22023", () => call(["2026-06-01", "2026-06-30", "day", "new", null, "2026-05-31"]));
      await expectPgError("previous period before 2023-12-01", "22023", () => call(["2023-12-01", "2023-12-31", "day", "new", "2023-11-01", "2023-11-30"]));
    }));

    await check("0206: helpers and list builders are closed; row types match their producers", () => scoped(async () => {
      const closed = [
        "public._ps_identity_list()", "public._ps_encounter_list()", "public._ps_revenue_line_list(date,date)",
        "public._ps_sec_summary(public._ps_identity[],public._ps_encounter[],date,date)",
        "public._ps_sec_series(public._ps_identity[],public._ps_encounter[],date,date,text,text)",
        "public._ps_sec_revenue(public._ps_identity[],public._ps_revenue_line[])",
        "public._ps_sec_overlaps(public._ps_revenue_line[])",
        "public._ps_sec_referrers(public._ps_identity[],date,date,integer)",
      ];
      for (const fn of closed) {
        const r = await q<{ a: boolean; u: boolean; s: boolean; sd: boolean }>(
          `select has_function_privilege('anon', $1, 'execute') as a,
                  has_function_privilege('authenticated', $1, 'execute') as u,
                  has_function_privilege('service_role', $1, 'execute') as s,
                  (select p.prosecdef from pg_proc p where p.oid = $1::regprocedure) as sd`, [fn]);
        const x = r.rows[0];
        assert(!x.a && !x.u && !x.s, `${fn} must be closed to anon/authenticated/service_role, got ${JSON.stringify(x)}`);
        assert(!x.sd, `${fn} must not be SECURITY DEFINER`);
      }
      const pairs: [string, string][] = [
        ["public._ps_identity", "public._patient_sources_identities()"],
        ["public._ps_encounter", "public._patient_sources_encounters()"],
        ["public._ps_revenue_line", "public._ps_revenue_lines(date,date)"],
      ];
      for (const [typ, fn] of pairs) {
        const r = await q<{ t: string; f: string }>(
          `select 'TABLE(' || (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
                                 from pg_attribute a where a.attrelid = (select typrelid from pg_type where oid = $1::regtype)
                                   and a.attnum > 0 and not a.attisdropped) || ')' as t,
                  pg_get_function_result($2::regprocedure) as f`, [typ, fn]);
        assert(r.rows[0].t === r.rows[0].f, `${typ} ${r.rows[0].t} does not match ${fn} ${r.rows[0].f}`);
      }
      const rep = await q<{ a: boolean; u: boolean; s: boolean; sd: boolean; gate: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as a,
                has_function_privilege('authenticated', $1, 'execute') as u,
                has_function_privilege('service_role', $1, 'execute') as s,
                (select p.prosecdef from pg_proc p where p.oid = $1::regprocedure) as sd,
                pg_get_functiondef($1::regprocedure) like '%coalesce((select auth.role()), '''') = ''service_role''%' as gate`,
        ["public.patient_sources_report(date,date,text,text,date,date)"]);
      const x = rep.rows[0];
      assert(!x.a && x.u && x.s && x.sd && x.gate, `patient_sources_report ACL/definer/gate wrong: ${JSON.stringify(x)}`);
    }));
```

(`fs` and `path` are already imported at the top of the file.)

- [ ] **Step 4: Run it — the new checks must FAIL, everything else PASS**

Run: `SUPABASE_DB_URL=$DB npm run -s patient-sources:db-proof 2>&1 | grep -E "^(FAIL|[0-9]+/)"`
Expected: FAIL for check 1 (`patient_sources_report` does not exist), "report sections equal…", "report gate matrix", "report refuses bad input", "helpers and list builders are closed…" (all `42883`/function-does-not-exist). PASS for "seeded world makes every section non-empty" and "every wrapper returns exactly the pre-0206 rows" (old = new before the migration — that is expected). If "seeded world" FAILs, fix `seedWorld()` until every section is non-empty — do not weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add scripts/patient-sources-db-proof.ts
git commit -m "test(patient-sources): 0206 proof — seeded world, before/after equivalence, report checks (red)"
```

---

### Task 3: Migration 0206

**Files:**
- Create: `supabase/migrations/0206_patient_sources_report.sql`

- [ ] **Step 1: Write the migration**

Each helper body below is the live body of the named function with ONLY the source swapped: `public._patient_sources_identities()` → `unnest(p_ids)`, `public._patient_sources_encounters()` → `unnest(p_enc)`, `public._ps_revenue_lines(p_from, p_to)` → `unnest(p_lines)`. Before saving, diff each helper against its source (0199 summary/series lines 56–93 / 116–142, 0189 revenue/overlaps lines 510–553, 0193 referrers lines 752–782) and confirm nothing else changed.

```sql
-- 0206_patient_sources_report.sql
--
-- Sheet Sync extra (b): the Patient Sources page built the identity core
-- (_patient_sources_identities, ~185 ms on prod) once PER RPC — 8+ times per
-- page view, more when a series paged past 1,000 rows — and read 8 different
-- snapshots. This migration:
--   * adds row types + list builders so the identity core, encounters and
--     revenue lines can be built ONCE and handed around as arrays;
--   * moves each section's rule, verbatim, into one internal helper over those
--     arrays (_ps_sec_*), so every number has exactly one definition;
--   * re-creates the five report RPCs as wrappers (same signature, columns,
--     gate, validation order, ACL, SECURITY DEFINER, search_path);
--   * adds patient_sources_report(from, to, grain, mode, prev_from, prev_to)
--     returning every section of the page as one jsonb from one snapshot.
-- The identity core, encounters, revenue lines and patient_sources_people are
-- NOT changed. Additive + create-or-replace with identical signatures: the live
-- app keeps working whether this lands before or after the deploy.

-- 1. Row types (must match their producers; post-condition below).
create type public._ps_identity as (
  identity text, confirmed boolean, survivor_id uuid, loose_key text, first_date date,
  basis text, is_returning boolean, channel text, referrer_raw text
);
create type public._ps_encounter as (
  identity text, survivor_id uuid, loose_key text, service_date date, source text
);
create type public._ps_revenue_line as (
  identity text, survivor_id uuid, service_date date, source text, php numeric, overlap boolean
);

-- 2. List builders.
create or replace function public._ps_identity_list()
returns public._ps_identity[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(row(i.identity, i.confirmed, i.survivor_id, i.loose_key, i.first_date,
                                i.basis, i.is_returning, i.channel, i.referrer_raw)::public._ps_identity),
                  '{}'::public._ps_identity[])
  from public._patient_sources_identities() i
$$;

create or replace function public._ps_encounter_list()
returns public._ps_encounter[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(row(e.identity, e.survivor_id, e.loose_key, e.service_date, e.source)::public._ps_encounter),
                  '{}'::public._ps_encounter[])
  from public._patient_sources_encounters() e
$$;

create or replace function public._ps_revenue_line_list(p_from date, p_to date)
returns public._ps_revenue_line[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(row(l.identity, l.survivor_id, l.service_date, l.source, l.php, l.overlap)::public._ps_revenue_line),
                  '{}'::public._ps_revenue_line[])
  from public._ps_revenue_lines(p_from, p_to) l
$$;

-- 3. Section helpers (no gate: callers gate and validate).
create or replace function public._ps_sec_summary(
  p_ids public._ps_identity[], p_enc public._ps_encounter[], p_from date, p_to date)
returns table (
  new_confirmed            int,
  new_unconfirmed          int,
  returning_first_recorded int,
  served_confirmed         int,
  served_unconfirmed       int,
  undated_registrations    int,
  source_recorded          int,
  source_total             int,
  sheet_last_dates         jsonb,
  sync_paused              boolean,
  last_synced_at           timestamptz,
  sheet_rows_present       boolean,
  last_run_status          text
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
  newish as (
    select * from ids i
    where i.basis in ('encounter', 'registration') and i.first_date between p_from and p_to
  ),
  served as (
    select distinct e.identity from unnest(p_enc) e
    where e.service_date between p_from and p_to
  )
  select
    (select count(*) from newish n where n.confirmed and not n.is_returning)::int,
    (select count(*) from newish n where not n.confirmed)::int,
    (select count(*) from newish n where n.confirmed and n.is_returning)::int,
    (select count(*) from served s where s.identity like 'patient:%')::int,
    (select count(*) from served s where s.identity like 'name:%')::int,
    (select count(*) from ids i where i.basis = 'undated')::int,
    (select count(*) from newish n where not n.is_returning and n.channel <> 'not_recorded')::int,
    (select count(*) from newish n where not n.is_returning)::int,
    (select coalesce(jsonb_object_agg(t.tab, t.last_date), '{}'::jsonb)
       from (select l.tab, max(l.service_date) as last_date
               from public.sheet_encounter_lines l group by l.tab
             union all
             select 'customers', max(c.registered_on)
               from public.sheet_customer_rows c having count(*) > 0) t),
    (select s.paused from public.sheet_sync_settings s where s.id),
    (select max(r.ended_at) from public.sheet_sync_runs r
      where r.status in ('succeeded', 'partial') and not r.dry_run and r.trigger in ('cron', 'manual', 'cli')),
    (exists (select 1 from public.sheet_encounter_lines) or exists (select 1 from public.sheet_customer_rows)),
    (select r.status from public.sheet_sync_runs r
      where not r.dry_run and r.trigger in ('cron', 'manual', 'cli')
        and r.status in ('succeeded', 'partial', 'failed')
      order by r.started_at desc, r.id desc
      limit 1);
end;
$$;

create or replace function public._ps_sec_series(
  p_ids public._ps_identity[], p_enc public._ps_encounter[], p_from date, p_to date, p_grain text, p_mode text)
returns table (bucket_start date, channel text, confirmed int, unconfirmed int)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_mode = 'new' then
    return query
    select public._ps_bucket(i.first_date, p_grain, p_from), i.channel,
           (count(*) filter (where i.confirmed))::int,
           (count(*) filter (where not i.confirmed))::int
    from unnest(p_ids) i
    where i.basis in ('encounter', 'registration')
      and not i.is_returning
      and i.first_date between p_from and p_to
    group by 1, 2
    order by 1, 2;
  else
    return query
    with served as (
      select distinct public._ps_bucket(e.service_date, p_grain, p_from) as b, e.identity
      from unnest(p_enc) e
      where e.service_date between p_from and p_to
    )
    select s.b, i.channel,
           (count(*) filter (where i.confirmed))::int,
           (count(*) filter (where not i.confirmed))::int
    from served s
    join unnest(p_ids) i on i.identity = s.identity
    group by 1, 2
    order by 1, 2;
  end if;
end;
$$;

create or replace function public._ps_sec_revenue(p_ids public._ps_identity[], p_lines public._ps_revenue_line[])
returns table (channel text, confirmed_php numeric, unconfirmed_php numeric)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  select i.channel,
         coalesce(sum(l.php) filter (where i.confirmed), 0)::numeric(14,2),
         coalesce(sum(l.php) filter (where not i.confirmed), 0)::numeric(14,2)
  from unnest(p_lines) l
  join unnest(p_ids) i on i.identity = l.identity
  where not l.overlap
  group by i.channel
  order by i.channel;
end;
$$;

create or replace function public._ps_sec_overlaps(p_lines public._ps_revenue_line[])
returns table (patient_id uuid, drm_id text, service_date date, app_php numeric, sheet_php numeric)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with lines as (
    select * from unnest(p_lines)
  )
  select s.survivor_id, p.drm_id, s.service_date,
         coalesce((select sum(a.php) from lines a
                    where a.source = 'app' and a.survivor_id = s.survivor_id
                      and a.service_date = s.service_date), 0)::numeric(14,2),
         sum(s.php)::numeric(14,2)
  from lines s
  join public.patients p on p.id = s.survivor_id
  where s.source = 'sheet' and s.overlap
  group by s.survivor_id, p.drm_id, s.service_date
  order by s.service_date, p.drm_id;
end;
$$;

create or replace function public._ps_sec_referrers(p_ids public._ps_identity[], p_from date, p_to date, p_limit int)
returns table (doctor_label text, new_confirmed int, new_unconfirmed int)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with ids as (
    select * from unnest(p_ids) i
    where i.basis in ('encounter', 'registration') and not i.is_returning
      and i.first_date between p_from and p_to
  ),
  raw as (
    select i.confirmed, i.referrer_raw as raw_label from ids i
  ),
  normed as (
    select r.confirmed, btrim(r.raw_label) as spelling, public._ps_doctor_norm(r.raw_label) as k
    from raw r where r.raw_label is not null
  ),
  spellings as (
    select n.k, n.spelling, count(*) as c from normed n where n.k is not null group by n.k, n.spelling
  ),
  labels as (
    select distinct on (s.k) s.k, s.spelling from spellings s order by s.k, s.c desc, s.spelling
  )
  select l.spelling,
         (count(*) filter (where n.confirmed))::int,
         (count(*) filter (where not n.confirmed))::int
  from normed n
  join labels l on l.k = n.k
  group by l.k, l.spelling
  order by count(*) desc, l.spelling
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;

-- 4. The five RPCs as wrappers (signatures, gates, validation order unchanged).
create or replace function public.patient_sources_summary(p_from date, p_to date)
returns table (
  new_confirmed            int,
  new_unconfirmed          int,
  returning_first_recorded int,
  served_confirmed         int,
  served_unconfirmed       int,
  undated_registrations    int,
  source_recorded          int,
  source_total             int,
  sheet_last_dates         jsonb,
  sync_paused              boolean,
  last_synced_at           timestamptz,
  sheet_rows_present       boolean,
  last_run_status          text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (public.has_role(array['admin']) or coalesce((select auth.role()), '') = 'service_role') then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  return query
  select * from public._ps_sec_summary(public._ps_identity_list(), public._ps_encounter_list(), p_from, p_to);
end;
$$;

create or replace function public.patient_sources_series(p_from date, p_to date, p_grain text, p_mode text)
returns table (bucket_start date, channel text, confirmed int, unconfirmed int)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (public.has_role(array['admin']) or coalesce((select auth.role()), '') = 'service_role') then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  if p_grain is null or p_grain not in ('day', 'week', 'month', 'period') then
    raise exception 'Unknown grouping %', coalesce(p_grain, '(none)') using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('new', 'served') then
    raise exception 'Unknown count %', coalesce(p_mode, '(none)') using errcode = '22023';
  end if;
  return query
  select * from public._ps_sec_series(
    public._ps_identity_list(),
    -- 'new' never reads encounters directly: skip building them.
    case when p_mode = 'served' then public._ps_encounter_list() else '{}'::public._ps_encounter[] end,
    p_from, p_to, p_grain, p_mode);
end;
$$;

create or replace function public.patient_sources_revenue(p_from date, p_to date)
returns table (channel text, confirmed_php numeric, unconfirmed_php numeric)
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
  return query
  select * from public._ps_sec_revenue(public._ps_identity_list(), public._ps_revenue_line_list(p_from, p_to));
end;
$$;

create or replace function public.patient_sources_overlaps(p_from date, p_to date)
returns table (patient_id uuid, drm_id text, service_date date, app_php numeric, sheet_php numeric)
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
  return query
  select * from public._ps_sec_overlaps(public._ps_revenue_line_list(p_from, p_to));
end;
$$;

create or replace function public.patient_sources_referrers(p_from date, p_to date, p_limit int default 20)
returns table (doctor_label text, new_confirmed int, new_unconfirmed int)
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
  return query
  select * from public._ps_sec_referrers(public._ps_identity_list(), p_from, p_to, p_limit);
end;
$$;

-- 5. The page's one call.
create or replace function public.patient_sources_report(
  p_from date, p_to date, p_grain text, p_mode text,
  p_prev_from date default null, p_prev_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids   public._ps_identity[];
  v_enc   public._ps_encounter[];
  v_lines public._ps_revenue_line[];
begin
  -- Same gate as summary/series (0199): the coalesce is load-bearing — without
  -- it a session with no role claim fails OPEN. The server key may read every
  -- section (Phase 5's weekly email); it already bypasses RLS everywhere.
  if not (public.has_role(array['admin']) or coalesce((select auth.role()), '') = 'service_role') then
    raise exception 'Patient Sources is for admins only' using errcode = '42501';
  end if;
  perform public._ps_assert_mirror_mode();
  perform public._ps_check_period(p_from, p_to);
  if p_grain is null or p_grain not in ('day', 'week', 'month', 'period') then
    raise exception 'Unknown grouping %', coalesce(p_grain, '(none)') using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('new', 'served') then
    raise exception 'Unknown count %', coalesce(p_mode, '(none)') using errcode = '22023';
  end if;
  if (p_prev_from is null) <> (p_prev_to is null) then
    raise exception 'Pick both ends of the comparison period, or neither' using errcode = '22023';
  end if;
  if p_prev_from is not null then
    perform public._ps_check_period(p_prev_from, p_prev_to);
  end if;

  v_ids := public._ps_identity_list();
  v_enc := public._ps_encounter_list();
  v_lines := public._ps_revenue_line_list(p_from, p_to);

  return jsonb_build_object(
    'summary',
      (select to_jsonb(s) from public._ps_sec_summary(v_ids, v_enc, p_from, p_to) s),
    'series',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start, x.channel), '[]'::jsonb)
         from public._ps_sec_series(v_ids, v_enc, p_from, p_to, p_grain, p_mode) x),
    'current',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start, x.channel), '[]'::jsonb)
         from public._ps_sec_series(v_ids, v_enc, p_from, p_to, 'period', p_mode) x),
    'previous',
      case when p_prev_from is null then null else
        (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start, x.channel), '[]'::jsonb)
           from public._ps_sec_series(v_ids, v_enc, p_prev_from, p_prev_to, 'period', p_mode) x)
      end,
    'new_by_day',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start, x.channel), '[]'::jsonb)
         from public._ps_sec_series(v_ids, v_enc, p_from, p_to, 'day', 'new') x),
    'revenue',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.channel), '[]'::jsonb)
         from public._ps_sec_revenue(v_ids, v_lines) x),
    'overlaps',
      (select coalesce(jsonb_agg(to_jsonb(x) order by x.service_date, x.drm_id), '[]'::jsonb)
         from public._ps_sec_overlaps(v_lines) x),
    'referrers',
      -- Keep the helper's own order (count desc, spelling): WITH ORDINALITY.
      (select coalesce(jsonb_agg(jsonb_build_object(
                'doctor_label', x.doctor_label, 'new_confirmed', x.new_confirmed,
                'new_unconfirmed', x.new_unconfirmed) order by x.ord), '[]'::jsonb)
         from public._ps_sec_referrers(v_ids, p_from, p_to, 20)
              with ordinality as x(doctor_label, new_confirmed, new_unconfirmed, ord))
  );
end;
$$;

-- 6. ACLs.
revoke all on function public._ps_identity_list() from public, anon, authenticated, service_role;
revoke all on function public._ps_encounter_list() from public, anon, authenticated, service_role;
revoke all on function public._ps_revenue_line_list(date, date) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_summary(public._ps_identity[], public._ps_encounter[], date, date) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_series(public._ps_identity[], public._ps_encounter[], date, date, text, text) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_revenue(public._ps_identity[], public._ps_revenue_line[]) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_overlaps(public._ps_revenue_line[]) from public, anon, authenticated, service_role;
revoke all on function public._ps_sec_referrers(public._ps_identity[], date, date, int) from public, anon, authenticated, service_role;

revoke all on function public.patient_sources_summary(date, date) from public, anon;
revoke all on function public.patient_sources_series(date, date, text, text) from public, anon;
revoke all on function public.patient_sources_revenue(date, date) from public, anon;
revoke all on function public.patient_sources_overlaps(date, date) from public, anon;
revoke all on function public.patient_sources_referrers(date, date, int) from public, anon;
revoke all on function public.patient_sources_report(date, date, text, text, date, date) from public, anon;
grant execute on function public.patient_sources_summary(date, date) to authenticated, service_role;
grant execute on function public.patient_sources_series(date, date, text, text) to authenticated, service_role;
grant execute on function public.patient_sources_revenue(date, date) to authenticated;
grant execute on function public.patient_sources_overlaps(date, date) to authenticated;
grant execute on function public.patient_sources_referrers(date, date, int) to authenticated;
grant execute on function public.patient_sources_report(date, date, text, text, date, date) to authenticated, service_role;

-- 7. Post-conditions: abort the deploy if anything is not what this file says.
do $$
declare
  f text;
  v_pair text[];
begin
  foreach f in array array[
    'public._ps_identity_list()', 'public._ps_encounter_list()', 'public._ps_revenue_line_list(date,date)',
    'public._ps_sec_summary(public._ps_identity[],public._ps_encounter[],date,date)',
    'public._ps_sec_series(public._ps_identity[],public._ps_encounter[],date,date,text,text)',
    'public._ps_sec_revenue(public._ps_identity[],public._ps_revenue_line[])',
    'public._ps_sec_overlaps(public._ps_revenue_line[])',
    'public._ps_sec_referrers(public._ps_identity[],date,date,integer)'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('service_role', f, 'execute') then
      raise exception '0206: internal % is executable by a runtime role', f;
    end if;
  end loop;

  foreach f in array array[
    'public.patient_sources_summary(date,date)', 'public.patient_sources_series(date,date,text,text)',
    'public.patient_sources_revenue(date,date)', 'public.patient_sources_overlaps(date,date)',
    'public.patient_sources_referrers(date,date,integer)',
    'public.patient_sources_report(date,date,text,text,date,date)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception '0206: % is executable by anon', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '0206: % is not executable by authenticated', f;
    end if;
    if not (select p.prosecdef from pg_proc p where p.oid = f::regprocedure) then
      raise exception '0206: % lost SECURITY DEFINER', f;
    end if;
  end loop;

  foreach f in array array[
    'public.patient_sources_summary(date,date)', 'public.patient_sources_series(date,date,text,text)',
    'public.patient_sources_report(date,date,text,text,date,date)'
  ] loop
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception '0206: % is not executable by service_role', f;
    end if;
    if pg_get_functiondef(f::regprocedure) not like '%coalesce((select auth.role()), '''') = ''service_role''%' then
      raise exception '0206: % does not carry the coalesced service_role gate', f;
    end if;
  end loop;

  foreach f in array array[
    'public.patient_sources_revenue(date,date)', 'public.patient_sources_overlaps(date,date)',
    'public.patient_sources_referrers(date,date,integer)'
  ] loop
    if pg_get_functiondef(f::regprocedure) like '%service_role%' then
      raise exception '0206: % must stay admin-only', f;
    end if;
  end loop;

  foreach v_pair slice 1 in array array[
    ['public._ps_identity', 'public._patient_sources_identities()'],
    ['public._ps_encounter', 'public._patient_sources_encounters()'],
    ['public._ps_revenue_line', 'public._ps_revenue_lines(date,date)']
  ] loop
    if 'TABLE(' || (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
                      from pg_attribute a
                      where a.attrelid = (select t.typrelid from pg_type t where t.oid = v_pair[1]::regtype)
                        and a.attnum > 0 and not a.attisdropped) || ')'
       is distinct from pg_get_function_result(v_pair[2]::regprocedure) then
      raise exception '0206: type % does not match %', v_pair[1], v_pair[2];
    end if;
  end loop;
end;
$$;
```

- [ ] **Step 2: Apply to the isolated stack**

Run: `$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/migrations/0206_patient_sources_report.sql > /dev/null && echo applied`
Expected: `applied` (post-conditions passed). If a post-condition raises, fix the migration, then re-apply (the `create type` statements fail on re-apply: first run `$PSQL $DB -c "drop function if exists public.patient_sources_report(date,date,text,text,date,date); drop type if exists public._ps_identity, public._ps_encounter, public._ps_revenue_line cascade;"` — `cascade` also drops the helpers/builders, which the file re-creates; the five wrappers must then be re-applied by the same file, which it does).

- [ ] **Step 3: Run the proof — all green**

Run: `SUPABASE_DB_URL=$DB npm run -s patient-sources:db-proof 2>&1 | grep -E "^(FAIL|[0-9]+/)"`
Expected: no FAIL lines; `N+6/N+6 checks passed.` (N from Task 0 Step 4).

- [ ] **Step 4: Sheet-sync proof still green**

Run: `SUPABASE_DB_URL=$DB npm run -s sheet-sync:db-proof 2>&1 | tail -2`
Expected: `…/… checks passed.` with no FAIL.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0206_patient_sources_report.sql
git commit -m "feat(db): 0206 — Patient Sources builds the identity core once per page view (patient_sources_report)"
```

---

### Task 4: Controls — prove the new proof can fail, and re-point the old control notes

**Files:**
- Modify: `scripts/patient-sources-db-proof.ts` (header comment only)

For each control: edit the LOCAL file `supabase/migrations/0206_patient_sources_report.sql`, reset the objects, re-apply, run the proof, record the FAIL line, revert, re-apply. Reset + apply command (use every time):

```bash
reapply() { $PSQL $DB -q -c "drop function if exists public.patient_sources_report(date,date,text,text,date,date); drop type if exists public._ps_identity, public._ps_encounter, public._ps_revenue_line cascade;" && $PSQL $DB -q -v ON_ERROR_STOP=1 -f supabase/migrations/0206_patient_sources_report.sql > /dev/null && echo reapplied; }
```

- [ ] **Step 1: Control M — report drops a section.** In `patient_sources_report`, delete the `'overlaps', (…),` entry. `reapply`; run the proof. Expected: `FAIL 0206: report sections equal the single RPCs … sections are current,new_by_day,previous,referrers,revenue,series,summary`. Revert, `reapply`.

- [ ] **Step 2: Control N — `current` uses the wrong mode.** In the report's `'current'` entry change `'period', p_mode` → `'period', 'new'`. Expected: `FAIL 0206: report sections equal … served … current:` (the served cases differ). Revert, `reapply`.

- [ ] **Step 3: Control O — report gate without the coalesce.** Change the report gate's `coalesce((select auth.role()), '') = 'service_role'` → `(select auth.role()) = 'service_role'`. Expected: the migration's own post-condition aborts (`0206: public.patient_sources_report(...) does not carry the coalesced service_role gate`). Then ALSO remove the report from that post-condition's array temporarily, `reapply`, run the proof. Expected: `FAIL 0206: report gate matrix — no JWT claims at all: expected error 42501, but the call succeeded` and `FAIL 0206: helpers and list builders are closed… gate`. Revert both edits, `reapply`.

- [ ] **Step 4: Control P — one helper's filter changes.** In `_ps_sec_series` (the `'new'` branch) change `and not i.is_returning` → `and true`. Expected: `FAIL 0206: every wrapper returns exactly the pre-0206 rows — … series …/new` (the seeded returning patient now counts). Revert, `reapply`.

- [ ] **Step 5: Control D (re-pointed) — summary wrapper without its gate.** In 0206's `patient_sources_summary` delete the three gate lines (`if not (…) then` / `raise …` / `end if;`) — and remove summary from the post-condition's anon/gate arrays so the file applies. `reapply`. Expected: `FAIL ACL matrix - functions`. Revert, `reapply`.

- [ ] **Step 6: Final all-PASS run after the last revert**

Run: `git diff --quiet supabase/migrations/0206_patient_sources_report.sql && echo clean; SUPABASE_DB_URL=$DB npm run -s patient-sources:db-proof 2>&1 | tail -1`
Expected: `clean` and `N+6/N+6 checks passed.`

- [ ] **Step 7: Update the proof's CONTROL ROUNDS header comment**

In the header of `scripts/patient-sources-db-proof.ts`, after the `MIG=supabase/migrations/0189_patient_sources.sql` line add:

```ts
//   MIG_LIVE — where each body lives NOW (a control that edits a superseded
//   body proves nothing): identity core + encounters + revenue lines =
//   0193_sync_review_gaps.sql; the five report RPCs + their rules =
//   0206_patient_sources_report.sql (_ps_sec_* helpers and wrappers);
//   patient_sources_people = 0189. Letters A, B, C, E, F, G, L edit the core
//   -> edit 0193 (psql -f 0193 is safe: create-or-replace + its own
//   post-conditions). Letter D edits the summary WRAPPER gate -> 0206 (and
//   drop summary from 0206's post-condition arrays for that round).
```

and append after control L:

```ts
//   M–P (0206, 2026-09-30), each confirmed with the FAIL line quoted:
//   M. patient_sources_report: delete the 'overlaps' entry. Expect: FAIL
//      0206: report sections equal the single RPCs (sections list).
//   N. patient_sources_report 'current': 'period', p_mode -> 'period', 'new'.
//      Expect: FAIL 0206: report sections equal … current.
//   O. patient_sources_report gate: drop the coalesce (and the report from the
//      post-condition gate array). Expect: FAIL 0206: report gate matrix — no
//      JWT claims at all.
//   P. _ps_sec_series 'new' branch: `and not i.is_returning` -> `and true`.
//      Expect: FAIL 0206: every wrapper returns exactly the pre-0206 rows.
//   0206 re-apply needs the objects dropped first:
//     psql $DB -c "drop function if exists public.patient_sources_report(date,date,text,text,date,date);
//                  drop type if exists public._ps_identity, public._ps_encounter, public._ps_revenue_line cascade;"
```

Replace each `Expect:` with the actual FAIL line observed in Steps 1–5 (`Confirmed 2026-09-30: FAIL …`).

- [ ] **Step 8: Commit**

```bash
git add scripts/patient-sources-db-proof.ts
git commit -m "test(patient-sources): 0206 control rounds M–P confirmed; control notes point at the live bodies"
```

---

### Task 5: Regenerate database types

**Files:**
- Modify: `src/types/database.ts`

- [ ] **Step 1: Regenerate from the isolated stack**

Run: `npm run -s db:types -- --workdir /private/tmp/claude-501/-Users-jamila/cf5b4733-06ca-4f97-8bac-de835cd7e214/scratchpad/ps-stack && git diff --stat src/types/database.ts`
Expected: only `src/types/database.ts` changes.

- [ ] **Step 2: Check the diff is only 0206's objects**

Run: `git diff src/types/database.ts | grep -E "^[+-] " | grep -v -E "patient_sources_report|_ps_identity|_ps_encounter|_ps_revenue_line|p_prev_from|p_prev_to|p_grain|p_mode|p_from|p_to|Args|Returns|Json|string|number|boolean|null|\{|\}|\|" | head`
Expected: nothing (or only formatting lines belonging to those objects). If unrelated objects appear, the isolated stack carries something extra — stop and report.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run -s typecheck && echo ok`
Expected: `ok`.

```bash
git add src/types/database.ts
git commit -m "chore(db): types for 0206 patient_sources_report"
```

---

### Task 6: Report type + parser

**Files:**
- Modify: `src/lib/marketing/patient-sources.ts`
- Test: `src/lib/marketing/patient-sources.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `patient-sources.test.ts`; add `parsePatientSourcesReport` to its import from `./patient-sources`)

```ts
describe("parsePatientSourcesReport", () => {
  const summary = {
    new_confirmed: 3, new_unconfirmed: 1, returning_first_recorded: 0, served_confirmed: 5, served_unconfirmed: 2,
    undated_registrations: 4, source_recorded: 2, source_total: 4, sheet_last_dates: { lab: "2026-06-12" },
    sync_paused: true, last_synced_at: null, sheet_rows_present: true, last_run_status: null,
  };
  const s = { bucket_start: "2026-06-01", channel: "walk_in", confirmed: 2, unconfirmed: 0 };
  const good = {
    summary, series: [s], current: [s], previous: null, new_by_day: [s],
    revenue: [{ channel: "walk_in", confirmed_php: 1500.5, unconfirmed_php: 0 }],
    overlaps: [{ patient_id: "p1", drm_id: "DRM-1", service_date: "2026-06-10", app_php: 500, sheet_php: 700 }],
    referrers: [{ doctor_label: "Dr. A", new_confirmed: 1, new_unconfirmed: 0 }],
  };

  it("returns every section typed as the single RPCs return them", () => {
    const r = parsePatientSourcesReport(good);
    expect(r).toEqual(good);
  });
  it("keeps previous as an array when a comparison period was asked for", () => {
    expect(parsePatientSourcesReport({ ...good, previous: [s] })?.previous).toEqual([s]);
  });
  it("coerces numeric strings to numbers (numeric can arrive as text)", () => {
    const r = parsePatientSourcesReport({ ...good, revenue: [{ channel: "x", confirmed_php: "12.50", unconfirmed_php: "0" }] });
    expect(r?.revenue[0]).toEqual({ channel: "x", confirmed_php: 12.5, unconfirmed_php: 0 });
  });
  it.each([
    ["not an object", 42],
    ["null", null],
    ["missing summary", { ...good, summary: undefined }],
    ["summary without counts", { ...good, summary: { ...summary, new_confirmed: "x" } }],
    ["series not an array", { ...good, series: {} }],
    ["missing referrers", { ...good, referrers: undefined }],
    ["previous neither null nor array", { ...good, previous: "no" }],
    ["a series row without a bucket", { ...good, series: [{ channel: "walk_in", confirmed: 1, unconfirmed: 0 }] }],
  ])("returns null for a malformed reply (%s)", (_label, raw) => {
    expect(parsePatientSourcesReport(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/lib/marketing/patient-sources.test.ts 2>&1 | tail -5`
Expected: FAIL — `parsePatientSourcesReport` is not exported.

- [ ] **Step 3: Implement** (in `patient-sources.ts`, after the `ReferrerRow` interface)

```ts
/** Every section of the Patient Sources page from ONE `patient_sources_report` call (0206). */
export interface PatientSourcesReport {
  summary: SummaryRow;
  series: SeriesRow[];
  current: SeriesRow[];
  previous: SeriesRow[] | null;
  new_by_day: SeriesRow[];
  revenue: RevenueRow[];
  overlaps: OverlapRow[];
  referrers: ReferrerRow[];
}

const SUMMARY_COUNTS = [
  "new_confirmed", "new_unconfirmed", "returning_first_recorded", "served_confirmed", "served_unconfirmed",
  "undated_registrations", "source_recorded", "source_total",
] as const;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Maps each element with `row`; null if the input is not an array or any element is rejected. */
function rowsOf<T>(v: unknown, row: (o: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const r = isObj(x) ? row(x) : null;
    if (r === null) return null;
    out.push(r);
  }
  return out;
}
function seriesRow(o: Record<string, unknown>): SeriesRow | null {
  const confirmed = num(o.confirmed), unconfirmed = num(o.unconfirmed);
  if (typeof o.bucket_start !== "string" || typeof o.channel !== "string" || confirmed === null || unconfirmed === null) return null;
  return { bucket_start: o.bucket_start, channel: o.channel, confirmed, unconfirmed };
}
function revenueRow(o: Record<string, unknown>): RevenueRow | null {
  const c = num(o.confirmed_php), u = num(o.unconfirmed_php);
  if (typeof o.channel !== "string" || c === null || u === null) return null;
  return { channel: o.channel, confirmed_php: c, unconfirmed_php: u };
}
function overlapRow(o: Record<string, unknown>): OverlapRow | null {
  const a = num(o.app_php), s = num(o.sheet_php);
  if (typeof o.patient_id !== "string" || typeof o.drm_id !== "string" || typeof o.service_date !== "string" || a === null || s === null) return null;
  return { patient_id: o.patient_id, drm_id: o.drm_id, service_date: o.service_date, app_php: a, sheet_php: s };
}
function referrerRow(o: Record<string, unknown>): ReferrerRow | null {
  const c = num(o.new_confirmed), u = num(o.new_unconfirmed);
  if (typeof o.doctor_label !== "string" || c === null || u === null) return null;
  return { doctor_label: o.doctor_label, new_confirmed: c, new_unconfirmed: u };
}

/** Validates the jsonb reply of `patient_sources_report`; null when it is not the expected shape. */
export function parsePatientSourcesReport(raw: unknown): PatientSourcesReport | null {
  if (!isObj(raw) || !isObj(raw.summary)) return null;
  const sm = raw.summary;
  const counts: Record<string, number> = {};
  for (const k of SUMMARY_COUNTS) {
    const n = num(sm[k]);
    if (n === null) return null;
    counts[k] = n;
  }
  const summary = { ...(sm as unknown as SummaryRow), ...counts } as SummaryRow;
  const series = rowsOf(raw.series, seriesRow);
  const current = rowsOf(raw.current, seriesRow);
  const newByDay = rowsOf(raw.new_by_day, seriesRow);
  const previous = raw.previous === null ? null : rowsOf(raw.previous, seriesRow);
  const revenue = rowsOf(raw.revenue, revenueRow);
  const overlaps = rowsOf(raw.overlaps, overlapRow);
  const referrers = rowsOf(raw.referrers, referrerRow);
  if (!series || !current || !newByDay || (raw.previous !== null && !previous) || !revenue || !overlaps || !referrers) return null;
  return { summary, series, current, previous, new_by_day: newByDay, revenue, overlaps, referrers };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/marketing/patient-sources.test.ts 2>&1 | tail -4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/patient-sources.ts src/lib/marketing/patient-sources.test.ts
git commit -m "feat(patient-sources): PatientSourcesReport type + reply parser"
```

---

### Task 7: The report loader

**Files:**
- Modify: `src/lib/marketing/patient-sources.server.ts`
- Test: `src/lib/marketing/patient-sources.server.test.ts`
- Modify: `src/lib/marketing/patient-sources-surfaces.test.ts` (RPCS list)

- [ ] **Step 1: Write the failing tests** (append to `patient-sources.server.test.ts`; import `loadPatientSourcesReport` alongside `loadAdSpendRows`)

```ts
describe("loadPatientSourcesReport", () => {
  const s = { bucket_start: "2026-06-01", channel: "walk_in", confirmed: 1, unconfirmed: 0 };
  const reply = {
    summary: {
      new_confirmed: 1, new_unconfirmed: 0, returning_first_recorded: 0, served_confirmed: 1, served_unconfirmed: 0,
      undated_registrations: 0, source_recorded: 1, source_total: 1, sheet_last_dates: {}, sync_paused: true,
      last_synced_at: null, sheet_rows_present: false, last_run_status: null,
    },
    series: [s], current: [s], previous: null, new_by_day: [s], revenue: [], overlaps: [], referrers: [],
  };
  function one(data: unknown, error: { code: string } | null = null) {
    const calls: [string, unknown][] = [];
    const supabase = { rpc(name: string, args: unknown) { calls.push([name, args]); return Promise.resolve({ data, error }); } };
    return { supabase: supabase as never, calls };
  }

  it("makes exactly one call with the period, grain, mode and no comparison", async () => {
    const { supabase, calls } = one(reply);
    const res = await loadPatientSourcesReport(supabase, { from: "2026-06-01", to: "2026-06-30", grain: "week", mode: "served", prev: null });
    expect(calls).toEqual([["patient_sources_report", {
      p_from: "2026-06-01", p_to: "2026-06-30", p_grain: "week", p_mode: "served", p_prev_from: null, p_prev_to: null,
    }]]);
    expect(res).toMatchObject({ ok: true, data: { series: [s], previous: null } });
  });
  it("passes the comparison period when given", async () => {
    const { supabase, calls } = one({ ...reply, previous: [s] });
    await loadPatientSourcesReport(supabase, { from: "2026-06-01", to: "2026-06-30", grain: "day", mode: "new", prev: { from: "2026-05-02", to: "2026-05-31" } });
    expect(calls[0][1]).toMatchObject({ p_prev_from: "2026-05-02", p_prev_to: "2026-05-31" });
  });
  it.each([["42501", "forbidden"], ["22023", "invalid"], ["0A000", "converted"], ["XX000", "error"]] as const)(
    "classifies SQLSTATE %s as %s", async (code, kind) => {
      const { supabase } = one(null, { code });
      const res = await loadPatientSourcesReport(supabase, { from: "2026-06-01", to: "2026-06-30", grain: "day", mode: "new", prev: null });
      expect(res).toMatchObject({ ok: false, kind });
    });
  it("treats a malformed reply as an error, never a crash", async () => {
    const { supabase } = one({ summary: {} });
    const res = await loadPatientSourcesReport(supabase, { from: "2026-06-01", to: "2026-06-30", grain: "day", mode: "new", prev: null });
    expect(res).toMatchObject({ ok: false, kind: "error" });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/lib/marketing/patient-sources.server.test.ts 2>&1 | tail -4`
Expected: FAIL — `loadPatientSourcesReport` is not exported.

- [ ] **Step 3: Implement** (in `patient-sources.server.ts`: add `parsePatientSourcesReport, type PatientSourcesReport` to the `./patient-sources` import; add after `loadPatientSourcesSummary`)

```ts
export interface ReportQuery {
  from: string;
  to: string;
  grain: Grain;
  mode: Mode;
  /** The comparison period, or null when there is none (e.g. it would start before Patient Sources' first date). */
  prev: { from: string; to: string } | null;
}

/**
 * Every section of the Patient Sources page from ONE call (0206): the database
 * builds the identity core once, and every card reads the same snapshot.
 * One jsonb value, so PostgREST's 1,000-row cap does not apply.
 */
export async function loadPatientSourcesReport(supabase: Db, q: ReportQuery): Promise<ReportResult<PatientSourcesReport>> {
  const { data, error } = await supabase.rpc("patient_sources_report", {
    p_from: q.from, p_to: q.to, p_grain: q.grain, p_mode: q.mode,
    // A deliberate SQL null ("no comparison"): CLI 2.118 types every SQL argument as non-null.
    p_prev_from: (q.prev?.from ?? null) as string, p_prev_to: (q.prev?.to ?? null) as string,
  });
  if (error) return fail("report", error);
  const report = parsePatientSourcesReport(data);
  if (!report) return fail("report (malformed reply)", { code: "XX000" });
  return { ok: true, data: report };
}
```

- [ ] **Step 4: Add the RPC name to the surfaces test**

In `patient-sources-surfaces.test.ts`, add `"patient_sources_report"` to the `RPCS` array (after `"patient_sources_referrers"`).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/lib/marketing 2>&1 | tail -4 && npm run -s typecheck && echo ok`
Expected: PASS and `ok`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/marketing/patient-sources.server.ts src/lib/marketing/patient-sources.server.test.ts src/lib/marketing/patient-sources-surfaces.test.ts
git commit -m "feat(patient-sources): loadPatientSourcesReport — one call for the whole page"
```

---

### Task 8: The page makes one report call

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx`
- Modify: `src/lib/marketing/patient-sources-surfaces.test.ts`

- [ ] **Step 1: Write the failing surfaces test**

In `patient-sources-surfaces.test.ts`:
1. Change the `SURFACES` entry for `` `${S}/marketing/patients/page.tsx` `` from `"loadPatientSourcesSummary"` to `"loadPatientSourcesReport"`.
2. Add inside `describe("Patient Sources has one definition and one caller", …)`:

```ts
  it("the Patient Sources page and its CSV read the identity sections through the ONE report call", () => {
    const SINGLE = ["loadPatientSourcesSummary", "loadPatientSourcesSeries", "loadPatientSourcesRevenue",
      "loadPatientSourcesOverlaps", "loadPatientSourcesReferrers"];
    for (const file of [`${S}/marketing/patients/page.tsx`, "src/app/api/admin/reports/patient-sources.csv/route.ts"]) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src.match(/loadPatientSourcesReport\(/g) ?? [], file).toHaveLength(1);
      for (const l of SINGLE) expect(src, `${file} still calls ${l}`).not.toContain(`${l}(`);
    }
  });
```
3. In the first-night-check block, the assertion `expect(readFileSync(join(ROOT, `${S}/marketing/patients/page.tsx`), "utf8")).toContain("formatNewCounts(")` stays (the page keeps using it).

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/lib/marketing/patient-sources-surfaces.test.ts 2>&1 | tail -6`
Expected: FAIL (page and CSV still call the single loaders).

- [ ] **Step 3: Change the page**

In `page.tsx` replace the loader import with:

```ts
import { loadAdSpendCoverage, loadAdSpendTotals, loadPatientSourcesReport } from "@/lib/marketing/patient-sources.server";
```

and add `REPORT_EXPORT_MAX_ROWS` import: `import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";`.

Replace the whole `const [summary, series, current, previous, newByDay, revenue, overlaps, referrers, spend, coverage] = await Promise.all([ … ]);` block with:

```ts
  // One report call (0206): the database builds who-is-who once and every
  // card below reads the same snapshot. The previous period may start before
  // Patient Sources' first date (the database refuses that): no comparison.
  const [report, spend, coverage] = await Promise.all([
    loadPatientSourcesReport(supabase, {
      from: period.from, to: period.to, grain, mode,
      prev: prev.from < PATIENT_SOURCES_MIN_DATE ? null : prev,
    }),
    loadAdSpendTotals(supabase, period.from, period.to),
    loadAdSpendCoverage(supabase),
  ]);
```

Change the error branch `if (!summary.ok) { … {summary.message} … }` to `if (!report.ok) { … {report.message} … }` (same markup).

After that branch, derive the values the rest of the page already uses (so the JSX below is unchanged):

```ts
  const r = report.data;
  // The overlaps list keeps the export ceiling the paged loader applied.
  const overlaps = {
    rows: r.overlaps.slice(0, REPORT_EXPORT_MAX_ROWS),
    truncated: r.overlaps.length > REPORT_EXPORT_MAX_ROWS,
  };
```

Then update the uses:
- `if (overlaps.ok && overlaps.data.rows.length > 0) {` → `if (overlaps.rows.length > 0) {`, and in its `metadata` use `count: overlaps.rows.length, truncated: overlaps.truncated`.
- `const s = summary.data;` → `const s = r.summary;`
- `const chart = series.ok ? chartData(series.data.rows, grain) : null;` → `const chart = chartData(r.series, grain);` and simplify the JSX `chart === null ? (…) : chart.rows.length === 0 ? …` to `chart.rows.length === 0 ? (…) : (…)` (drop the "Couldn't load the chart" branch — a report failure now shows the page alert).
- `const table = current.ok && (previous === null || previous.ok) ? channelTable(current.data.rows, previous === null ? null : previous.data.rows) : null;` → `const table = channelTable(r.current, r.previous);` and drop the "Couldn't load the channel table" branch.
- `const costs = spend.ok && newByDay.ok ? costPerNewPatient(spend.data.rows, newByDay.data.rows) : null;` → `const costs = spend.ok ? costPerNewPatient(spend.data.rows, r.new_by_day) : null;`
- `<RevenueSection revenue={revenue.ok ? revenue.data : null} overlaps={overlaps.ok ? overlaps.data : null} />` → `<RevenueSection revenue={r.revenue} overlaps={overlaps} />`
- `<ReferrersSection rows={referrers.ok ? referrers.data : null} />` → `<ReferrersSection rows={r.referrers} />`

Check `report-sections.tsx` prop types accept these (they take `RevenueRow[] | null`, `{ rows: OverlapRow[]; truncated: boolean } | null`, `ReferrerRow[] | null`) — no change there.

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `npx vitest run src/lib/marketing 2>&1 | tail -4; npm run -s typecheck && npm run -s lint > /dev/null && echo ok`
Expected: the new surfaces test still FAILS only on the CSV route (fixed in Task 9); typecheck and lint `ok`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx" src/lib/marketing/patient-sources-surfaces.test.ts
git commit -m "feat(patient-sources): the page reads every section from one report call"
```

---

### Task 9: The CSV route makes one report call

**Files:**
- Modify: `src/app/api/admin/reports/patient-sources.csv/route.ts`
- Test: `src/app/api/admin/reports/patient-sources.csv/route.test.ts`

- [ ] **Step 1: Update the route test first**

In `route.test.ts`:
- `loaders` gains `loadPatientSourcesReport: vi.fn(),` (keep the others; the people route still uses `loadAllPeople`).
- In `beforeEach` add:
```ts
  loaders.loadPatientSourcesReport.mockResolvedValue({ ok: true, data: {
    summary: {}, series: [], current: [], previous: null, new_by_day: [], revenue: [], overlaps: [], referrers: [],
  } });
```
- In the BAD-period test add `expect(loaders.loadPatientSourcesReport).not.toHaveBeenCalled();`.
- Append:
```ts
describe("patient-sources.csv reads one report", () => {
  it("asks for the period, grain and mode with no comparison, and exports its summary + series", async () => {
    const s = { bucket_start: "2026-08-01", channel: "walk_in", confirmed: 1, unconfirmed: 0 };
    loaders.loadPatientSourcesReport.mockResolvedValueOnce({ ok: true, data: {
      summary: { new_confirmed: 1 }, series: [s], current: [], previous: null, new_by_day: [], revenue: [], overlaps: [], referrers: [],
    } });
    const res = await seriesGet(req("patient-sources.csv", "from=2026-08-01&to=2026-08-31&grain=week&mode=served"));
    expect(res.status).toBe(200);
    expect(loaders.loadPatientSourcesReport).toHaveBeenCalledTimes(1);
    expect(loaders.loadPatientSourcesReport.mock.calls[0][1]).toEqual({ from: "2026-08-01", to: "2026-08-31", grain: "week", mode: "served", prev: null });
    expect(loaders.loadPatientSourcesSummary).not.toHaveBeenCalled();
    expect(loaders.loadPatientSourcesSeries).not.toHaveBeenCalled();
    expect(csv.mock.calls[0][0]).toMatchObject({ truncated: false });
  });
  it.each([["forbidden", 403], ["invalid", 500], ["error", 500]] as const)("answers %s with %i", async (kind, status) => {
    loaders.loadPatientSourcesReport.mockResolvedValueOnce({ ok: false, kind, message: "m" });
    const res = await seriesGet(req("patient-sources.csv", "from=2026-08-01&to=2026-08-31"));
    expect(res.status).toBe(status);
    expect(csv).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/app/api/admin/reports/patient-sources.csv 2>&1 | tail -5`
Expected: FAIL (route still calls summary + series).

- [ ] **Step 3: Change the route**

Replace the loader import with `import { loadPatientSourcesReport } from "@/lib/marketing/patient-sources.server";`, add `import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";`, and replace the `Promise.all([...])` + the two `!ok` checks + `return reportCsvResponse({...})` with:

```ts
  // One report call (0206): summary and rows come from the same snapshot.
  const report = await loadPatientSourcesReport(supabase, { from: period.from, to: period.to, grain, mode, prev: null });
  if (!report.ok) return new Response(report.message, { status: report.kind === "forbidden" ? 403 : 500 });
  const series = report.data.series;
  return reportCsvResponse({
    staff,
    report: "patient_sources",
    filename: `patient-sources-${period.from}-to-${period.to}-${mode}-${grain}.csv`,
    rows: seriesCsvRows({ from: period.from, to: period.to, mode, grain }, report.data.summary, series.slice(0, REPORT_EXPORT_MAX_ROWS)),
    truncated: series.length > REPORT_EXPORT_MAX_ROWS,
    filters: { from: period.from, to: period.to, mode, grain },
  });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/app/api/admin/reports src/lib/marketing 2>&1 | tail -4`
Expected: PASS (including the surfaces test from Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/reports/patient-sources.csv
git commit -m "feat(patient-sources): the CSV export reads one report call"
```

---

### Task 10: Docs — ledger and guide sentence

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/drmed-user-guide.html`

- [ ] **Step 1: Ledger.** In `CLAUDE.md` the "Migration ledger" paragraph (line ~30) says `**prod head = 0202** (…)`. Rewrite its opening so it reads, before the existing 0202 text:

```
Migration ledger: **prod head = 0206** (`patient_sources_report`, this PR — Patient Sources builds the identity core once per page view: row types `_ps_identity` / `_ps_encounter` / `_ps_revenue_line`, closed list builders + `_ps_sec_*` section helpers, the five report RPCs re-created as wrappers with unchanged signatures/gates/ACLs, new `patient_sources_report` (admin or service_role, coalesced gate); pushed right before merge and verified by object) over **0204** (`sheet_links_clear_held_patient`, #274 — `sheet_review_resolve` / undo clear `sheet_patient_links.held_patient_id`; pushed 2026-09-30 with the user approving the prompt, verified by object) over **0203** (`ad_spend_leads_bookings`, #277 — `ad_spend_daily` gains leads / platform bookings / ad label, re-created `ad_spend_import`, new admin-gated `ad_spend_rows`; pushed 2026-09-30, verified by object) over **0202** …
```

keeping the rest of the existing sentence (the 0202 description onward, and the separate 0201 note) intact. Also update the "not contiguous" list: `(no 0165, 0168, 0169, 0195–0197, 0200, 0205 — …)` — re-check before merge with the prod ledger query (controller does this in Task 12) and write what prod actually shows.

- [ ] **Step 2: Guide sentence.** In `docs/drmed-user-guide.html`, find the Patient Sources section (5.8; search `How these numbers work` or `Patient Sources</span> — where new`). After the sentence that describes the four cards, add:

```html
All the numbers on the page — cards, chart, channel table, cost, revenue, double entries and referring doctors — are read together at the same moment, so they always agree with each other even while a sheet sync is finishing; the <kbd class="ui">Download CSV</kbd> file is read the same way.
```

Do NOT bump the version/date (done at merge time).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/drmed-user-guide.html
git commit -m "docs: ledger 0203/0204/0206; Patient Sources numbers are read together"
```

---

### Task 11: Full gate (controller)

- [ ] **Step 1:** `npm test > $SP/test.log 2>&1; echo exit=$?; tail -5 $SP/test.log` → `exit=0`.
- [ ] **Step 2:** `npm run -s typecheck && npm run -s lint && echo ok` → `ok`.
- [ ] **Step 3:** Build against the isolated stack (never the prod env): read `API URL`, `anon key`, `service_role key` from `supabase status --workdir $SP -o env`, then `NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npm run build > $SP/build.log 2>&1; echo exit=$?` → `exit=0`.
- [ ] **Step 4:** Proofs: patient-sources `N+6/N+6`, sheet-sync all PASS (Task 3 Steps 3–4 re-run on the final tree).
- [ ] **Step 5:** Final review subagent (Sonnet) over `git diff origin/main...HEAD` against the spec; fix findings; re-run the gate.

### Task 12: Prod timing, push, PR, db push, merge (controller, with the user)

- [ ] **Step 1: Prod timing (read-only).** Via MCP `execute_sql` on `qhptbmafrosgibooelpp`, inside `begin; … rollback;` with `set_config('request.jwt.claims','{"role":"service_role"}',true)`: time today's eight calls (summary; series day/served, period/served ×2 periods, day/new; revenue/overlaps/referrers are admin-only — time `_ps_revenue_lines` + identities instead) — this is the "before" figure; the "after" figure is measured after `db push` (Step 5) with `patient_sources_report`.
- [ ] **Step 2:** Merge origin/main into the branch; bump the guide version/date (header + CLAUDE.md bullet) to the next version; re-run the gate if main moved.
- [ ] **Step 3:** Ask the user once; push; open the PR (body: what/why, timings, proofs, controls, rollout).
- [ ] **Step 4:** Right before merge: prod `list_migrations` check (head 0204, 0206 absent); from this worktree with `supabase/.temp/{project-ref,linked-project.json,pooler-url}` copied from the main checkout: `supabase db push --dry-run` (expect only 0206), then `supabase db push` — the user approves the prompt.
- [ ] **Step 5:** Verify by object on prod: ledger 0206; `patient_sources_report` EXECUTE authenticated + service_role only; helpers closed; three types exist; wrappers carry their gates; one `patient_sources_report` call as service_role returns 8 sections; "after" timing.
- [ ] **Step 6:** User OK → merge → Vercel production deploy READY → stop the isolated stack (`supabase stop --workdir $SP --no-backup`) → memory update.

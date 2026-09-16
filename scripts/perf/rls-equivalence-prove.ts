// Proves a migration does not change what any principal can see.
//
// Snapshots row visibility, applies the migration's DDL, snapshots again, and
// rolls the whole thing back — all inside ONE transaction at REPEATABLE READ.
//
// Why one transaction rather than two separate runs:
//
//   1. The local Supabase stack is SHARED across worktrees and sessions. A
//      before-run and an after-run minutes apart can straddle someone else's
//      write — during development of this script another session inserted a
//      staff_profiles row between two snapshots, which would have shown up as a
//      spurious visibility "change". REPEATABLE READ pins both snapshots to the
//      same data, so the ONLY difference between them is the policies.
//   2. Policy DDL is transactional in Postgres, so the migration can be applied
//      and rolled back without ever persisting. Nothing is left behind, and the
//      proof can be re-run as many times as you like without a db:reset.
//
// Counts come from SQL. Never from the length of a fetched array — PostgREST caps
// a bare select at 1000 rows silently, which would make a truncated "before" and a
// truncated "after" look identical and wave a broken migration through.
//
// Staff principals are produced by flipping the seeded staff row's `role` inside a
// savepoint. `npm run seed:test` creates exactly one active staff row (admin) and
// one inactive medtech, so a probe that merely read the fixture would have tested
// only the role that can already see everything — a break in reception or medtech
// visibility would have passed silently.
import "../lib/load-env";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { readFileSync } from "node:fs";
import { Client } from "pg";

requireLocalOrExplicitProd("perf:rls-prove", {
  readOnly: true,
  writes:
    "nothing persistent — applies the migration inside a transaction it always rolls back",
});

// The full role set from staff_profiles_role_check. Hardcoded deliberately: if a
// migration adds a role, this list must be updated consciously rather than the
// proof quietly covering one fewer principal than the reviewer believes.
const STAFF_ROLES = [
  "reception",
  "medtech",
  "pathologist",
  "admin",
  "xray_technician",
] as const;

interface Principal {
  label: string;
  dbRole: "anon" | "authenticated";
  claims: Record<string, string> | null;
  asStaffRole?: string;
}

type Observation = { n: string; fp: string } | { error: string };
type Snapshot = Record<string, Observation>;

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

async function buildPrincipals(db: Client): Promise<Principal[]> {
  // `anon` is mandatory and listed first. This app has shipped two live
  // anon-readable exposures before (2026-09-10), so the role that must never gain
  // a row is the one checked first.
  const principals: Principal[] = [
    { label: "anon", dbRole: "anon", claims: null },
  ];

  const { rows: staff } = await db.query<{ id: string }>(
    `select id::text as id from public.staff_profiles order by id limit 1`,
  );
  const { rows: patients } = await db.query<{ id: string }>(
    `select id::text as id from public.patients order by id limit 1`,
  );
  if (!staff[0] || !patients[0]) {
    throw new Error(
      "fixture too thin: need at least one staff_profiles row and one patient. " +
        "Run `npm run seed:test` first.",
    );
  }

  for (const role of STAFF_ROLES) {
    principals.push({
      label: `staff:${role}`,
      dbRole: "authenticated",
      claims: { sub: staff[0].id, role: "authenticated" },
      asStaffRole: role,
    });
  }

  // A patient, via the anon-role JWT carrying a patient_id claim (migration 0114).
  principals.push({
    label: "patient",
    dbRole: "anon",
    claims: { role: "anon", patient_id: patients[0].id },
  });

  return principals;
}

async function snapshot(
  db: Client,
  principals: Principal[],
  tables: string[],
): Promise<Snapshot> {
  const snap: Snapshot = {};

  for (const p of principals) {
    // Savepoint per principal: rolling back to it reverts both the staff-role flip
    // and the SET LOCAL ROLE, so the next principal starts clean and the outer
    // transaction keeps its REPEATABLE READ data snapshot.
    await db.query("savepoint principal");
    try {
      if (p.asStaffRole) {
        await db.query(
          `update public.staff_profiles set role = $1, is_active = true where id = $2::uuid`,
          [p.asStaffRole, p.claims!.sub],
        );
      }
      await db.query(`set local role ${p.dbRole}`);
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        p.claims ? JSON.stringify(p.claims) : "",
      ]);

      for (const t of tables) {
        const key = `${p.label}::${t}`;
        await db.query("savepoint probe");
        try {
          // t::text hashes the whole row, so a column-level visibility change is
          // caught too, and no primary key is assumed.
          const { rows } = await db.query<{ n: string; fp: string | null }>(
            `select count(*)::text as n,
                    md5(coalesce(string_agg(x, '|' order by x), '')) as fp
               from (select t::text as x from public.${quoteIdent(t)} t) s`,
          );
          snap[key] = { n: rows[0].n, fp: rows[0].fp ?? "" };
          await db.query("release savepoint probe");
        } catch (err) {
          // A permission denial is itself a stable, comparable observation — if it
          // stops being denied after the migration, that is what we want to see.
          snap[key] = { error: (err as Error).message.split("\n")[0] };
          await db.query("rollback to savepoint probe");
        }
      }
    } finally {
      await db.query("rollback to savepoint principal");
    }
  }
  return snap;
}

function diff(before: Snapshot, after: Snapshot): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (!b) { out.push(`${k}: appeared only AFTER the migration`); continue; }
    if (!a) { out.push(`${k}: present BEFORE, missing after`); continue; }
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      out.push(`${k}:\n    before ${JSON.stringify(b)}\n    after  ${JSON.stringify(a)}`);
    }
  }
  return out;
}

async function main() {
  const migrationPath = process.argv[2];
  if (!migrationPath) {
    console.error(
      "usage: tsx scripts/perf/rls-equivalence-prove.ts <migration.sql> [--expect-change]",
    );
    console.error(
      "  --expect-change  invert the exit code; used by the control test to prove",
    );
    console.error("                   this harness actually detects a real change.");
    process.exit(1);
  }
  const expectChange = process.argv.includes("--expect-change");
  const ddl = readFileSync(migrationPath, "utf8");

  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const { rows: tableRows } = await db.query<{ tablename: string }>(`
    select c.relname as tablename
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    order by c.relname
  `);
  const tables = tableRows.map((r) => r.tablename);
  const principals = await buildPrincipals(db);

  const expectedPrincipals = 2 + STAFF_ROLES.length;
  if (principals.length !== expectedPrincipals) {
    throw new Error(
      `expected ${expectedPrincipals} principals, built ${principals.length}. ` +
        "An equivalence proof that silently skips a role is worse than no proof.",
    );
  }

  let diffs: string[] = [];
  // REPEATABLE READ: both snapshots see identical data, so any difference is the
  // policies and nothing else. Immune to a concurrent session writing to the
  // shared local stack mid-proof.
  await db.query("begin isolation level repeatable read");
  try {
    const before = await snapshot(db, principals, tables);
    await db.query(ddl);
    const after = await snapshot(db, principals, tables);
    diffs = diff(before, after);

    console.log(
      `compared ${Object.keys(before).length} observations ` +
        `(${tables.length} tables x ${principals.length} principals)`,
    );
    console.log(`principals: ${principals.map((p) => p.label).join(", ")}`);
  } finally {
    // Unconditional. The migration is never persisted by this script.
    await db.query("rollback");
    await db.end();
  }

  if (diffs.length > 0) {
    console.error(`\nROW VISIBILITY CHANGED — ${diffs.length} observations differ:\n`);
    for (const d of diffs) console.error("  " + d);
    if (expectChange) {
      console.log("\n--expect-change: a change was detected, as required. Harness works.");
      process.exit(0);
    }
    console.error(
      "\nThe migration must not ship. Do not adjust this script to make it pass.",
    );
    process.exit(1);
  }

  if (expectChange) {
    console.error(
      "\n--expect-change: NO change detected, but one was required.\n" +
        "The harness is blind. Fix it before trusting any green run.",
    );
    process.exit(1);
  }
  console.log("\nOK — every principal sees exactly the same rows before and after.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Snapshots, for every RLS-protected table in `public` and every principal the app
// can present, how many rows are visible and what they contain. Run once before the
// 0150 migration and once after; `rls-equivalence-check.ts` diffs the two files.
//
// Content checksum, not just a count: a policy rewrite that swapped WHICH rows are
// visible while keeping the same number would sail through a count-only check.
//
// Counts come from SQL. Never from the length of a fetched array — PostgREST caps a
// bare select at 1000 rows silently, which would make a truncated "before" and a
// truncated "after" look identical and wave a broken migration through.
//
// The probe PROVISIONS its own principals rather than trusting the fixture.
// `npm run seed:test` creates exactly one active staff row (admin) and one inactive
// medtech, so a probe that just read what was there would have certified the
// migration having tested only the role that can already see everything — a break in
// reception or medtech visibility would have passed silently. Instead each staff
// principal is produced by flipping the seeded admin's `role` inside a transaction
// that is always rolled back. has_role() reads
// `staff_profiles where id = auth.uid() and is_active and role = any(...)`, so the
// flip is exactly what the policies key off, and reusing an existing row avoids
// fabricating an `auth.users` entry.
import "../lib/load-env";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { writeFileSync } from "node:fs";
import { Client } from "pg";

// Guarded even though it only reads: pointing a "local" probe at the live clinic
// would read real patient rows under every role, which is an RA 10173 disclosure.
requireLocalOrExplicitProd("perf:rls-probe", {
  readOnly: true,
  writes: "nothing — snapshots visible row counts and checksums per role",
});

// The full role set from staff_profiles_role_check. Hardcoded deliberately: if a
// migration adds a role, this list must be updated consciously rather than the probe
// quietly covering one fewer principal than the reviewer believes.
const STAFF_ROLES = [
  "reception",
  "medtech",
  "pathologist",
  "admin",
  "xray_technician",
] as const;

interface Principal {
  label: string;
  /** Postgres role to assume. */
  dbRole: "anon" | "authenticated";
  claims: Record<string, string> | null;
  /** When set, the seeded staff row is flipped to this role for the transaction. */
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
  // anon-readable exposures before (2026-09-10), so the role that must never gain a
  // row is the one probed first.
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

async function probePrincipal(
  db: Client,
  p: Principal,
  tables: string[],
  snapshot: Snapshot,
): Promise<void> {
  // One transaction per principal, always rolled back. Savepoints isolate a
  // permission error on one table so it does not abort the remaining probes.
  await db.query("begin");
  try {
    if (p.asStaffRole) {
      // Runs as the connection role (postgres) — before the role switch below.
      await db.query(
        `update public.staff_profiles
            set role = $1, is_active = true
          where id = $2::uuid`,
        [p.asStaffRole, p.claims!.sub],
      );
    }

    await db.query(`set local role ${p.dbRole}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      p.claims ? JSON.stringify(p.claims) : "",
    ]);

    for (const tablename of tables) {
      const key = `${p.label}::${tablename}`;
      await db.query("savepoint probe");
      try {
        // t::text hashes the whole row, so a column-level visibility change is
        // caught too, and no primary key is assumed.
        const { rows } = await db.query<{ n: string; fp: string | null }>(
          `select count(*)::text as n,
                  md5(coalesce(string_agg(x, '|' order by x), '')) as fp
             from (select t::text as x from public.${quoteIdent(tablename)} t) s`,
        );
        snapshot[key] = { n: rows[0].n, fp: rows[0].fp ?? "" };
        await db.query("release savepoint probe");
      } catch (err) {
        // A permission denial is itself a stable, comparable observation — if it
        // stops being denied after the migration, that is what we want to see.
        snapshot[key] = { error: (err as Error).message.split("\n")[0] };
        await db.query("rollback to savepoint probe");
      }
    }
  } finally {
    // Unconditional: the staff-role flip above must never outlive the probe.
    await db.query("rollback");
  }
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("usage: tsx scripts/perf/rls-equivalence-probe.ts <out.json>");
    process.exit(1);
  }

  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  // Every RLS-enabled table in public, read from the catalog rather than a
  // hardcoded list so a table added later is covered automatically.
  const { rows: tableRows } = await db.query<{ tablename: string }>(`
    select c.relname as tablename
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    order by c.relname
  `);
  const tables = tableRows.map((r) => r.tablename);

  const principals = await buildPrincipals(db);
  const snapshot: Snapshot = {};

  for (const p of principals) {
    await probePrincipal(db, p, tables, snapshot);
  }

  // Fail loudly rather than silently under-covering. An equivalence proof that
  // quietly skipped a role is worse than no proof, because it reads as green.
  const expected = 2 + STAFF_ROLES.length; // anon + patient + every staff role
  if (principals.length !== expected) {
    throw new Error(
      `expected ${expected} principals (anon, patient, ${STAFF_ROLES.join(", ")}), ` +
        `built ${principals.length}: ${principals.map((p) => p.label).join(", ")}`,
    );
  }

  // Confirm the staff-role flip was actually rolled back.
  const { rows: after } = await db.query<{ role: string; n: string }>(
    `select role, count(*)::text as n from public.staff_profiles group by role order by role`,
  );

  await db.end();
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `wrote ${outPath}: ${tables.length} tables x ${principals.length} principals = ` +
      `${Object.keys(snapshot).length} observations`,
  );
  console.log(`principals: ${principals.map((p) => p.label).join(", ")}`);
  console.log(
    `staff_profiles after rollback: ${after.map((r) => `${r.role}=${r.n}`).join(", ")}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

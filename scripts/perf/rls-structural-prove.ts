// Proves, for EVERY policy in the database, whether a migration changed what the
// policy MEANS or only how often Postgres evaluates it.
//
// Why this exists alongside rls-equivalence-prove.ts:
//
//   The row-visibility proof samples. It can only speak for tables that contain
//   rows, and the local fixture leaves 67 of 98 RLS'd tables empty — on those,
//   "before and after are identical" is trivially true and proves nothing. A
//   migration that destroyed visibility on an empty table would pass it.
//
//   But Phase 1 of migration 0150 is a SYNTACTIC transformation: `fn(x)` becomes
//   `(select fn(x))`. That can be proved exactly rather than sampled. Strip the
//   wrapper back off the post-migration expression; if what remains is byte-identical
//   to the pre-migration expression, the policy provably means the same thing — for
//   every row of every table, populated or not, forever.
//
//   So: this script is the primary gate for Phase 1 (100% of policies, no fixture
//   needed), and rls-equivalence-prove.ts is the gate for Phase 2, where expressions
//   genuinely change and only row sampling can speak.
//
// Everything runs inside one transaction that is always rolled back.
import "../lib/load-env";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { readFileSync } from "node:fs";
import { Client } from "pg";

requireLocalOrExplicitProd("perf:rls-structural", {
  readOnly: true,
  writes:
    "nothing persistent — applies the migration inside a transaction it always rolls back",
});

// Tables whose policy EXPRESSIONS are expected to change (Phase 2 consolidation).
// Anything outside this list that changes meaning is a defect, not a design choice.
// Keeping it explicit means a reviewer sees the full semantic blast radius in one
// place instead of inferring it from a diff.
const PHASE2_TABLES = new Set([
  "appointment_attachments",
  "hmo_providers",
  "physicians",
  "report_groups",
  "result_test_requests",
  "results",
  "services",
  "staff_profiles",
  "test_requests",
]);

interface PolicyRow {
  tablename: string;
  policyname: string;
  cmd: string;
  permissive: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
}

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Remove `(select <expr>)` wrappers, leaving `<expr>`. Applied to the AFTER
 * expression so it can be compared against the BEFORE expression byte-for-byte.
 *
 * Only unwraps a parenthesised scalar subquery whose body is a bare `select X`
 * with no FROM/WHERE/etc — exactly the shape the InitPlan rewrite introduces.
 * A pre-existing correlated subquery such as
 * `visit_id IN (SELECT v.id FROM visits v ...)` has a FROM and is left alone.
 */
export function unwrapInitPlans(expr: string): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    if (expr[i] !== "(") {
      out += expr[i];
      i++;
      continue;
    }
    const close = matchParen(expr, i);
    if (close === -1) {
      out += expr.slice(i);
      break;
    }
    const inner = expr.slice(i + 1, close).trim();
    const m = /^select\s+([\s\S]+)$/i.exec(inner);
    if (m && !/\b(from|where|group\s+by|having|union|join)\b/i.test(m[1])) {
      // A bare `(select <expr>)` — the wrapper this migration adds. Drop it and
      // recurse into the body, since the body may itself contain wrappers.
      out += unwrapInitPlans(m[1].trim());
    } else {
      // Something else in parens. Keep the parens, recurse inside.
      out += "(" + unwrapInitPlans(expr.slice(i + 1, close)) + ")";
    }
    i = close + 1;
  }
  return out;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  let inQuote = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Collapse whitespace so formatting differences are not reported as meaning changes. */
function norm(e: string | null): string {
  return (e ?? "").replace(/\s+/g, " ").trim();
}

function key(p: PolicyRow): string {
  return `${p.tablename}::${p.policyname}`;
}

async function readPolicies(db: Client): Promise<Map<string, PolicyRow>> {
  const { rows } = await db.query<PolicyRow>(`
    select tablename, policyname, cmd, permissive, roles::text[] as roles, qual, with_check
    from pg_policies
    where schemaname = 'public'
    order by tablename, policyname
  `);
  return new Map(rows.map((r) => [key(r), r]));
}

async function main() {
  const migrationPath = process.argv[2];
  if (!migrationPath) {
    console.error("usage: tsx scripts/perf/rls-structural-prove.ts <migration.sql>");
    process.exit(1);
  }
  const ddl = readFileSync(migrationPath, "utf8");

  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const inert: string[] = [];
  const semantic: string[] = [];
  const structural: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  await db.query("begin");
  try {
    const before = await readPolicies(db);
    await db.query(ddl);
    const after = await readPolicies(db);

    for (const [k, b] of before) {
      const a = after.get(k);
      if (!a) {
        removed.push(k);
        continue;
      }
      // Role list, command and permissiveness must never drift. A restrictive
      // policy re-created as permissive WIDENS access; a role added to the list
      // widens it too.
      if (
        norm(a.cmd) !== norm(b.cmd) ||
        norm(a.permissive) !== norm(b.permissive) ||
        a.roles.slice().sort().join(",") !== b.roles.slice().sort().join(",")
      ) {
        structural.push(
          `${k}\n      before cmd=${b.cmd} permissive=${b.permissive} roles={${b.roles}}` +
            `\n      after  cmd=${a.cmd} permissive=${a.permissive} roles={${a.roles}}`,
        );
        continue;
      }
      const qualSame = norm(unwrapInitPlans(a.qual ?? "")) === norm(b.qual);
      const checkSame =
        norm(unwrapInitPlans(a.with_check ?? "")) === norm(b.with_check);
      if (qualSame && checkSame) inert.push(k);
      else
        semantic.push(
          `${k}\n      before ${norm(b.qual) || "(none)"}` +
            `\n      after  ${norm(unwrapInitPlans(a.qual ?? "")) || "(none)"} (unwrapped)`,
        );
    }
    for (const k of after.keys()) if (!before.has(k)) added.push(k);

    console.log(`policies before: ${before.size}   after: ${after.size}`);
  } finally {
    await db.query("rollback");
    await db.end();
  }

  console.log(`\n  provably inert (same meaning, hoisted to InitPlan): ${inert.length}`);
  console.log(`  meaning changed:                                    ${semantic.length}`);
  console.log(`  cmd/roles/permissive changed:                       ${structural.length}`);
  console.log(`  added:   ${added.length}`);
  console.log(`  removed: ${removed.length}`);

  let failed = false;

  if (structural.length > 0) {
    console.error(`\nFAIL — cmd / roles / permissive changed on ${structural.length} policies:`);
    for (const s of structural) console.error("    " + s);
    console.error(
      "\n  None of these should EVER change. A restrictive policy re-created as\n" +
        "  permissive, or a role added to the list, widens access.",
    );
    failed = true;
  }

  // A meaning change is legitimate ONLY on a Phase 2 table.
  const unexpected = semantic.filter(
    (s) => !PHASE2_TABLES.has(s.split("::")[0].trim()),
  );
  if (unexpected.length > 0) {
    console.error(`\nFAIL — meaning changed on ${unexpected.length} policies outside Phase 2:`);
    for (const s of unexpected) console.error("    " + s);
    failed = true;
  } else if (semantic.length > 0) {
    console.log(`\n  ${semantic.length} meaning changes, all on Phase 2 tables (expected):`);
    for (const s of semantic) console.log("    " + s);
    console.log(
      "\n  These are NOT proved by this script — only row-visibility sampling can\n" +
        "  speak for them. Run `npm run perf:rls-prove` and confirm the Phase 2\n" +
        "  tables it covers.",
    );
  }

  const addedOutside = added.filter((k) => !PHASE2_TABLES.has(k.split("::")[0]));
  const removedOutside = removed.filter((k) => !PHASE2_TABLES.has(k.split("::")[0]));
  if (addedOutside.length || removedOutside.length) {
    console.error(`\nFAIL — policies added/removed outside Phase 2:`);
    for (const k of addedOutside) console.error("    added:   " + k);
    for (const k of removedOutside) console.error("    removed: " + k);
    failed = true;
  }

  if (failed) {
    console.error("\nThe migration must not ship.");
    process.exit(1);
  }
  console.log(
    `\nOK — ${inert.length} policies provably unchanged in meaning across ALL tables,\n` +
      "     populated or empty. Phase 1 is inert by construction, not by sampling.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

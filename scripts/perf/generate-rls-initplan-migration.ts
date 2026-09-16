// scripts/perf/generate-rls-initplan-migration.ts
//
// Emits the Phase 1 body of migration 0150: every RLS policy that calls a STABLE
// helper bare, reissued with the call wrapped in a scalar subquery so Postgres
// hoists it to an InitPlan (evaluated once per query, not once per row).
//
// Runs at AUTHORING time only. It is not part of the migration — the committed
// artifact is plain static DDL a reviewer reads line by line.
import "../lib/load-env";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { Client } from "pg";

requireLocalOrExplicitProd("perf:gen-rls-migration", {
  readOnly: true,
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

// Match helper calls; the loop below skips existing SELECT wrappers. The leading
// group excludes adjacent identifiers such as `my_has_role(`.
const CALL_RE = new RegExp(
  `(^|[^.\\w])(${HELPERS.join("|")})\\s*\\(`,
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
    const before = expr.slice(0, nameStart).toLowerCase();
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
  let inQuote = false;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "'") inQuote = !inQuote;
    if (inQuote) continue;
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function quoteIdent(n: string) { return '"' + n.replace(/"/g, '""') + '"'; }

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const { rows } = await db.query<{
    tablename: string; policyname: string; cmd: string;
    permissive: string; roles: string[]; qual: string | null; with_check: string | null;
  }>(`
    select tablename, policyname, cmd, permissive, roles::text[] as roles, qual, with_check
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

#!/usr/bin/env node
// Regenerate src/types/database.ts from the LOCAL Supabase stack (default) or
// from a database URL (`--db-url`, used by db:types:remote).
//
// Why a script and not `supabase gen types … > src/types/database.ts`:
//   - A shell redirect truncates the file BEFORE the generator runs, so a failed
//     or empty run wiped the committed types. This writes only a complete,
//     parseable result.
//   - Supabase CLI >= 2.118 generates local types with a newer postgres-meta
//     that no longer formats its output. It is formatted here with a pinned
//     Prettier (no semicolons — the style the file has always had), so the diff
//     after a migration shows the schema change, not whitespace.
//   - A function installed in `public` by an extension (dblink, left behind by
//     the old dblink race smoke (supabase/tests/0183_waiver_race_smoke.sql,
//     since replaced by scripts/waiver-concurrency-proof.ts) before it moved to
//     the `extensions` schema) is not part of the app schema; the run refuses and
//     says how to move it rather than committing it into the types.
//
// Usage: node scripts/db-types.mjs            (local stack)
//        node scripts/db-types.mjs --workdir <dir with its own supabase/>
//        node scripts/db-types.mjs --db-url "$SUPABASE_DB_URL"
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as prettier from "prettier";
import { refuseGeneratedTypes, typesSourceArgs } from "./lib/db-types-check.mjs";

const OUT = join(process.cwd(), "src", "types", "database.ts");
// --workdir <dir>: generate from ANOTHER local stack (e.g. an isolated one started
// from a copy of supabase/), so the shared stack's unmerged objects stay out.
// Unknown options are refused before anything runs (see typesSourceArgs).
const source = typesSourceArgs(process.argv.slice(2));
if (source.error) {
  console.error(`db-types: ${source.error} — src/types/database.ts left unchanged`);
  process.exit(1);
}

const gen = spawnSync("supabase", ["gen", "types", "typescript", ...source.args], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
if (gen.error || gen.status !== 0) {
  console.error(`db-types: supabase gen types failed (${gen.error?.message ?? `exit ${gen.status}`}) — src/types/database.ts left unchanged`);
  process.exit(1);
}
const refusal = refuseGeneratedTypes(gen.stdout);
if (refusal) {
  console.error(`db-types: ${refusal}\n  src/types/database.ts left unchanged`);
  process.exit(1);
}

const formatted = await prettier.format(gen.stdout, { parser: "typescript", semi: false });
writeFileSync(OUT, formatted);
console.log(`db-types: wrote ${OUT}`);

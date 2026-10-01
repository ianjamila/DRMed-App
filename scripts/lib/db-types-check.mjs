// Pure checks for scripts/db-types.mjs, kept separate so they are unit-tested.
import { parseArgs } from "node:util";

/**
 * The `supabase gen types` source flags for these CLI arguments, or `{ error }`.
 * Strict: `--workdir=<dir>` and `--workdir <dir>` both work, and an unknown or
 * misspelled option is refused — silently falling back to `--local` would write
 * the SHARED stack's types (other sessions' unmerged objects) into the file.
 */
export function typesSourceArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "db-url": { type: "string" }, workdir: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { error: err.message };
  }
  const dbUrl = values["db-url"];
  const workdir = values.workdir;
  if (dbUrl !== undefined && !dbUrl) return { error: "--db-url needs a value" };
  if (workdir !== undefined && !workdir) return { error: "--workdir needs a value" };
  if (dbUrl && workdir) return { error: "choose --db-url or --workdir, not both" };
  if (dbUrl) return { args: ["--db-url", dbUrl] };
  return { args: workdir ? ["--local", "--workdir", workdir] : ["--local"] };
}

/** Why a generator run must not be written, or null when it is safe to write. */
export function refuseGeneratedTypes(stdout) {
  if (!/export type Database\s*=/.test(stdout)) {
    return "the generator printed no Database type";
  }
  const dblink = new Set([...stdout.matchAll(/^\s*"?(dblink[a-z_]*)"?\s*:/gm)].map((m) => m[1]));
  if (dblink.size > 0) {
    return (
      `${dblink.size} dblink functions are installed in public on this database — not app schema.\n` +
      "  Move them (non-destructive, they keep working):  alter extension dblink set schema extensions;"
    );
  }
  return null;
}

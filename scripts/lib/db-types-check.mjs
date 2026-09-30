// Pure checks for scripts/db-types.mjs, kept separate so they are unit-tested.

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

// scripts/patient-dedup/lib/args.ts
// Pure CLI argument parsing for `npm run dedup:patients` (kept out of
// engine.ts so tests don't import the env loader or a database client).
// Since 0196 every merge is recorded against a named, ACTIVE admin — the SQL
// function refuses anything else (P0078) — so --commit requires --actor.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DedupArgs {
  commit: boolean;
  actor: string | null;
}

export function parseDedupArgs(argv: readonly string[]): DedupArgs {
  const commit = argv.includes("--commit");
  const eq = argv.find((a) => a.startsWith("--actor="));
  const at = argv.indexOf("--actor");
  const raw = eq !== undefined ? eq.slice("--actor=".length) : at >= 0 ? (argv[at + 1] ?? "") : null;
  if (raw !== null && !UUID_RE.test(raw)) {
    throw new Error("--actor must be an admin's staff id (a UUID, from Admin Tools › Staff).");
  }
  if (commit && raw === null) {
    throw new Error("--commit needs --actor=<admin staff id>: every merge is recorded against an active admin.");
  }
  return { commit, actor: raw };
}

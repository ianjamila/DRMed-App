// Diffs two snapshots from rls-equivalence-probe.ts. Exits 1 on any difference.
//
// Deliberately dumb: no tolerances, no "expected" diffs, no allowlist. Row
// visibility either is identical or the migration does not ship. The moment this
// grows an exception list it stops being evidence.
import { readFileSync } from "node:fs";

type Observation = { n: string; fp: string } | { error: string };

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error(
    "usage: tsx scripts/perf/rls-equivalence-check.ts <before.json> <after.json>",
  );
  process.exit(1);
}

const before: Record<string, Observation> = JSON.parse(
  readFileSync(beforePath, "utf8"),
);
const after: Record<string, Observation> = JSON.parse(
  readFileSync(afterPath, "utf8"),
);

const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
const diffs: string[] = [];

for (const k of keys) {
  const b = before[k];
  const a = after[k];
  if (!b) {
    diffs.push(`${k}: MISSING from ${beforePath}`);
    continue;
  }
  if (!a) {
    diffs.push(`${k}: MISSING from ${afterPath}`);
    continue;
  }
  if (JSON.stringify(b) !== JSON.stringify(a)) {
    diffs.push(
      `${k}:\n    before ${JSON.stringify(b)}\n    after  ${JSON.stringify(a)}`,
    );
  }
}

if (diffs.length > 0) {
  console.error(
    `ROW VISIBILITY CHANGED — ${diffs.length} of ${keys.length} observations differ:\n`,
  );
  for (const d of diffs) console.error("  " + d);
  console.error(
    "\nThe migration must not ship. Every observation must be identical.\n" +
      "Do not adjust this checker to make it pass — fix the migration.",
  );
  process.exit(1);
}

console.log(
  `OK — all ${keys.length} observations identical across ${beforePath} -> ${afterPath}`,
);

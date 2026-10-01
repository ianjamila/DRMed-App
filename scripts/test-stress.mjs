#!/usr/bin/env node
// Flake hunter: repeat the vitest suite (optionally K copies at once to load
// the CPU) and report which tests failed in how many runs.
//   npm run test:stress -- --runs 5 --parallel 2 [--late-mocks 50] [file filters...]
// --late-mocks MS makes every vi.fn mockResolvedValue(Once) resolve MS late
// (scripts/lib/late-mocks-setup.ts), turning sync-assert-after-await races into
// deterministic failures. Off by default; fake-timer tests may need it off.
// Reports are written under os.tmpdir(), never the repo. Exit 1 on any failure.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStressArgs, tallyRuns } from "./lib/test-stress-tally.mjs";

let opts;
try {
  opts = parseStressArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error("Usage: npm run test:stress -- [--runs N] [--parallel K] [--late-mocks MS] [vitest file filters...]");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "test-stress-"));
const vitestBin = join(process.cwd(), "node_modules", ".bin", "vitest");

function runOne(round, k) {
  const out = join(dir, `run-${round}-${k}.json`);
  return new Promise((resolve) => {
    const child = spawn(
      vitestBin,
      [
        "run",
        ...(opts.lateMocks ? ["-c", "scripts/lib/vitest.late-mocks.config.ts"] : []),
        "--reporter=json",
        `--outputFile=${out}`,
        ...opts.filters,
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, ...(opts.lateMocks ? { LATE_MOCKS_MS: String(opts.lateMocks) } : {}) },
      },
    );
    child.on("error", () => resolve({ label: `run ${round}.${k}`, report: null }));
    child.on("close", () => {
      let report = null;
      if (existsSync(out)) {
        try {
          report = JSON.parse(readFileSync(out, "utf8"));
        } catch {}
      }
      resolve({ label: `run ${round}.${k}`, report });
    });
  });
}

const all = [];
for (let round = 1; round <= opts.runs; round++) {
  const batch = await Promise.all(Array.from({ length: opts.parallel }, (_, k) => runOne(round, k + 1)));
  all.push(...batch);
  const failed = batch.reduce((n, r) => n + (r.report?.numFailedTests ?? 0) + (r.report ? 0 : 1), 0);
  console.log(`round ${round}/${opts.runs}: ${failed === 0 ? "green" : `${failed} failure(s)`}`);
}

const { tests, perRun } = tallyRuns(all);
const flaky = tests.filter((t) => t.failures > 0);
console.log(`\nReports: ${dir}`);
console.log("\nPer run:");
for (const r of perRun) console.log(`  ${r.label.padEnd(10)} passed ${String(r.passed).padStart(5)}  failed ${r.failed}`);
console.log("\nTests that failed (failures/total runs):");
if (flaky.length === 0) console.log("  none");
for (const t of flaky) console.log(`  ${t.failures}/${t.total}  ${t.key}`);

const unreadable = all.filter((r) => !r.report).length;
if (unreadable) console.log(`\n${unreadable} run(s) produced no readable report - counted as failures.`);
process.exit(flaky.length > 0 || unreadable > 0 ? 1 : 0);

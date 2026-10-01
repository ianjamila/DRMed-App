// Pure helpers for scripts/test-stress.mjs: argument parsing and tallying of
// vitest `--reporter=json` results across repeated runs.

/** @param {string[]} argv */
export function parseStressArgs(argv) {
  const out = { runs: 5, parallel: 1, lateMocks: 0, filters: [] };
  const num = (flag, v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive whole number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(runs|parallel|late-mocks)(?:=(.*))?$/.exec(a);
    if (m) {
      const v = m[2] ?? argv[++i];
      if (v === undefined) throw new Error(`--${m[1]} needs a value`);
      out[m[1] === "late-mocks" ? "lateMocks" : m[1]] = num(`--${m[1]}`, v);
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option ${a} (only --runs, --parallel, --late-mocks and file filters are accepted)`);
    } else {
      out.filters.push(a);
    }
  }
  return out;
}

/**
 * @param {Array<{ label: string, report: any }>} runs one entry per vitest process
 * @returns {{ tests: Array<{ key: string, failures: number, total: number }>, perRun: Array<{ label: string, passed: number, failed: number }> }}
 */
export function tallyRuns(runs) {
  const byKey = new Map();
  const perRun = [];
  for (const { label, report } of runs) {
    let passed = 0;
    let failed = 0;
    for (const file of report?.testResults ?? []) {
      const name = String(file.name ?? "").replace(/^.*?\/(src|scripts)\//, "$1/");
      for (const t of file.assertionResults ?? []) {
        if (t.status === "pending" || t.status === "skipped" || t.status === "todo") continue;
        const key = `${name} :: ${t.fullName ?? t.title}`;
        const row = byKey.get(key) ?? { key, failures: 0, total: 0 };
        row.total++;
        if (t.status === "failed") {
          row.failures++;
          failed++;
        } else passed++;
        byKey.set(key, row);
      }
      // A file that failed to load has no assertion results but is a failure.
      if (file.status === "failed" && !(file.assertionResults ?? []).length) {
        const key = `${name} :: (file failed to run)`;
        const row = byKey.get(key) ?? { key, failures: 0, total: 0 };
        row.total++;
        row.failures++;
        failed++;
        byKey.set(key, row);
      }
    }
    perRun.push({ label, passed, failed });
  }
  const tests = [...byKey.values()].sort((a, b) => b.failures - a.failures || a.key.localeCompare(b.key));
  return { tests, perRun };
}

/**
 * Why a whole vitest process counts as failed, or null when it is clean.
 * Catches what per-test tallies cannot: a crash, a kill, a file that failed to
 * load, or a filter that matched nothing (zero tests is never "green").
 * @param {{ code?: number | null, signal?: string | null, report: any }} run
 * @returns {string | null}
 */
export function runFailureReason({ code, signal, report }) {
  if (signal) return `killed by ${signal}`;
  // Checked before the exit code: vitest exits 1 when a filter matches nothing.
  if (report && report.numTotalTests === 0) return "no tests ran";
  if (code !== 0 && code !== undefined) return `vitest exited ${code}`;
  if (!report) return "no readable report";
  if (report.success === false) return "vitest reported failure";
  if ((report.numFailedTestSuites ?? 0) > 0) return `${report.numFailedTestSuites} test file(s) failed to run`;
  if (!(report.numTotalTests > 0)) return "no tests ran";
  return null;
}

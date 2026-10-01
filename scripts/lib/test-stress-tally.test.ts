import { describe, expect, it } from "vitest";
import { parseStressArgs, runFailureReason, tallyRuns } from "./test-stress-tally.mjs";

describe("parseStressArgs", () => {
  it("defaults to 5 runs, 1 process, no filters", () => {
    expect(parseStressArgs([])).toEqual({ runs: 5, parallel: 1, lateMocks: 0, filters: [] });
  });
  it("reads spaced and = forms and passes the rest through as filters", () => {
    expect(parseStressArgs(["--runs", "3", "--parallel=2", "--late-mocks", "50", "messages-bulk-bar", "edit-payment"])).toEqual({
      runs: 3,
      parallel: 2,
      lateMocks: 50,
      filters: ["messages-bulk-bar", "edit-payment"],
    });
  });
  it("refuses bad numbers, missing values and unknown flags", () => {
    expect(() => parseStressArgs(["--runs", "0"])).toThrow(/positive/);
    expect(() => parseStressArgs(["--parallel", "x"])).toThrow(/positive/);
    expect(() => parseStressArgs(["--runs"])).toThrow(/needs a value/);
    expect(() => parseStressArgs(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseStressArgs(["-t", "x"])).toThrow(/Unknown option -t/);
  });
});

const report = (statuses: Record<string, string>) => ({
  testResults: [
    {
      name: "/x/repo/src/a.test.ts",
      status: "passed",
      assertionResults: Object.entries(statuses).map(([title, status]) => ({ fullName: title, title, status })),
    },
  ],
});

describe("tallyRuns", () => {
  it("counts failures per test across runs, worst first, and per-run totals", () => {
    const { tests, perRun } = tallyRuns([
      { label: "r1", report: report({ one: "passed", two: "failed", skip: "pending" }) },
      { label: "r2", report: report({ one: "passed", two: "passed" }) },
      { label: "r3", report: report({ one: "failed", two: "failed" }) },
    ]);
    expect(tests).toEqual([
      { key: "src/a.test.ts :: two", failures: 2, total: 3 },
      { key: "src/a.test.ts :: one", failures: 1, total: 3 },
    ]);
    expect(perRun).toEqual([
      { label: "r1", passed: 1, failed: 1 },
      { label: "r2", passed: 2, failed: 0 },
      { label: "r3", passed: 0, failed: 2 },
    ]);
  });
  it("counts a file that failed to load, and a missing report, without throwing", () => {
    const { tests, perRun } = tallyRuns([
      { label: "r1", report: { testResults: [{ name: "/x/src/b.test.ts", status: "failed", assertionResults: [] }] } },
      { label: "r2", report: null },
    ]);
    expect(tests).toEqual([{ key: "src/b.test.ts :: (file failed to run)", failures: 1, total: 1 }]);
    expect(perRun[1]).toEqual({ label: "r2", passed: 0, failed: 0 });
  });
});

describe("runFailureReason", () => {
  const ok = { numTotalTests: 3, numFailedTestSuites: 0, success: true };
  it("is null for a clean run", () => {
    expect(runFailureReason({ code: 0, signal: null, report: ok })).toBeNull();
  });
  it("flags zero tests as a failure, never green", () => {
    expect(runFailureReason({ code: 0, signal: null, report: { ...ok, numTotalTests: 0 } })).toBe("no tests ran");
  });
  it("flags a non-zero exit, a kill, a missing report, and a file that failed to load", () => {
    expect(runFailureReason({ code: 1, signal: null, report: ok })).toBe("vitest exited 1");
    expect(runFailureReason({ code: null, signal: "SIGKILL", report: ok })).toBe("killed by SIGKILL");
    expect(runFailureReason({ code: 0, signal: null, report: null })).toBe("no readable report");
    expect(runFailureReason({ code: 0, signal: null, report: { ...ok, numFailedTestSuites: 1 } })).toMatch(/failed to run/);
    expect(runFailureReason({ code: 0, signal: null, report: { ...ok, success: false } })).toBe("vitest reported failure");
  });
});

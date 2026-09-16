import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRON_HEARTBEATS, deriveCronStatus } from "./cron-heartbeats";

const workflow = readFileSync(".github/workflows/cron-watchdog.yml", "utf8");

// Intentionally strict: an SQL shape change must update this parser, not skip rows.
function parseWatched(source: string) {
  const values = source.match(/WITH watched\(route, actions, max_age, active_from\) AS \(\s*VALUES([\s\S]*?)\), heartbeats AS/);
  if (!values) throw new Error("Cannot find watched VALUES table");
  const rowPattern = /\('([^']+)',\s*ARRAY\[([^\]]+)\],\s*interval '(\d+) (hours|days)',\s*date '(\d{4}-\d{2}-\d{2})'\)/g;
  const rows = [...values[1].matchAll(rowPattern)];
  if (rows.length !== CRON_HEARTBEATS.length) {
    throw new Error(`Parsed ${rows.length} watched rows; expected ${CRON_HEARTBEATS.length}`);
  }
  if (values[1].replace(rowPattern, "").replace(/[\s,]/g, "")) {
    throw new Error("Unparsed SQL remains in watched VALUES");
  }
  return rows.map(([, route, actions, amount, unit, activeFrom]) => ({
    route,
    actions: [...actions.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
    maxAge: Number(amount) * (unit === "days" ? 24 : 1) * 60 * 60 * 1000,
    activeFrom,
  }));
}

describe("cron drift guards", () => {
  it("matches every vercel path + schedule exactly once, in both directions", () => {
    const { crons } = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons: { path: string; schedule: string }[];
    };
    const identity = (cron: { path: string; schedule: string }) => `${cron.path}|${cron.schedule}`;
    const expected = CRON_HEARTBEATS.map(identity).sort();
    expect(CRON_HEARTBEATS.length).toBeGreaterThan(0);
    expect(new Set(CRON_HEARTBEATS.map((c) => c.key)).size).toBe(CRON_HEARTBEATS.length);
    expect(new Set(expected).size).toBe(expected.length);
    expect(crons.map(identity).sort()).toEqual(expected);
  });

  it("matches every SQL watcher to the canonical module", () => {
    const rows = parseWatched(workflow);
    expect(rows).toHaveLength(CRON_HEARTBEATS.length);
    const byRoute = (a: { route: string }, b: { route: string }) => a.route.localeCompare(b.route);
    expect(rows.sort(byRoute)).toEqual(CRON_HEARTBEATS.map((c) => ({
      route: c.path.replace("/api/cron/", ""),
      actions: [...c.actions].sort(), maxAge: c.maxAge, activeFrom: c.activeFrom,
    })).sort(byRoute));
  });

  it("fails loudly for absent, empty, or partially parsed VALUES", () => {
    expect(() => parseWatched("")).toThrow();
    expect(() => parseWatched(workflow.replace(/\('sync-accounting'[^\n]+/, ""))).toThrow(/Parsed 6/);
    expect(() => parseWatched(workflow.replace(/\('.*?\)/g, ""))).toThrow(/Parsed 0/);
    expect(() => parseWatched(workflow.replace("VALUES", "VALUES (unsupported_row),"))).toThrow(/Unparsed SQL/);
  });

  it("pins the system-only filter, UTC session, and status boundaries", () => {
    expect(workflow).toContain("AND a.actor_type = 'system'");
    expect(workflow).toContain("-c timezone=UTC");
    expect(workflow).toContain("WHEN last_seen IS NULL AND now() < active_from THEN 'PENDING'");
    expect(workflow).toContain("WHEN last_seen IS NULL OR age > max_age THEN 'STALE'");
    expect(workflow).toContain("ELSE 'HEALTHY'");
  });
});

describe("deriveCronStatus", () => {
  const now = Date.parse("2026-09-18T00:00:00Z");
  const maxAge = 30 * 60 * 60 * 1000;
  it.each([
    ["fresh", now - 1000, "healthy"],
    ["exactly at the threshold", now - maxAge, "healthy"],
    ["older than the threshold", now - maxAge - 1, "stale"],
  ] as const)("%s", (_label, lastSeen, expected) => {
    expect(deriveCronStatus(new Date(lastSeen).toISOString(), now, maxAge, "2026-09-18")).toBe(expected);
  });
  it.each([
    ["before activation", now - 1, "pending"],
    ["on activation", now, "stale"],
    ["after activation", now + 1, "stale"],
  ] as const)("never ran %s", (_label, current, expected) => {
    expect(deriveCronStatus(null, current, maxAge, "2026-09-18")).toBe(expected);
  });
  it("does not give an old heartbeat a bootstrap exemption", () => {
    expect(deriveCronStatus("2026-09-01T00:00:00Z", now, maxAge, "2026-09-22")).toBe("stale");
  });
});

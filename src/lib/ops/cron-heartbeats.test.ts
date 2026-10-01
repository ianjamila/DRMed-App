import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRON_HEARTBEATS, NOTICE_WATCH_GRACE_MINUTES, deriveCronStatus, isNoticeSweepWatched } from "./cron-heartbeats";

const workflow = readFileSync(".github/workflows/cron-watchdog.yml", "utf8");

// Intentionally strict: an SQL shape change must update this parser, not skip rows.
function parseWatched(source: string) {
  const values = source.match(/WITH watched\(route, actions, max_age, active_from, require_trigger, watch_when\) AS \(\s*VALUES([\s\S]*?)\), gates AS/);
  if (!values) throw new Error("Cannot find watched VALUES table");
  const rowPattern = /\('([^']+)',\s*ARRAY\[([^\]]+)\],\s*interval '(\d+) (hours|days)',\s*date '(\d{4}-\d{2}-\d{2})',\s*(NULL::text|'[^']+'),\s*(NULL::text|'[^']+')\)/g;
  const rows = [...values[1].matchAll(rowPattern)];
  if (rows.length !== CRON_HEARTBEATS.length) {
    throw new Error(`Parsed ${rows.length} watched rows; expected ${CRON_HEARTBEATS.length}`);
  }
  const withoutRows = values[1].replace(rowPattern, "");
  if (withoutRows.replace(/--[^\n]*/g, "").replace(/[\s,]/g, "")) {
    throw new Error("Unparsed SQL remains in watched VALUES");
  }
  return rows.map(([, route, actions, amount, unit, activeFrom, requireTrigger, watchWhen]) => ({
    route,
    actions: [...actions.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
    maxAge: Number(amount) * (unit === "days" ? 24 : 1) * 60 * 60 * 1000,
    activeFrom,
    requireTrigger: requireTrigger === "NULL::text" ? null : requireTrigger.slice(1, -1),
    watchWhen: watchWhen === "NULL::text" ? null : watchWhen.slice(1, -1),
  }));
}

describe("cron drift guards", () => {
  it("matches every vercel path + schedule exactly once, in both directions", () => {
    const { crons } = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons: { path: string; schedule: string }[];
    };
    const identity = (cron: { path: string; schedule: string }) => `${cron.path}|${cron.schedule}`;
    // A pg_cron-scheduled leg (0212) is deliberately NOT in vercel.json.
    const vercelLegs = CRON_HEARTBEATS.filter((c) => !("scheduler" in c));
    const expected = vercelLegs.map(identity).sort();
    expect(CRON_HEARTBEATS.length).toBeGreaterThan(0);
    expect(new Set(CRON_HEARTBEATS.map((c) => c.key)).size).toBe(CRON_HEARTBEATS.length);
    expect(new Set(expected).size).toBe(expected.length);
    expect(crons.map(identity).sort()).toEqual(expected);
  });

  it("only the release-notices sweeper is scheduled outside vercel.json (pg_cron), and its migration pins the same schedule", () => {
    expect(CRON_HEARTBEATS.filter((c) => "scheduler" in c).map((c) => [c.key, c.schedule])).toEqual([
      ["release-notices", "*/5 * * * *"],
    ]);
    const migration = readFileSync("supabase/migrations/0212_release_notice_sweep_cron.sql", "utf8");
    expect(migration).toContain("cron.schedule('release-notice-sweep', '*/5 * * * *'");
    expect(readFileSync("vercel.json", "utf8")).not.toContain("release-notices");
  });

  it("matches every SQL watcher to the canonical module", () => {
    const rows = parseWatched(workflow);
    expect(rows).toHaveLength(CRON_HEARTBEATS.length);
    const byRoute = (a: { route: string }, b: { route: string }) => a.route.localeCompare(b.route);
    expect(rows.sort(byRoute)).toEqual(CRON_HEARTBEATS.map((c) => ({
      route: c.path.replace("/api/cron/", ""),
      actions: [...c.actions].sort(), maxAge: c.maxAge, activeFrom: c.activeFrom,
      requireTrigger: "requireTrigger" in c ? c.requireTrigger : null,
      watchWhen: "watchWhen" in c ? c.watchWhen : null,
    })).sort(byRoute));
  });

  it("only sheet-sync requires a trigger — a manual/CLI 'system' run must not count as its cron heartbeat", () => {
    expect(CRON_HEARTBEATS.filter((c) => "requireTrigger" in c).map((c) => c.key)).toEqual(["sheet-sync"]);
    expect(workflow).toContain("AND (w.require_trigger IS NULL OR a.metadata->>'trigger' = w.require_trigger)");
  });

  it("fails loudly for absent, empty, or partially parsed VALUES", () => {
    expect(() => parseWatched("")).toThrow();
    expect(() => parseWatched(workflow.replace(/\('sync-accounting'[^\n]+/, ""))).toThrow(new RegExp(`Parsed ${CRON_HEARTBEATS.length - 1} `));
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

describe("the release-notices watch gate", () => {
  it("only release-notices is gated, and the SQL gate is the flag AND 15 minutes since it was switched on", () => {
    expect(CRON_HEARTBEATS.filter((c) => "watchWhen" in c).map((c) => c.key)).toEqual(["release-notices"]);
    expect(workflow).toContain("s.enabled AND s.updated_at < now() - interval '15 minutes'");
    expect(workflow).toContain("WHEN NOT watched THEN 'PENDING'");
    expect(NOTICE_WATCH_GRACE_MINUTES).toBe(15);
  });
  const now = Date.parse("2026-10-05T12:00:00Z");
  it.each([
    ["flag off", false, "2026-10-01T00:00:00Z", false],
    ["on, switched on 5 minutes ago", true, "2026-10-05T11:55:00Z", false],
    ["on, exactly 15 minutes", true, "2026-10-05T11:45:00Z", false],
    ["on, 16 minutes ago", true, "2026-10-05T11:44:00Z", true],
    ["on, no timestamp", true, null, false],
  ] as const)("%s", (_l, enabled, updatedAt, expected) => {
    expect(isNoticeSweepWatched(enabled, updatedAt, now)).toBe(expected);
  });
  it("an unwatched leg is never stale, even with no heartbeat after its grace date", () => {
    expect(deriveCronStatus(null, now, 6 * 3_600_000, "2026-10-02", false)).toBe("pending");
    expect(deriveCronStatus("2026-09-01T00:00:00Z", now, 6 * 3_600_000, "2026-10-02", false)).toBe("pending");
    expect(deriveCronStatus(null, now, 6 * 3_600_000, "2026-10-02", true)).toBe("stale");
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

describe("Cron Health names each task in plain words", () => {
  it("gives every scheduled task its own label and description, never a route", () => {
    const labels = CRON_HEARTBEATS.map((cron) => cron.label);
    expect(new Set(labels).size).toBe(CRON_HEARTBEATS.length);
    for (const cron of CRON_HEARTBEATS) {
      expect(cron.label, cron.key).toMatch(/^[A-Z]/);
      expect(cron.label, cron.key).not.toMatch(/[/_?=]|api|cron/i);
      expect(cron.description.length, cron.key).toBeGreaterThan(20);
      expect(cron.description, cron.key).not.toMatch(/[/_?=]/);
    }
  });

  it("tells the daily and weekly template checks apart", () => {
    const byKey = new Map<string, string>(CRON_HEARTBEATS.map((cron) => [cron.key, cron.label]));
    expect(byKey.get("template-health")).not.toBe(byKey.get("template-health-weekly"));
  });
});

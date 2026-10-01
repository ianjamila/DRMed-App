import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const NOW = Date.parse("2026-10-01T12:00:00Z");
const fx = vi.hoisted(() => ({
  counts: null as unknown,
  recent: { data: [] as unknown[], error: null as null | { message: string } },
  lastAbandonedAlert: { data: [] as unknown[], error: null as null | { message: string } },
  fresh: { ok: true, count: 0 } as { ok: boolean; count?: number },
  sinceArgs: [] as string[],
  reported: [] as Array<{ scope: string; error: Error; metadata?: Record<string, unknown> }>,
  chains: [] as unknown[][][],
}));

vi.mock("@/lib/results/release-notice-followups.server", () => ({ fetchOutboxCounts: async () => fx.counts,
  countLiveAbandonedSince: async (since: string) => (fx.sinceArgs.push(since), fx.fresh),
}));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async (a: never) => void fx.reported.push(a) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const calls: unknown[][] = [];
      fx.chains.push(calls);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "order", "limit"]) b[m] = (...a: unknown[]) => (calls.push([m, ...a]), b);
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(calls.some((c) => c[0] === "eq" && c[2] === "cron/release-notices:abandoned") ? fx.lastAbandonedAlert : fx.recent);
      return b;
    },
  }),
}));

import { ABANDONED_SCOPE, BACKLOG_SCOPE, alertOnSweep } from "./release-notice-alerts.server";

const base = { queued: 0, overdue: 0, oldestOverdueAt: null, expiredLeases: 0, oldestExpiredLeaseAt: null, abandoned24h: 0, abandoned7d: 0, sent24h: 0 };
const stale = new Date(NOW - 3 * 3_600_000).toISOString();

beforeEach(() => {
  fx.counts = { ok: true, counts: base };
  fx.recent = { data: [], error: null };
  fx.reported.length = 0;
  fx.chains.length = 0;
  fx.lastAbandonedAlert = { data: [], error: null };
  fx.fresh = { ok: true, count: 0 };
  fx.sinceArgs.length = 0;
});

describe("alertOnSweep", () => {
  it("is silent for a clean run", async () => {
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.reported).toEqual([]);
  });

  it("alerts on live abandoned notices with the count only, whoever abandoned them (sender run or lease-exhausted claim)", async () => {
    fx.fresh = { ok: true, count: 2 };
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.reported).toHaveLength(1);
    expect(fx.reported[0].scope).toBe(ABANDONED_SCOPE);
    expect(fx.reported[0].metadata).toEqual({ abandoned: 2 });
  });

  it("counts only rows newer than the last abandoned alert, and does not repeat for the same rows", async () => {
    fx.lastAbandonedAlert = { data: [{ created_at: "2026-10-01T11:55:00.000Z" }], error: null };
    fx.fresh = { ok: true, count: 0 }; // the same rows are now older than the alert
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.sinceArgs).toEqual(["2026-10-01T11:55:00.000Z"]);
    expect(fx.reported).toEqual([]);
  });

  it("falls back to a 24 h window when there is no earlier alert, and when the lookup fails", async () => {
    const fallback = new Date(NOW - 24 * 3_600_000).toISOString();
    await alertOnSweep({ enabled: true }, NOW);
    fx.lastAbandonedAlert = { data: [], error: { message: "boom" } };
    fx.fresh = { ok: true, count: 1 };
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.sinceArgs).toEqual([fallback, fallback]);
    expect(fx.reported.map((r) => r.scope)).toEqual([ABANDONED_SCOPE]);
  });

  it("bounds the abandoned-alert lookup to the fallback window", async () => {
    await alertOnSweep({ enabled: true }, NOW);
    const chain = fx.chains.find((c) => c.some((x) => x[0] === "eq" && x[2] === ABANDONED_SCOPE))!;
    expect(chain).toContainEqual(["gte", "created_at", new Date(NOW - 24 * 3_600_000).toISOString()]);
  });

  it("stays quiet when the abandoned count cannot be read", async () => {
    fx.fresh = { ok: false };
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.reported).toEqual([]);
  });

  it("reports a problem backlog with counts only", async () => {
    fx.counts = { ok: true, counts: { ...base, queued: 5, overdue: 5, oldestOverdueAt: stale } };
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.reported.map((r) => r.scope)).toEqual([BACKLOG_SCOPE]);
    expect(fx.reported[0].metadata).toMatchObject({ overdue: 5, queued: 5, oldest_overdue_minutes: 180 });
  });

  it("does not repeat a backlog alert inside the cooldown", async () => {
    fx.counts = { ok: true, counts: { ...base, overdue: 5, oldestOverdueAt: stale } };
    fx.recent = { data: [{ created_at: "x" }], error: null };
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.reported).toEqual([]);
    const chain = fx.chains.find((c) => c.some((x) => x[0] === "eq" && x[2] === BACKLOG_SCOPE))!;
    expect(chain).toContainEqual(["gte", "created_at", new Date(NOW - 6 * 3_600_000).toISOString()]);
  });

  it("alerts when the cooldown lookup itself fails", async () => {
    fx.counts = { ok: true, counts: { ...base, overdue: 1, oldestOverdueAt: stale } };
    fx.recent = { data: [], error: { message: "boom" } };
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.reported).toHaveLength(1);
  });

  it("does not alert for a mere warning, or when the counts cannot be read", async () => {
    fx.counts = { ok: true, counts: { ...base, overdue: 1, oldestOverdueAt: new Date(NOW - 45 * 60_000).toISOString() } };
    await alertOnSweep({ enabled: true }, NOW);
    fx.counts = { ok: false };
    await alertOnSweep({ enabled: true }, NOW);
    expect(fx.reported).toEqual([]);
  });

  it("skips the backlog check when the outbox is off, and never throws", async () => {
    fx.counts = { ok: true, counts: { ...base, overdue: 1, oldestOverdueAt: stale } };
    await alertOnSweep({ enabled: false }, NOW);
    expect(fx.reported).toEqual([]);
    fx.counts = null; // makes the code under test throw
    await expect(alertOnSweep({ enabled: true }, NOW)).resolves.toBeUndefined();
  });
});

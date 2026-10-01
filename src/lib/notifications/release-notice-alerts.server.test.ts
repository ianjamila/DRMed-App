import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const NOW = Date.parse("2026-10-01T12:00:00Z");
const fx = vi.hoisted(() => ({
  counts: null as unknown,
  recent: { data: [] as unknown[], error: null as null | { message: string } },
  reported: [] as Array<{ scope: string; error: Error; metadata?: Record<string, unknown> }>,
  auditCalls: [] as unknown[][],
}));

vi.mock("@/lib/results/release-notice-followups.server", () => ({ fetchOutboxCounts: async () => fx.counts }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async (a: never) => void fx.reported.push(a) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "limit"]) b[m] = (...a: unknown[]) => (fx.auditCalls.push([m, ...a]), b);
      b.then = (resolve: (v: unknown) => unknown) => resolve(fx.recent);
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
  fx.auditCalls.length = 0;
});

describe("alertOnSweep", () => {
  it("is silent for a clean run", async () => {
    await alertOnSweep({ enabled: true, abandoned: 0 }, NOW);
    expect(fx.reported).toEqual([]);
  });

  it("reports abandoned notices once per run, with the count only", async () => {
    await alertOnSweep({ enabled: true, abandoned: 2 }, NOW);
    expect(fx.reported).toHaveLength(1);
    expect(fx.reported[0].scope).toBe(ABANDONED_SCOPE);
    expect(fx.reported[0].metadata).toEqual({ abandoned: 2 });
  });

  it("reports a problem backlog with counts only", async () => {
    fx.counts = { ok: true, counts: { ...base, queued: 5, overdue: 5, oldestOverdueAt: stale } };
    await alertOnSweep({ enabled: true, abandoned: 0 }, NOW);
    expect(fx.reported.map((r) => r.scope)).toEqual([BACKLOG_SCOPE]);
    expect(fx.reported[0].metadata).toMatchObject({ overdue: 5, queued: 5, oldest_overdue_minutes: 180 });
  });

  it("does not repeat a backlog alert inside the cooldown", async () => {
    fx.counts = { ok: true, counts: { ...base, overdue: 5, oldestOverdueAt: stale } };
    fx.recent = { data: [{ created_at: "x" }], error: null };
    await alertOnSweep({ enabled: true, abandoned: 0 }, NOW);
    expect(fx.reported).toEqual([]);
    expect(fx.auditCalls).toContainEqual(["eq", "resource_type", BACKLOG_SCOPE]);
  });

  it("alerts when the cooldown lookup itself fails", async () => {
    fx.counts = { ok: true, counts: { ...base, overdue: 1, oldestOverdueAt: stale } };
    fx.recent = { data: [], error: { message: "boom" } };
    await alertOnSweep({ enabled: true, abandoned: 0 }, NOW);
    expect(fx.reported).toHaveLength(1);
  });

  it("does not alert for a mere warning, or when the counts cannot be read", async () => {
    fx.counts = { ok: true, counts: { ...base, overdue: 1, oldestOverdueAt: new Date(NOW - 45 * 60_000).toISOString() } };
    await alertOnSweep({ enabled: true, abandoned: 0 }, NOW);
    fx.counts = { ok: false };
    await alertOnSweep({ enabled: true, abandoned: 0 }, NOW);
    expect(fx.reported).toEqual([]);
  });

  it("skips the backlog check when the outbox is off, and never throws", async () => {
    fx.counts = { ok: true, counts: { ...base, overdue: 1, oldestOverdueAt: stale } };
    await alertOnSweep({ enabled: false, abandoned: 0 }, NOW);
    expect(fx.reported).toEqual([]);
    fx.counts = null; // makes the code under test throw
    await expect(alertOnSweep({ enabled: true, abandoned: 0 }, NOW)).resolves.toBeUndefined();
  });
});

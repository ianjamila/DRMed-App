import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const NOW = Date.parse("2026-10-01T12:00:00Z");
type R = { count?: number | null; data?: unknown[]; error: null | { message: string } };
const fx = vi.hoisted(() => ({ results: [] as R[], chains: [] as unknown[][][], next: 0 }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "release_notices") throw new Error(`unexpected table ${table}`);
      const calls: unknown[][] = [];
      fx.chains.push(calls);
      const idx = fx.chains.length - 1;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "lte", "lt", "gte", "order", "limit"]) b[m] = (...a: unknown[]) => (calls.push([m, ...a]), b);
      b.then = (resolve: (v: unknown) => unknown) => resolve(fx.results[idx]);
      return b;
    },
  }),
}));

import { LIVE_ABANDONED_FILTERS, fetchAbandonedNoticeCount, fetchOutboxCounts, fetchStuckNotices } from "./release-notice-followups.server";

const ok = (count: number, data: unknown[] = []): R => ({ count, data, error: null });

beforeEach(() => {
  fx.chains.length = 0;
  fx.results = [ok(7), ok(2, [{ next_attempt_at: "2026-10-01T10:00:00Z" }]), ok(1, [{ lease_expires_at: "2026-10-01T11:00:00Z" }]), ok(1), ok(4), ok(30)];
});

describe("fetchOutboxCounts", () => {
  it("maps the six counts and the oldest timestamps", async () => {
    expect(await fetchOutboxCounts(NOW)).toEqual({
      ok: true,
      counts: {
        queued: 7, overdue: 2, oldestOverdueAt: "2026-10-01T10:00:00Z",
        expiredLeases: 1, oldestExpiredLeaseAt: "2026-10-01T11:00:00Z",
        abandoned24h: 1, abandoned7d: 4, sent24h: 30,
      },
    });
  });

  it("uses the right statuses and windows", async () => {
    await fetchOutboxCounts(NOW);
    expect(fx.chains[1]).toContainEqual(["lte", "next_attempt_at", new Date(NOW).toISOString()]);
    expect(fx.chains[2]).toContainEqual(["eq", "status", "sending"]);
    expect(fx.chains[2]).toContainEqual(["lt", "lease_expires_at", new Date(NOW).toISOString()]);
    expect(fx.chains[3]).toContainEqual(["gte", "resolved_at", new Date(NOW - 86_400_000).toISOString()]);
    expect(fx.chains[4]).toContainEqual(["gte", "resolved_at", new Date(NOW - 7 * 86_400_000).toISOString()]);
    expect(fx.chains[5]).toContainEqual(["gte", "sent_at", new Date(NOW - 86_400_000).toISOString()]);
  });

  it("abandoned counts, the follow-ups list and the dashboard count share one live-notice filter (deleted visit / deleted or merged patient excluded from all)", async () => {
    fx.results = [ok(1), ok(0), ok(0), ok(1), ok(1), ok(0), { data: [], error: null }, ok(0), ok(3)];
    await fetchOutboxCounts(NOW);
    await fetchStuckNotices();
    const card = await fetchAbandonedNoticeCount();
    expect(card).toEqual({ ok: true, count: 3 });
    // chains 3,4 = 24h/7d counts; 6 = follow-ups list; 8 = dashboard count
    for (const i of [3, 4, 6, 8]) {
      expect(fx.chains[i]).toContainEqual(["eq", "status", "abandoned"]);
      for (const [col, val] of LIVE_ABANDONED_FILTERS) expect(fx.chains[i]).toContainEqual(["is", col, val]);
    }
    expect(LIVE_ABANDONED_FILTERS.map((x) => x[0])).toEqual(["visits.deleted_at", "visits.patients.deleted_at", "visits.patients.merged_into_id"]);
    // the counts embed the visit and patient inner, so a notice without a live one cannot match
    expect(String(fx.chains[3].find((c) => c[0] === "select")![1])).toContain("visits!inner");
  });

  it("the dashboard count reports a read failure", async () => {
    fx.results = [{ count: null, error: { message: "boom" } }];
    const r = await fetchAbandonedNoticeCount();
    expect(r.ok).toBe(false);
  });

  it("reads no patient columns", async () => {
    await fetchOutboxCounts(NOW);
    const selects = fx.chains.flat().filter((c) => c[0] === "select").map((c) => String(c[1]));
    expect(selects.join(" ")).not.toMatch(/phone|email|name|drm_id/i);
  });

  it("is not-ok when any read fails (never a false all-clear)", async () => {
    fx.results[4] = { count: null, error: { message: "boom" } };
    expect(await fetchOutboxCounts(NOW)).toEqual({ ok: false });
  });
});

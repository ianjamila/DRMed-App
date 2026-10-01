import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  summary: { enabled: true, claimed: 0, failures: 0 } as Record<string, unknown>,
  sweepError: null as unknown,
  audits: [] as Array<Record<string, unknown>>,
  monitored: [] as string[],
  failed: 0,
  reported: [] as string[],
  lastHeartbeat: null as string | null,
}));

vi.mock("@/lib/ops/cron-monitor", () => ({
  withCronMonitor: async (key: string, run: (markFailed: () => void) => Promise<Response>) => {
    fx.monitored.push(key);
    return run(() => {
      fx.failed += 1;
    });
  },
}));
vi.mock("@/lib/notifications/release-notice-sweep", () => ({
  runReleaseNoticeSweep: async () => {
    if (fx.sweepError) throw fx.sweepError;
    return fx.summary;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: fx.lastHeartbeat ? { created_at: fx.lastHeartbeat } : null, error: null });
      return b;
    },
  }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async (a: { scope: string }) => void fx.reported.push(a.scope) }));

import { GET, POST } from "./route";

const req = (auth?: string, method = "POST") =>
  new Request("http://localhost/api/cron/release-notices", { method, headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  fx.summary = { enabled: true, claimed: 2, audit_pending: 0, failures: 0 };
  fx.sweepError = null;
  fx.audits.length = 0;
  fx.monitored.length = 0;
  fx.failed = 0;
  fx.reported.length = 0;
  fx.lastHeartbeat = null;
});

describe("/api/cron/release-notices", () => {
  it("refuses a missing or wrong bearer (401) and does no work or monitoring", async () => {
    for (const bad of [undefined, "Bearer nope", "s3cret", "Bearer s3cre", "Bearer s3cret2", "bearer s3cret"]) {
      const res = await POST(req(bad));
      expect(res.status).toBe(401);
    }
    expect(fx.monitored).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });

  it("answers 500 when CRON_SECRET is not configured (never accepts an empty secret)", async () => {
    delete process.env.CRON_SECRET;
    expect((await POST(req("Bearer "))).status).toBe(500);
    expect((await POST(req("Bearer undefined"))).status).toBe(500);
    expect(fx.monitored).toHaveLength(0);
  });

  it("runs the sweep under its monitor and writes the heartbeat with the summary", async () => {
    const res = await POST(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, claimed: 2, audit_pending: 0, failures: 0 });
    expect(fx.monitored).toEqual(["release-notices"]);
    expect(fx.audits).toEqual([
      { actor_id: null, actor_type: "system", action: "system.release_notices.sweep.completed", metadata: { enabled: true, claimed: 2, audit_pending: 0, failures: 0 } },
    ]);
    expect(fx.failed).toBe(0);
  });

  it("while the flag is off the sweep does nothing but the heartbeat is STILL written (first one)", async () => {
    fx.summary = { enabled: false, claimed: 0, audit_pending: 0, failures: 0 };
    const res = await POST(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(fx.audits).toHaveLength(1);
    expect(fx.audits[0]).toMatchObject({ action: "system.release_notices.sweep.completed", metadata: { enabled: false } });
  });

  it("a quiet run is skipped when the last heartbeat is under 60 minutes old", async () => {
    fx.summary = { enabled: true, claimed: 0, audit_pending: 0, failures: 0 };
    fx.lastHeartbeat = new Date(Date.now() - 59 * 60_000).toISOString();
    expect((await POST(req("Bearer s3cret"))).status).toBe(200);
    expect(fx.audits).toHaveLength(0);
  });

  it("a quiet run writes once the last heartbeat is 60+ minutes old, or none exists", async () => {
    fx.summary = { enabled: true, claimed: 0, audit_pending: 0, failures: 0 };
    fx.lastHeartbeat = new Date(Date.now() - 61 * 60_000).toISOString();
    await POST(req("Bearer s3cret"));
    expect(fx.audits).toHaveLength(1);
    fx.audits.length = 0;
    fx.lastHeartbeat = null;
    await POST(req("Bearer s3cret"));
    expect(fx.audits).toHaveLength(1);
  });

  it.each([
    ["it claimed work", { claimed: 1, audit_pending: 0, failures: 0 }],
    ["it audited pending rows", { claimed: 0, audit_pending: 2, failures: 0 }],
    ["it failed", { claimed: 0, audit_pending: 0, failures: 1 }],
  ])("always writes when %s, even right after the last heartbeat", async (_n, partial) => {
    fx.summary = { enabled: true, ...partial };
    fx.lastHeartbeat = new Date().toISOString();
    await POST(req("Bearer s3cret"));
    expect(fx.audits).toHaveLength(1);
  });

  it("GET works too (by hand), with the same auth", async () => {
    expect((await GET(req("Bearer s3cret", "GET"))).status).toBe(200);
    expect((await GET(req(undefined, "GET"))).status).toBe(401);
  });

  it("a sweep that fails to claim answers 500, reports it and writes NO heartbeat", async () => {
    fx.sweepError = new Error("claim_release_notice failed: x");
    const res = await POST(req("Bearer s3cret"));
    expect(res.status).toBe(500);
    expect(fx.reported).toEqual(["cron/release-notices:sweep"]);
    expect(fx.audits).toHaveLength(0);
  });

  it("marks the monitor failed (but still answers 200 with a heartbeat) when some sends failed", async () => {
    fx.summary = { enabled: true, claimed: 3, audit_pending: 0, failures: 1 };
    const res = await POST(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(fx.failed).toBe(1);
    expect(fx.audits).toHaveLength(1);
  });
});

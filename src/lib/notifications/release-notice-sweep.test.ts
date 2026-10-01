import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  flag: { data: true as unknown, error: null as null | { message: string } },
  claim: { data: [] as unknown[], error: null as null | { message: string } },
  pending: { data: [] as unknown[], error: null as null | { message: string } },
  rpcs: [] as Array<{ name: string; args: unknown }>,
  filters: [] as unknown[][],
  active: 0,
  maxActive: 0,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: unknown) => {
      fx.rpcs.push({ name, args });
      if (name === "release_notices_enabled") return fx.flag;
      if (name === "claim_release_notice") return fx.claim;
      throw new Error(`unexpected rpc ${name}`);
    },
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "not", "is", "lte", "order", "limit"]) {
        b[m] = (...a: unknown[]) => {
          fx.filters.push([m, ...a]);
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve(fx.pending);
      return b;
    },
  }),
}));
vi.mock("@/lib/observability/report-error", () => ({ reportError: vi.fn(async () => {}) }));

const sender = vi.hoisted(() => ({ results: new Map<string, string>(), sent: [] as string[] }));
vi.mock("./release-notice-sender", () => ({
  sendReleaseNotice: vi.fn(async (row: { id: string }) => {
    fx.active += 1;
    fx.maxActive = Math.max(fx.maxActive, fx.active);
    sender.sent.push(row.id);
    await new Promise((r) => setTimeout(r, 5));
    fx.active -= 1;
    return { outcome: { status: "sent", channels: [], reason: null }, finalStatus: sender.results.get(row.id) ?? "sent" };
  }),
}));
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("./release-notice-audit", () => ({ auditTerminalNotice: auditMock }));

import { AUDIT_GRACE_MS, SWEEP_CLAIM_LIMIT, SWEEP_CONCURRENCY, runReleaseNoticeSweep } from "./release-notice-sweep";

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));

beforeEach(() => {
  fx.flag = { data: true, error: null };
  fx.claim = { data: [], error: null };
  fx.pending = { data: [], error: null };
  fx.rpcs = [];
  fx.filters = [];
  fx.active = 0;
  fx.maxActive = 0;
  sender.results.clear();
  sender.sent = [];
  auditMock.mockReset();
  auditMock.mockResolvedValue("stamped");
});

describe("runReleaseNoticeSweep", () => {
  it("does nothing while the flag is off: no claim, no send, no audit pass", async () => {
    fx.flag = { data: false, error: null };
    const s = await runReleaseNoticeSweep();
    expect(s.enabled).toBe(false);
    expect(fx.rpcs.map((r) => r.name)).toEqual(["release_notices_enabled"]);
    expect(fx.filters).toHaveLength(0);
  });

  it("an error reading the flag is OFF, and so is anything but true", async () => {
    fx.flag = { data: null, error: { message: "boom" } };
    expect((await runReleaseNoticeSweep()).enabled).toBe(false);
    fx.flag = { data: "true", error: null };
    expect((await runReleaseNoticeSweep()).enabled).toBe(false);
    expect(fx.rpcs.some((r) => r.name === "claim_release_notice")).toBe(false);
  });

  it("claims up to the limit with p_id left out (the sweeper, not the inline path)", async () => {
    await runReleaseNoticeSweep();
    expect(fx.rpcs[1]).toEqual({ name: "claim_release_notice", args: { p_limit: SWEEP_CLAIM_LIMIT } });
  });

  it("sends each claimed row with bounded concurrency and counts every final status", async () => {
    fx.claim = { data: rowsOf(10), error: null };
    sender.results.set("n1", "retry");
    sender.results.set("n2", "abandoned");
    sender.results.set("n3", "fenced");
    sender.results.set("n4", "suppressed");
    sender.results.set("n5", "cancelled");
    sender.results.set("n6", "skipped");
    sender.results.set("n7", "error");
    const s = await runReleaseNoticeSweep();
    expect(sender.sent.sort()).toEqual(rowsOf(10).map((r) => r.id).sort());
    expect(fx.maxActive).toBeLessThanOrEqual(SWEEP_CONCURRENCY);
    expect(fx.maxActive).toBeGreaterThan(1);
    expect(s).toMatchObject({ enabled: true, claimed: 10, sent: 3, retried: 1, abandoned: 1, deferred: 1, suppressed: 1, cancelled: 1, skipped: 1, failures: 1 });
  });

  it("audits terminal notices without an audit row (resolved, un-audited, past the grace) and counts them", async () => {
    fx.pending = { data: rowsOf(3), error: null };
    auditMock.mockResolvedValueOnce("stamped").mockResolvedValueOnce("already_audited").mockResolvedValueOnce("audit_failed");
    const s = await runReleaseNoticeSweep();
    expect(fx.filters).toContainEqual(["not", "resolved_at", "is", null]);
    expect(fx.filters).toContainEqual(["is", "audited_at", null]);
    const lte = fx.filters.find((f) => f[0] === "lte" && f[1] === "resolved_at")!;
    expect(Date.now() - Date.parse(lte[2] as string)).toBeGreaterThanOrEqual(AUDIT_GRACE_MS - 1000);
    expect(auditMock).toHaveBeenCalledTimes(3);
    expect(s).toMatchObject({ audit_pending: 3, audited: 2, failures: 1 });
  });

  it("a failed claim throws (the route answers 500); a failed audit query is a counted failure, not a throw", async () => {
    fx.claim = { data: [], error: { message: "claim exploded" } };
    await expect(runReleaseNoticeSweep()).rejects.toThrow("claim_release_notice failed");
    fx.claim = { data: [], error: null };
    fx.pending = { data: [], error: { message: "boom" } };
    const s = await runReleaseNoticeSweep();
    expect(s.failures).toBe(1);
  });
});

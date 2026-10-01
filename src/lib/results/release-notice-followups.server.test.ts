import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  abandoned: { data: [] as unknown[], error: null as null | { message: string } },
  waiting: { count: 0 as number | null, error: null as null | { message: string } },
  chains: [] as unknown[][][],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "release_notices") throw new Error(`unexpected table ${table}`);
      const calls: unknown[][] = [];
      fx.chains.push(calls);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit"]) {
        b[m] = (...a: unknown[]) => {
          calls.push([m, ...a]);
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        const head = calls.some((c) => c[0] === "select" && (c[2] as { head?: boolean } | undefined)?.head);
        return resolve(head ? fx.waiting : fx.abandoned);
      };
      return b;
    },
  }),
}));

import { STUCK_NOTICE_LIMIT, fetchStuckNotices } from "./release-notice-followups.server";

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `n${i}`,
  visit_id: `v${i}`,
  test_request_ids: ["a", "b"],
  attempts: 6,
  resolved_at: "2026-10-01T09:00:00+00:00",
  last_error: "Resend 500: x",
  visits: { visit_number: `V-${i}`, patients: { first_name: "Ana", middle_name: null, last_name: "Cruz", drm_id: "DRM-1" } },
  ...over,
});

beforeEach(() => {
  fx.abandoned = { data: [], error: null };
  fx.waiting = { count: 0, error: null };
  fx.chains.length = 0;
});

describe("fetchStuckNotices", () => {
  it("lists abandoned notices with the patient's name, visit, test count and the redacted error", async () => {
    fx.abandoned = { data: [row(1)], error: null };
    fx.waiting = { count: 3, error: null };
    const r = await fetchStuckNotices();
    expect(r).toEqual({
      ok: true,
      waitingForRetry: 3,
      capped: false,
      abandoned: [{
        id: "n1", visit_id: "v1", visit_number: "V-1", patient_name: "Cruz, Ana", drm_id: "DRM-1",
        test_count: 2, attempts: 6, gave_up_at: "2026-10-01T09:00:00+00:00", last_error: "Resend 500: x",
      }],
    });
  });

  it("never selects a phone number or an email address", async () => {
    await fetchStuckNotices();
    const select = fx.chains.flat().find((c) => c[0] === "select" && typeof c[1] === "string" && (c[1] as string).includes("visits"))![1] as string;
    expect(select).not.toMatch(/phone|email/i);
  });

  it("only abandoned notices on live visits and active (undeleted, unmerged) patients", async () => {
    await fetchStuckNotices();
    const list = fx.chains[0];
    expect(list).toContainEqual(["eq", "status", "abandoned"]);
    expect(list).toContainEqual(["is", "visits.deleted_at", null]);
    expect(list).toContainEqual(["is", "visits.patients.deleted_at", null]);
    expect(list).toContainEqual(["is", "visits.patients.merged_into_id", null]);
    expect(fx.chains[1]).toContainEqual(["eq", "status", "retry"]);
  });

  it("handles the embed arriving as arrays, and a missing name", async () => {
    fx.abandoned = { data: [row(2, { visits: [{ visit_number: "V-2", patients: [{ first_name: "", middle_name: null, last_name: "", drm_id: "DRM-2" }] }] })], error: null };
    const r = await fetchStuckNotices();
    expect(r.ok && r.abandoned[0]).toMatchObject({ visit_number: "V-2", patient_name: "(no name on file)", drm_id: "DRM-2" });
  });

  it("flags a capped list", async () => {
    fx.abandoned = { data: Array.from({ length: STUCK_NOTICE_LIMIT + 1 }, (_, i) => row(i)), error: null };
    const r = await fetchStuckNotices();
    expect(r.ok && r.capped).toBe(true);
    expect(r.ok && r.abandoned).toHaveLength(STUCK_NOTICE_LIMIT);
  });

  it("answers not-ok when either read fails", async () => {
    fx.abandoned = { data: [], error: { message: "boom" } };
    expect(await fetchStuckNotices()).toEqual({ ok: false });
    fx.abandoned = { data: [], error: null };
    fx.waiting = { count: null, error: { message: "boom" } };
    expect(await fetchStuckNotices()).toEqual({ ok: false });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// 0210/0212: retryReleaseNoticeAction is admin-only on the EFFECTIVE role (an
// admin viewing as reception is refused), validates the id, and only ever calls
// retry_release_notice through the service-role client — nothing about the
// patient or the message comes from the browser.

const fx = vi.hoisted(() => ({
  role: "admin" as string,
  rpcResult: { data: true as unknown, error: null as null | { message: string } },
  rpcs: [] as Array<{ name: string; args: unknown }>,
  audits: [] as Array<Record<string, unknown>>,
  revalidated: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void fx.revalidated.push(p) }));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "staff-1", role: fx.role, actual_role: "admin" }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: unknown) => {
      fx.rpcs.push({ name, args });
      return fx.rpcResult;
    },
  }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/results/copy-followups.server", () => ({ fetchOutdatedCopies: vi.fn() }));
vi.mock("@/lib/notifications/notify-corrected", () => ({ notifyResultCorrected: vi.fn() }));

import { retryReleaseNoticeAction } from "./actions";

const ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  fx.role = "admin";
  fx.rpcResult = { data: true, error: null };
  fx.rpcs.length = 0;
  fx.audits.length = 0;
  fx.revalidated.length = 0;
});

describe("retryReleaseNoticeAction", () => {
  it("an admin queues the retry through retry_release_notice, audits it and refreshes the page", async () => {
    expect(await retryReleaseNoticeAction(ID)).toEqual({ ok: true, data: { queued: true } });
    expect(fx.rpcs).toEqual([{ name: "retry_release_notice", args: { p_id: ID } }]);
    expect(fx.audits).toEqual([
      { actor_id: "staff-1", actor_type: "staff", action: "result.notice_retry_requested", resource_type: "release_notice", resource_id: ID, metadata: { notice_id: ID } },
    ]);
    expect(fx.revalidated).toEqual(["/staff/result-follow-ups"]);
  });

  it.each(["reception", "medtech", "xray_tech", "pathologist", "doctor"])("is refused for %s (effective role) and touches nothing", async (role) => {
    fx.role = role;
    const r = await retryReleaseNoticeAction(ID);
    expect(r).toEqual({ ok: false, error: "Only an admin can retry a result notice." });
    expect(fx.rpcs).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });

  it("rejects an id that is not a uuid before any database call", async () => {
    const r = await retryReleaseNoticeAction("1; drop table release_notices");
    expect(r.ok).toBe(false);
    expect(fx.rpcs).toHaveLength(0);
  });

  it("says so when the notice is no longer waiting (retry_release_notice answers false), with no audit", async () => {
    fx.rpcResult = { data: false, error: null };
    const r = await retryReleaseNoticeAction(ID);
    expect(r).toEqual({ ok: false, error: "That notice isn't waiting for a retry any more — refresh the list." });
    expect(fx.audits).toHaveLength(0);
  });

  it("a database error is a plain refusal, never the raw message", async () => {
    fx.rpcResult = { data: null, error: { message: "permission denied for function retry_release_notice" } };
    const r = await retryReleaseNoticeAction(ID);
    expect(r).toEqual({ ok: false, error: "Couldn't queue the retry — try again in a moment." });
    expect(fx.audits).toHaveLength(0);
  });
});

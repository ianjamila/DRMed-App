import { beforeEach, describe, expect, it, vi } from "vitest";

// 0188: retryPatientNoticeAction may only retry a row that is on the caller's
// own Result Follow-ups list (the signed-in, reception/admin-only RPC), and
// takes the patient, result and test name from that row and the database —
// never from the browser.

const fx = vi.hoisted(() => ({
  role: "reception" as string,
  list: { ok: true, rows: [] as Record<string, unknown>[], capped: false } as unknown,
  groupId: null as string | null,
  groupName: null as string | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "staff-1", role: fx.role }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/results/copy-followups.server", () => ({
  fetchOutdatedCopies: vi.fn(async () => fx.list),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "results"
              ? { data: { report_group_id: fx.groupId }, error: null }
              : { data: fx.groupName ? { name: fx.groupName } : null, error: null },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/notifications/notify-corrected", () => ({ notifyResultCorrected: vi.fn(async () => "sent") }));

import { notifyResultCorrected } from "@/lib/notifications/notify-corrected";
import { retryPatientNoticeAction } from "./actions";

const row = (over: Record<string, unknown> = {}) => ({
  latest_amendment_id: "am-1",
  result_id: "r1",
  patient_id: "pt-1",
  test_names: "FBS",
  contacted_at: null,
  notify_problem: "send_error",
  ...over,
});

beforeEach(() => {
  vi.mocked(notifyResultCorrected).mockClear();
  fx.role = "reception";
  fx.list = { ok: true, rows: [row()], capped: false };
  fx.groupId = null;
  fx.groupName = null;
});

describe("retryPatientNoticeAction", () => {
  it("retries a send-error row from the list with the server's own patient and test name", async () => {
    const out = await retryPatientNoticeAction("am-1");
    expect(out).toEqual({ ok: true, data: { outcome: "sent" } });
    expect(notifyResultCorrected).toHaveBeenCalledWith({
      amendmentId: "am-1",
      resultId: "r1",
      testName: "FBS",
      actorId: "staff-1",
      patientId: "pt-1",
      retry: true,
    });
  });

  it("names a combined report by its report group, as the edit's notice did", async () => {
    fx.list = { ok: true, rows: [row({ test_names: "FBS, BUN" })], capped: false };
    fx.groupId = "g1";
    fx.groupName = "Chemistry";
    await retryPatientNoticeAction("am-1");
    expect(vi.mocked(notifyResultCorrected).mock.calls[0][0].testName).toBe("Chemistry");
  });

  it.each([
    ["not on the list", { rows: [row({ latest_amendment_id: "am-2" })] }],
    ["already contacted", { rows: [row({ contacted_at: "2026-09-28T00:00:00Z" })] }],
    ["a failure a retry can't fix", { rows: [row({ notify_problem: "not_set_up" })] }],
  ])("refuses a row that is %s, and sends nothing", async (_label, list) => {
    fx.list = { ok: true, capped: false, ...list };
    const out = await retryPatientNoticeAction("am-1");
    expect(out.ok).toBe(false);
    expect(notifyResultCorrected).not.toHaveBeenCalled();
  });

  it("refuses other roles before reading anything", async () => {
    fx.role = "medtech";
    const out = await retryPatientNoticeAction("am-1");
    expect(out).toEqual({ ok: false, error: "Only reception or admin can do this." });
    expect(notifyResultCorrected).not.toHaveBeenCalled();
  });
});

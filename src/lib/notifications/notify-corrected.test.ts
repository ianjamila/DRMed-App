import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * notifyResultCorrected documents "never throws" (0179). This pins that every
 * step after the claim — the send, the outcome record, and the audit write —
 * is caught individually, so a throw in any one of them still returns a
 * NotifyOutcome instead of propagating, and the exactly-once claim's outcome
 * is still recorded (best effort) when a later step blows up.
 *
 * `npm test` has no database: the admin client is faked (rpc + a `patients`
 * select), and ./email, ./sms, @/lib/audit/log and the error reporter are
 * mocked so each scenario can be driven precisely.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/results/copy-followups.server", () => ({
  fetchCopyStateAdmin: vi.fn(),
}));

const fx = vi.hoisted(() => ({
  claim: null as null | (() => Promise<{ data: unknown; error: { message: string } | null }>),
  claimCalls: 0,
  patient: null as null | {
    id: string;
    first_name: string | null;
    phone: string | null;
    email: string | null;
    deleted_at: string | null;
    merged_into_id: string | null;
  },
  record: null as null | (() => Promise<{ data: unknown; error: { message: string } | null }>),
  recordCalls: [] as { p_amendment_id: string; p_channels: string[]; p_error: string | null }[],
  audits: [] as Record<string, unknown>[],
  auditImpl: null as null | (() => Promise<void>),
  errors: [] as { scope: string }[],
  releaseCheck: null as null | (() => Promise<{ data: unknown; error: { message: string } | null }>),
}));

const releasedRow = { test_requests: { status: "released" } };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "result_claim_patient_notify") {
        fx.claimCalls += 1;
        return fx.claim!();
      }
      if (fn === "result_record_patient_notify") {
        fx.recordCalls.push(args as { p_amendment_id: string; p_channels: string[]; p_error: string | null });
        return fx.record ? fx.record() : { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (table: string) => {
      if (table === "patients") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: fx.patient, error: null }),
            }),
          }),
        };
      }
      if (table === "result_test_requests") {
        return {
          select: () => ({
            eq: async () =>
              fx.releaseCheck ? fx.releaseCheck() : { data: [releasedRow], error: null },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("./email", () => ({ sendEmail: vi.fn() }));
vi.mock("./sms", () => ({ sendSms: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({
  audit: async (entry: Record<string, unknown>) => {
    if (fx.auditImpl) await fx.auditImpl();
    fx.audits.push(entry);
  },
}));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: vi.fn(async (input: { scope: string }) => {
    fx.errors.push({ scope: input.scope });
  }),
}));

import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { fetchCopyStateAdmin } from "@/lib/results/copy-followups.server";
import { describeSendFailure, notifyResultCorrected, resolveCorrectedNotifyOutcome } from "./notify-corrected";

const okClaim = () =>
  Promise.resolve({
    data: [{ amendment_seq: 2, anchor_test_request_id: "t1", patient_id: "pt1", result_id: "r1" }],
    error: null,
  });

beforeEach(() => {
  vi.clearAllMocks();
  fx.claim = okClaim;
  fx.claimCalls = 0;
  fx.patient = {
    id: "pt1",
    first_name: "Ana",
    phone: "09171234567",
    email: "ana@example.com",
    deleted_at: null,
    merged_into_id: null,
  };
  fx.record = null;
  fx.recordCalls = [];
  fx.audits = [];
  fx.auditImpl = null;
  fx.errors = [];
  fx.releaseCheck = null;
});

const args = { amendmentId: "am-1", resultId: "r1", testName: "Chemistry", actorId: "u1", patientId: "pt1" };

describe("notifyResultCorrected", () => {
  it("claim returns no row: already, nothing sent", async () => {
    fx.claim = () => Promise.resolve({ data: [], error: null });
    const out = await notifyResultCorrected(args);
    expect(out).toBe("already");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(fx.recordCalls).toHaveLength(0);
  });

  it("claim throws: failed, nothing sent, never throws", async () => {
    fx.claim = () => {
      throw new Error("fetch failed");
    };
    const out = await notifyResultCorrected(args);
    expect(out).toBe("failed");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:claim")).toBe(true);
  });

  it("0167: deleted patient — inactive outcome, nothing sent, claim never consumed", async () => {
    fx.patient = {
      id: "pt1",
      first_name: "Ana",
      phone: "09171234567",
      email: "ana@example.com",
      deleted_at: "2026-01-01T00:00:00Z",
      merged_into_id: null,
    };
    const out = await notifyResultCorrected(args);
    expect(out).toBe("inactive");
    expect(fx.claimCalls).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(fx.recordCalls).toHaveLength(0);
    expect(fx.audits.some((a) => a.action === "notification.skipped_inactive_patient")).toBe(true);
  });

  it("0167: merged patient — inactive outcome, nothing sent, claim never consumed", async () => {
    fx.patient = {
      id: "pt1",
      first_name: "Ana",
      phone: "09171234567",
      email: "ana@example.com",
      deleted_at: null,
      merged_into_id: "pt2",
    };
    const out = await notifyResultCorrected(args);
    expect(out).toBe("inactive");
    expect(fx.claimCalls).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("0167: missing patient row — inactive outcome, nothing sent, claim never consumed", async () => {
    fx.patient = null;
    const out = await notifyResultCorrected(args);
    expect(out).toBe("inactive");
    expect(fx.claimCalls).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("send ok: sent, record called with the channel that succeeded", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em-1" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });
    fx.patient = {
      id: "pt1",
      first_name: "Ana",
      phone: null,
      email: "ana@example.com",
      deleted_at: null,
      merged_into_id: null,
    };

    const out = await notifyResultCorrected(args);

    expect(out).toBe("sent");
    expect(fx.recordCalls).toHaveLength(1);
    expect(fx.recordCalls[0]).toMatchObject({ p_amendment_id: "am-1", p_channels: ["email"] });
    expect(fx.audits).toHaveLength(1);
  });

  it("both channels skipped: failed, record called with an error string", async () => {
    fx.patient = {
      id: "pt1",
      first_name: "Ana",
      phone: null,
      email: null,
      deleted_at: null,
      merged_into_id: null,
    };
    const out = await notifyResultCorrected(args);
    expect(out).toBe("failed");
    expect(fx.recordCalls).toHaveLength(1);
    expect(fx.recordCalls[0].p_channels).toEqual([]);
    expect(typeof fx.recordCalls[0].p_error).toBe("string");
    expect(fx.recordCalls[0].p_error).toContain("no contact on file");
  });

  it("contact on file but neither provider configured: not_set_up, reason names the setup, not the patient", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "SEMAPHORE_API_KEY / SEMAPHORE_SENDER_NAME not configured" });
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "skipped", reason: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured" });
    const out = await notifyResultCorrected(args);
    expect(out).toBe("not_set_up");
    expect(fx.recordCalls[0].p_channels).toEqual([]);
    expect(fx.recordCalls[0].p_error).toMatch(/^notices not set up: /);
    expect(fx.recordCalls[0].p_error).toContain("SEMAPHORE_API_KEY");
    expect(fx.recordCalls[0].p_error).toContain("RESEND_API_KEY");
    expect(fx.recordCalls[0].p_error).not.toContain("no contact on file");
  });

  it("phone only and SMS not configured: not_set_up (the old wording blamed a missing contact)", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "NOTIFICATIONS_LIVE not enabled in this environment" });
    fx.patient = { ...fx.patient!, email: null };
    const out = await notifyResultCorrected(args);
    expect(out).toBe("not_set_up");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fx.recordCalls[0].p_error).toBe(
      "notices not set up: NOTIFICATIONS_LIVE not enabled in this environment; patient has no email on file",
    );
  });

  it("a real provider error is still a plain failure, never not_set_up", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "SEMAPHORE_API_KEY / SEMAPHORE_SENDER_NAME not configured" });
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "error", error: "Resend 500" });
    const out = await notifyResultCorrected(args);
    expect(out).toBe("failed");
    expect(fx.recordCalls[0].p_error).toBe("SEMAPHORE_API_KEY / SEMAPHORE_SENDER_NAME not configured; Resend 500");
  });

  it("audit throws after a send: still returns sent and does not throw", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em-1" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });
    fx.patient = {
      id: "pt1",
      first_name: "Ana",
      phone: null,
      email: "ana@example.com",
      deleted_at: null,
      merged_into_id: null,
    };
    fx.auditImpl = () => {
      throw new Error("audit db down");
    };

    const out = await notifyResultCorrected(args);

    expect(out).toBe("sent");
    expect(fx.recordCalls).toHaveLength(1);
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:audit")).toBe(true);
  });

  it("amendmentId null: failed, no RPC called, reportError with a clear message", async () => {
    const out = await notifyResultCorrected({ ...args, amendmentId: null });
    expect(out).toBe("failed");
    expect(fx.recordCalls).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:no-amendment-id")).toBe(true);
  });

  it("a claimed slot whose send throws still records failed (best effort)", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("resend down"));
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });
    fx.patient = {
      id: "pt1",
      first_name: "Ana",
      phone: null,
      email: "ana@example.com",
      deleted_at: null,
      merged_into_id: null,
    };

    const out = await notifyResultCorrected(args);

    expect(out).toBe("failed");
    expect(fx.recordCalls).toHaveLength(1);
    expect(fx.recordCalls[0].p_channels).toEqual([]);
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:send")).toBe(true);
  });

  it("R4: the record RPC returning an error (not throwing) reports and returns sent_unrecorded (X3)", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em-1" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });
    fx.patient = {
      id: "pt1",
      first_name: "Ana",
      phone: null,
      email: "ana@example.com",
      deleted_at: null,
      merged_into_id: null,
    };
    fx.record = () => Promise.resolve({ data: null, error: { message: "record rpc rejected" } });

    const out = await notifyResultCorrected(args);

    expect(out).toBe("sent_unrecorded");
    expect(fx.recordCalls).toHaveLength(1);
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:record")).toBe(true);
    expect(fx.audits).toHaveLength(1);
  });

  it("the record RPC throwing is reported and returns sent_unrecorded (X3)", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em-1" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });
    fx.patient = {
      id: "pt1",
      first_name: "Ana",
      phone: null,
      email: "ana@example.com",
      deleted_at: null,
      merged_into_id: null,
    };
    fx.record = () => {
      throw new Error("record rpc down");
    };

    const out = await notifyResultCorrected(args);

    expect(out).toBe("sent_unrecorded");
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:record")).toBe(true);
    expect(fx.audits).toHaveLength(1);
  });

  // R1: the portal only serves released results. undo-release can walk a
  // downloaded test back to ready_for_release/result_uploaded — a notice
  // sent from there would promise a copy the patient can't open, and (per
  // spec) a successful send would wrongly drop the row off Result follow-ups.
  it("R1: a live test not yet released — not_released, nothing sent, claim never consumed", async () => {
    fx.releaseCheck = () => Promise.resolve({ data: [{ test_requests: { status: "ready_for_release" } }], error: null });
    const out = await notifyResultCorrected(args);
    expect(out).toBe("not_released");
    expect(fx.claimCalls).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(fx.recordCalls).toHaveLength(0);
  });

  it("R1: the release-status read fails — failed, no claim, reportError", async () => {
    fx.releaseCheck = () => Promise.resolve({ data: null, error: { message: "boom" } });
    const out = await notifyResultCorrected(args);
    expect(out).toBe("failed");
    expect(fx.claimCalls).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:release-check")).toBe(true);
  });

  // X1: the portal's rule (isResultDownloadEligible) counts every linked
  // test_request, deleted ones included — a "live members only" check would
  // pass here while the portal still refuses the shared PDF. Reusing
  // fetchLinkedTestRequestStatusesStrict means a deleted, unreleased sibling
  // correctly blocks the notice too.
  it("X1: a deleted, unreleased sibling still blocks the notice — not_released", async () => {
    fx.releaseCheck = () =>
      Promise.resolve({
        data: [releasedRow, { test_requests: { status: "ready_for_release" } }],
        error: null,
      });
    const out = await notifyResultCorrected(args);
    expect(out).toBe("not_released");
    expect(fx.claimCalls).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(fx.recordCalls).toHaveLength(0);
  });
});

// R6: the shared decide-and-send helper the three edit actions now call
// instead of duplicating shouldOfferNotify(await fetchCopyStateAdmin(...)).
const offeredState = {
  result_id: "r1",
  latest_amendment_id: "am-1",
  amendment_count: 2,
  amended_at: "2026-09-25T00:00:00Z",
  holds_copy: true,
  portal_outdated: true,
  printed_outdated: false,
  followed_up: false,
  notified_at: null,
  notify_failed: false,
  has_email: true,
  has_phone: false,
};

describe("describeSendFailure", () => {
  const noPhone = { ok: false as const, kind: "skipped" as const, reason: "patient has no phone on file" };
  const noEmail = { ok: false as const, kind: "skipped" as const, reason: "patient has no email on file" };
  const unconfigured = { ok: false as const, kind: "skipped" as const, reason: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured" };
  it("no contact on file only when both channels lack a contact", () => {
    expect(describeSendFailure(noPhone, noEmail)).toEqual({ error: "no contact on file", notSetUp: false });
  });
  it("a provider skip makes it not set up", () => {
    expect(describeSendFailure(noPhone, unconfigured)).toEqual({
      error: "notices not set up: patient has no phone on file; RESEND_API_KEY / RESEND_FROM_EMAIL not configured",
      notSetUp: true,
    });
  });
  it("an error on either channel keeps it a plain failure", () => {
    expect(describeSendFailure({ ok: false, kind: "error", error: "timeout" }, noEmail)).toEqual({
      error: "timeout; patient has no email on file",
      notSetUp: false,
    });
  });
});

// 0188 turns these stored reasons into result_outdated_copies.notify_problem
// by matching their exact wording, so the writer and the SQL must not drift.
describe("0188 notify_problem mapping matches what describeSendFailure writes", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/0188_result_followups_notify_problem.sql"), "utf8");
  const skipped = (reason: string) => ({ ok: false as const, kind: "skipped" as const, reason });
  it("not set up → the SQL prefix", () => {
    const { error } = describeSendFailure(skipped("NOTIFICATIONS_LIVE not enabled in this environment"), skipped("patient has no email on file"));
    expect(sql).toContain("like 'notices not set up%' then 'not_set_up'");
    expect(error.startsWith("notices not set up")).toBe(true);
  });
  it("no contact → the SQL literal", () => {
    const { error } = describeSendFailure(skipped("patient has no phone on file"), skipped("patient has no email on file"));
    expect(sql).toContain(`= '${error}' then 'no_contact'`);
  });
});

describe("resolveCorrectedNotifyOutcome", () => {
  const helperArgs = {
    resultId: "r1",
    amendmentId: "am-1",
    testName: "Chemistry",
    actorId: "u1",
    patientId: "pt1",
  };

  it("wantsNotify false: undefined, fetchCopyStateAdmin never called", async () => {
    const out = await resolveCorrectedNotifyOutcome({ ...helperArgs, wantsNotify: false });
    expect(out).toBeUndefined();
    expect(fetchCopyStateAdmin).not.toHaveBeenCalled();
    expect(fx.claimCalls).toBe(0);
  });

  it("R6: the copy-state read fails — check_failed, reportError, no claim", async () => {
    vi.mocked(fetchCopyStateAdmin).mockResolvedValue({ ok: false });
    const out = await resolveCorrectedNotifyOutcome({ ...helperArgs, wantsNotify: true });
    expect(out).toBe("check_failed");
    expect(fx.claimCalls).toBe(0);
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:check")).toBe(true);
  });

  it("copy state read ok but offer refuses (no copy on file): not_offered, no claim", async () => {
    vi.mocked(fetchCopyStateAdmin).mockResolvedValue({
      ok: true,
      state: { ...offeredState, holds_copy: false },
    });
    const out = await resolveCorrectedNotifyOutcome({ ...helperArgs, wantsNotify: true });
    expect(out).toBe("not_offered");
    expect(fx.claimCalls).toBe(0);
  });

  it("copy state read ok and offered: delegates to notifyResultCorrected", async () => {
    vi.mocked(fetchCopyStateAdmin).mockResolvedValue({ ok: true, state: offeredState });
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em-1" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });

    const out = await resolveCorrectedNotifyOutcome({ ...helperArgs, wantsNotify: true });

    expect(out).toBe("sent");
    expect(fx.claimCalls).toBe(1);
  });
});

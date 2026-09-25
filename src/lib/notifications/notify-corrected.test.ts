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

const fx = vi.hoisted(() => ({
  claim: null as null | (() => Promise<{ data: unknown; error: { message: string } | null }>),
  patient: null as null | { id: string; first_name: string | null; phone: string | null; email: string | null },
  record: null as null | (() => Promise<{ data: unknown; error: { message: string } | null }>),
  recordCalls: [] as { p_amendment_id: string; p_channels: string[]; p_error: string | null }[],
  audits: [] as Record<string, unknown>[],
  auditImpl: null as null | (() => Promise<void>),
  errors: [] as { scope: string }[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "result_claim_patient_notify") return fx.claim!();
      if (fn === "result_record_patient_notify") {
        fx.recordCalls.push(args as { p_amendment_id: string; p_channels: string[]; p_error: string | null });
        return fx.record ? fx.record() : { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (table: string) => {
      if (table !== "patients") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: fx.patient, error: null }),
          }),
        }),
      };
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
import { notifyResultCorrected } from "./notify-corrected";

const okClaim = () =>
  Promise.resolve({
    data: [{ amendment_seq: 2, anchor_test_request_id: "t1", patient_id: "pt1", result_id: "r1" }],
    error: null,
  });

beforeEach(() => {
  vi.clearAllMocks();
  fx.claim = okClaim;
  fx.patient = { id: "pt1", first_name: "Ana", phone: "09171234567", email: "ana@example.com" };
  fx.record = null;
  fx.recordCalls = [];
  fx.audits = [];
  fx.auditImpl = null;
  fx.errors = [];
});

const args = { amendmentId: "am-1", testName: "Chemistry", actorId: "u1" };

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

  it("send ok: sent, record called with the channel that succeeded", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em-1" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });
    fx.patient = { id: "pt1", first_name: "Ana", phone: null, email: "ana@example.com" };

    const out = await notifyResultCorrected(args);

    expect(out).toBe("sent");
    expect(fx.recordCalls).toHaveLength(1);
    expect(fx.recordCalls[0]).toMatchObject({ p_amendment_id: "am-1", p_channels: ["email"] });
    expect(fx.audits).toHaveLength(1);
  });

  it("both channels skipped: failed, record called with an error string", async () => {
    fx.patient = { id: "pt1", first_name: "Ana", phone: null, email: null };
    const out = await notifyResultCorrected(args);
    expect(out).toBe("failed");
    expect(fx.recordCalls).toHaveLength(1);
    expect(fx.recordCalls[0].p_channels).toEqual([]);
    expect(typeof fx.recordCalls[0].p_error).toBe("string");
    expect(fx.recordCalls[0].p_error).toContain("no contact on file");
  });

  it("audit throws after a send: still returns sent and does not throw", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em-1" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });
    fx.patient = { id: "pt1", first_name: "Ana", phone: null, email: "ana@example.com" };
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
    fx.patient = { id: "pt1", first_name: "Ana", phone: null, email: "ana@example.com" };

    const out = await notifyResultCorrected(args);

    expect(out).toBe("failed");
    expect(fx.recordCalls).toHaveLength(1);
    expect(fx.recordCalls[0].p_channels).toEqual([]);
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:send")).toBe(true);
  });

  it("the record RPC throwing is swallowed and still returns the send outcome", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em-1" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "patient has no phone on file" });
    fx.patient = { id: "pt1", first_name: "Ana", phone: null, email: "ana@example.com" };
    fx.record = () => {
      throw new Error("record rpc down");
    };

    const out = await notifyResultCorrected(args);

    expect(out).toBe("sent");
    expect(fx.errors.some((e) => e.scope === "notify/result-corrected:record")).toBe(true);
    expect(fx.audits).toHaveLength(1);
  });
});

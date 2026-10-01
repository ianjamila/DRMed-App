import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * sendReleaseNotice (0210/0212): every re-check branch, the 24 h dedup, the
 * at-most-once SMS, the email idempotency key, the lease-fenced finish and the
 * terminal audit + stamp. `npm test` has no database: the admin client is a
 * recording fake, the providers / audit / error reporter are mocked.
 */

vi.mock("server-only", () => ({}));

type Call = [string, ...unknown[]];
type Res = { data: unknown; error: { message: string } | null };

const fx = vi.hoisted(() => ({
  tests: [] as unknown[],
  testsError: null as null | { message: string },
  sentNotices: [] as Array<{ test_request_ids: string[] }>,
  sentNoticesError: null as null | { message: string },
  fenceRows: [{ id: "n1" }] as unknown[],
  fenceError: null as null | { message: string },
  finishRows: null as unknown,           // null = echo a row built from the finish args; [] = fenced
  finishError: null as null | { message: string },
  stampResult: true as boolean,
  stampError: null as null | { message: string },
  auditExisting: [] as unknown[],
  auditExistingError: null as null | { message: string },
  visitPatientId: "pt1" as string | null,
  recipient: null as unknown,
  asked: false,
  log: [] as string[],
  calls: [] as Array<{ table: string; calls: Call[] }>,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  audits: [] as Record<string, unknown>[],
  auditOk: true,
  throwOnRender: false,
  currentRow: null as unknown,
  statusRow: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const calls: Call[] = [];
      fx.calls.push({ table, calls });
      const finalize = (): Res => {
        if (table === "test_requests") return { data: fx.tests, error: fx.testsError };
        if (table === "release_notices") {
          if (calls.some((c) => c[0] === "update")) {
            fx.log.push("fence");
            return { data: fx.fenceRows, error: fx.fenceError };
          }
          return { data: fx.sentNotices, error: fx.sentNoticesError };
        }
        if (table === "audit_log") return { data: fx.auditExisting, error: fx.auditExistingError };
        if (table === "visits") return { data: fx.visitPatientId ? { patient_id: fx.visitPatientId } : null, error: null };
        throw new Error(`unexpected table ${table}`);
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "in", "eq", "neq", "is", "gte", "update", "not", "or", "order", "limit"]) {
        b[m] = (...a: unknown[]) => {
          calls.push([m, ...a]);
          return b;
        };
      }
      b.maybeSingle = async () => (table === "release_notices" ? { data: fx.statusRow, error: null } : finalize());
      b.then = (resolve: (v: Res) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(finalize()).then(resolve, reject);
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown>): Promise<Res> => {
      fx.rpcs.push({ name, args });
      if (name === "finish_release_notice") {
        fx.log.push(`finish:${String(args.p_final_status)}`);
        if (fx.finishError) return { data: null, error: fx.finishError };
        if (fx.finishRows !== null) return { data: fx.finishRows, error: null };
        const retry = args.p_final_status === "retry";
        return {
          data: [{
            ...(fx.currentRow as object),
            status: retry ? "retry" : (args.p_final_status as string),
            email_state: (args.p_email_state as string) ?? "todo",
            sms_state: (args.p_sms_state as string) ?? "todo",
            email_provider_id: (args.p_email_provider_id as string) ?? null,
            sms_provider_id: (args.p_sms_provider_id as string) ?? null,
            last_error: (args.p_error as string) ?? null,
            skip_reason: (args.p_skip_reason as string) ?? null,
            resolved_at: retry ? null : "2026-10-01T05:00:00.123456+00:00",
            sent_at: args.p_final_status === "sent" ? "2026-10-01T05:00:00.123456+00:00" : null,
            lease_token: null,
            lease_expires_at: null,
          }],
          error: null,
        };
      }
      if (name === "mark_release_notice_audited") {
        fx.log.push("stamp");
        return { data: fx.stampError ? null : fx.stampResult, error: fx.stampError };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  }),
}));

vi.mock("./email", () => ({ sendEmail: vi.fn() }));
vi.mock("./sms", () => ({ sendSms: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({
  audit: vi.fn(),
  auditChecked: vi.fn(async (entry: Record<string, unknown>) => {
    fx.log.push(`audit:${String(entry.action)}`);
    fx.audits.push(entry);
    return fx.auditOk;
  }),
}));
vi.mock("@/lib/observability/report-error", () => ({ reportError: vi.fn(async () => {}) }));
vi.mock("./active-patient-recipient", () => ({ checkPatientRecipient: vi.fn(async () => fx.recipient) }));
vi.mock("./review-cta", () => ({ patientAlreadyAskedForReview: vi.fn(async () => fx.asked) }));
vi.mock("./release-notice-content", async (orig) => {
  const actual = await orig<typeof import("./release-notice-content")>();
  return {
    ...actual,
    renderSingleNotice: (a: Parameters<typeof actual.renderSingleNotice>[0]) => {
      if (fx.throwOnRender) throw new Error("render exploded");
      return actual.renderSingleNotice(a);
    },
  };
});

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { reportError } from "@/lib/observability/report-error";
import { SAMPLE_SKIP_REASON } from "@/lib/visits/sample";
import { EMAIL_IN_FLIGHT, EMAIL_KEY_CONFLICT, emailIdempotencyKey, loadAuditTests, sendReleaseNotice as realSend } from "./release-notice-sender";
import type { ReleaseNoticeRow } from "./release-notice-types";

// Every send goes through here so the fake finish can echo the claimed row (as the database does).
const sendReleaseNotice = (row: ReleaseNoticeRow) => {
  fx.currentRow = row;
  return realSend(row);
};

const RELEASED_AT = "2026-10-01T04:59:59.123456+00:00";

function baseRow(over: Partial<ReleaseNoticeRow> = {}): ReleaseNoticeRow {
  return {
    id: "n1",
    visit_id: "v1",
    released_at: RELEASED_AT,
    test_request_ids: ["t1"],
    release_medium: "email",
    bulk_batch_id: null,
    status: "sending",
    email_state: "todo",
    sms_state: "todo",
    email_provider_id: null,
    sms_provider_id: null,
    attempts: 1,
    next_attempt_at: "2026-10-01T04:59:59+00:00",
    lease_token: "lease-1",
    lease_expires_at: "2026-10-01T05:03:00+00:00",
    last_error: null,
    skip_reason: null,
    created_at: "2026-10-01T04:59:59+00:00",
    sent_at: null,
    resolved_at: null,
    audited_at: null,
    ...over,
  };
}

const testRow = (id: string, name: string, over: { kind?: string; is_sample?: boolean } = {}) => ({
  id,
  services: { name, kind: over.kind ?? "lab_test" },
  visits: { id: "v1", is_sample: over.is_sample ?? false, patient_id: "pt1" },
});

const patient: { id: string; drm_id: string; first_name: string; phone: string | null; email: string | null } = { id: "pt1", drm_id: "DRM-0001", first_name: "Ana", phone: "09171234567", email: "ana@example.com" };
const active = (over: Partial<typeof patient> = {}) => ({ kind: "active", patient: { ...patient, ...over } });

const finishArgs = () => fx.rpcs.find((r) => r.name === "finish_release_notice")?.args;
const audits = (action?: string) => fx.audits.filter((a) => !action || a.action === action);
const stamped = () => fx.rpcs.some((r) => r.name === "mark_release_notice_audited");

beforeEach(() => {
  vi.clearAllMocks();
  fx.tests = [testRow("t1", "CBC")];
  fx.testsError = null;
  fx.sentNotices = [];
  fx.sentNoticesError = null;
  fx.fenceRows = [{ id: "n1" }];
  fx.fenceError = null;
  fx.finishRows = null;
  fx.finishError = null;
  fx.stampResult = true;
  fx.stampError = null;
  fx.auditExisting = [];
  fx.auditExistingError = null;
  fx.visitPatientId = "pt1";
  fx.recipient = active();
  fx.asked = false;
  fx.log = [];
  fx.calls = [];
  fx.rpcs = [];
  fx.audits = [];
  fx.auditOk = true;
  fx.throwOnRender = false;
  fx.statusRow = null;
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em1" });
  vi.mocked(sendSms).mockResolvedValue({ ok: true, id: 77 });
});

describe("re-check at send time", () => {
  it("reads only the tests still released with this EXACT released_at, on a live, undeleted visit", async () => {
    await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2"] }));
    const chain = fx.calls.find((c) => c.table === "test_requests")!.calls;
    expect(chain).toContainEqual(["in", "id", ["t1", "t2"]]);
    expect(chain).toContainEqual(["eq", "visit_id", "v1"]);
    expect(chain).toContainEqual(["eq", "status", "released"]);
    // The stamp is passed as the database's own string, microseconds intact.
    expect(chain).toContainEqual(["eq", "released_at", RELEASED_AT]);
    expect(chain).toContainEqual(["is", "deleted_at", null]);
    expect(chain).toContainEqual(["is", "visits.deleted_at", null]);
    expect(chain.some((c) => c[0] === "eq" && c[1] === "released_at" && typeof c[2] !== "string")).toBe(false);
  });

  it("cancels when no test is still released (undone or deleted) and audits result.notice_cancelled with the batch id", async () => {
    fx.tests = [];
    const r = await sendReleaseNotice(baseRow({ bulk_batch_id: "batch-1" }));
    expect(finishArgs()).toMatchObject({ p_final_status: "cancelled" });
    expect(r.finalStatus).toBe("cancelled");
    expect(r.outcome).toEqual({ status: "skipped", channels: [], reason: "released tests were undone or deleted" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(audits("result.notice_cancelled")).toHaveLength(1);
    expect(audits("result.notice_cancelled")[0]).toMatchObject({
      resource_type: "test_request",
      resource_id: "t1",
      metadata: { notice_id: "n1", visit_id: "v1", bulk_batch_id: "batch-1" },
    });
    expect(stamped()).toBe(true);
  });

  it("drops an undone test and announces only the survivor (single template by SURVIVING count)", async () => {
    fx.tests = [testRow("t2", "FBS")];
    await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2", "t3"] }));
    expect(vi.mocked(sendEmail).mock.calls[0][0].subject).toBe("Your DRMed lab result is ready (FBS)");
  });

  it("uses the consolidated template when several tests survive, in the release's order", async () => {
    fx.tests = [testRow("t2", "FBS"), testRow("t1", "CBC")];
    await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2"] }));
    const sent = vi.mocked(sendEmail).mock.calls[0][0];
    expect(sent.subject).toBe("2 lab results ready — DRMed");
    expect(sent.text.indexOf("CBC")).toBeLessThan(sent.text.indexOf("FBS"));
  });

  it("a failed read of the tests retries — it never cancels on a read error", async () => {
    fx.testsError = { message: "boom" };
    const r = await sendReleaseNotice(baseRow());
    expect(finishArgs()).toMatchObject({ p_final_status: "retry" });
    expect(r.outcome.status).toBe("retrying");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a doctor-only notice: nothing to announce, no providers, no audit row (but it is stamped)", async () => {
    fx.tests = [testRow("t1", "Consult", { kind: "doctor_consultation" })];
    const r = await sendReleaseNotice(baseRow());
    expect(finishArgs()).toMatchObject({ p_final_status: "skipped", p_skip_reason: "consultation — nothing to announce" });
    expect(r.outcome).toEqual({ status: "skipped", channels: [], reason: "consultation — nothing to announce" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fx.audits).toHaveLength(0);
    expect(stamped()).toBe(true);
  });

  it("a doctor line beside a lab test is dropped, the lab test is announced", async () => {
    fx.tests = [testRow("t1", "Consult", { kind: "doctor_consultation" }), testRow("t2", "CBC")];
    await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2"] }));
    expect(vi.mocked(sendEmail).mock.calls[0][0].subject).toBe("Your DRMed lab result is ready (CBC)");
  });

  it("skips a sample visit on both channels and writes today's result.notified skip row", async () => {
    fx.tests = [testRow("t1", "CBC", { is_sample: true })];
    const r = await sendReleaseNotice(baseRow({ bulk_batch_id: "b9" }));
    expect(r.outcome).toEqual({ status: "skipped", channels: [], reason: SAMPLE_SKIP_REASON });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(finishArgs()).toMatchObject({ p_email_state: "skipped", p_sms_state: "skipped" });
    const [a] = audits("result.notified");
    expect(a.metadata).toMatchObject({
      visit_id: "v1",
      test_name: "CBC",
      release_medium: "email",
      sms: { ok: false, skipped: true, reason: SAMPLE_SKIP_REASON },
      email: { ok: false, skipped: true, reason: SAMPLE_SKIP_REASON },
      review_cta: { shown: false },
      bulk_batch_id: "b9",
    });
  });

  it.each(["physical", "pickup"])("skips a %s hand-off and sends nothing", async (medium) => {
    const r = await sendReleaseNotice(baseRow({ release_medium: medium }));
    expect(r.outcome).toEqual({ status: "skipped", channels: [], reason: "physical hand-off — no message sent" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(audits("result.notified")[0].metadata).toMatchObject({ release_medium: medium });
  });

  it("skips an inactive patient with the same skip audit as today (and the batch id), no providers", async () => {
    fx.recipient = { kind: "inactive", patientId: "pt1", reason: "merged" };
    const r = await sendReleaseNotice(baseRow({ bulk_batch_id: "b1" }));
    expect(r.outcome).toEqual({ status: "skipped", channels: [], reason: "patient is not active" });
    expect(finishArgs()).toMatchObject({ p_final_status: "skipped", p_skip_reason: "patient is not active (merged)" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audits("result.notified")).toHaveLength(0);
    expect(audits("notification.skipped_inactive_patient")[0]).toMatchObject({
      patient_id: "pt1",
      resource_type: "test_request",
      resource_id: "t1",
      metadata: { sender: "notify-released", reason: "merged", patient_id: "pt1", bulk_batch_id: "b1", notice_id: "n1" },
    });
  });

  it("an inactive patient on a several-test notice audits against the visit, as the bulk sender does", async () => {
    fx.tests = [testRow("t1", "CBC"), testRow("t2", "FBS")];
    fx.recipient = { kind: "inactive", patientId: "pt1", reason: "deleted" };
    await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2"] }));
    expect(audits("notification.skipped_inactive_patient")[0]).toMatchObject({
      resource_type: "visit",
      resource_id: "v1",
      metadata: { sender: "notify-released-bulk", reason: "deleted" },
    });
  });

  it("skips a walk-in patient with no contact details", async () => {
    fx.recipient = { kind: "walk_in" };
    const r = await sendReleaseNotice(baseRow());
    expect(r.outcome).toEqual({ status: "skipped", channels: [], reason: "walk-in patient — no contact details" });
    expect(audits("notification.skipped_inactive_patient")[0].metadata).toMatchObject({ reason: "walk_in" });
  });

  it("a patient lookup outage retries instead of dropping the notice", async () => {
    fx.recipient = { kind: "inactive", patientId: "pt1", reason: "lookup_failed" };
    const r = await sendReleaseNotice(baseRow());
    expect(finishArgs()).toMatchObject({ p_final_status: "retry" });
    expect(r.outcome.status).toBe("retrying");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(vi.mocked(reportError).mock.calls.map((c) => c[0].scope)).toContain("notifications.recipient_lookup");
  });

  it("a patient with neither phone nor email finishes skipped with 'no email or phone on file'", async () => {
    fx.recipient = active({ phone: null, email: null });
    const r = await sendReleaseNotice(baseRow());
    expect(r.outcome).toEqual({ status: "skipped", channels: [], reason: "no email or phone on file" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(finishArgs()).toMatchObject({ p_final_status: "skipped", p_email_state: "skipped", p_sms_state: "skipped" });
    expect(audits("result.notified")[0].metadata).toMatchObject({
      sms: { ok: false, skipped: true, reason: "patient has no phone on file" },
      email: { ok: false, skipped: true, reason: "patient has no email on file" },
    });
  });
});

describe("dedup — owner decision 1", () => {
  it("suppresses a notice whose tests were all announced in a sent notice in the last 24 h", async () => {
    fx.sentNotices = [{ test_request_ids: ["t1", "t9"] }];
    const r = await sendReleaseNotice(baseRow({ bulk_batch_id: "b2" }));
    expect(r.finalStatus).toBe("suppressed");
    expect(r.outcome.status).toBe("skipped");
    expect(finishArgs()).toMatchObject({ p_final_status: "suppressed" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(audits("result.notice_suppressed")[0]).toMatchObject({ metadata: { notice_id: "n1", bulk_batch_id: "b2" } });
    const q = fx.calls.find((c) => c.table === "release_notices")!.calls;
    expect(q).toContainEqual(["eq", "status", "sent"]);
    expect(q).toContainEqual(["neq", "id", "n1"]);
    const since = q.find((c) => c[0] === "gte" && c[1] === "sent_at")![2] as string;
    expect(Date.now() - Date.parse(since)).toBeGreaterThan(24 * 3600 * 1000 - 5000);
    expect(Date.now() - Date.parse(since)).toBeLessThan(24 * 3600 * 1000 + 5000);
  });

  it("counts tests announced across two earlier sent notices", async () => {
    fx.tests = [testRow("t1", "CBC"), testRow("t2", "FBS")];
    fx.sentNotices = [{ test_request_ids: ["t1"] }, { test_request_ids: ["t2"] }];
    const r = await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2"] }));
    expect(r.finalStatus).toBe("suppressed");
  });

  it("sends when only SOME tests were announced before", async () => {
    fx.tests = [testRow("t1", "CBC"), testRow("t2", "FBS")];
    fx.sentNotices = [{ test_request_ids: ["t1"] }];
    const r = await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2"] }));
    expect(r.finalStatus).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("an earlier notice that never sent (nothing in the sent list) does not suppress", async () => {
    fx.sentNotices = [];
    expect((await sendReleaseNotice(baseRow())).finalStatus).toBe("sent");
  });

  it("a failed dedup read retries rather than sending blind", async () => {
    fx.sentNoticesError = { message: "boom" };
    const r = await sendReleaseNotice(baseRow());
    expect(finishArgs()).toMatchObject({ p_final_status: "retry" });
    expect(r.outcome.status).toBe("retrying");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("sends the email with Idempotency-Key result-notice:<id>:email:<hash of the FULL payload>", async () => {
    await sendReleaseNotice(baseRow({ id: "n-42" }));
    const sent = vi.mocked(sendEmail).mock.calls[0][0];
    expect(sent.idempotencyKey).toMatch(/^result-notice:n-42:email:[0-9a-f]{12}$/);
    expect(sent.idempotencyKey).toBe(emailIdempotencyKey("n-42", { to: "ana@example.com", subject: sent.subject, text: sent.text, html: sent.html! }));
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ana@example.com" }));
  });

  it("the key covers to, subject, text AND html", () => {
    const base = { to: "a@x.test", subject: "s", text: "t", html: "h" };
    const k = emailIdempotencyKey("n1", base);
    for (const changed of [{ to: "b@x.test" }, { subject: "s2" }, { text: "t2" }, { html: "h2" }]) {
      expect(emailIdempotencyKey("n1", { ...base, ...changed })).not.toBe(k);
    }
    expect(emailIdempotencyKey("n1", { ...base })).toBe(k);
  });

  it("identical content across attempts reuses the key; changed content (a test undone, CTA toggled) gets a new one", async () => {
    await sendReleaseNotice(baseRow({ attempts: 1 }));
    await sendReleaseNotice(baseRow({ attempts: 2 }));
    fx.asked = true; // the review CTA drops out of the text
    await sendReleaseNotice(baseRow({ attempts: 3 }));
    fx.asked = false;
    fx.tests = [testRow("t1", "CBC"), testRow("t2", "FBS")];
    await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2"], attempts: 4 }));
    const keys = vi.mocked(sendEmail).mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });

  it("a Resend 409 invalid_idempotent_request is a definite 'not sent': retried (no salt, the key already hashes the full payload)", async () => {
    fx.recipient = active({ phone: null });
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: false, kind: "error", error: 'Resend 409: {"name":"invalid_idempotent_request"}' });
    const r = await sendReleaseNotice(baseRow({ attempts: 1 }));
    expect(r.finalStatus).toBe("retry");
    expect(finishArgs()).toMatchObject({ p_email_state: "failed", p_error: EMAIL_KEY_CONFLICT });
    await sendReleaseNotice(baseRow({ attempts: 2, last_error: EMAIL_KEY_CONFLICT }));
    const keys = vi.mocked(sendEmail).mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]); // identical payload => identical key, never flipped by last_error
  });

  it("a Resend 409 concurrent_idempotent_requests retries with the SAME key (the first send may still deliver)", async () => {
    fx.recipient = active({ phone: null });
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: false, kind: "error", error: 'Resend 409: {"name":"concurrent_idempotent_requests"}' });
    await sendReleaseNotice(baseRow({ attempts: 1 }));
    expect(finishArgs()).toMatchObject({ p_final_status: "retry", p_error: EMAIL_IN_FLIGHT });
    await sendReleaseNotice(baseRow({ attempts: 2, last_error: EMAIL_IN_FLIGHT }));
    const keys = vi.mocked(sendEmail).mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("fences sms_state='unknown' on the lease BEFORE the text leaves, and finishes sent with both channels", async () => {
    const r = await sendReleaseNotice(baseRow());
    const fence = fx.calls.find((c) => c.table === "release_notices" && c.calls.some((x) => x[0] === "update"))!.calls;
    expect(fence).toContainEqual(["update", { sms_state: "unknown" }]);
    expect(fence).toContainEqual(["eq", "id", "n1"]);
    expect(fence).toContainEqual(["eq", "lease_token", "lease-1"]);
    expect(fence).toContainEqual(["eq", "status", "sending"]);
    // the fence happened before the SMS provider was called
    expect(fx.log.indexOf("fence")).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(sendSms).mock.invocationCallOrder[0]).toBeGreaterThan(0);
    expect(r.outcome).toEqual({ status: "sent", channels: ["email", "sms"], reason: null });
    expect(finishArgs()).toMatchObject({
      p_final_status: "sent", p_email_state: "sent", p_sms_state: "sent", p_email_provider_id: "em1", p_sms_provider_id: "77",
    });
  });

  it("never sends an SMS from sms_state 'unknown' (an earlier attempt's text may have left); the email still goes", async () => {
    const r = await sendReleaseNotice(baseRow({ sms_state: "unknown" }));
    expect(sendSms).not.toHaveBeenCalled();
    expect(fx.calls.some((c) => c.calls.some((x) => x[0] === "update"))).toBe(false); // no fence either
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(r.outcome).toEqual({ status: "sent", channels: ["email"], reason: null });
    expect(finishArgs()).toMatchObject({ p_sms_state: "unknown", p_email_state: "sent" });
  });

  it("never sends an SMS from sms_state 'failed' either", async () => {
    await sendReleaseNotice(baseRow({ sms_state: "failed" }));
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("never re-sends a channel already 'sent'", async () => {
    const r = await sendReleaseNotice(baseRow({ sms_state: "sent", sms_provider_id: "55", email_state: "sent", email_provider_id: "em0" }));
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.outcome).toEqual({ status: "sent", channels: ["email", "sms"], reason: null });
    expect(finishArgs()).toMatchObject({ p_final_status: "sent", p_email_state: "sent", p_sms_state: "sent" });
  });

  it("a row whose email already went out sends only the missing SMS", async () => {
    await sendReleaseNotice(baseRow({ email_state: "sent", email_provider_id: "em0" }));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("losing the lease at the SMS fence (no row updated) sends NOTHING and writes nothing", async () => {
    fx.fenceRows = [];
    const r = await sendReleaseNotice(baseRow());
    expect(r.finalStatus).toBe("fenced");
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(finishArgs()).toBeUndefined();
    expect(fx.audits).toHaveLength(0);
    expect(stamped()).toBe(false);
  });

  it("a fence write that errors keeps the text back but still sends the email", async () => {
    fx.fenceError = { message: "db down" };
    const r = await sendReleaseNotice(baseRow());
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(r.finalStatus).toBe("sent");
  });

  it("an SMS error leaves the state 'unknown' (never 'failed', never retried); the email carries the notice", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "error", error: "Semaphore 500: x" });
    const r = await sendReleaseNotice(baseRow());
    expect(r.outcome).toEqual({ status: "sent", channels: ["email"], reason: null });
    expect(finishArgs()).toMatchObject({ p_sms_state: "unknown", p_email_state: "sent" });
    expect(vi.mocked(reportError).mock.calls.map((c) => c[0].scope)).toContain("notify/result-released:sms");
  });

  it("an email error with nothing delivered retries, reports, and writes no terminal audit", async () => {
    fx.recipient = active({ phone: null });
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "error", error: "Resend 429: slow down" });
    const r = await sendReleaseNotice(baseRow());
    expect(r.finalStatus).toBe("retry");
    expect(r.outcome).toEqual({ status: "retrying", channels: [], reason: "will retry automatically" });
    expect(finishArgs()).toMatchObject({ p_final_status: "retry", p_email_state: "failed", p_error: "Resend 429: slow down" });
    expect(fx.audits).toHaveLength(0);
    expect(stamped()).toBe(false);
    expect(vi.mocked(reportError).mock.calls.map((c) => c[0].scope)).toContain("notify/result-released:email");
  });

  it("an email error but a delivered SMS is sent (any channel delivered), with the email error in the audit", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "error", error: "Resend 500: x" });
    const r = await sendReleaseNotice(baseRow());
    expect(r.outcome).toEqual({ status: "sent", channels: ["sms"], reason: null });
    expect(audits("result.notified")[0].metadata).toMatchObject({
      sms: { ok: true, id: 77 },
      email: { ok: false, error: "Resend 500: x", to: "ana@example.com" },
      review_cta: { shown: false },
    });
  });

  it("both channels not configured here finishes skipped (never retried) with each channel's reason", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "skipped", reason: "NOTIFICATIONS_LIVE not enabled in this environment" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "NOTIFICATIONS_LIVE not enabled in this environment" });
    const r = await sendReleaseNotice(baseRow());
    expect(r.finalStatus).toBe("skipped");
    expect(r.outcome).toEqual({ status: "skipped", channels: [], reason: "no email or phone on file" });
    expect(finishArgs()).toMatchObject({ p_skip_reason: "NOTIFICATIONS_LIVE not enabled in this environment" });
  });
});

describe("fenced copy", () => {
  it("a lost lease on a notice another worker already SENT reads as notified", async () => {
    fx.finishRows = [];
    fx.statusRow = { status: "sent", email_state: "sent", sms_state: "skipped" };
    const r = await sendReleaseNotice(baseRow());
    expect(r.finalStatus).toBe("fenced");
    expect(r.outcome).toEqual({ status: "sent", channels: ["email"], reason: null });
  });

  it.each(["sending", "retry", "pending", "abandoned"])("a lost lease on a %s notice stays 'retrying'", async (status) => {
    fx.finishRows = [];
    fx.statusRow = { status, email_state: "todo", sms_state: "todo" };
    expect((await sendReleaseNotice(baseRow())).outcome.status).toBe("retrying");
  });

  it("a status read that fails also stays 'retrying'", async () => {
    fx.finishRows = [];
    fx.statusRow = null;
    expect((await sendReleaseNotice(baseRow())).outcome.status).toBe("retrying");
  });
});

describe("loadAuditTests (re-audit names)", () => {
  it("returns the lab-only ids and names without the released/status filters (an undone test is still one the notice announced)", async () => {
    fx.tests = [testRow("t1", "CBC"), testRow("t2", "Consult", { kind: "doctor_consultation" })];
    const out = await loadAuditTests(createAdminClient(), baseRow({ test_request_ids: ["t1", "t2"] }));
    expect(out).toEqual({ testIds: ["t1"], testNames: ["CBC"] });
    const chain = fx.calls.find((c) => c.table === "test_requests")!.calls;
    expect(chain.some((c) => c[0] === "eq" && (c[1] === "status" || c[1] === "released_at"))).toBe(false);
    expect(chain).toContainEqual(["is", "deleted_at", null]);
    expect(chain).toContainEqual(["is", "visits.deleted_at", null]);
  });
});

describe("finish and the terminal audit", () => {
  it("a stale lease (finish returns no row) writes no audit and does not stamp", async () => {
    fx.finishRows = [];
    const r = await sendReleaseNotice(baseRow());
    expect(r.finalStatus).toBe("fenced");
    expect(r.outcome.status).toBe("retrying");
    expect(fx.audits).toHaveLength(0);
    expect(stamped()).toBe(false);
  });

  it("finish failing leaves the row for the sweeper: retrying outcome, no audit", async () => {
    fx.finishError = { message: "db down" };
    const r = await sendReleaseNotice(baseRow());
    expect(r.finalStatus).toBe("error");
    expect(r.outcome.status).toBe("retrying");
    expect(fx.audits).toHaveLength(0);
  });

  it("writes result.notified in today's exact shape (single), THEN stamps — in that order", async () => {
    const r = await sendReleaseNotice(baseRow({ bulk_batch_id: "batch-7" }));
    expect(r.outcome.status).toBe("sent");
    const [a] = audits("result.notified");
    expect(a).toMatchObject({ actor_id: null, actor_type: "system", patient_id: "pt1", resource_type: "test_request", resource_id: "t1" });
    expect(a.metadata).toEqual({
      visit_id: "v1",
      test_name: "CBC",
      sms: { ok: true, id: 77 },
      email: { ok: true, id: "em1", to: "ana@example.com" },
      review_cta: { shown: true },
      notice_id: "n1",
      bulk_batch_id: "batch-7",
    });
    expect(fx.log.indexOf("audit:result.notified")).toBeGreaterThan(fx.log.indexOf("finish:sent"));
    expect(fx.log.indexOf("stamp")).toBeGreaterThan(fx.log.indexOf("audit:result.notified"));
  });

  it("the consolidated shape for several tests keeps bulk, count, test_names and test_request_ids", async () => {
    fx.tests = [testRow("t1", "CBC"), testRow("t2", "FBS")];
    await sendReleaseNotice(baseRow({ test_request_ids: ["t1", "t2"], bulk_batch_id: "b" }));
    expect(audits("result.notified")[0]).toMatchObject({ resource_id: "t1" });
    expect(audits("result.notified")[0].metadata).toMatchObject({
      bulk: true, count: 2, test_names: ["CBC", "FBS"], test_request_ids: ["t1", "t2"], bulk_batch_id: "b",
    });
  });

  it("omits bulk_batch_id when the notice has none", async () => {
    await sendReleaseNotice(baseRow());
    expect(audits("result.notified")[0].metadata).not.toHaveProperty("bulk_batch_id");
  });

  it("review_cta.shown is true only when the email actually went out", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "error", error: "x" });
    await sendReleaseNotice(baseRow());   // sms delivers, email fails -> sent
    expect(audits("result.notified")[0].metadata).toMatchObject({ review_cta: { shown: false } });
  });

  it("review_cta.shown is false when the patient was already asked", async () => {
    fx.asked = true;
    await sendReleaseNotice(baseRow());
    expect(audits("result.notified")[0].metadata).toMatchObject({ review_cta: { shown: false } });
    expect(vi.mocked(sendEmail).mock.calls[0][0].text).not.toContain("Google review");
  });

  it("a stamp that answers false (another worker audited first) is a no-op: one audit, no throw", async () => {
    fx.stampResult = false;
    const r = await sendReleaseNotice(baseRow());
    expect(r.outcome.status).toBe("sent");
    expect(audits("result.notified")).toHaveLength(1);
  });

  it("an audit write that fails is NOT stamped, so the sweeper audits it later", async () => {
    fx.auditOk = false;
    const r = await sendReleaseNotice(baseRow());
    expect(r.outcome.status).toBe("sent");
    expect(stamped()).toBe(false);
  });

  it("a finish that abandons the row audits result.notice_abandoned", async () => {
    fx.finishRows = [{
      ...baseRow({ status: "abandoned", attempts: 6, last_error: "Resend 500", resolved_at: "2026-10-01T09:00:00+00:00", lease_token: null, lease_expires_at: null, bulk_batch_id: "bb" }),
    }];
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "error", error: "Resend 500" });
    fx.recipient = active({ phone: null });
    const r = await sendReleaseNotice(baseRow({ attempts: 6 }));
    expect(r.outcome).toEqual({ status: "failed", channels: [], reason: "sending failed" });
    expect(audits("result.notice_abandoned")[0]).toMatchObject({
      resource_id: "t1",
      metadata: { notice_id: "n1", attempts: 6, last_error: "Resend 500", bulk_batch_id: "bb" },
    });
    expect(stamped()).toBe(true);
  });
});

describe("never throws", () => {
  it("an unexpected failure is reported, the row is handed back for a retry, and the caller gets 'retrying'", async () => {
    fx.throwOnRender = true;
    const r = await sendReleaseNotice(baseRow());
    expect(r.finalStatus).toBe("error");
    expect(r.outcome.status).toBe("retrying");
    expect(finishArgs()).toMatchObject({ p_final_status: "retry" });
    expect(vi.mocked(reportError).mock.calls.map((c) => c[0].scope)).toContain("notify/release-notice:unexpected");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a row that is not leased does nothing", async () => {
    const r = await sendReleaseNotice(baseRow({ status: "pending", lease_token: null }));
    expect(r.finalStatus).toBe("fenced");
    expect(fx.rpcs).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * notifyResultReleased returns a ReleaseNoticeOutcome (sent / skipped / failed
 * + reason) since #280. One test per branch that skips, sends or fails, each
 * pinning the exact outcome plus the side effect that matters (no provider
 * call on a skip, the audit row / reportError where the code writes one).
 *
 * `npm test` has no database: the admin client is a table-keyed fake and
 * ./email, ./sms, @/lib/audit/log and the error reporter are mocked — the same
 * style as notify-corrected.test.ts.
 */

vi.mock("server-only", () => ({}));

type Res = { data: unknown; error: { message: string } | null };

const fx = vi.hoisted(() => ({
  testRow: null as unknown,
  patientRow: null as unknown,
  patientError: null as null | { message: string },
  askedForReview: false,
  audits: [] as Record<string, unknown>[],
  recipientOverride: null as unknown,
  isCalls: [] as Array<[string, string, unknown]>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const m of ["select", "eq"]) chain[m] = self;
      chain.is = (col: string, val: unknown) => {
        fx.isCalls.push([table, col, val]);
        return chain;
      };
      if (table === "test_requests") {
        chain.maybeSingle = async (): Promise<Res> => ({ data: fx.testRow, error: null });
      } else if (table === "patients") {
        chain.maybeSingle = async (): Promise<Res> => ({ data: fx.patientRow, error: fx.patientError });
      } else if (table === "audit_log") {
        chain.limit = async (): Promise<Res> => ({
          data: fx.askedForReview ? [{ id: "a1" }] : [],
          error: null,
        });
      } else {
        throw new Error(`unexpected table ${table}`);
      }
      return chain;
    },
  }),
}));

vi.mock("./email", () => ({ sendEmail: vi.fn() }));
vi.mock("./sms", () => ({ sendSms: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    fx.audits.push(entry);
  }),
}));
vi.mock("@/lib/observability/report-error", () => ({ reportError: vi.fn(async () => {}) }));
// Real recipient check by default; the walk-in test overrides the decision
// (the real function can only return walk_in for a null patient id, which this
// caller never passes — see the walk-in test).
vi.mock("./active-patient-recipient", async (orig) => {
  const actual = await orig<typeof import("./active-patient-recipient")>();
  return {
    ...actual,
    checkPatientRecipient: vi.fn((db: never, id: string | null) =>
      fx.recipientOverride ? Promise.resolve(fx.recipientOverride) : actual.checkPatientRecipient(db, id),
    ),
  };
});

import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { reportError } from "@/lib/observability/report-error";
import { SAMPLE_SKIP_REASON } from "@/lib/visits/sample";
import { notifyResultReleased } from "./notify-released";

const patientRow = {
  id: "pt1",
  drm_id: "DRM-0001",
  first_name: "Ana",
  phone: "09171234567",
  email: "ana@example.com",
  deleted_at: null,
  merged_into_id: null,
};

function testRow(over: { kind?: string; is_sample?: boolean; visits?: unknown; services?: unknown; patients?: unknown } = {}) {
  return {
    id: "tr1",
    visit_id: "v1",
    services: over.services ?? { name: "CBC", kind: over.kind ?? "lab_test" },
    visits:
      over.visits ??
      {
        id: "v1",
        is_sample: over.is_sample ?? false,
        patients: over.patients ?? { id: "pt1", drm_id: "DRM-0001", first_name: "Ana", phone: patientRow.phone, email: patientRow.email },
      },
  };
}

const base = { testRequestId: "tr1", visitId: "v1", releaseMedium: "portal" };
const noteAudits = () => fx.audits.filter((a) => a.action === "result.notified");
const skipAudits = () => fx.audits.filter((a) => a.action === "notification.skipped_inactive_patient");

beforeEach(() => {
  vi.clearAllMocks();
  fx.testRow = testRow();
  fx.patientRow = { ...patientRow };
  fx.patientError = null;
  fx.askedForReview = false;
  fx.audits = [];
  fx.recipientOverride = null;
  fx.isCalls = [];
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em1" });
  vi.mocked(sendSms).mockResolvedValue({ ok: true, id: "sm1" });
});

function expectNothingSent() {
  expect(sendEmail).not.toHaveBeenCalled();
  expect(sendSms).not.toHaveBeenCalled();
}

describe("notifyResultReleased — skips", () => {
  it("only looks up live rows: filters out a deleted line and a deleted visit", async () => {
    await notifyResultReleased(base);
    const tr = fx.isCalls.filter(([t]) => t === "test_requests");
    expect(tr).toContainEqual(["test_requests", "deleted_at", null]);
    expect(tr).toContainEqual(["test_requests", "visits.deleted_at", null]);
  });

  it("skips when the test request is not found", async () => {
    fx.testRow = null;
    expect(await notifyResultReleased(base)).toEqual({ status: "skipped", channels: [], reason: "test not found" });
    expectNothingSent();
    expect(fx.audits).toHaveLength(0);
  });

  it("skips when the joined visit is missing", async () => {
    fx.testRow = testRow({ visits: [] });
    expect(await notifyResultReleased(base)).toEqual({ status: "skipped", channels: [], reason: "visit not found" });
    expectNothingSent();
  });

  it("skips when the patient is missing from the visit", async () => {
    fx.testRow = testRow({ patients: [] });
    expect(await notifyResultReleased(base)).toEqual({ status: "skipped", channels: [], reason: "patient or test not found" });
    expectNothingSent();
  });

  it("skips when the service is missing", async () => {
    fx.testRow = testRow({ services: [] });
    expect(await notifyResultReleased(base)).toEqual({ status: "skipped", channels: [], reason: "patient or test not found" });
    expectNothingSent();
  });

  it.each(["doctor_consultation", "doctor_procedure"])("skips a doctor line (%s) without auditing or sending", async (kind) => {
    fx.testRow = testRow({ kind });
    expect(await notifyResultReleased(base)).toEqual({
      status: "skipped",
      channels: [],
      reason: "consultation — nothing to announce",
    });
    expectNothingSent();
    expect(fx.audits).toHaveLength(0);
  });

  it("skips a sample visit and records a skipped result.notified row on both channels", async () => {
    fx.testRow = testRow({ is_sample: true });
    expect(await notifyResultReleased({ ...base, bulkBatchId: "b1" })).toEqual({
      status: "skipped",
      channels: [],
      reason: SAMPLE_SKIP_REASON,
    });
    expectNothingSent();
    const skipped = { ok: false, skipped: true, reason: SAMPLE_SKIP_REASON };
    expect(noteAudits()).toHaveLength(1);
    expect(noteAudits()[0]).toMatchObject({
      patient_id: "pt1",
      resource_id: "tr1",
      metadata: { sms: skipped, email: skipped, review_cta: { shown: false }, bulk_batch_id: "b1" },
    });
  });

  it("a sample visit wins over a physical hand-off (sample reason is reported)", async () => {
    fx.testRow = testRow({ is_sample: true });
    const out = await notifyResultReleased({ ...base, releaseMedium: "physical" });
    expect(out.reason).toBe(SAMPLE_SKIP_REASON);
  });

  it.each(["physical", "pickup"])("skips a %s hand-off and audits it as skipped, with no bulk_batch_id when none given", async (releaseMedium) => {
    expect(await notifyResultReleased({ ...base, releaseMedium })).toEqual({
      status: "skipped",
      channels: [],
      reason: "physical hand-off — no message sent",
    });
    expectNothingSent();
    expect(noteAudits()).toHaveLength(1);
    const meta = noteAudits()[0].metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      release_medium: releaseMedium,
      email: { ok: false, skipped: true, reason: "physical hand-off — no message sent" },
      sms: { ok: false, skipped: true },
    });
    expect(meta).not.toHaveProperty("bulk_batch_id");
  });

  it.each([
    ["deleted", { deleted_at: "2026-09-01T00:00:00Z" }],
    ["merged", { merged_into_id: "pt2" }],
  ])("skips a %s patient, audits the skip, and sends nothing", async (reason, over) => {
    fx.patientRow = { ...patientRow, ...over };
    expect(await notifyResultReleased(base)).toEqual({ status: "skipped", channels: [], reason: "patient is not active" });
    expectNothingSent();
    expect(skipAudits()).toHaveLength(1);
    expect(skipAudits()[0]).toMatchObject({
      patient_id: "pt1",
      resource_type: "test_request",
      resource_id: "tr1",
      metadata: { sender: "notify-released", reason },
    });
    expect(noteAudits()).toHaveLength(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("skips when the patient record is missing (audit has a null patient_id)", async () => {
    fx.patientRow = null;
    expect((await notifyResultReleased(base)).reason).toBe("patient is not active");
    expectNothingSent();
    expect(skipAudits()[0]).toMatchObject({ patient_id: null, metadata: { reason: "missing" } });
  });

  it("fails closed on a recipient lookup error: skipped, audited, and reported", async () => {
    fx.patientError = { message: "boom" };
    expect(await notifyResultReleased(base)).toEqual({ status: "skipped", channels: [], reason: "patient is not active" });
    expectNothingSent();
    expect(skipAudits()[0]).toMatchObject({ metadata: { reason: "lookup_failed" } });
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ scope: "notifications.recipient_lookup" }));
  });

  it("skips a walk-in recipient with its own reason and audits reason walk_in", async () => {
    // checkPatientRecipient only returns walk_in for a null patient id, which
    // this caller never passes (the inner join guarantees one), so the branch
    // is driven by overriding the decision.
    fx.recipientOverride = { kind: "walk_in" };
    expect(await notifyResultReleased(base)).toEqual({
      status: "skipped",
      channels: [],
      reason: "walk-in patient — no contact details",
    });
    expectNothingSent();
    expect(skipAudits()[0]).toMatchObject({ metadata: { sender: "notify-released", reason: "walk_in" } });
  });

  it("skips with 'no email or phone on file' when the patient has neither contact", async () => {
    fx.patientRow = { ...patientRow, email: null, phone: null };
    expect(await notifyResultReleased(base)).toEqual({
      status: "skipped",
      channels: [],
      reason: "no email or phone on file",
    });
    expectNothingSent();
    expect(noteAudits()[0].metadata).toMatchObject({
      sms: { ok: false, skipped: true, reason: "patient has no phone on file" },
      email: { ok: false, skipped: true, reason: "patient has no email on file" },
    });
  });
});

describe("notifyResultReleased — sent / failed", () => {
  it("sends on both channels, returns sent [email, sms], and audits both ids", async () => {
    expect(await notifyResultReleased({ ...base, bulkBatchId: "b9" })).toEqual({
      status: "sent",
      channels: ["email", "sms"],
      reason: null,
    });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ana@example.com" }));
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: "09171234567" }));
    expect(reportError).not.toHaveBeenCalled();
    expect(noteAudits()).toHaveLength(1);
    expect(noteAudits()[0].metadata).toMatchObject({
      sms: { ok: true, id: "sm1" },
      email: { ok: true, id: "em1", to: "ana@example.com" },
      review_cta: { shown: true },
      bulk_batch_id: "b9",
    });
  });

  it("is sent with email only when SMS is not configured (skipped)", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "not configured" });
    expect(await notifyResultReleased(base)).toEqual({ status: "sent", channels: ["email"], reason: null });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not show the review CTA when the patient was already asked", async () => {
    fx.askedForReview = true;
    await notifyResultReleased(base);
    expect(noteAudits()[0].metadata).toMatchObject({ review_cta: { shown: false } });
  });

  it("returns failed when the email send errors, and reports it", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "error", error: "resend 500" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "not configured" });
    expect(await notifyResultReleased(base)).toEqual({ status: "failed", channels: [], reason: "sending failed" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "notify/result-released:email",
        metadata: { test_request_id: "tr1", visit_id: "v1" },
      }),
    );
    expect(noteAudits()[0].metadata).toMatchObject({
      email: { ok: false, error: "resend 500", to: "ana@example.com" },
      review_cta: { shown: false },
    });
  });

  it("returns failed when SMS errors and email is absent, reporting the sms scope", async () => {
    fx.patientRow = { ...patientRow, email: null };
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "error", error: "bad number" });
    expect(await notifyResultReleased(base)).toEqual({ status: "failed", channels: [], reason: "sending failed" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ scope: "notify/result-released:sms" }));
    expect(noteAudits()[0].metadata).toMatchObject({ review_cta: { shown: false } });
  });

  it("omits the review CTA when the visit snapshot has no email, even if the fresh recipient record does", async () => {
    // hasEmail reads the joined snapshot; the address actually used is re-read.
    fx.testRow = testRow({ patients: { id: "pt1", drm_id: "DRM-0001", first_name: "Ana", phone: patientRow.phone, email: null } });
    await notifyResultReleased(base);
    const mail = vi.mocked(sendEmail).mock.calls[0][0];
    expect(mail.text).not.toContain("Google review");
    expect(mail.html).not.toContain("review");
  });

  it("does not show the review CTA when the patient has no email (SMS still sends)", async () => {
    fx.patientRow = { ...patientRow, email: null };
    expect(await notifyResultReleased(base)).toEqual({ status: "sent", channels: ["sms"], reason: null });
    expect(noteAudits()[0].metadata).toMatchObject({ review_cta: { shown: false } });
  });

  it("greets \"there\" when the patient has no first name", async () => {
    fx.testRow = testRow({ patients: { id: "pt1", drm_id: "DRM-0001", first_name: null, phone: patientRow.phone, email: patientRow.email } });
    await notifyResultReleased(base);
    expect(vi.mocked(sendSms).mock.calls[0][0].message).toContain("Hi there,");
    const mail = vi.mocked(sendEmail).mock.calls[0][0];
    expect(mail.text).toContain("Hi there,");
    expect(mail.html).toContain("Hi <b>there</b>");
  });

  it("is still sent when one channel errors but the other delivers (error is reported)", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "error", error: "bad number" });
    expect(await notifyResultReleased(base)).toEqual({ status: "sent", channels: ["email"], reason: null });
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ scope: "notify/result-released:sms" }));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * notifyResultsReleasedBulk returns a ReleaseNoticeOutcome (sent / skipped /
 * failed + reason) since #280. One test per skip / send / fail branch, plus a
 * mixed run across several visits. The function itself handles ONE visit per
 * call (it consolidates that visit's components into one message); there is no
 * cross-visit aggregate to test, so the "mixed batch" drives several visits
 * through it and checks each outcome and the exact set of provider calls.
 *
 * Mocking style mirrors notify-corrected.test.ts / notify-released.test.ts:
 * table-keyed admin fake, mocked ./email, ./sms, audit and reportError.
 */

vi.mock("server-only", () => ({}));

type Res = { data: unknown; error: { message: string } | null };

const fx = vi.hoisted(() => ({
  visits: {} as Record<string, unknown>,
  visitId: "v1",
  patientRow: null as unknown,
  patientError: null as null | { message: string },
  askedForReview: false,
  audits: [] as Record<string, unknown>[],
  recipientOverride: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      let eqId: string | null = null;
      for (const m of ["select", "is"]) chain[m] = self;
      chain.eq = (_col: string, val: string) => {
        eqId = val;
        return chain;
      };
      if (table === "visits") {
        chain.maybeSingle = async (): Promise<Res> => ({ data: fx.visits[eqId ?? ""] ?? null, error: null });
      } else if (table === "patients") {
        chain.maybeSingle = async (): Promise<Res> => ({
          data: typeof fx.patientRow === "function" ? (fx.patientRow as (id: string | null) => unknown)(eqId) : fx.patientRow,
          error: fx.patientError,
        });
      } else if (table === "audit_log") {
        chain.limit = async (): Promise<Res> => ({ data: fx.askedForReview ? [{ id: "a1" }] : [], error: null });
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
// Real recipient check unless a test overrides the decision (walk-in: the real
// function only returns walk_in for a null patient id, never passed here).
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
import { notifyResultsReleasedBulk } from "./notify-released-bulk";

const patientRow = {
  id: "pt1",
  drm_id: "DRM-0001",
  first_name: "Ana",
  phone: "09171234567",
  email: "ana@example.com",
  deleted_at: null,
  merged_into_id: null,
};

const visitRow = (over: { is_sample?: boolean; patients?: unknown } = {}) => ({
  id: "v1",
  is_sample: over.is_sample ?? false,
  patients:
    over.patients ?? { id: "pt1", drm_id: "DRM-0001", first_name: "Ana", phone: patientRow.phone, email: patientRow.email },
});

const base = {
  visitId: "v1",
  testRequestIds: ["tr1", "tr2"],
  testNames: ["CBC", "Urinalysis"],
  releaseMedium: "portal",
};
const noteAudits = () => fx.audits.filter((a) => a.action === "result.notified");
const skipAudits = () => fx.audits.filter((a) => a.action === "notification.skipped_inactive_patient");

beforeEach(() => {
  vi.clearAllMocks();
  fx.visits = { v1: visitRow() };
  fx.patientRow = { ...patientRow };
  fx.patientError = null;
  fx.askedForReview = false;
  fx.audits = [];
  fx.recipientOverride = null;
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "em1" });
  vi.mocked(sendSms).mockResolvedValue({ ok: true, id: "sm1" });
});

function expectNothingSent() {
  expect(sendEmail).not.toHaveBeenCalled();
  expect(sendSms).not.toHaveBeenCalled();
}

describe("notifyResultsReleasedBulk — skips", () => {
  it("skips an empty batch before touching the database", async () => {
    fx.visits = {};
    expect(await notifyResultsReleasedBulk({ ...base, testRequestIds: [], testNames: [] })).toEqual({
      status: "skipped",
      channels: [],
      reason: "nothing to announce",
    });
    expectNothingSent();
    expect(fx.audits).toHaveLength(0);
  });

  it("skips when the visit is not found (or deleted)", async () => {
    fx.visits = {};
    expect(await notifyResultsReleasedBulk(base)).toEqual({ status: "skipped", channels: [], reason: "visit not found" });
    expectNothingSent();
    expect(fx.audits).toHaveLength(0);
  });

  it("skips when the visit has no patient", async () => {
    fx.visits = { v1: visitRow({ patients: [] }) };
    expect(await notifyResultsReleasedBulk(base)).toEqual({ status: "skipped", channels: [], reason: "patient not found" });
    expectNothingSent();
  });

  it("skips a sample visit and audits a skipped bulk row on the first test", async () => {
    fx.visits = { v1: visitRow({ is_sample: true }) };
    expect(await notifyResultsReleasedBulk({ ...base, bulkBatchId: "b1" })).toEqual({
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
      metadata: {
        sms: skipped,
        email: skipped,
        bulk: true,
        count: 2,
        test_request_ids: ["tr1", "tr2"],
        bulk_batch_id: "b1",
      },
    });
  });

  it("a sample visit wins over a physical hand-off", async () => {
    fx.visits = { v1: visitRow({ is_sample: true }) };
    expect((await notifyResultsReleasedBulk({ ...base, releaseMedium: "physical" })).reason).toBe(SAMPLE_SKIP_REASON);
  });

  it.each(["physical", "pickup"])("skips a %s hand-off and audits it as skipped", async (releaseMedium) => {
    expect(await notifyResultsReleasedBulk({ ...base, releaseMedium })).toEqual({
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
      bulk: true,
      count: 2,
    });
    expect(meta).not.toHaveProperty("bulk_batch_id");
  });

  it.each([
    ["deleted", { deleted_at: "2026-09-01T00:00:00Z" }],
    ["merged", { merged_into_id: "pt2" }],
  ])("skips a %s patient, audits the skip against the visit, and sends nothing", async (reason, over) => {
    fx.patientRow = { ...patientRow, ...over };
    expect(await notifyResultsReleasedBulk(base)).toEqual({ status: "skipped", channels: [], reason: "patient is not active" });
    expectNothingSent();
    expect(skipAudits()).toHaveLength(1);
    expect(skipAudits()[0]).toMatchObject({
      patient_id: "pt1",
      resource_type: "visit",
      resource_id: "v1",
      metadata: { sender: "notify-released-bulk", reason },
    });
    expect(noteAudits()).toHaveLength(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("skips when the patient record is missing (audit has a null patient_id)", async () => {
    fx.patientRow = null;
    expect((await notifyResultsReleasedBulk(base)).reason).toBe("patient is not active");
    expectNothingSent();
    expect(skipAudits()[0]).toMatchObject({ patient_id: null, metadata: { reason: "missing" } });
  });

  it("fails closed on a recipient lookup error: skipped, audited, and reported", async () => {
    fx.patientError = { message: "boom" };
    expect(await notifyResultsReleasedBulk(base)).toEqual({ status: "skipped", channels: [], reason: "patient is not active" });
    expectNothingSent();
    expect(skipAudits()[0]).toMatchObject({ metadata: { reason: "lookup_failed" } });
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ scope: "notifications.recipient_lookup" }));
  });

  it("skips a walk-in recipient with its own reason and audits reason walk_in", async () => {
    fx.recipientOverride = { kind: "walk_in" };
    expect(await notifyResultsReleasedBulk(base)).toEqual({
      status: "skipped",
      channels: [],
      reason: "walk-in patient — no contact details",
    });
    expectNothingSent();
    expect(skipAudits()[0]).toMatchObject({ metadata: { sender: "notify-released-bulk", reason: "walk_in" } });
  });

  it("skips with 'no email or phone on file' when the patient has neither contact", async () => {
    fx.patientRow = { ...patientRow, email: null, phone: null };
    expect(await notifyResultsReleasedBulk(base)).toEqual({
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

describe("notifyResultsReleasedBulk — sent / failed", () => {
  it("sends ONE consolidated email + SMS and audits one bulk row keyed on the first test", async () => {
    expect(await notifyResultsReleasedBulk({ ...base, bulkBatchId: "b9" })).toEqual({
      status: "sent",
      channels: ["email", "sms"],
      reason: null,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ana@example.com", subject: "2 lab results ready — DRMed" }));
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "09171234567", message: expect.stringContaining("2 results from your DRMed visit are ready") }),
    );
    expect(reportError).not.toHaveBeenCalled();
    expect(noteAudits()).toHaveLength(1);
    expect(noteAudits()[0]).toMatchObject({
      resource_id: "tr1",
      metadata: {
        sms: { ok: true, id: "sm1" },
        email: { ok: true, id: "em1", to: "ana@example.com" },
        review_cta: { shown: true },
        bulk: true,
        count: 2,
        test_names: ["CBC", "Urinalysis"],
        bulk_batch_id: "b9",
      },
    });
  });

  it("uses singular wording for a one-test batch", async () => {
    await notifyResultsReleasedBulk({ ...base, testRequestIds: ["tr1"], testNames: ["CBC"] });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: "1 lab result ready — DRMed" }));
  });

  it("is sent with email only when SMS is skipped", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "not configured" });
    expect(await notifyResultsReleasedBulk(base)).toEqual({ status: "sent", channels: ["email"], reason: null });
  });

  it("returns failed when the email send errors, and reports it with the batch ids", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, kind: "error", error: "resend 500" });
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "skipped", reason: "not configured" });
    expect(await notifyResultsReleasedBulk(base)).toEqual({ status: "failed", channels: [], reason: "sending failed" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "notify/result-released-bulk:email",
        metadata: { visit_id: "v1", test_request_ids: ["tr1", "tr2"] },
      }),
    );
    expect(noteAudits()[0].metadata).toMatchObject({ email: { ok: false, error: "resend 500", to: "ana@example.com" } });
  });

  it("returns failed when SMS errors and email is absent, reporting the sms scope", async () => {
    fx.patientRow = { ...patientRow, email: null };
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "error", error: "bad number" });
    expect(await notifyResultsReleasedBulk(base)).toEqual({ status: "failed", channels: [], reason: "sending failed" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ scope: "notify/result-released-bulk:sms" }));
  });

  it("is still sent when one channel errors but the other delivers", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: false, kind: "error", error: "bad number" });
    expect(await notifyResultsReleasedBulk(base)).toEqual({ status: "sent", channels: ["email"], reason: null });
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ scope: "notify/result-released-bulk:sms" }));
  });
});

describe("notifyResultsReleasedBulk — mixed batch of visits", () => {
  it("returns the right outcome per visit and only the sendable ones reach a provider", async () => {
    const pat = (id: string) => ({ id, drm_id: `DRM-${id}`, first_name: id, phone: null, email: `${id}@example.com` });
    fx.visits = {
      vSent: { id: "vSent", is_sample: false, patients: pat("pSent") },
      vSample: { id: "vSample", is_sample: true, patients: pat("pSample") },
      vDeleted: { id: "vDeleted", is_sample: false, patients: pat("pDeleted") },
      vFail: { id: "vFail", is_sample: false, patients: pat("pFail") },
    };
    fx.patientRow = (id: string | null) => ({
      ...patientRow,
      id,
      email: `${id}@example.com`,
      phone: null,
      deleted_at: id === "pDeleted" ? "2026-09-01T00:00:00Z" : null,
    });
    vi.mocked(sendEmail).mockImplementation(async (input) =>
      input.to === "pFail@example.com" ? { ok: false, kind: "error", error: "resend 500" } : { ok: true, id: "em1" },
    );

    const run = (visitId: string, releaseMedium = "portal") =>
      notifyResultsReleasedBulk({ ...base, visitId, testRequestIds: [`${visitId}-t`], testNames: ["CBC"], releaseMedium });

    const outcomes = [
      await run("vSent"),
      await run("vSample"),
      await run("vDeleted"),
      await run("vFail"),
      await run("vSent", "pickup"),
      await run("vMissing"),
    ];

    expect(outcomes).toEqual([
      { status: "sent", channels: ["email"], reason: null },
      { status: "skipped", channels: [], reason: SAMPLE_SKIP_REASON },
      { status: "skipped", channels: [], reason: "patient is not active" },
      { status: "failed", channels: [], reason: "sending failed" },
      { status: "skipped", channels: [], reason: "physical hand-off — no message sent" },
      { status: "skipped", channels: [], reason: "visit not found" },
    ]);
    // Exactly the two sendable visits hit the email provider; nobody else.
    expect(vi.mocked(sendEmail).mock.calls.map((c) => c[0].to)).toEqual(["pSent@example.com", "pFail@example.com"]);
    expect(sendSms).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    // sent, sample, pickup, failed audits + one inactive-skip audit; missing visit audits nothing.
    expect(noteAudits().map((a) => a.resource_id)).toEqual(["vSent-t", "vSample-t", "vFail-t", "vSent-t"]);
    expect(skipAudits()).toHaveLength(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  admin: {} as Record<string, unknown>, // any .from()/.rpc() on it would throw: the action must not touch the database itself
  requireAdmin: vi.fn(),
  build: vi.fn(),
  send: vi.fn(),
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: fx.requireAdmin }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fx.admin }));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: "203.0.113.9", ua: "vitest" }) }));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: fx.send }));
vi.mock("@/lib/marketing/patient-sources-digest.server", () => ({ buildPatientSourcesDigestEmail: fx.build }));

import { sendPatientSourcesPreviewAction } from "./preview-actions";

const ADMIN = { user_id: "admin-1", email: "owner@drmed.ph", full_name: "Ian Jamila", role: "admin" };
const EMAIL = { ok: true, kind: "email", period: { from: "2026-09-28", to: "2026-10-04" }, subject: "Patient sources, Wk of 28 Sep: 12 new (▲ 4)", html: "<p>h</p>", text: "t" };

beforeEach(() => {
  fx.requireAdmin.mockReset().mockResolvedValue(ADMIN);
  fx.build.mockReset().mockResolvedValue(EMAIL);
  fx.send.mockReset().mockResolvedValue({ ok: true, id: "em_1" });
  fx.audits.length = 0;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("sendPatientSourcesPreviewAction", () => {
  it("refuses a non-admin: nothing is built, sent or logged", async () => {
    fx.requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(sendPatientSourcesPreviewAction("week")).rejects.toThrow("NEXT_REDIRECT");
    expect(fx.build).not.toHaveBeenCalled();
    expect(fx.send).not.toHaveBeenCalled();
    expect(fx.audits).toHaveLength(0);
  });

  it("sends the digest to the caller only, subject prefixed [Preview], no idempotency key", async () => {
    const res = await sendPatientSourcesPreviewAction("week");
    expect(res).toEqual({ ok: true, data: { sentTo: "owner@drmed.ph", periodFrom: "2026-09-28" } });
    expect(fx.build).toHaveBeenCalledWith(fx.admin, "week", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), "https://drmed.ph");
    expect(fx.send).toHaveBeenCalledTimes(1);
    expect(fx.send.mock.calls[0]![0]).toEqual({
      to: "owner@drmed.ph",
      subject: "[Preview] Patient sources, Wk of 28 Sep: 12 new (▲ 4)",
      text: "t",
      html: "<p>h</p>",
    });
  });

  it("audits staff_alert.preview_sent as the staff member, and writes nothing else (no claim, no .sent)", async () => {
    await sendPatientSourcesPreviewAction("month");
    expect(fx.audits).toHaveLength(1);
    expect(fx.audits[0]).toMatchObject({
      actor_id: "admin-1",
      actor_type: "staff",
      action: "staff_alert.preview_sent",
      metadata: { alert_key: "patient_sources_monthly", period_from: "2026-09-28" },
      ip_address: "203.0.113.9",
    });
    expect(fx.build).toHaveBeenCalledWith(fx.admin, "month", expect.any(String), "https://drmed.ph");
  });

  it("surfaces a skipped send's reason (the shared emailStatus wording) and is not a success; nothing is logged", async () => {
    fx.send.mockResolvedValue({ ok: false, kind: "skipped", reason: "NOTIFICATIONS_LIVE not enabled in this environment" });
    expect(await sendPatientSourcesPreviewAction("week")).toEqual({ ok: false, error: "NOTIFICATIONS_LIVE not enabled in this environment" });
    expect(fx.audits).toHaveLength(0);
  });

  it("a send error is a plain failure", async () => {
    fx.send.mockResolvedValue({ ok: false, kind: "error", error: "Resend 500", definite: true });
    expect(await sendPatientSourcesPreviewAction("week")).toMatchObject({ ok: false, error: expect.stringMatching(/did not accept/) });
    expect(fx.audits).toHaveLength(0);
  });

  it("a digest that cannot be built, or is too early, sends nothing", async () => {
    fx.build.mockResolvedValue({ ok: false, message: "report: down" });
    expect(await sendPatientSourcesPreviewAction("week")).toMatchObject({ ok: false });
    fx.build.mockResolvedValue({ ok: true, kind: "too_early", period: { from: "2023-11-01", to: "2023-11-30" } });
    expect(await sendPatientSourcesPreviewAction("month")).toMatchObject({ ok: false, error: expect.stringMatching(/first date/) });
    expect(fx.send).not.toHaveBeenCalled();
  });

  it("refuses an admin with no email address, and any kind other than week/month", async () => {
    fx.requireAdmin.mockResolvedValue({ ...ADMIN, email: "" });
    expect(await sendPatientSourcesPreviewAction("week")).toMatchObject({ ok: false, error: expect.stringMatching(/no email address/) });
    fx.requireAdmin.mockResolvedValue(ADMIN);
    expect(await sendPatientSourcesPreviewAction("year" as never)).toMatchObject({ ok: false });
    expect(fx.build).not.toHaveBeenCalled();
  });
});

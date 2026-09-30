import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const queued: Array<() => unknown> = [];
vi.mock("next/server", () => ({ after: (fn: () => unknown) => queued.push(fn) }));

let visitResult: { data: unknown; error: unknown } | Error;
const visitFilters: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      expect(table).toBe("visits");
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, v: unknown) => {
        visitFilters.push(`eq:${col}=${String(v)}`);
        return q;
      };
      q.is = (col: string, v: unknown) => {
        visitFilters.push(`is:${col}=${String(v)}`);
        return q;
      };
      q.maybeSingle = async () => {
        if (visitResult instanceof Error) throw visitResult;
        return visitResult;
      };
      return q;
    },
  }),
}));

const resolveRecipients = vi.fn();
vi.mock("./staff-alert-recipients", () => ({ resolveStaffAlertRecipients: (...a: unknown[]) => resolveRecipients(...a) }));

const sendEmail = vi.fn();
vi.mock("./email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

const auditMock = vi.fn();
vi.mock("@/lib/audit/log", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

const reportError = vi.fn();
vi.mock("@/lib/observability/report-error", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { scheduleReleaseStaffAlert } from "./release-staff-alert";

const visitRow = {
  id: "v1",
  visit_number: "0044",
  is_sample: false,
  deleted_at: null,
  patients: { first_name: "Ian", last_name: "Jamila" },
};

async function run() {
  expect(queued).toHaveLength(1);
  await queued[0]!();
}

beforeEach(() => {
  queued.length = 0;
  visitFilters.length = 0;
  visitResult = { data: visitRow, error: null };
  resolveRecipients.mockReset().mockResolvedValue({ enabled: true, emails: ["a@x.com", "b@x.com"], staffOn: [], staffWithoutEmail: [] });
  sendEmail.mockReset().mockResolvedValue({ ok: true });
  auditMock.mockReset().mockResolvedValue(undefined);
  reportError.mockReset().mockResolvedValue(undefined);
});

describe("scheduleReleaseStaffAlert", () => {
  it("queues exactly one after() callback and does no I/O until it runs", () => {
    scheduleReleaseStaffAlert("v1", 3);
    expect(queued).toHaveLength(1);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(visitFilters).toEqual([]);
  });

  it("emails every recipient and writes one audit row without addresses", async () => {
    scheduleReleaseStaffAlert("v1", 3);
    await run();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0]![0].subject).toBe("3 results released for Ian J. — visit #0044");
    expect(resolveRecipients).toHaveBeenCalledWith("result_released", expect.anything());
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      action: "test_request.released.staff_alert_sent",
      actor_type: "system",
      resource_type: "visit",
      resource_id: "v1",
      metadata: { recipients: 2, sent: 2, failed: 0, count: 3 },
    });
    expect(JSON.stringify(auditMock.mock.calls[0]![0])).not.toContain("@");
  });

  it("reads the visit live (deleted_at is null) at query level", async () => {
    scheduleReleaseStaffAlert("v1", 1);
    await run();
    expect(visitFilters).toContain("is:deleted_at=null");
    expect(visitFilters).toContain("eq:id=v1");
  });

  it("counts failed sends", async () => {
    sendEmail.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, kind: "failed" });
    scheduleReleaseStaffAlert("v1", 2);
    await run();
    expect(auditMock.mock.calls[0]![0].metadata).toMatchObject({ sent: 1, failed: 1 });
  });

  it("skips a sample visit", async () => {
    visitResult = { data: { ...visitRow, is_sample: true }, error: null };
    scheduleReleaseStaffAlert("v1", 3);
    await run();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0]![0].metadata).toMatchObject({ skipped: "sample visit" });
  });

  it("queues nothing for a zero count", () => {
    scheduleReleaseStaffAlert("v1", 0);
    expect(queued).toHaveLength(0);
  });

  it("sends nothing when the alert is off, and says why", async () => {
    resolveRecipients.mockResolvedValue({ enabled: false, emails: [], staffOn: [], staffWithoutEmail: [] });
    scheduleReleaseStaffAlert("v1", 3);
    await run();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0]![0].metadata).toMatchObject({ skipped: "turned off in Email Alerts" });
  });

  it("sends nothing when nobody is switched on", async () => {
    resolveRecipients.mockResolvedValue({ enabled: true, emails: [], staffOn: [], staffWithoutEmail: [] });
    scheduleReleaseStaffAlert("v1", 3);
    await run();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0]![0].metadata).toMatchObject({
      skipped: "nobody is switched on for this alert in Email Alerts",
    });
  });

  it("a failed recipient read is audited as a read failure, never as nobody switched on", async () => {
    resolveRecipients.mockResolvedValue({
      enabled: true,
      emails: [],
      staffOn: ["s1"],
      staffWithoutEmail: ["s1"],
      loadError: "staff sign-in emails, page 1: timeout",
    });
    scheduleReleaseStaffAlert("v1", 3);
    await run();
    expect(sendEmail).not.toHaveBeenCalled();
    const meta = auditMock.mock.calls[0]![0].metadata;
    expect(meta.skipped).toContain("couldn't read who gets this alert");
    expect(meta.skipped).not.toContain("nobody is switched on");
    expect(meta.recipients_error).toBe("staff sign-in emails, page 1: timeout");
  });

  it("still emails whoever was resolved after a partial read, and records the error", async () => {
    resolveRecipients.mockResolvedValue({
      enabled: true,
      emails: ["desk@drmed.test"],
      staffOn: [],
      staffWithoutEmail: [],
      loadError: "alert recipients: gone",
    });
    scheduleReleaseStaffAlert("v1", 3);
    await run();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const meta = auditMock.mock.calls[0]![0].metadata;
    expect(meta.skipped).toBeUndefined();
    expect(meta.recipients_error).toBe("alert recipients: gone");
  });

  it("reports (and does not rethrow) a thrown visit read", async () => {
    visitResult = new Error("boom");
    scheduleReleaseStaffAlert("v1", 3);
    await expect(run()).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("reports a visit read that returns an error and claims no send", async () => {
    const error = { message: "db down" };
    visitResult = { data: null, error };
    scheduleReleaseStaffAlert("v1", 3);
    await run();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ error }));
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("skips a visit deleted (or missing) by the time the callback runs", async () => {
    visitResult = { data: null, error: null };
    scheduleReleaseStaffAlert("v1", 3);
    await run();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0]![0].metadata).toMatchObject({ skipped: "visit deleted or missing" });
  });
});

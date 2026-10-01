import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * auditTerminalNotice WITHOUT the live send context — what the sweeper does for
 * a terminal notice that never got its audit row (a crash between finish and the
 * audit, or an exhausted lease the claim closed as abandoned): rebuild the row
 * from the database, never write a second audit for the same notice, and stamp
 * only once the row is really in.
 */

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  existing: [] as unknown[],
  existingError: null as null | { message: string },
  patientId: "pt1" as string | null,
  asked: false,
  stamp: true,
  stampError: null as null | { message: string },
  auditOk: true,
  audits: [] as Record<string, unknown>[],
  stamps: 0,
  auditFilters: [] as unknown[][],
}));

const admin = {
  from: (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "in", "eq", "limit"]) {
      b[m] = (...a: unknown[]) => {
        if (table === "audit_log") fx.auditFilters.push([m, ...a]);
        return b;
      };
    }
    b.maybeSingle = async () => ({ data: fx.patientId ? { patient_id: fx.patientId } : null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: fx.existing, error: fx.existingError });
    return b;
  },
  rpc: async () => {
    fx.stamps += 1;
    return { data: fx.stamp, error: fx.stampError };
  },
};

vi.mock("@/lib/audit/log", () => ({
  audit: vi.fn(),
  auditChecked: vi.fn(async (e: Record<string, unknown>) => {
    fx.audits.push(e);
    return fx.auditOk;
  }),
}));
vi.mock("./review-cta", () => ({ patientAlreadyAskedForReview: vi.fn(async () => fx.asked) }));

import { auditTerminalNotice } from "./release-notice-audit";
import type { ReleaseNoticeRow } from "./release-notice-types";

function row(over: Partial<ReleaseNoticeRow>): ReleaseNoticeRow {
  return {
    id: "n1", visit_id: "v1", released_at: "2026-10-01T05:00:00.123456+00:00", test_request_ids: ["t1"],
    release_medium: "email", bulk_batch_id: "batch-1", status: "sent", email_state: "sent", sms_state: "skipped",
    email_provider_id: "em1", sms_provider_id: null, attempts: 2, next_attempt_at: "2026-10-01T05:00:00+00:00",
    lease_token: null, lease_expires_at: null, last_error: null, skip_reason: "patient has no phone on file",
    created_at: "2026-10-01T05:00:00+00:00", sent_at: "2026-10-01T05:10:00+00:00",
    resolved_at: "2026-10-01T05:10:00+00:00", audited_at: null, ...over,
  };
}

beforeEach(() => {
  Object.assign(fx, { existing: [], existingError: null, patientId: "pt1", asked: false, stamp: true, stampError: null, auditOk: true, audits: [], stamps: 0, auditFilters: [] });
});

describe("auditTerminalNotice (rebuilt from the row)", () => {
  it("audits a sent notice from its channel states, with the batch id, then stamps", async () => {
    expect(await auditTerminalNotice(admin as never, row({}))).toBe("stamped");
    expect(fx.audits).toHaveLength(1);
    expect(fx.audits[0]).toMatchObject({ action: "result.notified", patient_id: "pt1", resource_type: "test_request", resource_id: "t1" });
    expect(fx.audits[0].metadata).toMatchObject({
      visit_id: "v1",
      sms: { ok: false, skipped: true },
      email: { ok: true, id: "em1" },
      review_cta: { shown: true },
      notice_id: "n1",
      bulk_batch_id: "batch-1",
    });
    expect(fx.stamps).toBe(1);
  });

  it("does not claim the review CTA was shown when the patient had already been asked", async () => {
    fx.asked = true;
    await auditTerminalNotice(admin as never, row({}));
    expect(fx.audits[0].metadata).toMatchObject({ review_cta: { shown: false } });
  });

  it("audits an abandoned notice as result.notice_abandoned with the (redacted) last error", async () => {
    await auditTerminalNotice(admin as never, row({ status: "abandoned", email_state: "failed", last_error: "Resend 500", sent_at: null }));
    expect(fx.audits[0]).toMatchObject({
      action: "result.notice_abandoned",
      metadata: { notice_id: "n1", attempts: 2, last_error: "Resend 500", bulk_batch_id: "batch-1" },
    });
  });

  it("does NOT write a second audit when one already exists for this notice — it only stamps", async () => {
    fx.existing = [{ id: "a1" }];
    expect(await auditTerminalNotice(admin as never, row({}))).toBe("stamped");
    expect(fx.audits).toHaveLength(0);
    expect(fx.stamps).toBe(1);
    expect(fx.auditFilters).toContainEqual(["eq", "metadata->>notice_id", "n1"]);
  });

  it("cannot tell whether it was audited (read error) -> writes nothing and does not stamp", async () => {
    fx.existingError = { message: "boom" };
    expect(await auditTerminalNotice(admin as never, row({}))).toBe("audit_failed");
    expect(fx.audits).toHaveLength(0);
    expect(fx.stamps).toBe(0);
  });

  it("an audit write that fails is not stamped", async () => {
    fx.auditOk = false;
    expect(await auditTerminalNotice(admin as never, row({}))).toBe("audit_failed");
    expect(fx.stamps).toBe(0);
  });

  it("a stamp that answers false reports already_audited", async () => {
    fx.stamp = false;
    expect(await auditTerminalNotice(admin as never, row({}))).toBe("already_audited");
  });

  it("never stamps or audits a row that is not terminal", async () => {
    expect(await auditTerminalNotice(admin as never, row({ status: "retry", resolved_at: null, sent_at: null }))).toBe("already_audited");
    expect(fx.audits).toHaveLength(0);
    expect(fx.stamps).toBe(0);
  });

  it("audits a doctor-only skip with nothing (today writes none) but still stamps", async () => {
    await auditTerminalNotice(admin as never, row({ status: "skipped", skip_reason: "consultation — nothing to announce", sent_at: null }));
    expect(fx.audits).toHaveLength(0);
    expect(fx.stamps).toBe(1);
  });

  it("rebuilds an inactive-patient skip with its code and the batch id", async () => {
    await auditTerminalNotice(admin as never, row({ status: "skipped", skip_reason: "patient is not active (merged)", sent_at: null }));
    expect(fx.audits[0]).toMatchObject({
      action: "notification.skipped_inactive_patient",
      metadata: { reason: "merged", bulk_batch_id: "batch-1", notice_id: "n1" },
    });
  });
});

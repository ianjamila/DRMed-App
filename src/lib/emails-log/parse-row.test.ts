import { describe, it, expect } from "vitest";
import { parseEmailLogRow } from "./parse-row";
import type { EmailAuditRow, PatientLite } from "./types";

const patient: PatientLite = {
  id: "p1",
  drm_id: "DRM-0042",
  first_name: "Juan",
  middle_name: "Santos",
  last_name: "Cruz",
  email: "juan@example.com",
};

function row(over: Partial<EmailAuditRow>): EmailAuditRow {
  return {
    id: 1,
    action: "result.notified",
    patient_id: "p1",
    resource_type: "test_request",
    resource_id: "t1",
    metadata: {},
    created_at: "2026-06-16T01:00:00.000Z",
    ...over,
  };
}

describe("parseEmailLogRow", () => {
  it("result.notified — sent, detail = test name, recipient from patient", () => {
    const e = parseEmailLogRow(
      row({ metadata: { visit_id: "v1", test_name: "CBC", email: { ok: true, id: "re_1" } } }),
      patient,
    );
    expect(e.type).toBe("result");
    expect(e.typeLabel).toBe("Result ready");
    expect(e.status).toBe("sent");
    expect(e.statusLabel).toBe("Sent");
    expect(e.detail).toBe("CBC");
    expect(e.recipientName).toBe("Cruz, Juan Santos");
    expect(e.recipientDrmId).toBe("DRM-0042");
    expect(e.recipientEmail).toBe("juan@example.com");
    expect(e.resendId).toBe("re_1");
    expect(e.visitId).toBe("v1");
  });

  it("uses snapshot metadata.email.to over the patient's current email", () => {
    const e = parseEmailLogRow(
      row({ metadata: { test_name: "CBC", email: { ok: true, id: "re_1", to: "old@example.com" } } }),
      patient,
    );
    expect(e.recipientEmail).toBe("old@example.com");
  });

  it("appointment.booked.notified — failed when email.error present, detail = error", () => {
    const e = parseEmailLogRow(
      row({
        action: "appointment.booked.notified",
        resource_type: "appointment",
        resource_id: "a1",
        metadata: { email: { ok: false, error: "Resend 422: bad address" } },
      }),
      patient,
    );
    expect(e.type).toBe("booking");
    expect(e.status).toBe("failed");
    expect(e.detail).toBe("Resend 422: bad address");
  });

  it("appointment.reminder.sent — no_email when skipped, detail = reason", () => {
    const e = parseEmailLogRow(
      row({
        action: "appointment.reminder.sent",
        resource_type: "appointment",
        resource_id: "a1",
        metadata: { email: { ok: false, skipped: true, reason: "no email" }, has_form: false },
      }),
      patient,
    );
    expect(e.type).toBe("reminder");
    expect(e.status).toBe("no_email");
    expect(e.statusLabel).toBe("No email on file");
    expect(e.detail).toBe("no email");
  });

  it("appointment.reminder.failed — failed, detail = metadata.error, no email key", () => {
    const e = parseEmailLogRow(
      row({
        action: "appointment.reminder.failed",
        resource_type: "appointment",
        resource_id: "a1",
        metadata: { error: "boom" },
      }),
      patient,
    );
    expect(e.type).toBe("reminder");
    expect(e.status).toBe("failed");
    expect(e.detail).toBe("boom");
    expect(e.recipientName).toBe("Cruz, Juan Santos");
  });

  it("newsletter.campaign.sent — bulk, detail = subject, carries counts, no patient", () => {
    const e = parseEmailLogRow(
      row({
        action: "newsletter.campaign.sent",
        patient_id: null,
        resource_type: "newsletter_campaign",
        resource_id: "c1",
        metadata: { subject: "June news", attempted: 120, delivered: 118, failed: 2 },
      }),
      null,
    );
    expect(e.type).toBe("newsletter");
    expect(e.status).toBe("bulk");
    expect(e.detail).toBe("June news");
    expect(e.bulk).toEqual({ attempted: 120, delivered: 118, failed: 2 });
    expect(e.recipientName).toBeNull();
    expect(e.recipientEmail).toBeNull();
  });

  it("patient.self_registered — registration_new, sent when email captured", () => {
    const e = parseEmailLogRow(
      row({
        action: "patient.self_registered",
        resource_type: "patient",
        resource_id: "p1",
        metadata: { drm_id: "DRM-0042", email: { ok: true, id: "re_2", to: "juan@example.com" } },
      }),
      patient,
    );
    expect(e.type).toBe("registration_new");
    expect(e.typeLabel).toBe("Registration welcome");
    expect(e.status).toBe("sent");
  });

  it("patient.self_register.matched — registration_existing; legacy row (no email key) defaults to sent", () => {
    const e = parseEmailLogRow(
      row({
        action: "patient.self_register.matched",
        resource_type: "patient",
        resource_id: "p1",
        metadata: { drm_id: "DRM-0042", via: "register" },
      }),
      patient,
    );
    expect(e.type).toBe("registration_existing");
    expect(e.status).toBe("sent");
    expect(e.recipientEmail).toBe("juan@example.com");
  });
});

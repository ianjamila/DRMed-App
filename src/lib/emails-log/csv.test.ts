import { describe, it, expect } from "vitest";
import { emailLogToCsv } from "./csv";
import type { EmailLogEntry } from "./types";

function entry(over: Partial<EmailLogEntry>): EmailLogEntry {
  return {
    id: 1,
    sentAt: "2026-06-16T01:00:00.000Z",
    type: "result",
    typeLabel: "Result ready",
    status: "sent",
    statusLabel: "Sent",
    patientId: "p1",
    recipientName: "Cruz, Juan",
    recipientDrmId: "DRM-0042",
    recipientEmail: "juan@example.com",
    resendId: "re_1",
    detail: "CBC",
    resourceType: "test_request",
    resourceId: "t1",
    visitId: "v1",
    ...over,
  };
}

describe("emailLogToCsv", () => {
  it("emits a header row then one row per entry", () => {
    const csv = emailLogToCsv([entry({})]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      '"Sent (ISO)","Type","Status","Recipient","DRM-ID","Email","Resend ID","Detail"',
    );
    expect(lines[1]).toContain('"Result ready"');
    expect(lines[1]).toContain('"juan@example.com"');
  });

  it("escapes embedded quotes by doubling them", () => {
    const csv = emailLogToCsv([entry({ detail: 'he said "hi"' })]);
    expect(csv).toContain('"he said ""hi"""');
  });

  it("renders newsletter recipient + delivered/attempted in status", () => {
    const csv = emailLogToCsv([
      entry({
        type: "newsletter",
        typeLabel: "Newsletter",
        status: "bulk",
        statusLabel: "Newsletter",
        recipientName: null,
        recipientDrmId: null,
        recipientEmail: null,
        detail: "June news",
        bulk: { attempted: 120, delivered: 118, failed: 2 },
      }),
    ]);
    const line = csv.split("\r\n")[1];
    expect(line).toContain('"Newsletter (118/120)"');
    expect(line).toContain('"All subscribers (120)"');
  });
});

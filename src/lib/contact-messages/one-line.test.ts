// The visitor-typed text that reaches a staff email subject line or greeting.
import { describe, it, expect } from "vitest";
import { oneLine, knownContactSubject, CORPORATE_SUBJECT } from "@/lib/contact-messages/labels";
import { firstNameOf } from "@/lib/contact-messages/first-name";
import { buildAlertEmail } from "@/lib/contact-messages/alert-content";
import { buildEmailReply } from "@/lib/contact-messages/reply-content";
import { ContactSchema } from "@/lib/validations/contact";

const HOSTILE = "Lab Tests\r\nBcc: victim@example.com\n\nURGENT: your account is locked, click here";

describe("oneLine", () => {
  it("removes line breaks and control characters", () => {
    expect(oneLine("a\r\nb\tc\u0007d", 80)).toBe("a b c d");
  });
  it("caps the length with an ellipsis", () => {
    const out = oneLine("x".repeat(200), 80);
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns empty for null", () => {
    expect(oneLine(null, 80)).toBe("");
  });
});

describe("knownContactSubject", () => {
  it("keeps a subject the form offers", () => {
    expect(knownContactSubject(CORPORATE_SUBJECT)).toBe(CORPORATE_SUBJECT);
  });
  it("drops anything else", () => {
    expect(knownContactSubject(HOSTILE)).toBeNull();
    expect(knownContactSubject("")).toBeNull();
  });
});

describe("the public contact schema", () => {
  const base = { name: "Maria", email: "", phone: "0917", message: "Hello there" };
  it("stores an unknown subject as no subject", () => {
    const r = ContactSchema.safeParse({ ...base, subject: HOSTILE });
    expect(r.success && r.data.subject).toBeNull();
  });
  it("keeps a listed subject", () => {
    const r = ContactSchema.safeParse({ ...base, subject: CORPORATE_SUBJECT });
    expect(r.success && r.data.subject).toBe(CORPORATE_SUBJECT);
  });
});

describe("staff emails never carry a multi-line visitor subject or name", () => {
  it("alert subject is one line", () => {
    const e = buildAlertEmail({ id: "x", name: "Eve\nBcc: x@y.z", subject: HOSTILE, kind: "general", createdAt: "2026-09-24T01:00:00Z", messageUrl: "https://drmed.ph/staff/messages/x" } as never);
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.subject.length).toBeLessThanOrEqual(120);
  });
  it("reply subject is one line", () => {
    const e = buildEmailReply({ firstName: firstNameOf("Eve"), subject: HOSTILE, staffText: "Thanks!" } as never);
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.subject.length).toBeLessThanOrEqual(90);
  });
  it("first name drops control characters and is capped", () => {
    expect(firstNameOf("\u0007Eve\u0007 Smith")).toBe("Eve");
    expect(firstNameOf("a".repeat(100)).length).toBe(40);
  });
});

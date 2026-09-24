import { describe, expect, it } from "vitest";
import { buildAlertEmail } from "./alert-content";

describe("buildAlertEmail", () => {
  const base = {
    name: "Juan dela Cruz",
    subject: "Laboratory Tests",
    kind: "general" as const,
    createdAt: "2026-09-24T05:00:00.000Z",
    messageUrl: "https://drmed.ph/staff/messages/abc-123",
  };

  it("greets by first name only and links to the message", () => {
    const email = buildAlertEmail(base);
    expect(email.text).toContain("Juan");
    expect(email.text).not.toContain("dela Cruz");
    expect(email.text).toContain(base.messageUrl);
    expect(email.html).toContain(base.messageUrl);
  });

  it("prefixes the subject for a corporate lead", () => {
    const email = buildAlertEmail({ ...base, kind: "corporate" });
    expect(email.subject.startsWith("[Corporate lead] ")).toBe(true);
    expect(email.text).toContain("Corporate / HMO lead");
  });

  it("falls back to General when no subject was picked", () => {
    const email = buildAlertEmail({ ...base, subject: null });
    expect(email.subject).toContain("General");
    expect(email.text).toContain("Subject: General");
  });

  it("never mentions message contents, phone or email — only name/subject/time/link", () => {
    // The function has no field for message/phone/email at all, but pin the
    // guarantee with a concrete fixture so a future refactor that adds one
    // has to touch this test. Banned terms stand in for a SENDER's contact
    // details/message text — not the clinic's own footer phone/email, which
    // the branded shell always includes and is expected to appear.
    const email = buildAlertEmail(base);
    const banned = ["0917 555 1234", "juan@personalmail.com", "please help me", "urgent request"];
    for (const term of banned) {
      expect(email.text.toLowerCase()).not.toContain(term.toLowerCase());
      expect(email.html.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
});

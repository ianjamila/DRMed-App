import { describe, it, expect } from "vitest";
import { buildReminderEmail } from "./reminder-email";

const base = {
  greeting: "Maria",
  serviceName: "Complete Blood Count",
  when: "June 18, 2026 at 9:00 AM",
  cancelUrl: "https://drmed.ph/appointments/cancel/abc",
  hasForm: false,
};

describe("buildReminderEmail", () => {
  it("subject names the service and time", () => {
    expect(buildReminderEmail(base).subject).toBe(
      "Reminder — Complete Blood Count tomorrow, June 18, 2026 at 9:00 AM",
    );
  });

  it("omits the form line when hasForm is false but keeps greeting + cancel link", () => {
    const { text } = buildReminderEmail(base);
    expect(text).not.toContain("request form on file");
    expect(text).toContain("Maria");
    expect(text).toContain("https://drmed.ph/appointments/cancel/abc");
  });

  it("includes the form-on-file line when hasForm is true", () => {
    expect(buildReminderEmail({ ...base, hasForm: true }).text).toContain(
      "request form on file",
    );
  });
});

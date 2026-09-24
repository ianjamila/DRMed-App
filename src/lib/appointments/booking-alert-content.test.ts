import { describe, it, expect } from "vitest";
import { buildBookingAlertEmail, bookingServicesLabel, bookingWhenLabel } from "./booking-alert-content";

const base = {
  firstName: "Maria Clara Santos",
  branch: "lab_request" as const,
  scheduledAtIso: "2026-09-25T01:30:00.000Z", // 9:30 AM Manila
  pendingCallback: false,
  serviceCount: 2,
  via: "website" as const,
  appointmentsUrl: "https://drmed.ph/staff/appointments",
};

describe("buildBookingAlertEmail", () => {
  it("names only the first name, the type, the Manila time and a count", () => {
    const e = buildBookingAlertEmail(base);
    expect(e.subject).toBe("New online booking: Lab request — Sep 25, 2026, 9:30 AM");
    expect(e.text).toContain("Maria booked online.");
    expect(e.text).toContain("Services: 2 services");
    expect(e.text).toContain("Booked through: Website (Schedule page)");
    expect(e.text).not.toContain("Santos");
    expect(e.html).toContain("https://drmed.ph/staff/appointments");
  });

  it("flags a booking that needs a call back in the subject", () => {
    const e = buildBookingAlertEmail({ ...base, branch: "home_service", scheduledAtIso: null, pendingCallback: true });
    expect(e.subject).toBe("[Call back] New online booking: Home service");
    expect(e.text).toContain("waiting for a call back");
    expect(e.text).toContain("When: Needs a call back to set a time");
  });

  it("says a portal booking came from the portal", () => {
    expect(buildBookingAlertEmail({ ...base, via: "portal" }).text).toContain("Booked through: Patient portal");
  });

  it("escapes a hostile first name in the HTML and keeps the subject one line", () => {
    const e = buildBookingAlertEmail({ ...base, firstName: "<script>x</script>\nBcc:" });
    expect(e.html).not.toContain("<script>x</script>");
    expect(e.subject).not.toMatch(/[\r\n]/);
  });

  // The input type has no phone/email/service-name field; this pins that the
  // output never grows one by accident.
  it("contains no contact details or service names", () => {
    const e = buildBookingAlertEmail(base);
    for (const part of [e.subject, e.text, e.html]) {
      expect(part).not.toMatch(/@example|09\d{9}|CBC|Lipid/i);
    }
  });
});

describe("labels", () => {
  it("walk-in when there is no slot and no call back", () => {
    expect(bookingWhenLabel({ scheduledAtIso: null, pendingCallback: false })).toBe(
      "No fixed time — walk in during clinic hours",
    );
  });
  it("a form-only lab request", () => {
    expect(bookingServicesLabel(0)).toBe("Tests from an uploaded request form");
    expect(bookingServicesLabel(1)).toBe("1 service");
  });
});

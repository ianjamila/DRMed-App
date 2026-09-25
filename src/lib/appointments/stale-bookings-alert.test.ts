import { describe, expect, it } from "vitest";
import { STALE_ALERT_MAX_LINES, buildStaleBookingsAlertEmail } from "./stale-bookings-alert";

const URL_ = "https://drmed.ph/staff/appointments#no-set-time";

describe("buildStaleBookingsAlertEmail", () => {
  it("lists each booking by first name and age, flagging likely no-shows", () => {
    const out = buildStaleBookingsAlertEmail({
      bookings: [
        { firstName: "Maria Clara", ageDays: 12, likelyNoShow: true },
        { firstName: null, ageDays: 4, likelyNoShow: false },
      ],
      appointmentsUrl: URL_,
    });
    expect(out.subject).toBe("DRMed: 2 bookings not acted on (1 likely no-show)");
    expect(out.text).toContain("- Maria — likely no-show: Booked 12 days ago");
    expect(out.text).toContain("- A patient: Booked 4 days ago");
    expect(out.text).toContain("1 of them is 7 days or older");
    expect(out.html).toContain("Maria — likely no-show");
    expect(out.html).not.toContain("Clara");
    expect(out.html).toContain(URL_);
  });

  it("drops the likely-no-show sentence when there are none", () => {
    const out = buildStaleBookingsAlertEmail({
      bookings: [{ firstName: "Ana", ageDays: 3, likelyNoShow: false }],
      appointmentsUrl: URL_,
    });
    expect(out.subject).toBe("DRMed: 1 booking not acted on");
    expect(out.text).toContain("1 booking with no set time has waited 3 days or more");
    expect(out.text).not.toContain("likely no-show");
  });

  it("caps the list and counts the rest", () => {
    const bookings = Array.from({ length: STALE_ALERT_MAX_LINES + 5 }, (_, i) => ({
      firstName: `P${i}`,
      ageDays: 10,
      likelyNoShow: true,
    }));
    const out = buildStaleBookingsAlertEmail({ bookings, appointmentsUrl: URL_ });
    expect(out.text).toContain("…and 5 more.");
    expect(out.text).not.toContain(`P${STALE_ALERT_MAX_LINES}:`);
    expect(out.html).toContain("…and 5 more on the Appointments page.");
  });

  it("escapes a name typed by a website visitor", () => {
    const out = buildStaleBookingsAlertEmail({
      bookings: [{ firstName: "<b>x</b>", ageDays: 5, likelyNoShow: false }],
      appointmentsUrl: URL_,
    });
    expect(out.html).not.toContain("<b>x</b>");
    expect(out.html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

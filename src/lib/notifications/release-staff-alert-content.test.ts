import { describe, expect, it } from "vitest";
import { buildReleaseAlertEmail, patientShortName } from "./release-staff-alert-content";

const base = {
  firstName: "Ian",
  lastName: "Jamila",
  visitNumber: "0044",
  count: 3,
  visitUrl: "https://drmed.ph/staff/visits/v1",
};

describe("release staff alert email", () => {
  it("shortens the name to first name + last initial", () => {
    expect(patientShortName("Ian", "Jamila")).toBe("Ian J.");
    expect(patientShortName("Ian", null)).toBe("Ian");
    expect(patientShortName(null, "Jamila")).toBe("A patient");
  });
  it("says how many results, for whom, on which visit", () => {
    const e = buildReleaseAlertEmail(base);
    expect(e.subject).toBe("3 results released for Ian J. — visit #0044");
    expect(e.text).toContain("https://drmed.ph/staff/visits/v1");
    expect(buildReleaseAlertEmail({ ...base, count: 1 }).subject).toBe("1 result released for Ian J. — visit #0044");
  });
  it("never carries the full surname, test names or contact details", () => {
    const e = buildReleaseAlertEmail(base);
    for (const part of [e.subject, e.text, e.html]) expect(part).not.toContain("Jamila");
    // The input type has no test-name / phone / email fields — structural rule.
  });
  it("escapes a hostile first name in the HTML and keeps the subject one line", () => {
    const e = buildReleaseAlertEmail({ ...base, firstName: "<b>x</b>\nBcc: y" });
    expect(e.html).not.toContain("<b>x</b>");
    expect(e.subject).not.toMatch(/[\r\n]/);
  });
  it("says why the recipient gets it and where to change it", () => {
    expect(buildReleaseAlertEmail(base).text).toContain("Admin Tools › Email Alerts");
  });
  it("links the button to the visit page", () => {
    expect(buildReleaseAlertEmail(base).html).toContain("https://drmed.ph/staff/visits/v1");
  });
});

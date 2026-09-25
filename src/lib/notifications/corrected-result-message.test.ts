import { describe, expect, it } from "vitest";
import { buildCorrectedResultMessages } from "./corrected-result-message";

describe("buildCorrectedResultMessages", () => {
  const m = buildCorrectedResultMessages({ firstName: "Ana", testName: "Chemistry", portalUrl: "https://drmed.ph/portal" });
  it("tells the patient an updated copy is ready, in the portal", () => {
    expect(m.sms).toContain("updated copy of your Chemistry result");
    expect(m.sms).toContain("https://drmed.ph/portal");
    expect(m.emailSubject).toBe("An updated copy of your DRMed result is ready");
    expect(m.emailHtml).toContain("Chemistry");
  });
  it("never carries a reason, a value or the word amended", () => {
    for (const text of [m.sms, m.emailHtml]) {
      expect(text).not.toMatch(/reason|amend|error|mmol|mg\/dL/i);
    }
  });
  it("escapes the test name in HTML", () => {
    const x = buildCorrectedResultMessages({ firstName: "A", testName: "<b>X</b>", portalUrl: "u" });
    expect(x.emailHtml).not.toContain("<b>X</b>");
  });
});

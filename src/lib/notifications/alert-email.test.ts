import { describe, expect, it } from "vitest";
import { isValidAlertEmail } from "./alert-email";

describe("isValidAlertEmail — mirrors 0155's staff_alert_recipients_email_shape CHECK", () => {
  it("accepts ordinary addresses", () => {
    expect(isValidAlertEmail("front@clinic.ph")).toBe(true);
    expect(isValidAlertEmail("inbox+alerts@drmed.ph")).toBe(true);
    expect(isValidAlertEmail("  a@b.co  ")).toBe(true); // trims before checking, like .trim() would before insert
  });

  it("rejects addresses with no @ or no dot in the domain", () => {
    expect(isValidAlertEmail("not-an-email")).toBe(false);
    expect(isValidAlertEmail("missing-domain@")).toBe(false);
    expect(isValidAlertEmail("no-tld@clinic")).toBe(false);
  });

  it("rejects whitespace inside either half", () => {
    expect(isValidAlertEmail("front desk@clinic.ph")).toBe(false);
    expect(isValidAlertEmail("front@clinic .ph")).toBe(false);
  });

  it("enforces the 6..254 char_length bound", () => {
    expect(isValidAlertEmail("a@b.c")).toBe(false); // 5 chars, below the 6 minimum
    expect(isValidAlertEmail("ab@b.co")).toBe(true); // 7 chars, at/above minimum
    const tooLong = `${"a".repeat(250)}@b.co`; // 255 chars, over the 254 maximum
    expect(isValidAlertEmail(tooLong)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidAlertEmail("")).toBe(false);
    expect(isValidAlertEmail("   ")).toBe(false);
  });
});

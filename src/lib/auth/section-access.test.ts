import { describe, expect, it } from "vitest";
import { isSectionAllowed } from "./section-access";
import { ALL_SECTIONS, type ServiceSection } from "./role-sections";

const MEDTECH_SECTIONS: ServiceSection[] = [
  "chemistry",
  "hematology",
  "immunology",
  "urinalysis",
  "microbiology",
  "send_out",
];

describe("isSectionAllowed", () => {
  it("allows everything when allowedSections is null (admin/pathologist)", () => {
    for (const section of [...ALL_SECTIONS, null, undefined, "bogus"]) {
      expect(isSectionAllowed(null, section)).toBe(true);
    }
  });

  it("denies everything when allowedSections is [] (reception) — including a null section", () => {
    expect(isSectionAllowed([], "chemistry")).toBe(false);
    expect(isSectionAllowed([], null)).toBe(false);
    expect(isSectionAllowed([], undefined)).toBe(false);
  });

  it("allows a section that is a member of the allowed list", () => {
    expect(isSectionAllowed(MEDTECH_SECTIONS, "chemistry")).toBe(true);
    expect(isSectionAllowed(MEDTECH_SECTIONS, "send_out")).toBe(true);
  });

  it("denies a section outside the allowed list", () => {
    expect(isSectionAllowed(MEDTECH_SECTIONS, "imaging_xray")).toBe(false);
  });

  it("denies a null/undefined section even when the list is non-empty", () => {
    expect(isSectionAllowed(MEDTECH_SECTIONS, null)).toBe(false);
    expect(isSectionAllowed(MEDTECH_SECTIONS, undefined)).toBe(false);
  });

  it("denies a resolvable but foreign section for xray_technician", () => {
    const XRAY_SECTIONS: ServiceSection[] = [
      "imaging_xray",
      "imaging_ultrasound",
      "imaging_ecg",
    ];
    expect(isSectionAllowed(XRAY_SECTIONS, "imaging_xray")).toBe(true);
    expect(isSectionAllowed(XRAY_SECTIONS, "chemistry")).toBe(false);
  });
});

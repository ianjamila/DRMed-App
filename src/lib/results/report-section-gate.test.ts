import { describe, expect, it } from "vitest";
import { membersWithinSections } from "./report-section-gate";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { canViewResultPdf } from "@/lib/visits/line-visibility";

describe("membersWithinSections — the every-member rule for a shared PDF", () => {
  const medtech = sectionsForRole("medtech");

  it("lets an unrestricted role (admin, pathologist) open any file", () => {
    expect(membersWithinSections(sectionsForRole("admin"), ["chemistry", "imaging_xray", null])).toBe(true);
    expect(membersWithinSections(null, [])).toBe(true);
  });

  it("needs EVERY member inside a lab role's sections", () => {
    expect(membersWithinSections(medtech, ["chemistry", "chemistry"])).toBe(true);
    expect(membersWithinSections(medtech, ["chemistry", "imaging_xray"])).toBe(false);
  });

  it("treats a NULL section as outside every list (SQL mirror)", () => {
    expect(membersWithinSections(medtech, ["chemistry", null])).toBe(false);
  });

  it("fails closed when no members were read back", () => {
    expect(membersWithinSections(medtech, [])).toBe(false);
  });

  it("denies a role with no lab sections", () => {
    expect(membersWithinSections(sectionsForRole("reception"), ["chemistry"])).toBe(false);
  });
});

describe("canViewResultPdf with memberSections", () => {
  const chemLine = { section: "chemistry", status: "ready_for_release", kind: "lab_test", reportReleased: false };

  it("keeps the old answer when no member list is passed", () => {
    expect(canViewResultPdf("medtech", chemLine)).toBe(true);
  });

  it("refuses a lab role a shared report with a member outside its sections", () => {
    expect(canViewResultPdf("medtech", { ...chemLine, memberSections: ["chemistry", "imaging_xray"] })).toBe(false);
    expect(canViewResultPdf("xray_technician", { ...chemLine, section: "imaging_xray", memberSections: ["imaging_xray", "chemistry"] })).toBe(false);
  });

  it("allows the lab role when it covers every member, at any finished or unfinished status", () => {
    expect(canViewResultPdf("medtech", { ...chemLine, memberSections: ["chemistry", "chemistry"] })).toBe(true);
    expect(canViewResultPdf("medtech", { ...chemLine, status: "in_progress", memberSections: ["chemistry"] })).toBe(true);
  });

  it("leaves reception's #221 rule alone: released lines of fully released files, any sections", () => {
    const released = { ...chemLine, status: "released", reportReleased: true, memberSections: ["chemistry", "imaging_xray"] };
    expect(canViewResultPdf("reception", released)).toBe(true);
    expect(canViewResultPdf("reception", { ...released, reportReleased: false })).toBe(false);
  });

  it("admin and pathologist are never narrowed", () => {
    expect(canViewResultPdf("admin", { ...chemLine, memberSections: ["chemistry", null] })).toBe(true);
    expect(canViewResultPdf("pathologist", { ...chemLine, memberSections: [] })).toBe(true);
  });
});

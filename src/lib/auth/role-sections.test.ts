import { describe, expect, it } from "vitest";
import { ALL_SECTIONS, sectionsForRole } from "./role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";

const ROLES = [
  "reception",
  "medtech",
  "xray_technician",
  "pathologist",
  "admin",
] as const;

describe("sectionsForRole", () => {
  it("denies reception outright — [] is 'no access', never 'no filter'", () => {
    expect(sectionsForRole("reception")).toEqual([]);
  });

  it("is unrestricted (null) for admin and pathologist only", () => {
    expect(sectionsForRole("admin")).toBeNull();
    expect(sectionsForRole("pathologist")).toBeNull();
    expect(sectionsForRole("medtech")).not.toBeNull();
    expect(sectionsForRole("xray_technician")).not.toBeNull();
  });

  it("splits the bench: medtech gets the lab sections, xray gets imaging, no overlap", () => {
    const medtech = sectionsForRole("medtech") ?? [];
    const xray = sectionsForRole("xray_technician") ?? [];
    expect(medtech).toEqual([
      "chemistry",
      "hematology",
      "immunology",
      "urinalysis",
      "microbiology",
      "send_out",
    ]);
    expect(xray).toEqual(["imaging_xray", "imaging_ultrasound", "imaging_ecg"]);
    expect(medtech.filter((s) => xray.includes(s))).toEqual([]);
  });

  it("never hands a doctor section to a restricted role", () => {
    for (const role of ["medtech", "xray_technician", "reception"] as const) {
      const list = sectionsForRole(role) ?? [];
      expect(list).not.toContain("consultation");
      expect(list).not.toContain("procedure");
    }
  });

  it("only lists sections that exist", () => {
    for (const role of ROLES) {
      for (const s of sectionsForRole(role) ?? []) {
        expect(ALL_SECTIONS).toContain(s);
      }
    }
  });
});

// The invariant releaseTestAction / markDoctorLineDoneAction rely on: doctor
// lines carry section = NULL in the DB, and a null-section row survives
// scoping only under an unrestricted (null) list.
describe("doctor lines (section null) through scopeToAllowedSections", () => {
  const doctorLine = {
    id: "consult-1",
    services: { section: null, name: "Consultation" },
  };

  it.each(ROLES)("%s", (role) => {
    const passes =
      scopeToAllowedSections([doctorLine], sectionsForRole(role)).length === 1;
    expect(passes).toBe(role === "admin" || role === "pathologist");
  });

  it("a chemistry line passes for medtech, admin, pathologist and nobody else", () => {
    const chem = { id: "fbs-1", services: { section: "chemistry", name: "FBS" } };
    const passing = ROLES.filter(
      (role) => scopeToAllowedSections([chem], sectionsForRole(role)).length === 1,
    );
    expect(passing).toEqual(["medtech", "pathologist", "admin"]);
  });
});

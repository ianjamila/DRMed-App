import { describe, expect, it } from "vitest";
import {
  ALL_SECTIONS,
  DOCTOR_SECTIONS,
  LAB_SECTIONS,
  canClaimSection,
  claimOwnerRole,
  queueTitleForRole,
  sectionsForRole,
} from "./role-sections";
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

describe("LAB_SECTIONS", () => {
  it("is ALL_SECTIONS minus the doctor sections, order preserved", () => {
    expect(LAB_SECTIONS).toEqual(
      ALL_SECTIONS.filter((s) => s !== "consultation" && s !== "procedure"),
    );
  });

  it("holds no doctor section", () => {
    for (const d of DOCTOR_SECTIONS) expect(LAB_SECTIONS).not.toContain(d);
  });

  it("partitions ALL_SECTIONS exactly — nothing dropped, nothing double-counted", () => {
    expect(LAB_SECTIONS.length + DOCTOR_SECTIONS.length).toBe(ALL_SECTIONS.length);
    expect(new Set([...LAB_SECTIONS, ...DOCTOR_SECTIONS])).toEqual(
      new Set(ALL_SECTIONS),
    );
  });

  it("keeps every non-doctor section, including ones a reader might mistake for doctor work", () => {
    // vaccine and home_service are lab-side kinds (classifyKind buckets them
    // as lab), so their sections belong to the lab report.
    expect(LAB_SECTIONS).toContain("vaccine");
    expect(LAB_SECTIONS).toContain("home_service");
    expect(LAB_SECTIONS).toContain("package");
  });

  it("names each doctor section, and only ones ALL_SECTIONS actually knows", () => {
    expect([...DOCTOR_SECTIONS]).toEqual(["consultation", "procedure"]);
    for (const d of DOCTOR_SECTIONS) expect(ALL_SECTIONS).toContain(d);
  });
});

describe("canClaimSection — x-ray belongs to the x-ray technician", () => {
  it("lets only xray_technician claim imaging_xray, even over unrestricted roles", () => {
    expect(canClaimSection("xray_technician", "imaging_xray")).toBe(true);
    expect(canClaimSection("admin", "imaging_xray")).toBe(false);
    expect(canClaimSection("pathologist", "imaging_xray")).toBe(false);
    expect(canClaimSection("medtech", "imaging_xray")).toBe(false);
    expect(canClaimSection("reception", "imaging_xray")).toBe(false);
  });

  it("leaves every other section on the plain role-scope rule", () => {
    for (const role of ROLES) {
      const allowed = sectionsForRole(role);
      for (const section of ALL_SECTIONS) {
        if (section === "imaging_xray") continue;
        const expected = allowed === null ? true : allowed.includes(section);
        expect(canClaimSection(role, section), `${role} / ${section}`).toBe(expected);
      }
    }
  });

  it("keeps ultrasound and ECG claimable by admin/pathologist (only x-ray was restricted)", () => {
    expect(claimOwnerRole("imaging_ultrasound")).toBeNull();
    expect(claimOwnerRole("imaging_ecg")).toBeNull();
    expect(canClaimSection("admin", "imaging_ultrasound")).toBe(true);
  });

  it("treats a null section as unrestricted-only, same as scopeToAllowedSections", () => {
    expect(canClaimSection("admin", null)).toBe(true);
    expect(canClaimSection("medtech", null)).toBe(false);
    expect(canClaimSection("reception", null)).toBe(false);
  });
});

describe("queueTitleForRole", () => {
  it("names the queue after what each role does there", () => {
    expect(queueTitleForRole("xray_technician")).toBe("Imaging queue");
    expect(queueTitleForRole("medtech")).toBe("Lab queue");
    expect(queueTitleForRole("admin")).toBe("Queue");
    expect(queueTitleForRole("pathologist")).toBe("Queue");
  });

  it("titles reception's view Released results — it only prints released work", () => {
    expect(queueTitleForRole("reception")).toBe("Released results");
  });
});

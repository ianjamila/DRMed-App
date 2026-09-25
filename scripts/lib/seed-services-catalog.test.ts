import { describe, expect, it } from "vitest";
import { ALL_SECTIONS, DOCTOR_SECTIONS, LAB_SECTIONS } from "../../src/lib/auth/role-sections";
import { SEED_SERVICES } from "./seed-services-catalog";

// A seeded service with no section is outside every role's list, so the local
// stack could not claim it (Urinalysis, 2026-09-25). Pin the catalog to the
// sections production uses.
describe("seed-services catalog", () => {
  it("gives every lab test a lab section", () => {
    for (const s of SEED_SERVICES.filter((x) => x.kind === "lab_test")) {
      expect(LAB_SECTIONS, s.code).toContain(s.section);
    }
  });

  it("files packages under the package section", () => {
    for (const s of SEED_SERVICES.filter((x) => x.kind === "lab_package")) {
      expect(s.section, s.code).toBe("package");
    }
  });

  it("files every doctor consultation under a doctor section, except the generic CONSULT anchor (NULL on prod)", () => {
    for (const s of SEED_SERVICES.filter((x) => x.kind === "doctor_consultation")) {
      if (s.code === "CONSULT") expect(s.section).toBeNull();
      else expect(DOCTOR_SECTIONS, s.code).toContain(s.section);
    }
  });

  it("uses only sections the services_section_check constraint allows, never an empty string", () => {
    for (const s of SEED_SERVICES) {
      if (s.section !== null) expect(ALL_SECTIONS, s.code).toContain(s.section);
    }
  });

  it("has unique codes (the upsert conflict key)", () => {
    const codes = SEED_SERVICES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("matches production for the codes medtechs claim", () => {
    const by = new Map(SEED_SERVICES.map((s) => [s.code, s.section]));
    expect(by.get("URINALYSIS")).toBe("urinalysis");
    expect(by.get("CBC")).toBe("hematology");
    expect(by.get("FBS")).toBe("chemistry");
    expect(by.get("XRAYCHEST")).toBe("imaging_xray");
  });
});

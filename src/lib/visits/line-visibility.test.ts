import { describe, expect, it } from "vitest";
import type { StaffSession } from "@/lib/auth/require-staff";
import {
  canActOnResult,
  canSeeLine,
  canViewResultPdf,
  roleCanActOnResults,
} from "./line-visibility";

const ROLES: readonly StaffSession["role"][] = [
  "reception",
  "medtech",
  "xray_technician",
  "pathologist",
  "admin",
];

const MEDTECH_SECTIONS = [
  "chemistry",
  "hematology",
  "immunology",
  "urinalysis",
  "microbiology",
  "send_out",
];
const XRAY_SECTIONS = ["imaging_xray", "imaging_ultrasound", "imaging_ecg"];
const SOME_OTHER_SECTION = "package";

describe("canSeeLine", () => {
  it("lets reception see every section — the counter enters and collects every line", () => {
    for (const section of [
      ...MEDTECH_SECTIONS,
      ...XRAY_SECTIONS,
      "consultation",
      "procedure",
      null,
      undefined,
    ]) {
      expect(canSeeLine("reception", section)).toBe(true);
    }
  });

  it("lets admin and pathologist see everything", () => {
    for (const role of ["admin", "pathologist"] as const) {
      for (const section of [...MEDTECH_SECTIONS, ...XRAY_SECTIONS, null]) {
        expect(canSeeLine(role, section)).toBe(true);
      }
    }
  });

  it("limits medtech to its own sections and denies imaging", () => {
    for (const section of MEDTECH_SECTIONS) {
      expect(canSeeLine("medtech", section)).toBe(true);
    }
    for (const section of XRAY_SECTIONS) {
      expect(canSeeLine("medtech", section)).toBe(false);
    }
  });

  it("limits xray_technician to its own sections and denies lab-bench sections", () => {
    for (const section of XRAY_SECTIONS) {
      expect(canSeeLine("xray_technician", section)).toBe(true);
    }
    for (const section of MEDTECH_SECTIONS) {
      expect(canSeeLine("xray_technician", section)).toBe(false);
    }
  });

  it("denies a null/unknown section for a restricted lab role", () => {
    expect(canSeeLine("medtech", null)).toBe(false);
    expect(canSeeLine("xray_technician", undefined)).toBe(false);
  });
});

describe("canActOnResult — unchanged A4 semantics", () => {
  it("denies reception on every section — [] is a deny, never 'no filter'", () => {
    for (const section of [
      ...MEDTECH_SECTIONS,
      ...XRAY_SECTIONS,
      SOME_OTHER_SECTION,
      null,
      undefined,
    ]) {
      expect(canActOnResult("reception", section)).toBe(false);
    }
  });

  it("lets admin and pathologist act everywhere", () => {
    for (const role of ["admin", "pathologist"] as const) {
      for (const section of [...MEDTECH_SECTIONS, ...XRAY_SECTIONS, null]) {
        expect(canActOnResult(role, section)).toBe(true);
      }
    }
  });

  it("lets medtech act only on its own sections, never imaging", () => {
    for (const section of MEDTECH_SECTIONS) {
      expect(canActOnResult("medtech", section)).toBe(true);
    }
    for (const section of XRAY_SECTIONS) {
      expect(canActOnResult("medtech", section)).toBe(false);
    }
  });

  it("lets xray_technician act only on its own sections, never the lab bench", () => {
    for (const section of XRAY_SECTIONS) {
      expect(canActOnResult("xray_technician", section)).toBe(true);
    }
    for (const section of MEDTECH_SECTIONS) {
      expect(canActOnResult("xray_technician", section)).toBe(false);
    }
  });

  it("never lets a null/unknown section be actable by a restricted role", () => {
    expect(canActOnResult("medtech", null)).toBe(false);
    expect(canActOnResult("xray_technician", undefined)).toBe(false);
    expect(canActOnResult("reception", null)).toBe(false);
  });
});

describe("roleCanActOnResults — page-level (non per-row) gate", () => {
  it("is false only for reception", () => {
    for (const role of ROLES) {
      expect(roleCanActOnResults(role)).toBe(role !== "reception");
    }
  });
});

describe("see vs act — every role, every section, the split holds", () => {
  it("reception always sees, never acts", () => {
    for (const section of [...MEDTECH_SECTIONS, ...XRAY_SECTIONS, null]) {
      expect(canSeeLine("reception", section)).toBe(true);
      expect(canActOnResult("reception", section)).toBe(false);
    }
  });

  it("admin and pathologist see and act identically everywhere", () => {
    for (const role of ["admin", "pathologist"] as const) {
      for (const section of [...MEDTECH_SECTIONS, ...XRAY_SECTIONS, null]) {
        expect(canSeeLine(role, section)).toBe(canActOnResult(role, section));
        expect(canSeeLine(role, section)).toBe(true);
      }
    }
  });

  it("medtech and xray_technician see and act identically on their own sections (both true) and off-section (both false)", () => {
    for (const section of MEDTECH_SECTIONS) {
      expect(canSeeLine("medtech", section)).toBe(true);
      expect(canActOnResult("medtech", section)).toBe(true);
      expect(canSeeLine("xray_technician", section)).toBe(false);
      expect(canActOnResult("xray_technician", section)).toBe(false);
    }
    for (const section of XRAY_SECTIONS) {
      expect(canSeeLine("xray_technician", section)).toBe(true);
      expect(canActOnResult("xray_technician", section)).toBe(true);
      expect(canSeeLine("medtech", section)).toBe(false);
      expect(canActOnResult("medtech", section)).toBe(false);
    }
  });
});

// A package HEADER's own services.section is the literal "package" — verified
// against production on 2026-09-15, where every `is_package_header` line
// carries that section and no other. "package" is in no role's allowed-section
// list, so neither predicate may ever be applied to a header directly: a
// header's visibility and its actionability both come from its COMPONENTS
// (`visibleParents` / `actionableParents` in visits/[id]/page.tsx). Gating a
// header on its own section would silently strip bulk package release from
// medtech and xray_technician even for a package made entirely of their own
// bench's work.
describe("the package-header section is a deny for every bench role", () => {
  it("is not see-able or act-able by medtech or xray_technician", () => {
    for (const role of ["medtech", "xray_technician"] as const) {
      expect(canSeeLine(role, "package")).toBe(false);
      expect(canActOnResult(role, "package")).toBe(false);
    }
  });

  it("is still see-able by reception, admin and pathologist", () => {
    for (const role of ["reception", "admin", "pathologist"] as const) {
      expect(canSeeLine(role, "package")).toBe(true);
    }
  });
});

describe("canViewResultPdf", () => {
  const STATUSES = ["requested", "in_progress", "result_uploaded", "ready_for_release", "released", "cancelled"];

  it("lets reception open a RELEASED lab or imaging result, so the counter can print it", () => {
    for (const section of [...MEDTECH_SECTIONS, ...XRAY_SECTIONS]) {
      expect(canViewResultPdf("reception", { section, status: "released", kind: "lab_test", reportReleased: true })).toBe(true);
    }
  });

  it("keeps reception out of every result that has not been released", () => {
    for (const status of STATUSES.filter((s) => s !== "released")) {
      for (const section of [...MEDTECH_SECTIONS, ...XRAY_SECTIONS]) {
        expect(canViewResultPdf("reception", { section, status, kind: "lab_test", reportReleased: true })).toBe(false);
      }
    }
  });

  it("never opens a doctor line for reception — a consultation has no result file", () => {
    for (const kind of ["doctor_consultation", "doctor_procedure"]) {
      expect(canViewResultPdf("reception", { section: null, status: "released", kind, reportReleased: true })).toBe(false);
    }
    // An unknown kind is not proof of a lab line.
    expect(canViewResultPdf("reception", { section: "chemistry", status: "released", kind: null, reportReleased: true })).toBe(false);
  });

  it("keeps reception out of a shared report while ANY test on it is unreleased", () => {
    // FBS released, Creatinine on the same consolidated PDF still pending or
    // withdrawn: printing FBS would print Creatinine's values too.
    expect(
      canViewResultPdf("reception", { section: "chemistry", status: "released", kind: "lab_test", reportReleased: false }),
    ).toBe(false);
  });

  it("leaves every lab role exactly where canActOnResult puts it, at every status", () => {
    for (const role of ROLES.filter((r) => r !== "reception")) {
      for (const section of [...MEDTECH_SECTIONS, ...XRAY_SECTIONS, SOME_OTHER_SECTION, null]) {
        for (const status of STATUSES) {
          for (const reportReleased of [true, false]) {
            expect(canViewResultPdf(role, { section, status, kind: "lab_test", reportReleased })).toBe(
              canActOnResult(role, section),
            );
          }
        }
      }
    }
  });
});

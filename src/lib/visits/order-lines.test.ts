import { describe, it, expect } from "vitest";
import { isDoctorKind, partitionByCategory, shouldSplit } from "./order-lines";

const line = (id: string, kind: string) => ({ id, kind });

describe("isDoctorKind", () => {
  it("classifies doctor kinds", () => {
    expect(isDoctorKind("doctor_consultation")).toBe(true);
    expect(isDoctorKind("doctor_procedure")).toBe(true);
  });
  it("treats everything else as non-doctor", () => {
    expect(isDoctorKind("lab_test")).toBe(false);
    expect(isDoctorKind("lab_package")).toBe(false);
    expect(isDoctorKind("home_service")).toBe(false);
    expect(isDoctorKind("vaccine")).toBe(false);
  });
});

describe("partitionByCategory", () => {
  it("splits lines into doctor and lab buckets, preserving order", () => {
    const lines = [
      line("a", "lab_test"),
      line("b", "doctor_consultation"),
      line("c", "lab_package"),
      line("d", "doctor_procedure"),
    ];
    const { doctor, lab } = partitionByCategory(lines, (l) => l.kind);
    expect(doctor.map((l) => l.id)).toEqual(["b", "d"]);
    expect(lab.map((l) => l.id)).toEqual(["a", "c"]);
  });
});

describe("shouldSplit", () => {
  it("is true only when both buckets are non-empty", () => {
    expect(shouldSplit([line("a", "lab_test"), line("b", "doctor_consultation")], (l) => l.kind)).toBe(true);
  });
  it("is false for doctor-only", () => {
    expect(shouldSplit([line("b", "doctor_consultation")], (l) => l.kind)).toBe(false);
  });
  it("is false for lab-only", () => {
    expect(shouldSplit([line("a", "lab_test")], (l) => l.kind)).toBe(false);
  });
  it("is false for an empty order", () => {
    expect(shouldSplit<{ id: string; kind: string }>([], (l) => l.kind)).toBe(false);
  });
});

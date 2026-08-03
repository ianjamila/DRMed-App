import { describe, it, expect } from "vitest";
import {
  defaultClinicFee,
  doctorLineBase,
  splitDoctorFee,
} from "./consultation-fee";

describe("defaultClinicFee", () => {
  it("is 100 for pf_split (and unknown)", () => {
    expect(defaultClinicFee("pf_split")).toBe(100);
    expect(defaultClinicFee(undefined)).toBe(100);
  });
  it("is 0 for rent_paying and shareholder", () => {
    expect(defaultClinicFee("rent_paying")).toBe(0);
    expect(defaultClinicFee("shareholder")).toBe(0);
  });

  it("a per-doctor override wins over the arrangement default", () => {
    expect(defaultClinicFee("pf_split", 250)).toBe(250);
    expect(defaultClinicFee("rent_paying", 50)).toBe(50);
    expect(defaultClinicFee("pf_split", 0)).toBe(0);
  });
  it("falls back to the arrangement default when the override is null/undefined", () => {
    expect(defaultClinicFee("pf_split", null)).toBe(100);
    expect(defaultClinicFee("pf_split", undefined)).toBe(100);
    expect(defaultClinicFee("rent_paying", null)).toBe(0);
  });
  it("ignores a negative or NaN override and falls back to the arrangement default", () => {
    expect(defaultClinicFee("pf_split", -5)).toBe(100);
    expect(defaultClinicFee("pf_split", NaN)).toBe(100);
    expect(defaultClinicFee("rent_paying", -1)).toBe(0);
  });
});

describe("doctorLineBase", () => {
  it("uses the counter-typed fee for a consultation", () => {
    expect(
      doctorLineBase({ kind: "doctor_consultation", typedRaw: "800", catalogPrice: 0 }),
    ).toBe(800);
  });
  it("bills a blank consultation at ₱0 (the action then rejects it)", () => {
    expect(
      doctorLineBase({ kind: "doctor_consultation", typedRaw: "", catalogPrice: 500 }),
    ).toBe(0);
  });
  it("uses the counter-typed fee for a procedure", () => {
    expect(
      doctorLineBase({ kind: "doctor_procedure", typedRaw: "2500", catalogPrice: 1800 }),
    ).toBe(2500);
  });
  it("falls back to the catalog price for a blank procedure fee", () => {
    expect(
      doctorLineBase({ kind: "doctor_procedure", typedRaw: "  ", catalogPrice: 1800 }),
    ).toBe(1800);
  });
  it("passes an explicit ₱0 through — the create action rules on it, not this helper", () => {
    expect(
      doctorLineBase({ kind: "doctor_procedure", typedRaw: "0", catalogPrice: 1800 }),
    ).toBe(0);
  });
  it("falls back on garbage or negative input", () => {
    expect(
      doctorLineBase({ kind: "doctor_procedure", typedRaw: "abc", catalogPrice: 1800 }),
    ).toBe(1800);
    expect(
      doctorLineBase({ kind: "doctor_procedure", typedRaw: "-5", catalogPrice: 1800 }),
    ).toBe(1800);
    expect(
      doctorLineBase({ kind: "doctor_consultation", typedRaw: "-5", catalogPrice: 900 }),
    ).toBe(0);
  });
  it("ignores the typed value for non-doctor kinds", () => {
    expect(
      doctorLineBase({ kind: "lab_test", typedRaw: "999", catalogPrice: 350 }),
    ).toBe(350);
  });
});

describe("splitDoctorFee", () => {
  it("defaults clinic fee from arrangement and PF to the remainder", () => {
    expect(
      splitDoctorFee({ finalPrice: 500, arrangement: "pf_split", clinicFeeRaw: "", doctorPfRaw: "" }),
    ).toEqual({ clinic_fee_php: 100, doctor_pf_php: 400 });
  });
  it("gives the doctor the full fee for rent_paying", () => {
    expect(
      splitDoctorFee({ finalPrice: 500, arrangement: "rent_paying", clinicFeeRaw: "", doctorPfRaw: "" }),
    ).toEqual({ clinic_fee_php: 0, doctor_pf_php: 500 });
  });
  it("honors explicit overrides", () => {
    expect(
      splitDoctorFee({ finalPrice: 800, arrangement: "pf_split", clinicFeeRaw: "150", doctorPfRaw: "650" }),
    ).toEqual({ clinic_fee_php: 150, doctor_pf_php: 650 });
  });
  it("never produces a negative PF", () => {
    expect(
      splitDoctorFee({ finalPrice: 50, arrangement: "pf_split", clinicFeeRaw: "", doctorPfRaw: "" }),
    ).toEqual({ clinic_fee_php: 100, doctor_pf_php: 0 });
  });
  it("falls back to the arrangement default for invalid clinic-fee input", () => {
    expect(
      splitDoctorFee({ finalPrice: 500, arrangement: "pf_split", clinicFeeRaw: "abc", doctorPfRaw: "" }),
    ).toEqual({ clinic_fee_php: 100, doctor_pf_php: 400 });
  });

  it("uses the per-doctor clinicCutPhp override as the default when the fee input is blank", () => {
    expect(
      splitDoctorFee({
        finalPrice: 800,
        arrangement: "pf_split",
        clinicFeeRaw: "",
        doctorPfRaw: "",
        clinicCutPhp: 250,
      }),
    ).toEqual({ clinic_fee_php: 250, doctor_pf_php: 550 });
  });
  it("falls back to the arrangement default when clinicCutPhp is null/undefined", () => {
    expect(
      splitDoctorFee({
        finalPrice: 500,
        arrangement: "pf_split",
        clinicFeeRaw: "",
        doctorPfRaw: "",
        clinicCutPhp: null,
      }),
    ).toEqual({ clinic_fee_php: 100, doctor_pf_php: 400 });
  });
  it("ignores a negative or NaN clinicCutPhp override", () => {
    expect(
      splitDoctorFee({
        finalPrice: 500,
        arrangement: "pf_split",
        clinicFeeRaw: "",
        doctorPfRaw: "",
        clinicCutPhp: -10,
      }),
    ).toEqual({ clinic_fee_php: 100, doctor_pf_php: 400 });
  });
  it("an explicit typed clinic-fee input still wins over clinicCutPhp", () => {
    expect(
      splitDoctorFee({
        finalPrice: 800,
        arrangement: "pf_split",
        clinicFeeRaw: "150",
        doctorPfRaw: "",
        clinicCutPhp: 250,
      }),
    ).toEqual({ clinic_fee_php: 150, doctor_pf_php: 650 });
  });
});

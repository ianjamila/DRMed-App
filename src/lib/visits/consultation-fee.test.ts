import { describe, it, expect } from "vitest";
import { defaultClinicFee, splitDoctorFee } from "./consultation-fee";

describe("defaultClinicFee", () => {
  it("is 100 for pf_split (and unknown)", () => {
    expect(defaultClinicFee("pf_split")).toBe(100);
    expect(defaultClinicFee(undefined)).toBe(100);
  });
  it("is 0 for rent_paying and shareholder", () => {
    expect(defaultClinicFee("rent_paying")).toBe(0);
    expect(defaultClinicFee("shareholder")).toBe(0);
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
});

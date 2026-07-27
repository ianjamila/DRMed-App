import { describe, it, expect } from "vitest";
import { isConsultOnlyOrder, shouldPrintReceipt } from "./receipt-policy";

describe("isConsultOnlyOrder", () => {
  it("is true for an order of nothing but consultations", () => {
    expect(isConsultOnlyOrder(["doctor_consultation"])).toBe(true);
    expect(
      isConsultOnlyOrder(["doctor_consultation", "doctor_consultation"]),
    ).toBe(true);
  });

  it("is false as soon as a lab line is present", () => {
    expect(isConsultOnlyOrder(["doctor_consultation", "lab_test"])).toBe(false);
    expect(isConsultOnlyOrder(["lab_package"])).toBe(false);
  });

  it("is false for a doctor procedure — procedures still print", () => {
    expect(isConsultOnlyOrder(["doctor_procedure"])).toBe(false);
    expect(isConsultOnlyOrder(["doctor_consultation", "doctor_procedure"])).toBe(
      false,
    );
  });

  it("treats an unknown kind as a lab line, so the receipt survives", () => {
    expect(isConsultOnlyOrder(["some_future_kind"])).toBe(false);
    expect(
      isConsultOnlyOrder(["doctor_consultation", "some_future_kind"]),
    ).toBe(false);
  });

  it("never suppresses on an empty line list", () => {
    expect(isConsultOnlyOrder([])).toBe(false);
  });
});

describe("shouldPrintReceipt", () => {
  it("is the inverse of isConsultOnlyOrder", () => {
    expect(shouldPrintReceipt(["doctor_consultation"])).toBe(false);
    expect(shouldPrintReceipt(["doctor_consultation", "lab_test"])).toBe(true);
    expect(shouldPrintReceipt([])).toBe(true);
  });
});

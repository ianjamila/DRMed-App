import { describe, expect, it } from "vitest";
import {
  PAYSLIP_VISIBLE_RUN_STATUSES,
  payslipVisibleToStaff,
} from "./payslip-visibility";

describe("payslipVisibleToStaff", () => {
  it("shows a payslip once its run is finalised", () => {
    expect(payslipVisibleToStaff("finalised")).toBe(true);
  });

  it("hides a payslip for a draft run — the numbers aren't real yet", () => {
    expect(payslipVisibleToStaff("draft")).toBe(false);
  });

  it("hides a payslip for a computed-but-not-finalised run", () => {
    expect(payslipVisibleToStaff("computed")).toBe(false);
  });

  it("hides a payslip for a voided run — it has been withdrawn", () => {
    expect(payslipVisibleToStaff("voided")).toBe(false);
  });

  it("fails closed on an unknown status", () => {
    expect(payslipVisibleToStaff("some_future_status")).toBe(false);
  });

  it("fails closed on an empty status", () => {
    expect(payslipVisibleToStaff("")).toBe(false);
  });

  it("PAYSLIP_VISIBLE_RUN_STATUSES is exactly ['finalised'] — there is no 'paid' run status", () => {
    expect(PAYSLIP_VISIBLE_RUN_STATUSES).toEqual(["finalised"]);
  });
});

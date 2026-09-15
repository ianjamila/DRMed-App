import { describe, expect, it } from "vitest";
import { tillPaymentBlockedByClose } from "./till-close-warning";

const TILL = "till-1010";
const BANK = "bank-1020";
const CLOSED = ["2026-09-10", "2026-09-11"] as const;

describe("tillPaymentBlockedByClose", () => {
  it("blocks a till payment dated on a closed day", () => {
    expect(
      tillPaymentBlockedByClose({
        cashAccountId: TILL,
        tillAccountId: TILL,
        paymentDate: "2026-09-11",
        closedDates: CLOSED,
      }),
    ).toBe(true);
  });

  it("allows a till payment on an open day", () => {
    expect(
      tillPaymentBlockedByClose({
        cashAccountId: TILL,
        tillAccountId: TILL,
        paymentDate: "2026-09-12",
        closedDates: CLOSED,
      }),
    ).toBe(false);
  });

  it("never blocks a payment from a bank account, closed day or not", () => {
    // The 0149 trigger keys on the account, so a non-till payment writes no
    // drawer row and never meets the lock.
    expect(
      tillPaymentBlockedByClose({
        cashAccountId: BANK,
        tillAccountId: TILL,
        paymentDate: "2026-09-11",
        closedDates: CLOSED,
      }),
    ).toBe(false);
  });

  it("stays quiet when 1010 is missing from the chart of accounts", () => {
    // The trigger compares against coa_uuid_for_code('1010'); if that is null
    // it returns early, so warning here would be a lie.
    expect(
      tillPaymentBlockedByClose({
        cashAccountId: TILL,
        tillAccountId: null,
        paymentDate: "2026-09-11",
        closedDates: CLOSED,
      }),
    ).toBe(false);
  });

  it("stays quiet before the form has a date or an account", () => {
    expect(
      tillPaymentBlockedByClose({
        cashAccountId: "",
        tillAccountId: TILL,
        paymentDate: "2026-09-11",
        closedDates: CLOSED,
      }),
    ).toBe(false);
    expect(
      tillPaymentBlockedByClose({
        cashAccountId: TILL,
        tillAccountId: TILL,
        paymentDate: "",
        closedDates: CLOSED,
      }),
    ).toBe(false);
  });

  it("does not block when no day has been closed yet", () => {
    expect(
      tillPaymentBlockedByClose({
        cashAccountId: TILL,
        tillAccountId: TILL,
        paymentDate: "2026-09-11",
        closedDates: [],
      }),
    ).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  SEND_OUT_ACCOUNT_CODE,
  SEND_OUT_CATEGORY,
  isSendOutCategory,
  sendOutLabRule,
} from "./partner-labs";
import { CATEGORY_TO_COA } from "./expense-mappings";

describe("SEND_OUT_ACCOUNT_CODE", () => {
  it("matches the Send Out category's CoA mapping", () => {
    expect(CATEGORY_TO_COA[SEND_OUT_CATEGORY]).toBe(SEND_OUT_ACCOUNT_CODE);
  });
});

describe("isSendOutCategory", () => {
  it("is true only for 'Send Out'", () => {
    expect(isSendOutCategory("Send Out")).toBe(true);
    expect(isSendOutCategory("Lab Supplies")).toBe(false);
    expect(isSendOutCategory("")).toBe(false);
  });
});

describe("sendOutLabRule", () => {
  it("requires a lab when it is a Send Out expense", () => {
    expect(sendOutLabRule(true, null)).toBe("Pick which lab you paid.");
    expect(sendOutLabRule(true, undefined)).toBe("Pick which lab you paid.");
    expect(sendOutLabRule(true, "")).toBe("Pick which lab you paid.");
  });

  it("accepts a Send Out expense with a lab", () => {
    expect(sendOutLabRule(true, "vendor-1")).toBeNull();
  });

  it("refuses a lab on a non-Send-Out expense", () => {
    expect(sendOutLabRule(false, "vendor-1")).toBe(
      "A lab can only be picked for a Send Out expense.",
    );
  });

  it("accepts a non-Send-Out expense with no lab", () => {
    expect(sendOutLabRule(false, null)).toBeNull();
    expect(sendOutLabRule(false, undefined)).toBeNull();
  });
});

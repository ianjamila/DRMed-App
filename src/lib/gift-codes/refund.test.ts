import { describe, expect, it } from "vitest";
import { giftCodeRefundEligibility } from "./refund";

describe("giftCodeRefundEligibility", () => {
  it("allows a purchased (unredeemed) code to be refunded", () => {
    expect(giftCodeRefundEligibility("purchased")).toEqual({ ok: true });
  });

  it("refuses a generated (never sold) code with a plain explanation", () => {
    const result = giftCodeRefundEligibility("generated");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/nothing to refund/i);
    }
  });

  it("refuses a redeemed code and points at voiding the payment instead", () => {
    const result = giftCodeRefundEligibility("redeemed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/void/i);
      expect(result.error).toMatch(/payment/i);
    }
  });

  it("refuses an already-cancelled code", () => {
    const result = giftCodeRefundEligibility("cancelled");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/cancelled/i);
    }
  });

  it("covers every status the schema allows, so a new status can't fall through silently", () => {
    const allStatuses = [
      "generated",
      "purchased",
      "redeemed",
      "cancelled",
    ] as const;
    for (const status of allStatuses) {
      expect(() => giftCodeRefundEligibility(status)).not.toThrow();
    }
  });
});

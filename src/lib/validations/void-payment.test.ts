import { describe, expect, it } from "vitest";
import { VoidPaymentSchema } from "./accounting";

describe("VoidPaymentSchema (Delete payment)", () => {
  it("accepts a category with no note", () => {
    expect(VoidPaymentSchema.safeParse({ category: "recorded_twice", reason: "" }).success).toBe(true);
  });

  it("requires a note for Other, which says nothing on its own", () => {
    const r = VoidPaymentSchema.safeParse({ category: "other", reason: "   " });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("Say why you are deleting it.");
    expect(VoidPaymentSchema.safeParse({ category: "other", reason: "patient disputed" }).success).toBe(true);
  });

  it("refuses a missing or unknown category", () => {
    const r = VoidPaymentSchema.safeParse({ category: "", reason: "x" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("Choose why you are deleting it.");
    expect(VoidPaymentSchema.safeParse({ category: "Edited", reason: "x" }).success).toBe(false);
  });

  it("trims the note and caps it at 500", () => {
    expect(VoidPaymentSchema.parse({ category: "refunded", reason: "  cash back  " }).reason).toBe("cash back");
    expect(VoidPaymentSchema.safeParse({ category: "refunded", reason: "x".repeat(501) }).success).toBe(false);
  });
});

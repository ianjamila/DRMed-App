import { describe, expect, it } from "vitest";
import { detailMetadata } from "./detail-metadata";

describe("detail metadata", () => {
  it.each([
    ["Bill", "Hi Precision", "Bill · Hi Precision"],
    ["Vendor", "  ACME & Sons  ", "Vendor · ACME & Sons"],
    ["Payment", "REF-123", "Payment · REF-123"],
    ["Journal Entry", "JE-2026-001", "Journal Entry · JE-2026-001"],
  ])("identifies %s by its subject without adding a site suffix", async (name, subject, title) => {
    expect(await detailMetadata(name, async () => subject)).toEqual({ title });
  });
  it.each([null, undefined, "", "   "])("falls back for a missing/blank subject: %s", async (subject) => {
    expect(await detailMetadata("Bill", async () => subject)).toEqual({ title: "Bill" });
  });
  it("falls back for a rejected lookup without leaking its error", async () => {
    expect(await detailMetadata("Payment", async () => { throw new Error("database unavailable"); })).toEqual({ title: "Payment" });
  });
});

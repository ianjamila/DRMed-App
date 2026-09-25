import { describe, expect, it } from "vitest";
import { allocateWaiver, waiverPreview, type WaiverLine } from "./waiver-allocation";

const line = (id: string, pricePhp: number, kind = "lab_test", p: Partial<WaiverLine> = {}): WaiverLine => ({
  id,
  pricePhp,
  kind,
  isComponent: false,
  status: "requested",
  ...p,
});

describe("allocateWaiver (mirror of waive_visit_balance's split, 0183)", () => {
  it("splits proportionally, lab to 4910 and doctor lines to 4920", () => {
    expect(allocateWaiver(600, [line("a", 500), line("b", 500, "doctor_consultation")])).toEqual([
      { id: "a", amountPhp: 300, account: "4910" },
      { id: "b", amountPhp: 300, account: "4920" },
    ]);
  });
  it("largest remainder: the centavos add up exactly, biggest fraction first, id as tie-break", () => {
    // ₱1,000 over three ₱500 lines (₱1,500 billed, ₱500 paid): 333.33 × 3 = 999.99;
    // every fraction ties, so the leftover centavo goes to the lowest id.
    const out = allocateWaiver(1000, [line("c", 500), line("a", 500), line("b", 500)]);
    expect(out.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(out.map((o) => o.amountPhp)).toEqual([333.34, 333.33, 333.33]);
    expect(out.reduce((s, o) => s + o.amountPhp, 0)).toBeCloseTo(1000, 2);
  });
  it("never exceeds a line's own price and never goes negative", () => {
    expect(allocateWaiver(0.03, [line("a", 0.01), line("b", 0.02)])).toEqual([
      { id: "a", amountPhp: 0.01, account: "4910" },
      { id: "b", amountPhp: 0.02, account: "4910" },
    ]);
  });
  it("skips ₱0 package components, cancelled lines, and drops ₱0 shares", () => {
    const out = allocateWaiver(1, [
      line("header", 5888, "lab_package"),
      line("comp", 0, "lab_test", { isComponent: true }),
      line("x", 550, "lab_test", { status: "cancelled" }),
      line("tiny", 0.01),
    ]);
    expect(out.map((o) => o.id)).toEqual(["header"]);
    expect(out[0]!.amountPhp).toBe(1);
  });
  it("refuses a remainder bigger than the lines add up to (visit total out of step)", () => {
    expect(() => allocateWaiver(700, [line("a", 500)])).toThrow(/more than its lines/);
  });
  it("preview refuses a visit total out of step with its lines in EITHER direction (0183 [CR-6])", () => {
    // total 1,000, one ₱900 line, ₱200 paid → remainder 800 fits under the
    // lines, so allocateWaiver alone would happily split it; the RPC refuses.
    expect(() => waiverPreview(800, [line("a", 900)], 1000)).toThrow(/does not match its lines/);
    expect(() => waiverPreview(300, [line("a", 1000)], 500)).toThrow(/does not match its lines/);
    expect(waiverPreview(300, [line("a", 500)], 500)).toEqual({ labPhp: 300, doctorPhp: 0, lines: 1 });
  });
  it("preview groups the split by account", () => {
    expect(waiverPreview(600, [line("a", 500), line("b", 500, "doctor_procedure")])).toEqual({
      labPhp: 300,
      doctorPhp: 300,
      lines: 2,
    });
  });
});

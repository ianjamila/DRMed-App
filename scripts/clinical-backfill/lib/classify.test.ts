import { describe, it, expect } from "vitest";
import { classifyRow } from "./classify";
import type { RawRow } from "./types";

function row(over: Partial<RawRow> = {}): RawRow {
  return {
    row_number: 10, posting_date: "2024-05-01", control_no: "C1", test_no: "T1",
    patient_name: "Doe, Jane", hmo_flag: "", hmo_provider: "", service: "CBC",
    base: 300, final: 300, clinic_fee: 0, doctor_pf: 0, mop: "CASH",
    or_number: "", date_paid: null, ...over,
  };
}
const WIN = { start: "2023-12-01", cutoverExclusive: "2026-05-26" };

describe("classifyRow", () => {
  it("postable inside the window with a positive amount", () => {
    expect(classifyRow(row(), WIN, false)).toBe("postable");
  });
  it("bad_date when posting_date is null", () => {
    expect(classifyRow(row({ posting_date: null }), WIN, false)).toBe("bad_date");
  });
  it("out_of_window before start or on/after cutover", () => {
    expect(classifyRow(row({ posting_date: "2023-11-30" }), WIN, false)).toBe("out_of_window");
    expect(classifyRow(row({ posting_date: "2026-05-26" }), WIN, false)).toBe("out_of_window");
  });
  it("zero_amount for a lab row with final<=0 and base<=0", () => {
    expect(classifyRow(row({ base: 0, final: 0 }), WIN, false)).toBe("zero_amount");
  });
  it("consult zero_amount keys on clinic_fee (the clinic's revenue)", () => {
    expect(classifyRow(row({ clinic_fee: 0, base: 500, final: 500 }), WIN, true)).toBe("zero_amount");
    expect(classifyRow(row({ clinic_fee: 200 }), WIN, true)).toBe("postable");
  });
});

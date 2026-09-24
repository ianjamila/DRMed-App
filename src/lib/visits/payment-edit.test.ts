import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EDITABLE_PAYMENT_METHODS,
  balanceAfterEdit,
  isEditablePaymentMethod,
  isMoneyChange,
  paymentEditability,
} from "./payment-edit";
import { PaymentEditSchema } from "@/lib/validations/payment";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/0161_payment_correction.sql"),
  "utf8",
);

describe("EDITABLE_PAYMENT_METHODS", () => {
  it("matches the method list correct_payment accepts", () => {
    const m = MIGRATION.match(/p_method not in \(([^)]+)\)/);
    expect(m).not.toBeNull();
    const sql = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(EDITABLE_PAYMENT_METHODS.map((x) => x.value).sort()).toEqual(sql);
  });

  it("never offers gift code or hmo as an edit target", () => {
    expect(isEditablePaymentMethod("gift_code")).toBe(false);
    expect(isEditablePaymentMethod("hmo")).toBe(false);
    expect(isEditablePaymentMethod("gcash")).toBe(true);
  });
});

describe("paymentEditability", () => {
  const base = { method: "cash", voided_at: null, legacy_import_run_id: null };

  it("allows an active counter payment", () => {
    expect(paymentEditability(base)).toEqual({ editable: true });
  });

  it.each([
    ["voided", { ...base, voided_at: "2026-09-24T00:00:00Z" }],
    ["gift code", { ...base, method: "gift_code" }],
    ["hmo", { ...base, method: "hmo" }],
    ["legacy import", { ...base, legacy_import_run_id: "run-1" }],
  ])("refuses a %s payment, as correct_payment does", (_label, row) => {
    expect(paymentEditability(row).editable).toBe(false);
  });

  it("refuses exactly what the SQL refuses", () => {
    expect(MIGRATION).toMatch(/v_old\.method in \('gift_code', 'hmo'\)/);
    expect(MIGRATION).toMatch(/v_old\.legacy_import_run_id is not null/);
    expect(MIGRATION).toMatch(/v_old\.voided_at is not null/);
  });

  it("allows a legacy bpi / maybank row recorded in the app", () => {
    expect(paymentEditability({ ...base, method: "bpi" })).toEqual({ editable: true });
  });
});

describe("isMoneyChange", () => {
  it("is false for the same amount and method", () => {
    expect(isMoneyChange({ amount_php: 5888, method: "cash" }, { amount_php: 5888, method: "cash" })).toBe(false);
  });
  it("is true when only the method changes", () => {
    expect(isMoneyChange({ amount_php: 5888, method: "cash" }, { amount_php: 5888, method: "gcash" })).toBe(true);
  });
  it("is true when only the amount changes", () => {
    expect(isMoneyChange({ amount_php: 5888, method: "cash" }, { amount_php: 5880, method: "cash" })).toBe(true);
  });
  it("ignores float noise below a centavo", () => {
    expect(isMoneyChange({ amount_php: 0.1 + 0.2, method: "cash" }, { amount_php: 0.3, method: "cash" })).toBe(false);
  });
});

describe("balanceAfterEdit", () => {
  it("is zero when the amount is unchanged on a paid visit", () => {
    expect(balanceAfterEdit({ visitTotal: 5888, visitPaid: 5888, oldAmount: 5888, newAmount: 5888 })).toBe(0);
  });
  it("shows the shortfall when the amount goes down", () => {
    expect(balanceAfterEdit({ visitTotal: 5888, visitPaid: 5888, oldAmount: 5888, newAmount: 5000 })).toBe(888);
  });
  it("goes negative when the edit overpays", () => {
    expect(balanceAfterEdit({ visitTotal: 1000, visitPaid: 1000, oldAmount: 1000, newAmount: 1200 })).toBe(-200);
  });
  it("counts centavos exactly", () => {
    expect(balanceAfterEdit({ visitTotal: 100.25, visitPaid: 50, oldAmount: 50, newAmount: 49.75 })).toBe(50.5);
  });
});

describe("PaymentEditSchema", () => {
  const ok = {
    payment_id: "6fc15e0b-e3e3-4fd4-ba2c-4a8b504b6394",
    amount_php: "5888.10",
    method: "gcash",
    reference_number: "",
    notes: "",
    reason: "Keyed as cash",
  };

  it("accepts two decimal places a float centavo check would refuse", () => {
    const r = PaymentEditSchema.safeParse(ok);
    expect(r.success).toBe(true);
    expect(r.success && r.data.amount_php).toBe(5888.1);
  });

  it.each([
    ["three decimals", { amount_php: "10.005" }],
    ["zero", { amount_php: "0" }],
    ["negative", { amount_php: "-5" }],
    ["text", { amount_php: "abc" }],
    ["gift code target", { method: "gift_code" }],
    ["hmo target", { method: "hmo" }],
    ["blank reason", { reason: "   " }],
  ])("refuses %s", (_label, patch) => {
    expect(PaymentEditSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });

  it("offers the same methods the dialog lists", () => {
    expect([...PaymentEditSchema.shape.method.options].sort()).toEqual(
      EDITABLE_PAYMENT_METHODS.map((m) => m.value).sort(),
    );
  });
});

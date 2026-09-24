/**
 * Every bill status and bill-payment method has words, and the lists match
 * the CHECK constraints in the committed SQL (the same text-parity approach
 * as `cash-adjustment-kinds.parity.test.ts` — `npm test` has no database).
 *
 * The vendor page once keyed its badge colours off `"partial"`, a status no
 * bill can have, so every partially-paid bill there fell through to the grey
 * "unknown" style. One list, checked against the constraint, stops that.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BILL_PAYMENT_METHODS,
  BILL_PAYMENT_METHOD_LABEL,
  BILL_STATUSES,
  BILL_STATUS_LABEL,
  billPaymentMethodLabel,
  billStatusLabel,
} from "./ap-labels";

const sql = readFileSync(
  fileURLToPath(
    new URL("../../../supabase/migrations/0048_ap_subledger_schema.sql", import.meta.url),
  ),
  "utf8",
);

function checkValues(constraint: string): string[] {
  const match = sql.match(new RegExp(`${constraint}\\s+check \\(\\w+ in \\(([^)]*)\\)\\)`));
  expect(match, constraint).not.toBeNull();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("bill status labels", () => {
  it("covers exactly the statuses the bills table allows", () => {
    expect([...BILL_STATUSES].sort()).toEqual(checkValues("bills_status_check").sort());
    expect(Object.keys(BILL_STATUS_LABEL).sort()).toEqual([...BILL_STATUSES].sort());
  });

  it("prints words, never the stored code", () => {
    expect(billStatusLabel("partially_paid")).toBe("Partially paid");
    for (const status of BILL_STATUSES) {
      expect(billStatusLabel(status)).not.toContain("_");
    }
  });

  it("humanises a code it does not know instead of showing it raw", () => {
    expect(billStatusLabel("on_hold")).toBe("On hold");
  });
});

describe("bill payment method labels", () => {
  it("covers exactly the methods bill_payments allows", () => {
    expect([...BILL_PAYMENT_METHODS].sort()).toEqual(
      checkValues("bill_payments_method_check").sort(),
    );
    expect(Object.keys(BILL_PAYMENT_METHOD_LABEL).sort()).toEqual(
      [...BILL_PAYMENT_METHODS].sort(),
    );
  });

  it("prints words, never the stored code", () => {
    expect(billPaymentMethodLabel("bank_transfer")).toBe("Bank transfer");
    expect(billPaymentMethodLabel("gcash")).toBe("GCash");
    for (const method of BILL_PAYMENT_METHODS) {
      expect(billPaymentMethodLabel(method)).not.toContain("_");
    }
  });

  it("humanises a code it does not know instead of showing it raw", () => {
    expect(billPaymentMethodLabel("credit_card")).toBe("Credit card");
  });
});

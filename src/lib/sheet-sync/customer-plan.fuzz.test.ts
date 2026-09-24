/**
 * Property test for the Customers identity plan (review round 2): random
 * small worlds — a few sheet rows drawn from a handful of colliding names,
 * DOBs and phones, a few existing patients (some merged), and sometimes a
 * saved decision — each planned in two row orders and replayed for a second
 * run through the SQL model in __fixtures__/customer-world.ts. Properties:
 * (1) determinism; (2) order-independence of every decision; (3) run 2 over
 * the same sheet emits no op at all; (4) no filled / created value comes from
 * a row that is not attached to that patient (a reviewed row never is);
 * (5) no auto-attached row conflicts (DOB, or phone without a matching DOB)
 * with the patient it ends up on.
 *
 * Seeded, so it is deterministic: a failure prints its case number and world.
 */
import { describe, expect, it } from "vitest";
import { checkCase, makeCase, mulberry32 } from "./__fixtures__/customer-fuzz";

const CASES = 1500;
const SEED = 20260924;

describe(`planCustomers — property test (${CASES} seeded random worlds)`, () => {
  it("is deterministic, order-independent, stable on run 2, and never pours a reviewed or conflicting row into a patient", () => {
    const rnd = mulberry32(SEED);
    const violations: string[] = [];
    let orderChecked = 0;
    for (let i = 0; i < CASES; i++) {
      const res = checkCase(i, makeCase(rnd), rnd);
      violations.push(...res.violations);
      if (res.orderChecked) orderChecked++;
    }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations).toHaveLength(0);
    expect(orderChecked).toBeGreaterThan(CASES * 0.9);
  });
});

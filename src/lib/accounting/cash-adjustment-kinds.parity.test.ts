/**
 * Every `eod_cash_adjustments.kind` is accounted for — in the drawer's own
 * arithmetic, and in the label map reception reads.
 *
 * WHY THIS EXISTS
 * ---------------
 * `cash_drawer_state` does not sum the table. It sums three *named* subsets of
 * it: `floats` (float_topup / float_pullout), `gift_sales` (gift_code_sale),
 * and `payouts` (an explicit `kind in (...)` list). A kind that is in the
 * CHECK constraint but in none of those three is invisible to
 * `expected_cash_php` — the row exists, the drawer ignores it, and reception
 * counts short or over with nothing on screen to explain it.
 *
 * That is not hypothetical. `salary_payout` shipped in 0044 and was left out
 * of the `payouts` list until 0139 found it, so for 95 migrations a cash
 * payroll payout silently inflated the day's expected cash. 0149 adds
 * `bill_payment` and would have made the same mistake just as quietly.
 *
 * The parity is checked against the migration TEXT rather than a database, for
 * the reasons `cash-denominations.parity.test.ts` gives: `npm test` has no
 * stack to talk to, and the committed SQL is the actual source of truth.
 *
 * ADDING A KIND
 * -------------
 * Widen the CHECK, put it in exactly one of the three CTEs, and give it a
 * KIND_LABEL. This test fails until all three are done.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATION = fileURLToPath(
  new URL(
    "../../../supabase/migrations/0149_ap_cash_bill_payment_drawer_link.sql",
    import.meta.url,
  ),
);
const DRAWER_CLIENT = fileURLToPath(
  new URL(
    "../../app/(staff)/staff/(dashboard)/payments/cash-drawer/cash-drawer-client.tsx",
    import.meta.url,
  ),
);
const VALIDATIONS = fileURLToPath(new URL("../validations/accounting.ts", import.meta.url));

const sql = readFileSync(MIGRATION, "utf8");

function quoted(text: string): string[] {
  return [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** The live `kind in (...)` list on eod_cash_adjustments_kind_check. */
function checkConstraintKinds(): string[] {
  const m = sql.match(
    /add constraint eod_cash_adjustments_kind_check check \(kind in \(([\s\S]*?)\)\)/,
  );
  if (!m) throw new Error("could not locate eod_cash_adjustments_kind_check in 0149");
  return quoted(m[1]);
}

/** The body of one named CTE inside cash_drawer_state. */
function cteBody(name: string): string {
  const fn = sql.match(
    /create or replace function public\.cash_drawer_state\(([\s\S]*?)\n\$\$;/,
  );
  if (!fn) throw new Error("could not locate cash_drawer_state in 0149");
  const m = fn[1].match(new RegExp(`\\n    ${name} as \\(([\\s\\S]*?)\\n    \\),`));
  if (!m) throw new Error(`could not locate the ${name} CTE in cash_drawer_state`);
  return m[1];
}

function labelledKinds(): string[] {
  const text = readFileSync(DRAWER_CLIENT, "utf8");
  const m = text.match(/const KIND_LABEL: Record<string, string> = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error("could not locate KIND_LABEL in cash-drawer-client.tsx");
  return [...m[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((x) => x[1]);
}

function zodKinds(): string[] {
  const text = readFileSync(VALIDATIONS, "utf8");
  const m = text.match(/const CashAdjustmentKindEnum = z\.enum\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error("could not locate CashAdjustmentKindEnum in validations/accounting.ts");
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe("eod_cash_adjustments kind parity", () => {
  const kinds = checkConstraintKinds();

  it("0149 widens the CHECK to admit bill_payment without dropping a kind", () => {
    expect(kinds).toEqual([
      "petty_cash",
      "salary_advance",
      "courier",
      "other_payout",
      "float_topup",
      "float_pullout",
      "salary_payout",
      "gift_code_sale",
      "bill_payment",
    ]);
  });

  it("every kind lands in exactly one of the drawer's three summing CTEs", () => {
    // `bill_payouts` is deliberately excluded: it is a display-only sub-total
    // of `payouts`, not a fourth bucket, and counting it here would make
    // bill_payment look double-summed.
    const buckets = {
      floats: quoted(cteBody("floats")),
      gift_sales: quoted(cteBody("gift_sales")),
      payouts: quoted(cteBody("payouts")),
    };

    for (const kind of kinds) {
      const hits = Object.entries(buckets)
        .filter(([, v]) => v.includes(kind))
        .map(([k]) => k);
      expect(
        hits,
        `${kind} is summed by ${hits.length === 0 ? "no CTE" : hits.join(" and ")} — ` +
          "a kind in no CTE is invisible to expected_cash_php; a kind in two is counted twice",
      ).toHaveLength(1);
    }
  });

  it("the display-only bill sub-total reads the same kind the link trigger writes", () => {
    expect(quoted(cteBody("bill_payouts"))).toEqual(["bill_payment"]);
  });

  it("reception never sees a raw kind slug", () => {
    expect(labelledKinds().sort()).toEqual([...kinds].sort());
  });

  it("the drawer's own form stays narrower than the CHECK, on purpose", () => {
    // salary_payout, gift_code_sale and bill_payment are written by their own
    // actions (payroll, gift codes, the AP subledger) and must not be
    // hand-recordable from the cash drawer's "Pay out cash" modal.
    const zod = zodKinds();
    expect(zod.every((k) => kinds.includes(k))).toBe(true);
    expect(zod).not.toContain("salary_payout");
    expect(zod).not.toContain("gift_code_sale");
    expect(zod).not.toContain("bill_payment");
  });
});

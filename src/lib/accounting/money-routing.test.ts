import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CASH_KIND_HELP,
  CASH_KIND_LABEL,
  FIXED_CASH_KINDS,
  FIXED_PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  SUSPENSE_CODE,
  accountChoicesFor,
  cashKindLabel,
  cashRoutingGroup,
  effectiveCashAccountCode,
  INACTIVE_ROUTED_ACCOUNT_ERROR,
  resolveCashAdjustmentAccount,
  groupAccounts,
  isAllowedAccount,
  paymentMethodLabel,
  pettyCashChoices,
  staffPicksAccount,
  startingPick,
  type RoutingAccount,
} from "./money-routing";

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../supabase/migrations/${name}`, import.meta.url)), "utf8");

const A = (code: string, type: string, name = code): RoutingAccount => ({ id: `id-${code}`, code, name, type });
const CHART: RoutingAccount[] = [
  A("1010", "asset", "Cash on Hand"),
  A("1020", "asset", "Cash in Bank — BPI"),
  A("1090", "asset", "Cash — HMO Settlements Pending"),
  A("1100", "asset", "Accounts Receivable — Patients"),
  A("1130", "asset", "Staff Advances"),
  A("2100", "liability"),
  A("2250", "liability", "Gift Codes Outstanding"),
  A("3100", "equity", "Owner's Capital"),
  A("4100", "revenue"),
  A("4910", "contra_revenue"),
  A("6320", "expense", "Courier"),
  A("6400", "expense", "Office Supplies"),
  A("9999", "memo", "Suspense"),
];
const codes = (xs: RoutingAccount[]) => xs.map((a) => a.code);

describe("plain names", () => {
  it("labels every seeded payment method and every routing kind", () => {
    const paymentSeeds = [
      ...migration("0030_op_gl_bridge.sql").matchAll(/^\s*\('([a-z_]+)',\s+public\.coa_uuid_for_code/gm),
    ].map((m) => m[1]);
    expect(paymentSeeds.length).toBeGreaterThan(5);
    for (const m of [...paymentSeeds, "gift_code"]) expect(PAYMENT_METHOD_LABEL[m], m).toBeTruthy();

    const check = migration("0139_gift_code_payment_method.sql").match(
      /add constraint cash_adjustment_account_map_kind_check check \(kind in \(([\s\S]*?)\)\)/,
    );
    expect(check).not.toBeNull();
    const kinds = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(kinds).toHaveLength(8);
    for (const k of kinds) {
      expect(CASH_KIND_LABEL[k], k).toBeTruthy();
      expect(CASH_KIND_HELP[k], k).toBeTruthy();
    }
  });

  it("never shows a raw slug, even for a code added after this map", () => {
    expect(paymentMethodLabel("bank_transfer")).toBe("Bank transfer");
    expect(paymentMethodLabel("new_wallet")).toBe("New wallet");
    expect(cashKindLabel("float_topup")).toBe("Cash added to drawer");
    expect(cashKindLabel("some_new_kind")).toBe("Some new kind");
  });
});

describe("fixed rows match the accounts the database hardcodes", () => {
  // Each fixed row pairs with SQL that posts the opposite side to one literal
  // account. If either side moves, this is the test that should fail.
  it("salary advance and salary payout are the accounts payroll finalise clears", () => {
    const payroll = migration("0044_payroll.sql");
    expect(payroll).toMatch(/coa_uuid_for_code\('1130'\), 0, v_totals\.advance_total/);
    expect(payroll).toMatch(/coa_uuid_for_code\('2360'\), 0, v_totals\.net_total/);
    expect(migration("0043_eod_cash_reconciliation.sql")).toMatch(
      /\('salary_advance', public\.coa_uuid_for_code\('1130'\)/,
    );
    expect(payroll).toMatch(/values \('salary_payout', public\.coa_uuid_for_code\('2360'\)/);
    expect(FIXED_CASH_KINDS.salary_advance).toContain("1130");
    expect(FIXED_CASH_KINDS.salary_payout).toContain("2360");
  });

  it("both gift-code rows point at the 2250 liability", () => {
    const gift = migration("0139_gift_code_payment_method.sql");
    expect(gift).toMatch(/'gift_code_sale',\s+public\.coa_uuid_for_code\('2250'\)/);
    expect(gift).toMatch(/'gift_code',\s+public\.coa_uuid_for_code\('2250'\)/);
    expect(FIXED_CASH_KINDS.gift_code_sale).toContain("2250");
    expect(FIXED_PAYMENT_METHODS.gift_code).toContain("2250");
  });
});

describe("cashRoutingGroup", () => {
  it("sorts rows into fixed, staff-picks and always", () => {
    expect(cashRoutingGroup("salary_payout", false)).toBe("fixed");
    // Fixed wins even if someone flipped the flag in the database.
    expect(cashRoutingGroup("gift_code_sale", true)).toBe("fixed");
    expect(cashRoutingGroup("petty_cash", true)).toBe("staff_picks");
    expect(cashRoutingGroup("courier", false)).toBe("always");
  });
});

describe("accountChoicesFor", () => {
  it("offers payment methods only cash and bank accounts", () => {
    expect(codes(accountChoicesFor({ side: "payment", key: "gcash" }, CHART))).toEqual(["1010", "1020", "1090"]);
  });

  it("offers petty cash only the Petty Cash tab's categories, and courier any expense", () => {
    expect(codes(accountChoicesFor({ side: "cash", key: "petty_cash" }, CHART))).toEqual(["6400"]);
    expect(codes(accountChoicesFor({ side: "cash", key: "courier" }, CHART))).toEqual(["6320", "6400"]);
  });

  it("offers cash moves the places cash comes from or goes to", () => {
    expect(codes(accountChoicesFor({ side: "cash", key: "float_topup" }, CHART))).toEqual([
      "1010", "1020", "1090", "2100", "2250", "3100",
    ]);
  });

  it("leaves 'Other' open to the whole chart", () => {
    expect(accountChoicesFor({ side: "cash", key: "other_payout" }, CHART)).toHaveLength(CHART.length);
  });

  it("always keeps the current account, however unusual", () => {
    const choices = accountChoicesFor({ side: "payment", key: "card" }, CHART, "id-1100");
    expect(codes(choices)).toContain("1100");
    expect(isAllowedAccount({ side: "payment", key: "card" }, A("1100", "asset"), "id-1100")).toBe(true);
    expect(isAllowedAccount({ side: "payment", key: "card" }, A("1100", "asset"), "id-1010")).toBe(false);
  });
});

describe("groupAccounts", () => {
  it("puts cash & bank first and keeps code order inside a group", () => {
    const groups = groupAccounts(CHART);
    expect(groups.map((g) => g.label)).toEqual([
      "Cash & bank", "Expenses", "Other assets", "Liabilities", "Equity", "Revenue", "Other",
    ]);
    expect(codes(groups[0].accounts)).toEqual(["1010", "1020", "1090"]);
    expect(codes(groups[2].accounts)).toEqual(["1100", "1130"]);
    expect(codes(groups[6].accounts)).toEqual(["9999"]);
  });

  it("drops empty groups", () => {
    expect(groupAccounts([A("6400", "expense")]).map((g) => g.label)).toEqual(["Expenses"]);
  });
});

describe("pettyCashChoices", () => {
  it("resolves the Petty Cash tab's categories to active accounts, skipping missing ones", () => {
    const choices = pettyCashChoices(CHART);
    expect(choices.map((c) => [c.category, c.account.code])).toEqual([["Office Supplies", "6400"]]);
    expect(choices[0].hint).toMatch(/ink/);
  });
});

describe("the Cash Drawer picker", () => {
  it("follows the routing row, and the old hardcoded rule without one", () => {
    expect(staffPicksAccount("courier", { account_id: "id-6320", requires_user_choice: true })).toBe(true);
    expect(staffPicksAccount("float_topup", { account_id: "id-1020", requires_user_choice: false })).toBe(false);
    expect(staffPicksAccount("courier", undefined)).toBe(false);
    expect(staffPicksAccount("salary_advance", undefined)).toBe(false);
    expect(staffPicksAccount("petty_cash", undefined)).toBe(true);
  });

  it("starts on the routing row's account when staff pick", () => {
    expect(startingPick({ account_id: "id-1020", requires_user_choice: true }, CHART)).toBe("id-1020");
  });

  it("never pre-fills Suspense, so a skipped pick still writes the suspense audit", () => {
    expect(startingPick({ account_id: "id-9999", requires_user_choice: true }, CHART)).toBe("");
  });

  it("starts empty when there is no picker, no row, or an inactive account", () => {
    expect(startingPick({ account_id: "id-1020", requires_user_choice: false }, CHART)).toBe("");
    expect(startingPick(undefined, CHART)).toBe("");
    expect(startingPick({ account_id: "id-gone", requires_user_choice: true }, CHART)).toBe("");
  });
});

describe("effectiveCashAccountCode", () => {
  // Mirrors resolve_cash_adjustment_account (0043): the account the DB will
  // actually post to, whether or not a picker is showing.
  it("an explicit contra pick always wins", () => {
    expect(effectiveCashAccountCode("id-6400", { account_id: "id-6320", requires_user_choice: false }, CHART)).toBe("6400");
  });

  it("no contra, no staff pick required: falls back to the routing row's account", () => {
    expect(effectiveCashAccountCode(null, { account_id: "id-6320", requires_user_choice: false }, CHART)).toBe("6320");
  });

  it("no contra, staff pick required and skipped: the DB posts to 9999 Suspense, not the mapped default", () => {
    expect(effectiveCashAccountCode(null, { account_id: "id-6400", requires_user_choice: true }, CHART)).toBe(SUSPENSE_CODE);
  });

  it("no contra and no routing row at all: also Suspense", () => {
    expect(effectiveCashAccountCode(null, undefined, CHART)).toBe(SUSPENSE_CODE);
    expect(effectiveCashAccountCode("", undefined, CHART)).toBe(SUSPENSE_CODE);
  });
});

describe("resolveCashAdjustmentAccount (server twin, sees inactive accounts)", () => {
  const ROWS = [
    { id: "id-6420", code: "6420", is_active: true },
    { id: "id-6400", code: "6400", is_active: false },
  ];

  it("resolves exactly like effectiveCashAccountCode for active accounts", () => {
    expect(resolveCashAdjustmentAccount("id-6420", undefined, ROWS)).toEqual({ code: "6420", inactive: false });
    expect(resolveCashAdjustmentAccount(null, { account_id: "id-6420", requires_user_choice: false }, ROWS)).toEqual({ code: "6420", inactive: false });
    expect(resolveCashAdjustmentAccount(null, { account_id: "id-6420", requires_user_choice: true }, ROWS)).toEqual({ code: SUSPENSE_CODE, inactive: false });
    expect(resolveCashAdjustmentAccount(null, undefined, ROWS)).toEqual({ code: SUSPENSE_CODE, inactive: false });
  });

  it("flags a switched-off routed default the browser could never show", () => {
    const rule = { account_id: "id-6400", requires_user_choice: false };
    expect(resolveCashAdjustmentAccount(null, rule, ROWS)).toEqual({ code: "6400", inactive: true });
    // The browser only holds active accounts, so it resolves nothing there — no lab picker.
    const activeOnly = CHART.filter((a) => a.id !== "id-6400");
    expect(effectiveCashAccountCode(null, rule, activeOnly)).toBeUndefined();
    expect(INACTIVE_ROUTED_ACCOUNT_ERROR).toMatch(/Money Routing/);
  });
});

describe("the Cash Drawer resolves the EFFECTIVE account on both sides", () => {
  // Reverting either side to "whatever the picker holds" silently lets a
  // Money Routing default of 6420 skip the Which-lab rule.
  const read = (p: string) =>
    readFileSync(fileURLToPath(new URL(`../../app/(staff)/staff/(dashboard)/payments/cash-drawer/${p}`, import.meta.url)), "utf8");

  it("the modal decides Send Out from effectiveCashAccountCode", () => {
    expect(read("cash-drawer-client.tsx")).toMatch(/const selectedAccountCode = effectiveCashAccountCode\(/);
  });

  it("the server action decides Send Out from resolveCashAdjustmentAccount and refuses an inactive default", () => {
    const src = read("actions.ts");
    expect(src).toMatch(/resolveCashAdjustmentAccount\(contraId, rule,/);
    expect(src).toMatch(/effective\.code === SEND_OUT_ACCOUNT_CODE/);
    expect(src).toMatch(/effective\.inactive\) return \{ ok: false, error: INACTIVE_ROUTED_ACCOUNT_ERROR \}/);
  });
});

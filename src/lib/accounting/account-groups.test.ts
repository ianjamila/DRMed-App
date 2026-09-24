import { describe, expect, it } from "vitest";
import {
  accountTypeGroupLabel,
  groupAccountsByType,
  parentAccountError,
} from "./account-groups";

const acct = (code: string, type: string) => ({ id: `id-${code}`, code, name: `Account ${code}`, type });

describe("groupAccountsByType", () => {
  it("groups in chart order (assets first), not alphabetically", () => {
    const groups = groupAccountsByType([
      acct("5100", "expense"),
      acct("1010", "asset"),
      acct("4900", "contra_revenue"),
      acct("2100", "liability"),
      acct("4100", "revenue"),
    ]);
    expect(groups.map((g) => g.type)).toEqual([
      "asset",
      "liability",
      "revenue",
      "contra_revenue",
      "expense",
    ]);
  });

  it("sorts each group by code and labels it with its code range", () => {
    const [assets] = groupAccountsByType([acct("1200", "asset"), acct("1010", "asset")]);
    expect(assets.label).toBe("Assets (1xxx)");
    expect(assets.accounts.map((a) => a.code)).toEqual(["1010", "1200"]);
  });

  it("keeps an unknown type visible, after the known ones", () => {
    const groups = groupAccountsByType([acct("9000", "suspense_x"), acct("1010", "asset")]);
    expect(groups.map((g) => g.type)).toEqual(["asset", "suspense_x"]);
    expect(groups[1].label).toBe("Suspense x");
  });

  it("drops empty groups", () => {
    expect(groupAccountsByType([])).toEqual([]);
  });
});

describe("accountTypeGroupLabel", () => {
  it("labels every account type the form offers", () => {
    for (const type of [
      "asset",
      "liability",
      "equity",
      "revenue",
      "contra_revenue",
      "expense",
      "contra_expense",
      "memo",
    ]) {
      expect(accountTypeGroupLabel(type)).not.toContain("_");
    }
  });
});

describe("parentAccountError", () => {
  it("allows no parent", () => {
    expect(parentAccountError({ type: "expense" }, null)).toBeNull();
  });

  it("allows a parent of the same type", () => {
    expect(parentAccountError({ id: "a", type: "expense" }, { id: "b", type: "expense" })).toBeNull();
  });

  it("rejects a parent of another type, naming both in words", () => {
    expect(parentAccountError({ type: "expense" }, { id: "b", type: "asset" })).toBe(
      "The parent account must be the same type — this account is Expenses (5xxx-7xxx) and the parent is Assets (1xxx).",
    );
  });

  it("rejects an account as its own parent", () => {
    expect(parentAccountError({ id: "a", type: "asset" }, { id: "a", type: "asset" })).toBe(
      "An account can't be its own parent.",
    );
  });
});

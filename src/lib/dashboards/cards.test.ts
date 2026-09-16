import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CARDS,
  hiddenCardIdsFor,
  matchesCardDefault,
  type CardDef,
} from "./cards";

const GIFT_CODES = "reception.gift_codes_sold";
const VISITS_TODAY = "reception.visits_today";

function card(id: string): CardDef {
  const found = DASHBOARD_CARDS.find((c) => c.id === id);
  if (!found) throw new Error(`no such card: ${id}`);
  return found;
}

describe("hiddenCardIdsFor", () => {
  it("hides nothing for a role with no stored prefs and no defaults", () => {
    expect(hiddenCardIdsFor("medtech", [])).toEqual(new Set());
  });

  it("hides a defaultHidden card when there is no stored pref", () => {
    expect(hiddenCardIdsFor("reception", [])).toEqual(new Set([GIFT_CODES]));
  });

  it("a stored visible=true turns a defaultHidden card back on", () => {
    const hidden = hiddenCardIdsFor("reception", [
      { card_id: GIFT_CODES, visible: true },
    ]);
    expect(hidden.has(GIFT_CODES)).toBe(false);
  });

  it("a stored visible=false still hides an ordinary card", () => {
    const hidden = hiddenCardIdsFor("reception", [
      { card_id: VISITS_TODAY, visible: false },
    ]);
    expect(hidden.has(VISITS_TODAY)).toBe(true);
    // …and the default-hidden one stays hidden alongside it.
    expect(hidden.has(GIFT_CODES)).toBe(true);
  });

  it("does not apply another role's default to this role", () => {
    // gift_codes_sold is a reception-only card; medtech must not inherit it.
    expect(hiddenCardIdsFor("medtech", []).has(GIFT_CODES)).toBe(false);
  });

  it("honours a stored hide for a card id no longer in the registry", () => {
    const hidden = hiddenCardIdsFor("admin", [
      { card_id: "admin.retired_card", visible: false },
    ]);
    expect(hidden.has("admin.retired_card")).toBe(true);
  });
});

describe("matchesCardDefault", () => {
  it("treats visible as the default for an ordinary card", () => {
    expect(matchesCardDefault(card(VISITS_TODAY), true)).toBe(true);
    expect(matchesCardDefault(card(VISITS_TODAY), false)).toBe(false);
  });

  it("treats hidden as the default for a defaultHidden card", () => {
    expect(matchesCardDefault(card(GIFT_CODES), false)).toBe(true);
    expect(matchesCardDefault(card(GIFT_CODES), true)).toBe(false);
  });
});

describe("card registry", () => {
  it("has unique ids", () => {
    const ids = DASHBOARD_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every card at least one role", () => {
    for (const c of DASHBOARD_CARDS) {
      expect(c.roles.length).toBeGreaterThan(0);
    }
  });
});

it("registers both income bases and preserves independent saved visibility", () => {
  const ops = card("admin.net_income_mtd");
  const books = card("admin.net_income_books_mtd");
  expect(ops.label).toBe("Gross Profit (Ops)");
  expect(books.label).toBe("Net Income (Books)");
  expect(books.roles).toEqual(["admin"]);
  expect(books.group).toBe("money");
  expect(matchesCardDefault(books, true)).toBe(true);
  const hidden = hiddenCardIdsFor("admin", [{ card_id: ops.id, visible: false }]);
  expect(hidden.has(ops.id)).toBe(true);
  expect(hidden.has(books.id)).toBe(false);
  expect(hiddenCardIdsFor("admin", [{ card_id: books.id, visible: false }]).has(books.id)).toBe(true);
});

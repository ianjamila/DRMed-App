import { describe, expect, it } from "vitest";
import { CONS_H0, CONS_H1, CUST_HEADER, LAB_H0, LAB_H1 } from "../__fixtures__/tab-headers";
import type { Cell } from "../types";
import { parseCustomersTab } from "./customers";
import { money, parseConsultTab, parseLabTab } from "./encounters";

const TODAY = "2026-09-24";

const cust = (over: Record<number, Cell>) => {
  const r: Cell[] = new Array(22).fill("");
  r[4] = "Dela Cruz, Juan Santos"; r[5] = "Male"; r[6] = 32874; r[11] = 9171234567;
  r[16] = "FACEBOOK"; r[19] = "NEW"; r[20] = 46000.5;
  for (const [k, v] of Object.entries(over)) r[Number(k)] = v;
  return r;
};

describe("parseCustomersTab", () => {
  it("parses a row with the May importer's name/phone/sex rules", () => {
    const p = parseCustomersTab([CUST_HEADER, cust({})], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(1);
    const r = p.rows[0];
    expect(r).toMatchObject({
      sheetRow: 2, first: "Juan", middle: "Santos", last: "Dela Cruz",
      nameNorm: "dela cruz|juan santos", dob: "1990-01-01", phoneE164: "+639171234567",
      phone10: "9171234567", sex: "male", referralSourceId: "online_facebook", newRepeat: "new",
      registeredOn: "2025-12-09", dupCount: 1,
    });
    expect(r.raw["How did you know about DR Med?"]).toBe("FACEBOOK");
  });
  it("Minor 1 (round 2): the conflict-test phone and the filled phone always agree", () => {
    const cases: Cell[] = ["0639171234567", "09171234567", "639171234567", "9171234567", 9171234567, "+63 917 123 4567",
      "0917 123 4567 / 0918 765 4321", "(02) 8123 4567", "12345", "", "0917-123-4567 loc 12"];
    for (const phone of cases) {
      const [r] = parseCustomersTab([CUST_HEADER, cust({ 11: phone })], { today: TODAY, aliases: new Map() }).rows;
      // A number that would be written to patients.phone must also be the one conflict-tested.
      if (r.phoneE164) expect(r.phone10, String(phone)).toBe(r.phoneE164.slice(-10));
    }
    const [r] = parseCustomersTab([CUST_HEADER, cust({ 11: "0639171234567" })], { today: TODAY, aliases: new Map() }).rows;
    expect(r).toMatchObject({ phoneE164: "+639171234567", phone10: "9171234567" });
  });
  it("collapses exact duplicates into one row with a count", () => {
    const p = parseCustomersTab([CUST_HEADER, cust({}), cust({})], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].dupCount).toBe(2);
    expect(p.rowsRead).toBe(2);
  });
  it("raises unparseable_date for junk timestamps and keeps the row undated", () => {
    const p = parseCustomersTab([CUST_HEADER, cust({ 20: "GCASH" })], { today: TODAY, aliases: new Map() });
    expect(p.rows[0].registeredOn).toBeNull();
    expect(p.issues.map((i) => i.kind)).toEqual(["unparseable_date"]);
  });
  it("raises invalid_row when first or last name is missing", () => {
    const p = parseCustomersTab([CUST_HEADER, cust({ 4: "Madonna" })], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(0);
    expect(p.issues[0].kind).toBe("invalid_row");
  });
  it("refuses a tab whose headers moved", () => {
    const moved = [...CUST_HEADER]; moved.splice(4, 0, "New column");
    expect(() => parseCustomersTab([moved], { today: TODAY, aliases: new Map() })).toThrow(/header/i);
  });
  it("keeps a stable invalid_row key when a formula column (Age) changes", () => {
    const rowA = cust({ 4: "Madonna", 7: 30 });
    const rowB = cust({ 4: "Madonna", 7: 45 });
    const pA = parseCustomersTab([CUST_HEADER, rowA], { today: TODAY, aliases: new Map() });
    const pB = parseCustomersTab([CUST_HEADER, rowB], { today: TODAY, aliases: new Map() });
    expect(pA.issues).toHaveLength(1);
    expect(pA.issues[0].item_key).toBe(pB.issues[0].item_key);
  });
  it("tags a registered_on date issue with reason unparseable vs out_of_range", () => {
    const p1 = parseCustomersTab([CUST_HEADER, cust({ 20: "GCASH" })], { today: TODAY, aliases: new Map() });
    expect(p1.issues[0].payload).toMatchObject({ column: "Timestamp", reason: "unparseable" });

    const p2 = parseCustomersTab([CUST_HEADER, cust({ 20: "2027-01-01" })], { today: TODAY, aliases: new Map() });
    expect(p2.issues[0].payload).toMatchObject({ column: "Timestamp", reason: "out_of_range" });
  });
  it("tags a dob date issue with reason unparseable vs out_of_range", () => {
    const p1 = parseCustomersTab([CUST_HEADER, cust({ 6: "not a date" })], { today: TODAY, aliases: new Map() });
    const dobIssue1 = p1.issues.find((i) => i.payload.column === "Date of Birth");
    expect(dobIssue1?.payload).toMatchObject({ reason: "unparseable" });

    const p2 = parseCustomersTab([CUST_HEADER, cust({ 6: "2027-01-01" })], { today: TODAY, aliases: new Map() });
    const dobIssue2 = p2.issues.find((i) => i.payload.column === "Date of Birth");
    expect(dobIssue2?.payload).toMatchObject({ reason: "out_of_range" });
  });
  it("falls back to Last/First/M.I. columns when Full Name is blank", () => {
    const row = cust({ 4: "", 0: "Dela Cruz", 1: "Juan", 2: "Santos" });
    const p = parseCustomersTab([CUST_HEADER, row], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ first: "Juan", middle: "Santos", last: "Dela Cruz", fullNameRaw: "" });
  });
  it("leaves the senior/PWD pair null when a kind is given without a number", () => {
    const row = cust({ 13: "Senior", 14: "" });
    const p = parseCustomersTab([CUST_HEADER, row], { today: TODAY, aliases: new Map() });
    expect(p.rows[0]).toMatchObject({ seniorKind: null, seniorNumber: null });
  });
  it("lowercases email", () => {
    const row = cust({ 12: "Juan.DelaCruz@Example.COM" });
    const p = parseCustomersTab([CUST_HEADER, row], { today: TODAY, aliases: new Map() });
    expect(p.rows[0].email).toBe("juan.delacruz@example.com");
  });
  it("builds address the way the May importer did, collapsing a trailing-comma cell", () => {
    const row = cust({ 8: "12 Main St,", 9: "", 10: "Pasig," });
    const p = parseCustomersTab([CUST_HEADER, row], { today: TODAY, aliases: new Map() });
    expect(p.rows[0].address).toBe("12 Main St, Pasig");
  });
  it("merges an exact duplicate: never overwrites a set field, fills a null one", () => {
    const rowA = cust({ 16: "GOOGLE", 12: "" });
    const rowB = cust({ 16: "FACEBOOK", 12: "juan@example.com" });
    const p = parseCustomersTab([CUST_HEADER, rowA, rowB], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(1);
    const r = p.rows[0];
    expect(r.dupCount).toBe(2);
    expect(r.referralSourceId).toBe("online_google");
    expect(r.email).toBe("juan@example.com");
  });
  it("skips a formula-only filler row (bare comma + Age) silently: no issue, not counted", () => {
    const row: Cell[] = new Array(22).fill("");
    row[4] = ","; row[7] = 30; // Age is a spreadsheet formula that yields a value even on an empty row
    const p = parseCustomersTab([CUST_HEADER, row], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(0);
    expect(p.issues).toHaveLength(0);
    expect(p.rowsRead).toBe(0);
  });
  it("keeps a filler-looking row in play when any other cell (e.g. phone) is non-blank", () => {
    const row: Cell[] = new Array(22).fill("");
    row[4] = ","; row[7] = 30; row[11] = "9171234567";
    const p = parseCustomersTab([CUST_HEADER, row], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(0);
    expect(p.rowsRead).toBe(1);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0].kind).toBe("invalid_row");
  });
  it("keeps a blank surname before the comma as a review item even when the Last Name column is filled (D6)", () => {
    const row = cust({ 4: ", Juan Santos", 0: "Dela Cruz" });
    const p = parseCustomersTab([CUST_HEADER, row], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(0);
    expect(p.issues.map((i) => i.kind)).toEqual(["invalid_row"]);
  });
});

describe("money", () => {
  it("accepts a leading PHP/Php/P currency word", () => {
    expect(money("PHP 350")).toBe(350);
    expect(money("Php350")).toBe(350);
  });
  it("accepts trailing '/-' and a bare trailing '.'", () => {
    expect(money("350.")).toBe(350);
    expect(money("1,970/-")).toBe(1970);
  });
  it("still returns null for non-numeric or blank text", () => {
    expect(money("N/A")).toBeNull();
    expect(money("")).toBeNull();
    expect(money("cash")).toBeNull();
  });
});

describe("parseLabTab / parseConsultTab", () => {
  const WIN = "2026-05-26";
  it("keeps only rows inside [window start, today] and uses FINAL PRICE as revenue", () => {
    // Plan's test used serial 46167 for the "in-window" row and expected
    // serviceDate "2026-05-26" — but 46167 converts to 2026-05-25 (verified
    // independently: serial − 25569 = days since 1970-01-01). Bumped to
    // 46168 (and DATE RELEASED to 46169) so the row is actually inside the
    // window and the assertions mean what they say.
    const rows = [LAB_H0, LAB_H1,
      [46168, 1, 10, "Dela Cruz, Juan", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "Viber", 46169],
      [45261, 2, 11, "Reyes, Ana", "N/A", "", "", "CBC", 350, "", "", "", "", 350, "CASH", "", "", ""]];
    const p = parseLabTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rowsRead).toBe(2);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ serviceDate: "2026-05-26", finalPhp: 300, revenuePhp: 300,
      paymentMethodRaw: "CASH", releaseMediumRaw: "Viber", releasedOn: "2026-05-27", testNo: "10", controlNo: "1" });
    expect(p.lastDate).toBe("2026-05-26");
  });
  it("uses the CLINIC FEE as the consult revenue basis", () => {
    // Same serial fix as above: 46167 = 2026-05-25, which is before this
    // test's window start (2026-05-26) and would drop the row entirely.
    const rows = [CONS_H0, CONS_H1, [],
      [46168, "", "", "Dela Cruz, Juan", "N/A", "", "", "DR. A", 1000, "", "", 1000, 300, "CASH", "", ""]];
    const p = parseConsultTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rows[0]).toMatchObject({ finalPhp: 1000, clinicFeePhp: 300, revenuePhp: 300, doctorRaw: "DR. A",
      paymentMethodRaw: "CASH" });
  });
  it("reports junk dates as review items instead of dropping them silently", () => {
    const rows = [CONS_H0, CONS_H1, [3034 * 365, "", "", "Dela Cruz, Juan", "", "", "", "DR. A", 1, "", "", 1, 1, "CASH"]];
    const p = parseConsultTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rows).toHaveLength(0);
    expect(p.issues[0].kind).toBe("unparseable_date");
  });
  it("skips an in-window row whose name has no surname or first name, and reports it", () => {
    // "Madonna" has no comma and one token: parseName gives first_name only,
    // last_name null — a bare "surname|" or "|" identity key would collapse
    // different people. serial 46168 = 2026-05-26, inside WIN.
    const rows = [LAB_H0, LAB_H1,
      [46168, 1, 10, "Madonna", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "Viber", 46169]];
    const p = parseLabTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rows).toHaveLength(0);
    expect(p.rowsRead).toBe(1);
    expect(p.issues).toEqual([{
      kind: "invalid_row",
      item_key: expect.stringMatching(/^lab:/),
      payload: { tab: "lab", sheet_row: 3, reason: "name needs a surname and a first name", name_raw: "Madonna" },
    }]);
  });
  it("does not raise invalid_row for an unparseable name in OLD history (before the window)", () => {
    const rows = [LAB_H0, LAB_H1,
      [45261, 1, 10, "Madonna", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "", ""]];
    const p = parseLabTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rows).toHaveLength(0);
    expect(p.issues).toHaveLength(0);
  });
  it("refuses a LAB tab whose headers moved", () => {
    const moved = [...LAB_H0]; moved.splice(3, 0, "New column");
    expect(() => parseLabTab([moved, LAB_H1], { today: TODAY, windowStart: WIN })).toThrow(/header/i);
  });
  it("refuses a CONSULT tab whose headers moved", () => {
    const moved = [...CONS_H0]; moved.splice(3, 0, "New column");
    expect(() => parseConsultTab([moved, CONS_H1], { today: TODAY, windowStart: WIN })).toThrow(/header/i);
  });
  it("keeps a stable unparseable_date key when DATE RELEASED changes", () => {
    const rowA = [46168, 1, 10, "Madonna", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "Viber", 46169, "old remark"];
    const rowB = [...rowA]; rowB[17] = 12345; rowB[0] = "not a date";
    rowA[0] = "not a date";
    const pA = parseLabTab([LAB_H0, LAB_H1, rowA], { today: TODAY, windowStart: WIN });
    const pB = parseLabTab([LAB_H0, LAB_H1, rowB], { today: TODAY, windowStart: WIN });
    expect(pA.issues).toHaveLength(1);
    expect(pA.issues[0].item_key).toBe(pB.issues[0].item_key);
  });
  it("keeps a stable invalid_row key when REMARKS changes", () => {
    const rowA = [46168, 1, 10, "Madonna", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "Viber", 46169, "old remark"];
    const rowB = [...rowA]; rowB[18] = "a totally different remark";
    const pA = parseLabTab([LAB_H0, LAB_H1, rowA], { today: TODAY, windowStart: WIN });
    const pB = parseLabTab([LAB_H0, LAB_H1, rowB], { today: TODAY, windowStart: WIN });
    expect(pA.issues).toHaveLength(1);
    expect(pA.issues[0].kind).toBe("invalid_row");
    expect(pA.issues[0].item_key).toBe(pB.issues[0].item_key);
  });
  it("tags a DATE issue with reason unparseable vs out_of_range", () => {
    const badRow = [ "banana", 1, 10, "Dela Cruz, Juan", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "", ""];
    const p1 = parseLabTab([LAB_H0, LAB_H1, badRow], { today: TODAY, windowStart: WIN });
    expect(p1.issues[0].payload).toMatchObject({ reason: "unparseable" });

    const futureRow = [ "2027-01-01", 1, 10, "Dela Cruz, Juan", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "", ""];
    const p2 = parseLabTab([LAB_H0, LAB_H1, futureRow], { today: TODAY, windowStart: WIN });
    expect(p2.issues[0].payload).toMatchObject({ reason: "out_of_range" });
  });
  it("treats a junk DATE RELEASED as releasedOn null without raising an issue", () => {
    const rows = [LAB_H0, LAB_H1,
      [46168, 1, 10, "Dela Cruz, Juan", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "Viber", "MAX"]];
    const p = parseLabTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rows[0].releasedOn).toBeNull();
    expect(p.issues).toHaveLength(0);
  });
  it("counts rowsRead, in-window rows, and undated rows independently", () => {
    const rows = [LAB_H0, LAB_H1,
      [46168, 1, 10, "Dela Cruz, Juan", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "", ""],
      [45261, 2, 11, "Reyes, Ana", "N/A", "", "", "CBC", 350, "", "", "", "", 350, "CASH", "", "", ""],
      ["", 3, 12, "Santos, Maria", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "", ""]];
    const p = parseLabTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rowsRead).toBe(3);
    expect(p.rows).toHaveLength(1);
    expect(p.undated).toBe(1);
  });
});

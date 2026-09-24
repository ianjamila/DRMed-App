import { describe, expect, it } from "vitest";
import { CONS_H0, CONS_H1, CUST_HEADER, LAB_H0, LAB_H1 } from "../__fixtures__/tab-headers";
import type { Cell } from "../types";
import { parseCustomersTab } from "./customers";
import { parseConsultTab, parseLabTab } from "./encounters";

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
});

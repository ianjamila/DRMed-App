import { describe, it, expect } from "vitest";
import {
  channelLabel,
  enumerateDays,
  num,
  CHANNEL_ORDER,
  buildDailyMatrix,
  buildDoctorRollup,
  groupDaysByMonth,
} from "./daily-report";
import type { ChannelRow, TotalsRow, DoctorRow } from "./daily-report";

describe("channelLabel", () => {
  it("maps bank_transfer to BDO (per the manual sheet)", () => {
    expect(channelLabel("bank_transfer")).toBe("BDO");
  });
  it("maps the known channels", () => {
    expect(channelLabel("cash")).toBe("Cash");
    expect(channelLabel("gcash")).toBe("GCash");
    expect(channelLabel("bpi")).toBe("BPI");
    expect(channelLabel("card")).toBe("Card pay");
    expect(channelLabel("hmo")).toBe("HMO");
    expect(channelLabel("unpaid")).toBe("Unpaid");
  });
  it("falls back to the raw value for an unknown channel", () => {
    expect(channelLabel("crypto")).toBe("crypto");
  });
  it("CHANNEL_ORDER lists the six display channels without unpaid", () => {
    expect(CHANNEL_ORDER).toEqual(["cash", "gcash", "bpi", "bank_transfer", "card", "hmo"]);
  });
});

describe("enumerateDays", () => {
  it("is inclusive of both ends", () => {
    expect(enumerateDays("2026-06-01", "2026-06-03")).toEqual([
      "2026-06-01", "2026-06-02", "2026-06-03",
    ]);
  });
  it("crosses a month boundary correctly", () => {
    expect(enumerateDays("2026-01-30", "2026-02-02")).toEqual([
      "2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02",
    ]);
  });
  it("returns a single day when from === to", () => {
    expect(enumerateDays("2026-06-06", "2026-06-06")).toEqual(["2026-06-06"]);
  });
  it("returns [] when to is before from", () => {
    expect(enumerateDays("2026-06-06", "2026-06-01")).toEqual([]);
  });
});

describe("num", () => {
  it("coerces numeric strings (Supabase numeric columns arrive as strings)", () => {
    expect(num("23985.00")).toBe(23985);
  });
  it("treats null/undefined/'' as 0", () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("")).toBe(0);
  });
  it("passes numbers through", () => {
    expect(num(1668)).toBe(1668);
  });
});

describe("buildDailyMatrix", () => {
  const days = ["2023-12-04", "2023-12-05"];

  const channelRows: ChannelRow[] = [
    { business_date: "2023-12-04", section: "lab", channel: "cash",
      line_count: 37, distinct_customers: 8, sales_gross: "20000.00", discount: "1668.00", net: "18332.00" },
    { business_date: "2023-12-04", section: "lab", channel: "hmo",
      line_count: 13, distinct_customers: 4, sales_gross: "3985.00", discount: "0.00", net: "3985.00" },
    { business_date: "2023-12-04", section: "consult", channel: "gcash",
      line_count: 10, distinct_customers: 10, sales_gross: "7400.00", discount: "7400.00", net: "0.00" },
    { business_date: "2023-12-05", section: "lab", channel: "cash",
      line_count: 5, distinct_customers: 5, sales_gross: "5000.00", discount: "0.00", net: "5000.00" },
  ];

  const totalsRows: TotalsRow[] = [
    { business_date: "2023-12-04", section: "lab", line_count: 50, distinct_customers: 12,
      sales_gross: "23985.00", discount: "1668.00", net: "22317.00", pf_collected: "0.00" },
    { business_date: "2023-12-04", section: "consult", line_count: 10, distinct_customers: 10,
      sales_gross: "7400.00", discount: "7400.00", net: "0.00", pf_collected: "7400.00" },
    { business_date: "2023-12-05", section: "lab", line_count: 5, distinct_customers: 5,
      sales_gross: "5000.00", discount: "0.00", net: "5000.00", pf_collected: "0.00" },
  ];

  const m = buildDailyMatrix(channelRows, totalsRows, days);

  it("exposes the requested days as columns", () => {
    expect(m.days).toEqual(days);
  });
  it("has a lab section and a consult section", () => {
    expect(m.sections.map((s) => s.section)).toEqual(["lab", "consult"]);
    expect(m.sections[0].title).toBe("Lab tests");
    expect(m.sections[1].title).toBe("Doctor consult");
  });
  it("lab distinct-customers row uses the cross-channel total (12, not 8+4)", () => {
    const lab = m.sections.find((s) => s.section === "lab")!;
    const cust = lab.rows.find((r) => r.metric === "customers")!;
    expect(cust.byDay["2023-12-04"]).toBe(12);
  });
  it("lab #tests row is the section line_count total", () => {
    const lab = m.sections.find((s) => s.section === "lab")!;
    const count = lab.rows.find((r) => r.metric === "count")!;
    expect(count.byDay["2023-12-04"]).toBe(50);
    expect(count.total).toBe(55);
  });
  it("emits a per-channel gross-sales row for each display channel with data", () => {
    const lab = m.sections.find((s) => s.section === "lab")!;
    const cash = lab.rows.find((r) => r.metric === "sales" && r.channel === "cash")!;
    const hmo = lab.rows.find((r) => r.metric === "sales" && r.channel === "hmo")!;
    expect(cash.byDay["2023-12-04"]).toBe(20000);
    expect(hmo.byDay["2023-12-04"]).toBe(3985);
  });
  it("omits a channel row that has no data in the range (e.g. BPI)", () => {
    const lab = m.sections.find((s) => s.section === "lab")!;
    expect(lab.rows.some((r) => r.metric === "sales" && r.channel === "bpi")).toBe(false);
  });
  it("lab sales-total row equals the section gross total", () => {
    const lab = m.sections.find((s) => s.section === "lab")!;
    const salesTotal = lab.rows.find((r) => r.metric === "sales" && r.channel === undefined)!;
    expect(salesTotal.byDay["2023-12-04"]).toBe(23985);
    expect(salesTotal.total).toBe(28985);
  });
  it("consult section carries a PF-collected row", () => {
    const consult = m.sections.find((s) => s.section === "consult")!;
    const pf = consult.rows.find((r) => r.metric === "pf")!;
    expect(pf.byDay["2023-12-04"]).toBe(7400);
  });
  it("grand totals are LAB + CONSULT only and don't double-count", () => {
    expect(m.totals.revenue.byDay["2023-12-04"]).toBe(31385);
    expect(m.totals.discount.byDay["2023-12-04"]).toBe(9068);
    expect(m.totals.net.byDay["2023-12-04"]).toBe(22317);
    expect(m.totals.revenue.total).toBe(36385);
  });
});

describe("buildDoctorRollup", () => {
  const rows: DoctorRow[] = [
    { business_date: "2023-12-04", physician_id: "p1", full_name: "Dr Gayo", specialty: "Internal Medicine",
      compensation_arrangement: "shareholder", consult_count: 3, sales_gross: "0.00", pf_collected: "1500.00" },
    { business_date: "2023-12-05", physician_id: "p1", full_name: "Dr Gayo", specialty: "Internal Medicine",
      compensation_arrangement: "shareholder", consult_count: 2, sales_gross: "0.00", pf_collected: "1000.00" },
    { business_date: "2023-12-04", physician_id: "p2", full_name: "Dr Cruz", specialty: "Internal Medicine",
      compensation_arrangement: "pf_split", consult_count: 1, sales_gross: "100.00", pf_collected: "400.00" },
    { business_date: "2023-12-04", physician_id: null, full_name: null, specialty: null,
      compensation_arrangement: null, consult_count: 4, sales_gross: "1600.00", pf_collected: "0.00" },
  ];

  const groups = buildDoctorRollup(rows);

  it("groups doctors by specialty, with an Unattributed bucket last", () => {
    expect(groups.map((g) => g.specialty)).toEqual(["Internal Medicine", "Unattributed"]);
  });
  it("aggregates a doctor across days", () => {
    const im = groups.find((g) => g.specialty === "Internal Medicine")!;
    const gayo = im.doctors.find((d) => d.name === "Dr Gayo")!;
    expect(gayo.consultCount).toBe(5);
    expect(gayo.pfCollected).toBe(2500);
    expect(gayo.salesGross).toBe(0);
  });
  it("flags shareholder/rent doctors as clinic-₱0-by-design", () => {
    const im = groups.find((g) => g.specialty === "Internal Medicine")!;
    expect(im.doctors.find((d) => d.name === "Dr Gayo")!.clinicZeroByDesign).toBe(true);
    expect(im.doctors.find((d) => d.name === "Dr Cruz")!.clinicZeroByDesign).toBe(false);
  });
  it("labels the null-physician group Unattributed", () => {
    const un = groups.find((g) => g.specialty === "Unattributed")!;
    expect(un.doctors[0].name).toBe("Unattributed");
    expect(un.doctors[0].consultCount).toBe(4);
  });
  it("rolls up specialty subtotals", () => {
    const im = groups.find((g) => g.specialty === "Internal Medicine")!;
    expect(im.consultCount).toBe(6);
    expect(im.salesGross).toBe(100);
    expect(im.pfCollected).toBe(2900);
  });
});

describe("groupDaysByMonth", () => {
  it("groups consecutive days into chronological months", () => {
    const g = groupDaysByMonth(["2026-01-30", "2026-01-31", "2026-02-01"]);
    expect(g.map((x) => x.key)).toEqual(["2026-01", "2026-02"]);
    expect(g[0].label).toBe("Jan");
    expect(g[0].dates).toEqual(["2026-01-30", "2026-01-31"]);
    expect(g[1].dates).toEqual(["2026-02-01"]);
  });
  it("appends the year when the range spans multiple years", () => {
    const g = groupDaysByMonth(["2025-12-31", "2026-01-01"]);
    expect(g.map((x) => x.label)).toEqual(["Dec 2025", "Jan 2026"]);
  });
  it("returns [] for no days", () => {
    expect(groupDaysByMonth([])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  aggregateLabTat,
  LAB_TAT_CSV_HEADER,
  labTatCsvFilename,
  labTatCsvHref,
  labTatCsvRows,
  median,
  parseLabTatParams,
  percentile,
  type ReleasedRow,
} from "./lab-tat";

const TODAY = "2026-09-08";

describe("parseLabTatParams", () => {
  it("defaults to the last 30 days, all sections", () => {
    expect(parseLabTatParams({}, TODAY)).toEqual({ start: "2026-08-09", end: TODAY, section: "" });
  });
  it("keeps a real section and drops an unknown one", () => {
    expect(parseLabTatParams({ section: "chemistry" }, TODAY).section).toBe("chemistry");
    expect(parseLabTatParams({ section: "dentistry" }, TODAY).section).toBe("");
  });
  it("falls back on garbage dates instead of passing them to the DB", () => {
    expect(parseLabTatParams({ start: "08/01/2026", end: "x" }, TODAY)).toEqual({ start: "2026-08-09", end: TODAY, section: "" });
  });
});

describe("median / percentile", () => {
  it("handle empty, odd and even sets", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});

const row = (
  id: string,
  requested: string,
  released: string | null,
  section: string | null,
  sla: number | null,
): ReleasedRow => ({
  id,
  requested_at: requested,
  released_at: released,
  status: "released",
  services: { name: `Svc ${id}`, section, turnaround_hours: sla },
  visits: { visit_number: "0001", patients: { first_name: "Ana", last_name: "Cruz" } },
});

const released: ReleasedRow[] = [
  row("a", "2026-09-01T00:00:00Z", "2026-09-01T02:00:00Z", "chemistry", 4),   // 2h, within SLA
  row("b", "2026-09-01T00:00:00Z", "2026-09-01T06:00:00Z", "chemistry", 4),   // 6h, breach
  row("c", "2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z", "hematology", 24), // 92d, outlier → counted, not sampled
  row("d", "2026-09-01T00:00:00Z", null, "hematology", 24),                   // never released → skipped
];

describe("aggregateLabTat", () => {
  const agg = aggregateLabTat(released);

  it("groups per section, counting every release but sampling only sane TATs", () => {
    expect(agg.metrics.map((m) => [m.section, m.totalReleased, m.tatSamples.length, m.slaBreaches])).toEqual([
      ["chemistry", 2, 2, 1],
      ["hematology", 1, 0, 0],
    ]);
    expect(agg.metrics[0]?.worstTatRequestId).toBe("b");
  });

  it("emits one sample per sane release with the breach flag", () => {
    expect(agg.samples.map((s) => [s.requestId, s.tatHours, s.breach])).toEqual([
      ["a", 2, false],
      ["b", 6, true],
    ]);
    expect(agg.slaBreachRows.map((s) => s.requestId)).toEqual(["b"]);
  });

  it("rolls up the overall figures", () => {
    expect(agg.overall).toEqual({ median: 4, p95: 6, totalReleased: 3, totalBreaches: 1, breachPct: 33 });
  });

  it("labels a null section '(unset)' and caps the breach detail at 20 in row order", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      row(`m${i}`, "2026-09-01T00:00:00Z", "2026-09-01T09:00:00Z", null, 4),
    );
    const wide = aggregateLabTat(many);
    expect(wide.metrics[0]?.section).toBe("(unset)");
    expect(wide.overall.totalBreaches).toBe(25);
    expect(wide.slaBreachRows).toHaveLength(20);
    expect(wide.slaBreachRows[0]?.requestId).toBe("m0");
    expect(wide.slaBreachRows[19]?.requestId).toBe("m19");
  });
});

describe("labTatCsvRows", () => {
  it("one row per sample, Manila stamps, one-decimal hours", () => {
    const out = labTatCsvRows(aggregateLabTat(released).samples);
    expect(out[0]).toEqual([...LAB_TAT_CSV_HEADER]);
    expect(out[1]).toEqual(["Chemistry", "Svc a", "Cruz, Ana", "0001", "2026-09-01 08:00", "2026-09-01 10:00", "2.0", 4, "no"]);
    expect(out[2]).toEqual(["Chemistry", "Svc b", "Cruz, Ana", "0001", "2026-09-01 08:00", "2026-09-01 14:00", "6.0", 4, "yes"]);
  });
});

describe("href / filename", () => {
  it("omits an empty section and includes a set one", () => {
    expect(labTatCsvHref({ start: "2026-08-09", end: TODAY, section: "" })).toBe("/api/admin/reports/lab-tat.csv?start=2026-08-09&end=2026-09-08");
    expect(labTatCsvHref({ start: "2026-08-09", end: TODAY, section: "chemistry" })).toBe("/api/admin/reports/lab-tat.csv?start=2026-08-09&end=2026-09-08&section=chemistry");
    expect(labTatCsvFilename({ start: "2026-08-09", end: TODAY, section: "" })).toBe("lab-tat-2026-08-09_2026-09-08.csv");
    expect(labTatCsvFilename({ start: "2026-08-09", end: TODAY, section: "chemistry" })).toBe("lab-tat-2026-08-09_2026-09-08-chemistry.csv");
  });
});

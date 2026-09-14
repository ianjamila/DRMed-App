import { describe, expect, it } from "vitest";
import {
  aggregateLabTat,
  LAB_TAT_CSV_HEADER,
  labTatCsvFilename,
  labTatCsvHref,
  labTatCsvRows,
  loadLabTat,
  median,
  parseLabTatParams,
  percentile,
  type ReleasedRow,
} from "./lab-tat";
import type { ServiceSection } from "@/lib/auth/role-sections";

const TODAY = "2026-09-08";

describe("parseLabTatParams", () => {
  it("defaults to the last 30 days, all sections", () => {
    expect(parseLabTatParams({}, TODAY)).toEqual({ start: "2026-08-09", end: TODAY, section: "" });
  });
  it("keeps a real section and drops an unknown one", () => {
    expect(parseLabTatParams({ section: "chemistry" }, TODAY).section).toBe("chemistry");
    expect(parseLabTatParams({ section: "dentistry" }, TODAY).section).toBe("");
  });
  it("drops a doctor section — it can no longer match a row, so it reads as all", () => {
    // Selecting Consultation used to mean "0 released, 1 pending"; now the
    // report excludes doctor lines outright, so a stale ?section=consultation
    // bookmark must widen to All rather than render an empty, quiet-looking lab.
    expect(parseLabTatParams({ section: "consultation" }, TODAY).section).toBe("");
    expect(parseLabTatParams({ section: "procedure" }, TODAY).section).toBe("");
  });
  it("keeps the lab-side sections a reader might mistake for doctor work", () => {
    expect(parseLabTatParams({ section: "vaccine" }, TODAY).section).toBe("vaccine");
    expect(parseLabTatParams({ section: "home_service" }, TODAY).section).toBe("home_service");
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

// ---------------------------------------------------------------------------
// Query shape — the doctor-line exclusion lives in the PostgREST filters, so
// it is asserted on the calls the loader makes rather than on its output.
// ---------------------------------------------------------------------------

const CHAIN_METHODS = [
  "select", "eq", "in", "is", "not", "gte", "lt", "order", "range", "returns", "limit",
] as const;

interface RecordedQuery {
  table: string;
  calls: { fn: string; args: unknown[] }[];
}

/**
 * A chainable stand-in for a supabase-js builder that records every call.
 * Each method returns the same object and the object is thenable, which is
 * all `fetchAllRows` and a direct `await` need — enough to assert the SHAPE
 * of a query with no database in sight (vitest.config: pure logic only).
 */
function recordingClient(count = 0) {
  const queries: RecordedQuery[] = [];
  const builderFor = (table: string) => {
    const q: RecordedQuery = { table, calls: [] };
    queries.push(q);
    const b: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count }).then(res, rej),
    };
    for (const m of CHAIN_METHODS) {
      b[m] = (...args: unknown[]) => {
        q.calls.push({ fn: m, args });
        return b;
      };
    }
    return b;
  };
  return { client: { from: builderFor }, queries };
}

const argsOf = (q: RecordedQuery, fn: string): unknown[][] =>
  q.calls.filter((c) => c.fn === fn).map((c) => c.args);

const DOCTOR_NOT_IN = ["services.kind", "in", "(doctor_consultation,doctor_procedure)"];

const runLoadLabTat = async (section: ServiceSection | "" = "", count = 0) => {
  const { client, queries } = recordingClient(count);
  const report = await loadLabTat(
    client as unknown as Parameters<typeof loadLabTat>[0],
    { start: "2026-09-01", end: "2026-09-08", section },
    20_000,
  );
  // [0] = released samples, [1] = the pending head-count.
  return { report, released: queries[0]!, pending: queries[1]! };
};

describe("loadLabTat query shape", () => {
  it("excludes doctor lines from the released samples", async () => {
    const { released } = await runLoadLabTat();
    expect(released.table).toBe("test_requests");
    expect(argsOf(released, "not")).toContainEqual(DOCTOR_NOT_IN);
  });

  it("excludes doctor lines from the pending count too", async () => {
    const { pending } = await runLoadLabTat();
    expect(pending.table).toBe("test_requests");
    expect(argsOf(pending, "not")).toContainEqual(DOCTOR_NOT_IN);
  });

  it("enumerates the doctor kinds rather than allow-listing the lab ones", async () => {
    // An allow-list would make a newly seeded kind vanish from the report
    // silently (0126). Nothing may pin the query to the lab kinds by name.
    const { released, pending } = await runLoadLabTat();
    for (const q of [released, pending]) {
      const inFilters = JSON.stringify(argsOf(q, "in"));
      for (const lab of ["lab_test", "lab_package", "vaccine", "home_service"]) {
        expect(inFilters).not.toContain(lab);
      }
    }
  });

  it("keeps the released window and status filters alongside the new one", async () => {
    const { released } = await runLoadLabTat();
    expect(argsOf(released, "eq")).toContainEqual(["status", "released"]);
    expect(argsOf(released, "gte").map((a) => a[0])).toContain("released_at");
    expect(argsOf(released, "lt").map((a) => a[0])).toContain("released_at");
  });

  it("keeps the pending query's live-lines filter", async () => {
    const { pending } = await runLoadLabTat();
    expect(argsOf(pending, "is")).toContainEqual(["deleted_at", null]);
  });

  it("excludes deleted lines and deleted visits from the released query too", async () => {
    // This assertion used to be its own inverse: the released query omitted
    // both filters, on the reasoning that 0125's guard raises P0043 when
    // soft-deleting a line whose status is already 'released', so they could
    // never exclude a row. Prod agreed — zero rows were both released and
    // soft-deleted — and that is still true, so nothing this report prints
    // moves. But it is a claim about ORDER, and the database enforces only
    // one direction of it: a line deleted at ready_for_release could still be
    // released afterwards, and deleting a VISIT never cascaded to its lines
    // at all. Both are now filtered at the source (the release actions refuse
    // a deleted visit), and the report states the invariant rather than
    // inheriting it.
    const { released } = await runLoadLabTat();
    expect(argsOf(released, "is")).toContainEqual(["deleted_at", null]);
    expect(argsOf(released, "is")).toContainEqual(["visits.deleted_at", null]);
  });

  it("embeds visits as an INNER join so the visits.deleted_at filter applies", async () => {
    // PostgREST silently ignores a filter on a LEFT-joined embed, so a plain
    // `visits ( … )` embed would make the assertion above pass while the query
    // returned unfiltered rows.
    const { released } = await runLoadLabTat();
    const selects = argsOf(released, "select").flat().join(" ");
    expect(selects).toMatch(/visits\s*!\s*inner/);
  });

  it("applies a lab section filter to both queries when one is chosen", async () => {
    const { released, pending } = await runLoadLabTat("chemistry");
    expect(argsOf(released, "eq")).toContainEqual(["services.section", "chemistry"]);
    expect(argsOf(pending, "eq")).toContainEqual(["services.section", "chemistry"]);
  });

  it("applies no section filter for 'all sections'", async () => {
    const { released, pending } = await runLoadLabTat("");
    for (const q of [released, pending]) {
      expect(argsOf(q, "eq").map((a) => a[0])).not.toContain("services.section");
    }
  });

  it("reports the pending count the query returned", async () => {
    const { report } = await runLoadLabTat("", 7);
    expect(report.pendingTotal).toBe(7);
  });
});

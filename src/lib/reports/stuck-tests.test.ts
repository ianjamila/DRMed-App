import { describe, expect, it } from "vitest";
import {
  ageDays,
  compareStuckRows,
  headerCandidateIsSettled,
  loadStuckTests,
  parseStuckTestsParams,
  STUCK_DEFAULT_SORT,
  STUCK_TESTS_CSV_HEADER,
  stuckTestsCsvFilename,
  stuckTestsCsvHref,
  stuckTestsCsvRows,
  type EmptyVisitRow,
  type StuckRow,
} from "./stuck-tests";

describe("parseStuckTestsParams", () => {
  it("defaults to 3 days and clamps to 1..365 whole days", () => {
    expect(parseStuckTestsParams({})).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "10.9" })).toEqual({ days: 10 });
    expect(parseStuckTestsParams({ days: "0" })).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "400" })).toEqual({ days: 3 });
    expect(parseStuckTestsParams({ days: "abc" })).toEqual({ days: 3 });
  });
});

describe("ageDays", () => {
  it("floors whole days from an injected now", () => {
    const now = Date.parse("2026-09-08T10:00:00Z");
    expect(ageDays("2026-09-05T11:00:00Z", now)).toBe(2);
    expect(ageDays("2026-09-05T09:00:00Z", now)).toBe(3);
  });
});

const NOW = Date.parse("2026-09-08T10:00:00Z");
const stuck: StuckRow = {
  id: "t1", status: "in_progress", requested_at: "2026-09-01T02:00:00Z", assigned_to: "u1", visit_id: "v1",
  services: { code: "CBC", name: "CBC" },
  visits: { visit_number: "0042", payment_status: "paid", hmo_provider_id: null, patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" } },
};
const header: StuckRow = {
  id: "h1", status: "ready_for_release", requested_at: "2026-09-02T02:00:00Z", assigned_to: null, visit_id: "v2",
  services: [{ code: "ROUTINE", name: "Routine package" }],
  visits: [{ visit_number: "0043", payment_status: "waived", hmo_provider_id: null, patients: [{ first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" }] }],
};
const empty: EmptyVisitRow = {
  id: "v3", visit_number: "0044", created_at: "2026-09-07T02:00:00Z", total_php: 0, payment_status: "unpaid",
  patients: { first_name: "Cy", last_name: "Ek", drm_id: "DRM-3" },
};

describe("headerCandidateIsSettled", () => {
  const withVisit = (payment_status: string, hmo_provider_id: string | null): StuckRow => ({
    ...header,
    visits: [{ visit_number: "0043", payment_status, hmo_provider_id, patients: [{ first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" }] }],
  });

  it("counts an HMO visit as settled even though it is never paid", () => {
    // The A3 case: an HMO visit's payment_status stays 'unpaid' forever, so
    // a paid/waived-only filter hid exactly the headers this report exists
    // to surface.
    expect(headerCandidateIsSettled(withVisit("unpaid", "hmo-1"))).toBe(true);
  });

  it("counts paid and waived visits as settled", () => {
    expect(headerCandidateIsSettled(withVisit("paid", null))).toBe(true);
    expect(headerCandidateIsSettled(withVisit("waived", null))).toBe(true);
  });

  it("does not count an unpaid non-HMO visit, whose header is legitimately withheld", () => {
    expect(headerCandidateIsSettled(withVisit("unpaid", null))).toBe(false);
  });

  it("does not count a row whose visit embed is missing", () => {
    expect(headerCandidateIsSettled({ ...header, visits: null })).toBe(false);
  });
});

describe("stuckTestsCsvRows", () => {
  it("unions the four lists under a List column", () => {
    const out = stuckTestsCsvRows(
      { stuck: [stuck], stuckHeaders: [header], orphanHeaders: [], emptyVisits: [empty] },
      new Map([["u1", "Med Tech"]]),
      NOW,
    );
    expect(out[0]).toEqual([...STUCK_TESTS_CSV_HEADER]);
    expect(out[1]).toEqual(["Stuck test", 7, "2026-09-01 10:00", "0042", "Cruz, Ana", "DRM-1", "CBC", "CBC", "in_progress", "Med Tech", "paid", ""]);
    expect(out[2]).toEqual(["Package header not auto-released", 6, "2026-09-02 10:00", "0043", "Dy, Ben", "DRM-2", "ROUTINE", "Routine package", "ready_for_release", "", "waived", ""]);
    expect(out[3]).toEqual(["Visit with no tests", 1, "2026-09-07 10:00", "0044", "Ek, Cy", "DRM-3", "", "", "", "", "unpaid", "0.00"]);
  });
});

describe("href / filename", () => {
  it("carries the threshold", () => {
    expect(stuckTestsCsvHref({ days: 3 })).toBe("/api/admin/reports/stuck-tests.csv?days=3");
    expect(stuckTestsCsvFilename({ days: 3 }, "2026-09-08")).toBe("stuck-tests-3d-2026-09-08.csv");
  });
});

describe("compareStuckRows", () => {
  const claimerNames = new Map<string, string>([
    ["u1", "Med Tech One"],
    ["u2", "Med Tech Two"],
  ]);

  function row(overrides: Partial<StuckRow> & { id: string }): StuckRow {
    return {
      status: "in_progress",
      requested_at: "2026-09-01T00:00:00Z",
      assigned_to: null,
      visit_id: "v1",
      services: { code: "CBC", name: "CBC" },
      visits: {
        visit_number: "0001",
        payment_status: "paid",
        hmo_provider_id: null,
        patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" },
      },
      ...overrides,
    };
  }

  it("defaults to age desc, which is requested_at ASCENDING — oldest row first", () => {
    // Age counts UP the longer a row has sat untouched, so the OLDEST row has
    // the LARGEST age and the SMALLEST requested_at. Get the sign backwards
    // and the default silently reads "newest first" instead of "oldest".
    const oldest = row({ id: "a", requested_at: "2026-08-01T00:00:00Z" });
    const middle = row({ id: "b", requested_at: "2026-08-15T00:00:00Z" });
    const newest = row({ id: "c", requested_at: "2026-09-01T00:00:00Z" });
    const sorted = [newest, oldest, middle].sort((x, y) =>
      compareStuckRows(x, y, STUCK_DEFAULT_SORT, claimerNames),
    );
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("age ascending is the inverse of the default — newest row first", () => {
    const oldest = row({ id: "a", requested_at: "2026-08-01T00:00:00Z" });
    const newest = row({ id: "c", requested_at: "2026-09-01T00:00:00Z" });
    const sorted = [oldest, newest].sort((x, y) =>
      compareStuckRows(x, y, { key: "age", dir: "asc" }, claimerNames),
    );
    expect(sorted.map((r) => r.id)).toEqual(["c", "a"]);
  });

  it("same requested_at falls through to the uuid id tie-break", () => {
    const higherId = row({ id: "z1", requested_at: "2026-08-01T00:00:00Z" });
    const lowerId = row({ id: "a1", requested_at: "2026-08-01T00:00:00Z" });
    const sorted = [higherId, lowerId].sort((x, y) =>
      compareStuckRows(x, y, STUCK_DEFAULT_SORT, claimerNames),
    );
    expect(sorted.map((r) => r.id)).toEqual(["a1", "z1"]);
  });

  it("`visit` compares visit_number as TEXT, never Number(), and keeps page slices stable", () => {
    // The literal prod mix: zero-padded numeric visit numbers alongside three
    // historical-import shapes. Number() on any of the latter three is NaN,
    // NaN - NaN is NaN, and `cmp !== 0` is TRUE for NaN — so the id tie-break
    // below would never be reached, and Array.sort could reorder same-visit
    // rows however it likes between renders, which is what actually shifts
    // rows across a page boundary.
    const withVisit = (id: string, visit_number: string) =>
      row({
        id,
        visits: {
          visit_number,
          payment_status: "paid",
          hmo_provider_id: null,
          patients: { first_name: "Ana", last_name: "Cruz", drm_id: "DRM-1" },
        },
      });

    const a = withVisit("id-a", "#0H-1");
    const b = withVisit("id-b", "#H-1001");
    const c = withVisit("id-c", "#H-LAB_SERVICE-0-3");
    const d = withVisit("id-d", "0042");

    expect(compareStuckRows(a, b, { key: "visit", dir: "asc" }, claimerNames)).toBe(
      "#0H-1".localeCompare("#H-1001"),
    );

    // Two rows sharing the SAME visit_number (sibling lines on one visit)
    // compare 0 on `visit` and must fall through to the id tie-break rather
    // than whatever order Array.sort happens to leave them in.
    const sameVisit1 = withVisit("row-2", "0042");
    const sameVisit2 = withVisit("row-1", "0042");
    expect(
      compareStuckRows(sameVisit1, sameVisit2, { key: "visit", dir: "asc" }, claimerNames),
    ).toBe("row-2".localeCompare("row-1"));

    // Paging proof: sort the same six rows starting from three different
    // input orders and slice a "page" out of each. If the comparator ever
    // regressed to Number() (NaN for every non-numeric visit_number here),
    // ties would stop resolving deterministically and this would flake.
    const all = [a, b, c, d, sameVisit1, sameVisit2];
    const sortAndPage = (input: StuckRow[]) =>
      [...input]
        .sort((x, y) => compareStuckRows(x, y, { key: "visit", dir: "asc" }, claimerNames))
        .map((r) => r.id);
    const forward = sortAndPage(all);
    const reversed = sortAndPage([...all].reverse());
    const shuffled = sortAndPage([c, a, sameVisit1, d, b, sameVisit2]);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
    expect(forward.slice(0, 3)).toEqual(reversed.slice(0, 3));
    expect(forward.slice(0, 3)).toEqual(shuffled.slice(0, 3));
  });

  it("`claimed` sinks an unclaimed row regardless of direction", () => {
    const claimed = row({ id: "a", assigned_to: "u1" });
    const unclaimed = row({ id: "b", assigned_to: null });
    expect(
      compareStuckRows(claimed, unclaimed, { key: "claimed", dir: "asc" }, claimerNames),
    ).toBeLessThan(0);
    expect(
      compareStuckRows(claimed, unclaimed, { key: "claimed", dir: "desc" }, claimerNames),
    ).toBeLessThan(0);
  });

  it("`claimed` also sinks an assigned_to whose name never resolved", () => {
    const resolved = row({ id: "a", assigned_to: "u1" });
    const unresolved = row({ id: "b", assigned_to: "ghost-staff-id" });
    expect(
      compareStuckRows(resolved, unresolved, { key: "claimed", dir: "asc" }, claimerNames),
    ).toBeLessThan(0);
  });

  it("`patient`, `test`, `status` and `payment` compare their printed text", () => {
    const ana = row({ id: "a" });
    const ben = row({
      id: "b",
      visits: {
        visit_number: "0002",
        payment_status: "unpaid",
        hmo_provider_id: null,
        patients: { first_name: "Ben", last_name: "Dy", drm_id: "DRM-2" },
      },
    });
    expect(compareStuckRows(ana, ben, { key: "patient", dir: "asc" }, claimerNames)).toBeLessThan(0); // Cruz < Dy

    const cbc = row({ id: "c", services: { code: "CBC", name: "CBC" } });
    const urine = row({ id: "d", services: { code: "UA", name: "Urinalysis" } });
    expect(compareStuckRows(cbc, urine, { key: "test", dir: "asc" }, claimerNames)).toBeLessThan(0);

    const readyForRelease = row({ id: "e", status: "ready_for_release" });
    const requested = row({ id: "f", status: "requested" });
    expect(
      compareStuckRows(readyForRelease, requested, { key: "status", dir: "asc" }, claimerNames),
    ).toBeLessThan(0); // "ready_for_release" < "requested"

    expect(compareStuckRows(ana, ben, { key: "payment", dir: "asc" }, claimerNames)).toBeLessThan(0); // "paid" < "unpaid"
  });

  it("every column ends in the uuid id tie-break, ascending", () => {
    const first = row({ id: "row-1" });
    const second = row({ id: "row-2" });
    // Identical everything except id — every branch must fall through to it.
    for (const key of ["patient", "test", "status", "payment"] as const) {
      expect(compareStuckRows(first, second, { key, dir: "asc" }, claimerNames)).toBe(
        "row-1".localeCompare("row-2"),
      );
    }
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
function recordingClient() {
  const queries: RecordedQuery[] = [];
  const builderFor = (table: string) => {
    const q: RecordedQuery = { table, calls: [] };
    queries.push(q);
    const b: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej),
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

const runLoadStuckTests = async () => {
  const { client, queries } = recordingClient();
  await loadStuckTests(
    client as unknown as Parameters<typeof loadStuckTests>[0],
    { days: 3 },
    20_000,
    NOW,
  );
  // Every list comes back empty, so the claimer lookup makes no call and the
  // four data queries land in a fixed order.
  return {
    stuck: queries[0]!,
    orphanHeaders: queries[1]!,
    emptyVisits: queries[2]!,
    packageHeaders: queries[3]!,
    queries,
  };
};

describe("loadStuckTests query shape", () => {
  it("excludes doctor lines from the stuck list", async () => {
    const { stuck } = await runLoadStuckTests();
    expect(stuck.table).toBe("test_requests");
    expect(argsOf(stuck, "not")).toContainEqual(DOCTOR_NOT_IN);
  });

  it("enumerates the doctor kinds rather than allow-listing the lab ones", async () => {
    // An allow-list would make a newly seeded kind vanish from the report
    // silently (0126). The only `.in()` here is the status list.
    const { stuck } = await runLoadStuckTests();
    const inFilters = JSON.stringify(argsOf(stuck, "in"));
    for (const lab of ["lab_test", "lab_package", "vaccine", "home_service"]) {
      expect(inFilters).not.toContain(lab);
    }
  });

  it("keeps the stuck list's existing filters alongside the new one", async () => {
    const { stuck } = await runLoadStuckTests();
    expect(argsOf(stuck, "in")).toContainEqual([
      "status",
      ["requested", "in_progress", "result_uploaded", "ready_for_release"],
    ]);
    expect(argsOf(stuck, "eq")).toContainEqual(["is_package_header", false]);
    expect(argsOf(stuck, "is")).toContainEqual(["deleted_at", null]);
    expect(argsOf(stuck, "is")).toContainEqual(["visits.deleted_at", null]);
    expect(argsOf(stuck, "lt").map((a) => a[0])).toContain("requested_at");
  });

  it("leaves the integrity lists unfiltered — a package header is never a doctor line", async () => {
    const { orphanHeaders, emptyVisits, packageHeaders } = await runLoadStuckTests();
    expect(orphanHeaders.table).toBe("test_requests");
    expect(packageHeaders.table).toBe("test_requests");
    expect(argsOf(orphanHeaders, "eq")).toContainEqual(["is_package_header", true]);
    expect(argsOf(packageHeaders, "eq")).toContainEqual(["is_package_header", true]);
    for (const q of [orphanHeaders, emptyVisits, packageHeaders]) {
      expect(argsOf(q, "not")).not.toContainEqual(DOCTOR_NOT_IN);
    }
    // emptyVisits counts test_request ROWS per visit — a consultation-only
    // visit has a bill line and is correctly not "empty".
    expect(emptyVisits.table).toBe("visits");
    expect(argsOf(emptyVisits, "is")).toContainEqual(["lines", null]);
  });

  it("makes no claimer lookup when nothing is stuck", async () => {
    const { queries } = await runLoadStuckTests();
    expect(queries.map((q) => q.table)).toEqual([
      "test_requests",
      "test_requests",
      "visits",
      "test_requests",
    ]);
  });
});

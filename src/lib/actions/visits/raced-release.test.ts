import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const reported = vi.hoisted(() => [] as Array<{ scope: string }>);
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (a: { scope: string }) => void reported.push(a),
}));

import { makeFakeReleaseDb, type FakeTestRow } from "./fake-release-db";
import { RACED_REASON } from "./release-reports";
import { describeRacedRelease, staffShortName } from "./raced-release";

// Fixed "now": 2026-10-01 12:00 in Manila (UTC+8, no DST).
const NOW = new Date("2026-10-01T04:00:00Z");
const TODAY_2_14_PM = "2026-10-01T06:14:00+00:00"; // 2:14 PM Manila, same day as NOW
const OTHER_DAY = "2026-09-30T06:14:00+00:00"; // Sep 30, 2:14 PM Manila
const OTHER_YEAR = "2025-12-30T06:14:00+00:00";
const STAFF = { maria: "Maria Santos", me: "Ian Jamila" };

function db(rows: FakeTestRow[], staff: Record<string, string> = STAFF) {
  return makeFakeReleaseDb({ rows, staff });
}
const released = (id: string, releasedBy: string | null, releasedAt: string | null): FakeTestRow => ({
  id,
  status: "released",
  releasedBy,
  releasedAt,
});

beforeEach(() => {
  reported.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("staffShortName", () => {
  it("is first name + last initial", () => {
    expect(staffShortName("Maria Santos")).toBe("Maria S.");
    expect(staffShortName("Maria Cecilia de la Cruz")).toBe("Maria C.");
    expect(staffShortName("Cher")).toBe("Cher");
    expect(staffShortName("  ")).toBeNull();
    expect(staffShortName(null)).toBeNull();
  });
});

describe("describeRacedRelease", () => {
  it("names another staff member and the time", async () => {
    const f = db([released("a", "maria", TODAY_2_14_PM)]);
    const m = await describeRacedRelease(f.client as never, ["a"], "me");
    expect(m.get("a")).toBe("Already released by Maria S. at 2:14 PM.");
  });

  it("says 'You' when the caller released it themselves", async () => {
    const f = db([released("a", "me", TODAY_2_14_PM)]);
    const m = await describeRacedRelease(f.client as never, ["a"], "me");
    expect(m.get("a")).toBe("You already released this at 2:14 PM.");
    // Never asks for the caller's own name.
    expect(f.calls.some((c) => c.table === "staff_profiles")).toBe(false);
  });

  it("adds the date when the release was not today in Manila time", async () => {
    const f = db([released("a", "maria", OTHER_DAY), released("b", "me", OTHER_DAY)]);
    const m = await describeRacedRelease(f.client as never, ["a", "b"], "me");
    expect(m.get("a")).toBe("Already released by Maria S. on Sep 30 at 2:14 PM.");
    expect(m.get("b")).toBe("You already released this on Sep 30 at 2:14 PM.");
  });

  it("keeps the year when the release was in another year", async () => {
    const f = db([released("a", "maria", OTHER_YEAR)]);
    expect((await describeRacedRelease(f.client as never, ["a"], "me")).get("a")).toBe(
      "Already released by Maria S. on Dec 30, 2025 at 2:14 PM.",
    );
  });

  it("uses the Manila day, not the UTC day (a 23:30 UTC release is already tomorrow in Manila)", async () => {
    // 2026-09-30T23:30Z = Oct 1, 7:30 AM Manila = today.
    const f = db([released("a", "maria", "2026-09-30T23:30:00+00:00")]);
    expect((await describeRacedRelease(f.client as never, ["a"], "me")).get("a")).toBe("Already released by Maria S. at 7:30 AM.");
  });

  it("drops the name when there is no recorded releaser (older row)", async () => {
    const f = db([released("a", null, TODAY_2_14_PM)]);
    expect((await describeRacedRelease(f.client as never, ["a"], "me")).get("a")).toBe("Already released at 2:14 PM.");
  });

  it("drops the name when the releaser has no staff profile, keeping the time", async () => {
    const f = db([released("a", "ghost", TODAY_2_14_PM)]);
    expect((await describeRacedRelease(f.client as never, ["a"], "me")).get("a")).toBe("Already released at 2:14 PM.");
  });

  it("omits an id that is not released now, so the caller keeps its generic reason", async () => {
    const f = db([{ id: "a", status: "ready_for_release" }, released("b", "maria", TODAY_2_14_PM)]);
    const m = await describeRacedRelease(f.client as never, ["a", "b"], "me");
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(true);
  });

  it("reads test_requests once for every id (batched)", async () => {
    const f = db([released("a", "maria", TODAY_2_14_PM), released("b", "maria", TODAY_2_14_PM)]);
    await describeRacedRelease(f.client as never, ["a", "b", "a"], "me");
    expect(f.calls.filter((c) => c.table === "test_requests")).toHaveLength(1);
    expect(f.calls.filter((c) => c.table === "staff_profiles")).toHaveLength(1);
  });

  it("a failed test_requests read yields nothing (generic reason) and never throws", async () => {
    const f = db([released("a", "maria", TODAY_2_14_PM)]);
    f.failNext("test_requests", "read");
    const m = await describeRacedRelease(f.client as never, ["a"], "me");
    expect(m.size).toBe(0);
    expect(reported.map((r) => r.scope)).toEqual(["release/raced-lookup"]);
  });

  it("a failed name read still reports the release, without the name", async () => {
    const f = db([released("a", "maria", TODAY_2_14_PM)]);
    f.failNext("staff_profiles", "read");
    expect((await describeRacedRelease(f.client as never, ["a"], "me")).get("a")).toBe("Already released at 2:14 PM.");
  });

  it("a client that throws outright still returns an empty map", async () => {
    const boom = { from: () => { throw new Error("network down"); } };
    await expect(describeRacedRelease(boom as never, ["a"], "me")).resolves.toEqual(new Map());
  });

  it("no ids makes no read", async () => {
    const f = db([]);
    expect((await describeRacedRelease(f.client as never, [], "me")).size).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it("RACED_REASON stays the generic fallback wording", () => {
    expect(RACED_REASON).toBe("Released by someone else or changed just now.");
  });
});

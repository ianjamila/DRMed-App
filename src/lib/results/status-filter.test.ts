import { describe, expect, it } from "vitest";
import {
  RESULT_STATUSES,
  RESULT_STATUS_LABEL,
  RESULT_STATUS_SPEC,
  parseResultStatusFilter,
  resultStatusSpec,
  type ResultStatusFilter,
} from "./status-filter";

/** Every non-"all" tab, i.e. every tab that carries a spec. */
const NARROWING_TABS = RESULT_STATUSES.filter(
  (s): s is Exclude<ResultStatusFilter, "all"> => s !== "all",
);

describe("parseResultStatusFilter", () => {
  it("accepts every known tab", () => {
    for (const s of RESULT_STATUSES) {
      expect(parseResultStatusFilter(s)).toBe(s);
    }
  });

  it("falls back to 'all' for anything unknown", () => {
    for (const raw of [undefined, "", "requested", "bogus", "ALL"]) {
      expect(parseResultStatusFilter(raw)).toBe("all");
    }
  });
});

describe("resultStatusSpec", () => {
  it("returns no spec for 'all' — that tab narrows nothing", () => {
    expect(resultStatusSpec("all")).toBeUndefined();
  });

  it("returns a spec for every other tab", () => {
    for (const s of NARROWING_TABS) {
      expect(resultStatusSpec(s)).toEqual(RESULT_STATUS_SPEC[s]);
    }
  });
});

describe("Unclaimed / In progress split", () => {
  it("covers the same two pre-result statuses on both tabs", () => {
    expect(RESULT_STATUS_SPEC.unclaimed.statuses).toEqual([
      "requested",
      "in_progress",
    ]);
    expect(RESULT_STATUS_SPEC.in_progress.statuses).toEqual(
      RESULT_STATUS_SPEC.unclaimed.statuses,
    );
  });

  it("splits them by assignee, so In progress no longer absorbs unclaimed work", () => {
    expect(RESULT_STATUS_SPEC.unclaimed.assignee).toBe("unclaimed");
    expect(RESULT_STATUS_SPEC.in_progress.assignee).toBe("claimed");
  });

  it("partitions the pre-result set — no row lands in both tabs or neither", () => {
    // The two tabs share a status set, so the assignee predicates alone decide
    // the split: they must be complementary halves of a boolean, never "any".
    const scopes = [
      RESULT_STATUS_SPEC.unclaimed.assignee,
      RESULT_STATUS_SPEC.in_progress.assignee,
    ];
    expect(new Set(scopes)).toEqual(new Set(["unclaimed", "claimed"]));
  });

  it("sorts Unclaimed oldest-first — it is a worklist, not an archive view", () => {
    expect(RESULT_STATUS_SPEC.unclaimed.oldestFirst).toBe(true);
    for (const s of NARROWING_TABS.filter((t) => t !== "unclaimed")) {
      expect(RESULT_STATUS_SPEC[s].oldestFirst).toBe(false);
    }
  });
});

describe("tab metadata", () => {
  it("labels every tab", () => {
    for (const s of RESULT_STATUSES) {
      expect(RESULT_STATUS_LABEL[s]).toBeTruthy();
    }
  });

  it("keeps the pre-result tabs adjacent, most-progressed first", () => {
    expect([...RESULT_STATUSES]).toEqual([
      "all",
      "released",
      "ready",
      "in_progress",
      "unclaimed",
      "cancelled",
    ]);
  });

  it("assigns each underlying status to exactly one tab", () => {
    // 'requested' and 'in_progress' are the deliberate exception — they appear
    // on two tabs that are disambiguated by the assignee predicate.
    const seen = new Map<string, number>();
    for (const s of NARROWING_TABS) {
      for (const st of RESULT_STATUS_SPEC[s].statuses) {
        seen.set(st, (seen.get(st) ?? 0) + 1);
      }
    }
    expect(seen.get("released")).toBe(1);
    expect(seen.get("result_uploaded")).toBe(1);
    expect(seen.get("ready_for_release")).toBe(1);
    expect(seen.get("cancelled")).toBe(1);
    expect(seen.get("requested")).toBe(2);
    expect(seen.get("in_progress")).toBe(2);
  });
});

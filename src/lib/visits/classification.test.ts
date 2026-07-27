import { describe, it, expect } from "vitest";
import {
  classifyKind,
  classesForKinds,
  combinePaymentStatus,
  foldVisitGroups,
  isVisitClass,
  isVisitView,
  kindPredicateForSet,
  parseVisitClasses,
  serialiseVisitClasses,
  summariseClasses,
  summaryTotals,
  toggleVisitClass,
  DOCTOR_KIND_VALUES,
  VISIT_CLASS_LABEL,
  type VisitClass,
} from "./classification";

const set = (...c: VisitClass[]) => new Set<VisitClass>(c);

describe("classifyKind", () => {
  it("names the two doctor kinds", () => {
    expect(classifyKind("doctor_consultation")).toBe("consult");
    expect(classifyKind("doctor_procedure")).toBe("procedure");
  });

  it("buckets every lab-side kind as lab", () => {
    for (const k of ["lab_test", "lab_package", "vaccine", "home_service"]) {
      expect(classifyKind(k)).toBe("lab");
    }
  });

  it("reads an unknown/new catalog kind as lab rather than dropping it", () => {
    expect(classifyKind("imaging_xray")).toBe("lab");
    expect(classifyKind("")).toBe("lab");
  });
});

describe("kindPredicateForSet", () => {
  it("applies no predicate for nothing selected or everything selected", () => {
    expect(kindPredicateForSet(set())).toEqual({ mode: "none" });
    expect(kindPredicateForSet(set("lab", "consult", "procedure"))).toEqual({
      mode: "none",
    });
  });

  it("matches single doctor classes by enumeration", () => {
    expect(kindPredicateForSet(set("consult"))).toEqual({
      mode: "in",
      kinds: ["doctor_consultation"],
    });
    expect(kindPredicateForSet(set("procedure"))).toEqual({
      mode: "in",
      kinds: ["doctor_procedure"],
    });
  });

  it("unions the enumerated kinds when both doctor classes are selected", () => {
    expect(kindPredicateForSet(set("consult", "procedure"))).toEqual({
      mode: "in",
      kinds: ["doctor_consultation", "doctor_procedure"],
    });
  });

  it("matches lab as the complement, so it stays in step with classifyKind", () => {
    const p = kindPredicateForSet(set("lab"));
    expect(p.mode).toBe("notIn");
    expect(p.mode === "notIn" ? [...p.kinds].sort() : []).toEqual(
      [...DOCTOR_KIND_VALUES].sort(),
    );
  });

  it("excludes only the unselected doctor class when lab is combined with one", () => {
    expect(kindPredicateForSet(set("lab", "consult"))).toEqual({
      mode: "notIn",
      kinds: ["doctor_procedure"],
    });
    expect(kindPredicateForSet(set("lab", "procedure"))).toEqual({
      mode: "notIn",
      kinds: ["doctor_consultation"],
    });
  });

  // `NOT IN ()` is a syntax error — the all-selected case must collapse to none.
  it("never emits an empty NOT IN", () => {
    for (const s of [
      set("lab", "consult", "procedure"),
      set("lab", "consult"),
      set("lab", "procedure"),
      set("lab"),
    ]) {
      const p = kindPredicateForSet(s);
      if (p.mode === "notIn") expect(p.kinds.length).toBeGreaterThan(0);
    }
  });

  // The bug this guards: an allow-list `lab` filter would silently exclude any
  // kind added to the catalog later, while the badge still called it Lab Tests.
  it("agrees with classifyKind for a kind nobody enumerated", () => {
    const p = kindPredicateForSet(set("lab"));
    expect(classifyKind("imaging_xray")).toBe("lab");
    expect(p.mode === "notIn" && p.kinds.includes("imaging_xray")).toBe(false);
  });
});

describe("chip param round-trip", () => {
  it("parses a comma list, ignoring junk", () => {
    expect([...parseVisitClasses("lab,consult")]).toEqual(["lab", "consult"]);
    expect([...parseVisitClasses("lab, bogus ,procedure")]).toEqual([
      "lab",
      "procedure",
    ]);
    expect([...parseVisitClasses(undefined)]).toEqual([]);
    expect([...parseVisitClasses("")]).toEqual([]);
  });

  it("serialises in display order, and collapses all-selected to empty", () => {
    expect(serialiseVisitClasses(set("consult", "lab"))).toBe("lab,consult");
    expect(serialiseVisitClasses(set("lab", "consult", "procedure"))).toBe("");
    expect(serialiseVisitClasses(set())).toBe("");
  });

  it("round-trips any partial selection", () => {
    for (const s of [set("lab"), set("consult"), set("lab", "procedure")]) {
      expect(parseVisitClasses(serialiseVisitClasses(s))).toEqual(s);
    }
  });

  it("toggles additively without mutating the input", () => {
    const base = set("lab");
    expect([...toggleVisitClass(base, "consult")]).toEqual(["lab", "consult"]);
    expect([...toggleVisitClass(base, "lab")]).toEqual([]);
    expect([...base]).toEqual(["lab"]);
  });
});

describe("isVisitView", () => {
  it("accepts the three views and rejects anything else", () => {
    expect(isVisitView("active")).toBe(true);
    expect(isVisitView("deleted")).toBe(true);
    expect(isVisitView("all")).toBe(true);
    expect(isVisitView("lab")).toBe(false);
    expect(isVisitView(undefined)).toBe(false);
  });
});

describe("summariseClasses", () => {
  it("returns all three classes in display order", () => {
    expect(summariseClasses([]).map((r) => r.class)).toEqual([
      "lab",
      "consult",
      "procedure",
    ]);
  });

  // The RPC GROUPs, so a class with no lines is absent, not zero. Procedures
  // are absent on every real query today — the strip must still show them.
  it("fills an absent class with zeros rather than dropping it", () => {
    const rows = summariseClasses([
      { class: "lab", visits: 6915, lines: 18187, revenue_php: 12077902.49 },
      { class: "consult", visits: 7352, lines: 7402, revenue_php: 249578 },
    ]);
    expect(rows.find((r) => r.class === "procedure")).toEqual({
      class: "procedure",
      visits: 0,
      lines: 0,
      revenuePhp: 0,
    });
    expect(rows.find((r) => r.class === "lab")?.revenuePhp).toBe(12077902.49);
  });

  it("ignores an unrecognised class name from SQL", () => {
    const rows = summariseClasses([
      { class: "something_new", visits: 5, lines: 5, revenue_php: 100 },
    ]);
    expect(rows.every((r) => r.visits === 0)).toBe(true);
  });

  it("coerces string numerics (numeric comes back as text over PostgREST)", () => {
    const rows = summariseClasses([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- numeric arrives as a string
      { class: "lab", visits: "3" as any, lines: "4" as any, revenue_php: "12.50" as any },
    ]);
    expect(rows[0]).toEqual({ class: "lab", visits: 3, lines: 4, revenuePhp: 12.5 });
  });
});

describe("summaryTotals", () => {
  it("sums lines and revenue", () => {
    const rows = summariseClasses([
      { class: "lab", visits: 10, lines: 20, revenue_php: 100 },
      { class: "consult", visits: 5, lines: 5, revenue_php: 50 },
    ]);
    expect(summaryTotals(rows)).toEqual({ lines: 25, revenuePhp: 150 });
  });

  // One visit can hold both a consult and a lab line, so per-class visit
  // counts overlap and must not be added together.
  it("does not expose a summed visit count", () => {
    const totals = summaryTotals(summariseClasses([]));
    expect(Object.keys(totals).sort()).toEqual(["lines", "revenuePhp"]);
  });
});

describe("classesForKinds", () => {
  it("de-duplicates and returns stable display order", () => {
    expect(
      classesForKinds([
        "doctor_procedure",
        "lab_test",
        "doctor_consultation",
        "lab_package",
      ]),
    ).toEqual(["lab", "consult", "procedure"]);
  });

  it("returns nothing for a visit with no live lines", () => {
    expect(classesForKinds([])).toEqual([]);
  });

  it("labels every class", () => {
    for (const c of classesForKinds(["lab_test", "doctor_consultation", "doctor_procedure"])) {
      expect(VISIT_CLASS_LABEL[c]).toBeTruthy();
    }
  });
});

describe("isVisitClass", () => {
  it("accepts the three classes and rejects anything else", () => {
    expect(isVisitClass("lab")).toBe(true);
    expect(isVisitClass("consult")).toBe(true);
    expect(isVisitClass("procedure")).toBe(true);
    expect(isVisitClass("all")).toBe(false);
    expect(isVisitClass(undefined)).toBe(false);
    expect(isVisitClass(null)).toBe(false);
  });
});

describe("combinePaymentStatus", () => {
  it("passes a single status straight through", () => {
    expect(combinePaymentStatus(["paid"])).toBe("paid");
    expect(combinePaymentStatus(["unpaid"])).toBe("unpaid");
    expect(combinePaymentStatus(["waived"])).toBe("waived");
    expect(combinePaymentStatus(["partial"])).toBe("partial");
  });

  it("treats an empty encounter as unpaid", () => {
    expect(combinePaymentStatus([])).toBe("unpaid");
  });

  it("is partial when one half is settled and the other is not", () => {
    expect(combinePaymentStatus(["paid", "unpaid"])).toBe("partial");
    expect(combinePaymentStatus(["waived", "unpaid"])).toBe("partial");
  });

  it("is partial whenever any half is itself partial", () => {
    expect(combinePaymentStatus(["partial", "paid"])).toBe("partial");
    expect(combinePaymentStatus(["partial", "waived"])).toBe("partial");
  });

  // Nothing is outstanding on either half, so this must not read as partial.
  it("reads paid + waived as paid, not partial", () => {
    expect(combinePaymentStatus(["paid", "waived"])).toBe("paid");
  });
});

describe("foldVisitGroups", () => {
  const v = (
    id: string,
    group: string | null,
    date: string,
    created: string,
  ) => ({ id, visit_group_id: group, visit_date: date, created_at: created });

  it("leaves standalone visits as one row each, in input order", () => {
    const folded = foldVisitGroups([
      v("a", null, "2026-07-20", "2026-07-20T02:00:00Z"),
      v("b", null, "2026-07-19", "2026-07-19T02:00:00Z"),
    ]);
    expect(folded.map((f) => f.key)).toEqual(["a", "b"]);
    expect(folded.every((f) => f.split === false)).toBe(true);
    expect(folded.map((f) => f.anchorId)).toEqual(["a", "b"]);
  });

  it("folds the two halves of a split visit into one row", () => {
    const folded = foldVisitGroups([
      v("doctor", "g1", "2026-07-20", "2026-07-20T02:00:01Z"),
      v("lab", "g1", "2026-07-20", "2026-07-20T02:00:00Z"),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.split).toBe(true);
    expect(folded[0]!.members.map((m) => m.id)).toEqual(["doctor", "lab"]);
  });

  it("anchors the group on the member that sorts first, whatever the input order", () => {
    const later = v("later", "g1", "2026-07-20", "2026-07-20T02:00:09Z");
    const earlier = v("earlier", "g1", "2026-07-20", "2026-07-20T02:00:00Z");
    expect(foldVisitGroups([earlier, later])[0]!.anchorId).toBe("later");
    expect(foldVisitGroups([later, earlier])[0]!.anchorId).toBe("later");
  });

  it("breaks a created_at tie deterministically so the anchor never flip-flops", () => {
    const a = v("aaa", "g1", "2026-07-20", "2026-07-20T02:00:00Z");
    const b = v("bbb", "g1", "2026-07-20", "2026-07-20T02:00:00Z");
    expect(foldVisitGroups([a, b])[0]!.anchorId).toBe("aaa");
    expect(foldVisitGroups([b, a])[0]!.anchorId).toBe("aaa");
  });

  it("sorts by visit_date before created_at", () => {
    const folded = foldVisitGroups([
      v("old-date-new-clock", "g1", "2026-07-19", "2026-07-21T02:00:00Z"),
      v("new-date-old-clock", "g1", "2026-07-20", "2026-07-20T02:00:00Z"),
    ]);
    expect(folded[0]!.anchorId).toBe("new-date-old-clock");
  });

  // The page unions the page rows with a top-up query for group members, so
  // the same visit can legitimately arrive twice.
  it("ignores a duplicate copy of the same visit", () => {
    const row = v("doctor", "g1", "2026-07-20", "2026-07-20T02:00:01Z");
    const folded = foldVisitGroups([
      row,
      v("lab", "g1", "2026-07-20", "2026-07-20T02:00:00Z"),
      { ...row },
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.members.map((m) => m.id)).toEqual(["doctor", "lab"]);
  });

  describe("filter-aware anchoring", () => {
    const doctorHalf = v("doctor", "g1", "2026-07-20", "2026-07-20T02:00:00Z");
    const labHalf = v("lab", "g1", "2026-07-20", "2026-07-20T02:00:09Z");

    it("anchors on the eligible member even when an ineligible one sorts first", () => {
      // labHalf sorts first (later created_at, desc order) but fails the filter.
      const folded = foldVisitGroups([doctorHalf, labHalf], (m) => m.id === "doctor");
      expect(folded[0]!.anchorId).toBe("doctor");
    });

    it("still renders both halves in the row — the filter picks encounters, not lines", () => {
      const folded = foldVisitGroups([doctorHalf, labHalf], (m) => m.id === "doctor");
      expect(folded[0]!.members.map((m) => m.id)).toEqual(["lab", "doctor"]);
    });

    it("falls back to the first member when nothing is eligible", () => {
      const folded = foldVisitGroups([doctorHalf, labHalf], () => false);
      expect(folded[0]!.anchorId).toBe("lab");
    });

    it("behaves as before when no predicate is supplied", () => {
      expect(foldVisitGroups([doctorHalf, labHalf])[0]!.anchorId).toBe("lab");
    });
  });

  it("keeps groups keyed apart from same-named standalone visits", () => {
    const folded = foldVisitGroups([
      v("x", "g1", "2026-07-20", "2026-07-20T02:00:00Z"),
      v("y", null, "2026-07-20", "2026-07-20T01:00:00Z"),
    ]);
    expect(folded.map((f) => f.key)).toEqual(["g1", "y"]);
  });
});

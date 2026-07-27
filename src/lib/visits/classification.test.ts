import { describe, it, expect } from "vitest";
import {
  classifyKind,
  classesForKinds,
  combinePaymentStatus,
  foldVisitGroups,
  isVisitClass,
  kindPredicateFor,
  DOCTOR_KIND_VALUES,
  VISIT_CLASS_LABEL,
} from "./classification";

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

describe("kindPredicateFor", () => {
  it("matches the doctor classes by enumeration", () => {
    expect(kindPredicateFor("consult")).toEqual({
      negated: false,
      kinds: ["doctor_consultation"],
    });
    expect(kindPredicateFor("procedure")).toEqual({
      negated: false,
      kinds: ["doctor_procedure"],
    });
  });

  it("matches lab as the complement, so it stays in step with classifyKind", () => {
    const lab = kindPredicateFor("lab");
    expect(lab.negated).toBe(true);
    expect([...lab.kinds].sort()).toEqual([...DOCTOR_KIND_VALUES].sort());
  });

  // The bug this guards: an allow-list `lab` filter would silently exclude any
  // kind added to the catalog later, while the badge still called it Lab Tests.
  it("agrees with classifyKind for a kind nobody enumerated", () => {
    const lab = kindPredicateFor("lab");
    expect(classifyKind("imaging_xray")).toBe("lab");
    expect(lab.kinds.includes("imaging_xray")).toBe(false);
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

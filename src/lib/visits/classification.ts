/**
 * Visit classification + split-visit folding for the Visits archive
 * (partner revisions item 4).
 *
 * Two pure concerns, no server-only imports so both are unit-testable:
 *
 *  1. **Classification** — every billable line carries a `services.kind`.
 *     Reception thinks in three buckets: Lab Tests, Doctor Consults, Doctor
 *     Procedures. Only the two doctor kinds are enumerated; everything else
 *     (lab_test, lab_package, vaccine, home_service, and any kind added to the
 *     catalog later) is Lab Tests. Defining `lab` as the complement — rather
 *     than as its own allow-list — is what keeps the badge and the filter
 *     chip from disagreeing the day someone seeds a new kind.
 *
 *  2. **Folding** — one counter encounter that mixes doctor and lab lines is
 *     stored as TWO visits sharing a `visit_group_id` (0090). The archive
 *     shows the encounter, so the halves fold into one row.
 */

// Mirrors DOCTOR_KINDS in ./order-lines — same split, different output shape
// (that module partitions into two billing buckets, this one names three
// reception-facing classes).
const CONSULT_KINDS: ReadonlySet<string> = new Set(["doctor_consultation"]);
const PROCEDURE_KINDS: ReadonlySet<string> = new Set(["doctor_procedure"]);

export const VISIT_CLASSES = ["lab", "consult", "procedure"] as const;
export type VisitClass = (typeof VISIT_CLASSES)[number];

export const VISIT_CLASS_LABEL: Record<VisitClass, string> = {
  lab: "Lab Tests",
  consult: "Doctor Consults",
  procedure: "Doctor Procedures",
};

/** All kinds that are NOT Lab Tests — the enumerated side of the split. */
export const DOCTOR_KIND_VALUES: readonly string[] = [
  ...CONSULT_KINDS,
  ...PROCEDURE_KINDS,
];

export function isVisitClass(value: string | null | undefined): value is VisitClass {
  return (VISIT_CLASSES as readonly string[]).includes(value ?? "");
}

/** Bucket one `services.kind`. Unknown kinds read as Lab Tests. */
export function classifyKind(kind: string): VisitClass {
  if (CONSULT_KINDS.has(kind)) return "consult";
  if (PROCEDURE_KINDS.has(kind)) return "procedure";
  return "lab";
}

/**
 * How to express a class as a PostgREST predicate on `services.kind`.
 * `lab` is the complement, so it negates — see the module note above.
 */
export function kindPredicateFor(cls: VisitClass): {
  negated: boolean;
  kinds: readonly string[];
} {
  if (cls === "consult") return { negated: false, kinds: [...CONSULT_KINDS] };
  if (cls === "procedure") return { negated: false, kinds: [...PROCEDURE_KINDS] };
  return { negated: true, kinds: DOCTOR_KIND_VALUES };
}

/** Distinct classes present in a set of lines, in stable display order. */
export function classesForKinds(kinds: readonly string[]): VisitClass[] {
  const seen = new Set<VisitClass>();
  for (const k of kinds) seen.add(classifyKind(k));
  return VISIT_CLASSES.filter((c) => seen.has(c));
}

// ---------------------------------------------------------------------------
// Combined payment status
// ---------------------------------------------------------------------------

/**
 * One status for a folded encounter. `waived` is a settled outcome, not an
 * unpaid one, so a paid half + a waived half reads as settled rather than
 * "partial" — the counter has nothing left to collect either way. Mixed
 * settled/unsettled is the only case that becomes `partial`.
 */
export function combinePaymentStatus(statuses: readonly string[]): string {
  if (statuses.length === 0) return "unpaid";
  const unique = new Set(statuses);
  if (unique.size === 1) return statuses[0]!;
  if (unique.has("partial")) return "partial";

  const settled = statuses.filter((s) => s === "paid" || s === "waived");
  if (settled.length === statuses.length) {
    // Mixed paid + waived — nothing outstanding; report the stronger term.
    return "paid";
  }
  if (settled.length === 0) return "unpaid";
  return "partial";
}

// ---------------------------------------------------------------------------
// Split-visit folding
// ---------------------------------------------------------------------------

export interface FoldableVisit {
  id: string;
  visit_group_id: string | null;
  visit_date: string;
  created_at: string;
}

export interface VisitGroupFold<T extends FoldableVisit> {
  /** `visit_group_id` when split, else the lone visit's id. */
  key: string;
  /** True when this row folds more than one visit. */
  split: boolean;
  /**
   * The member that sorts first under the page ordering (visit_date desc,
   * created_at desc) AND satisfies the active filters. The archive renders a
   * group on the page its anchor landed on, which is what stops a group
   * straddling a page boundary from rendering twice. The anchor has to be
   * filter-aware: under a "Doctor Consults" chip only the doctor half is
   * fetched into the page, so anchoring on an unfiltered lab half would
   * suppress the row on every page.
   */
  anchorId: string;
  /** Members in page order — anchor first. */
  members: T[];
}

function compareDesc(a: FoldableVisit, b: FoldableVisit): number {
  if (a.visit_date !== b.visit_date) return a.visit_date < b.visit_date ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  // Final tie-break so the anchor is deterministic when two halves are written
  // in the same transaction and share a created_at to the microsecond.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold visits into encounter rows, preserving the input ordering of each
 * group's anchor. `visits` may include members pulled in from outside the
 * page window — ordering is recomputed per group, not assumed.
 *
 * `isEligible` marks the members that satisfy the active filters; the anchor
 * is the first eligible member. Members that fail it still render inside the
 * row (the row is the encounter, the filter only chooses which encounters
 * appear). When no member is eligible the first member anchors, so a group
 * can never become unrenderable.
 */
export function foldVisitGroups<T extends FoldableVisit>(
  visits: readonly T[],
  isEligible?: (visit: T) => boolean,
): VisitGroupFold<T>[] {
  const byKey = new Map<string, T[]>();
  const order: string[] = [];

  for (const v of visits) {
    const key = v.visit_group_id ?? v.id;
    const existing = byKey.get(key);
    if (existing) {
      // Guard against the same visit arriving twice (page row + group-member
      // top-up query both carry it).
      if (!existing.some((m) => m.id === v.id)) existing.push(v);
    } else {
      byKey.set(key, [v]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const members = [...byKey.get(key)!].sort(compareDesc);
    const anchor = isEligible ? members.find(isEligible) : members[0];
    return {
      key,
      split: members.length > 1,
      anchorId: (anchor ?? members[0]!).id,
      members,
    };
  });
}

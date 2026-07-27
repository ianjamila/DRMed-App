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

/** The enumerated `services.kind` values belonging to a doctor class. */
function kindsOf(cls: VisitClass): readonly string[] {
  if (cls === "consult") return [...CONSULT_KINDS];
  if (cls === "procedure") return [...PROCEDURE_KINDS];
  return [];
}

/**
 * How to express a SET of selected classes as a PostgREST predicate on
 * `services.kind`.
 *
 * The chips are multi-select, so this has to handle every subset:
 *
 * - nothing selected, or all three → no predicate at all ("All")
 * - `lab` not selected → match the enumerated kinds of the chosen doctor
 *   classes: `kind IN (…)`
 * - `lab` selected → `lab` is the complement, so exclude the doctor kinds
 *   whose class was NOT chosen: `kind NOT IN (…)`. With lab + both doctor
 *   classes there is nothing left to exclude, which collapses to "no
 *   predicate" — never to an empty `NOT IN ()`, which isn't valid SQL.
 */
export type KindPredicate =
  | { mode: "none" }
  | { mode: "in"; kinds: readonly string[] }
  | { mode: "notIn"; kinds: readonly string[] };

export function kindPredicateForSet(
  selected: ReadonlySet<VisitClass>,
): KindPredicate {
  if (selected.size === 0 || selected.size === VISIT_CLASSES.length) {
    return { mode: "none" };
  }
  if (!selected.has("lab")) {
    return {
      mode: "in",
      kinds: VISIT_CLASSES.filter((c) => selected.has(c)).flatMap((c) => [
        ...kindsOf(c),
      ]),
    };
  }
  const excluded = VISIT_CLASSES.filter((c) => !selected.has(c)).flatMap((c) => [
    ...kindsOf(c),
  ]);
  return excluded.length === 0 ? { mode: "none" } : { mode: "notIn", kinds: excluded };
}

/** Parse the `kind` query param (`"lab,consult"`) into a set of classes. */
export function parseVisitClasses(raw: string | undefined): Set<VisitClass> {
  const out = new Set<VisitClass>();
  for (const part of (raw ?? "").split(",")) {
    const t = part.trim();
    if (isVisitClass(t)) out.add(t);
  }
  return out;
}

/** Serialise a class set back to a `kind` param, in stable display order. */
export function serialiseVisitClasses(
  selected: ReadonlySet<VisitClass>,
): string {
  if (selected.size === 0 || selected.size === VISIT_CLASSES.length) return "";
  return VISIT_CLASSES.filter((c) => selected.has(c)).join(",");
}

/** Toggle one chip, returning a new set (chips are additive, not exclusive). */
export function toggleVisitClass(
  selected: ReadonlySet<VisitClass>,
  cls: VisitClass,
): Set<VisitClass> {
  const next = new Set(selected);
  if (next.has(cls)) next.delete(cls);
  else next.add(cls);
  return next;
}

// ---------------------------------------------------------------------------
// Deleted-visit view
// ---------------------------------------------------------------------------

export const VISIT_VIEWS = ["active", "deleted", "all"] as const;
export type VisitView = (typeof VISIT_VIEWS)[number];

export const VISIT_VIEW_LABEL: Record<VisitView, string> = {
  active: "Active",
  deleted: "Deleted",
  all: "All",
};

export function isVisitView(value: string | null | undefined): value is VisitView {
  return (VISIT_VIEWS as readonly string[]).includes(value ?? "");
}

/** Distinct classes present in a set of lines, in stable display order. */
export function classesForKinds(kinds: readonly string[]): VisitClass[] {
  const seen = new Set<VisitClass>();
  for (const k of kinds) seen.add(classifyKind(k));
  return VISIT_CLASSES.filter((c) => seen.has(c));
}

// ---------------------------------------------------------------------------
// Revenue summary (0126 `visits_classification_summary`)
// ---------------------------------------------------------------------------

export interface ClassSummaryRow {
  class: VisitClass;
  visits: number;
  lines: number;
  revenuePhp: number;
}

/** A raw row as the RPC returns it — `class` is untyped text from SQL. */
export interface RawClassSummaryRow {
  class: string;
  visits: number;
  lines: number;
  revenue_php: number;
}

/**
 * Normalise the RPC result into one row per class, in display order.
 *
 * The function GROUPs, so a class with no lines is simply ABSENT from the
 * result — `doctor_procedure` has no seeded services yet, so it is absent on
 * every real query today. The strip still has to show it at zero, otherwise
 * the reader can't tell "nothing booked" from "column missing".
 */
export function summariseClasses(
  rows: readonly RawClassSummaryRow[] | null | undefined,
): ClassSummaryRow[] {
  const byClass = new Map<VisitClass, RawClassSummaryRow>();
  for (const r of rows ?? []) {
    if (isVisitClass(r.class)) byClass.set(r.class, r);
  }
  return VISIT_CLASSES.map((c) => {
    const r = byClass.get(c);
    return {
      class: c,
      visits: Number(r?.visits ?? 0),
      lines: Number(r?.lines ?? 0),
      revenuePhp: Number(r?.revenue_php ?? 0),
    };
  });
}

/**
 * Grand total across classes. Visit counts are NOT summed — one visit can hold
 * both a consult and a lab line, so it is counted under both classes and
 * adding them would overstate the total. Revenue and line counts are
 * line-level and do sum cleanly.
 */
export function summaryTotals(rows: readonly ClassSummaryRow[]): {
  lines: number;
  revenuePhp: number;
} {
  return {
    lines: rows.reduce((s, r) => s + r.lines, 0),
    revenuePhp: rows.reduce((s, r) => s + r.revenuePhp, 0),
  };
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

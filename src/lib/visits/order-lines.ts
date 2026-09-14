// Pure classification of reception order lines into the two billing
// categories: Doctor / Professional Fee vs Lab & Services. No server-only
// imports — unit-testable.

import { DOCTOR_KIND_VALUES } from "./classification";

// Sourced from ./classification rather than re-listed here. The two modules
// split the same way for different outputs (that one names three
// reception-facing classes, this one two billing buckets), and they used to
// keep independent copies of the kind list — so a new doctor kind had to be
// added in two places or the buckets would silently disagree. One list now
// feeds the classifier, this predicate, and the `DOCTOR_KINDS_PG_LIST`
// literal the lab surfaces filter on.
const DOCTOR_KINDS = new Set<string>(DOCTOR_KIND_VALUES);

/** True for doctor consultation/procedure kinds; everything else is Lab & Services. */
export function isDoctorKind(kind: string): boolean {
  return DOCTOR_KINDS.has(kind);
}

/** Partition items into doctor/lab buckets, preserving input order in each. */
export function partitionByCategory<T>(
  items: T[],
  kindOf: (item: T) => string,
): { doctor: T[]; lab: T[] } {
  const doctor: T[] = [];
  const lab: T[] = [];
  for (const item of items) {
    if (isDoctorKind(kindOf(item))) doctor.push(item);
    else lab.push(item);
  }
  return { doctor, lab };
}

/** A split is warranted only when the order spans BOTH categories. */
export function shouldSplit<T>(items: T[], kindOf: (item: T) => string): boolean {
  const { doctor, lab } = partitionByCategory(items, kindOf);
  return doctor.length > 0 && lab.length > 0;
}

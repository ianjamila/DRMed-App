// Pure classification of reception order lines into the two billing
// categories: Doctor / Professional Fee vs Lab & Services. No server-only
// imports — unit-testable.

const DOCTOR_KINDS = new Set(["doctor_consultation", "doctor_procedure"]);

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

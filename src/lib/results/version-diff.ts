// "What changed" between result versions (0172 snapshots). Pure. Staff-only surface.

export interface SnapshotValue {
  parameter_id: string;
  parameter_name: string | null;
  numeric_value_si: number | null;
  numeric_value_conv: number | null;
  text_value: string | null;
  select_value: string | null;
  flag: string | null;
  is_blank: boolean | null;
}

export interface ValueChange {
  parameterId: string;
  name: string;
  before: string;
  after: string;
  flagBefore: string | null;
  flagAfter: string | null;
}

export interface AmendmentSnapshot {
  id: string;
  amendment_seq: number;
  amended_at: string;
  prior_values_json: SnapshotValue[] | null;
}

export function displayValue(x: SnapshotValue | undefined): string {
  if (!x || x.is_blank) return "—";
  if (x.numeric_value_si != null) return String(x.numeric_value_si);
  return x.select_value ?? x.text_value ?? "—";
}

export function diffResultVersions(before: readonly SnapshotValue[], after: readonly SnapshotValue[]): ValueChange[] {
  const b = new Map(before.map((x) => [x.parameter_id, x]));
  const a = new Map(after.map((x) => [x.parameter_id, x]));
  const order = [...after.map((x) => x.parameter_id), ...before.map((x) => x.parameter_id).filter((id) => !a.has(id))];
  const out: ValueChange[] = [];
  for (const id of order) {
    const x = b.get(id);
    const y = a.get(id);
    const change: ValueChange = {
      parameterId: id,
      name: y?.parameter_name ?? x?.parameter_name ?? "Parameter",
      before: displayValue(x),
      after: displayValue(y),
      flagBefore: x?.flag ?? null,
      flagAfter: y?.flag ?? null,
    };
    if (change.before !== change.after || change.flagBefore !== change.flagAfter) out.push(change);
  }
  return out;
}

export interface AmendmentChanges {
  amendmentId: string;
  seq: number;
  amendedAt: string;
  fromVersion: number;
  toVersion: number;
  structured: boolean;
  changes: ValueChange[];
}

/** Newest first. Correction N turned version N into N+1; its "after" is the next snapshot or current values. */
export function changesPerAmendment(
  amendments: readonly AmendmentSnapshot[],
  current: readonly SnapshotValue[],
): AmendmentChanges[] {
  const sorted = [...amendments].sort((x, y) => x.amendment_seq - y.amendment_seq);
  return sorted
    .map((am, i) => {
      const next = sorted[i + 1];
      const after = next ? next.prior_values_json : current;
      const structured = am.prior_values_json != null && after != null;
      return {
        amendmentId: am.id,
        seq: am.amendment_seq,
        amendedAt: am.amended_at,
        fromVersion: am.amendment_seq,
        toVersion: am.amendment_seq + 1,
        structured,
        changes: structured ? diffResultVersions(am.prior_values_json!, after!) : [],
      };
    })
    .reverse();
}

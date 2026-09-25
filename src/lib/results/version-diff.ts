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
  // House pattern (types.ts computeFlag/detectCritical): a conv-only value
  // (no SI reading, only the converted one) must still show, not read as
  // blank.
  const numeric = x.numeric_value_si ?? x.numeric_value_conv;
  if (numeric != null) return String(numeric);
  return x.select_value ?? x.text_value ?? "—";
}

// R2: "changed" must be decided on the underlying fields, not on
// displayValue()'s STRING — displayValue prefers numeric_value_si when it's
// present, so a correction that only touches numeric_value_conv (the SI
// reading unchanged) produced identical before/after strings and the diff
// silently dropped it as "Values unchanged". Added/removed (one side
// undefined) always counts as a value change.
function sameValueFields(x: SnapshotValue | undefined, y: SnapshotValue | undefined): boolean {
  if (!x || !y) return false;
  return (
    x.numeric_value_si === y.numeric_value_si &&
    x.numeric_value_conv === y.numeric_value_conv &&
    x.text_value === y.text_value &&
    x.select_value === y.select_value &&
    Boolean(x.is_blank) === Boolean(y.is_blank)
  );
}

export function diffResultVersions(before: readonly SnapshotValue[], after: readonly SnapshotValue[]): ValueChange[] {
  const b = new Map(before.map((x) => [x.parameter_id, x]));
  const a = new Map(after.map((x) => [x.parameter_id, x]));
  const order = [...after.map((x) => x.parameter_id), ...before.map((x) => x.parameter_id).filter((id) => !a.has(id))];
  const out: ValueChange[] = [];
  for (const id of order) {
    const x = b.get(id);
    const y = a.get(id);
    const valueChanged = !sameValueFields(x, y);
    const flagBefore = x?.flag ?? null;
    const flagAfter = y?.flag ?? null;
    if (!valueChanged && flagBefore === flagAfter) continue;

    let before_ = displayValue(x);
    let after_ = displayValue(y);
    // The SI-preferring display collided (e.g. SI unchanged, conv differs) —
    // append the conv value so the real change is still visible.
    if (before_ === after_ && valueChanged && x?.numeric_value_conv !== y?.numeric_value_conv) {
      const bConv = x?.numeric_value_conv;
      const aConv = y?.numeric_value_conv;
      before_ = bConv != null ? `${before_} (conv ${bConv})` : before_;
      after_ = aConv != null ? `${after_} (conv ${aConv})` : after_;
    }

    out.push({
      parameterId: id,
      name: y?.parameter_name ?? x?.parameter_name ?? "Parameter",
      before: before_,
      after: after_,
      flagBefore,
      flagAfter,
    });
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

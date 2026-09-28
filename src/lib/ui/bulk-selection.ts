// Pure state for the shared row-selection kit (src/components/staff/row-selection).
// Lives in src/lib so both the client provider and the server actions' caps can
// import it — "use server" modules may only export async functions, and
// vitest can test this without a DOM.

/** Selected rows per action (bookings / tests / messages). */
export const MAX_BULK_ROWS = 100;
/** Deduplicated underlying record ids per action (a booking with 6 services is 6). */
export const MAX_BULK_RECORDS = 500;

export interface SelectionLimits {
  rows: number;
  records: number;
}

export const DEFAULT_LIMITS: SelectionLimits = {
  rows: MAX_BULK_ROWS,
  records: MAX_BULK_RECORDS,
};

export interface SelectionEntry {
  /** Opaque row identity — a booking-group key, a test_request id, a message id. */
  rowKey: string;
  /** What the bar may do with this row; a row can carry several. */
  kinds: readonly string[];
  /** How many underlying records the row expands to (≥ 1). */
  weight: number;
}

export type SelectionState = ReadonlyMap<string, SelectionEntry>;

export const EMPTY_SELECTION: SelectionState = new Map();

export function recordsOf(state: SelectionState): number {
  let total = 0;
  for (const entry of state.values()) total += entry.weight;
  return total;
}

/** True when the entry is already selected, or adding it stays under both caps. */
export function canAdd(
  state: SelectionState,
  entry: SelectionEntry,
  limits: SelectionLimits = DEFAULT_LIMITS,
): boolean {
  if (state.has(entry.rowKey)) return true;
  return state.size + 1 <= limits.rows && recordsOf(state) + entry.weight <= limits.records;
}

/**
 * Adds entries in order. Stops before the first entry that would exceed either
 * cap and reports it and everything after it as refused — a row is never
 * split. Returns the same Map reference when nothing was added so React can
 * bail out of a re-render.
 */
export function addEntries(
  state: SelectionState,
  entries: readonly SelectionEntry[],
  limits: SelectionLimits = DEFAULT_LIMITS,
): { next: SelectionState; refused: string[] } {
  let next: Map<string, SelectionEntry> | null = null;
  let rows = state.size;
  let records = recordsOf(state);
  const refused: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if ((next ?? state).has(entry.rowKey)) continue;
    if (rows + 1 > limits.rows || records + entry.weight > limits.records) {
      for (let j = i; j < entries.length; j++) {
        const rest = entries[j]!;
        if (!(next ?? state).has(rest.rowKey)) refused.push(rest.rowKey);
      }
      break;
    }
    next ??= new Map(state);
    next.set(entry.rowKey, entry);
    rows += 1;
    records += entry.weight;
  }
  return { next: next ?? state, refused };
}

/** Removes the given keys; same reference when none was present. */
export function removeKeys(state: SelectionState, keys: readonly string[]): SelectionState {
  let next: Map<string, SelectionEntry> | null = null;
  for (const key of keys) {
    if (!(next ?? state).has(key)) continue;
    next ??= new Map(state);
    next.delete(key);
  }
  return next ?? state;
}

export function toggleEntry(
  state: SelectionState,
  entry: SelectionEntry,
  limits: SelectionLimits = DEFAULT_LIMITS,
): SelectionState {
  if (state.has(entry.rowKey)) return removeKeys(state, [entry.rowKey]);
  return addEntries(state, [entry], limits).next;
}

/** Every selected key under every kind it carries, in selection order. */
export function keysByKind(state: SelectionState): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of state.values()) {
    for (const kind of entry.kinds) (out[kind] ??= []).push(entry.rowKey);
  }
  return out;
}

export type SelectAllState = "none" | "some" | "all";

/** For a header checkbox over the rows one table renders on this page. */
export function selectAllState(
  entries: readonly SelectionEntry[],
  state: SelectionState,
): SelectAllState {
  if (entries.length === 0) return "none";
  let selected = 0;
  for (const entry of entries) if (state.has(entry.rowKey)) selected += 1;
  if (selected === 0) return "none";
  return selected === entries.length ? "all" : "some";
}

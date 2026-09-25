// Which bulk buttons the appointments bar offers for a selection, and how a
// server result maps back to bookings. Pure — the server actions still apply
// ALLOWED_FROM and the active-patient guard themselves; this only decides
// what to send and how to word the outcome.

export type BulkAction = "arrive" | "noShow" | "cancel" | "confirm" | "revert" | "delete";

/** Mirrors ALLOWED_FROM in appointments/actions.ts (keyed by button, not target). */
export const BULK_ELIGIBLE_FROM: Record<BulkAction, readonly string[]> = {
  arrive: ["confirmed"],
  noShow: ["confirmed"],
  cancel: ["confirmed", "arrived", "pending_callback"],
  confirm: ["pending_callback"],
  revert: ["arrived", "no_show", "cancelled"],
  delete: ["confirmed", "arrived", "no_show", "cancelled", "pending_callback"],
};

/** Statuses the bulk delete may remove — the server enforces this list in the write. */
export const BULK_DELETABLE_STATUSES = BULK_ELIGIBLE_FROM.delete;

/** The server transition each non-delete button fires. */
export const BULK_TARGET: Record<Exclude<BulkAction, "delete">, "arrived" | "no_show" | "cancelled" | "confirmed"> = {
  arrive: "arrived",
  noShow: "no_show",
  cancel: "cancelled",
  confirm: "confirmed",
  revert: "confirmed",
};

/** Buttons that put work back on a patient record and therefore need an active patient. */
const NEEDS_ACTIVE_PATIENT: ReadonlySet<BulkAction> = new Set(["arrive", "confirm", "revert"]);

export interface BulkGroup {
  key: string;
  status: string;
  patientActive: boolean;
}

export interface BulkPlanEntry {
  keys: string[];
  skippedInactive: number;
}

export function bulkActionPlan(
  groups: readonly BulkGroup[],
  isAdmin: boolean,
): Record<BulkAction, BulkPlanEntry> {
  const plan = {} as Record<BulkAction, BulkPlanEntry>;
  for (const action of Object.keys(BULK_ELIGIBLE_FROM) as BulkAction[]) {
    const entry: BulkPlanEntry = { keys: [], skippedInactive: 0 };
    if (action === "delete" && !isAdmin) {
      plan[action] = entry;
      continue;
    }
    const from = BULK_ELIGIBLE_FROM[action];
    for (const group of groups) {
      if (!from.includes(group.status)) continue;
      if (NEEDS_ACTIVE_PATIENT.has(action) && !group.patientActive) {
        entry.skippedInactive += 1;
        continue;
      }
      entry.keys.push(group.key);
    }
    plan[action] = entry;
  }
  return plan;
}

export interface GroupInfo {
  ids: string[];
  status: string;
  patientActive: boolean;
}

export interface Outcome {
  changed: string[];
  partly: string[];
  unchanged: string[];
}

/** Maps the ids a write returned back to the bookings that were sent. */
export function summariseOutcome(
  sentKeys: readonly string[],
  groupsByKey: Record<string, GroupInfo>,
  changedIds: readonly string[],
): Outcome {
  const changedSet = new Set(changedIds);
  const out: Outcome = { changed: [], partly: [], unchanged: [] };
  for (const key of sentKeys) {
    const ids = groupsByKey[key]?.ids ?? [];
    const hits = ids.filter((id) => changedSet.has(id)).length;
    if (ids.length > 0 && hits === ids.length) out.changed.push(key);
    else if (hits > 0) out.partly.push(key);
    else out.unchanged.push(key);
  }
  return out;
}

/** null when every booking changed; otherwise the alert text. */
export function outcomeMessage(verb: string, pastTense: string, outcome: Outcome): string | null {
  const total = outcome.changed.length + outcome.partly.length + outcome.unchanged.length;
  if (outcome.partly.length === 0 && outcome.unchanged.length === 0) return null;
  const firstSentence = pastTense
    ? `${verb} ${outcome.changed.length} of ${total} bookings ${pastTense}.`
    : `${verb} ${outcome.changed.length} of ${total} bookings.`;
  const parts = [firstSentence];
  if (outcome.partly.length > 0) {
    parts.push(
      `${outcome.partly.length} partly changed — open ${outcome.partly.length === 1 ? "it" : "them"} to check.`,
    );
  }
  if (outcome.unchanged.length > 0) parts.push(`${outcome.unchanged.length} had already changed.`);
  return parts.join(" ");
}

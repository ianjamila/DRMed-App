import { SAMPLE_SKIP_REASON } from "@/lib/visits/sample";

// The reasons a release notice is finished without a message, as the words
// stored in release_notices.skip_reason (0210; redacted of addresses and phone
// numbers in SQL). The terminal audit step reads them back to decide which
// audit row the outcome earns, so the sender and the auditor share ONE set.
// Pure — no server-only imports.

export const SKIP_PHYSICAL = "physical hand-off — no message sent";
export const SKIP_SAMPLE = SAMPLE_SKIP_REASON;
export const SKIP_DOCTOR = "consultation — nothing to announce";
export const SKIP_WALK_IN = "walk-in patient — no contact details";
export const SKIP_NO_CONTACT = "no email or phone on file";
/** `patient is not active (deleted|merged|missing)` — the code rides in the brackets. */
export const SKIP_INACTIVE = "patient is not active";
export const CANCEL_REASON = "released tests were undone or deleted";
export const SUPPRESS_REASON = "the same results were already announced in the last 24 hours";

export function inactiveSkipReason(code: string): string {
  return `${SKIP_INACTIVE} (${code})`;
}

export type SkipKind = "sample" | "physical" | "doctor" | "inactive" | "walk_in" | "channels";

export function classifySkip(reason: string | null | undefined): SkipKind {
  const r = reason ?? "";
  if (r === SKIP_SAMPLE) return "sample";
  if (r === SKIP_PHYSICAL) return "physical";
  if (r === SKIP_DOCTOR) return "doctor";
  if (r === SKIP_WALK_IN) return "walk_in";
  if (r.startsWith(SKIP_INACTIVE)) return "inactive";
  return "channels";
}

/** The code inside `patient is not active (<code>)`, or "deleted" when absent. */
export function inactiveCodeOf(reason: string | null | undefined): string {
  const m = /\(([a-z_]+)\)\s*$/.exec(reason ?? "");
  return m ? m[1] : "deleted";
}

/** The plain-language reason the fast path shows for a skip (never the brackets). */
export function outcomeReasonOf(reason: string | null | undefined): string {
  const kind = classifySkip(reason);
  if (kind === "inactive") return SKIP_INACTIVE;
  if (kind === "channels") return SKIP_NO_CONTACT;
  return reason as string;
}

// Plain words for the codes Sheet Sync stores — an admin page, but CLAUDE.md's
// "Plain language by audience" still applies: no raw enum values on screen.
// Pinned to migration 0170's CHECK lists by format.test.ts.
import type { ReviewKind, TabKey } from "@/lib/sheet-sync/types";
import type { ReleaseSummary, RevertSummary } from "@/lib/sheet-sync/run";
import { REFERRAL_SOURCE_LABEL, isReferralSource } from "@/lib/patients/referral-sources";

export const TAB_LABEL: Record<TabKey, string> = {
  customers: "Customers",
  lab: "Lab services",
  consult: "Doctor consultations",
};

export const KIND_LABEL: Record<ReviewKind, string> = {
  ambiguous_patient: "Which patient is this?",
  identity_conflict: "Details don't match the patient",
  possible_existing_patient: "Might already be a patient",
  unmapped_source: "Unknown \"how did you hear\" answer",
  unparseable_date: "Date the sync can't read",
  invalid_row: "Row the sync can't use",
  suspect_snapshot: "Sheet shrank suddenly",
};

export const TRIGGER_LABEL: Record<string, string> = {
  cron: "Nightly",
  manual: "Sync now",
  cli: "Command line",
  resort: "Re-sort approval",
  alias: "Answer mapped",
  revert: "Undo",
  release: "Sync decides again",
};

export const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  succeeded: "Done",
  partial: "Partly done",
  failed: "Failed",
  skipped_paused: "Skipped (paused)",
};

export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * Plain words for an undo's result. Shown twice: right after confirming (the
 * undo dialog's own state, which is lost on the next refresh because
 * revalidatePath re-renders the target run's row as "Undone" and unmounts
 * whatever held that state), and — durably, surviving any refresh — in the
 * undo run's OWN row in Run history, via `run-history.tsx`'s `whatChanged()`.
 * Covers every RevertSummary field so the durable copy is the complete one.
 */
export function revertSummaryLine(r: RevertSummary): string {
  const parts = [
    `Put back ${r.restored}`,
    `Kept ${r.blocked} (changed since)`,
    `Removed ${r.deleted} new patients`,
    `Kept ${r.kept} (in use)`,
  ];
  if (r.gone > 0) parts.push(`${r.gone} already removed by staff`);
  if (r.held > 0) parts.push(`${r.held} link(s) returned to review`);
  if (r.links_left > 0) parts.push(`${r.links_left} link(s) left as they were`);
  if (r.alias_restored > 0) parts.push(`the previous "how did you hear" mapping was restored`);
  if (r.alias_removed > 0) parts.push("the answer mapping was removed");
  return parts.join(" · ");
}

// "Let the sync decide again" belongs on an undo run that held rows back
// (its result counts held > 0) and has not been released yet — refused in
// SQL (22023) otherwise. An undo that never finished its bookkeeping has no
// result; its holds are released from the undo run that finished the job.
export function canRelease(run: {
  trigger: string; status: string; released_by_run_id: string | null; summary: { result?: unknown } | null;
}): boolean {
  if (run.trigger !== "revert" || run.released_by_run_id || run.status === "running") return false;
  const result = run.summary?.result as Partial<RevertSummary> | undefined;
  return !!result && typeof result === "object" && (result.held ?? 0) > 0;
}

/** Plain words for a "Let the sync decide again" run's result (Run history + the dialog). */
export function releaseSummaryLine(r: ReleaseSummary): string {
  const rows = `${r.released} row${r.released === 1 ? "" : "s"} handed back to the sync`;
  return r.items_resolved > 0 ? `${rows} · ${r.items_resolved} review item${r.items_resolved === 1 ? "" : "s"} closed` : rows;
}

// The only per-tab error string run.ts writes in a machine-shaped format —
// everything else that reaches here is already safe to show as-is: run.ts's
// errText() only lets our own hand-authored P00NN/22023 messages through
// unredacted, and rewrites any foreign SQLSTATE to a bare "database error
// <CODE>" (logged in full server-side). This just rewords that one prefix.
const SUSPECT_SNAPSHOT_RE = /^suspect_snapshot: (\d+) → (\d+) rows \(−(\d+)%\)$/;

export function tabErrorLabel(tab: TabKey, error: string | null | undefined): string | null {
  if (!error) return null;
  const m = SUSPECT_SNAPSHOT_RE.exec(error);
  if (!m) return error;
  const [, previous, current, pct] = m;
  return `${KIND_LABEL.suspect_snapshot} — ${TAB_LABEL[tab]} had ${previous} rows last time and ${current} now (−${pct}%). The sync skipped this tab.`;
}

// Plain words for a HANDLED review item's `resolution.action` (0170's
// sheet_review_resolve / sheet_alias_apply write it as jsonb: `{action, ...}`).
// Shown only in the review queue's "Show handled" list — the open list never
// reads `resolution`, it doesn't exist until the item is resolved/dismissed.
export const RESOLUTION_ACTION_LABEL: Record<string, string> = {
  link: "Linked to a patient",
  create: "Created a new patient",
  dismiss: "Dismissed",
  alias: "Answer mapped to a channel",
  released: "Released — the sync decides again",
};

/**
 * True for a review item 0170's `sheet_sync_upsert_review` auto-cleared
 * (`p_clear_absent`) because a later sync no longer reports it — a *system*
 * resolution, not an admin decision: `resolved_by` stays NULL and
 * `resolution` is `{auto: 'no longer reported by the sheet'}`, a different
 * shape from every admin resolution's `{action, ...}`.
 */
export function isAutoResolution(resolution: Record<string, unknown> | null | undefined): boolean {
  return !!resolution && typeof resolution.auto === "string";
}

/**
 * One line for a resolved/dismissed item's resolution. `dismiss` with
 * `keep_undone: true` (0170 round 3+5) is the "Keep undone" outcome, not a
 * plain dismiss — the admin re-affirmed an undo hold rather than clearing it.
 * `alias` names the channel it was mapped to when the id is one this page
 * knows (`isReferralSource`); an id added to the lookup without a matching
 * label here falls back to the bare action word rather than showing nothing.
 * An auto-clear (see `isAutoResolution`) reads as "Cleared", never as the raw
 * `resolution.auto` text — that text is a fixed internal marker, not a
 * message meant for a screen.
 */
export function resolutionSummary(resolution: Record<string, unknown> | null | undefined): string {
  if (!resolution) return "—";
  if (isAutoResolution(resolution)) return "Cleared — no longer in the sheet";
  const action = typeof resolution.action === "string" ? resolution.action : undefined;
  if (action === "dismiss" && resolution.keep_undone === true) {
    // Raised straight into this state by the sync after an undo (0170's
    // sheet_sync_upsert_review, auto_from_undo): the undo was the decision.
    return resolution.auto_from_undo === true ? "Kept undone (by the undo)" : "Kept undone";
  }
  if (action === "alias") {
    const id = resolution.referral_source_id;
    if (typeof id === "string" && isReferralSource(id)) return `Mapped to ${REFERRAL_SOURCE_LABEL[id]}`;
    return RESOLUTION_ACTION_LABEL.alias;
  }
  return (action && RESOLUTION_ACTION_LABEL[action]) || "—";
}

// ---------------------------------------------------------------------------
// "Done" banner — a one-time success message that survives the row/group it
// came from disappearing off the open list. Map answer and Approve group
// both navigate to `?...&done=<kind>&n=<count>` on success (review-actions.tsx's
// `useGoDone`), which re-fetches the page as a side effect of the new URL;
// page.tsx renders this as a role="status" banner and then strips the
// params back out of the URL so a later refresh doesn't repeat it.
// ---------------------------------------------------------------------------

export const DONE_KINDS = ["alias", "resort"] as const;
export type DoneKind = (typeof DONE_KINDS)[number];

export function isDoneKind(value: string | undefined): value is DoneKind {
  return !!value && (DONE_KINDS as readonly string[]).includes(value);
}

const DONE_MESSAGE: Record<DoneKind, (n: number) => string> = {
  alias: (n) => `Answer mapped — ${n} patient${n === 1 ? "" : "s"} updated. You can undo it from Run history.`,
  resort: (n) => `Group approved — ${n} patient${n === 1 ? "" : "s"} updated. You can undo it from Run history.`,
};

export function doneBannerMessage(kind: DoneKind, n: number): string {
  return DONE_MESSAGE[kind](n);
}

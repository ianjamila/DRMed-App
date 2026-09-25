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

// Plain words for a real (non-dry-run) sync's customers `applied` counts
// (0170's sheet_sync_apply_customer_ops counts jsonb: created, linked,
// filled, facts, held, skipped, stale, skipped_existing). Only the counts
// worth calling out on screen have a label; an unlisted key (held, facts,
// the generic skipped) is left off rather than shown as a raw code. `stale`
// is an op the sync skipped because the patient changed since it read the
// sheet (link or fill) — the next run re-plans it from a fresh read.
// `skipped_existing` is a create the sync skipped because someone matching
// this exact person (same normalized name + birthdate, or name + phone) was
// already a live patient — the next run links the sheet row to them instead
// of creating a duplicate.
export const APPLIED_COUNT_LABEL: Partial<Record<string, (n: number) => string>> = {
  created: (n) => `${n} created`,
  filled: (n) => `${n} filled`,
  linked: (n) => `${n} linked`,
  stale: (n) => `${n} skipped — changed since the sync read them (next sync retries)`,
  skipped_existing: (n) => `${n} skipped — already registered (next sync links them)`,
};

/** Ordered, non-zero parts of a customers `applied` count record, in `APPLIED_COUNT_LABEL`'s key order. */
export function appliedChangeParts(applied: Record<string, number> | undefined | null): string[] {
  if (!applied) return [];
  return Object.keys(APPLIED_COUNT_LABEL)
    .map((k) => {
      const n = applied[k];
      return n ? APPLIED_COUNT_LABEL[k]!(n) : null;
    })
    .filter((b): b is string => b !== null);
}

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

// Sync runs (cron/manual/cli) are the only ones whose failure can still have
// committed patient writes: applyCustomerOps runs in 500-op chunks (run.ts's
// OPS_CHUNK), so a run that later fails — even one whose OWN bookkeeping row
// never got to "finished" and was reclaimed as failed — can have written
// real changes before the failure. The SQL guard (0170) itself allows
// undoing any non-running, non-revert, not-already-undone run regardless of
// status; this only widens the UI to match it.
const SYNC_TRIGGERS = new Set(["cron", "manual", "cli"]);

// Cheap heuristic from data already on the row (no extra query): only a
// customers op — create/link/fill/facts/hold — writes to sheet_sync_changes;
// lab/consult are mirror-only and never touch a patient. If per_tab lacks
// applied counts (an old row, or the customers tab itself failed before any
// op ran) we can't be sure there's nothing to undo — default to TRUE so an
// unmeasured change is never hidden from Undo. Chosen over an extra
// `sheet_sync_changes` count query: this reuses the row already fetched.
export function hasCommittedChanges(run: { per_tab: Record<string, { applied?: Record<string, number> }> | null }): boolean {
  const applied = run.per_tab?.customers?.applied;
  if (!applied) return true;
  return Object.values(applied).some((n) => n > 0);
}

// The Undo action is refused in SQL (22023) for a run that is itself an
// undo, a still-running run, or an already-undone run — hide the button for
// those instead of letting an admin hit a wall.
// Re-sort and answer-mapping runs are undoable too (plan D3): they can
// commit their patient writes (resortApply / aliasApply) and then still end
// up `failed` if only the run's own finish bookkeeping errors afterward
// (withAdminLease's separate finish try, run.ts) — so `failed` is undoable
// for them exactly like it is for a sync run, once they've actually run.
export function canUndo(run: {
  trigger: string; status: string; dry_run: boolean; reverted_by_run_id: string | null;
  per_tab: Record<string, { applied?: Record<string, number> }> | null;
}): boolean {
  if (run.dry_run || run.reverted_by_run_id) return false;
  if (SYNC_TRIGGERS.has(run.trigger)) {
    return (run.status === "succeeded" || run.status === "partial" || run.status === "failed") && hasCommittedChanges(run);
  }
  return (run.trigger === "resort" || run.trigger === "alias") && (run.status === "succeeded" || run.status === "failed");
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

/**
 * A HANDLED item that still takes Link / Create: an identity item kept undone
 * (an admin's Keep undone, or raised that way after an undo). Keeping a row
 * undone parks it without answering who it is, so 0170's sheet_review_resolve
 * accepts link / create on it (never dismiss). Everything else handled is
 * read-only.
 */
export function isKeptUndoneActionable(item: {
  kind: string; status: string; resolution: Record<string, unknown> | null | undefined;
}): boolean {
  return item.status === "dismissed"
    && (item.kind === "ambiguous_patient" || item.kind === "identity_conflict" || item.kind === "possible_existing_patient")
    && item.resolution?.keep_undone === true;
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

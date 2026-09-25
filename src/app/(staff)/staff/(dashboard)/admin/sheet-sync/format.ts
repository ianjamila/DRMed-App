// Plain words for the codes Sheet Sync stores — an admin page, but CLAUDE.md's
// "Plain language by audience" still applies: no raw enum values on screen.
// Pinned to migration 0170's CHECK lists by format.test.ts.
import type { ReviewKind, TabKey } from "@/lib/sheet-sync/types";
import type { RevertSummary } from "@/lib/sheet-sync/run";

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

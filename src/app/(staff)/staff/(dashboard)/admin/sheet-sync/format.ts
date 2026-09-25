// Plain words for the codes Sheet Sync stores — an admin page, but CLAUDE.md's
// "Plain language by audience" still applies: no raw enum values on screen.
// Pinned to migration 0170's CHECK lists by format.test.ts.
import type { ReviewKind, TabKey } from "@/lib/sheet-sync/types";

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

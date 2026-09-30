import { manilaISODate } from "@/lib/dates/manila";

// The Closures page's "Affected" column: what "Reschedule all" would move on
// each closed day. It is the same count as reschedule_closure_appointments
// (p_dry_run => true) in 0184 — confirmed/arrived bookings on that Manila day,
// split into ones the action moves (no patient record, or an active one) and
// ones it leaves alone (a deleted or merged record). Counting all upcoming
// closures from ONE appointments read replaces one dry-run RPC call per
// closure. closure-preview.test.ts pins these rules to the RPC's SQL text.

export const CLOSURE_RESCHEDULE_STATUSES = ["confirmed", "arrived"] as const;

export interface ClosurePreviewRow {
  scheduled_at: string | null;
  patient_id: string | null;
  // null when patient_id points at no readable row — counted as left alone,
  // like the RPC's `p.id is null` branch.
  patients: { deleted_at: string | null; merged_into_id: string | null } | null;
}

export interface ClosurePreview {
  affected: number;
  skippedInactive: number;
}

export function closurePreviewCounts(
  closedOn: readonly string[],
  rows: readonly ClosurePreviewRow[],
): Map<string, ClosurePreview> {
  const out = new Map<string, ClosurePreview>(closedOn.map((d) => [d, { affected: 0, skippedInactive: 0 }]));
  for (const row of rows) {
    const bucket = out.get(manilaISODate(row.scheduled_at) ?? "");
    if (!bucket) continue; // an open day between two closures
    const moves =
      row.patient_id === null ||
      (row.patients !== null && row.patients.deleted_at === null && row.patients.merged_into_id === null);
    if (moves) bucket.affected += 1;
    else bucket.skippedInactive += 1;
  }
  return out;
}

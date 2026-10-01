// src/lib/patients/merge-fields.ts
// The single TypeScript copy of what a patient merge touches (0196). The SQL
// functions merge_patients_guarded / undo_patient_merge_guarded hold the
// authoritative lists; merge-migration.test.ts pins these constants to the
// migration text so the UI labels and the FK inventory cannot drift from it.
// Pure: imported by client components, server actions and tests.

// Fields a merge copies from the merged-in record onto the kept record when
// the kept record's value is NULL or blank. Never overwrites. Birthdate joined
// the admin merge in 0196 (the dedup CLI always filled it).
export const MERGE_FILL_FIELDS = ["middle_name", "sex", "phone", "email", "address", "birthdate"] as const;
export type MergeFillField = (typeof MERGE_FILL_FIELDS)[number];

export const MERGE_FILL_LABELS: Record<MergeFillField, string> = {
  middle_name: "middle name",
  sex: "sex",
  phone: "phone",
  email: "email",
  address: "address",
  birthdate: "birthdate",
};

// Tables whose patient_id a merge moves, in the order the SQL moves them
// (visits before critical_alerts: 0184's alert-matches-its-test check).
export const MERGE_MOVED_TABLES = [
  "visits",
  "appointments",
  "audit_log",
  "critical_alerts",
  "patient_consents",
  "appointment_attachments",
] as const;
export type MergeMovedTable = (typeof MERGE_MOVED_TABLES)[number];

export const MERGE_MOVED_LABELS: Record<MergeMovedTable, { one: string; many: string }> = {
  visits: { one: "visit", many: "visits" },
  appointments: { one: "appointment", many: "appointments" },
  audit_log: { one: "audit row", many: "audit rows" },
  critical_alerts: { one: "critical alert", many: "critical alerts" },
  patient_consents: { one: "consent record", many: "consent records" },
  appointment_attachments: { one: "lab-request form", many: "lab-request forms" },
};

export function isMergeFillField(f: string): f is MergeFillField {
  return (MERGE_FILL_FIELDS as readonly string[]).includes(f);
}

// The undo window, enforced in SQL (undo_patient_merge_guarded) — this copy
// only drives the page's own filter and wording.
export const MERGE_UNDO_WINDOW_DAYS = 30;

// Rows per page on the Recently merged list. Lives here, not in the
// "use server" actions file: a server-action module may export only async
// functions.
export const RECENT_MERGES_PAGE_SIZE = 25;

// The patient's data export (portal › Download my data) includes the recent
// audit rows filed under their record. Those rows are the CLINIC's compliance
// ledger: staff actions on the patient's results carry clinic-only free text in
// their metadata — the reason a finished result was corrected (owner decision
// 2026-09-25: never shown to patients), an undo-release or deletion reason, a
// staff note. The export keeps every event (what happened, when, by which kind
// of actor) and drops those texts. Codex review 2026-09-25.
//
// Pure, so it is unit-tested without a database.

/** Metadata keys that hold staff-written free text or clinical snapshots. */
const CLINIC_ONLY_KEY = /(reason|note|remark|comment|prior_values)/i;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function scrub(value: Json): Json {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) {
      if (CLINIC_ONLY_KEY.test(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

export interface ExportAuditRow {
  id: number | string;
  action: string;
  actor_type: string;
  created_at: string;
  metadata: unknown;
}

export function patientSafeAuditRows<T extends ExportAuditRow>(rows: readonly T[]): T[] {
  return rows.map((r) => ({ ...r, metadata: r.metadata == null ? r.metadata : scrub(r.metadata as Json) }));
}

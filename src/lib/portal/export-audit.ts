// The patient's data export (portal › Download my data) includes the recent
// audit rows filed under their record. Those rows are the CLINIC's compliance
// ledger: staff actions on the patient's results carry clinic-only free text in
// their metadata — the reason a finished result was corrected (owner decision
// 2026-09-25: never shown to patients), an undo-release or deletion reason, a
// staff note, or a provider (SMS/email) failure message nested under
// `sms.error` / `email.error` on a `result.notified` row. The export keeps
// every event (what happened, when, by which kind of actor) and drops those
// texts. A key matching CLINIC_ONLY_KEY (reason/note/remark/comment/
// prior_values, substring, any depth) survives only when its value is
// EXACTLY one of the known machine-written system codes — a staff note that
// merely looks code-like ("visit_created!") is still dropped. A key named
// `error` (exact match, any depth) never survives, even when its value looks
// like a system code: provider/internal error text is always clinic-only.
// Codex review 2026-09-25.
//
// Pure, so it is unit-tested without a database.

/** Metadata keys that hold staff-written free text or clinical snapshots. */
const CLINIC_ONLY_KEY = /(reason|note|remark|comment|prior_values)/i;

/** Provider/internal error text — clinic-only, never eligible for the system-code allowlist. */
const ERROR_KEY = /^error$/i;

/** Machine-written codes that may sit under a clinic-only key name. Exact match only. Owner decision 2026-09-25. */
const SYSTEM_CODES: ReadonlySet<string> = new Set(["visit_created", "manual_reissue"]);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function scrub(value: Json): Json {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) {
      if (ERROR_KEY.test(k)) continue;
      if (CLINIC_ONLY_KEY.test(k)) {
        if (typeof v === "string" && SYSTEM_CODES.has(v)) out[k] = v;
        continue;
      }
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

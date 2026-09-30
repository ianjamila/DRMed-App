// The one active-patient rule (0167): a patient record is ACTIVE when it is
// neither soft-deleted nor merged into another record. Every directory,
// picker and matching query applies it; history lookups (visits, receipts,
// payments, reports, audit) deliberately do not. The lab worklists (the queue
// and the results archive) and the dashboard cards that count them DO, per
// owner decision 2026-09-30 — a deleted or merged-away patient's tests are
// hidden there, not just badged. The SQL side of the same
// rule lives in the 0167 views and functions (active-views.test.ts), and
// src/lib/patients/query-surfaces.test.ts classifies every patients read.
//
// Pure — no server-only import — so it is unit-testable and usable from
// scripts.

export interface PatientLifecycle {
  drm_id: string;
  deleted_at: string | null;
  merged_into_id: string | null;
}

/** The select fragment a lifecycle check needs. */
export const PATIENT_LIFECYCLE_COLUMNS = "drm_id, deleted_at, merged_into_id";

interface IsFilterable {
  is(column: string, value: null): unknown;
}

/**
 * Restrict a `patients` query to active records. Wrap the builder DIRECTLY —
 * `activePatients(db.from("patients").select(...))` — so the inventory test
 * can see it at the call site. Only for the `patients` table; the 0167 views
 * already apply the rule in SQL and have no lifecycle columns.
 */
export function activePatients<Q>(query: Q): Q {
  const withDeleted = (query as unknown as IsFilterable).is("deleted_at", null);
  return (withDeleted as IsFilterable).is("merged_into_id", null) as Q;
}

/**
 * Restrict a query to rows whose EMBEDDED patient is active. `embed` is the
 * dotted path to a `patients!inner` embed (e.g. "visits.patients"); every hop
 * must be `!inner`, or PostgREST silently ignores the filter (CLAUDE.md).
 * Wrap the builder directly — `query = activeEmbeddedPatients(query, "visits.patients")`
 * — so the inventory test can see it at the call site.
 */
export function activeEmbeddedPatients<Q>(query: Q, embed: string): Q {
  const withDeleted = (query as unknown as IsFilterable).is(`${embed}.deleted_at`, null);
  return (withDeleted as IsFilterable).is(`${embed}.merged_into_id`, null) as Q;
}

export function isActivePatient(p: PatientLifecycle | null | undefined): boolean {
  return !!p && p.deleted_at === null && p.merged_into_id === null;
}

export function firstInactivePatient<T extends PatientLifecycle>(rows: readonly T[]): T | null {
  return rows.find((r) => !isActivePatient(r)) ?? null;
}

/** Staff-facing refusal for a write aimed at an inactive (or missing) record. */
export function inactivePatientError(p: PatientLifecycle | null | undefined): string {
  if (!p) return "We couldn't find that patient. Search again.";
  if (p.merged_into_id !== null) {
    return `${p.drm_id} was merged into another record. Open the surviving record instead.`;
  }
  return `${p.drm_id} was deleted. An admin can restore it from Admin Tools › Deleted Patients before anything else is done on it.`;
}

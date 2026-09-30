import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { PATIENT_LIFECYCLE_COLUMNS, type PatientLifecycle } from "./active";
import { activeCheck, chunkIds, type ActiveCheck } from "./require-active-core";

// App-level refusal of writes aimed at an inactive (deleted or merged)
// patient — spec "History pages keep working": history stays readable, but
// nothing new is done on it until an admin restores the record. Pass the
// admin client: the check must see the lifecycle columns whatever the
// caller's RLS. Each helper resolves its rows to DISTINCT patient ids, then
// checks them in one query. Walk-in appointments (patient_id NULL) pass.
//
// PR 3 adds the database twin (child-table activity guards under the shared
// lifecycle lock); these stay as the friendly first line.

type Db = SupabaseClient<Database>;
export type { ActiveCheck };

const CHUNK = 200;
const uniq = (ids: readonly (string | null | undefined)[]) =>
  [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];

/**
 * The one place every `.in("id", …)` in this file goes through. `ids` may be
 * caller-supplied and unbounded (bulk release, an HMO claim batch), so this
 * dedupes and splits into CHUNK-sized `.in()` calls rather than sending one
 * query with hundreds of values — the same protection the final patients
 * lookup already had, now shared by every intermediate resolution query too.
 */
async function selectByIds<Row>(
  ids: readonly (string | null | undefined)[],
  fetch: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Row[] | null> {
  const unique = uniq(ids);
  if (unique.length === 0) return [];
  const out: Row[] = [];
  for (const chunk of chunkIds(unique, CHUNK)) {
    const { data, error } = await fetch(chunk);
    if (error) return null;
    out.push(...((data ?? []) as unknown as Row[]));
  }
  return out;
}

async function lifecycleRows(db: Db, patientIds: readonly string[]): Promise<PatientLifecycle[] | null> {
  return selectByIds<PatientLifecycle>(patientIds, (chunk) =>
    db.from("patients").select(`id, ${PATIENT_LIFECYCLE_COLUMNS}`).in("id", chunk),
  );
}

const LOOKUP_FAILED: ActiveCheck = { ok: false, error: "Could not check the patient record. Try again." };

export async function assertPatientsActive(db: Db, patientIds: readonly (string | null | undefined)[]): Promise<ActiveCheck> {
  const ids = uniq(patientIds);
  if (ids.length === 0) return { ok: true };
  const rows = await lifecycleRows(db, ids);
  return rows ? activeCheck(rows, ids.length) : LOOKUP_FAILED;
}

export function assertPatientActive(db: Db, patientId: string): Promise<ActiveCheck> {
  return assertPatientsActive(db, [patientId]);
}

export async function assertVisitsPatientsActive(db: Db, visitIds: readonly string[]): Promise<ActiveCheck> {
  const rows = await selectByIds<{ patient_id: string | null }>(visitIds, (chunk) =>
    db.from("visits").select("patient_id").in("id", chunk),
  );
  if (!rows) return LOOKUP_FAILED;
  return assertPatientsActive(db, rows.map((v) => v.patient_id));
}

export function assertVisitPatientActive(db: Db, visitId: string): Promise<ActiveCheck> {
  return assertVisitsPatientsActive(db, [visitId]);
}

export async function assertTestRequestsPatientsActive(db: Db, testRequestIds: readonly string[]): Promise<ActiveCheck> {
  const rows = await selectByIds<{ visit_id: string }>(testRequestIds, (chunk) =>
    db.from("test_requests").select("visit_id").in("id", chunk),
  );
  if (!rows) return LOOKUP_FAILED;
  return assertVisitsPatientsActive(db, rows.map((t) => t.visit_id));
}

export async function assertPaymentPatientActive(db: Db, paymentId: string): Promise<ActiveCheck> {
  const { data, error } = await db.from("payments").select("visit_id").eq("id", paymentId).maybeSingle();
  if (error) return LOOKUP_FAILED;
  return data ? assertVisitPatientActive(db, data.visit_id) : { ok: true };
}

export async function assertAppointmentsPatientsActive(db: Db, appointmentIds: readonly string[]): Promise<ActiveCheck> {
  const rows = await selectByIds<{ patient_id: string | null }>(appointmentIds, (chunk) =>
    db.from("appointments").select("patient_id").in("id", chunk),
  );
  if (!rows) return LOOKUP_FAILED;
  return assertPatientsActive(db, rows.map((a) => a.patient_id));
}

export async function assertClaimItemsPatientsActive(db: Db, itemIds: readonly string[]): Promise<ActiveCheck> {
  const rows = await selectByIds<{ test_request_id: string }>(itemIds, (chunk) =>
    db.from("hmo_claim_items").select("test_request_id").in("id", chunk),
  );
  if (!rows) return LOOKUP_FAILED;
  return assertTestRequestsPatientsActive(db, rows.map((i) => i.test_request_id));
}

export async function assertBatchPatientsActive(db: Db, batchId: string): Promise<ActiveCheck> {
  const { data, error } = await db.from("hmo_claim_items").select("test_request_id").eq("batch_id", batchId);
  if (error) return LOOKUP_FAILED;
  return assertTestRequestsPatientsActive(db, (data ?? []).map((i) => i.test_request_id));
}

export async function assertResolutionPatientActive(db: Db, resolutionId: string): Promise<ActiveCheck> {
  const { data, error } = await db.from("hmo_claim_resolutions").select("item_id").eq("id", resolutionId).maybeSingle();
  if (error) return LOOKUP_FAILED;
  return data ? assertClaimItemsPatientsActive(db, [data.item_id]) : { ok: true };
}

/**
 * Which of these test_requests currently belong to an ACTIVE patient — for a
 * bulk write that must SKIP an inactive patient's row instead of failing the
 * whole statement (0184 review minor #1): a single multi-row UPDATE aborts
 * wholesale the instant any ONE row's a_lifecycle_guard trigger refuses it,
 * so a bulk action over many rows (bulkSetHmoResponseAction) has to exclude
 * an inactive patient's row BEFORE the write, not discover it as a failure.
 * Same shape as the queue's per-row bulk claim/unclaim skip and the closures
 * bulk reschedule's skip count. Returns null only on a lookup failure —
 * callers should treat that as "skip everything" (fail closed).
 */
export async function activeTestRequestIds(
  db: Db,
  testRequestIds: readonly string[],
): Promise<Set<string> | null> {
  const rows = await selectByIds<{ id: string; visit_id: string }>(testRequestIds, (chunk) =>
    db.from("test_requests").select("id, visit_id").in("id", chunk),
  );
  if (!rows) return null;
  const visits = await selectByIds<{ id: string; patient_id: string }>(
    rows.map((r) => r.visit_id),
    (chunk) => db.from("visits").select("id, patient_id").in("id", chunk),
  );
  if (!visits) return null;
  const patientByVisit = new Map(visits.map((v) => [v.id, v.patient_id]));
  const patients = await selectByIds<{ id: string; deleted_at: string | null; merged_into_id: string | null }>(
    visits.map((v) => v.patient_id),
    (chunk) => db.from("patients").select("id, deleted_at, merged_into_id").in("id", chunk),
  );
  if (!patients) return null;
  const activeByPatient = new Map(patients.map((p) => [p.id, p.deleted_at === null && p.merged_into_id === null]));
  const out = new Set<string>();
  for (const r of rows) {
    const patientId = patientByVisit.get(r.visit_id);
    if (patientId && activeByPatient.get(patientId)) out.add(r.id);
  }
  return out;
}

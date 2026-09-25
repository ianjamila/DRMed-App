import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { PATIENT_LIFECYCLE_COLUMNS } from "@/lib/patients/active";

// The last check before ANY patient email/SMS provider call (0167). Reads the
// record fresh — deferred work (cron, retries) carries the patient_id, never a
// cached address. A deleted or merged record gets NOTHING on any channel and
// never falls back to an appointment's walk-in contact fields; a genuinely
// NULL patient id is a walk-in and is the caller's business. Staff alerts,
// newsletters and contact-form replies do not go through here (see
// patient-senders.test.ts). A provider call already admitted before a delete
// can still be in flight — that is the documented delivery boundary.

export interface RecipientPatient {
  id: string;
  drm_id: string;
  first_name: string;
  email: string | null;
  phone: string | null;
}

export type RecipientCheck =
  | { kind: "walk_in" }
  | { kind: "active"; patient: RecipientPatient }
  | { kind: "inactive"; patientId: string; reason: "deleted" | "merged" | "missing" | "lookup_failed" };

interface RecipientRow extends RecipientPatient {
  deleted_at: string | null;
  merged_into_id: string | null;
}

export function recipientDecision(patientId: string | null, row: RecipientRow | null): RecipientCheck {
  if (patientId === null) return { kind: "walk_in" };
  if (!row) return { kind: "inactive", patientId, reason: "missing" };
  if (row.merged_into_id !== null) return { kind: "inactive", patientId, reason: "merged" };
  if (row.deleted_at !== null) return { kind: "inactive", patientId, reason: "deleted" };
  return {
    kind: "active",
    patient: { id: row.id, drm_id: row.drm_id, first_name: row.first_name, email: row.email, phone: row.phone },
  };
}

export async function checkPatientRecipient(
  db: SupabaseClient<Database>,
  patientId: string | null,
): Promise<RecipientCheck> {
  if (patientId === null) return { kind: "walk_in" };
  const { data, error } = await db
    .from("patients")
    .select(`id, first_name, email, phone, ${PATIENT_LIFECYCLE_COLUMNS}`)
    .eq("id", patientId)
    .maybeSingle();
  // Fail closed: if we cannot prove the record is active, do not send.
  if (error) return { kind: "inactive", patientId, reason: "lookup_failed" };
  return recipientDecision(patientId, (data as RecipientRow | null) ?? null);
}

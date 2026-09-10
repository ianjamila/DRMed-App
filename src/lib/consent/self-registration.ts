import type { Database } from "@/types/database";
import type { PatientResolution } from "@/lib/appointments/create";
import { CURRENT_CONSENT_NOTICE_VERSION } from "./notice";

type ConsentInsert = Database["public"]["Tables"]["patient_consents"]["Insert"];

/**
 * The one shape of a public self-service consent grant — written by /register
 * and, for a brand-new patient only, by /schedule. actor_kind 'patient' and no
 * created_by: the patient granted it themselves; no staff member vouched.
 *
 * Pure (no server-only) so the row shape is unit-tested and both public forms
 * cannot drift apart.
 */
export function selfRegistrationGrant(input: {
  patientId: string;
  ip: string | null;
  userAgent: string | null;
}): ConsentInsert {
  return {
    patient_id: input.patientId,
    event_type: "granted",
    method: "self_registration",
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: "self",
    actor_kind: "patient",
    ip: input.ip,
    user_agent: input.userAgent,
  };
}

/**
 * A public booking form may record consent ONLY for a patient it just created.
 * A dedup match ("reused"), an existing/portal patient or a walk-in must never
 * have their consent state re-affirmed from a public form — otherwise anyone
 * who knows a patient's email + surname + birthdate could "consent" for them.
 */
export function shouldRecordBookingConsent(
  resolution: PatientResolution["resolution"],
  serviceAgreement: boolean,
): boolean {
  return resolution === "created" && serviceAgreement === true;
}

/** The shape of the insert error both callers get back from PostgREST. */
export interface ConsentInsertError {
  message: string;
  code?: string;
}

export interface RecordConsentDeps {
  insertGrant: (row: ConsentInsert) => Promise<{ error: ConsentInsertError | null }>;
  reportFailure: (error: unknown, metadata: Record<string, unknown>) => Promise<void> | void;
}

/** PostgREST stamps a `code` on a rejected insert; a thrown transport error may not. */
function errorCode(failure: unknown): string | undefined {
  if (typeof failure !== "object" || failure === null) return undefined;
  const code = (failure as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Write a self-service consent grant, and never let its failure take down the
 * registration or booking that earned it — the patient row already exists, so
 * failing here would lose the whole submission to save a row staff can capture
 * at the counter. Instead the gap is surfaced (Sentry + a system.error audit
 * row) and the patient falls into the "Patients without consent" report,
 * because the sync_patient_consent_state trigger never flipped
 * patients.consent_current.
 *
 * Returns whether the row actually landed, so the caller audits what happened
 * (`consent_recorded`) instead of asserting a success it never checked.
 */
export async function recordSelfRegistrationGrant(
  deps: RecordConsentDeps,
  input: {
    patientId: string;
    ip: string | null;
    userAgent: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  let failure: unknown = null;
  try {
    // PostgREST returns a rejected row as `{ error }`; only transport
    // failures throw, and those must not lose the submission either.
    const { error } = await deps.insertGrant(selfRegistrationGrant(input));
    if (!error) return true;
    failure = error;
  } catch (thrown) {
    failure = thrown;
  }
  try {
    await deps.reportFailure(failure, {
      code: errorCode(failure),
      patient_id: input.patientId,
      ...input.metadata,
    });
  } catch {
    // The reporter is best-effort: a Sentry/audit outage must not turn a
    // missing consent row into a failed registration.
  }
  return false;
}

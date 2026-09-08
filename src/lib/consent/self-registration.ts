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

// Finding 9: pure matcher for completeArrivedAppointmentsForPatientAction
// (src/app/(staff)/staff/(dashboard)/appointments/actions.ts). NO
// "server-only" import so this is vitest-testable without a DB.
//
// Starting a visit from the patient's page (no appointment_id threaded)
// used to complete EVERY "arrived" appointment the patient had, regardless
// of which services the new visit actually covers. A patient arrived for
// both a separate lab visit and a doctor consultation would have BOTH
// appointments closed out by creating just the lab visit — the consultation
// silently vanished from the queue while the patient was still sitting
// there waiting for it.
//
// The fix matches at the service level: an arrived appointment only
// completes when its own `service_id` is one the new visit actually billed
// for. Appointments for services the visit does NOT cover are left
// untouched, deliberately — a stuck "arrived" appointment is a nuisance
// reception can close manually; an appointment silently marked complete is
// a patient who never gets seen. This does not sweep booking-group
// siblings the way completeAppointmentFromVisitAction does (that path
// knows the whole group was the SAME booking the visit was started from;
// this path only knows the visit's own service list).
export interface ArrivedAppointmentRow {
  id: string;
  service_id: string | null;
}

/**
 * Returns the ids of `arrived` that should be marked completed by a visit
 * covering `visitServiceIds` — every appointment whose `service_id` is one
 * of the visit's, and nothing else. An appointment with a null
 * `service_id` (the column is nullable; should not happen for a real
 * booking) never matches, so it is left open rather than guessed at.
 */
export function matchArrivedAppointmentsForServices(
  arrived: ReadonlyArray<ArrivedAppointmentRow>,
  visitServiceIds: ReadonlyArray<string>,
): string[] {
  if (visitServiceIds.length === 0 || arrived.length === 0) return [];
  const wanted = new Set(visitServiceIds);
  return arrived
    .filter((a) => a.service_id != null && wanted.has(a.service_id))
    .map((a) => a.id);
}

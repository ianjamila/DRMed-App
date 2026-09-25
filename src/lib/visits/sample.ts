/**
 * Sample / training visits (0181, `visits.is_sample`).
 *
 * The flag badges a visit and stops the app contacting the patient about it;
 * it does not change what the visit counts toward — deleting it does that
 * (deleted visits drop out of every report). Owner decisions 2026-09-25:
 * reception AND admin may mark or unmark; never contact the patient.
 *
 * Who may flip it is enforced HERE, not in the database: "visits: staff full"
 * (0151) lets every staff role update a visit, so setVisitSampleAction checks
 * `canMarkSample` and audit-logs every change.
 */

export const SAMPLE_MARK_ROLES: ReadonlySet<string> = new Set([
  "reception",
  "admin",
]);

export function canMarkSample(role: string): boolean {
  return SAMPLE_MARK_ROLES.has(role);
}

/** Shown in place of a patient message the app refuses to send. */
export const SAMPLE_NO_CONTACT_MESSAGE =
  "This is a sample visit — nothing is sent to the patient.";

/** Audit `reason` for a notification skipped because the visit is a sample. */
export const SAMPLE_SKIP_REASON = "sample visit — no message sent";

/** `?sample=1` on Visit Records narrows the list to sample visits. */
export function parseSampleFilter(raw: string | string[] | undefined): boolean {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "1";
}

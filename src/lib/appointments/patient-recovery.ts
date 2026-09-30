import type { PatientResolution } from "@/lib/appointments/create";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";

// NOTE: no `import "server-only"` (directly or transitively) — this module
// must stay unit-testable without a DB. `PatientResolution` is imported as a
// type only (erased at build time), so it never pulls in `./create`'s
// runtime module graph (which does transitively import `server-only` via
// `translatePgError`).

export const LOOKUP_AGAIN_ERROR = "We couldn't use that patient record. Look the patient up again, then book.";

// The public/portal booking form has no patient picker to "look up again" —
// whoever is booking is either signed in to the portal or typing their own
// details, so telling them to "look the patient up" is staff wording on a
// patient-facing screen. Same non-disclosure rule as LOOKUP_AGAIN_ERROR (must
// never say whether a record was deleted or merged): tell the patient what
// to do next without naming why (0184 review minor #5).
export const PORTAL_LOOKUP_AGAIN_ERROR =
  "We couldn't book this appointment. Please sign in again, or contact the clinic if this keeps happening.";

/**
 * Insert the booking rows; recover once from a patient that stopped being
 * active between resolution and insert (0184: the insert re-checks under the
 * patient's lifecycle lock). A patient RESOLVED from typed details is resolved
 * again and the insert retried once; a patient chosen by id (staff picker,
 * portal session) is never silently swapped — the caller gets a generic
 * lookup-again error that does not say whether a record was deleted.
 *
 * `lookupAgainError` lets a patient-facing caller swap in wording that fits a
 * screen with no staff patient picker (PORTAL_LOOKUP_AGAIN_ERROR) instead of
 * duplicating this function's recovery logic; it defaults to the staff
 * wording (LOOKUP_AGAIN_ERROR) for every existing caller.
 */
export async function insertWithPatientRecovery<T>(args: {
  patient: PatientResolution;
  insert: (patient: PatientResolution) => PromiseLike<{ data: T | null; error: { code?: string | null; message: string } | null }>;
  resolveAgain: () => Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }>;
  lookupAgainError?: string;
}): Promise<{ ok: true; data: T; patient: PatientResolution } | { ok: false; error: { code?: string | null; message: string } | string }> {
  const lookupAgainError = args.lookupAgainError ?? LOOKUP_AGAIN_ERROR;
  let patient = args.patient;
  let res = await withLifecycleRetry(() => args.insert(patient));
  if (res.error?.code === "P0058") {
    if (patient.resolution !== "reused" && patient.resolution !== "created") {
      return { ok: false, error: lookupAgainError };
    }
    const again = await args.resolveAgain();
    if (!again.ok) return { ok: false, error: again.error };
    patient = again.patient;
    res = await withLifecycleRetry(() => args.insert(patient));
    if (res.error?.code === "P0058") return { ok: false, error: lookupAgainError };
  }
  if (res.error || !res.data) return { ok: false, error: res.error ?? "Could not save the appointment." };
  return { ok: true, data: res.data, patient };
}

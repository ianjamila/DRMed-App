import type { PatientResolution } from "@/lib/appointments/create";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";

// NOTE: no `import "server-only"` (directly or transitively) — this module
// must stay unit-testable without a DB. `PatientResolution` is imported as a
// type only (erased at build time), so it never pulls in `./create`'s
// runtime module graph (which does transitively import `server-only` via
// `translatePgError`).

export const LOOKUP_AGAIN_ERROR = "We couldn't use that patient record. Look the patient up again, then book.";

/**
 * Insert the booking rows; recover once from a patient that stopped being
 * active between resolution and insert (0184: the insert re-checks under the
 * patient's lifecycle lock). A patient RESOLVED from typed details is resolved
 * again and the insert retried once; a patient chosen by id (staff picker,
 * portal session) is never silently swapped — the caller gets a generic
 * lookup-again error that does not say whether a record was deleted.
 */
export async function insertWithPatientRecovery<T>(args: {
  patient: PatientResolution;
  insert: (patient: PatientResolution) => PromiseLike<{ data: T | null; error: { code?: string | null; message: string } | null }>;
  resolveAgain: () => Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }>;
}): Promise<{ ok: true; data: T; patient: PatientResolution } | { ok: false; error: { code?: string | null; message: string } | string }> {
  let patient = args.patient;
  let res = await withLifecycleRetry(() => args.insert(patient));
  if (res.error?.code === "P0058") {
    if (patient.resolution !== "reused" && patient.resolution !== "created") {
      return { ok: false, error: LOOKUP_AGAIN_ERROR };
    }
    const again = await args.resolveAgain();
    if (!again.ok) return { ok: false, error: again.error };
    patient = again.patient;
    res = await withLifecycleRetry(() => args.insert(patient));
    if (res.error?.code === "P0058") return { ok: false, error: LOOKUP_AGAIN_ERROR };
  }
  if (res.error || !res.data) return { ok: false, error: res.error ?? "Could not save the appointment." };
  return { ok: true, data: res.data, patient };
}

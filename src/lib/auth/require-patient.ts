import "server-only";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import type { PatientSession } from "@/lib/auth/patient-session";
import { activePatients } from "@/lib/patients/active";

export interface PatientProfile {
  patient_id: string;
  drm_id: string;
  visit_id: string;
  first_name: string;
  last_name: string;
  middle_name: string | null;
}

export interface ActivePatientSession extends PatientSession {
  first_name: string;
  last_name: string;
  middle_name: string | null;
}

// The portal's only session check (0167). Verifies the signed cookie AND
// re-reads the patient record: a deleted or merged record returns null on the
// very next request, whatever the cookie's remaining lifetime. No merge-chain
// following — the surviving record signs in with its own DRM-ID and PIN.
// Callers answer null with their existing generic "session expired" wording,
// never with the record's lifecycle state. A restore makes a still-unexpired
// cookie work again; nothing extends its lifetime.
export async function getActivePatientSession(): Promise<ActivePatientSession | null> {
  const session = await getPatientSession();
  if (!session) return null;
  const admin = createAdminClient();
  const { data: patient } = await activePatients(
    admin.from("patients").select("id, drm_id, first_name, last_name, middle_name"),
  )
    .eq("id", session.patient_id)
    .maybeSingle();
  if (!patient) return null;
  return {
    patient_id: patient.id,
    drm_id: patient.drm_id,
    visit_id: session.visit_id,
    first_name: patient.first_name,
    last_name: patient.last_name,
    middle_name: patient.middle_name,
  };
}

// Whether a signed session cookie is present, independent of whether the
// underlying patient record is still active. The one other allowed caller
// of the bare cookie helper (active-session.test.ts) — clear-session/
// route.ts uses this instead of importing getPatientSession() itself, so
// that file stays a consumer of require-patient.ts's exports rather than a
// second holder of the bare helper.
export async function hasSignedPatientCookie(): Promise<boolean> {
  return (await getPatientSession()) !== null;
}

// Call at the top of any /portal/(authenticated)/* server component or route.
export async function requirePatientProfile(): Promise<PatientProfile> {
  // Know whether a signed cookie was present at all, separately from whether
  // it's still active: a Server Component render can't clear a cookie (see
  // clear-session/route.ts), so a signed-but-now-inactive cookie has to be
  // routed through that Route Handler instead of straight to /portal/login —
  // no cookie at all skips that extra hop.
  const raw = await hasSignedPatientCookie();
  const s = await getActivePatientSession();
  if (!s) redirect(raw ? "/portal/login/clear-session" : "/portal/login");
  return {
    patient_id: s.patient_id,
    drm_id: s.drm_id,
    visit_id: s.visit_id,
    first_name: s.first_name,
    last_name: s.last_name,
    middle_name: s.middle_name,
  };
}

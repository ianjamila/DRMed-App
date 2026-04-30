import "server-only";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";

export interface PatientProfile {
  patient_id: string;
  drm_id: string;
  visit_id: string;
  first_name: string;
  last_name: string;
  middle_name: string | null;
}

// Call at the top of any /portal/(authenticated)/* server component.
// Verifies the patient JWT cookie and returns the patient row. The middleware
// already gates on cookie presence, but we re-verify here so the session can
// be passed straight to the page.
export async function requirePatientProfile(): Promise<PatientProfile> {
  const session = await getPatientSession();
  if (!session) redirect("/portal/login");

  const admin = createAdminClient();
  const { data: patient } = await admin
    .from("patients")
    .select("id, drm_id, first_name, last_name, middle_name")
    .eq("id", session.patient_id)
    .maybeSingle();

  if (!patient) redirect("/portal/login");

  return {
    patient_id: patient.id,
    drm_id: patient.drm_id,
    visit_id: session.visit_id,
    first_name: patient.first_name,
    last_name: patient.last_name,
    middle_name: patient.middle_name,
  };
}

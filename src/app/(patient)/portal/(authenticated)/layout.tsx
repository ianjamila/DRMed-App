import { requirePatientProfile } from "@/lib/auth/require-patient";
import { PatientShell } from "@/components/patient/patient-shell";
import { getPatientConsentState } from "@/lib/consent/gate";
import { PortalConsentGate } from "./consent/consent-gate";

export default async function PatientAuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const patient = await requirePatientProfile();
  const consent = await getPatientConsentState(patient.patient_id);
  return (
    <PatientShell patient={patient}>
      {children}
      {!consent.current && <PortalConsentGate />}
    </PatientShell>
  );
}

import { requirePatientProfile } from "@/lib/auth/require-patient";
import { PatientShell } from "@/components/patient/patient-shell";
import { getPatientConsentState } from "@/lib/consent/gate";
import { PortalConsentGate } from "./consent/consent-gate";

export default async function PatientAuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const patient = await requirePatientProfile();
  const consent = await getPatientConsentState(patient.patient_id);
  // M3: render children (and thus their RSC data fetches) ONLY once consent is
  // on file. Pre-consent we render the gate in their place instead of overlaying
  // it, so no result data is fetched or shipped before the patient agrees.
  return (
    <PatientShell patient={patient}>
      {consent.current ? children : <PortalConsentGate />}
    </PatientShell>
  );
}

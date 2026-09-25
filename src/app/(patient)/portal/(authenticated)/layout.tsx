import { requirePatientProfile } from "@/lib/auth/require-patient";
import { PatientShell } from "@/components/patient/patient-shell";
import { portalConsentCurrent } from "@/lib/portal/consent-guard";
import { PortalConsentGate } from "./consent/consent-gate";

export default async function PatientAuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const patient = await requirePatientProfile();
  const consented = await portalConsentCurrent(patient.patient_id);
  // M3: render children (and thus their RSC data fetches) ONLY once consent is
  // on file. Pre-consent we render the gate in their place instead of overlaying
  // it. That is not enough on its own — layouts and pages render in parallel
  // and a layout does not re-render on client navigation — so every page and
  // action repeats the check (src/lib/portal/consent-guard.ts).
  return (
    <PatientShell patient={patient}>
      {consented ? children : <PortalConsentGate />}
    </PatientShell>
  );
}

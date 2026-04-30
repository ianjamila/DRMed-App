import { requirePatientProfile } from "@/lib/auth/require-patient";
import { PatientShell } from "@/components/patient/patient-shell";

export default async function PatientAuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const patient = await requirePatientProfile();
  return <PatientShell patient={patient}>{children}</PatientShell>;
}

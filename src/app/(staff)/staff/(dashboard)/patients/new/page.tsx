import Link from "next/link";
import { PatientForm } from "./patient-form";

export const metadata = {
  title: "New patient — staff",
};

export default function NewPatientPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/patients"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Patients
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New patient
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        DRM-ID is auto-generated on save. After creation you can start a visit.
      </p>
      <div className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <PatientForm />
      </div>
    </div>
  );
}

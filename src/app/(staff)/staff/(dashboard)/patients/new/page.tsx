import Link from "next/link";
import { PatientForm } from "../patient-form";
import { listActiveReferralSources } from "@/lib/legacy-import/loaders";

export const metadata = {
  title: "New patient — staff",
};

export default async function NewPatientPage() {
  const sources = await listActiveReferralSources();
  const referralOptions = [
    { value: "", label: "—" },
    ...sources.map((s) => ({ value: s.id, label: s.label })),
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/patients"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Patients
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New patient
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        DRM-ID is auto-generated on save. After creation you can start a visit.
      </p>
      <div className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <PatientForm referralOptions={referralOptions} />
      </div>
    </div>
  );
}
